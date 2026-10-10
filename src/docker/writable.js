/** Reclaimable file blocks in a container, excluding immutable image data. */
import { DockerCli } from './cli.js';
import { isWithin } from '../paths.js';
import { trace } from '../exec.js';
import { resetDiffSnapshots } from './snapshots.js';
import { rootUpperdir, upperdirBytes } from './upperdir.js';

let measurementQueue = Promise.resolve();
const layers = new WeakMap();

export function sharedWritableLayer(executor, id) {
  executor = executor.unscoped ?? executor;
  if (!layers.has(executor)) {
    layers.set(executor, new Map());
  }
  const registry = layers.get(executor);
  if (!registry.has(id)) {
    registry.set(id, new WritableLayer(executor, id));
  }
  return registry.get(id);
}

export function resetWritableLayers(executor) {
  executor = executor.unscoped ?? executor;
  layers.delete(executor);
  resetDiffSnapshots(executor);
}

/** Overlay without an authoritative upper layer must never count merged bytes. */
export class UnknownWritableLayer {
  source = 'unknown-overlay';
  measure(env, usages) {
    return Promise.resolve(
      new Map(
        [...usages]
          .filter(([, usage]) => usage)
          .map(([target, usage]) => [
            target,
            {
              ...usage,
              totalBytes: usage.bytes,
              bytes: 0,
              imageBytes: 0,
              sizeUnknown: true,
            },
          ])
      )
    );
  }
}

export class WritableLayer {
  constructor(executor, id) {
    this.docker = new DockerCli(executor);
    this.id = id;
    this.stats = new Map();
    this.removed = new Set();
  }

  snapshot(candidateFiles = 0) {
    if (!this.snapshotPromise) {
      const acquire = async () => {
        trace(
          'measuring container',
          this.id,
          '(one storage snapshot; concurrency 1)'
        );
        const container =
          this.inspected ??
          (await this.docker.inspect([this.id]).catch(() => []))[0];
        if (!container) {
          return { diff: null, container };
        }
        const { upperdir, source } = await this.upperdir(container);
        if (upperdir?.startsWith('/')) {
          const result = await this.docker.executor
            .run(['stat', '-c', '%F', '--', upperdir])
            .catch(() => null);
          if (result?.code === 0 && result.stdout.trim() === 'directory') {
            trace('using authoritative upperdir', this.id);
            this.source = source;
            return { container, upperdir, diff: null };
          }
        }
        if (candidateFiles > 100000) {
          trace(
            'skipping docker diff: candidate file budget exceeds 100000',
            this.id
          );
          return { diff: null, container };
        }
        const diff = await this.docker.diff(this.id);
        this.source = diff === null ? 'unknown' : 'docker-diff';
        trace('finished measuring container', this.id);
        // Bound the retained change set; unknown is safer than a partial result.
        return {
          diff: diff?.split('\n').length > 100000 ? null : diff,
          container,
        };
      };
      this.snapshotPromise = measurementQueue.then(acquire, acquire);
      measurementQueue = this.snapshotPromise.then(
        () => {},
        () => {}
      );
    }
    return this.snapshotPromise;
  }

  async upperdir(container) {
    if (container.GraphDriver?.Data?.UpperDir) {
      return {
        upperdir: container.GraphDriver.Data.UpperDir,
        source: 'graphdriver-upperdir',
      };
    }
    const pid = container.State?.Pid;
    if (Number.isInteger(pid) && pid > 0) {
      const info = await this.docker.executor.run([
        'cat',
        `/proc/${pid}/mountinfo`,
      ]);
      const upperdir = info.code === 0 ? rootUpperdir(info.stdout) : null;
      if (upperdir) {
        return { upperdir, source: 'mountinfo-upperdir' };
      }
    }
    return { upperdir: this.upperdirCandidate, source: 'overlay-upperdir' };
  }

  forget(target, pathApi) {
    this.removed.add(target);
    for (const file of this.stats.keys()) {
      if (isWithin(file, target, pathApi)) {
        this.stats.delete(file);
      }
    }
  }

  /** Allocated upper blocks before/after deletion, independent of merged data. */
  async allocatedBytes(paths, pathApi) {
    const { container, upperdir } = await this.snapshot();
    if (
      !upperdir ||
      (container.Mounts ?? []).some((mount) =>
        paths.some(
          (target) =>
            isWithin(target, mount.Destination, pathApi) ||
            isWithin(mount.Destination, target, pathApi)
        )
      )
    ) {
      return null;
    }
    const measured = await upperdirBytes(
      this.docker.executor,
      paths.map((target) => `${upperdir}/${target.replace(/^\/+/, '')}`)
    );
    const values = [...measured.values()];
    return values.length === paths.length &&
      values.every((value) => value !== null)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  }

