// Scans a synthetic, inactive Cargo project with two builds of `serde` and
// prints the items (`--clean` adds a dry-run clean).
// Run: node experiments/issue-5-cargo-superseded.mjs [--clean]
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scan } from '../src/scan.js';
import { clean } from '../src/clean.js';

const DAY = 86400000;
const root = mkdtempSync(join(tmpdir(), 'dss-issue5-'));
const project = join(root, 'crate');
const profile = join(project, 'target', 'debug');
mkdirSync(join(profile, 'deps'), { recursive: true });
writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\n');
writeFileSync(join(project, 'target', 'CACHEDIR.TAG'), '');
const setAge = (p, ms) =>
  utimesSync(p, new Date(Date.now() - ms), new Date(Date.now() - ms));
for (const [hash, ageMs] of [
  ['1111111111111111', 3 * DAY],
  ['2222222222222222', 2 * DAY],
]) {
  const fp = join(profile, '.fingerprint', `serde-${hash}`);
  mkdirSync(fp, { recursive: true });
  writeFileSync(
    join(fp, 'lib-serde.json'),
    '{"rustc":1,"target":1,"profile":2}'
  );
  const rlib = join(profile, 'deps', `libserde-${hash}.rlib`);
  writeFileSync(rlib, Buffer.alloc(5e6, 1));
  setAge(join(fp, 'lib-serde.json'), ageMs);
  setAge(fp, ageMs);
  setAge(rlib, ageMs);
}
setAge(join(project, 'Cargo.toml'), 40 * DAY);
const report = await scan({
  roots: [root],
  docker: false,
  scanners: ['projects'],
  minSize: 0,
});
for (const item of report.items) {
  console.log(
    item.tier,
    item.rule,
    item.bytes,
    item.path,
    item.blockers.join('; ')
  );
}
if (process.argv.includes('--clean')) {
  const audit = await clean(report, {
    tier: 'safe',
    audit: false,
    dryRun: true,
  });
  console.log(audit.entries.map((e) => [e.rule, e.status, e.reason]));
}
