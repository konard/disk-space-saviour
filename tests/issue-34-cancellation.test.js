import { describe, expect } from 'test-anywhere';
import { runProcess, hostExecutor } from '../src/exec.js';
import { scan, SCANNERS } from '../src/scan.js';
import { makeItem } from '../src/items.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { itUnless, sandboxed, notLinux } from './helpers/skip.js';
import {
  fixtureEnv,
  tempRoot,
  removeRoot,
  scanInput,
} from './helpers/fixtures.js';

const slow = ['node', '-e', 'setTimeout(() => {}, 1000)'];

describe('issue 34 cancellation and scan budgets', () => {
  itUnless(sandboxed)(
    'cancels a streaming executor command as well as captured commands',
    async () => {
      const controller = new AbortController();
      const child = hostExecutor().spawn(slow, { signal: controller.signal });
      const done = once(child, 'close');
      controller.abort();
      const [code] = await done;
      expect(code === 0).toBe(false);
    }
  );
  itUnless(sandboxed)(
    'terminates a spawned child when the scan signal aborts',
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30);
      const start = Date.now();
      try {
        const result = await runProcess(slow, { signal: controller.signal });
        expect(result.aborted).toBe(true);
        expect(Date.now() - start < 900).toBe(true);
      } finally {
        clearTimeout(timer);
      }
    }
  );
  for (const budget of [false, true]) {
    itUnless(sandboxed)(
      `preserves partial findings after ${budget ? 'a time budget' : 'cancellation'}`,
      async () => {
        const root = tempRoot(),
          env = fixtureEnv(root),
          controller = new AbortController();
        let timer;
        SCANNERS.interruptFixture = async (context) => {
          context.emit(
            makeItem(env, { rule: 'fixture', path: root, bytes: 8192 })
          );
          if (!budget) {
            timer = setTimeout(() => controller.abort(), 50);
          }
          await context.env.run(['node', '-e', 'setTimeout(() => {}, 10000)']);
          return [];
        };
        try {
          const report = await scan(
            scanInput(env, [], {
              scanners: ['interruptFixture'],
              signal: controller.signal,
              scanBudget: budget ? 2000 : 15000,
            })
          );
          expect(report.items.length).toBe(1);
          expect(report.environments[0].scanStatus).toBe(
            budget ? 'budget-exceeded' : 'aborted'
          );
          expect(report.items[0].blockers.join(' ')).toMatch(/incomplete/);
          expect(report.aborted).toBe(!budget);
        } finally {
          clearTimeout(timer);
          delete SCANNERS.interruptFixture;
          removeRoot(root);
        }
      }
    );
  }
  for (const command of ['scan', 'clean', 'emergency']) {
    for (const [signal, code] of [
      ['SIGTERM', 143],
      ['SIGINT', 130],
    ]) {
      itUnless(sandboxed, notLinux)(
        `writes a partial ${command} pre-scan report and exits ${code} on ${signal}`,
        async () => {
          const root = tempRoot(),
            output = [],
            diagnostics = [];
          let signalledAt;
          const child = spawn('node', [
            '--import',
            './experiments/issue-40/slow-scanner.mjs',
            'bin/dss.js',
            command,
            ...(command === 'emergency' ? ['--free', '1G'] : []),
            '--no-docker',
            '--scanner',
            'global',
            root,
            '--min-size',
            '0',
            '--audit-dir',
            join(root, 'audit'),
            '--json',
          ]);
          const done = once(child, 'close');
          child.stdout.on('data', (data) => output.push(data));
          child.stderr.on('data', (data) => {
            diagnostics.push(data);
            if (data.toString().includes('fixture ready')) {
              signalledAt = Date.now();
              process.kill(child.pid, signal);
            }
          });
          try {
            const [exitCode] = await done;
            expect(exitCode).toBe(code);
            expect(Date.now() - signalledAt < 5000).toBe(true);
            const report = JSON.parse(Buffer.concat(output).toString());
            expect(report.aborted).toBe(true);
            expect(report.items.length).toBe(1);
            expect(report.environments[0].scanStatus).toBe('aborted');
            expect(Buffer.concat(diagnostics).toString()).toContain(
              'fixture ready'
            );
          } finally {
            child.kill('SIGKILL');
            removeRoot(root);
          }
        }
      );
    }
  }
});
