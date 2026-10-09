import { describe, it, expect } from 'test-anywhere';
import path from 'node:path';
import { scanEnvironment } from '../src/scan.js';
import { resolveOptions } from '../src/options.js';
import { ShellEnv } from '../src/env/shell.js';
import { containerExecutor } from '../src/exec.js';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

function storageEnv({ diff = '', mounts = [], fail = false } = {}) {
  const parent = {
    label: 'host',
    run: async (argv) => {
      if (argv[0] === 'cat') {
        return ok('MemAvailable: 1048576 kB\n');
      }
      if (argv[1] === 'diff') {
        return fail ? { code: 1, stdout: '', stderr: 'failed' } : ok(diff);
      }
      if (argv[1] === 'inspect') {
        return ok(JSON.stringify([{ Id: 'box', Mounts: mounts }]));
      }
      return ok();
    },
  };
  const env = new ShellEnv(containerExecutor(parent, 'box'));
  env.path = path.posix;
  // Actual merged usage includes 900 image bytes and 100 writable bytes.
  env.rawUsageMany = async (targets) =>
    new Map(
      targets.map((target) => [
        target,
        {
          bytes: target === '/cache/volume' ? 200 : 1000,
          newestMtimeMs: 1,
        },
      ])
    );
  env.statMany = async (targets) =>
    new Map(
      targets.map((target) => [
        target,
        {
          type: target === '/cache' ? 'dir' : 'file',
          bytes: 100,
          inode: target,
        },
      ])
    );
  return env;
}

describe('issue 14 writable-layer usage', () => {
  it('counts changed files without walking a changed directory into lower layers', async () => {
    const env = storageEnv({
      diff: 'C /cache\nA /cache/new\nD /cache/deleted\n',
    });
    const usage = (await env.usageMany(['/cache'])).get('/cache');
    expect(usage.bytes).toBe(100);
    expect(usage.imageBytes).toBe(900);
    expect(usage.totalBytes).toBe(1000);
  });

  it('reports an unchanged image cache as zero reclaimable bytes', async () => {
    const env = storageEnv();
    expect((await env.usageMany(['/cache'])).get('/cache').bytes).toBe(0);
  });

  it('includes mounted data and never double counts it as layer data', async () => {
    const env = storageEnv({
      diff: 'A /cache/new\nA /cache/volume/data\n',
      mounts: [{ Type: 'volume', Destination: '/cache/volume' }],
    });
    expect((await env.usageMany(['/cache'])).get('/cache').bytes).toBe(300);
    expect(
      (await env.usageMany(['/cache/volume'])).get('/cache/volume').bytes
    ).toBe(200);
  });

  it('marks failed layer inspection as unknown with zero estimated bytes', async () => {
    const env = storageEnv({ fail: true });
    const usage = (await env.usageMany(['/cache'])).get('/cache');
    expect(usage.bytes).toBe(0);
    expect(usage.sizeUnknown).toBe(true);
  });

  it('keeps image-only caches visible in a real scanner report', async () => {
    const env = storageEnv();
    env.homeDirs = async () => ['/home/box'];
    env.tmpDirs = async () => [];
    env.processes = async () => [];
    env.openPaths = async () => new Set();
    env.existsMany = async (targets) =>
      new Set(targets.filter((target) => target === '/home/box/.npm/_cacache'));
    env.listMany = async () => new Map();
    const items = await scanEnvironment(
      env,
      resolveOptions({ scanners: ['global'], noNative: true })
    );
    const item = items.find((entry) => entry.rule === 'npm-cache');
    expect(item.bytes).toBe(0);
    expect(item.imageBytes).toBe(1000);
  });
});
