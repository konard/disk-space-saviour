/** Compare explicit Unix signal-style exit statuses across runtime adapters. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
for (const code of [0, 130, 143]) {
  const child = spawn('node', ['-e', `process.exit(${code})`]);
  console.log({ expected: code, close: await once(child, 'close') });
}
for (const delivery of ['child.kill', 'process.kill']) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const child = spawn('node', [
      '-e',
      `process.on('${signal}', () => {console.error('handled'); process.exit(143)}); console.error('ready'); setTimeout(() => {}, 3000)`,
    ]);
    const done = once(child, 'close');
    child.stderr.on('data', (data) => {
      console.log({ delivery, signal, stderr: data.toString() });
      if (data.toString().includes('ready')) {
        if (delivery === 'child.kill') {
          child.kill(signal);
        } else {
          process.kill(child.pid, signal);
        }
      }
    });
    console.log({ delivery, signal, close: await done });
  }
}
