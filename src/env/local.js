/**
 * Environment adapter for the machine running dss, backed by node:fs.
 *
 * Scanners only talk to environment adapters, so the same rules run on the
 * host and inside containers (see shell.js).
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hostExecutor } from '../exec.js';
import { matchesGlob } from '../paths.js';

export const DEFAULT_SKIP_NAMES = [
  '.git',
  '.hg',
  '.svn',
  '.Trash',
  '.cache',
  '.local',
  '.npm',
  '.bun',
  '.yarn',
  '.pnpm-store',
  '.deno',
  '.cargo',
  '.rustup',
  '.m2',
  '.nvm',
  '.pyenv',
  '.rbenv',
  '.sdkman',
  '.elan',
  '.ghcup',
  '.opam',
  '.julia',
  '.gem',
  '.nuget',
  '.pub-cache',
  '.stack',
  '.cabal',
  '.ivy2',
  '.sbt',
  '.hex',
  '.mix',
  '.cpanm',
  '.luarocks',
  '.nimble',
  '.conda',
  '.ccache',
  '.vscode-server',
  '.docker',
  'Library',
  'miniconda3',
  'anaconda3',
  'snap',
  'proc',
  'sys',
  'dev',
];

function entryType(stats) {
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }
  if (stats.isDirectory()) {
    return 'dir';
  }
  if (stats.isFile()) {
    return 'file';
  }
  return 'other';
}

function diskBytes(stats) {
  return typeof stats.blocks === 'number' && stats.blocks >= 0
    ? stats.blocks * 512
    : stats.size;
}

async function safeLstat(target) {
  try {
    return await fsp.lstat(target);
  } catch {
    return null;
  }
}

async function makeWritable(target) {
  const stats = await safeLstat(target);
  if (!stats || stats.isSymbolicLink()) {
    return;
  }
  try {
    await fsp.chmod(target, stats.mode | 0o700);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    let names = [];
    try {
      names = await fsp.readdir(target);
    } catch {
      return;
    }
    for (const name of names) {
      await makeWritable(path.join(target, name));
    }
  }
}

export class LocalEnv {
  /**
   * @param {{homes?: string[], tmpDirs?: string[], executor?: object,
   *   platform?: string, vars?: object, skipNames?: string[], id?: string,
   *   label?: string}} [options]
   */
  constructor(options = {}) {
    this.id = options.id ?? 'host';
    this.kind = 'host';
    this.label = options.label ?? `host (${os.hostname()})`;
    this.path = path;
    this.platform = options.platform ?? process.platform;
    this.executor = options.executor ?? hostExecutor();
    this.options = options;
    this.currentHome = os.homedir();
    this.skipNames = new Set(options.skipNames ?? DEFAULT_SKIP_NAMES);
    this.vars = options.vars ?? {
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      APPDATA: process.env.APPDATA,
      TMPDIR: process.env.TMPDIR,
    };
  }

  homeDirs() {
    return Promise.resolve(this.options.homes ?? [os.homedir()]);
  }

  async tmpDirs() {
    if (this.options.tmpDirs) {
      return this.options.tmpDirs;
    }
    const dirs = new Set([os.tmpdir()]);
    if (this.platform !== 'win32' && (await this.exists('/tmp'))) {
      dirs.add('/tmp');
    }
    return [...dirs];
  }

  async exists(target) {
    return (await safeLstat(target)) !== null;
  }

  async stat(target) {
    const stats = await safeLstat(target);
    if (!stats) {
      return null;
    }
    return {
      type: entryType(stats),
      size: stats.size,
      bytes: diskBytes(stats),
      mtimeMs: stats.mtimeMs,
    };
  }

  async readText(target, maxBytes = 1024 * 1024) {
    try {
      const handle = await fsp.open(target, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  /**
   * Reads the first bytes of many files in one batch (Rust `.d` files).
   * @param {string[]} files
   * @param {number} maxBytes
   * @returns {Promise<Map<string,string>>}
   */
  async readHeads(files, maxBytes = 4096) {
    const heads = new Map();
    for (const file of files) {
      const text = await this.readText(file, maxBytes);
      if (text !== null) {
        heads.set(file, text);
      }
    }
    return heads;
  }

  async list(dir) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const entries = await Promise.all(
      names.map(async (name) => {
        const full = path.join(dir, name);
        const stats = await safeLstat(full);
        if (!stats) {
          return null;
        }
        return {
          name,
          path: full,
          type: entryType(stats),
          size: stats.size,
          bytes: diskBytes(stats),
          mtimeMs: stats.mtimeMs,
        };
      })
    );
    return entries.filter(Boolean);
  }

  /**
   * Disk usage like `du -s`: allocated blocks, each hard-linked inode
   * counted a single time, symlinks not followed. Also reports the newest
   * file mtime.
   */
  async usage(target) {
    const root = await safeLstat(target);
    if (!root) {
      return null;
    }
    const seen = new Set();
    let bytes = 0;
    let apparentBytes = 0;
    let files = 0;
    let errors = 0;
    let newestMtimeMs = 0;
    const account = (stats) => {
      if (stats.nlink > 1 && !stats.isDirectory()) {
        const key = `${stats.dev}:${stats.ino}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
      }
      bytes += diskBytes(stats);
      apparentBytes += stats.size;
      if (!stats.isDirectory()) {
        files++;
        newestMtimeMs = Math.max(newestMtimeMs, stats.mtimeMs);
      }
    };
    account(root);
    const stack = root.isDirectory() ? [target] : [];
    while (stack.length > 0) {
      const dir = stack.pop();
      let names;
      try {
        names = await fsp.readdir(dir);
      } catch {
        errors++;
        continue;
      }
      const children = await Promise.all(
        names.map(async (name) => {
          const full = path.join(dir, name);
          return [full, await safeLstat(full)];
        })
      );
      for (const [full, stats] of children) {
        if (!stats) {
          errors++;
          continue;
        }
        account(stats);
        if (stats.isDirectory()) {
          stack.push(full);
        }
      }
    }
    if (files === 0) {
      newestMtimeMs = root.mtimeMs;
    }
    return { bytes, apparentBytes, files, errors, newestMtimeMs };
  }

  /**
   * Finds directories whose basename matches one of `globs`, without
   * descending into matches or into `skipNames`.
   * @returns {Promise<Array<{path: string, name: string, parent: string,
   *   siblings: Array<{name: string, type: string, mtimeMs: number}>}>>}
   */
  async findDirs(roots, { globs, maxDepth = 6, skipNames } = {}) {
    const skip = skipNames ? new Set(skipNames) : this.skipNames;
    const results = [];
    const visited = new Set();
    const queue = roots.map((root) => [root, 0]);
    while (queue.length > 0) {
      const [dir, depth] = queue.shift();
      if (visited.has(dir)) {
        continue;
      }
      visited.add(dir);
      const entries = await this.list(dir);
      let siblings = null;
      for (const entry of entries) {
        if (entry.type !== 'dir') {
          continue;
        }
        if (globs.some((glob) => matchesGlob(entry.name, glob))) {
          siblings ??= entries.map(({ name, type, mtimeMs }) => ({
            name,
            type,
            mtimeMs,
          }));
          results.push({
            path: entry.path,
            name: entry.name,
            parent: dir,
            siblings,
          });
          continue;
        }
        if (!skip.has(entry.name) && depth + 1 < maxDepth) {
          queue.push([entry.path, depth + 1]);
        }
      }
    }
    return results;
  }

  async remove(targets) {
    for (const target of targets) {
      try {
        await fsp.rm(target, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
          throw error;
        }
        // Read-only trees (Go module cache, some toolchains) need write
        // permission on directories before their entries can be unlinked.
        await makeWritable(target);
        await fsp.rm(target, { recursive: true, force: true });
      }
    }
  }

  async processes() {
    const selfPids = new Set([process.pid, process.ppid]);
    if (this.platform === 'linux') {
      return (await this.#linuxProcesses()).filter(
        (proc) => !selfPids.has(proc.pid)
      );
    }
    if (this.platform === 'win32') {
      const result = await this.run(['tasklist', '/fo', 'csv', '/nh']);
      return result.stdout
        .split(/\r?\n/)
        .map((line) => /^"([^"]+)","(\d+)"/.exec(line))
        .filter(Boolean)
        .map((m) => ({ pid: Number(m[2]), name: m[1].replace(/\.exe$/i, '') }))
        .filter((proc) => !selfPids.has(proc.pid));
    }
    const result = await this.run(['ps', '-axo', 'pid=,comm=']);
    return result.stdout
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), name: path.basename(m[2].trim()) }))
      .filter((proc) => !selfPids.has(proc.pid));
  }

  async #linuxProcesses() {
    let pids = [];
    try {
      pids = (await fsp.readdir('/proc')).filter((name) => /^\d+$/.test(name));
    } catch {
      return [];
    }
    const processes = [];
    for (const pid of pids) {
      const base = `/proc/${pid}`;
      let name;
      try {
        name = (await fsp.readFile(`${base}/comm`, 'utf8')).trim();
      } catch {
        continue;
      }
      const cwd = await fsp.readlink(`${base}/cwd`).catch(() => null);
      processes.push({ pid: Number(pid), name, cwd });
    }
    return processes;
  }

  /**
   * Paths currently held open (fds, cwds, executables) by any process.
   * Returns null when the platform gives no reliable answer.
   * @returns {Promise<Set<string>|null>}
   */
  async openPaths() {
    if (this.platform === 'linux') {
      const paths = new Set();
      let pids = [];
      try {
        pids = (await fsp.readdir('/proc')).filter((n) => /^\d+$/.test(n));
      } catch {
        return null;
      }
      for (const pid of pids) {
        const base = `/proc/${pid}`;
        for (const link of ['cwd', 'exe']) {
          const target = await fsp.readlink(`${base}/${link}`).catch(() => '');
          if (target.startsWith('/')) {
            paths.add(target.replace(/ \(deleted\)$/, ''));
          }
        }
        const fds = await fsp.readdir(`${base}/fd`).catch(() => []);
        for (const fd of fds) {
          const target = await fsp.readlink(`${base}/fd/${fd}`).catch(() => '');
          if (target.startsWith('/')) {
            paths.add(target.replace(/ \(deleted\)$/, ''));
          }
        }
      }
      return paths;
    }
    if (this.platform === 'darwin') {
      const result = await this.run(['lsof', '-n', '-F', 'n'], {
        timeoutMs: 30000,
      });
      if (result.code !== 0 && !result.stdout) {
        return null;
      }
      return new Set(
        result.stdout
          .split('\n')
          .filter((line) => line.startsWith('n/'))
          .map((line) => line.slice(1))
      );
    }
    return null;
  }

  run(argv, options) {
    return this.executor.run(argv, options);
  }

  async which(command) {
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    const extensions =
      this.platform === 'win32'
        ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
        : [''];
    for (const dir of dirs.filter(Boolean)) {
      for (const extension of extensions) {
        const stats = await safeLstat(path.join(dir, command + extension));
        if (stats && !stats.isDirectory()) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Filesystem capacity of the volume holding `target`.
   * @returns {Promise<{total: number, free: number, used: number}|null>}
   */
  async diskUsage(target) {
    if (typeof fsp.statfs === 'function') {
      try {
        const stats = await fsp.statfs(target);
        const total = stats.blocks * stats.bsize;
        const free = stats.bavail * stats.bsize;
        const used = total - stats.bfree * stats.bsize;
        return { total, free, used };
      } catch {
        // Fall through to df.
      }
    }
    if (this.platform === 'win32') {
      return null;
    }
    const result = await this.run(['df', '-Pk', target]);
    return parseDf(result.stdout);
  }
}

/**
 * Parses POSIX `df -Pk` output.
 * @param {string} output
 */
export function parseDf(output) {
  const line = output.trim().split('\n').slice(1).join(' ');
  const fields = line.trim().split(/\s+/);
  if (fields.length < 4) {
    return null;
  }
  const total = Number(fields[1]) * 1024;
  const used = Number(fields[2]) * 1024;
  const free = Number(fields[3]) * 1024;
  if (![total, used, free].every(Number.isFinite)) {
    return null;
  }
  return { total, free, used };
}
