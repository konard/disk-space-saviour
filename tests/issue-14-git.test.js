import { describe, it, expect } from 'test-anywhere';
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { containerGitState } from '../src/docker/containers.js';
import { git, pushedRepo, removeRoot, tempRoot } from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

async function inspect(repo, diff = 'C /work/repo/README.md\n') {
  return containerGitState(
    {
      diff: async () => diff,
      pathExists: async (_id, target) => target === '/work/repo/.git/HEAD',
      copyOut: async (_id, _source, destination) => {
        cpSync(repo, join(destination, basename('/work/repo')), {
          recursive: true,
        });
        return { code: 0 };
      },
    },
    'box'
  );
}

describe('issue 14 preserved container work', () => {
  itUnless(sandboxed)(
    'recognizes modified and untracked files saved together on a remote recovery ref',
    async () => {
      const root = tempRoot();
      try {
        const repo = pushedRepo(join(root, 'repo'));
        git(repo, 'checkout', '-qb', 'recovery/task');
        writeFileSync(join(repo, 'README.md'), 'saved changes\n');
        writeFileSync(join(repo, 'new file.txt'), 'saved new file\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-qm', 'save work');
        git(repo, 'push', '-q', 'origin', 'recovery/task');
        git(repo, 'checkout', '-q', 'main');
        git(repo, 'branch', '-D', 'recovery/task');
        writeFileSync(join(repo, 'README.md'), 'saved changes\n');
        writeFileSync(join(repo, 'new file.txt'), 'saved new file\n');
        const result = await inspect(repo);
        expect(result.blockers).toEqual([]);
        expect(result.repos[0].preservedOn).toBe('origin/recovery/task');
        expect(result.repos[0].untracked).toBe(1);
        writeFileSync(join(repo, 'new file.txt'), 'unsaved change\n');
        expect((await inspect(repo)).blockers.join()).toMatch(/uncommitted/);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'requires deletions to match the saved ref and keeps staged work protected',
    async () => {
      const root = tempRoot();
      try {
        const repo = pushedRepo(join(root, 'repo'));
        rmSync(join(repo, 'README.md'));
        expect((await inspect(repo)).blockers.join()).toMatch(/uncommitted/);
        git(repo, 'checkout', '--', 'README.md');
        writeFileSync(join(repo, 'README.md'), 'staged work');
        git(repo, 'add', '.');
        expect((await inspect(repo)).blockers.join()).toMatch(/uncommitted/);
      } finally {
        removeRoot(root);
      }
    }
  );

  it('ignores nested Docker layer copies and temporary Codex plugin checkouts', async () => {
    const copied = [];
    const result = await containerGitState(
      {
        diff: async () =>
          'A /var/lib/docker/fuse-overlayfs/abc/diff/work/repo/.git/HEAD\nA /home/box/.codex/.tmp/plugins-123/vendor/.git/HEAD\n',
        pathExists: async () => {
          throw new Error('excluded paths must not be probed');
        },
        copyOut: async (_id, source) => {
          copied.push(source);
          return { code: 1 };
        },
      },
      'box'
    );
    expect(copied).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  itUnless(sandboxed)(
    'accepts a detached upstream commit but protects a new detached commit',
    async () => {
      const root = tempRoot();
      try {
        const repo = pushedRepo(join(root, 'repo'));
        git(repo, 'checkout', '-q', '--detach', 'origin/main');
        expect((await inspect(repo)).blockers).toEqual([]);
        writeFileSync(join(repo, 'README.md'), 'unpublished');
        git(repo, 'commit', '-qam', 'unpublished');
        expect((await inspect(repo)).blockers.join()).toMatch(/unpushed/);
      } finally {
        removeRoot(root);
      }
    }
  );
});
