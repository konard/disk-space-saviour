/**
 * `emergency({free, until})`: frees space tier by tier (safe, moderate,
 * aggressive), re-reading the filesystem after every removal and stopping
 * as soon as the goal is met.
 *
 * - `free: '20G'`: at least 20 GiB available on the target volume;
 * - `until: '80%'`: at most 80% of the target volume used.
 *
 * Within a tier, caches inside containers and on the host go first, Docker
 * objects next, and stopped containers last, and those only with operator
 * approval (`removeStoppedContainers` or an interactive yes).
 */

import { startAudit, writeAudit } from './audit.js';
import { Cleaner, cleanOrder, finishAudit, wantedItems } from './clean.js';
import { LocalEnv } from './env/local.js';
import { TIERS, selectByTier, tierRank } from './items.js';
import { resolveGoal, resolveOptions } from './options.js';
import { revalidateReport, scan } from './scan.js';

/**
 * Used percentage the way `df` prints it: used / (used + available).
 */
export function usedPercent(disk) {
  const total = disk.used + disk.free;
  return total > 0 ? (disk.used / total) * 100 : 0;
}

/**
 * Whether `disk` satisfies `goal`.
 */
export function goalMet(goal, disk) {
  return (
    (goal.freeBytes === null || disk.free >= goal.freeBytes) &&
    (goal.untilPercent === null || usedPercent(disk) <= goal.untilPercent)
  );
}

/**
 * Bytes still to free for `goal` on `disk` (0 when met).
 */
export function bytesNeeded(goal, disk) {
  const total = disk.used + disk.free;
  const forFree =
    goal.freeBytes === null ? 0 : Math.max(0, goal.freeBytes - disk.free);
  const forPercent =
    goal.untilPercent === null
      ? 0
      : Math.max(0, disk.used - (goal.untilPercent / 100) * total);
  return Math.ceil(Math.max(forFree, forPercent));
}

async function readDisk(env, target) {
  const disk = await env.diskUsage(target);
  if (!disk) {
    throw new Error(`cannot read the free space of ${target}`);
  }
  return disk;
}

function simulated(disk, freed) {
  return { ...disk, free: disk.free + freed, used: disk.used - freed };
}

/**
 * @param {object} input options (see ./options.js) plus `free`, `until`,
 *   `path` (volume to watch, `/` by default), `report` (reuse a scan),
 *   `dryRun`, `confirm`, `env`, `audit: false`
 * @returns {Promise<object>} audit log with `goalMet`, `diskBefore`,
 *   `diskAfter`
 */
export async function emergency(input = {}) {
  const goal = resolveGoal(input);
  const options = resolveOptions({
    ...input,
    tier: input.tier ?? 'aggressive',
  });
  const env = input.env ?? new LocalEnv();
  const target =
    input.path ?? (env.platform === 'win32' ? env.currentHome : '/');
  const diskBefore = await readDisk(env, target);
  const audit = startAudit('emergency', {
    dryRun: Boolean(input.dryRun),
    goal,
    path: target,
    diskBefore,
    bytesNeeded: bytesNeeded(goal, diskBefore),
  });
  const report = input.report
    ? await revalidateReport(input.report, { ...input, env })
    : await scan({ ...input, env });
  audit.report = { createdAt: report.createdAt, totals: report.totals };
  if (options.audit !== false) {
    await writeAudit(audit, { ...options, inProgress: true });
  }
  let disk = diskBefore;
  if (!goalMet(goal, disk)) {
    disk = await escalate({ report, options, env, target, goal, audit });
  }
  audit.diskAfter = disk;
  audit.goalMet = goalMet(goal, disk);
  return finishAudit(audit, report, options);
}

async function escalate({ report, options, env, target, goal, audit }) {
  const persistProgress = async (entry) => {
    if (!audit.entries.includes(entry)) {
      audit.entries.push(entry);
    }
    if (options.audit !== false) {
      await writeAudit(audit, { ...options, inProgress: true });
    }
  };
  const cleaner = new Cleaner(report, {
    ...options,
    env,
    onProgress: persistProgress,
  });
  const done = new Set();
  const targetDevice = await env.deviceId?.(target);
  const scoped = await Promise.all(
    wantedItems(report, options).map(async (item) => {
      if (targetDevice === undefined) {
        return item;
      }
      if (item.env !== env.id) {
        return null;
      }
      const location = item.action?.volume ?? item.paths?.[0];
      if (!location || !env.path.isAbsolute(location)) {
        return null;
      }
      return (await env.deviceId(location)) === targetDevice ? item : null;
    })
  );
  const wanted = scoped.filter(Boolean);
  let disk = audit.diskBefore;
  let freed = 0;
  for (const tier of TIERS.slice(0, tierRank(options.tier) + 1)) {
    audit.reachedTier = tier;
    const items = selectByTier(wanted, tier)
      .filter((item) => !done.has(item.id))
      .sort(cleanOrder);
    for (const item of items) {
      done.add(item.id);
      const entry = await cleaner.process(item);
      if (!audit.entries.includes(entry)) {
        audit.entries.push(entry);
      }
      options.onEntry?.(entry, item);
      if (options.audit !== false) {
        await writeAudit(audit, { ...options, inProgress: true });
      }
      if (entry.status !== 'removed' && entry.status !== 'planned') {
        continue;
      }
      freed += entry.status === 'planned' ? entry.plannedBytes : 0;
      disk = options.dryRun
        ? simulated(audit.diskBefore, freed)
        : await readDisk(env, target);
      if (goalMet(goal, disk)) {
        return disk;
      }
    }
  }
  return disk;
}
