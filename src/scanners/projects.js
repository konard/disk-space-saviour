/**
 * Per-project dependency, build and cache directories (node_modules, target,
 * .venv, ...) found by walking the scan roots.
 *
 * A directory matches a rule when its name matches and the rule's markers
 * are present. Generic names (`build`, `lib`, `target`, `bin`) that fail
 * every rule are searched again below, with the remaining depth, so a
 * non-matching `build` directory never hides real projects inside it.
 *
 * Cargo `target` directories stay intact: build timestamps do not prove that
 * a feature or profile variant can be deleted safely.
 */

import { ECOSYSTEMS, PROJECT_RULES } from '../rules/ecosystems.js';
import { block, makeItem } from '../items.js';
import { isWithin, matchesGlob } from '../paths.js';
import { listMany, olderThan, scanTimeBusy } from './common.js';

const ECOSYSTEM_NAMES = new Map(ECOSYSTEMS.map((e) => [e.id, e.name]));

function anyMatch(entries, globs) {
  return (entries ?? []).some((entry) =>
    globs.some((glob) => matchesGlob(entry.name, glob))
  );
}

function depthBelow(env, roots, target) {
  const root = roots
    .filter((candidate) => isWithin(target, candidate, env.path))
    .sort((a, b) => b.length - a.length)[0];
  return env.path.relative(root, target).split(/[\\/]/).filter(Boolean).length;
}

