/** Resolve cache configuration once per environment, using only that user's tools. */
export const CACHE_VARIABLES = [
  'LOCALAPPDATA',
  'APPDATA',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GRADLE_USER_HOME',
  'DENO_DIR',
  'BUN_INSTALL_CACHE_DIR',
  'GOMODCACHE',
  'GOCACHE',
  'GOPATH',
  'NVM_DIR',
  'SDKMAN_DIR',
  'PERLBREW_ROOT',
  'RBENV_ROOT',
  'GEM_HOME',
  'GEM_PATH',
  'npm_config_cache',
  'NPM_CONFIG_CACHE',
  'PIP_CACHE_DIR',
  'YARN_CACHE_FOLDER',
  'PNPM_STORE_DIR',
];

const ROOTS = [
  ['~/.cargo', 'CARGO_HOME'],
  ['~/.rustup', 'RUSTUP_HOME'],
  ['~/.gradle', 'GRADLE_USER_HOME'],
  ['~/.nvm', 'NVM_DIR'],
  ['~/.sdkman', 'SDKMAN_DIR'],
  ['~/.perl5', 'PERLBREW_ROOT'],
  ['~/perl5/perlbrew', 'PERLBREW_ROOT'],
  ['~/.rbenv', 'RBENV_ROOT'],
  ['~/.bun/install/cache', 'BUN_INSTALL_CACHE_DIR'],
  ['~/.cache/deno', 'DENO_DIR'],
  ['~/.npm', 'npm_config_cache', 'NPM_CONFIG_CACHE'],
  ['~/.cache/pip', 'PIP_CACHE_DIR'],
  ['~/.cache/yarn', 'YARN_CACHE_FOLDER'],
  ['~/.local/share/pnpm/store', 'PNPM_STORE_DIR'],
  ['~/go/pkg/mod', 'GOMODCACHE'],
  ['~/.cache/go-build', 'GOCACHE'],
  ['~/.cache', 'XDG_CACHE_HOME'],
];

export function configuredPattern(env, home, pattern) {
  if (home !== env.currentHome) {
    return pattern;
  }
  for (const [prefix, ...keys] of ROOTS) {
    if (pattern !== prefix && !pattern.startsWith(`${prefix}/`)) {
      continue;
    }
    const root = keys
      .map((key) => env.vars?.[key])
      .find((value) => value && env.path.isAbsolute(value));
    if (root) {
      return env.path.join(root, pattern.slice(prefix.length));
    }
  }
  return pattern;
}

function applyQuery(vars, keys, values, pathApi) {
  for (const key of keys) {
    if (
      !vars[key] &&
      typeof values[key] === 'string' &&
      pathApi.isAbsolute(values[key])
    ) {
      vars[key] = values[key];
    }
  }
}

export async function configureCacheRoots(env, homes) {
  if (env.variables) {
    Object.assign(env.vars, await env.variables(CACHE_VARIABLES));
  }
  if (!homes.includes(env.currentHome)) {
    return;
  }
  const vars = env.vars;
  if (!vars.GOMODCACHE && vars.GOPATH) {
    vars.GOMODCACHE = env.path.join(
      vars.GOPATH.split(env.platform === 'win32' ? ';' : ':')[0],
      'pkg/mod'
    );
  }
  const queries = [
    [
      'go',
      ['go', 'env', '-json', 'GOMODCACHE', 'GOCACHE'],
      ['GOMODCACHE', 'GOCACHE'],
    ],
    ['npm', ['npm', 'config', 'get', 'cache'], ['npm_config_cache']],
    ['pip', ['pip', 'cache', 'dir'], ['PIP_CACHE_DIR']],
    ['yarn', ['yarn', 'cache', 'dir'], ['YARN_CACHE_FOLDER']],
    ['pnpm', ['pnpm', 'store', 'path'], ['PNPM_STORE_DIR']],
  ];
  for (const [tool, argv, keys] of queries) {
    if (
      keys.every((key) => vars[key]) ||
      (tool === 'npm' && vars.NPM_CONFIG_CACHE) ||
      !(await env.which(tool))
    ) {
      continue;
    }
    const result = await env.run(argv, { timeoutMs: 5000 });
    if (result.code !== 0) {
      continue;
    }
    let values;
    try {
      values =
        tool === 'go'
          ? JSON.parse(result.stdout)
          : { [keys[0]]: result.stdout.trim().split('\n').at(-1) };
    } catch {
      continue;
    }
    applyQuery(vars, keys, values, env.path);
  }
}
