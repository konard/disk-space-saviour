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
  const pathApi = env.path;
  if (!/[*?[]/.test(pattern)) {
    return (await env.exists(pattern)) ? [pattern] : [];
  }
  const root = pathApi.parse(pattern).root;
  const segments = pattern
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = [root];
  for (const segment of segments) {
    const next = [];
    for (const base of current) {
      if (/[*?[]/.test(segment)) {
        const entries = await env.list(base);
        for (const entry of entries) {
          if (matchesGlob(entry.name, segment)) {
            next.push(pathApi.join(base, entry.name));
          }
        }
      } else {
        next.push(pathApi.join(base, segment));
      }
    }
    current = next;
    if (current.length === 0) {
      return [];
    }
  }
  const existing = [];
  for (const candidate of current) {
    if (await env.exists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}
