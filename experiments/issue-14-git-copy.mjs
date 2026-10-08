/**
 * Repeat copied-repository inspection after commits, through a symlinked
 * temporary root like macOS /var. Run with the desired Git version on PATH.
 * Fixture commands disable automatic maintenance so copying a stopped
 * repository cannot race a background writer. Inputs are capped at 20 commits.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { containerGitState } from '../src/docker/containers.js';
import {
  git,
  pushedRepo,
  removeRoot,
  tempRoot,
} from '../tests/helpers/fixtures.js';

const root = tempRoot('dss-git-copy-probe-');
const previousTmp = process.env.TMPDIR;
try {
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  symlinkSync(tmp, join(root, 'tmp-link'));
  process.env.TMPDIR = join(root, 'tmp-link');
  const repo = pushedRepo(join(root, 'repo'));
  git(repo, 'checkout', '-q', '--detach', 'origin/main');
  const docker = {
    diff: () => Promise.resolve('C /work/repo/README.md\n'),
    pathExists: (_id, target) =>
      Promise.resolve(target === '/work/repo/.git/HEAD'),
    copyOut: (_id, _source, destination) => {
      try {
        cpSync(repo, join(destination, 'repo'), { recursive: true });
      } catch (error) {
        console.error(error.stack);
        throw error;
      }
      return Promise.resolve({ code: 0 });
    },
  };
  assert.deepEqual((await containerGitState(docker, 'box')).blockers, []);
  for (let attempt = 0; attempt < 20; attempt++) {
    writeFileSync(join(repo, 'README.md'), `unpublished ${attempt}`);
    git(repo, 'commit', '-qam', 'unpublished');
    const result = await containerGitState(docker, 'box');
    assert.match(result.blockers.join(), /unpushed/);
  }
  console.log('20 copied detached-repository inspections passed');
} finally {
  if (previousTmp === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmp;
  }
  removeRoot(root);
}
