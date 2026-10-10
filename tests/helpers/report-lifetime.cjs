// Preloaded into fixture processes under DSS_DEBUG=1 (`node -r`, and
// NODE_OPTIONS for their Node descendants) to report when each process
// started, what it spawned and how long it lived, so a slow fixture shows
// whether the time went to starting it, running it or noticing its exit.
// Lines go to DSS_LIFETIME_LOG when set, because a parent may swallow the
// output of its children.
const childProcess = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

const started = Date.now() - process.uptime() * 1000;
const name = `${process.pid} ${process.argv.slice(1, 3).join(' ')}`;
const log = (text) => {
  const line = `[lifetime ${name}] +${Math.round(process.uptime() * 1000)}ms ${text}\n`;
  if (process.env.DSS_LIFETIME_LOG) {
    appendFileSync(process.env.DSS_LIFETIME_LOG, line);
  } else {
    process.stderr.write(line);
  }
};

const { spawn } = childProcess;
childProcess.spawn = function (...args) {
  const child = spawn.apply(this, args);
  log(`spawned ${child.pid} ${args[0]} ${JSON.stringify(args[1])}`);
  child.on('exit', (code, signal) =>
    log(`child ${child.pid} exited ${code ?? signal}`)
  );
  return child;
};
syncBuiltinESMExports();

setTimeout(
  () => log(`still running: ${process.getActiveResourcesInfo().join(', ')}`),
  10000
).unref();
process.on('exit', (code) => {
  log(
    `exit ${code} started=${Math.round(started)} lived=${Math.round(process.uptime() * 1000)}ms`
  );
});
