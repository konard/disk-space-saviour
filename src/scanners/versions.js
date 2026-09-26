/**
 * Toolchain versions installed by version managers (nvm, pyenv, rbenv,
 * SDKMAN!, rustup, elan, ghcup, opam, swiftly, VS Code Server).
 *
 * Kept: the manager's default and alias targets, versions pinned by any
 * project below the scan roots, the newest install of each group, and
 * anything a running process executes from (checked by the liveness probe).
 * Everything else is reported as `moderate`.
 */

import {
  VERSION_RULES,
  compareVersions,
  versionMatches,
} from '../rules/versions.js';
import { block, makeItem } from '../items.js';
import { expandGlobPath, expandRulePath } from '../paths.js';
import { scanTimeBusy } from './common.js';

async function installDirs(env, rule, home) {
  const dirs = [];
  for (const pattern of rule.dirs) {
    const expanded = expandRulePath(pattern, { home, pathApi: env.path });
    for (const candidate of await expandGlobPath(env, expanded)) {
      const name = env.path.basename(candidate);
      if ((rule.exclude ?? []).includes(name)) {
        continue;
      }
      if ((await env.stat(candidate))?.type !== 'dir') {
        continue;
      }
      if (
        rule.selfMarker &&
        !(await env.exists(env.path.join(candidate, rule.selfMarker)))
      ) {
        continue;
      }
      dirs.push(candidate);
    }
  }
  return dirs;
}

async function aliasRefs(env, aliasDir) {
  const refs = [];
  const pending = [aliasDir];
  while (pending.length > 0) {
    for (const entry of await env.list(pending.shift())) {
      if (entry.type === 'dir') {
        pending.push(entry.path);
      } else {
        refs.push(
          ...((await env.readText(entry.path, 4096)) ?? '').split(/\s+/)
        );
      }
    }
  }
  return refs.filter(Boolean);
}

function linkRefs(target) {
  if (!target) {
    return [];
  }
  const refs = [target.split(/[\\/]/).filter(Boolean).pop()];
  const inside = /(?:^|\/)ghc\/([^/]+)\/bin/.exec(target);
  if (inside) {
    refs.push(inside[1]);
  }
  return refs;
}

/**
 * Versions a manager itself marks as default, aliased or current.
 * @returns {Promise<string[]>}
 */
async function managerRefs(env, rule, home, installs) {
  const expand = (pattern) =>
    expandRulePath(pattern, { home, pathApi: env.path });
  const refs = [];
  for (const source of rule.defaults ?? []) {
    const text = await env.readText(expand(source.path), 65536);
    refs.push(...source.parse(text));
  }
  if (rule.aliasDir) {
    refs.push(...(await aliasRefs(env, expand(rule.aliasDir))));
  }
  for (const link of rule.defaultLinks ?? []) {
    refs.push(...linkRefs(await env.readLink(expand(link))));
  }
  if (rule.currentLink) {
    const parents = new Set(installs.map((dir) => env.path.dirname(dir)));
    for (const parent of parents) {
      const target = await env.readLink(
        env.path.join(parent, rule.currentLink)
      );
      const name = linkRefs(target)[0];
      if (name) {
        refs.push(rule.versionOf(env.path.join(parent, name)));
      }
    }
  }
  return refs.filter(Boolean);
}

/**
 * Versions pinned by project files (`.nvmrc`, `rust-toolchain.toml`, ...)
 * below the roots, per rule id.
 * @returns {Promise<Map<string, string[]>>}
 */
export async function projectPins(env, roots, rules, maxDepth) {
  const byName = new Map();
  for (const rule of rules) {
    for (const [name, parse] of Object.entries(rule.projectFiles ?? {})) {
      byName.set(name, [...(byName.get(name) ?? []), { rule, parse }]);
    }
  }
  const pins = new Map(rules.map((rule) => [rule.id, []]));
  if (byName.size === 0 || roots.length === 0) {
    return pins;
  }
  const files = await env.findFiles(roots, {
    names: [...byName.keys()],
    maxDepth,
  });
  const heads = await env.readHeads(files, 16384);
  for (const file of files) {
    for (const { rule, parse } of byName.get(env.path.basename(file)) ?? []) {
      pins.get(rule.id).push(...parse(heads.get(file)).filter(Boolean));
    }
  }
  return pins;
}

function newestInstalls(env, rule, installs, usages) {
  const groups = new Map();
  for (const dir of installs) {
    const parent = env.path.dirname(dir);
    groups.set(parent, [...(groups.get(parent) ?? []), dir]);
  }
  const newest = new Set();
  const versionOf = rule.versionOf ?? ((dir) => env.path.basename(dir));
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) =>
      rule.newestBy === 'mtime'
        ? (usages.get(b)?.newestMtimeMs ?? 0) -
          (usages.get(a)?.newestMtimeMs ?? 0)
        : compareVersions(versionOf(b), versionOf(a))
    );
    newest.add(sorted[0]);
  }
  return newest;
}

async function ruleItems(context, rule, home, pins) {
  const { env } = context;
  const installs = await installDirs(env, rule, home);
  if (installs.length < 2) {
    return [];
  }
  const refs = [...(await managerRefs(env, rule, home, installs)), ...pins];
  const usages = await env.usageMany(installs);
  const newest = newestInstalls(env, rule, installs, usages);
  const versionOf = rule.versionOf ?? ((dir) => env.path.basename(dir));
  const items = [];
  for (const dir of installs) {
    const version = versionOf(dir);
    if (newest.has(dir) || refs.some((ref) => versionMatches(version, ref))) {
      continue;
    }
    const usage = usages.get(dir);
    const item = makeItem(env, {
      rule: rule.id,
      kind: 'toolchain',
      ecosystem: rule.ecosystem,
      description: `${rule.description} ${version}`,
      path: dir,
      bytes: usage?.bytes ?? 0,
      newestMtimeMs: usage?.newestMtimeMs ?? 0,
      tier: 'moderate',
      reason: `not the ${rule.manager} default, not pinned by a scanned project, not the newest`,
      checks: { busy: rule.busy ?? [], cwd: dir, mtime: true },
    });
    const busy = scanTimeBusy(context, item);
    if (busy) {
      block(item, `busy: ${busy}`);
    }
    items.push(item);
  }
  return items;
}

/**
 * Scans version manager installs.
 * @returns {Promise<object[]>} report items
 */
export async function scanVersions(context, { rules = VERSION_RULES } = {}) {
  const { env, options } = context;
  const homes = options.homes ?? (await env.homeDirs());
  const pins = await projectPins(
    env,
    options.roots ?? [],
    rules,
    options.maxDepth ?? 6
  );
  const items = [];
  for (const rule of rules) {
    for (const home of homes) {
      items.push(...(await ruleItems(context, rule, home, pins.get(rule.id))));
    }
  }
  return items;
}
