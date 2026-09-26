// End-to-end clean() demo on a throwaway fixture and a stopped container.
// Usage: node experiments/clean-demo.mjs [containerName]
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'node:fs';

import { clean } from '../src/clean.js';
import { scan } from '../src/scan.js';

const root = '/tmp/dss-clean-fix';
rmSync(root, { recursive: true, force: true });
mkdirSync(`${root}/proj/node_modules/x`, { recursive: true });
writeFileSync(`${root}/proj/package.json`, '{}');
writeFileSync(`${root}/proj/node_modules/x/big`, Buffer.alloc(2e6, 1));
const old = new Date(Date.now() - 60 * 86400e3);
for (const p of [
  'proj/node_modules/x/big',
  'proj/node_modules/x',
  'proj/node_modules',
  'proj/package.json',
  'proj',
]) {
  utimesSync(`${root}/${p}`, old, old);
}
const container = process.argv[2];
const report = await scan({
  roots: [root],
  scanners: ['projects'],
  docker: container ? true : false,
  containers: container ? [container] : [],
  minSize: 0,
  auditDir: '/tmp/dss-clean-audit',
});
const show = (audit) =>
  audit.entries
    .map(
      (e) =>
        `${e.status.padEnd(8)} ${e.rule} ${e.path ?? ''} ${e.freedBytes} ${e.reason ?? ''} ${e.backup ?? ''}`
    )
    .join('\n');
const common = {
  tier: 'moderate',
  auditDir: '/tmp/dss-clean-audit',
  backupDir: '/tmp/dss-clean-backup',
};
const dry = await clean(report, { ...common, dryRun: true });
console.log(`--- dry run\n${show(dry)}`, '\naudit', dry.file);
console.log('exists after dry run', existsSync(`${root}/proj/node_modules`));
const noConsent = await clean(report, { ...common });
console.log(`--- without consent\n${show(noConsent)}`);
const real = await clean(report, {
  ...common,
  removeStoppedContainers: true,
  removeUnusedImages: false,
});
console.log(`--- with consent\n${show(real)}`);
console.log('exists after clean', existsSync(`${root}/proj/node_modules`));
console.log(JSON.stringify(real.environments, null, 1));
if (container) {
  console.log(
    execFileSync('docker', [
      'ps',
      '-a',
      '--format',
      '{{.Names}} {{.State}}',
    ]).toString()
  );
}
