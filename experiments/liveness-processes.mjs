// Lists what LocalEnv.processes() reports for a child running in a temp dir.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalEnv } from '../src/env/local.js';

const dir = mkdtempSync(join(tmpdir(), 'dss-exp-proc-'));
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
  cwd: dir,
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 300));
const procs = await new LocalEnv().processes();
console.log(
  'count',
  procs?.length,
  procs?.find((p) => p.pid === child.pid)
);
console.log(procs?.slice(0, 3));
child.kill();