function ruleAccepts(env, rule, candidate, selfListing, grandListing) {
  if (rule.markers && !anyMatch(candidate.siblings, rule.markers)) {
    return false;
  }
  if (rule.selfMarkers && !anyMatch(selfListing, rule.selfMarkers)) {
    return false;
  }
  if (rule.parentName) {
    if (env.path.basename(candidate.parent) !== rule.parentName) {
      return false;
    }
    if (rule.parentMarkers && !anyMatch(grandListing, rule.parentMarkers)) {
      return false;
    }
  }
  if (
    rule.lockfiles &&
    !anyMatch(
      rule.parentName ? grandListing : candidate.siblings,
      rule.lockfiles
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Pairs every found directory with the first rule it satisfies (or null).
 */
async function matchRules(env, found, rules) {
  const options = found.map((candidate) => ({
    candidate,
    rules: rules.filter((rule) =>
      rule.names.some((glob) => matchesGlob(candidate.name, glob))
    ),
  }));
  const selfDirs = options
    .filter((o) => o.rules.some((rule) => rule.selfMarkers))
    .map((o) => o.candidate.path);
  const grandDirs = options
    .filter((o) =>
      o.rules.some(
        (rule) => rule.parentName === env.path.basename(o.candidate.parent)
      )
    )
    .map((o) => env.path.dirname(o.candidate.parent));
  const selfListings = await listMany(env, selfDirs);
  const grandListings = await listMany(env, [...new Set(grandDirs)]);
  return options.map(({ candidate, rules: possible }) => ({
    candidate,
    rule:
      possible.find((rule) =>
        ruleAccepts(
          env,
          rule,
          candidate,
          selfListings.get(candidate.path),
          grandListings.get(env.path.dirname(candidate.parent))
        )
      ) ?? null,
  }));
}

async function rootCandidates(env, roots) {
  const candidates = [];
  for (const root of roots) {
    const parent = env.path.dirname(root);
    if (parent === root) {
      continue;
    }
    const siblings = await env.list(parent);
    candidates.push({
      path: root,
      name: env.path.basename(root),
      parent,
      siblings,
    });
  }
  return candidates;
}

/**
 * Finds every rule match below the roots.
 * @returns {Promise<Array<{candidate: object, rule: object}>>}
 */
export async function findProjectDirs(env, roots, options = {}) {
  const rules = options.rules ?? PROJECT_RULES;
  const maxDepth = options.maxDepth ?? 6;
  const globs = [...new Set(rules.flatMap((rule) => rule.names))];
  const matches = [];
  if (options.includeRoots) {
    const self = await matchRules(env, await rootCandidates(env, roots), rules);
    matches.push(...self.filter((match) => match.rule));
  }
  let frontier = new Map([[maxDepth, roots]]);
  while (frontier.size > 0) {
    const next = new Map();
    for (const [depth, dirs] of frontier) {
      const found = await env.findDirs(dirs, { globs, maxDepth: depth });
      for (const match of await matchRules(env, found, rules)) {
        if (match.rule) {
          matches.push(match);
          continue;
        }
        const remaining = depth - depthBelow(env, dirs, match.candidate.path);
        if (remaining > 0) {
          next.set(remaining, [
            ...(next.get(remaining) ?? []),
            match.candidate.path,
          ]);
        }
      }
    }
    frontier = next;
  }
  return matches;
}

function siblingActivity(candidate, globs) {
  return (candidate.siblings ?? [])
    .filter(
      (entry) =>
        entry.name !== candidate.name &&
        !globs.some((glob) => matchesGlob(entry.name, glob))
    )
    .reduce((newest, entry) => Math.max(newest, entry.mtimeMs ?? 0), 0);
}

function projectTier(context, rule, lastActivityMs) {
  if (rule.kind === 'cache') {
    return { tier: 'safe', reason: 'cache, re-created on demand' };
  }
  const { inactiveMs } = context.options;
  if (olderThan(context, lastActivityMs, inactiveMs)) {
    return {
      tier: 'moderate',
      reason: 'project inactive, re-created by the build or install step',
    };
  }
  return {
    tier: 'aggressive',
    reason: 'project recently active, re-created by the build or install step',
  };
}

async function addBlockers(context, item, requireClean) {
  for (const reason of await context.git.pathBlockers(item.path, {
    requireClean,
  })) {
    block(item, reason);
  }
  const busy = scanTimeBusy(context, item);
  if (busy) {
    block(item, `busy: ${busy}`);
  }
}

async function projectActivity(context, project, candidate, usage, globs) {
  const { env, git } = context;
  const repo = await git.findRepoRoot(project);
  const lastCommitMs = repo ? (await git.repoState(repo)).lastCommitMs : 0;
  context.projectUsage ??= new Map();
  if (!context.projectUsage.has(project)) {
    context.projectUsage.set(project, await env.usage(project));
  }
  const projectUsage = context.projectUsage.get(project);
  return Math.max(
    usage?.newestMtimeMs ?? 0,
    projectUsage?.newestMtimeMs ?? 0,
    siblingActivity(candidate, globs),
    lastCommitMs
  );
}

async function projectItem(context, { candidate, rule }, usage, globs) {
  const { env, options } = context;
  const project = rule.parentName
    ? env.path.dirname(candidate.parent)
    : candidate.parent;
  const lastActivityMs = await projectActivity(
    context,
    project,
    candidate,
    usage,
    globs
  );
  const item = makeItem(env, {
    rule: rule.id,
    kind: rule.kind,
    ecosystem: rule.ecosystem,
    description: `${ECOSYSTEM_NAMES.get(rule.ecosystem)} ${rule.description}`,
    path: candidate.path,
    bytes: usage?.bytes ?? 0,
    newestMtimeMs: usage?.newestMtimeMs ?? 0,
    lastActivityMs,
    project,
    lockfiles: rule.lockfiles ?? null,
    ...projectTier(context, rule, lastActivityMs),
    checks: { busy: rule.busy ?? [], cwd: project, mtime: true },
  });
  await addBlockers(
    context,
    item,
    item.tier !== 'safe' && !options.allowDirtyRepos
  );
  return item;
}

/**
 * Scans project trees below `context.options.roots`.
 * @returns {Promise<object[]>} report items
 */
export async function scanProjects(context, { rules = PROJECT_RULES } = {}) {
  const { env, options } = context;
  const matches = await findProjectDirs(env, options.roots, {
    rules,
    maxDepth: options.maxDepth,
    includeRoots: options.includeRoots,
  });
  const usages = await env.usageMany(matches.map((m) => m.candidate.path));
  const globs = [...new Set(rules.flatMap((rule) => rule.names))];
  const items = [];
  for (const match of matches) {
    const usage = usages.get(match.candidate.path);
    if (!usage) {
      continue;
    }
    const item = await projectItem(context, match, usage, globs);
    items.push(item);
  }
  return items;
}
