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

import { trace } from './exec.js';

const GIT_FLAGS = ['--no-optional-locks', '-c', 'safe.directory=*'];

function countLines(text) {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
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

  async #git(root, args) {
    const result = await this.env.run([
      'git',
      ...GIT_FLAGS,
      '-C',
      root,
      ...args,
    ]);
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
    const status = await this.#git(root, [
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]);
    if (status.code !== 0) {
      state.error = `git status failed: ${status.stderr.trim() || `exit ${status.code}`}`;
      return state;
    }
    state.dirty = countLines(status.stdout);
    const unpushed = await this.#git(root, [
      'log',
      '--branches',
      '--not',
      '--remotes',
      '--oneline',
    ]);
    state.unpushed = unpushed.code === 0 ? countLines(unpushed.stdout) : 0;
    const stashes = await this.#git(root, ['stash', 'list']);
    state.stashes = stashes.code === 0 ? countLines(stashes.stdout) : 0;
    const last = await this.#git(root, ['log', '-1', '--format=%ct']);
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
    const state = await this.repoState(root);
    if (state.error) {
      return [`${root}: ${state.error}`];
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
      ? [`Git repository ${root} has ${problems.join(', ')}`]
      : [];
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
    const result = await this.#git(root, ['ls-files', '--', relative]);
    return result.code === 0 ? countLines(result.stdout) : -1;
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
