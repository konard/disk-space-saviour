import { describe, it, expect } from 'test-anywhere';
import { join, posix } from 'node:path';
import { scan } from '../src/scan.js';
import { clean } from '../src/clean.js';
import { APP_RULES } from '../src/rules/apps.js';
import { expandRulePath } from '../src/paths.js';
import { ScanPolicy } from '../src/env/policy.js';
import {
  fixtureEnv,
  tempRoot,
  writeBlob,
  age,
  DAY_MS,
  scanInput,
} from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

describe('new application and runner rule families', () => {
  for (const rule of APP_RULES) {
    itUnless(sandboxed)(
      `discovers and safely cleans an idle ${rule.id} fixture`,
      async () => {
        const root = tempRoot('dss-rule-family-');
        const env = fixtureEnv(root);
        const home = join(root, 'home');
        const tmp = join(root, 'tmp');
        env.tmpDirs = async () => [tmp];
        env.vars = {
          APPDATA: join(home, 'roaming'),
          LOCALAPPDATA: join(home, 'local'),
        };
        const target = expandRulePath(rule.paths[0], {
          home,
          vars: { ...env.vars, TMP: tmp },
          pathApi: env.path,
        }).replaceAll('*', 'sample');
        writeBlob(rule.fileOnly ? target : join(target, 'payload'));
        if (rule.markers) {
          writeBlob(join(env.path.dirname(target), 'Local Storage', 'state'));
        }
        age(root, 40 * DAY_MS);
        const options = scanInput(env, [], {
          scanners: ['global'],
          tier: rule.tier ?? 'safe',
        });
        const report = await scan(options);
        const item = report.items.find(
          (entry) => entry.rule === rule.id && entry.path === target
        );
        expect(Boolean(item)).toBe(true);
        expect(item.blockers).toEqual([]);
        expect(item.tier).toBe(rule.tier ?? 'safe');
        const audit = await clean(report, { ...options, audit: false });
        expect(
          audit.entries.some(
            (entry) => entry.id === item.id && entry.status === 'removed'
          )
        ).toBe(true);
      }
    );
  }

  itUnless(sandboxed)(
    'protects an Electron cache while its app runs',
    async () => {
      const root = tempRoot('dss-electron-busy-');
      const app = join(root, 'home', 'Library/Application Support/Example');
      writeBlob(join(app, 'GPUCache/blob'));
      writeBlob(join(app, 'Local Storage/state'));
      age(root, 40 * DAY_MS);
      const env = fixtureEnv(root);
      env.processes = async () => [
        { pid: 1234, name: 'Example', command: 'Example', cwd: '/elsewhere' },
      ];
      const report = await scan(scanInput(env, [], { scanners: ['global'] }));
      expect(
        report.items
          .find((item) => item.path === join(app, 'GPUCache'))
          .blockers.join()
      ).toMatch(/busy/);
    }
  );

  itUnless(sandboxed)(
    'finalizes an audit when cancellation arrives during its last item',
    async () => {
      const root = tempRoot('dss-last-abort-');
      writeBlob(join(root, 'home/.cache/uv/payload'));
      age(root, 40 * DAY_MS);
      const env = fixtureEnv(root);
      const controller = new AbortController();
      const options = scanInput(env, [], { scanners: ['global'] });
      const audit = await clean(await scan(options), {
        ...options,
        audit: false,
        signal: controller.signal,
        onEntry: () => controller.abort(),
      });
      expect(audit.aborted).toBe(true);
      expect(Boolean(audit.finishedAt)).toBe(true);
    }
  );
});

describe('explicit mount roots', () => {
  it('allows an explicitly selected subdirectory on an ordinary mount, while pruning runtime and overlay roots', () => {
    const env = { path: posix };
    const mounts = [
      { path: '/volume', type: 'ext4' },
      { path: '/images', type: 'overlay' },
      { path: '/readonly', type: 'ext4', readonly: true },
    ];
    const policy = new ScanPolicy(
      env,
      { roots: ['/volume/project', '/images', '/readonly', '/var/lib/docker'] },
      mounts
    );
    expect(policy.allows('/volume/project/cache')).toBe(true);
    expect(policy.allows('/images/cache')).toBe(false);
    expect(policy.allows('/readonly/cache')).toBe(false);
    expect(policy.allows('/var/lib/docker/cache')).toBe(false);
  });
});
