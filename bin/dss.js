#!/usr/bin/env node

import { runCli } from '../src/cli.js';

const controller = new AbortController();
let received = null,
  fallback;
const abort = (signal) => {
  const code = signal === 'SIGTERM' ? 143 : 130;
  if (received) {
    process.exit(code);
  }
  received = code;
  controller.abort(new Error(`interrupted by ${signal}`));
  fallback = setTimeout(() => process.exit(code), 5000);
  fallback.unref();
};
const interrupt = () => abort('SIGINT'),
  terminate = () => abort('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    signal: controller.signal,
  });
  if (received) {
    process.exitCode = received;
  }
} finally {
  clearTimeout(fallback);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
}
