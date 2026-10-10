import { describe, it, expect } from 'test-anywhere';
import { LivenessProbe } from '../src/liveness.js';
import { tierTotals, makeItem, block } from '../src/items.js';
import { ShellEnv } from '../src/env/shell.js';
import path from 'node:path';
import { retryProcessOwners } from '../src/env/inspection.js';
import { containerExecutor } from '../src/exec.js';

describe('issue 38 permission-aware activity', () => {
  it('retries denied processes under their UID/GID without waiving remaining failures', async () => {
    const calls = [],
      first = { pid: 10, uid: 1001, gid: 1001, name: 'node' },
      second = { pid: 11, uid: 1002, gid: 1002, name: 'python' };
    const executor = {
      run: (argv) => {
        calls.push(argv);
        return Promise.resolve(
          argv.includes('--reuid=1001')
            ? { code: 0, stdout: '/cache/active\n', stderr: '' }
            : { code: 127, stdout: '', stderr: 'setpriv unavailable' }
        );
      },
    };
    const result = await retryProcessOwners(executor, {
      paths: new Set(['/readable']),
      unreadable: [first, second],
    });
    expect([...result.paths]).toEqual(['/readable', '/cache/active']);
    expect(result.unreadable).toEqual([second]);
    expect(calls[0]).toContain('--clear-groups');
    expect(calls[0]).toContain('/proc/10');
  });
  it('preserves initial readable evidence when privileged Docker inspection fails', async () => {
    const parent = {
      label: 'host',
      run: (argv) =>
        Promise.resolve(
          argv.includes('--privileged')
            ? { code: 1, stdout: '', stderr: 'denied' }
            : {
                code: 1,
                stdout: '/readable/cache\n',
                stderr:
                  'DSS_UNREADABLE|11|0|dockerd|dockerd --data-root=/docker\nDSS_GID|11|0\n',
              }
        ),
    };
    const env = new ShellEnv(containerExecutor(parent, 'box'));
    const paths = await env.openPaths();
    expect(paths.has('/readable/cache')).toBe(true);
    expect(env.unreadableProcesses[0].pid).toBe(11);
    expect(env.probeHint).toMatch(/CAP_SYS_PTRACE/);
  });
  it('scopes unreadable root Docker daemons to their storage and runtime paths', async () => {
    const env = {
      path: path.posix,
      unreadableProcesses: [
        {
          pid: 8,
          uid: 0,
          name: 'dockerd',
          argv: ['dockerd', '--data-root=/docker'],
        },
      ],
      statMany: (paths) =>
        Promise.resolve(
          new Map(paths.map((p) => [p, { uid: 1001, mode: 0o40700 }]))
        ),
    };
    const probe = new LivenessProbe(env, { staleAgeMs: 0 });
    await probe.resolve(['/home/dev/.cache', '/docker/build']);
    expect(probe.uncertainUsage(['/home/dev/.cache'])).toBe(null);
    expect(probe.uncertainUsage(['/docker/build'])).toMatch(
      /unreadable.*dockerd/
    );
    env.unreadableProcesses[0].name = 'unknown';
    expect(probe.uncertainUsage(['/home/dev/.cache'])).toMatch(/unreadable/);
  });
  it('returns owners and permissions for remote stat, including single paths', async () => {
    const env = new ShellEnv({
      label: 'remote',
      run: () =>
        Promise.resolve({
          code: 0,
          stdout: 'directory|4096|8|512|1|/cache|1:2:1001:1001:41c0\n',
          stderr: '',
        }),
    });
    const stat = await env.stat('/cache');
    expect(stat.uid).toBe(1001);
    expect(stat.gid).toBe(1001);
    expect(stat.mode).toBe(0o40700);
  });
  it('shows blocked known and unknown sizes without counting nested data twice', () => {
    const env = { id: 'host', label: 'host' };
    const parent = block(
      makeItem(env, {
        rule: 'cache',
        path: '/cache',
        bytes: 0,
        totalBytes: 8192,
        sizeUnknown: true,
      }),
      'unreadable process'
    );
    const child = block(
      makeItem(env, {
        rule: 'child',
        path: '/cache/child',
        bytes: 4096,
        parentId: parent.id,
      }),
      'unreadable process'
    );
    const totals = tierTotals([parent, child]);
    expect(totals.blocked.bytes).toBe(0);
    expect(totals.blocked.totalBytes).toBe(8192);
    expect(totals.blocked.unknownBytes).toBe(8192);
    expect(totals.safe.bytes).toBe(0);
  });
});
