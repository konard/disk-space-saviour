/**
 * Git safety checks. Deleting inside a work tree is only allowed when it
 * cannot lose work:
 * - regenerable directories must not contain tracked files;
 * - removing a whole work tree (abandoned solver checkouts, containers)
 *   additionally requires no uncommitted changes, no commits missing from
 *   every remote (`git log --branches --not --remotes`), and no stashes.
 *
 * When Git itself is unavailable but a `.git` exists, the check fails
 * closed: the item is blocked.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { trace } from './exec.js';

const GIT_FLAGS = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];

const SAFE_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_CONFIG_COUNT: '0',
  GIT_CONFIG_PARAMETERS: '',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

/** A metadata-only Git directory, with no repository-supplied config or hooks. */
async function safeGitDirectory(root, callback) {
  const source = path.join(root, '.git');
  const stat = await fsp.lstat(source);
  if (!stat.isDirectory()) {
    throw new Error('cannot safely inspect a linked Git worktree');
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dss-safe-git-'));
  try {
    for (const name of [
      'HEAD',
      'index',
      'packed-refs',
      'shallow',
      'refs',
      'logs',
    ]) {
      await fsp
        .cp(path.join(source, name), path.join(dir, name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        })
        .catch((error) => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        });
    }
    await fsp.symlink(path.join(source, 'objects'), path.join(dir, 'objects'));
    await fsp.writeFile(
      path.join(dir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tbare = false\n'
    );
    return await callback(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function countLines(text) {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

/**
 * Reasons a repository with `state` (see `GitInspector#repoState`) must not
 * be deleted, naming it `label`.
 * @returns {string[]}
 */
export function stateBlockers(label, state) {
  if (state.error) {
    return [`${label}: ${state.error}`];
  }
  const problems = [];
  if (state.dirty > 0) {
    problems.push(plural(state.dirty, 'uncommitted change'));
  }
  if (state.unpushed > 0) {
    problems.push(plural(state.unpushed, 'unpushed commit'));
  }
  if (state.stashes > 0) {
    problems.push(plural(state.stashes, 'stash entry', 'stash entries'));
  }
  return problems.length > 0
    ? [`Git repository ${label} has ${problems.join(', ')}`]
    : [];
}

export class GitInspector {
  /**
   * @param {object} env environment adapter
   */
  constructor(env) {
    this.env = env;
    this.states = new Map();
    this.roots = new Map();
    this.available = null;
  }

  async #git(root, args, safeDir = null) {
    const result = await this.env.run(
      [
        'git',
        ...GIT_FLAGS,
        '-C',
        root,
        ...(safeDir ? ['--git-dir', safeDir, '--work-tree', root] : []),
        ...args,
      ],
      { env: SAFE_GIT_ENV }
    );
    trace('git', root, args.join(' '), '->', result.code);
    return result;
  }

  async isAvailable() {
    this.available ??= await this.env.which('git');
    return this.available;
  }

  /**
   * Closest directory at or above `target` that contains `.git`, or null.
   * @param {string} target
   * @param {string} [stopAt] do not look above this directory
   */
  async findRepoRoot(target, stopAt) {
    const pathApi = this.env.path;
    let dir = target;
    const visited = [];
    for (;;) {
      if (this.roots.has(dir)) {
        const root = this.roots.get(dir);
        visited.forEach((entry) => this.roots.set(entry, root));
        return root;
      }
      visited.push(dir);
      if (await this.env.exists(pathApi.join(dir, '.git'))) {
        visited.forEach((entry) => this.roots.set(entry, dir));
        return dir;
      }
      const parent = pathApi.dirname(dir);
      if (parent === dir || dir === stopAt) {
        visited.forEach((entry) => this.roots.set(entry, null));
        return null;
      }
      dir = parent;
    }
  }

  /**
   * Uncommitted, unpushed and stashed work of a repository (cached).
   * @param {string} root
   * @returns {Promise<{root: string, error: string|null, dirty: number,
   *   unpushed: number, stashes: number, lastCommitMs: number}>}
   */
  repoState(root) {
    if (!this.states.has(root)) {
      this.states.set(root, this.#loadState(root));
    }
    return this.states.get(root);
  }

  /** Discard scan-time Git state before a deletion decision. */
  invalidate() {
    this.states.clear();
    this.roots.clear();
  }

  async #loadState(root) {
    const state = {
      root,
      error: null,
      dirty: 0,
      unpushed: 0,
      stashes: 0,
      lastCommitMs: 0,
    };
    if (!(await this.isAvailable())) {
      state.error = 'git is not installed, cannot verify the repository';
      return state;
    }
    try {
      return this.env.kind === 'host'
        ? await safeGitDirectory(root, (safeDir) =>
            this.#inspectState(root, state, safeDir)
          )
        : await this.#inspectState(root, state);
    } catch (error) {
      state.error = `cannot safely inspect Git repository: ${error.message}`;
      return state;
    }
  }

  async #inspectState(root, state, safeDir = null) {
    const git = (args) => this.#git(root, args, safeDir);
    const status = await git([
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]);
    if (status.code !== 0) {
      state.error = `git status failed: ${status.stderr.trim() || `exit ${status.code}`}`;
      return state;
    }
    state.dirty = countLines(status.stdout);
    const unpushed = await git([
      'log',
      'HEAD',
      '--branches',
      '--not',
      '--remotes',
      '--oneline',
    ]);
    if (unpushed.code !== 0) {
      state.error = `git log failed: ${unpushed.stderr.trim() || `exit ${unpushed.code}`}`;
      return state;
    }
    state.unpushed = countLines(unpushed.stdout);
    const stashes = await git(['stash', 'list']);
    if (stashes.code !== 0) {
      state.error = `git stash list failed: ${stashes.stderr.trim() || `exit ${stashes.code}`}`;
      return state;
    }
    state.stashes = countLines(stashes.stdout);
    const last = await git(['log', '-1', '--format=%ct']);
    const seconds = Number(last.stdout.trim());
    state.lastCommitMs = Number.isFinite(seconds) ? seconds * 1000 : 0;
    return state;
  }

  /**
   * Reasons a whole repository must not be deleted.
   * @param {string} root
   * @returns {Promise<string[]>}
   */
  async repoBlockers(root) {
    return stateBlockers(root, await this.repoState(root));
  }

  /** Protect an entire temporary work directory, including nested clones. */
  async treeBlockers(target) {
    const dirs = await this.env.findDirs([target], {
      globs: ['.git'],
      maxDepth: 32,
      skipNames: [],
    });
    const files = await this.env.findFiles([target], {
      names: ['.git'],
      maxDepth: 32,
      skipNames: [],
    });
    const roots = new Set([
      ...((await this.env.exists(this.env.path.join(target, '.git')))
        ? [target]
        : []),
      ...dirs.map((entry) => entry.parent),
      ...files.map((file) => this.env.path.dirname(file)),
    ]);
    if (roots.size === 0) {
      return [`${target}: no Git repository found; cannot verify work`];
    }
    if (roots.size > 50) {
      return [`${target}: too many repositories to verify safely`];
    }
    const blockers = [];
    for (const root of roots) {
      blockers.push(...(await this.repoBlockers(root)));
    }
    return blockers;
  }

  /**
   * Number of tracked files inside `target` (a path within `root`).
   * Returns -1 when Git cannot answer.
   */
  async trackedCount(root, target) {
    if (!(await this.isAvailable())) {
      return -1;
    }
    const relative = this.env.path.relative(root, target) || '.';
    try {
      const result =
        this.env.kind === 'host'
          ? await safeGitDirectory(root, (safeDir) =>
              this.#git(root, ['ls-files', '--', relative], safeDir)
            )
          : await this.#git(root, ['ls-files', '--', relative]);
      return result.code === 0 ? countLines(result.stdout) : -1;
    } catch {
      return -1;
    }
  }

  /**
   * Reasons a regenerable directory inside a work tree must be kept:
   * tracked files inside it, or (with `requireClean`) repository state.
   * @param {string} target
   * @param {{requireClean?: boolean, stopAt?: string}} [options]
   */
  async pathBlockers(target, { requireClean = false, stopAt } = {}) {
    const root = await this.findRepoRoot(target, stopAt);
    if (!root) {
      return [];
    }
    if (root === target) {
      return this.repoBlockers(root);
    }
    const tracked = await this.trackedCount(root, target);
    if (tracked === -1) {
      return [`cannot verify Git tracking of ${target}`];
    }
    if (tracked > 0) {
      return [`${plural(tracked, 'file')} inside ${target} tracked by Git`];
    }
    return requireClean ? this.repoBlockers(root) : [];
  }
}
