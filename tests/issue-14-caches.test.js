import { describe, it, expect } from 'test-anywhere';
import { existsSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { scan } from '../src/scan.js';
import { clean } from '../src/clean.js';
import { scanAudit, runCli } from '../src/cli.js';
import { investigationBlocker } from '../src/docker/containers.js';
import {
  fixtureEnv,
  tempRoot,
  removeRoot,
  writeBlob,
  age,
  DAY_MS,
  readOnlyRuntime,
  scanInput,
} from './helpers/fixtures.js';

async function fixture(callback) {
  if (readOnlyRuntime()) {
    return;
  }
  const root = tempRoot('dss-issue14-');
  try {
    await callback(root, join(root, 'home'), fixtureEnv(root));
  } finally {
    removeRoot(root);
  }
}

describe('issue 14 missing caches and logs', () => {
  it('deletes opam download files without ever invoking opam', async () =>
    fixture(async (root, home, env) => {
      const target = join(home, '.opam/download-cache');
      writeBlob(join(target, 'blob'));
      env.currentHome = home;
      env.which = async (command) => command === 'opam';
      const report = await scan(
        scanInput(env, [], { scanners: ['global'], noNative: false })
      );
      expect(
        report.items.find((item) => item.rule === 'opam-download-cache').action
          .type
      ).toBe('remove');
      await clean(report, { env, audit: false, docker: false });
      expect(existsSync(target)).toBe(false);
    }));

  it('finds aged isolation logs and sanitized upload staging paths', async () =>
    fixture(async (root, home, env) => {
      const tmp = join(root, 'tmp');
      env.tmpDirs = async () => [tmp];
      const log = join(tmp, 'start-command/logs/isolation/docker/task.log');
      const staging = join(
        tmp,
        'log-tmp-hive-mind-log-upload-123-sanitized-456'
      );
      writeBlob(log);
      writeBlob(join(staging, 'payload.log'));
      writeBlob(join(tmp, 'log-home-box-hive-telegram-bot-456/payload.log'));
      writeBlob(
        join(
          tmp,
          'log-tmp-hive-mind-log-upload-active-sanitized-new/payload.log'
        )
      );
      age(log, 3 * DAY_MS);
      age(staging, 3 * DAY_MS);
      const report = await scan(scanInput(env, [], { scanners: ['global'] }));
      expect(
        report.items.some(
          (item) =>
            item.rule === 'start-command-isolation-logs' && item.path === log
        )
      ).toBe(true);
      expect(
        report.items.some(
          (item) =>
            item.rule === 'sanitized-upload-staging' && item.path === staging
        )
      ).toBe(true);
      expect(
        report.items.some((item) => item.path.includes('active-sanitized'))
      ).toBe(false);
    }));

  it('keeps newest and current Claude binaries and Copilot packages', async () =>
    fixture(async (root, home, env) => {
      const versions = join(home, '.local/share/claude/versions');
      const packages = join(home, '.cache/copilot/pkg/linux-x64');
      for (const version of ['2.1.288', '2.1.289', '2.1.292']) {
        writeBlob(join(versions, version));
      }
      for (const version of ['1.0.91', '1.0.92']) {
        writeBlob(join(packages, version, 'copilot'));
      }
      mkdirSync(join(home, '.local/bin'), { recursive: true });
      symlinkSync(join(versions, '2.1.289'), join(home, '.local/bin/claude'));
      age(root, 3 * DAY_MS);
      const report = await scan(scanInput(env, [], { scanners: ['versions'] }));
      expect(
        report.items
          .filter((item) => item.rule === 'claude-code-versions')
          .map((item) => item.path)
      ).toEqual([join(versions, '2.1.288')]);
      expect(
        report.items
          .filter((item) => item.rule === 'copilot-cli-versions')
          .map((item) => item.path)
      ).toEqual([join(packages, '1.0.91')]);
      rmSync(join(versions, '2.1.292'));
      rmSync(join(home, '.local/bin/claude'));
      symlinkSync(join(versions, '2.1.288'), join(home, '.local/bin/claude'));
      const audit = await clean(report, {
        env,
        tier: 'moderate',
        docker: false,
        audit: false,
      });
      expect(
        audit.entries.find((entry) => entry.rule === 'claude-code-versions')
          .status
      ).toBe('skipped');
      expect(existsSync(join(versions, '2.1.288'))).toBe(true);
    }));
});

describe('issue 14 reporting and consent', () => {
  it('embeds the scan items and blockers in the audit report', () => {
    if (readOnlyRuntime()) {
      return;
    }
    const item = {
      id: 'x',
      env: 'host',
      rule: 'npm-cache',
      blockers: ['busy'],
    };
    const audit = scanAudit({ environments: [{ id: 'host' }], items: [item] });
    expect(audit.report.items).toEqual([item]);
  });

  it('returns a failure exit code for an incomplete JSON scan', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot();
    let output = '';
    let errors = '';
    try {
      const code = await runCli(
        ['docker', 'scan', '--json', '--audit-dir', root],
        {
          io: {
            stdout: (text) => {
              output += text;
            },
            stderr: (text) => {
              errors += text;
            },
          },
          api: {
            scan: async () => ({
              items: [],
              environments: [],
              errors: [{ message: 'snapshot missing' }],
            }),
          },
        }
      );
      expect(code).toBe(1);
      expect(JSON.parse(output).errors[0].message).toBe('snapshot missing');
      expect(errors).toBe('');
    } finally {
      removeRoot(root);
    }
  });

  it('lifts investigation holds only past the explicit age and a known end time', () => {
    const now = () => Date.parse('2026-10-08T12:00:00Z');
    const options = { now, investigationMaxAgeMs: 48 * 3600e3 };
    expect(
      investigationBlocker(
        { ExitCode: 1, FinishedAt: '2026-10-05T12:00:00Z' },
        'abc',
        'box',
        options
      )
    ).toBe(null);
    expect(
      investigationBlocker(
        { ExitCode: 1, FinishedAt: '2026-10-08T11:00:00Z' },
        'abc',
        'box',
        options
      )
    ).toMatch(/investigation/);
    expect(
      investigationBlocker({ ExitCode: 1 }, 'abc', 'box', options)
    ).toMatch(/investigation/);
  });
});
