// Usage: node experiments/scan-projects.mjs <root...>
// Lists project directories the scanner would report, with tiers and blockers.
import { LocalEnv } from '../src/env/local.js';
import { GitInspector } from '../src/git.js';
import { LivenessProbe } from '../src/liveness.js';
import { scanProjects } from '../src/scanners/projects.js';
import { formatBytes } from '../src/units.js';

const env = new LocalEnv();
const liveness = new LivenessProbe(env, { staleAgeMs: 3600e3 });
await liveness.refresh();
const context = {
  env,
  git: new GitInspector(env),
  liveness,
  now: Date.now(),
  options: {
    roots: process.argv.slice(2),
    maxDepth: 6,
    staleAgeMs: 3600e3,
    inactiveMs: 30 * 86400e3,
  },
};
const started = Date.now();
const items = await scanProjects(context);
for (const item of items) {
  console.log(
    `${item.tier.padEnd(10)} ${formatBytes(item.bytes).padStart(10)} ${item.rule.padEnd(18)} ${item.path}${item.blockers.length ? ` BLOCKED: ${item.blockers.join('; ')}` : ''}`
  );
}
console.log(`${items.length} items in ${Date.now() - started} ms`);
