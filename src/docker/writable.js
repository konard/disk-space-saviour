/** Reclaimable file blocks in a container, excluding immutable image data. */
import { DockerCli } from './cli.js';
import { isWithin } from '../paths.js';
import { trace } from '../exec.js';
import { resetDiffSnapshots } from './snapshots.js';

let measurementQueue = Promise.resolve();
const layers = new WeakMap();

export function sharedWritableLayer(executor, id) {
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
  layers.delete(executor);
  resetDiffSnapshots(executor);
}

/** Overlay without an authoritative upper layer must never count merged bytes. */
export class UnknownWritableLayer {
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
        const upperdir =
          container.GraphDriver?.Data?.UpperDir ?? this.upperdirCandidate;
        if (upperdir?.startsWith('/')) {
          const result = await this.docker.executor
            .run(['stat', '-c', '%F', '--', upperdir])
            .catch(() => null);
          if (result?.code === 0 && result.stdout.trim() === 'directory') {
            trace('using authoritative upperdir', this.id);
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

  forget(target, pathApi) {
    this.removed.add(target);
    for (const file of this.stats.keys()) {
      if (isWithin(file, target, pathApi)) {
        this.stats.delete(file);
      }
    }
  }

  async measureUpperdir(env, usages, container, upperdir) {
    const result = new Map();
    const mounts = (container.Mounts ?? [])
      .map((mount) => mount.Destination)
      .filter(Boolean);
    for (const [target, usage] of usages) {
      if (mounts.some((mount) => isWithin(target, mount, env.path))) {
        result.set(target, {
          ...usage,
          totalBytes: usage.bytes,
          imageBytes: 0,
        });
        continue;
      }
      const measured = await this.docker.executor.run([
        'du',
        '-skx',
        '--',
        `${upperdir}/${target.replace(/^\/+/, '')}`,
      ]);
      const kib = Number(/^([0-9]+)\s/m.exec(measured.stdout)?.[1]);
      // Missing upperdir leaf means image-only. Other errors remain unknown.
      const absent = /no such file|not found/i.test(measured.stderr);
      const known = (measured.code === 0 && Number.isFinite(kib)) || absent;
      const bytes = known ? Math.min(usage.bytes, absent ? 0 : kib * 1024) : 0;
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
