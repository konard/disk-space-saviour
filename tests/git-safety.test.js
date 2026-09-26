/**
 * Git and liveness safety against real repositories and processes: tracked
 * files, uncommitted, unpushed and stashed work, and open files block
 * deletion, both when scanning and again right before deleting.
 */

import { describe, it, expect } from 'test-anywhere';
import { spawn } from 'node:child_process';
import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { clean, cleanOptions } from '../src/clean.js';
import { LocalEnv } from '../src/env/local.js';
import { GitInspector, stateBlockers } from '../src/git.js';
import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  git,
  pushedRepo,
  readOnlyRuntime,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

/**
 * A pushed repository with an old, untracked `node_modules`.
 */
function repoWithModules(root) {
  const repo = pushedRepo(join(root, 'app'));
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(repo, 'package-lock.json'), '{}');
  git(repo, 'add', 'package.json', 'package-lock.json');
  git(repo, 'commit', '-q', '-m', 'package');
  git(repo, 'push', '-q');
  const modules = join(repo, 'node_modules');
  writeBlob(join(modules, 'left-pad', 'index.js'));
  age(root, 40 * DAY_MS);
  return { repo, modules };
}

async function scanRepo(root) {
  const env = fixtureEnv(root);
  const report = await scan(scanInput(env, [root], { scanners: ['projects'] }));
  return { env, report };
}

describe('Git state', () => {
  it('does not inherit an aggressive tier or disabled age checks from a saved report', () => {
    const options = cleanOptions(
      { options: { tier: 'aggressive', olderThan: '0s' } },
      {}
    );
    expect(options.tier).toBe('safe');
    expect(options.staleAgeMs).toBe(60 * 60 * 1000);
  });
  it('reserves aggressive cleanup for emergency mode', () => {
    expect(() => cleanOptions({ options: {} }, { tier: 'aggressive' })).toThrow(
      /emergency mode/
    );
  });
  it('names every kind of unsaved work', () => {
    expect(
      stateBlockers('/w', { error: null, dirty: 2, unpushed: 1, stashes: 1 })
    ).toEqual([
      'Git repository /w has 2 uncommitted changes, 1 unpushed commit, 1 stash entry',
    ]);
    expect(
      stateBlockers('/w', { error: null, dirty: 0, unpushed: 0, stashes: 0 })
    ).toEqual([]);
    expect(stateBlockers('/w', { error: 'git status failed' })).toEqual([
      '/w: git status failed',
    ]);
  });

  it('blocks a repository with uncommitted, unpushed or stashed work', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-git-state-');
    const repo = pushedRepo(join(root, 'repo'));
    const blockers = () =>
      new GitInspector(fixtureEnv(root)).repoBlockers(repo);
    expect(await blockers()).toEqual([]);

    writeFileSync(join(repo, 'README.md'), 'changed contents\n');
    expect((await blockers()).join()).toMatch(/1 uncommitted change/);

    git(repo, 'stash', '-q');
    expect((await blockers()).join()).toMatch(/1 stash entry/);
    git(repo, 'stash', 'drop', '-q');

    writeFileSync(join(repo, 'NEW.md'), 'new\n');
    git(repo, 'add', 'NEW.md');
    git(repo, 'commit', '-q', '-m', 'local only');
    expect((await blockers()).join()).toMatch(/1 unpushed commit/);
    removeRoot(root);
  });

  it('blocks an unpushed commit on detached HEAD', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-git-detached-');
    const repo = pushedRepo(join(root, 'repo'));
    git(repo, 'checkout', '--detach', '-q');
    writeFileSync(join(repo, 'DETACHED.md'), 'local work\n');
    git(repo, 'add', 'DETACHED.md');
    git(repo, 'commit', '-q', '-m', 'detached work');
    expect(
      (await new GitInspector(fixtureEnv(root)).repoBlockers(repo)).join()
    ).toMatch(/1 unpushed commit/);
    removeRoot(root);
  });

  it('does not execute commands configured by a repository during inspection', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-git-untrusted-');
    const repo = pushedRepo(join(root, 'repo'));
    const monitor = join(root, 'FSMONITOR_RAN');
    const filter = join(root, 'FILTER_RAN');
    git(repo, 'config', 'core.fsmonitor', `touch ${monitor}; false`);
    git(repo, 'config', 'filter.evil.clean', `touch ${filter}; cat`);
    writeFileSync(join(repo, '.gitattributes'), 'README.md filter=evil\n');
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    await new GitInspector(fixtureEnv(root)).repoBlockers(repo);
    expect(existsSync(monitor)).toBe(false);
    expect(existsSync(filter)).toBe(false);
    removeRoot(root);
  });

  it('blocks a directory with tracked files at scan time', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-git-tracked-');
    const { repo } = repoWithModules(root);
    git(repo, 'add', '-f', 'node_modules');
    git(repo, 'commit', '-q', '-m', 'vendor modules');
    git(repo, 'push', '-q');
    const { report } = await scanRepo(root);
    expect(report.items[0].blockers).toEqual([
      `1 file inside ${join(repo, 'node_modules')} tracked by Git`,
    ]);
    removeRoot(root);
  });
});

