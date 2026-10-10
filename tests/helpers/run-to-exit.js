/**
 * Runs a command and settles when the command exits, not when its pipes close.
 *
 * spawnSync and the 'close' event wait until every process holding the
 * child's stdout or stderr has closed it, and on Windows Deno lets a process
 * that another thread starts at the same moment inherit those pipes.
 * `deno test --parallel` runs test files on threads of one process, so a
 * child that finished in 1.4s kept a spawnSync in
 * tests/changeset-config.test.js waiting past its 20s timeout
 * (experiments/windows-pipe-inheritance.mjs). The 'exit' event fires when the
 * child itself exits; output that is still in flight gets a short grace.
 * https://github.com/denoland/deno/issues/37011
 */
import { spawn } from 'node:child_process';

const OUTPUT_GRACE_MS = 1000;

/**
 * @param {string} command program to run
 * @param {string[]} args its arguments
 * @param {object} options spawn options plus `timeout` in milliseconds
 * @returns {Promise<{status: number|null, signal: string|null, error: Error|null, stdout: string, stderr: string, ms: number, exitMs: number|null}>}
 */
export function runToExit(command, args, { timeout, ...options } = {}) {
  const started = Date.now();
  return new Promise((settle) => {
    const result = {
      status: null,
      signal: null,
      error: null,
      stdout: '',
      stderr: '',
      ms: 0,
      exitMs: null,
    };
    let timer;
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        result.ms = Date.now() - started;
        settle(result);
      }
    };
    const child = spawn(command, args, { ...options, stdio: 'pipe' });
    child.stdin.end();
    child.stdout.setEncoding('utf8').on('data', (text) => {
      result.stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text) => {
      result.stderr += text;
    });
    if (timeout) {
      timer = setTimeout(() => {
        result.error = new Error(`${command} timed out after ${timeout}ms`);
        child.kill();
      }, timeout);
    }
    child.on('error', (error) => {
      result.error = error;
      finish();
    });
    child.on('close', finish);
    child.on('exit', (status, signal) => {
      result.status = status;
      result.signal = signal;
      result.exitMs = Date.now() - started;
      clearTimeout(timer);
      timer = setTimeout(finish, OUTPUT_GRACE_MS);
    });
  });
}
