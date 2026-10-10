// Which program answers when a test spawns `node` under each runtime?
// Run: node experiments/deno-spawn-node-identity.mjs
//      deno run -A experiments/deno-spawn-node-identity.mjs
import { spawnSync } from 'node:child_process';

const probe =
  "console.log(JSON.stringify({deno: typeof Deno !== 'undefined', node: process.versions.node, execPath: process.execPath}))";
const result = spawnSync('node', ['-e', probe], { encoding: 'utf8' });
console.log(
  JSON.stringify({ parent: typeof Deno !== 'undefined' ? 'deno' : 'node' })
);
console.log(result.stdout.trim() || result.stderr.trim() || result.error);
