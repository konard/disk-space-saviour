/**
 * Emergency mode on a fixture volume whose free space follows the files
 * under the fixture root: tiers escalate only as far as the goal needs and
 * the run stops as soon as the goal is met.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync, lstatSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  bytesNeeded,
  emergency,
  goalMet,
  usedPercent,
} from '../src/emergency.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  readOnlyRuntime,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

const KIB = 1024;
const CAPACITY = 100 * KIB * KIB;

function treeBytes(target) {
  const stats = lstatSync(target);
  if (!stats.isDirectory()) {
    return stats.blocks * 512;
  }
  return readdirSync(target).reduce(
    (sum, name) => sum + treeBytes(join(target, name)),
    stats.blocks * 512
  );
}

/**
 * Fixture environment on a pretend volume of CAPACITY bytes whose used
 * space is whatever lies under `root`.
 */
function volumeEnv(root) {
  const env = fixtureEnv(root);
  env.diskUsage = () => {
    const used = treeBytes(root);
    return Promise.resolve({ total: CAPACITY, used, free: CAPACITY - used });
  };
  return env;
}

/**
 * Two caches (safe), an abandoned project (moderate) and a project used
 * three days ago (aggressive).
 */
function volume() {
  const root = tempRoot('dss-emergency-');
  const home = join(root, 'home');
  const paths = {
    npm: writeBlob(join(home, '.npm', '_cacache', 'blob'), 512 * KIB),
    pip: writeBlob(join(home, '.cache', 'pip', 'blob'), 256 * KIB),
  };
  for (const [name, bytes] of [
    ['old', 1024 * KIB],
    ['recent', 2048 * KIB],
  ]) {
    const project = join(root, 'projects', name);
    writeBlob(join(project, 'node_modules', 'dep', 'index.js'), bytes);
    writeFileSync(join(project, 'package.json'), '{}');
    paths[name] = join(project, 'node_modules');
  }
  age(root, 40 * DAY_MS);
  age(join(root, 'projects', 'recent'), 3 * DAY_MS);
  const env = volumeEnv(root);
  const run = async (extra) =>
    emergency({
      ...scanInput(env, [join(root, 'projects')], {
        scanners: ['projects', 'global'],
        auditDir: join(root, 'audit'),
      }),
      path: root,
      ...extra,
    });
  const free = () => CAPACITY - treeBytes(root);
  const kept = () => Object.keys(paths).filter((key) => existsSync(paths[key]));
  return { root, run, free, kept };
}

describe('emergency goals', () => {
  const disk = { total: 100, used: 90, free: 10 };

  it('measures used space like df', () => {
    expect(usedPercent(disk)).toBe(90);
    expect(usedPercent({ used: 0, free: 0 })).toBe(0);
  });

  it('knows how much is missing for --free and --until', () => {
    expect(goalMet({ freeBytes: 10, untilPercent: null }, disk)).toBe(true);
    expect(bytesNeeded({ freeBytes: 25, untilPercent: null }, disk)).toBe(15);
    expect(goalMet({ freeBytes: null, untilPercent: 80 }, disk)).toBe(false);
    expect(bytesNeeded({ freeBytes: null, untilPercent: 80 }, disk)).toBe(10);
    expect(bytesNeeded({ freeBytes: 15, untilPercent: 85 }, disk)).toBe(5);
  });
});

describe('emergency mode', () => {
  it('stops after the caches when they free enough', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { root, run, free, kept } = volume();
    const audit = await run({ free: free() + 100 * KIB });
    expect(audit.goalMet).toBe(true);
    expect(audit.reachedTier).toBe('safe');
    expect(audit.entries.map((e) => [e.rule, e.status])).toEqual([
      ['npm-cache', 'removed'],
    ]);
    expect(kept()).toEqual(['pip', 'old', 'recent']);
    removeRoot(root);
  });

  it('escalates to the moderate tier and leaves recent projects', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { root, run, free, kept } = volume();
    const audit = await run({ free: free() + 1024 * KIB });
    expect(audit.goalMet).toBe(true);
    expect(audit.reachedTier).toBe('moderate');
    expect(kept()).toEqual(['recent']);
    expect(audit.diskAfter.free >= audit.diskBefore.free + 1024 * KIB).toBe(
      true
    );
    removeRoot(root);
  });

  it('reports an unreachable goal after the aggressive tier', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { root, run, free, kept } = volume();
    const audit = await run({ free: free() + 50 * 1024 * KIB });
    expect(audit.goalMet).toBe(false);
    expect(audit.reachedTier).toBe('aggressive');
    expect(kept()).toEqual([]);
    removeRoot(root);
  });

  it('does nothing when the goal is already met', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { root, run, kept } = volume();
    const audit = await run({ until: '99%' });
    expect(audit.goalMet).toBe(true);
    expect(audit.entries).toEqual([]);
    expect(kept()).toEqual(['npm', 'pip', 'old', 'recent']);
    removeRoot(root);
  });

  it('plans against a simulated disk in a dry run', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { root, run, free, kept } = volume();
    const audit = await run({ free: free() + 1024 * KIB, dryRun: true });
    expect(audit.goalMet).toBe(true);
    expect(audit.reachedTier).toBe('moderate');
    expect(audit.entries.every((e) => e.status === 'planned')).toBe(true);
    expect(kept()).toEqual(['npm', 'pip', 'old', 'recent']);
    removeRoot(root);
  });

  it('writes an audit log on every run', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { root, run } = volume();
    const audit = await run({ until: '99%', dryRun: true });
    expect(audit.file.startsWith(join(root, 'audit'))).toBe(true);
    expect(existsSync(audit.file)).toBe(true);
    removeRoot(root);
  });
});
