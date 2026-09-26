/**
 * Liveness checks: is anything using a path right now?
 *
 * Three independent signals, any of which blocks deletion:
 * - recent writes: newest file mtime inside the stale-age window;
 * - a relevant tool is running (by process name), optionally only when its
 *   working directory is inside the project;
 * - a process holds a file, working directory, or executable inside the path
 *   (`/proc/<pid>/{fd,cwd,exe}` on Linux, `lsof` on macOS).
 *
 * The cleaner refreshes the probe right before acting on each item.
 */

import { isWithin } from './paths.js';
import { formatDuration } from './units.js';

const PROC_COMM_LIMIT = 15;

function nameMatches(name, candidate) {
  return (
    name === candidate ||
    (name.length === PROC_COMM_LIMIT &&
      candidate.startsWith(name) &&
      candidate.length > PROC_COMM_LIMIT)
  );
}

/**
 * Name of `proc` that matches one of `names`, or null. Besides the kernel
 * name (`comm`, which programs may rename: Node.js calls its main thread
 * `MainThread`), processes carry `aliases`: the executable and `argv[0]`
 * base names.
 */
function matchingName(proc, names) {
  const own = [proc.name ?? '', ...(proc.aliases ?? [])];
  for (const name of own) {
    if (name && names.some((candidate) => nameMatches(name, candidate))) {
      return name;
    }
  }
  const commandWords = (proc.command ?? '').toLowerCase().split(/[^a-z0-9_-]+/);
  for (const candidate of names) {
    if (commandWords.includes(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return null;
}

export class LivenessProbe {
  /**
   * @param {object} env environment adapter
   * @param {{staleAgeMs: number, now?: () => number, refreshMs?: number}} options
   */
  constructor(env, { staleAgeMs, now = () => Date.now(), refreshMs = 2000 }) {
    this.env = env;
    this.staleAgeMs = staleAgeMs;
    this.now = now;
    this.refreshMs = refreshMs;
    this.refreshedAt = -Infinity;
    this.processes = [];
    this.openPaths = null;
    this.probeError = false;
    this.realPaths = new Map();
  }

  async refresh(force = false) {
    if (!force && this.now() - this.refreshedAt < this.refreshMs) {
      return;
    }
    const processes = await this.env.processes().catch(() => null);
    this.processes = processes ?? [];
    this.openPaths = await this.env.openPaths().catch(() => null);
    this.probeError =
      (processes === null || this.openPaths === null) &&
      (this.env.platform === 'linux' || this.env.platform === 'darwin');
    this.refreshedAt = this.now();
  }

  /**
   * Resolves symlinks in `paths` (cached), because processes report the
   * paths they hold open with symlinks resolved: a scan of `/var/folders`
   * on macOS must match `lsof` output under `/private/var/folders`.
   * @param {string[]} paths
   */
  async resolve(paths) {
    if (typeof this.env.realPath !== 'function') {
      return;
    }
    for (const target of paths) {
      if (!this.realPaths.has(target)) {
        this.realPaths.set(target, await this.env.realPath(target));
      }
    }
  }

  recentWrite(newestMtimeMs) {
    if (!newestMtimeMs || this.staleAgeMs <= 0) {
      return null;
    }
    const age = this.now() - newestMtimeMs;
    if (age < this.staleAgeMs) {
      return `modified ${formatDuration(Math.max(age, 0))} ago, inside the ${formatDuration(this.staleAgeMs)} activity window`;
    }
    return null;
  }

  runningTool(names, cwd) {
    if (!names || names.length === 0) {
      return null;
    }
    const pathApi = this.env.path;
    for (const proc of this.processes) {
      const name = matchingName(proc, names);
      if (!name) {
        continue;
      }
      if (!cwd) {
        return `${name} is running (pid ${proc.pid})`;
      }
      if (!proc.cwd) {
        return `${name} is running (pid ${proc.pid}, working directory unknown)`;
      }
      if (isWithin(proc.cwd, cwd, pathApi)) {
        return `${name} is running in ${proc.cwd} (pid ${proc.pid})`;
      }
    }
    return null;
  }

  openInside(paths) {
    if (!this.openPaths || paths.length === 0) {
      return null;
    }
    const pathApi = this.env.path;
    const targets = paths.flatMap((target) => {
      const real = this.realPaths.get(target);
      return real && real !== target ? [target, real] : [target];
    });
    for (const open of this.openPaths) {
      for (const target of targets) {
        if (isWithin(open, target, pathApi)) {
          return `in use: ${open}`;
        }
      }
    }
    return null;
  }

  /**
   * First reason the item is busy, or null when it is idle.
   * @param {object} item
   */
  busyReason(item) {
    const checks = item.checks ?? {};
    return (
      (this.probeError
        ? 'cannot verify process and open-file activity'
        : null) ??
      (checks.mtime === false ? null : this.recentWrite(item.newestMtimeMs)) ??
      this.runningTool(checks.busy, checks.cwd) ??
      this.openInside(item.paths ?? [])
    );
  }
}
