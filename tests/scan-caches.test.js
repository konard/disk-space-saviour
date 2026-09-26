/**
 * Global cache scanning against a fake home directory holding one cache
 * of every rule.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CACHE_RULES } from '../src/rules/ecosystems.js';
import { scan } from '../src/scan.js';
import {
  fixtureEnv,
  readOnlyRuntime,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

const homeRules = CACHE_RULES.filter((rule) =>
  rule.paths.some((pattern) => pattern.startsWith('~/'))
);

let cached = null;

function cacheScan() {
  cached ??= (async () => {
    const root = tempRoot('dss-caches-');
    const home = join(root, 'home');
    const dirs = new Map();
    for (const rule of homeRules) {
      const pattern = rule.paths.find((p) => p.startsWith('~/'));
      const dir = join(home, pattern.slice(2).replaceAll('*', 'x'));
      writeBlob(join(dir, `${rule.id}.bin`), 32 * 1024);
      dirs.set(rule.id, dir);
    }
    const report = await scan(
      scanInput(fixtureEnv(root), [], { scanners: ['global'] })
    );
    return { root, dirs, report };
  })();
  return cached;
}

describe('global cache rules find their fixture cache', () => {
  it('covers every ecosystem with a home-directory cache', () => {
    const ecosystems = new Set(homeRules.map((rule) => rule.ecosystem));
    expect(ecosystems.size >= 20).toBe(true);
  });

  for (const rule of homeRules) {
    it(`${rule.ecosystem}: ${rule.id}`, async () => {
      if (readOnlyRuntime()) {
        return;
      }
      const { dirs, report } = await cacheScan();
      const item = report.items.find((candidate) => candidate.rule === rule.id);
      expect(item?.paths).toEqual([dirs.get(rule.id)]);
      expect(item.tier).toBe(rule.tier ?? 'safe');
      expect(item.blockers).toEqual([]);
      expect(item.bytes >= 32 * 1024).toBe(true);
    });
  }

  it('deletes nothing while scanning', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { dirs, root } = await cacheScan();
    for (const [id, dir] of dirs) {
      expect(existsSync(join(dir, `${id}.bin`))).toBe(true);
    }
    removeRoot(root);
  });
});
