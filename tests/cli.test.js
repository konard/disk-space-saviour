/**
 * `dss` command line: argument parsing, consent (dry run unless --yes or an
 * interactive yes), exit codes and audit logs.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { USAGE, parseCli, runCli, toOptions } from '../src/cli.js';
import { clean } from '../src/clean.js';
import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  readOnlyRuntime,
  removeRoot,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

/**
 * Terminal double: records output and answers questions from `answers`.
 */
function fakeIo({ interactive = false, answers = [] } = {}) {
  const io = {
    out: [],
    err: [],
    questions: [],
    interactive,
    stdout: (text) => io.out.push(text),
    stderr: (text) => io.err.push(text),
    ask: (question) => {
      io.questions.push(question);
      return Promise.resolve(answers.shift() ?? '');
    },
  };
  return io;
}

const REPORT = {
  createdAt: '2026-01-01T00:00:00.000Z',
  durationMs: 1,
  totals: {},
  environments: [{ id: 'host' }],
  errors: [],
  items: [],
};

/**
 * Library double that records every call and returns audits built from
 * `status` and `goalMet`.
 */
function fakeApi({ status = 'planned', goalMet = true } = {}) {
  const calls = [];
  const audit = (options) => ({
    command: 'clean',
    dryRun: Boolean(options.dryRun),
    goalMet,
    entries: [{ id: 'plan-item', status: options.dryRun ? 'planned' : status }],
    environments: [],
  });
  return {
    calls,
    scan: (options) => {
      calls.push(['scan', options]);
      return Promise.resolve(REPORT);
    },
    clean: (report, options) => {
      calls.push(['clean', options]);
      return Promise.resolve(audit(options));
    },
    emergency: (options) => {
      calls.push(['emergency', options]);
      return Promise.resolve(audit(options));
    },
  };
}

async function run(argv, { io = fakeIo(), api = fakeApi() } = {}) {
  const code = await runCli([...argv, '--json'], { io, api });
  const runs = api.calls.filter(([name]) => name !== 'scan');
  return { code, io, api, runs, last: runs.at(-1)?.[1] };
}

describe('argument parsing', () => {
  it('turns `docker scan` into one command', () => {
    expect(parseCli(['docker', 'scan', '--recursive']).command).toBe(
      'docker-scan'
    );
    expect(parseCli(['docker']).command).toBe('docker-scan');
    expect(parseCli(['clean', '/a', '/b']).paths).toEqual(['/a', '/b']);
    expect(parseCli([]).command).toBe('help');
  });

  it('maps flags to library options', () => {
    const { values, paths } = parseCli([
      'clean',
      '/w',
      '--tier',
      'moderate',
      '--older-than',
      '2h',
      '--no-docker',
      '--only',
      'rust',
      '--only',
      'node',
      '--remove-stopped-containers',
    ]);
    const options = toOptions(values, paths);
    expect(options.roots).toEqual(['/w']);
    expect(options.tier).toBe('moderate');
    expect(options.staleAge).toBe('2h');
    expect(options.docker).toBe(false);
    expect(options.only).toEqual(['rust', 'node']);
    expect(options.removeStoppedContainers).toBe(true);
  });

  it('prints usage and rejects bad input with exit code 2', async () => {
    const help = fakeIo();
    expect(await runCli(['--help'], { io: help })).toBe(0);
    expect(help.out).toEqual([USAGE]);
    for (const argv of [
      ['clean', '--tier', 'nuclear'],
      ['docker', 'rm'],
      ['scan', '--depth', '-1'],
      ['frobnicate'],
      ['scan', '--no-such-flag'],
      ['emergency'],
    ]) {
      const io = fakeIo();
      expect(await runCli(argv, { io, api: fakeApi() })).toBe(2);
      expect(io.err.at(-1)).toBe('Run `dss --help` for usage.');
    }
  });
});

describe('consent', () => {
  it('only plans without --yes when nobody can answer', async () => {
    const { code, io, runs, last } = await run(['clean']);
    expect(code).toBe(0);
    expect(runs.length).toBe(1);
    expect(last.dryRun).toBe(true);
    expect(io.err).toEqual([
      'Dry run: pass --yes to delete non-interactively.',
    ]);
  });

  it('deletes with --yes and never with --dry-run', async () => {
    expect((await run(['clean', '--yes'])).last.dryRun).toBe(false);
    expect((await run(['clean', '--yes', '--dry-run'])).last.dryRun).toBe(true);
  });

  it('asks on a terminal and keeps everything on no', async () => {
    const io = fakeIo({ interactive: true, answers: ['n'] });
    const { runs, last } = await run(['clean'], { io });
    expect(io.questions).toEqual(['Delete the planned items? [y/N] ']);
    expect(runs.map(([, options]) => options.dryRun)).toEqual([true, true]);
    expect(last.confirm).toBe(undefined);
  });

  it('deletes after a yes and confirms risky items one by one', async () => {
    const io = fakeIo({ interactive: true, answers: ['yes', 'y'] });
    const { last } = await run(['clean'], { io });
    expect(last.dryRun).toBe(false);
    expect(last.approvedIds).toEqual(['plan-item']);
    const approved = await last.confirm({
      description: 'stopped container web (abc)',
      bytes: 2048,
      container: { owner: { session: 's-1' } },
    });
    expect(approved).toBe(true);
    expect(io.questions.at(-1)).toBe(
      'Remove stopped container web (abc) (2.0 KiB, session s-1)? [y/N] '
    );
  });
});

