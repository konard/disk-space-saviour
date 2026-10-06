/**
 * Application, browser and agent caches outside language ecosystems:
 * staged app updates, browser HTTP caches, agent logs, and IDE extension
 * folders that must never be treated as projects.
 */

import { describe, it, expect } from 'test-anywhere';
import { join, posix, win32 } from 'node:path';

import { expandRulePath } from '../src/paths.js';
import { OTHER_RULES } from '../src/rules/other.js';
import { scan } from '../src/scan.js';
import {
  fixtureEnv,
  age,
  DAY_MS,
  readOnlyRuntime,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

const HOUR_MS = 60 * 60 * 1000;

async function scanHome(files, { ageMs = 2 * HOUR_MS, roots = [] } = {}) {
  const root = tempRoot('dss-app-caches-');
  const home = join(root, 'home');
  for (const file of files) {
    writeBlob(join(home, file), 32 * 1024);
  }
  age(root, ageMs);
  const report = await scan(
    scanInput(
      fixtureEnv(root),
      roots.map((dir) => join(home, dir)),
      {
        scanners: roots.length > 0 ? ['projects'] : ['global'],
      }
    )
  );
  return { root, home, report };
}

const byRule = (report, rule) =>
  report.items.filter((item) => item.rule === rule);

describe('application and agent cache rules', () => {
  it('reports staged Sparkle and ShipIt updates but keeps ShipIt state', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const caches = 'Library/Caches';
    const { root, home, report } = await scanHome([
      `${caches}/com.example.app/org.sparkle-project.Sparkle/Installation/x/App.tar.xz`,
      `${caches}/com.example.editor.ShipIt/update.abc/Editor.app/binary`,
      `${caches}/com.example.editor.ShipIt/ShipItState.plist`,
    ]);
    const paths = [
      ...byRule(report, 'sparkle-update-downloads'),
      ...byRule(report, 'shipit-update-downloads'),
    ]
      .flatMap((item) => item.paths)
      .sort();
    expect(paths).toEqual([
      join(home, caches, 'com.example.app', 'org.sparkle-project.Sparkle'),
      join(home, caches, 'com.example.editor.ShipIt', 'update.abc'),
    ]);
    removeRoot(root);
  });

  it('leaves app updates staged within the activity window alone', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { root, report } = await scanHome(
      ['Library/Caches/com.example.app/org.sparkle-project.Sparkle/u.zip'],
      { ageMs: 0 }
    );
    expect(byRule(report, 'sparkle-update-downloads')).toEqual([]);
    removeRoot(root);
  });

  it('keeps the newest playwright-go driver', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { root, home, report } = await scanHome(
      [
        'Library/Caches/ms-playwright-go/1.50.1/node',
        'Library/Caches/ms-playwright-go/1.52.0/node',
      ],
      { ageMs: 40 * DAY_MS }
    );
    const items = byRule(report, 'playwright-go-drivers');
    expect(items.map((item) => item.path)).toEqual([
      join(home, 'Library/Caches/ms-playwright-go/1.50.1'),
    ]);
    expect(items[0].tier).toBe('moderate');
    removeRoot(root);
  });

  it('reports browser HTTP caches but not browser profiles', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { root, home, report } = await scanHome([
      'Library/Caches/Google/Chrome/Default/Cache/Cache_Data/data_0',
      'Library/Caches/Google/Chrome/Default/Storage/ext/state',
      'Library/Caches/Firefox/Profiles/abc.default/cache2/entries/x',
    ]);
    const paths = [
      ...byRule(report, 'chrome-http-caches'),
      ...byRule(report, 'firefox-http-caches'),
    ]
      .map((item) => item.path)
      .sort();
    expect(paths).toEqual([
      join(home, 'Library/Caches/Firefox/Profiles/abc.default/cache2'),
      join(home, 'Library/Caches/Google/Chrome/Default/Cache'),
    ]);
    removeRoot(root);
  });

  it('aggregates Claude Code MCP logs of every project', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const { root, report } = await scanHome([
      'Library/Caches/claude-cli-nodejs/-work-a/mcp-logs-ide/1.jsonl',
      'Library/Caches/claude-cli-nodejs/-work-b/mcp-logs-ide/1.jsonl',
    ]);
    const items = byRule(report, 'claude-cli-mcp-logs');
    expect(items.length).toBe(1);
    expect(items[0].paths.length).toBe(2);
    removeRoot(root);
  });

  it('never treats IDE extension dependencies as projects', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const files = ['.qoder', '.windsurf', '.vscode'].flatMap((ide) => [
      `${ide}/extensions/pub.ext-1.0.0/package.json`,
      `${ide}/extensions/pub.ext-1.0.0/package-lock.json`,
      `${ide}/extensions/pub.ext-1.0.0/node_modules/dep/index.js`,
    ]);
    const { root, report } = await scanHome(files, {
      ageMs: 40 * DAY_MS,
      roots: ['.'],
    });
    expect(byRule(report, 'node-modules')).toEqual([]);
    removeRoot(root);
  });

  it('expands every rule path on Linux, macOS and Windows', () => {
    const platforms = [
      { home: '/home/me', vars: {}, pathApi: posix },
      {
        home: 'C:\\Users\\me',
        vars: {
          LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
          APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        },
        pathApi: win32,
      },
    ];
    for (const rule of OTHER_RULES) {
      for (const pattern of rule.paths) {
        for (const platform of platforms) {
          const expanded = expandRulePath(pattern, platform);
          if (expanded === null) {
            expect(/\{[A-Z_]+\}/.test(pattern)).toBe(true);
            continue;
          }
          expect(platform.pathApi.isAbsolute(expanded)).toBe(true);
          expect(/[~{}]/.test(expanded)).toBe(false);
        }
      }
    }
  });
});

describe('browser cache rules', () => {
  it('reports caches of other browsers, including single-profile Opera', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const caches = 'Library/Caches';
    const { root, home, report } = await scanHome([
      `${caches}/Microsoft Edge/Profile 1/Cache/Cache_Data/data_0`,
      `${caches}/com.operasoftware.Opera/Cache/Cache_Data/data_0`,
      `${caches}/com.operasoftware.Opera/Code Cache/js/index`,
      `${caches}/com.operasoftware.Opera/Session Storage/state`,
      `${caches}/Vivaldi/Default/Cache/Cache_Data/data_0`,
      `${caches}/librewolf/Profiles/abc.default/cache2/entries/x`,
    ]);
    const paths = [
      'edge-http-caches',
      'opera-http-caches',
      'vivaldi-http-caches',
      'firefox-fork-http-caches',
    ]
      .flatMap((rule) => byRule(report, rule))
      .map((item) => item.path)
      .sort();
    expect(paths).toEqual(
      [
        `${caches}/Microsoft Edge/Profile 1/Cache`,
        `${caches}/Vivaldi/Default/Cache`,
        `${caches}/com.operasoftware.Opera/Cache`,
        `${caches}/com.operasoftware.Opera/Code Cache`,
        `${caches}/librewolf/Profiles/abc.default/cache2`,
      ]
        .map((path) => join(home, path))
        .sort()
    );
    removeRoot(root);
  });
});
