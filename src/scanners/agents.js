/**
 * Snapshot stores of AI coding agents built on the opencode storage layout
 * (`@link-assistant/agent`, opencode).
 *
 * `<data>/snapshot/<projectId>/` is a bare Git object store with a full copy
 * of the project's worktree, keyed by the project's root commit.
 * `<data>/storage/project/<projectId>.json` records the project's
 * `worktree`. Tasks that run the agent in throwaway checkouts leave one
 * store per checkout behind (link-assistant/hive-mind#2186).
 *
 * - worktree recorded and gone: retained because the snapshot may be the only
 *   remaining copy of uncommitted work;
 * - no project record and idle for the activity window: `moderate`;
 * - worktree still present: kept;
 * - the newest store is always kept.
 *
 * Running agents do not block: a store is only written by the agent working
 * in its worktree, so recent writes and open files are the liveness signal
 * (the same rule the agent's own `Project.prune()` uses).
 */

import { block, makeItem } from '../items.js';
import { listMany, olderThan, scanTimeBusy } from './common.js';

export const AGENT_APPS = [
  { id: 'link-assistant-agent', name: '@link-assistant/agent' },
  { id: 'opencode', name: 'opencode' },
];

function dataDirs(env, home) {
  const dirs = [env.path.join(home, '.local', 'share')];
  const xdg = env.vars?.XDG_DATA_HOME;
  if (home === env.currentHome && xdg && !dirs.includes(xdg)) {
    dirs.push(xdg);
  }
  return dirs;
}

/**
 * Reads the recorded worktree from a project record.
 * @returns {string|null}
 */
export function recordedWorktree(text) {
  try {
    const worktree = JSON.parse(text ?? '').worktree;
    return typeof worktree === 'string' && worktree ? worktree : null;
  } catch {
    return null;
  }
}

async function snapshotStates(env, root) {
  const snapshotDir = env.path.join(root, 'snapshot');
  const projectDir = env.path.join(root, 'storage', 'project');
  const listings = await listMany(env, [snapshotDir, projectDir]);
  const stores = (listings.get(snapshotDir) ?? []).filter(
    (entry) => entry.type === 'dir'
  );
  if (stores.length === 0) {
    return [];
  }
  const records = new Set(
    (listings.get(projectDir) ?? []).map((entry) => entry.name)
  );
  const recordPath = (id) => env.path.join(projectDir, `${id}.json`);
  const heads = await env.readHeads(
    stores
      .filter((entry) => records.has(`${entry.name}.json`))
      .map((entry) => recordPath(entry.name)),
    65536
  );
  const states = [];
  for (const entry of stores) {
    const record = heads.get(recordPath(entry.name));
    const worktree = record === undefined ? null : recordedWorktree(record);
    states.push({
      entry,
      hasRecord: record !== undefined,
      worktree,
      worktreeExists: worktree ? await env.exists(worktree) : false,
    });
  }
  return states;
}

function classify(context, state, usage) {
  if (state.worktreeExists) {
    return null;
  }
  if (state.hasRecord && state.worktree) {
    return null;
  }
  if (olderThan(context, usage.newestMtimeMs, context.options.staleAgeMs)) {
    return {
      tier: 'moderate',
      reason: 'no project record points at this store and it is idle',
    };
  }
  return null;
}

async function appItems(context, app, root) {
  const { env } = context;
  const states = await snapshotStates(env, root);
  if (states.length === 0) {
    return [];
  }
  const usages = await env.usageMany(states.map((s) => s.entry.path));
  const newest = states
    .map((state) => ({
      state,
      mtimeMs: usages.get(state.entry.path)?.newestMtimeMs ?? 0,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0].state;
  const items = [];
  for (const state of states) {
    const usage = usages.get(state.entry.path);
    const verdict =
      state === newest || !usage ? null : classify(context, state, usage);
    if (!verdict) {
      continue;
    }
    const item = makeItem(env, {
      rule: 'agent-snapshot',
      kind: 'agent-state',
      ecosystem: 'agents',
      description: `${app.name} snapshot store ${state.entry.name}`,
      path: state.entry.path,
      bytes: usage.bytes,
      newestMtimeMs: usage.newestMtimeMs,
      worktree: state.worktree,
      ...verdict,
      checks: { busy: [], cwd: null, mtime: true },
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
 * Scans agent snapshot stores of every home.
 * @returns {Promise<object[]>} report items
 */
export async function scanAgents(context, { apps = AGENT_APPS } = {}) {
  const { env, options } = context;
  const homes = options.homes ?? (await env.homeDirs());
  const items = [];
  const seen = new Set();
  for (const home of homes) {
    for (const dataDir of dataDirs(env, home)) {
      for (const app of apps) {
        const root = env.path.join(dataDir, app.id);
        if (seen.has(root)) {
          continue;
        }
        seen.add(root);
        items.push(...(await appItems(context, app, root)));
      }
    }
  }
  return items;
}
