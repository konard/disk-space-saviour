/**
 * Global per-user caches (ecosystem download and compilation caches, IDE and
 * browser caches), system package caches, and leftovers in temporary
 * directories. See ../rules/ecosystems.js and ../rules/other.js.
 */

import { CACHE_RULES } from '../rules/ecosystems.js';
import { OTHER_RULES } from '../rules/other.js';
import { block, makeItem } from '../items.js';
import { expandGlobPath, expandRulePath } from '../paths.js';
import { olderThan, scanTimeBusy } from './common.js';

export const GLOBAL_RULES = [...CACHE_RULES, ...OTHER_RULES];

function scopeBases(rule, homes, tmpDirs) {
  const scope = rule.scope ?? 'home';
  if (scope === 'tmp') {
    return tmpDirs.map((tmp) => ({ home: null, tmp }));
  }
  if (scope === 'system') {
    return [{ home: null, tmp: null }];
  }
  return homes.map((home) => ({ home, tmp: null }));
}

async function expandRule(env, rule, base) {
  const matches = [];
  for (const pattern of rule.paths) {
    const usesVars = /\{(?!TMP\})[A-Z_]+\}/.test(pattern);
    if (usesVars && base.home !== env.currentHome) {
      continue;
    }
    const expanded = expandRulePath(pattern, {
      home: base.home ?? '/',
      vars: { ...env.vars, TMP: base.tmp ?? undefined },
      pathApi: env.path,
    });
    if (expanded) {
      matches.push(...(await expandGlobPath(env, expanded)));
    }
  }
  return [...new Set(matches)];
}

/**
 * The tool's own clean command, when it can run for this cache.
 * @returns {Promise<{action: object|null, blocker: string|null}>}
 */
async function nativeAction(context, rule, base, paths) {
  const { env, options } = context;
  const native = rule.native;
  const removal = { type: 'remove', paths };
  if (!native || options.noNative) {
    return { action: removal, blocker: null };
  }
  const usable =
    (rule.scope === 'system' || base.home === env.currentHome) &&
    (await env.which(native.tool)) &&
    (!native.root || (await env.isRoot()));
  if (usable) {
    return {
      action: {
        type: 'command',
        argv: native.argv,
        measure: paths,
        fallback: native.required ? null : removal,
      },
      blocker: null,
    };
  }
  if (native.required) {
    return {
      action: null,
      blocker: `only \`${native.argv.join(' ')}\` can clean this safely, and it is unavailable`,
    };
  }
  return { action: removal, blocker: null };
}

function ageFilter(context, rule) {
  const { options } = context;
  if (rule.minAge === 'stale') {
    return (usage) =>
      olderThan(context, usage.newestMtimeMs, options.staleAgeMs);
  }
  if (rule.minAge === 'inactive') {
    return (usage) =>
      olderThan(context, usage.newestMtimeMs, options.inactiveMs);
  }
  return () => true;
}

async function buildItem(context, rule, base, group) {
  const { env } = context;
  const paths = group.map((entry) => entry.path);
  const { action, blocker } = await nativeAction(context, rule, base, paths);
  const scope = rule.scope ?? 'home';
  const item = makeItem(env, {
    rule: rule.id,
    kind: scope === 'tmp' ? 'leftover' : 'cache',
    ecosystem: rule.ecosystem,
    description: rule.description,
    path: paths[0],
    paths,
    bytes: group.reduce((sum, entry) => sum + entry.usage.bytes, 0),
    newestMtimeMs: Math.max(...group.map((e) => e.usage.newestMtimeMs ?? 0)),
    tier: rule.tier ?? 'safe',
    reason: rule.minAge
      ? `untouched for longer than the ${rule.minAge === 'stale' ? 'activity' : 'inactivity'} window`
      : 're-downloaded or re-created on demand',
    action: action ?? { type: 'none' },
    checks: {
      busy: rule.busy ?? [],
      cwd: scope === 'tmp' ? paths[0] : null,
      mtime: scope === 'tmp' || Boolean(rule.minAge),
    },
  });
  block(item, blocker);
  await addBlockers(context, rule, item);
  return item;
}

async function addBlockers(context, rule, item) {
  const { env, git } = context;
  if (rule.scope === 'system' && !(await env.isRoot())) {
    block(item, 'system location, run as root to clean it');
  }
  if (rule.git) {
    for (const target of item.paths) {
      const root = await git.findRepoRoot(target, target);
      for (const reason of root ? await git.repoBlockers(root) : []) {
        block(item, reason);
      }
    }
  }
  const busy = scanTimeBusy(context, item);
  if (busy) {
    block(item, `busy: ${busy}`);
  }
}

/**
 * Scans global cache and leftover locations.
 * @returns {Promise<object[]>} report items
 */
export async function scanGlobal(context, { rules = GLOBAL_RULES } = {}) {
  const { env, options } = context;
  const homes = options.homes ?? (await env.homeDirs());
  const tmpDirs = options.tmpDirs ?? (await env.tmpDirs());
  const found = [];
  const seen = new Set();
  for (const rule of rules) {
    for (const base of scopeBases(rule, homes, tmpDirs)) {
      const paths = (await expandRule(env, rule, base)).filter(
        (target) => !seen.has(target)
      );
      paths.forEach((target) => seen.add(target));
      if (paths.length > 0) {
        found.push({ rule, base, paths });
      }
    }
  }
  const usages = await env.usageMany(found.flatMap((entry) => entry.paths));
  const items = [];
  for (const { rule, base, paths } of found) {
    const accept = ageFilter(context, rule);
    const measured = paths
      .map((target) => ({ path: target, usage: usages.get(target) }))
      .filter((entry) => entry.usage && accept(entry.usage));
    const groups = rule.aggregate
      ? [measured]
      : measured.map((entry) => [entry]);
    for (const group of groups.filter((g) => g.length > 0)) {
      items.push(await buildItem(context, rule, base, group));
    }
  }
  return items;
}
