// Creates every global cache rule under a fake home and prints scan() items.
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from '../src/scan.js';
import { LocalEnv } from '../src/env/local.js';
import { CACHE_RULES } from '../src/rules/ecosystems.js';

const root = mkdtempSync(join(tmpdir(), 'dss-global-'));
const home = join(root, 'home');
const made = new Map();
for (const rule of CACHE_RULES) {
  const pattern = rule.paths.find((p) => p.startsWith('~/'));
  if (!pattern) {
    console.log('no home path', rule.id);
    continue;
  }
  const dir = join(home, pattern.slice(2).replaceAll('*', 'x'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${rule.id}.bin`), Buffer.alloc(32 * 1024, 1));
  made.set(rule.id, dir);
}
const env = new LocalEnv({ homes: [home], tmpDirs: [], vars: {} });
const report = await scan({
  env,
  roots: [],
  scanners: ['global'],
  docker: false,
  minSize: 0,
  auditDir: null,
  noNative: true,
});
const found = new Map(report.items.map((i) => [i.rule, i]));
for (const [id, dir] of made) {
  const item = found.get(id);
  console.log(
    id.padEnd(24),
    item
      ? `${item.tier} ${item.bytes} ${item.paths.map((p) => p.slice(home.length)).join(',')} ${item.blockers}`
      : `MISSING ${dir.slice(home.length)}`
  );
}
console.log(
  'extra',
  report.items.filter((i) => !made.has(i.rule)).map((i) => i.rule)
);
rmSync(root, { recursive: true, force: true });
