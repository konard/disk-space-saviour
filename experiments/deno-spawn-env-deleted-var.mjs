// Does child_process drop a variable that was deleted from the env it gets?
// Node: yes (the child sees only the env passed). Deno: check with
//   CI=true node experiments/deno-spawn-env-deleted-var.mjs
//   CI=true deno run -A experiments/deno-spawn-env-deleted-var.mjs
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
delete env.CI;
const probe = 'console.log(JSON.stringify(process.env.CI ?? null))';
const viaNode = spawnSync('node', ['-e', probe], { env, encoding: 'utf8' });
const viaSh = spawnSync('sh', ['-c', 'echo "${CI-<unset>}"'], {
  env,
  encoding: 'utf8',
});
const viaEmpty = spawnSync('sh', ['-c', 'echo "${CI-<unset>}"'], {
  env: { ...env, CI: '' },
  encoding: 'utf8',
});
console.log('parent CI =', JSON.stringify(process.env.CI ?? null));
console.log('node child CI =', viaNode.stdout.trim());
console.log('sh child CI =', viaSh.stdout.trim());
console.log('sh child CI with CI="" =', JSON.stringify(viaEmpty.stdout.trim()));
