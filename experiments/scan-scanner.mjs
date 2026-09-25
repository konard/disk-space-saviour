// Usage: node experiments/scan-scanner.mjs <projects|global|versions|agents|system> [--container ID] <root...>
// Runs one scanner on the host (or inside a running container via docker exec)
// and prints its items with tiers and blockers.
import { LocalEnv } from '../src/env/local.js';
import { ShellEnv } from '../src/env/shell.js';
import { containerExecutor, hostExecutor } from '../src/exec.js';
import { GitInspector } from '../src/git.js';
import { LivenessProbe } from '../src/liveness.js';
import { formatBytes } from '../src/units.js';

const [name, ...rest] = process.argv.slice(2);
let env = new LocalEnv();
const containerIndex = rest.indexOf('--container');
if (containerIndex !== -1) {
  const [, id] = rest.splice(containerIndex, 2);
  env = new ShellEnv(containerExecutor(hostExecutor(), id));
}
const module = await import(`../src/scanners/${name}.js`);
const scan = Object.entries(module).find(([key]) => key.startsWith('scan'))[1];
const liveness = new LivenessProbe(env, { staleAgeMs: 3600e3 });
await liveness.refresh();
const homes = await env.homeDirs();
const context = {
  env,
  git: new GitInspector(env),
  liveness,
  now: Date.now(),
  options: {
    roots: rest.length > 0 ? rest : homes,
    homes,
    tmpDirs: await env.tmpDirs(),
    maxDepth: 6,
    staleAgeMs: 3600e3,
    inactiveMs: 30 * 86400e3,
  },
};
const started = Date.now();
const items = await scan(context);
for (const item of items) {
  const blocked = item.blockers.length
    ? ` BLOCKED: ${item.blockers.join('; ')}`
    : '';
  const action =
    item.action.type === 'command' ? ` [${item.action.argv.join(' ')}]` : '';
  console.log(
    `${item.tier.padEnd(10)} ${formatBytes(item.bytes).padStart(10)} ${item.rule.padEnd(22)} ${item.path}${action}${blocked}`
  );
}
console.log(`${items.length} items in ${Date.now() - started} ms`);