describe('exit codes', () => {
  it('returns 1 when a deletion failed', async () => {
    const api = fakeApi({ status: 'failed' });
    expect((await run(['clean', '--yes'], { api })).code).toBe(1);
  });

  it('returns 3 when the emergency goal is not met', async () => {
    const api = fakeApi({ goalMet: false });
    const missed = await run(['emergency', '--free', '20G', '--yes'], { api });
    expect(missed.code).toBe(3);
    expect(missed.last.free).toBe('20G');
    const met = await run(['emergency', '--until', '80%', '--yes']);
    expect(met.code).toBe(0);
  });

  it('returns 1 when an emergency action fails even if the goal is met', async () => {
    const api = fakeApi({ status: 'failed', goalMet: true });
    expect(
      (await run(['emergency', '--free', '1G', '--yes'], { api })).code
    ).toBe(1);
  });

  it('limits docker commands to Docker', async () => {
    const { api } = await run(['docker', 'clean', '--recursive', '--yes']);
    const [, options] = api.calls[0];
    expect(options.host).toBe(false);
    expect(options.docker).toBe(true);
    expect(options.dockerDepth).toBe(3);
  });
});

describe('dss on real files', () => {
  it('rescans a saved report before executing edited paths', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-report-');
    try {
      const project = join(root, 'app');
      const vendor = writeBlob(join(project, 'vendor', 'autoload.php'));
      const protectedFile = writeBlob(join(root, 'keep', 'notes.txt'));
      writeFileSync(join(project, 'composer.json'), '{}');
      writeFileSync(join(project, 'composer.lock'), '{}');
      age(root, 40 * DAY_MS);
      const env = fixtureEnv(root);
      const api = {
        scan: (options) => scan({ ...options, env }),
        clean: (report, options) => clean(report, { ...options, env }),
      };
      const args = [
        root,
        '--no-docker',
        '--no-native',
        '--scanner',
        'projects',
        '--min-size',
        '0',
        '--audit-dir',
        join(root, 'audit'),
      ];
      const saved = await api.scan({
        roots: [root],
        docker: false,
        noNative: true,
        scanners: ['projects'],
        minSize: 0,
      });
      const item = saved.items.find(
        (entry) => entry.rule === 'composer-vendor'
      );
      expect(Boolean(item)).toBe(true);
      item.paths = [join(root, 'keep')];
      item.action.paths = item.paths;
      item.blockers = [];
      const reportFile = join(root, 'report.json');
      writeFileSync(reportFile, JSON.stringify(saved));
      const io = fakeIo();
      expect(
        await runCli(
          [
            'clean',
            ...args,
            '--report',
            reportFile,
            '--tier',
            'moderate',
            '--yes',
            '--json',
          ],
          { io, api }
        )
      ).toBe(0);
      expect(existsSync(protectedFile)).toBe(true);
      expect(existsSync(vendor)).toBe(false);
    } finally {
      removeRoot(root);
    }
  });

  it('scans, plans and cleans with an audit log for every run', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    // A PHP project: no composer or php runs on CI runners, where other
    // test workers are node processes whose working directory is unknown
    // on Windows and would keep a Node.js project busy.
    const root = tempRoot('dss-cli-');
    const project = join(root, 'app');
    const vendor = join(project, 'vendor');
    writeBlob(join(vendor, 'autoload.php'), 256 * 1024);
    writeFileSync(join(project, 'composer.json'), '{}');
    writeFileSync(join(project, 'composer.lock'), '{}');
    age(root, 40 * DAY_MS);
    const auditDir = join(root, 'audit');
    const common = [
      root,
      '--no-docker',
      '--no-native',
      '--scanner',
      'projects',
      '--min-size',
      '0',
      '--audit-dir',
      auditDir,
    ];
    const env = fixtureEnv(root);
    const api = {
      scan: (options) => scan({ ...options, env }),
      clean: (report, options) => clean(report, { ...options, env }),
    };

    const scanned = fakeIo();
    expect(await runCli(['scan', ...common], { io: scanned, api })).toBe(0);
    expect(scanned.out[0]).toMatch(/nothing was deleted/);
    expect(scanned.out[0]).toMatch(/MODERATE {2}1 item/);
    expect(scanned.out[0]).toContain(vendor);

    const planned = fakeIo();
    const cleanArgs = ['clean', ...common, '--tier', 'moderate'];
    expect(await runCli(cleanArgs, { io: planned, api })).toBe(0);
    expect(existsSync(vendor)).toBe(true);

    const cleaned = fakeIo();
    expect(
      await runCli([...cleanArgs, '--yes', '--json'], { io: cleaned, api })
    ).toBe(0);
    const audit = JSON.parse(cleaned.out[0]);
    expect(audit.entries.map((e) => e.status)).toEqual(['removed']);
    expect(existsSync(vendor)).toBe(false);

    const logs = readdirSync(auditDir).map((name) => name.split('-')[1]);
    expect(logs.sort()).toEqual(['clean', 'clean', 'scan']);
    removeRoot(root);
  });
});
