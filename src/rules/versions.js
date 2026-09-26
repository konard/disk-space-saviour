/**
 * Toolchain version managers. Every installed version is a candidate
 * (tier `moderate`) unless it is:
 * - the manager's default or an alias/override target (`defaults`),
 * - referenced by a pin file in any scanned project (`projectFiles`),
 * - the newest installed version,
 * - in use by a running process (checked by the liveness layer).
 *
 * `versionOf(dirPath)` maps an install directory to the version string that
 * defaults and pin files are compared with (see `versionMatches`).
 */

function firstLines(text) {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function tomlValue(text, key) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(
    text ?? ''
  );
  return match ? match[1] : null;
}

function tomlOverrides(text) {
  const section = /^\[overrides\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(
    text ?? ''
  );
  if (!section) {
    return [];
  }
  return [...section[1].matchAll(/=\s*"([^"]+)"/g)].map((m) => m[1]);
}

function basename(dirPath) {
  return dirPath.split(/[\\/]/).filter(Boolean).pop() ?? dirPath;
}

function rustToolchainRefs(text) {
  const channel = tomlValue(text, 'channel');
  if (channel) {
    return [channel];
  }
  return firstLines(text).filter((line) => !line.includes('='));
}

function elanName(dirName) {
  return dirName.replaceAll('---', ':').replaceAll('--', '/');
}

/**
 * Normalizes a version string for comparison.
 * @param {string} value
 */
export function normalizeVersion(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^v(?=\d)/, '')
    .replace(/^ghc-/, '');
}

/**
 * Whether an installed version satisfies a reference: equal, or the
 * reference is a prefix ending at a `.` or `-` boundary (`20` matches
 * `20.11.1`, `stable` matches `stable-x86_64-unknown-linux-gnu`).
 * @param {string} installed
 * @param {string} reference
 */
export function versionMatches(installed, reference) {
  const a = normalizeVersion(installed);
  const b = normalizeVersion(reference);
  if (!b) {
    return false;
  }
  return a === b || a.startsWith(`${b}.`) || a.startsWith(`${b}-`);
}

/**
 * Compares dotted versions numerically, falling back to string order.
 */
