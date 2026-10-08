/** Reclaimable file blocks in a container, excluding immutable image data. */
import { DockerCli } from './cli.js';
import { isWithin } from '../paths.js';

export class WritableLayer {
  constructor(executor, id) {
    this.docker = new DockerCli(executor);
    this.id = id;
  }

  async measure(env, usages) {
    usages = new Map([...usages].filter(([, usage]) => usage));
    if (usages.size === 0) {
      return usages;
    }
    const diff = await this.docker.diff(this.id);
    const [container] = await this.docker.inspect([this.id]).catch(() => []);
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
        !mounts.some((mount) => inside(file, mount))
    );
    const stats = await env.statMany(changed);
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
          },
        ];
      })
    );
  }
}

/** Attach storage accounting to the host adapter when dss runs in Docker. */
export async function configureContainerHost(env, ids) {
  if (!ids.length || !(await env.which('docker'))) {
    return;
  }
  const docker = new DockerCli(env.executor);
  const containers = await docker.inspect(ids).catch(() => []);
  const own = containers.find((container) => ids.includes(container.Id));
  if (own) {
    env.writableLayer = new WritableLayer(env.executor, own.Id);
    const { ShellEnv } = await import('../env/shell.js');
    const { containerExecutor } = await import('../exec.js');
    env.processInspector = new ShellEnv(
      containerExecutor(env.executor, own.Id)
    );
  }
}
