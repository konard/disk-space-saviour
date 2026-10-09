import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellEnv } from '../src/env/shell.js';
import { ScanPolicy } from '../src/env/policy.js';
import { hostExecutor } from '../src/exec.js';

const root = mkdtempSync(join(tmpdir(), 'dss-shell-boundaries-'));
try {
  const cache = join(root, 'cache');
  mkdirSync(join(cache, 'keep'), { recursive: true });
  writeFileSync(join(cache, 'keep', 'data'), 'preserved');
  for (const suffix of ['keep*', '**/keep', '**/keep/**']) {
    const env = new ShellEnv(hostExecutor());
    env.scanPolicy = new ScanPolicy(
      env,
      { roots: [root], exclude: [`${cache}/${suffix}`] },
      []
    );
    const usages = await env.rawUsageMany([cache]);
    assert.equal(usages.size, 0, suffix);
    console.log(`${suffix}: pruned before measurement`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
