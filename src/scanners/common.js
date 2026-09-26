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
export function scanTimeBusy(context, item) {
  return context.liveness ? context.liveness.busyReason(item) : null;
}

/**
 * Whether `now - timestamp` exceeds `windowMs` (unknown timestamps count as
 * recent, so they are never treated as abandoned).
 */
export function olderThan(context, timestamp, windowMs) {
  return Boolean(timestamp) && context.now - timestamp >= windowMs;
}
