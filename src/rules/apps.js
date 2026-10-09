/** Only regenerable cache leaves; profiles, databases and local storage survive. */
export const CACHE_LEAVES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Service Worker/CacheStorage',
  'Service Worker/ScriptCache',
];
const telegramAccounts =
  '~/Library/Group Containers/*.ru.keepcoder.Telegram/*/account-*/postbox/media';
const telegramDesktop = [
  '~/.local/share/TelegramDesktop/tdata',
  '~/Library/Application Support/Telegram Desktop/tdata',
  '{APPDATA}/Telegram Desktop/tdata',
];
export const APP_RULES = [
  {
    id: 'telegram-caches',
    ecosystem: 'apps',
    description: 'Telegram regenerable media cache partitions',
    paths: [
      ...['cache', 'cache-storage', 'short-cache'].map(
        (leaf) => `${telegramAccounts}/${leaf}`
      ),
      '~/Library/Containers/ru.keepcoder.Telegram/Data/Library/Caches',
      '~/Library/Caches/ru.keepcoder.Telegram',
      ...telegramDesktop.flatMap((root) =>
        ['cache', 'user_data/cache', 'user_data/media_cache'].map(
          (leaf) => `${root}/${leaf}`
        )
      ),
    ],
    busy: ['Telegram', 'telegram-desktop'],
  },
  {
    id: 'telegram-downloaded-media',
    excludeNames: ['cache', 'cache-storage', 'short-cache'],
    ecosystem: 'apps',
    tier: 'moderate',
    description:
      'Telegram downloaded media: secret-chat media may not be recoverable',
    paths: [
      `${telegramAccounts}/*`,
      ...telegramDesktop.map((root) => `${root}/user_data/downloads`),
    ],
    busy: ['Telegram', 'telegram-desktop'],
  },
  {
    id: 'safari-webkit-caches',
    ecosystem: 'browsers',
    description: 'Safari and WebKit HTTP/compiled resource caches',
    paths: [
      '~/Library/Caches/com.apple.Safari',
      '~/Library/Caches/com.apple.WebKit.Networking',
      '~/Library/Caches/*/WebKit',
      '~/Library/Containers/com.apple.Safari/Data/Library/Caches',
      '~/Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default/CacheStorage',
      '~/Library/WebKit/com.apple.Safari/WebsiteData/Default/CacheStorage',
    ],
    busy: ['Safari', 'com.apple.WebKit'],
  },
  {
    id: 'electron-profile-caches',
    ecosystem: 'apps',
    description: 'Electron app regenerable caches',
    paths: [
      '~/Library/Application Support/*',
      '~/.config/*',
      '{APPDATA}/*',
    ].flatMap((root) => CACHE_LEAVES.map((leaf) => `${root}/${leaf}`)),
    markers: ['Local Storage', 'Preferences'],
    busy: ['electron', 'Electron'],
  },
  {
    id: 'agent-scratch-sessions',
    directoryOnly: true,
    ecosystem: 'agents',
    scope: 'tmp',
    tier: 'moderate',
    description:
      'inactive Claude/Codex scratch sessions and partial work copies',
    paths: [
      '{TMP}/claude-*/*/*',
      '{TMP}/codex-*/*/*',
      '{TMP}/codex-scratch-*',
      '{TMP}/claude-copy-*',
      '{TMP}/codex-copy-*',
    ],
    minAge: 'inactive',
    git: 'ifPresent',
    busy: ['claude', 'codex', 'git', 'node', 'bun'],
  },
  {
    id: 'agent-scratch-files',
    ecosystem: 'agents',
    scope: 'tmp',
    tier: 'moderate',
    description: 'inactive agent-named temporary logs and scripts',
    paths: [
      '{TMP}/claude-*.log',
      '{TMP}/claude-*.sh',
      '{TMP}/codex-*.log',
      '{TMP}/codex-*.sh',
    ],
    minAge: 'inactive',
    busy: ['claude', 'codex', 'bash', 'sh'],
    fileOnly: true,
  },
  {
    id: 'bunx-cache',
    ecosystem: 'javascript',
    description: 'per-entry bunx package cache',
    scope: 'tmp',
    paths: ['{TMP}/bunx-*'],
    minAge: 'stale',
    busy: [],
  },
  {
    id: 'pnpm-dlx-cache',
    ecosystem: 'javascript',
    description: 'per-entry pnpm dlx package cache',
    paths: [
      '~/.cache/pnpm/dlx/*',
      '~/Library/Caches/pnpm/dlx/*',
      '{LOCALAPPDATA}/pnpm-cache/dlx/*',
    ],
    minAge: 'stale',
    busy: [],
  },
  {
    id: 'yarn-dlx-cache',
    ecosystem: 'javascript',
    description: 'per-entry Yarn dlx temporary cache',
    scope: 'tmp',
    paths: ['{TMP}/dlx-*'],
    minAge: 'stale',
    busy: [],
  },
];

export function expandChromiumCaches(rules) {
  return rules.map((rule) => {
    if (
      !rule.id.includes('http-caches') ||
      !rule.paths.some((p) => p.includes('/Code Cache'))
    ) {
      return rule;
    }
    const bases = rule.paths
      .filter((p) => p.endsWith('/Code Cache'))
      .map((p) => p.slice(0, -'/Code Cache'.length));
    const support = bases
      .filter((p) => p.includes('~/Library/Caches/'))
      .map((p) =>
        p.replace('~/Library/Caches/', '~/Library/Application Support/')
      );
    const profiles = [...bases, ...support];
    const roots = profiles.map((p) => (p.endsWith('/*') ? p.slice(0, -2) : p));
    return {
      ...rule,
      paths: [
        ...new Set([
          ...rule.paths,
          ...profiles.flatMap((p) =>
            CACHE_LEAVES.map((leaf) => `${p}/${leaf}`)
          ),
          ...roots.flatMap((p) =>
            ['GrShaderCache', 'ShaderCache', 'component_crx_cache'].map(
              (leaf) => `${p}/${leaf}`
            )
          ),
        ]),
      ],
    };
  });
}
