/**
 * Real file-system fixtures for scanner and cleaner tests: temporary
 * project trees, fake home directories and Git repositories.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LocalEnv } from '../../src/env/local.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deno CI grants read access only; tests that write files or start
 * processes return early there.
 */
export const readOnlyRuntime = () => typeof Deno !== 'undefined';

export function tempRoot(prefix = 'dss-fixture-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

/**
 * Writes `bytes` bytes to `file`, creating parent directories.
 */
export function writeBlob(file, bytes = 64 * 1024) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

/**
 * Sets the access and modification time of `target` and everything below
 * it to `ageMs` ago.
 */
export function age(target, ageMs) {
  const when = new Date(Date.now() - ageMs);
  const visit = (current) => {
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      visit(join(current, entry.name));
    }
    utimesSync(current, when, when);
  };
  visit(target);
}

const concrete = (name) => name.replaceAll('*', 'app');

/**
 * Builds the smallest project tree a project rule recognises inside
 * `root/<rule.id>` and returns the directory the rule should report.
 */
export function projectFixture(root, rule, bytes = 64 * 1024) {
  const project = join(root, rule.id);
  mkdirSync(project, { recursive: true });
  const marker = (rule.markers ?? rule.parentMarkers ?? [])[0];
  if (marker) {
    writeFileSync(join(project, concrete(marker)), '');
  }
  const parent = rule.parentName ? join(project, rule.parentName) : project;
  const dir = join(parent, concrete(rule.names[0]));
  mkdirSync(dir, { recursive: true });
  const selfMarker = rule.selfMarkers?.[0];
  if (selfMarker) {
    writeFileSync(join(dir, selfMarker), '');
  }
  writeBlob(join(dir, 'payload.bin'), bytes);
  return dir;
}

/**
 * Local environment confined to fixture directories: only processes
 * working inside `root` and only open paths inside it are visible, so
 * whatever else runs on the test machine cannot make fixtures busy.
 */
class FixtureEnv extends LocalEnv {
  constructor(root) {
    super({
      label: 'host (fixture)',
      homes: [join(root, 'home')],
      tmpDirs: [],
      vars: {},
    });
    // Processes report paths with symlinks resolved (macOS: /private/var).
    this.roots = [root, realpathSync(root)];
  }

  #inside(target) {
    return this.roots.some((root) => target?.startsWith(root));
  }

  async processes() {
    return (await super.processes()).filter((proc) => this.#inside(proc.cwd));
  }

  async openPaths() {
    const paths = await super.openPaths();
    return paths
      ? new Set([...paths].filter((open) => this.#inside(open)))
      : null;
  }
}

export function fixtureEnv(root) {
  return new FixtureEnv(root);
}

/**
 * Base options for scans that only look at `roots`.
 */
export function scanInput(env, roots, overrides = {}) {
  return {
    env,
    roots,
    docker: false,
    minSize: 0,
    auditDir: null,
    noNative: true,
    ...overrides,
  };
}

/**
 * Fixture commits are dated 40 days back so projects count as inactive.
 * Built on first use: reading `process.env` needs a permission Deno CI
 * does not grant.
 */
function gitEnv() {
  const date = new Date(Date.now() - 40 * DAY_MS).toISOString();
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'dss test',
    GIT_AUTHOR_EMAIL: 'dss@example.invalid',
    GIT_COMMITTER_NAME: 'dss test',
    GIT_COMMITTER_EMAIL: 'dss@example.invalid',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

/**
 * Git repository at `dir` with one pushed commit (to a bare remote next to
 * it), so it starts clean and fully pushed.
 */
export function pushedRepo(dir) {
  const remote = `${dir}-remote.git`;
  mkdirSync(dir, { recursive: true });
  git(dirname(dir), 'init', '-q', '--bare', remote);
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return dir;
}