describe('re-checks right before deleting', () => {
  it('protects a nested solver clone at scan time and after a saved report', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const parent = tempRoot('dss-solver-parent-');
    const work = join(parent, 'gh-issue-solver-example');
    const repo = pushedRepo(join(work, 'checkout'));
    age(work, 40 * DAY_MS);
    const env = new LocalEnv({ homes: [], tmpDirs: [parent] });
    env.processes = async () => [];
    env.openPaths = async () => new Set();
    const input = scanInput(env, [], {
      scanners: ['global'],
      now: () => Date.now() + DAY_MS,
    });
    const report = await scan(input);
    const item = report.items.find((entry) => entry.path === work);
    expect(Boolean(item)).toBe(true);
    expect(item.blockers).toEqual([]);
    git(repo, 'checkout', '--detach', '-q');
    writeFileSync(join(repo, 'WORK.md'), 'unpublished\n');
    git(repo, 'add', 'WORK.md');
    git(repo, 'commit', '-q', '-m', 'work');
    const fresh = await scan(input);
    expect(
      fresh.items.find((entry) => entry.path === work).blockers.join()
    ).toMatch(/unpushed commit/);
    const audit = await clean(report, {
      env,
      tier: 'moderate',
      now: () => Date.now() + DAY_MS,
      audit: false,
    });
    expect(audit.entries.find((entry) => entry.path === work).reason).toMatch(
      /unpushed commit/
    );
    expect(existsSync(work)).toBe(true);
    removeRoot(parent);
  });

  it('deletes an untracked dependency dir of a clean, pushed repo', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-git-clean-');
    const { modules } = repoWithModules(root);
    const { env, report } = await scanRepo(root);
    const audit = await clean(report, { env, tier: 'moderate', audit: false });
    expect(audit.entries.map((e) => e.status)).toEqual(['removed']);
    expect(existsSync(modules)).toBe(false);
    removeRoot(root);
  });

  it('keeps it when the repository has uncommitted changes', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-git-dirty-');
    const { repo, modules } = repoWithModules(root);
    const { env, report } = await scanRepo(root);
    writeFileSync(join(repo, 'README.md'), 'work in progress\n');
    const audit = await clean(report, { env, tier: 'moderate', audit: false });
    expect(audit.entries[0].status).toBe('skipped');
    expect(audit.entries[0].reason).toMatch(/1 uncommitted change/);
    expect(existsSync(modules)).toBe(true);
    removeRoot(root);
  });

  it('keeps it when files inside became tracked after the scan', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-git-late-');
    const { repo, modules } = repoWithModules(root);
    const { env, report } = await scanRepo(root);
    git(repo, 'add', '-f', 'node_modules');
    const audit = await clean(report, { env, tier: 'moderate', audit: false });
    expect(audit.entries[0].reason).toMatch(/tracked by Git/);
    expect(existsSync(modules)).toBe(true);
    removeRoot(root);
  });

  it('keeps it when it was written to after the scan', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-git-written-');
    const { modules } = repoWithModules(root);
    const { env, report } = await scanRepo(root);
    writeBlob(join(modules, 'new-dep', 'index.js'), 10);
    const audit = await clean(report, { env, tier: 'moderate', audit: false });
    expect(audit.entries[0].reason).toMatch(/^busy: modified/);
    expect(existsSync(modules)).toBe(true);
    removeRoot(root);
  });
});

describe('liveness re-checks right before deleting', () => {
  /**
   * Holds a file inside `node_modules` open while cleaning a report made
   * from `scanRoot`, which may be a symlink to the repository's parent.
   */
  async function cleanWhileOpen(root, scanRoot) {
    const { modules } = repoWithModules(root);
    const { env, report } = await scanRepo(scanRoot);
    const held = join(scanRoot, 'app', 'node_modules', 'left-pad', 'index.js');
    const holder = spawn('tail', ['-f', held], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const audit = await clean(report, {
        env,
        tier: 'moderate',
        audit: false,
      });
      expect(audit.entries[0].reason).toMatch(/^busy: in use: .*index\.js$/);
      expect(existsSync(modules)).toBe(true);
    } finally {
      holder.kill();
    }
  }

  const liveness =
    process.platform === 'linux' || process.platform === 'darwin';

  it('keeps it while a process holds a file inside open', async () => {
    if (readOnlyRuntime() || !liveness) {
      return;
    }
    const root = tempRoot('dss-git-open-');
    await cleanWhileOpen(root, root);
    removeRoot(root);
  });

  it('sees open files when the scanned path is a symlink', async () => {
    if (readOnlyRuntime() || !liveness) {
      return;
    }
    const root = tempRoot('dss-git-real-');
    const links = tempRoot('dss-git-link-');
    const link = join(links, 'work');
    symlinkSync(root, link);
    await cleanWhileOpen(root, link);
    removeRoot(links);
    removeRoot(root);
  });

  it('keeps it while the package manager runs inside the project', async () => {
    if (readOnlyRuntime() || process.platform !== 'linux') {
      return;
    }
    const root = tempRoot('dss-git-tool-');
    const { repo, modules } = repoWithModules(root);
    const { env, report } = await scanRepo(root);
    const tool = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 20000)'],
      {
        cwd: repo,
        stdio: 'ignore',
      }
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const audit = await clean(report, {
        env,
        tier: 'moderate',
        audit: false,
      });
      expect(audit.entries[0].reason).toMatch(
        new RegExp(`is running in ${repo} \\(pid ${tool.pid}\\)`)
      );
      expect(existsSync(modules)).toBe(true);
    } finally {
      tool.kill();
      removeRoot(root);
    }
  });
});
