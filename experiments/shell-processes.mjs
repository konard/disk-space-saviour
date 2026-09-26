// Lists processes of a running container through ShellEnv (docker exec).
import { resolveEnvironment } from '../src/env/resolve.js';

const id = process.argv[2] ?? 'dss-exp-running';
const { env } = resolveEnvironment({
  id: `host/${id}`,
  label: id,
  kind: 'container',
  depth: 1,
  chain: [{ containerId: id, name: id }],
});
console.log(await env.processes());
