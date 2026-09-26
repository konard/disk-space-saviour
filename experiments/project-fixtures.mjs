// Builds one fixture project per project rule and prints what scan() finds.
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from '../src/scan.js';
import { LocalEnv } from '../src/env/local.js';
import { PROJECT_RULES } from '../src/rules/ecosystems.js';

const concrete = (name) => name.replaceAll('*', 'app');
const root = mkdtempSync(join(tmpdir(), 'dss-fixtures-'));
for (const rule of PROJECT_RULES) {
  const project = join(root, rule.id);
  mkdirSync(project, { recursive: true });
  for (const marker of rule.markers ?? rule.parentMarkers ?? []) {
    writeFileSync(join(project, concrete(marker)), '');
    break;
  }
  const parent = rule.parentName ? join(project, rule.parentName) : project;
  const dir = join(parent, concrete(rule.names[0]));
  mkdirSync(dir, { recursive: true });
  const self = rule.selfMarkers?.[0];
  if (self) {
    writeFileSync(join(dir, self), '');
  }
  writeFileSync(join(dir, 'blob.bin'), Buffer.alloc(64 * 1024, 1));
}
const env = new LocalEnv({ homes: [join(root, 'home')], tmpDirs: [] });
const report = await scan({
  env,
  roots: [root],
  scanners: ['projects'],
  docker: false,
  minSize: 0,
  auditDir: null,
});
const found = new Map(report.items.map((i) => [i.rule, i]));
for (const rule of PROJECT_RULES) {
  const item = found.get(rule.id);
  console.log(
    rule.id.padEnd(22),
    item
      ? `${item.tier} ${item.bytes} ${item.blockers.join('|')} ${item.path.slice(root.length)}`
      : 'MISSING'
  );
}
console.log(
  'extra:',
  report.items
    .filter((i) => !PROJECT_RULES.some((r) => r.id === i.rule))
    .map((i) => i.rule)
);
console.log('errors:', report.errors);
rmSync(root, { recursive: true, force: true });
