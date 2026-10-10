import { spawnSync } from 'node:child_process';
import { describe, expect } from 'test-anywhere';
import { runToExit } from './helpers/run-to-exit.js';
import { itUnless, sandboxed } from './helpers/skip.js';

// A child that exits while a process it started keeps the child's stdout
// open, which is what an inherited pipe looks like on every platform. The
// process is detached because Node on Windows kills its other children when
// it exits (libuv's job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).
const HOLD_MS = 4000;
const leavesPipeOpen = [
  '-e',
  `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${HOLD_MS})'], { stdio: 'inherit', detached: true }).unref(); console.log('child done');`,
];

describe('runToExit', () => {
  itUnless(sandboxed)(
    'settles when the child exits while another process holds its pipes',
    async () => {
      const started = Date.now();
      const held = spawnSync('node', leavesPipeOpen, { encoding: 'utf8' });
      const heldMs = Date.now() - started;
      const result = await runToExit('node', leavesPipeOpen, {
        timeout: 20000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('child done');
      expect(result.ms).toBeLessThan(HOLD_MS - 1000);
      // Proof the fixture holds the pipe: spawnSync waits for it.
      expect(held.stdout).toContain('child done');
      expect(heldMs).toBeGreaterThanOrEqual(HOLD_MS - 1000);
    }
  );

  itUnless(sandboxed)('reports the exit status and both streams', async () => {
    const result = await runToExit('node', [
      '-e',
      "console.log('out'); console.error('err'); process.exit(3)",
    ]);

    expect(result.status).toBe(3);
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
    expect(result.error).toBe(null);
  });

  itUnless(sandboxed)('kills a child that outlives its timeout', async () => {
    const result = await runToExit(
      'node',
      ['-e', 'setTimeout(() => {}, 20000)'],
      { timeout: 500 }
    );

    expect(result.status).toBe(null);
    expect(String(result.error)).toContain('timed out after 500ms');
    expect(result.ms).toBeLessThan(10000);
  });

  itUnless(sandboxed)('reports a program that does not exist', async () => {
    const result = await runToExit('dss-no-such-program', []);

    expect(result.error?.code).toBe('ENOENT');
    expect(result.status).toBe(null);
  });
});
