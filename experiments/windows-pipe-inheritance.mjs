// Does a spawnSync wait for processes that another thread starts meanwhile?
//
// On Windows a child inherits every inheritable handle of its parent process,
// not only its own stdio. A runtime that makes a child's pipe ends
// inheritable and calls CreateProcessW(bInheritHandles=TRUE) without a lock
// or PROC_THREAD_ATTRIBUTE_HANDLE_LIST lets a process started on another
// thread at that moment keep the pipe open, so spawnSync sees EOF only when
// that process exits. `deno test --parallel` runs test files on threads of
// one process, which is how tests/changeset-config.test.js waited 20s for a
// child that had finished in 1.4s.
//
// A worker thread keeps starting 3-second sleepers while the main thread
// times quick spawnSync calls. Any call near 3s waited for a sleeper.
//
// Run: deno run -A experiments/windows-pipe-inheritance.mjs
//      node experiments/windows-pipe-inheritance.mjs
/* global URL, Worker */
import { spawn, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';
const sleeper = isWindows
  ? ['ping', ['-n', '4', '127.0.0.1']]
  : ['sleep', ['3']];
const quick = isWindows ? ['cmd', ['/c', 'exit 0']] : ['true', []];
const CALLS = Number(process.env.CALLS || 150);
const LIVE_SLEEPERS = Number(process.env.LIVE_SLEEPERS || 16);
const SLOW_MS = 1500;
const isWorker = process.argv.includes('--sleepers');

function startSleepers(signal) {
  let live = 0;
  const top = () => {
    while (!signal.stopped && live < LIVE_SLEEPERS) {
      live += 1;
      const child = spawn(sleeper[0], sleeper[1], { stdio: 'ignore' });
      child.on('exit', () => {
        live -= 1;
        setTimeout(top, 0);
      });
      child.on('error', () => {
        live -= 1;
      });
    }
  };
  top();
}

async function startWorker() {
  const self = new URL(import.meta.url);
  if (typeof Deno !== 'undefined') {
    const worker = new Worker(new URL('#sleepers', self), { type: 'module' });
    return () => worker.terminate();
  }
  const threads = await import('node:worker_threads');
  const worker = new threads.Worker(self, { argv: ['--sleepers'] });
  return () => worker.terminate();
}

if (isWorker || new URL(import.meta.url).hash === '#sleepers') {
  startSleepers({ stopped: false });
} else {
  const stop = await startWorker();
  // Let the worker reach its steady state.
  await new Promise((done) => setTimeout(done, 1000));
  const durations = [];
  for (let i = 0; i < CALLS; i += 1) {
    const started = Date.now();
    spawnSync(quick[0], quick[1], { encoding: 'utf8' });
    durations.push(Date.now() - started);
  }
  await stop();
  const slow = durations.filter((ms) => ms >= SLOW_MS);
  const sorted = [...durations].sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      runtime:
        typeof Deno !== 'undefined'
          ? `deno ${Deno.version.deno}`
          : `node ${process.version}`,
      platform: process.platform,
      calls: CALLS,
      median: sorted[Math.floor(sorted.length / 2)],
      max: sorted.at(-1),
      slow: slow.length,
    })
  );
  process.exit(0);
}
