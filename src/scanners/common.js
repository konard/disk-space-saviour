/**
 * Helpers shared by scanners.
 *
 * Every scanner receives a context:
 * `{env, git, liveness, options, now}` where `options` holds the resolved
 * scan options (`staleAgeMs`, `inactiveMs`, `maxDepth`, `roots`, ...).
 */

/**
 * Lists many directories, batched when the environment supports it.
 * @returns {Promise<Map<string, object[]>>}
 */
export async function listMany(env, dirs) {
  if (typeof env.listMany === 'function') {
    return env.listMany(dirs);
  }
  const listings = new Map();
  for (const dir of dirs) {
    listings.set(dir, await env.list(dir));
  }
  return listings;
}

/**
 * Busy reason at scan time (recent writes, running tool, open files).
 * @returns {string|null}
 */
export async function scanTimeBusy(context, item) {
  await resolvePaths(context, item.paths);
  return context.liveness ? context.liveness.busyReason(item) : null;
}

/** Prime one batch before constructing items, so later per-item probes are cached. */
export async function resolvePaths(context, paths) {
  await context.liveness?.resolve(paths);
}

/**
 * Whether `now - timestamp` exceeds `windowMs` (unknown timestamps count as
 * recent, so they are never treated as abandoned).
 */
export function olderThan(context, timestamp, windowMs) {
  return Boolean(timestamp) && context.now - timestamp >= windowMs;
}
