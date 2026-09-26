/**
 * Report item model shared by scanners, cleaner, emergency mode and output.
 *
 * An item is one reclaimable thing: a directory, a set of stale files, a
 * native clean command, or a Docker object. Items with `blockers` are
 * reported but never acted on. Items with `requiresConfirmation` need the
 * named flag (or an interactive yes) on top of their tier being selected.
 */

export const TIERS = ['safe', 'moderate', 'aggressive'];

/**
 * @param {string} tier
 * @returns {number} 0 for safe, 1 for moderate, 2 for aggressive
 */
export function tierRank(tier) {
  const rank = TIERS.indexOf(tier);
  if (rank === -1) {
    throw new Error(`Unknown tier: ${tier} (expected ${TIERS.join(', ')})`);
  }
  return rank;
}

/**
 * Creates an item with defaults filled in.
 * @param {{id: string, label: string}} env
 * @param {object} fields
 */
export function makeItem(env, fields) {
  const paths = fields.paths ?? (fields.path ? [fields.path] : []);
  const item = {
    id: `${env.id}:${fields.rule}:${fields.path ?? fields.target ?? paths[0] ?? ''}`,
    env: env.id,
    envLabel: env.label,
    kind: 'cache',
    ecosystem: 'other',
    rule: 'unknown',
    description: '',
    path: paths[0] ?? null,
    bytes: 0,
    newestMtimeMs: 0,
    tier: 'safe',
    reason: '',
    blockers: [],
    requiresConfirmation: null,
    parentId: null,
    checks: { busy: [], cwd: null, mtime: true },
    ...fields,
  };
  item.paths = paths;
  item.action ??= { type: 'remove', paths };
  return item;
}

/**
 * Adds a blocker reason to an item (idempotent).
 */
export function block(item, reason) {
  if (reason && !item.blockers.includes(reason)) {
    item.blockers.push(reason);
  }
  return item;
}

/**
 * Totals per tier. Each tier total includes the lower tiers, and nested
 * items (whose parent is also counted) are not double counted.
 * @param {object[]} items
 */
export function tierTotals(items) {
  const totals = {};
  for (const tier of TIERS) {
    const selected = selectByTier(items, tier);
    totals[tier] = {
      items: selected.length,
      bytes: selected.reduce((sum, item) => sum + item.bytes, 0),
    };
  }
  totals.blocked = {
    items: items.filter((item) => item.blockers.length > 0).length,
    bytes: items
      .filter((item) => item.blockers.length > 0)
      .reduce((sum, item) => sum + item.bytes, 0),
  };
  return totals;
}

function parentPath(target) {
  let end = target.length;
  while (end > 0 && (target[end - 1] === '/' || target[end - 1] === '\\')) {
    end--;
  }
  const trimmed = target.slice(0, end);
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index > 0 ? trimmed.slice(0, index) : null;
}

/**
 * Drops items contained in another item of the same environment: by
 * `parentId`, or because every path lies below another item's path.
 * @param {object[]} items
 */
export function dropNested(items) {
  const ids = new Set(items.map((item) => item.id));
  const paths = new Set(
    items
      .filter((item) => item.action?.type === 'remove')
      .flatMap((item) => item.paths.map((p) => `${item.env}\0${p}`))
  );
  const inside = (item, target) => {
    for (let dir = parentPath(target); dir; dir = parentPath(dir)) {
      if (paths.has(`${item.env}\0${dir}`)) {
        return true;
      }
    }
    return false;
  };
  return items.filter(
    (item) =>
      !(item.parentId && ids.has(item.parentId)) &&
      !(item.paths.length > 0 && item.paths.every((p) => inside(item, p)))
  );
}

/**
 * Items at or below `maxTier` without blockers, dropping items nested in
 * another selected item.
 * @param {object[]} items
 * @param {string} maxTier
 * @param {(item: object) => boolean} [accept] extra filter
 */
export function selectByTier(items, maxTier, accept = () => true) {
  const rank = tierRank(maxTier);
  return dropNested(
    items.filter(
      (item) =>
        tierRank(item.tier) <= rank &&
        item.blockers.length === 0 &&
        accept(item)
    )
  );
}
