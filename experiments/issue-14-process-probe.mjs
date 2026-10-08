/** Measure three finite, read-only local process probes on a busy host. */
import { performance } from 'node:perf_hooks';
import { LocalEnv } from '../src/env/local.js';

const env = new LocalEnv();
for (let attempt = 0; attempt < 3; attempt++) {
  const started = performance.now();
  const processes = await env.processes();
  console.log(
    JSON.stringify({
      attempt,
      processes: processes.length,
      elapsedMs: Math.round(performance.now() - started),
    })
  );
}