  async measureUpperdir(env, usages, container, upperdir) {
    const result = new Map();
    const mounts = (container.Mounts ?? [])
      .map((mount) => mount.Destination)
      .filter(Boolean);
    const upperPath = (target) => `${upperdir}/${target.replace(/^\/+/, '')}`;
    const targets = [...usages.keys()].filter(
      (target) => !mounts.some((mount) => isWithin(target, mount, env.path))
    );
    const measurements = await upperdirBytes(
      this.docker.executor,
      targets.map(upperPath)
    );
    const mountRoots = mounts.filter(
      (mount) =>
        targets.some((target) => isWithin(mount, target, env.path)) &&
        !mounts.some(
          (other) => other !== mount && isWithin(mount, other, env.path)
        )
    );
    const mountedUsage = mountRoots.length
      ? await env.rawUsageMany(mountRoots)
      : new Map();
    for (const [target, usage] of usages) {
      if (mounts.some((mount) => isWithin(target, mount, env.path))) {
        result.set(target, {
          ...usage,
          totalBytes: usage.bytes,
          imageBytes: 0,
        });
        continue;
      }
      const measured = measurements.get(upperPath(target));
      const contained = mountRoots.filter((mount) =>
        isWithin(mount, target, env.path)
      );
      const known =
        measured !== null &&
        measured !== undefined &&
        contained.every((mount) => mountedUsage.has(mount));
      const bytes = known
        ? Math.min(
            usage.bytes,
            measured +
              contained.reduce(
                (sum, mount) => sum + mountedUsage.get(mount).bytes,
                0
              )
          )
        : 0;
      result.set(target, {
        ...usage,
        bytes,
        totalBytes: usage.bytes,
        imageBytes: known ? Math.max(0, usage.bytes - bytes) : 0,
        sizeUnknown: !known,
        imageRef: container.Config?.Image ?? container.Image ?? null,
      });
    }
    return result;
  }

  async measure(env, usages) {
    usages = new Map([...usages].filter(([, usage]) => usage));
    if (usages.size === 0) {
      return usages;
    }
    this.upperdirCandidate ??= /(?:^|,)upperdir=([^,]+)/.exec(
      env.scanPolicy?.overlay?.options ?? ''
    )?.[1];
    const candidateFiles = [...usages.values()].reduce(
      (sum, usage) => sum + (usage.files ?? 0),
      0
    );
    const { diff, container, upperdir } = await this.snapshot(candidateFiles);
    if (upperdir) {
      return this.measureUpperdir(env, usages, container, upperdir);
    }
    if (diff === null || !container) {
      return new Map(
        [...usages].map(([target, usage]) => [
          target,
          {
            ...usage,
            totalBytes: usage.bytes,
            bytes: 0,
            imageBytes: 0,
            sizeUnknown: true,
          },
        ])
      );
    }
    const mounts = (container.Mounts ?? [])
      .map((mount) => mount.Destination)
      .filter(Boolean);
    const inside = (target, root) => isWithin(target, root, env.path);
    const changed = [
      ...new Set(
        diff
          .split('\n')
          .map((line) => /^[AC] (\/.+)$/.exec(line)?.[1])
          .filter(Boolean)
      ),
    ].filter(
      (file) =>
        [...usages.keys()].some((target) => inside(file, target)) &&
        !mounts.some((mount) => inside(file, mount)) &&
        ![...this.removed].some((target) => inside(file, target))
    );
    const missing = changed.filter((file) => !this.stats.has(file));
    const fresh = await env.statMany(missing);
    for (const file of missing) {
      this.stats.set(file, fresh.get(file) ?? null);
    }
    const stats = new Map(
      changed
        .map((file) => [file, this.stats.get(file)])
        .filter(([, stat]) => stat)
    );
    const mountRoots = [
      ...new Set(
        mounts.filter((mount) =>
          [...usages.keys()].some(
            (target) => inside(mount, target) && mount !== target
          )
        )
      ),
    ];
    const mountedUsage = mountRoots.length
      ? await env.rawUsageMany(mountRoots)
      : new Map();
    return new Map(
      [...usages].map(([target, usage]) => {
        if (mounts.some((mount) => inside(target, mount))) {
          return [target, { ...usage, totalBytes: usage.bytes, imageBytes: 0 }];
        }
        let bytes = 0;
        const seen = new Set();
        for (const [file, stat] of stats) {
          // Docker diff's C directories include unchanged lower-layer children.
          // Count file blocks only, with hard-linked inodes counted once.
          if (
            !inside(file, target) ||
            stat.type === 'dir' ||
            seen.has(stat.inode ?? file)
          ) {
            continue;
          }
          seen.add(stat.inode ?? file);
          bytes += stat.bytes;
        }
        for (const mount of mountRoots.filter((mount) =>
          inside(mount, target)
        )) {
          if (
            !mountRoots.some((other) => other !== mount && inside(mount, other))
          ) {
            bytes += mountedUsage.get(mount)?.bytes ?? 0;
          }
        }
        bytes = Math.min(usage.bytes, bytes);
        return [
          target,
          {
            ...usage,
            totalBytes: usage.bytes,
            bytes,
            imageBytes: Math.max(0, usage.bytes - bytes),
            imageRef: container.Config?.Image ?? container.Image ?? null,
          },
        ];
      })
    );
  }
}

/** Attach storage accounting to the host adapter when dss runs in Docker. */
export async function configureContainerHost(env, ids, options = {}) {
  if (env.scanPolicy?.overlay && !env.writableLayer) {
    env.writableLayer = new UnknownWritableLayer();
  }
  if (options.docker === false) {
    return;
  }
  if (!ids.length || !(await env.which('docker'))) {
    return;
  }
  const docker = new DockerCli(env.executor);
  const containers = await docker.inspect(ids).catch(() => []);
  const own = containers.find((container) => ids.includes(container.Id));
  if (own) {
    env.writableLayer = sharedWritableLayer(env.executor, own.Id);
    env.writableLayer.inspected = own;
    const { ShellEnv } = await import('../env/shell.js');
    const { containerExecutor } = await import('../exec.js');
    env.processInspector = new ShellEnv(
      containerExecutor(env.executor, own.Id)
    );
  }
}
