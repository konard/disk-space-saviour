/**
 * Reclaimable locations outside language ecosystems: browser binaries for
 * test runners, IDE caches, AI agent stores, OS package caches, Trash, and
 * leftovers in temporary directories.
 *
 * `scope` selects how paths expand:
 * - `home` (default): `~` is every home directory;
 * - `system`: absolute paths, checked a single time per environment;
 * - `tmp`: `{TMP}` is every temporary directory (`/tmp`, `$TMPDIR`).
 *
 * `aggregate: true` reports all matches of the rule as a single item,
 * otherwise each match is its own item. `minAge: 'stale'` only reports
 * matches untouched for the stale-age window, `minAge: 'inactive'` for the
 * project inactivity window. `git: true` refuses matches that are Git work
 * trees with uncommitted, unpushed, or stashed changes.
 */

export const OTHER_RULES = [
  {
    id: 'playwright-browsers',
    ecosystem: 'browsers',
    description: 'Playwright browser downloads',
    paths: [
      '~/.cache/ms-playwright',
      '~/Library/Caches/ms-playwright',
      '{LOCALAPPDATA}/ms-playwright',
    ],
    busy: ['chrome', 'chromium', 'headless_shell', 'firefox', 'webkit'],
  },
  {
    id: 'puppeteer-browsers',
    ecosystem: 'browsers',
    description: 'Puppeteer browser downloads',
    paths: ['~/.cache/puppeteer'],
    busy: ['chrome', 'chromium', 'headless_shell'],
  },
  {
    id: 'cypress-binaries',
    ecosystem: 'browsers',
    description: 'Cypress binary cache',
    paths: ['~/.cache/Cypress', '~/Library/Caches/Cypress'],
    busy: ['Cypress', 'cypress'],
  },
  {
    id: 'selenium-drivers',
    ecosystem: 'browsers',
    description: 'Selenium Manager driver cache',
    paths: ['~/.cache/selenium'],
    busy: ['chromedriver', 'geckodriver'],
  },
  {
    id: 'jetbrains-caches',
    ecosystem: 'ide',
    description: 'JetBrains IDE caches, indexes and logs',
    paths: [
      '~/.cache/JetBrains',
      '~/Library/Caches/JetBrains',
      '~/Library/Logs/JetBrains',
      '{LOCALAPPDATA}/JetBrains/*/caches',
    ],
    busy: ['idea', 'pycharm', 'webstorm', 'clion', 'goland', 'rider', 'java'],
  },
  {
    id: 'vscode-caches',
    ecosystem: 'ide',
    description: 'VS Code caches and downloaded extension packages',
    paths: [
      '~/.config/Code/Cache',
      '~/.config/Code/CachedData',
      '~/.config/Code/CachedExtensionVSIXs',
      '~/.config/Code/logs',
      '~/Library/Application Support/Code/Cache',
      '~/Library/Application Support/Code/CachedData',
      '~/Library/Application Support/Code/CachedExtensionVSIXs',
      '~/.vscode-server/data/CachedExtensionVSIXs',
      '~/.vscode-server/data/logs',
      '~/.cursor-server/data/CachedExtensionVSIXs',
    ],
    busy: ['code', 'Code', 'code-server', 'cursor'],
  },
  {
    id: 'copilot-caches',
    ecosystem: 'ide',
    description: 'GitHub Copilot language server logs and caches',
    paths: ['~/.cache/github-copilot', '~/.config/github-copilot/logs'],
    busy: ['copilot-language-server', 'code'],
  },
  {
    id: 'codex-logs',
    ecosystem: 'agents',
    description: 'Codex CLI logs',
    paths: ['~/.codex/log'],
    busy: ['codex'],
  },
  {
    id: 'codex-sessions',
    ecosystem: 'agents',
    description:
      'Codex CLI session transcripts older than the inactivity window',
    tier: 'moderate',
    paths: ['~/.codex/sessions/*/*'],
    minAge: 'inactive',
    busy: ['codex'],
  },
  {
    id: 'homebrew-cache',
    ecosystem: 'system',
    description: 'Homebrew download cache',
    paths: ['~/Library/Caches/Homebrew', '~/.cache/Homebrew'],
    busy: ['brew'],
  },
  {
    id: 'trash',
    ecosystem: 'system',
    description: 'Trash contents',
    tier: 'moderate',
    aggregate: true,
    paths: [
      '~/.local/share/Trash/files',
      '~/.local/share/Trash/info',
      '~/.Trash/*',
    ],
  },
  {
    id: 'user-crash-reports',
    ecosystem: 'system',
    description: 'macOS crash and diagnostic reports',
    tier: 'moderate',
    aggregate: true,
    paths: ['~/Library/Logs/DiagnosticReports/*'],
  },
  {
    id: 'apt-archives',
    ecosystem: 'system',
    scope: 'system',
    description: 'apt downloaded packages',
    aggregate: true,
    paths: ['/var/cache/apt/archives/*.deb', '/var/cache/apt/*.bin'],
    native: { tool: 'apt-get', argv: ['apt-get', 'clean'], root: true },
    busy: ['apt', 'apt-get', 'dpkg', 'unattended-upgr'],
  },
  {
    id: 'dnf-yum-cache',
    ecosystem: 'system',
    scope: 'system',
    description: 'dnf/yum metadata and package cache',
    paths: ['/var/cache/dnf', '/var/cache/yum'],
    native: { tool: 'dnf', argv: ['dnf', 'clean', 'all'], root: true },
    busy: ['dnf', 'yum', 'rpm'],
  },
  {
    id: 'pacman-cache',
    ecosystem: 'system',
    scope: 'system',
    description: 'pacman package cache (used for downgrades)',
    tier: 'moderate',
    aggregate: true,
    paths: ['/var/cache/pacman/pkg/*'],
    busy: ['pacman', 'yay', 'paru'],
  },
  {
    id: 'apk-cache',
    ecosystem: 'system',
    scope: 'system',
    description: 'Alpine apk cache',
    aggregate: true,
    paths: ['/var/cache/apk/*'],
    busy: ['apk'],
  },
  {
    id: 'snapd-cache',
    ecosystem: 'system',
    scope: 'system',
    description: 'snapd download cache',
    aggregate: true,
    paths: ['/var/lib/snapd/cache/*'],
    busy: ['snap'],
  },
  {
    id: 'core-dumps',
    ecosystem: 'system',
    scope: 'system',
    description: 'core dumps and crash reports',
    tier: 'moderate',
    aggregate: true,
    paths: ['/var/lib/systemd/coredump/*', '/var/crash/*', '/cores/*'],
  },
  {
    id: 'gh-issue-solver-workdirs',
    ecosystem: 'tmp',
    scope: 'tmp',
    description: 'abandoned hive-mind solver working copies',
    tier: 'moderate',
    paths: ['{TMP}/gh-issue-solver-*'],
    minAge: 'stale',
    git: true,
    busy: ['claude', 'codex', 'opencode', 'agent', 'git', 'node', 'bun'],
  },
  {
    id: 'browser-tmp-profiles',
    ecosystem: 'tmp',
    scope: 'tmp',
    description: 'leftover headless browser profiles',
    paths: [
      '{TMP}/puppeteer_dev_chrome_profile-*',
      '{TMP}/playwright_chromiumdev_profile-*',
      '{TMP}/playwright-artifacts-*',
      '{TMP}/.org.chromium.Chromium.*',
    ],
    minAge: 'stale',
    busy: ['chrome', 'chromium', 'headless_shell'],
  },
  {
    id: 'node-tmp-caches',
    ecosystem: 'tmp',
    scope: 'tmp',
    description: 'Node.js compile caches in temporary directories',
    paths: [
      '{TMP}/node-compile-cache',
      '{TMP}/v8-compile-cache-*',
      '{TMP}/jiti',
    ],
    minAge: 'stale',
    busy: ['node'],
  },
];
