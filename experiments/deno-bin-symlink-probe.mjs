// Spawns bin/dss.js through an npm-style symlink with process.execPath, the
// way tests/package-metadata.test.js does, and prints what the child reports.
// Usage: deno run -A experiments/deno-bin-symlink-probe.mjs (or node ...)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'dss-bin-'));
const linkPath = join(tempRoot, 'dss');
symlinkSync(resolve('bin/dss.js'), linkPath);
try {
  const result = spawnSync(process.execPath, [linkPath, '--help'], {
    encoding: 'utf8',
  });
  console.log('status:', result.status);
  console.log('stdout:', result.stdout.slice(0, 200));
  console.log('stderr:', result.stderr.slice(0, 1500));
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}