export function compareVersions(left, right) {
  const a = normalizeVersion(left).split(/[=.-]/);
  const b = normalizeVersion(right).split(/[=.-]/);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index] ?? '';
    const y = b[index] ?? '';
    const nx = Number(x);
    const ny = Number(y);
    const diff =
      x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny)
        ? nx - ny
        : x.localeCompare(y);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export const VERSION_RULES = [
  {
    id: 'nvm-node',
    ecosystem: 'javascript',
    manager: 'nvm',
    description: 'Node.js version installed by nvm',
    dirs: ['~/.nvm/versions/node/*'],
    aliasDir: '~/.nvm/alias',
    defaults: [{ path: '~/.nvm/alias/default', parse: firstLines }],
    projectFiles: { '.nvmrc': firstLines, '.node-version': firstLines },
    busy: ['node'],
  },
  {
    id: 'pyenv-python',
    ecosystem: 'python',
    manager: 'pyenv',
    description: 'Python version installed by pyenv',
    dirs: ['~/.pyenv/versions/*'],
    defaults: [{ path: '~/.pyenv/version', parse: firstLines }],
    projectFiles: { '.python-version': firstLines },
    busy: ['python', 'python3'],
  },
  {
    id: 'rbenv-ruby',
    ecosystem: 'ruby',
    manager: 'rbenv',
    description: 'Ruby version installed by rbenv',
    dirs: ['~/.rbenv/versions/*'],
    defaults: [{ path: '~/.rbenv/version', parse: firstLines }],
    projectFiles: { '.ruby-version': firstLines },
    busy: ['ruby'],
  },
  {
    id: 'sdkman-candidate',
    ecosystem: 'jvm',
    manager: 'sdkman',
    description: 'SDK installed by SDKMAN!',
    dirs: ['~/.sdkman/candidates/*/*'],
    exclude: ['current'],
    currentLink: 'current',
    versionOf: (dirPath) => {
      const parts = dirPath.split(/[\\/]/).filter(Boolean);
      return `${parts.at(-2)}=${parts.at(-1)}`;
    },
    projectFiles: {
      '.sdkmanrc': (text) =>
        firstLines(text).filter((line) => line.includes('=')),
    },
    busy: ['java', 'gradle', 'mvn', 'kotlin', 'sbt'],
  },
  {
    id: 'rustup-toolchain',
    ecosystem: 'rust',
    manager: 'rustup',
    description: 'Rust toolchain installed by rustup',
    dirs: ['~/.rustup/toolchains/*'],
    defaults: [
      {
        path: '~/.rustup/settings.toml',
        parse: (text) => [
          tomlValue(text, 'default_toolchain'),
          ...tomlOverrides(text),
        ],
      },
    ],
    projectFiles: {
      'rust-toolchain': rustToolchainRefs,
      'rust-toolchain.toml': rustToolchainRefs,
    },
    busy: ['cargo', 'rustc', 'rustdoc', 'rust-analyzer'],
  },
  {
    id: 'elan-toolchain',
    ecosystem: 'lean',
    manager: 'elan',
    description: 'Lean toolchain installed by elan',
    dirs: ['~/.elan/toolchains/*'],
    versionOf: (dirPath) => elanName(basename(dirPath)),
    defaults: [
      {
        path: '~/.elan/settings.toml',
        parse: (text) => [
          tomlValue(text, 'default_toolchain'),
          ...tomlOverrides(text),
        ],
      },
    ],
    projectFiles: { 'lean-toolchain': firstLines },
    busy: ['lean', 'lake'],
  },
  {
    id: 'ghcup-ghc',
    ecosystem: 'haskell',
    manager: 'ghcup',
    description: 'GHC installed by ghcup',
    dirs: ['~/.ghcup/ghc/*'],
    defaultLinks: ['~/.ghcup/bin/ghc'],
    projectFiles: {
      'cabal.project': (text) =>
        [...(text ?? '').matchAll(/with-compiler:\s*ghc-([\d.]+)/g)].map(
          (m) => m[1]
        ),
    },
    busy: ['ghc', 'cabal', 'stack', 'haskell-language-server'],
  },
  {
    id: 'opam-switch',
    ecosystem: 'ocaml',
    manager: 'opam',
    description: 'opam switch',
    dirs: ['~/.opam/*'],
    selfMarker: '.opam-switch',
    defaults: [
      {
        path: '~/.opam/config',
        parse: (text) => {
          const match = /^switch:\s*"([^"]+)"/m.exec(text ?? '');
          return match ? [match[1]] : [];
        },
      },
    ],
    projectFiles: {},
    busy: ['ocaml', 'dune', 'opam', 'ocamllsp'],
    protectAll: true,
  },
  {
    id: 'swiftly-toolchain',
    ecosystem: 'swift',
    manager: 'swiftly',
    description: 'Swift toolchain installed by swiftly',
    dirs: ['~/.local/share/swiftly/toolchains/*'],
    defaults: [
      {
        path: '~/.local/share/swiftly/config.json',
        parse: (text) => {
          const match = /"inUse"\s*:\s*"([^"]+)"/.exec(text ?? '');
          return match ? [match[1]] : [];
        },
      },
    ],
    projectFiles: { '.swift-version': firstLines },
    busy: ['swift', 'swift-frontend', 'sourcekit-lsp'],
  },
  {
    id: 'vscode-server-builds',
    ecosystem: 'ide',
    manager: 'vscode-server',
    description: 'VS Code Server build',
    dirs: ['~/.vscode-server/bin/*', '~/.vscode-server/cli/servers/*'],
    newestBy: 'mtime',
    projectFiles: {},
    busy: ['node', 'code-server'],
  },
];
