// A child that exits while a grandchild keeps its stdout open: spawnSync and
// the 'close' event wait for the grandchild, the 'exit' event does not.
// Run: node experiments/exit-before-pipe-close.mjs
//      deno run -A experiments/exit-before-pipe-close.mjs
import { spawn, spawnSync } from 'node:child_process';

const parent = [
  '-e',
  "require('node:child_process').spawn('node', ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'inherit', detached: true }).unref(); console.log('parent done');",
];

let started = Date.now();
spawnSync('node', parent, { encoding: 'utf8' });
console.log(`spawnSync returned after ${Date.now() - started}ms`);

started = Date.now();
const child = spawn('node', parent);
child.stdout.resume();
child.on('exit', () => console.log(`'exit' after ${Date.now() - started}ms`));
child.on('close', () => console.log(`'close' after ${Date.now() - started}ms`));
