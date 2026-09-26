/**
 * Path helpers shared by the local and remote (container) environments.
 */

const globCache = new Map();

/**
 * Converts a basename glob (`*`, `?`, `[...]`) to a RegExp.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let cached = globCache.get(glob);
  if (!cached) {
    let source = '';
    for (const char of glob) {
      if (char === '*') {
        source += '[^/\\\\]*';
      } else if (char === '?') {
        source += '[^/\\\\]';
      } else if (char === '[' || char === ']') {
        source += char;
      } else {
        source += char.replace(/[.+^${}()|\\]/g, '\\$&');
      }
    }
    cached = new RegExp(`^${source}$`);
    globCache.set(glob, cached);
  }
  return cached;
}

/**
 * @param {string} name
 * @param {string} glob
 */
export function matchesGlob(name, glob) {
  return globToRegExp(glob).test(name);
}

/**
 * Whether `child` equals `parent` or lies below it.
 * @param {string} child
 * @param {string} parent
 * @param {{sep: string}} pathApi node:path flavour used by the environment
 */
export function isWithin(child, parent, pathApi) {
  if (!child || !parent) {
    return false;
  }
  const normalize = (value) =>
    pathApi.sep === '\\' ? value.toLowerCase() : value;
  const c = normalize(pathApi.resolve(child));
  const p = normalize(pathApi.resolve(parent));
  if (c === p) {
    return true;
  }
  const prefix = p.endsWith(pathApi.sep) ? p : p + pathApi.sep;
  return c.startsWith(prefix);
}

/**
 * Expands `~` and `{VAR}` tokens of a rule path for one home directory.
 * Returns null when a referenced variable is not set.
 * @param {string} pattern
 * @param {{home: string, vars?: Record<string,string|undefined>, pathApi: object}} context
 */
export function expandRulePath(pattern, { home, vars = {}, pathApi }) {
  let missing = false;
  let expanded = pattern.replace(/\{([A-Z_]+)\}/g, (_, name) => {
    const value = vars[name];
    if (!value) {
      missing = true;
      return '';
    }
    return value;
  });
  if (missing) {
    return null;
  }
  if (expanded === '~') {
    expanded = home;
  } else if (expanded.startsWith('~/')) {
    expanded = pathApi.join(home, expanded.slice(2));
  }
  return pathApi.normalize(expanded);
}

/**
 * Expands glob segments (`*`) in an absolute path by listing directories.
 * @param {object} env environment adapter
 * @param {string} pattern absolute path that may contain glob segments
 * @returns {Promise<string[]>}
 */
export async function expandGlobPath(env, pattern) {
  return (await expandGlobPaths(env, [pattern])).get(pattern) ?? [];
}

const GLOB_CHARS = /[*?[]/;

async function listDirs(env, dirs) {
  if (typeof env.listMany === 'function') {
    return env.listMany(dirs);
  }
  const listings = await Promise.all(dirs.map((dir) => env.list(dir)));
  return new Map(dirs.map((dir, index) => [dir, listings[index]]));
}

/**
 * Paths among `targets` that exist, checked in one batch when the
 * environment supports it.
 * @returns {Promise<Set<string>>}
 */
export async function existingPaths(env, targets) {
  if (typeof env.existsMany === 'function') {
    return env.existsMany(targets);
  }
  const flags = await Promise.all(targets.map((target) => env.exists(target)));
  return new Set(targets.filter((_, index) => flags[index]));
}

function globState(pathApi, pattern) {
  if (!GLOB_CHARS.test(pattern)) {
    return { pattern, segments: [], current: [pattern] };
  }
  const root = pathApi.parse(pattern).root;
  const segments = pattern
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  return { pattern, segments, current: [root] };
}

function advance(state, segment, listings, pathApi) {
  if (!GLOB_CHARS.test(segment)) {
    return state.current.map((base) => pathApi.join(base, segment));
  }
  return state.current.flatMap((base) =>
    (listings.get(base) ?? [])
      .filter((entry) => matchesGlob(entry.name, segment))
      .map((entry) => pathApi.join(base, entry.name))
  );
}

/**
 * Expands many absolute path patterns (glob segments allowed) with one
 * listing round per path depth and one existence check.
 * @param {object} env environment adapter
 * @param {string[]} patterns
 * @returns {Promise<Map<string, string[]>>} existing matches per pattern
 */
export async function expandGlobPaths(env, patterns) {
  const pathApi = env.path;
  const states = [...new Set(patterns)].map((p) => globState(pathApi, p));
  for (let step = 0; ; step++) {
    const active = states.filter(
      (state) => step < state.segments.length && state.current.length > 0
    );
    if (active.length === 0) {
      break;
    }
    const toList = new Set(
      active
        .filter((state) => GLOB_CHARS.test(state.segments[step]))
        .flatMap((state) => state.current)
    );
    const listings =
      toList.size > 0 ? await listDirs(env, [...toList]) : new Map();
    for (const state of active) {
      state.current = advance(state, state.segments[step], listings, pathApi);
    }
  }
  const existing = await existingPaths(env, [
    ...new Set(states.flatMap((state) => state.current)),
  ]);
  return new Map(
    states.map((state) => [
      state.pattern,
      state.current.filter((target) => existing.has(target)),
    ])
  );
}
