/**
 * Command execution primitives.
 *
 * An executor runs argv arrays somewhere: on the host, or inside a container
 * through `docker exec`. Executors chain, so a container inside a
 * Docker-in-Docker daemon is reached by wrapping the outer container's
 * executor. Every higher layer (filesystem adapters, Docker client, git
 * checks) talks to an executor and never cares how deep it is.
 */

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;

/**
 * Debug tracing, off by default. Enable with DSS_DEBUG=1 or `--verbose`.
 */
let traceEnabled = false;
try {
  traceEnabled = Boolean(globalThis.process?.env?.DSS_DEBUG);
} catch {
  traceEnabled = false;
}

export function setTrace(enabled) {
  traceEnabled = Boolean(enabled);
}

export function trace(...parts) {
  if (traceEnabled) {
    console.error('[dss]', ...parts);
  }
}

/**
 * Spawns argv and captures its output.
 * @param {string[]} argv
 * @param {{input?: string, timeoutMs?: number, cwd?: string, env?: object}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string, error?: Error}>}
 */
export function runProcess(argv, options = {}) {
  const { input, timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env } = options;
  trace('exec', JSON.stringify(argv));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: String(error), error });
      return;
    }
    const stdout = [];
    const stderr = [];
    let captured = 0;
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        code: 124,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `timed out after ${timeoutMs}ms`,
        error: new Error(`timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      captured += chunk.length;
      if (captured <= MAX_CAPTURE_BYTES) {
        target.push(chunk);
      }
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => {
      finish({ code: 127, stdout: '', stderr: String(error), error });
    });
    child.on('close', (code) => {
      finish({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.on('error', () => {});
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Executor that runs commands on the machine running dss.
 */
export function hostExecutor() {
  return {
    label: 'host',
    depth: 0,
    run: (argv, options) => runProcess(argv, options),
    spawn: (argv) =>
      spawn(argv[0], argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
  };
}

/**
 * Executor that runs commands inside a container via `docker exec`.
 * @param {object} parent executor that can reach the container's daemon
 * @param {string} containerId
 * @param {{docker?: string, label?: string, user?: string}} [options]
 */
export function containerExecutor(parent, containerId, options = {}) {
  const docker = options.docker ?? 'docker';
  const wrap = (argv, interactive) => [
    docker,
    'exec',
    ...(interactive ? ['-i'] : []),
    ...(options.user ? ['--user', options.user] : []),
    containerId,
    ...argv,
  ];
  return {
    label: options.label ?? `${parent.label}/${containerId.slice(0, 12)}`,
    depth: (parent.depth ?? 0) + 1,
    containerId,
    parent,
    run: (argv, runOptions = {}) =>
      parent.run(wrap(argv, runOptions.input !== undefined), runOptions),
    spawn: (argv) => parent.spawn(wrap(argv, false)),
  };
}

/**
 * Quotes a value for inclusion in a POSIX shell script.
 * @param {string} value
 */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
