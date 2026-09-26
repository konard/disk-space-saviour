/**
 * Project scanning against real fixture trees: one project per rule of
 * every ecosystem, activity window, marker requirements, sizes compared
 * with `du`, and a scan never deleting anything.
 */

import { describe, it, expect } from 'test-anywhere';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_RULES } from '../src/rules/ecosystems.js';
import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  projectFixture,
  readOnlyRuntime,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

let aged = null;

/**
 * One fixture project per rule, untouched for 40 days, scanned once.
 */
function agedScan() {
  aged ??= (async () => {
    const root = tempRoot('dss-projects-');
    const dirs = new Map(
      PROJECT_RULES.map((rule) => [rule.id, projectFixture(root, rule)])
    );
    age(root, 40 * DAY_MS);
    const report = await scan(
      scanInput(fixtureEnv(root), [root], { scanners: ['projects'] })
    );
    return { root, dirs, report };
  })();
  return aged;
}

describe('project rules find their fixture project', () => {
  for (const rule of PROJECT_RULES) {
    it(`${rule.ecosystem}: ${rule.id} (${rule.names[0]})`, async () => {
      if (readOnlyRuntime()) {
        return;
      }
      const { dirs, report } = await agedScan();
      const item = report.items.find((candidate) => candidate.rule === rule.id);
      expect(item?.path).toBe(dirs.get(rule.id));
      expect(item.ecosystem).toBe(rule.ecosystem);
      expect(item.tier).toBe(rule.kind === 'cache' ? 'safe' : 'moderate');
      expect(item.blockers).toEqual([]);
      expect(item.bytes >= 64 * 1024).toBe(true);
      expect(item.action).toEqual({ type: 'remove', paths: [item.path] });
    });
  }

  it('reports each fixture exactly once and deletes nothing', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { dirs, report, root } = await agedScan();
    expect(report.items.map((item) => item.rule).sort()).toEqual(
      PROJECT_RULES.map((rule) => rule.id).sort()
    );
    for (const dir of dirs.values()) {
      expect(existsSync(join(dir, 'payload.bin'))).toBe(true);
    }
    removeRoot(root);
  });
});

describe('project activity and markers', () => {
  it('blocks a project written inside the activity window', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-fresh-');
    const rule = PROJECT_RULES.find((r) => r.id === 'node-modules');
    projectFixture(root, rule);
    const report = await scan(
      scanInput(fixtureEnv(root), [root], {
        scanners: ['projects'],
        staleAge: '1h',
      })
    );
    const [item] = report.items;
    expect(item.tier).toBe('aggressive');
    expect(item.blockers.join()).toMatch(/inside the 1h activity window/);
    removeRoot(root);
  });

  it('keeps recently active projects out of the moderate tier', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-active-');
    const rule = PROJECT_RULES.find((r) => r.id === 'node-modules');
    projectFixture(root, rule);
    age(root, 3 * DAY_MS);
    const report = await scan(
      scanInput(fixtureEnv(root), [root], {
        scanners: ['projects'],
        inactive: '30d',
      })
    );
    expect(report.items[0].tier).toBe('aggressive');
    expect(report.items[0].blockers).toEqual([]);
    removeRoot(root);
  });

  it('ignores same-named directories without the project marker', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-unmarked-');
    for (const name of ['target', 'build', 'vendor', 'lib', 'bin', 'obj']) {
      writeBlob(join(root, 'plain', name, 'data.bin'));
    }
    writeBlob(join(root, 'venv-like', '.venv', 'data.bin'));
    age(root, 40 * DAY_MS);
    const report = await scan(
      scanInput(fixtureEnv(root), [root], { scanners: ['projects'] })
    );
    expect(report.items).toEqual([]);
    removeRoot(root);
  });

  it('respects --exclude for a project directory', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-exclude-');
    const rule = PROJECT_RULES.find((r) => r.id === 'node-modules');
    const dir = projectFixture(root, rule);
    age(root, 40 * DAY_MS);
    const report = await scan(
      scanInput(fixtureEnv(root), [root], {
        scanners: ['projects'],
        exclude: [dir],
      })
    );
    expect(report.items).toEqual([]);
    removeRoot(root);
  });
});

function duBytes(target) {
  const output = execFileSync('du', ['-sk', target]).toString();
  return Number(output.split(/\s+/)[0]) * 1024;
}

describe('sizes', () => {
  it('match du within 5%', async () => {
    if (readOnlyRuntime() || process.platform === 'win32') {
      return;
    }
    const root = tempRoot('dss-du-');
    const project = join(root, 'app');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    const modules = join(project, 'node_modules');
    for (let index = 0; index < 40; index++) {
      writeBlob(
        join(modules, `pkg-${index % 7}`, `file-${index}.js`),
        1 + index * 3001
      );
    }
    writeBlob(join(modules, 'big', 'bundle.js'), 3 * 1024 * 1024 + 17);
    age(root, 40 * DAY_MS);
    const report = await scan(
      scanInput(fixtureEnv(root), [root], { scanners: ['projects'] })
    );
    const expected = duBytes(modules);
    const measured = report.items[0].bytes;
    expect(Math.abs(measured - expected) / expected <= 0.05).toBe(true);
    removeRoot(root);
  });
});
