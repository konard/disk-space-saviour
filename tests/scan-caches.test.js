/**
 * Global cache scanning against a fake home directory holding one cache
 * of every rule.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { CACHE_RULES } from '../src/rules/ecosystems.js';
import { clean } from '../src/clean.js';
import { OTHER_RULES } from '../src/rules/other.js';
import { scan } from '../src/scan.js';
import {
  fixtureEnv,
  age,
  DAY_MS,
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
  it('reports only old browser revisions and keeps the newest download', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-browser-revisions-');
    const home = join(root, 'home');
    const old = join(home, '.cache', 'ms-playwright', 'chromium-100');
    const newest = join(home, '.cache', 'ms-playwright', 'chromium-200');
    writeBlob(join(old, 'chrome'), 1024);
    writeBlob(join(newest, 'chrome'), 1024);
    age(root, 40 * DAY_MS);
    const report = await scan(
      scanInput(fixtureEnv(root), [], { scanners: ['global'] })
    );
    const browsers = report.items.filter(
      (item) => item.rule === 'playwright-browsers'
    );
    expect(browsers.map((item) => item.path)).toEqual([old]);
    expect(browsers[0].tier).toBe('moderate');
    expect(existsSync(join(newest, 'chrome'))).toBe(true);
    rmSync(newest, { recursive: true });
    const audit = await clean(report, {
      env: fixtureEnv(root),
      tier: 'moderate',
      audit: false,
      docker: false,
    });
    expect(
      audit.entries.find((entry) => entry.rule === 'playwright-browsers')
        ?.reason
    ).toMatch(/newest installed browser revision/);
    expect(existsSync(join(old, 'chrome'))).toBe(true);
    removeRoot(root);
  });
  it('does not select session transcripts or unique package stores', () => {
    const paths = [...CACHE_RULES, ...OTHER_RULES].flatMap(
      (rule) => rule.paths
    );
    for (const unsafe of [
      '~/.codex/sessions/*/*',
      '~/.julia/logs',
      '~/.julia/artifacts',
      '~/.m2/repository',
      '~/.conan/data',
      '~/.conan2/p',
      '~/.cache/R/renv',
    ]) {
      expect(paths.includes(unsafe)).toBe(false);
    }
  });
  it('covers every ecosystem with a home-directory cache', () => {
    const ecosystems = new Set(homeRules.map((rule) => rule.ecosystem));
    expect(ecosystems.size >= 19).toBe(true);
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
