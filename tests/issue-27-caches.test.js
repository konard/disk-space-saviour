import { describe, it, expect } from 'test-anywhere';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { scan } from '../src/scan.js';
import { clean } from '../src/clean.js';
import {
  fixtureEnv,
  tempRoot,
  writeBlob,
  age,
  DAY_MS,
  scanInput,
  readOnlyRuntime,
} from './helpers/fixtures.js';

async function caches(files, input = {}) {
  const root = tempRoot('dss-expanded-caches-');
  const home = join(root, 'home');
  for (const file of files) {
    writeBlob(join(home, file), 8192);
  }
  age(root, 40 * DAY_MS);
  const env = fixtureEnv(root);
  const options = scanInput(env, [], { scanners: ['global'], ...input });
  return { root, home, env, options, report: await scan(options) };
}

describe('issue 18 cache coverage', () => {
  it('rechecks exclusions discovered during the final usage walk before removing its ancestor', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { home, env, options, report } = await caches(
      ['.cache/uv/drop/data'],
      { exclude: ['keep'] }
    );
    const usage = env.usage.bind(env);
    env.usage = async (target) => {
      const result = await usage(target);
      env.scanPolicy.allows(join(target, 'keep'));
      return result;
    };
    const audit = await clean(report, { ...options, audit: false });
    expect(existsSync(join(home, '.cache/uv/drop/data'))).toBe(true);
    expect(audit.entries.every((entry) => entry.status !== 'removed')).toBe(
      true
    );
  });
  it('finds Telegram cache partitions and preserves its database and media', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const base =
      'Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram/appstore/account-1/postbox';
    const { home, report } = await caches([
      `${base}/media/cache/blob`,
      `${base}/media/cache-storage/blob`,
      `${base}/media/short-cache/blob`,
      `${base}/db.sqlite`,
      `${base}/media/downloads/blob`,
    ]);
    const safe = report.items
      .filter((item) => item.tier === 'safe')
      .flatMap((item) => item.paths);
    expect(safe).toContain(join(home, base, 'media/cache'));
    expect(safe).toContain(join(home, base, 'media/cache-storage'));
    expect(safe).toContain(join(home, base, 'media/short-cache'));
    expect(safe).not.toContain(join(home, base));
    expect(
      report.items.some(
        (item) =>
          item.paths.includes(join(home, base, 'media/downloads')) &&
          item.tier === 'moderate'
      )
    ).toBe(true);
  });

  it('finds application-support Chromium and marker-backed Electron caches', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const chrome = 'Library/Application Support/Google/Chrome';
    const electron = 'Library/Application Support/Example';
    const { home, report } = await caches([
      `${chrome}/Default/Code Cache/blob`,
      `${chrome}/Profile 1/Service Worker/CacheStorage/blob`,
      `${chrome}/GrShaderCache/blob`,
      `${chrome}/Default/Cookies`,
      `${electron}/Local Storage/state`,
      `${electron}/GPUCache/blob`,
      `${electron}/Cookies`,
      'Library/Application Support/Other/GPUCache/valuable',
    ]);
    const paths = report.items.flatMap((item) => item.paths);
    expect(paths).toContain(join(home, chrome, 'Default/Code Cache'));
    expect(paths).toContain(
      join(home, chrome, 'Profile 1/Service Worker/CacheStorage')
    );
    expect(paths).toContain(join(home, chrome, 'GrShaderCache'));
    expect(paths).toContain(join(home, electron, 'GPUCache'));
    expect(paths).not.toContain(
      join(home, 'Library/Application Support/Other/GPUCache')
    );
    expect(paths).not.toContain(join(home, chrome, 'Default'));
  });

  it('keeps MCP profiles while old browser revisions are safe', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { home, report } = await caches([
      '.cache/ms-playwright/chromium-100/chrome',
      '.cache/ms-playwright/chromium-200/chrome',
      '.cache/ms-playwright/mcp-chrome-profile/Default/Cookies',
      '.cache/ms-playwright/mcp-chromium-1/Default/Cookies',
    ]);
    const browsers = report.items.filter(
      (item) => item.rule === 'playwright-browsers'
    );
    expect(browsers.length).toBe(1);
    expect(browsers[0].tier).toBe('safe');
    expect(browsers[0].path).toBe(
      join(home, '.cache/ms-playwright/chromium-100')
    );
  });

  it('protects excluded descendants from ancestor removal', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { home, options, report } = await caches(
      ['.cache/uv/keep/data', '.cache/uv/drop/data'],
      { exclude: ['keep'] }
    );
    const audit = await clean(report, { ...options, audit: false });
    expect(existsSync(join(home, '.cache/uv/keep/data'))).toBe(true);
    expect(audit.entries.every((entry) => entry.status !== 'removed')).toBe(
      true
    );
  });

  it('finalizes a partial audit when a callback interrupts cleanup', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { root, options, report } = await caches(['.cache/uv/data']);
    const dir = join(root, 'audit');
    const audit = await clean(report, {
      ...options,
      auditDir: dir,
      onEntry: () => {
        throw new Error('interrupted');
      },
    });
    expect(audit.finishedAt).not.toBe(null);
    expect(audit.aborted).toBe(true);
    expect(audit.error).toMatch(/interrupted/);
    expect(audit.entries.some((entry) => entry.status === 'removed')).toBe(
      true
    );
  });
});
