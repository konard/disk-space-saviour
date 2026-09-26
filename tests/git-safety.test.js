/**
 * Git and liveness safety against real repositories and processes: tracked
 * files, uncommitted, unpushed and stashed work, and open files block
 * deletion, both when scanning and again right before deleting.
 */

import { describe, it, expect } from 'test-anywhere';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
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
  git(repo, 'add', 'package.json');
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

    writeFileSync(join(repo, 'README.md'), 'changed\n');
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

  it('keeps it while a process holds a file inside open', async () => {
    const liveness =
      process.platform === 'linux' || process.platform === 'darwin';
    if (readOnlyRuntime() || !liveness) {
      return;
    }
    const root = tempRoot('dss-git-open-');
    const { modules } = repoWithModules(root);
    const { env, report } = await scanRepo(root);
    const holder = spawn(
      'tail',
      ['-f', join(modules, 'left-pad', 'index.js')],
      {
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
      expect(audit.entries[0].reason).toMatch(/^busy: in use: .*index\.js$/);
      expect(existsSync(modules)).toBe(true);
    } finally {
      holder.kill();
      removeRoot(root);
    }
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
