import { describe, it, expect } from 'test-anywhere';
import { posix, join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { selectContainers } from '../src/docker/scan.js';
import { WritableLayer } from '../src/docker/writable.js';
import { ShellEnv } from '../src/env/shell.js';
import { LocalEnv } from '../src/env/local.js';
import {
  buildAuthFailureGuidance,
  isNonRetryableFailure,
} from '../scripts/publish-failure-classifier.mjs';
import { capturedPublishFailure } from '../scripts/publish-output.mjs';
import { scan } from '../src/scan.js';
import { clean, wantedItems } from '../src/clean.js';
import { resolveOptions } from '../src/options.js';
import { makeItem } from '../src/items.js';
import {
  fixtureEnv,
  tempRoot,
  writeBlob,
  age,
  DAY_MS,
  scanInput,
  pushedRepo,
  git,
} from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
describe('aggregate cleanup details', () => {
  it('keeps local cache items when the directly supplied host adapter is a container', () => {
    const host = { id: 'host', label: 'fixture' };
    const item = makeItem(host, { kind: 'cache', bytes: 100 });
    expect(
      wantedItems(
        {
          items: [item],
          environments: [
            { id: 'host', kind: 'container', depth: 0, chain: [] },
          ],
        },
        resolveOptions({ docker: false, minSize: 0 })
      )
    ).toEqual([item]);
  });
  it('applies no-docker to Docker actions from a previously scanned report', () => {
    const host = { id: 'host', label: 'fixture' };
    const item = makeItem(host, {
      kind: 'docker',
      bytes: 100,
      action: { type: 'command', argv: ['docker', 'builder', 'prune'] },
    });
    expect(
      wantedItems(
        { items: [item] },
        resolveOptions({ docker: false, minSize: 0 })
      )
    ).toEqual([]);
  });
  it('accepts unique name prefixes and reports ambiguous and unmatched filters', () => {
    const rows = [
      { ID: 'aaa', Names: 'task-111-resume' },
      { ID: 'bbb', Names: 'task-222-resume' },
    ];
    expect([...selectContainers(rows, ['task-111']).ids]).toEqual(['aaa']);
    expect(selectContainers(rows, ['task-']).errors.join()).toMatch(
      /ambiguous/
    );
    expect(selectContainers(rows, ['missing']).errors.join()).toMatch(
      /no matching/
    );
  });
  it('measures the authoritative upperdir without a diff or memory probe', async () => {
    const calls = [];
    const executor = {
      run: async (argv) => {
        calls.push(argv);
        if (argv[1] === 'inspect') {
          return ok(
            JSON.stringify([
              {
                Id: 'box',
                Mounts: [],
                Config: { Image: 'start-command-resume/task:1' },
                GraphDriver: { Data: { UpperDir: '/storage/upper' } },
              },
            ])
          );
        }
        if (argv[0] === 'stat') {
          return ok('directory');
        }
        if (argv[0] === 'du') {
          return ok('4\t/storage/upper/cache');
        }
        throw new Error('unexpected command');
      },
    };
    const usage = await new WritableLayer(executor, 'box').measure(
      { path: posix },
      new Map([['/cache', { bytes: 8192 }]])
    );
    expect(usage.get('/cache').bytes).toBe(4096);
    expect(usage.get('/cache').imageBytes).toBe(4096);
    expect(calls.some((argv) => argv[1] === 'diff')).toBe(false);
  });
  it('preserves readable shell paths while retaining denied PID identity', async () => {
    const env = new ShellEnv({
      run: async () => ({
        code: 1,
        stdout: '/work/app.js\n',
        stderr: 'DSS_UNREADABLE|22|0|dockerd|dockerd --data-root=/custom\n',
      }),
    });
    expect((await env.openPaths()).has('/work/app.js')).toBe(true);
    expect(env.unreadableProcesses[0].uid).toBe(0);
    expect(env.unreadableProcesses[0].command).toMatch(/custom/);
  });
});

describe('aggregate cleanup safety and publishing', () => {
  itUnless(sandboxed)(
    'reports Full Disk Access when Safari inspection is denied',
    async () => {
      const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
      const env = new LocalEnv({
        platform: 'darwin',
        fileFs: {
          lstat: async () => {
            throw denied;
          },
        },
      });
      expect(await env.stat('/Users/me/Library/Caches/com.apple.Safari')).toBe(
        null
      );
      expect([...env.accessErrors.values()].join()).toMatch(/Full Disk Access/);
    }
  );
  it('explains a repository transfer in npm publishing diagnostics', () => {
    expect(buildAuthFailureGuidance('disk-space-saviour')).toMatch(
      /repository transfer/
    );
    expect(buildAuthFailureGuidance('disk-space-saviour')).toMatch(
      /link-foundation/
    );
  });
  it('retains npm E404 diagnostics when publishing rejects with a generic exit error', () => {
    const error = Object.assign(new Error('Command failed with exit code 1'), {
      code: 1,
      stderr: 'npm error code E404',
    });
    const result = capturedPublishFailure(error);
    expect(isNonRetryableFailure(result.stderr)).toBe(true);
    expect(result.code).toBe(1);
  });
  itUnless(sandboxed)(
    'blocks nonignored artifact files while allowing ignored artifacts with dirty source',
    async () => {
      const root = tempRoot('dss-artifacts-');
      const repo = pushedRepo(join(root, 'app'));
      writeFileSync(join(repo, 'package.json'), '{}');
      writeFileSync(join(repo, 'package-lock.json'), '{}');
      git(repo, 'add', 'package.json', 'package-lock.json');
      git(repo, 'commit', '-qm', 'package');
      const modules = join(repo, 'node_modules');
      writeBlob(join(modules, 'keep.js'));
      writeFileSync(join(repo, '.gitignore'), '');
      age(root, 40 * DAY_MS);
      const env = fixtureEnv(root);
      const options = scanInput(env, [repo], { scanners: ['projects'] });
      const report = await scan(options);
      expect(
        report.items
          .find((item) => item.rule === 'node-modules')
          .blockers.join()
      ).toMatch(/not ignored/);
      const audit = await clean(report, {
        ...options,
        tier: 'moderate',
        audit: false,
      });
      expect(audit.entries.some((entry) => entry.status === 'removed')).toBe(
        false
      );
      expect(existsSync(modules)).toBe(true);
    }
  );
});
