// Preloaded into fixture processes under DSS_DEBUG=1 (`node -r`) to report
// when the process started and how long it lived, so a slow fixture shows
// whether the time went to starting it, running it or noticing its exit.
const started = Date.now() - process.uptime() * 1000;
process.on('exit', () => {
  process.stderr.write(
    `[lifetime] started=${Math.round(started)} lived=${Math.round(process.uptime() * 1000)}ms\n`
  );
});
