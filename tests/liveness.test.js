/**
 * Liveness decisions with a fake process table: activity window, running
 * tools (by kernel name, executable or argv[0]) and open files.
 */

import { describe, it, expect } from 'test-anywhere';
import path from 'node:path';

import { processAliases } from '../src/env/local.js';
import { LivenessProbe } from '../src/liveness.js';

const NOW = 1_000_000_000_000;

async function probe(processes, openPaths = new Set(), staleAgeMs = 3600e3) {
  const env = {
    path: path.posix,
    processes: () => Promise.resolve(processes),
    openPaths: () => Promise.resolve(openPaths),
  };
  const result = new LivenessProbe(env, { staleAgeMs, now: () => NOW });
  await result.refresh();
  return result;
}

const item = (fields = {}) => ({
  paths: ['/work/app/node_modules'],
  newestMtimeMs: NOW - 2 * 3600e3,
  checks: { busy: ['node', 'npm'], cwd: '/work/app', mtime: true },
  ...fields,
});

describe('process aliases', () => {
  it('uses executable and argv[0] base names', () => {
    expect(processAliases('/usr/bin/node', '/usr/bin/node')).toEqual(['node']);
    expect(processAliases('/usr/bin/node (deleted)', 'npm install')).toEqual([
      'node',
      'npm',
    ]);
    expect(processAliases('', '')).toEqual([]);
  });
});

describe('LivenessProbe', () => {
  it('lets an idle directory go', async () => {
    const live = await probe([{ pid: 9, name: 'bash', cwd: '/work/app' }]);
    expect(live.busyReason(item())).toBe(null);
  });

  it('reports writes inside the activity window', async () => {
    const live = await probe([]);
    expect(live.busyReason(item({ newestMtimeMs: NOW - 60e3 }))).toBe(
      'modified 1m ago, inside the 1h activity window'
    );
  });

  it('finds Node.js by executable when its thread is renamed', async () => {
    const live = await probe([
      { pid: 7, name: 'MainThread', aliases: ['node'], cwd: '/work/app/src' },
    ]);
    expect(live.busyReason(item())).toBe(
      'node is running in /work/app/src (pid 7)'
    );
  });

  it('ignores the tool when it runs in another project', async () => {
    const live = await probe([
      { pid: 7, name: 'npm', aliases: ['node', 'npm'], cwd: '/work/other' },
    ]);
    expect(live.busyReason(item())).toBe(null);
  });

  it('matches truncated 15-character kernel names', async () => {
    const live = await probe([
      { pid: 5, name: 'rust-analyzer-p', cwd: '/work/app' },
    ]);
    expect(
      live.busyReason(
        item({ checks: { busy: ['rust-analyzer-proc-macro-srv'], cwd: null } })
      )
    ).toBe('rust-analyzer-p is running (pid 5)');
  });

  it('reports files held open inside the directory', async () => {
    const live = await probe(
      [],
      new Set(['/work/app/node_modules/.bin/vite', '/work/app/package.json'])
    );
    expect(live.busyReason(item())).toBe(
      'in use: /work/app/node_modules/.bin/vite'
    );
  });
});
