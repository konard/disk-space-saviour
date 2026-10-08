/** Bounded Docker reproduction of non-dumpable processes and image caches. */
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShellEnv } from '../src/env/shell.js';
import { containerExecutor, hostExecutor, runProcess } from '../src/exec.js';
import { LivenessProbe } from '../src/liveness.js';
import { clean } from '../src/clean.js';
import { scan } from '../src/scan.js';

const BASE =
  'busybox@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e';
const MIB = 1024 * 1024;
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dss-issue14-'));
const tag = `dss-issue14:${process.pid}`;
let id;
async function command(argv) {
  const result = await runProcess(argv);
  assert.equal(result.code, 0, `${argv[0]} ${argv[1]}: ${result.stderr}`);
  return result.stdout.trim();
}
try {
  await fsp.writeFile(
    path.join(dir, 'sleeper.c'),
    '#include <sys/prctl.h>\n#include <unistd.h>\nint main(void) { prctl(PR_SET_DUMPABLE, 0); sleep(120); return 0; }\n'
  );
  await command([
    'gcc',
    '-static',
    '-O2',
    path.join(dir, 'sleeper.c'),
    '-o',
    path.join(dir, 'sleeper'),
  ]);
  await fsp.writeFile(
    path.join(dir, 'Dockerfile'),
    `FROM ${BASE}\nRUN mkdir -p /home/box/.npm/_cacache && head -c ${4 * MIB} /dev/zero > /home/box/.npm/_cacache/image\nCOPY sleeper /sleeper\nCMD ["/sleeper"]\n`
  );
  await command(['docker', 'build', '-q', '-t', tag, dir]);
  id = `dss-issue14-${process.pid}`;
  await command([
    'docker',
    'run',
    '-d',
    '--name',
    id,
    tag,
    'sh',
    '-c',
    'ulimit -v 131072; exec /sleeper',
  ]);
  const denied = await runProcess([
    'docker',
    'exec',
    '--user',
    '0',
    id,
    'readlink',
    '/proc/1/cwd',
  ]);
  assert.notEqual(
    denied.code,
    0,
    'normal root exec must reproduce missing ptrace capability'
  );
  const env = new ShellEnv(containerExecutor(hostExecutor(), id), {
    homes: ['/home/box'],
    tmpDirs: [],
  });
  const live = new LivenessProbe(env, { staleAgeMs: 0 });
  await live.refresh();
  assert.equal(live.probeError, false, env.probeDiagnostic);
  assert.ok(env.probeExecutor, 'the privileged read-only fallback succeeded');
  const options = {
    env,
    docker: false,
    roots: [],
    scanners: ['global'],
    minSize: 0,
    olderThan: '0s',
    noNative: true,
    auditDir: null,
  };
  const before = await scan(options);
  const imageOnly = before.items.find((item) => item.rule === 'npm-cache');
  assert.equal(imageOnly.bytes, 0);
  assert.ok(imageOnly.imageBytes >= 4 * MIB);
  assert.ok(
    imageOnly.blockers.some((reason) => reason.includes('image layer'))
  );
  await command([
    'docker',
    'exec',
    id,
    'sh',
    '-c',
    `head -c ${MIB} /dev/zero > /home/box/.npm/_cacache/writable`,
  ]);
  const report = await scan(options);
  const cache = report.items.find((item) => item.rule === 'npm-cache');
  assert.equal(cache.bytes, MIB);
  assert.ok(cache.imageBytes >= 4 * MIB);
  const audit = await clean(report, {
    ...options,
    dryRun: false,
    yes: true,
    only: ['npm-cache'],
  });
  assert.equal(audit.freedBytes, MIB);
  console.log(
    JSON.stringify({
      rootProbeExit: denied.code,
      privilegedProbe: 'passed',
      imageBytes: imageOnly.imageBytes,
      reclaimableBytes: cache.bytes,
      freedBytes: audit.freedBytes,
    })
  );
} finally {
  if (id) {
    await runProcess(['docker', 'rm', '-f', id]);
  }
  await runProcess(['docker', 'image', 'rm', tag]);
  await fsp.rm(dir, { recursive: true, force: true });
}
