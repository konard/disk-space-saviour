// Smoke test of the recursive Docker scan against the local daemon.
// Usage: node experiments/scan-docker.mjs [containerFilter...]
import { scanDocker } from '../src/docker/scan.js';
import { LocalEnv } from '../src/env/local.js';
import { hostExecutor, setTrace } from '../src/exec.js';

setTrace(Boolean(process.env.DSS_DEBUG));
const env = new LocalEnv();
const filters = process.argv.slice(2);
const result = await scanDocker(
  { env, executor: hostExecutor(), chain: [] },
  {
    staleAgeMs: 3600e3,
    dockerDepth: 3,
    containerFilter: filters,
    includeVolumes: true,
  },
  async (inner) => {
    const homes = await inner.homeDirs();
    return [{ id: `${inner.id}:probe`, homes, bytes: 0, blockers: [] }];
  }
);
console.log(JSON.stringify(result, null, 2));
