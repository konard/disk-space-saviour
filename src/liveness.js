/**
 * Liveness checks: is anything using a path right now?
 *
 * Independent signals, any of which blocks deletion:
 * - recent writes: newest file mtime inside the stale-age window;
 * - a relevant tool is running (by process name), optionally only when its
 *   working directory is inside the project;
 * - a process holds a file, working directory, or executable inside the path
 *   (`/proc/<pid>/{fd,cwd,exe}` on Linux, `lsof` on macOS).
 * - a command argument names a path inside the item (including scripts
 *   whose interpreter has already closed its input descriptor).
 *
 * The cleaner refreshes the probe right before acting on each item.
 */

import path from 'node:path';

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

/** Arguments preserved by /proc; command titles are a fallback. */
export function processArgs(proc) {
  return (
    proc.argv ??
    (proc.command ?? '')
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((arg) => arg.replace(/^["']|["']$/g, '')) ??
    []
  );
}

function scriptIndex(args) {
  const first = path.posix.basename(args[0] ?? '');
  if (!/^(node|nodejs|bun|deno|python[\d.]*|bash|sh)$/.test(first)) {
    return 0;
  }
  // Only the interpreter's script operand; option values and arbitrary
  // arguments are not executable names.
  let index = 1;
  while (args[index]?.startsWith('-')) {
    if (['-e', '--eval', '-p', '--print', '-c'].includes(args[index])) {
      return -1;
    }
    index += ['-r', '--require', '--import', '--loader'].includes(args[index])
      ? 2
      : 1;
  }
  return index;
}

function commandNames(proc) {
  const args = processArgs(proc);
  const first = path.posix.basename(args[0] ?? '');
  const names = [first];
  if (/^npm(?: |$)/.test(proc.name ?? '') || /^npm(?: |$)/.test(first)) {
    names.push('npm');
  }
  const index = scriptIndex(args);
  if (index > 0) {
    const script = path.posix.basename(args[index] ?? '');
    names.push(
      script,
      ...(script === 'npm-cli.js' ? ['npm'] : []),
      ...(script === 'npx-cli.js' ? ['npx'] : [])
    );
  }
  // An explicit npm launcher package is also a tool (e.g. Playwright MCP).
  if (isNpmExec(proc)) {
    const packageArg = args.find((arg) => /^@[^/]+\/[^/]+$/.test(arg));
    if (packageArg) {
      names.push(packageArg.slice(1).split('/')[0]);
    }
  }
  return names;
}

export function isNpmExec(proc) {
  const args = processArgs(proc);
  const index = scriptIndex(args);
  const executable = path.posix.basename(args[Math.max(index, 0)] ?? '');
  return (
    /^npm (exec|x)(?: |$)|^npx(?: |$)/.test(proc.name ?? '') ||
    /^npm (exec|x)(?: |$)|^npx(?: |$)/.test(args[0] ?? '') ||
    (index >= 0 &&
      (['npx', 'npx-cli.js'].includes(executable) ||
        (['npm', 'npm-cli.js'].includes(executable) &&
          ['exec', 'x'].includes(args[index + 1]))))
  );
}

/**
 * Name of `proc` that matches one of `names`, or null. Besides the kernel
 * name (`comm`, which programs may rename: Node.js calls its main thread
 * `MainThread`), processes carry `aliases`: the executable and `argv[0]`
 * base names.
 */
export function matchingName(proc, names) {
  const own = [proc.name ?? '', ...(proc.aliases ?? []), ...commandNames(proc)];
  for (const name of own) {
    if (name && names.some((candidate) => nameMatches(name, candidate))) {
      return name;
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
    this.openPaths = await this.env.openPaths().catch(() => null);
    const processes = await this.env.processes().catch(() => null);
    this.listed = processes !== null;
    this.processes = processes ?? [];
    this.probeError =
      (processes === null || this.openPaths === null) &&
      (this.env.platform === 'linux' || this.env.platform === 'darwin');
    this.refreshedAt = this.now();
  }

  /** Processes of the last refresh, or null when they could not be listed. */
  processList() {
    return this.listed ? this.processes : null;
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

  runningTool(names, cwd, item = {}) {
    if (!names || names.length === 0) {
      return null;
    }
    const pathApi = this.env.path;
    for (const proc of this.processes) {
      if (
        ['npm-cache', 'node-gyp-cache', 'npx-cache'].includes(item.rule) &&
        isNpmExec(proc)
      ) {
        continue;
      }
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
   * Paths of `paths` that a process holds open, with the reason.
   * @param {string[]} paths
   * @returns {Map<string, string>}
   */
  openPathsOf(paths) {
    const open = new Map();
    for (const target of paths) {
      const reason = this.openInside([target]);
      if (reason) {
        open.set(target, reason);
      }
    }
    return open;
  }

  commandUsage(paths) {
    for (const proc of this.processes) {
      for (const arg of processArgs(proc)) {
        const candidate = arg.startsWith('/')
          ? arg
          : proc.cwd && !arg.startsWith('-')
            ? this.env.path.resolve(proc.cwd, arg)
            : null;
        if (
          candidate &&
          paths.some((target) => isWithin(candidate, target, this.env.path))
        ) {
          return `in use: ${candidate} (pid ${proc.pid})`;
        }
      }
    }
    return null;
  }

  /**
   * First reason the item is busy, or null when it is idle. Items with
   * `checks.perPath` leave open files to `openPathsOf`: the caller skips
   * those paths and keeps the item.
   * @param {object} item
   */
  busyReason(item) {
    const checks = item.checks ?? {};
    const paths = checks.perPath ? [] : (item.paths ?? []);
    return (
      (this.probeError
        ? `cannot verify process and open-file activity${this.env.probeDiagnostic ? `: ${this.env.probeDiagnostic}` : ''}`
        : null) ??
      (checks.mtime === false ? null : this.recentWrite(item.newestMtimeMs)) ??
      this.runningTool(checks.busy, checks.cwd, item) ??
      this.openInside(paths) ??
      this.commandUsage(paths)
    );
  }
}
