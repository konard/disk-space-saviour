// Compares ShellEnv (POSIX tools) with LocalEnv (node:fs) on the same tree.
import { hostExecutor, containerExecutor } from '../src/exec.js';
import { ShellEnv } from '../src/env/shell.js';
import { LocalEnv } from '../src/env/local.js';

const target = process.argv[2] ?? process.cwd();
const container = process.argv[3];
const executor = container
  ? containerExecutor(hostExecutor(), container)
  : hostExecutor();
const shell = new ShellEnv(executor);
console.log('homes', await shell.homeDirs(), shell.currentHome);
console.log('list', (await shell.list(target)).slice(0, 3));
console.log('usage shell', await shell.usage(target));
if (!container) {
  console.log('usage local', await new LocalEnv().usage(target));
}
const found = await shell.findDirs([target], {
  globs: ['node_modules', 'src'],
  maxDepth: 3,
  skipNames: ['.git'],
});
console.log(
  'findDirs',
  found.map((f) => [f.path, f.siblings.length])
);
console.log('procs', (await shell.processes()).slice(0, 3));
console.log('open', (await shell.openPaths())?.size);
console.log(
  'which sh',
  await shell.which('sh'),
  'which nope',
  await shell.which('nope-x')
);
console.log('df', await shell.diskUsage(target));
console.log(
  'exists',
  await shell.exists(target),
  await shell.exists('/nope/x')
);
console.log('stat', await shell.stat(target));
console.log(
  'heads',
  await shell.readHeads([`${target}/package.json`, '/etc/hostname'], 40)
);
