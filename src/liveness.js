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

function processMatches(proc, names) {
  const name = proc.name ?? '';
  return names.some(
    (candidate) =>
      name === candidate ||
      (name.length === PROC_COMM_LIMIT &&
        candidate.startsWith(name) &&
        candidate.length > PROC_COMM_LIMIT)
  );
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
  }

  async refresh(force = false) {
    if (!force && this.now() - this.refreshedAt < this.refreshMs) {
      return;
    }
    this.processes = (await this.env.processes()) ?? [];
    this.openPaths = await this.env.openPaths();
    this.refreshedAt = this.now();
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
      if (!processMatches(proc, names)) {
        continue;
      }
      if (!cwd) {
        return `${proc.name} is running (pid ${proc.pid})`;
      }
      if (!proc.cwd) {
        return `${proc.name} is running (pid ${proc.pid}, working directory unknown)`;
      }
      if (isWithin(proc.cwd, cwd, pathApi)) {
        return `${proc.name} is running in ${proc.cwd} (pid ${proc.pid})`;
      }
    }
    return null;
  }

  openInside(paths) {
    if (!this.openPaths || paths.length === 0) {
      return null;
    }
    const pathApi = this.env.path;
    for (const open of this.openPaths) {
      for (const target of paths) {
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
      (checks.mtime === false ? null : this.recentWrite(item.newestMtimeMs)) ??
      this.runningTool(checks.busy, checks.cwd) ??
      this.openInside(item.paths ?? [])
    );
  }
}
