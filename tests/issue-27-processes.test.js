import { describe, it, expect } from 'test-anywhere';
import path from 'node:path';
import { LocalEnv } from '../src/env/local.js';
import { LivenessProbe } from '../src/liveness.js';
import { readOnlyRuntime } from './helpers/fixtures.js';

const denied = () =>
  Object.assign(new Error('permission denied'), { code: 'EACCES' });
const missing = () => Object.assign(new Error('gone'), { code: 'ENOENT' });
function procFs() {
  return {
    readdir: async (target) =>
      target === '/proc'
        ? ['10', '11']
        : target === '/proc/10/fd'
          ? ['1']
          : Promise.reject(denied()),
    readFile: async (target) => {
      if (target.endsWith('/stat')) {
        return `10 (name) S ${'0 '.repeat(20)}`;
      }
      if (target.endsWith('/comm')) {
        return target.includes('/11/') ? 'dockerd' : 'node';
      }
      if (target.endsWith('/status')) {
        return `Uid:\t${target.includes('/11/') ? 0 : 1001}\t0\t0\t0\n`;
      }
      if (target.endsWith('/cmdline')) {
        return target.includes('/11/')
          ? 'dockerd\0--data-root\0/var/lib/docker\0'
          : 'node\0/work/tool.js\0';
      }
      throw missing();
    },
    readlink: async (target) => {
      if (target.includes('/11/')) {
        throw denied();
      }
      return target.endsWith('/cwd')
        ? '/work'
        : target.endsWith('/exe')
          ? '/usr/bin/node'
          : '/work/tool.js';
    },
  };
}

describe('issue 25 partial process inspection', () => {
  it('retains readable paths when a root daemon denies inspection', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const env = new LocalEnv({
      platform: 'linux',
      procFs: procFs(),
      executor: {
        run: async () => ({ code: 1, stdout: '', stderr: 'sudo unavailable' }),
      },
    });
    env.stat = async () => ({ uid: 1001 });
    env.realPath = async (target) => target;
    const probe = new LivenessProbe(env, { staleAgeMs: 0 });
    await probe.refresh();
    await probe.resolve([
      '/home/box/.cache/bun',
      '/var/lib/docker/data',
      '/work',
    ]);
    expect(probe.openPaths.has('/work/tool.js')).toBe(true);
    const item = (target) => ({ paths: [target], checks: { mtime: false } });
    expect(probe.busyReason(item('/home/box/.cache/bun'))).toBe(null);
    expect(probe.busyReason(item('/var/lib/docker/data'))).toMatch(
      /unreadable|in use/
    );
    expect(probe.busyReason(item('/work'))).toMatch(/in use/);
  });

  it('protects a package path passed to node even with no open descriptor', async () => {
    const env = {
      path: path.posix,
      platform: 'darwin',
      openPaths: async () => new Set(),
      processes: async () => [
        {
          pid: 10,
          name: 'node',
          command: 'node /Users/me/.npm/_npx/active/node_modules/server.js',
        },
      ],
    };
    const probe = new LivenessProbe(env, { staleAgeMs: 0 });
    await probe.refresh();
    expect(
      probe.busyReason({ paths: ['/Users/me/.npm/_npx/active'], checks: {} })
    ).toMatch(/in use/);
    expect(
      probe.busyReason({ paths: ['/Users/me/.npm/_npx/idle'], checks: {} })
    ).toBe(null);
  });

  it('protects the current installation independently from process probes', async () => {
    const env = {
      path: path.posix,
      protectedPaths: ['/cache/active/node_modules/disk-space-saviour'],
      openPaths: async () => new Set(),
      processes: async () => [],
    };
    const probe = new LivenessProbe(env, { staleAgeMs: 0 });
    await probe.refresh();
    expect(probe.busyReason({ paths: ['/cache/active'], checks: {} })).toMatch(
      /dss.*installation/
    );
    expect(probe.busyReason({ paths: ['/cache/idle'], checks: {} })).toBe(null);
  });
});
