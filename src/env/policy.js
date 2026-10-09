/** Shared traversal and deletion boundaries for every scanner/environment. */
import { isWithin, matchesExcluded } from '../paths.js';
import { trace } from '../exec.js';

const RUNTIME_ROOTS = [
  '/var/lib/docker',
  '/var/lib/containerd',
  '/run/containerd',
  '/var/lib/containers',
];
const unescapeMount = (value) =>
  value.replace(/\\([0-7]{3})/g, (_, octal) =>
    String.fromCharCode(parseInt(octal, 8))
  );

export function parseMountInfo(text) {
  return (text ?? '').split('\n').flatMap((line) => {
    const [left, right] = line.split(' - ');
    if (!right) {
      return [];
    }
    const fields = left.split(' ');
    const [type, source, options = ''] = right.split(' ');
    return [
      {
        path: unescapeMount(fields[4]),
        type,
        source,
        readonly: fields[5].split(',').includes('ro'),
        options,
      },
    ];
  });
}

export class ScanPolicy {
  constructor(env, options, mounts) {
    this.env = env;
    this.exclude = options.exclude ?? [];
    this.roots = options.roots ?? [];
    this.mounts = mounts;
    this.excludedPaths = new Set();
    this.pruned = mounts
      .filter(
        (mount) =>
          mount.path !== '/' &&
          (mount.readonly ||
            mount.type === 'overlay' ||
            mount.type === 'fuse.overlayfs' ||
            !this.roots.some((root) => isWithin(root, mount.path, env.path)))
      )
      .map((mount) => mount.path);
    this.overlay = mounts.find(
      (mount) =>
        mount.path === '/' && ['overlay', 'fuse.overlayfs'].includes(mount.type)
    );
  }

  allows(target) {
    const { path } = this.env;
    if (matchesExcluded(target, this.exclude, path)) {
      this.excludedPaths.add(target);
      return false;
    }
    return (
      !RUNTIME_ROOTS.some((root) => isWithin(target, root, path)) &&
      !matchesExcluded(
        target,
        ['/tmp/containerd-mount*', '/private/tmp/containerd-mount*'],
        path
      ) &&
      !this.pruned.some((root) => isWithin(target, root, path)) &&
      !this.mounts.some(
        (mount) => mount.readonly && isWithin(target, mount.path, path)
      )
    );
  }

  removalReason(target) {
    if (!this.allows(target)) {
      return 'path is excluded, mounted, read-only or owned by a container runtime';
    }
    if (
      [...this.excludedPaths].some((root) =>
        isWithin(root, target, this.env.path)
      ) ||
      this.exclude.some(
        (pattern) =>
          !/[?*[]/.test(pattern) && isWithin(pattern, target, this.env.path)
      )
    ) {
      return 'contains an excluded path';
    }
    if (this.pruned.some((root) => isWithin(root, target, this.env.path))) {
      return 'contains a mounted filesystem';
    }
    return null;
  }
}

/** Install boundaries before any scanner expands paths or traverses roots. */
export async function configureScanPolicy(env, options) {
  const mounts =
    env.platform === 'linux' && env.readText
      ? parseMountInfo(await env.readText('/proc/self/mountinfo'))
      : [];
  const excluded = env.scanPolicy?.excludedPaths;
  env.scanPolicy = new ScanPolicy(env, options, mounts);
  if (excluded) {
    env.scanPolicy.excludedPaths = excluded;
  }
  if (env.policyInstalled) {
    return;
  }
  env.policyInstalled = true;
  const allowed = (target) => env.scanPolicy.allows(target);
  for (const name of ['list', 'stat', 'exists']) {
    if (!env[name]) {
      continue;
    }
    const original = env[name].bind(env);
    env[name] = async (target, ...args) => {
      if (!allowed(target)) {
        trace('pruned', target);
        return name === 'list' ? [] : name === 'exists' ? false : null;
      }
      const value = await original(target, ...args);
      return name === 'list'
        ? value.filter((entry) =>
            allowed(entry.path ?? env.path.join(target, entry.name))
          )
        : value;
    };
  }
  for (const name of ['listMany', 'existsMany', 'statMany', 'rawUsageMany']) {
    if (!env[name]) {
      continue;
    }
    const original = env[name].bind(env);
    env[name] = async (targets, ...args) => {
      const value = await original(targets.filter(allowed), ...args);
      if (name !== 'listMany') {
        return value;
      }
      return new Map(
        [...value].map(([dir, entries]) => [
          dir,
          entries.filter((entry) =>
            allowed(entry.path ?? env.path.join(dir, entry.name))
          ),
        ])
      );
    };
  }
}
