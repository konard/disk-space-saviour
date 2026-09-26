/**
 * `clean(report, options) → AuditLog`: acts on the items of a report.
 *
 * Before touching an item the cleaner re-checks it against the live
 * system: it re-measures the paths, refreshes the process and open-file
 * probe, re-runs the Git checks and, for superseded Rust artifacts,
 * re-derives which hashes are superseded. Stopped containers are
 * re-inspected (still stopped, not restarted since the scan, Git state
 * still clean) and their logs and inspect data are saved before a plain
 * `docker rm`. Every decision lands in the audit log.
 */

import { once } from 'node:events';
import { createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import { backupDirectory, startAudit, writeAudit } from './audit.js';
import { DockerCli, assertAllowed, parseDockerSize } from './docker/cli.js';
import {
  containerGitState,
  gitBlockersForRemoval,
  runningBindMounts,
} from './docker/containers.js';
import { resolveEnvironment } from './env/resolve.js';
import { GitInspector } from './git.js';
import { dropNested, selectByTier, tierRank } from './items.js';
import { LivenessProbe } from './liveness.js';
import { resolveOptions } from './options.js';
import { isWithin } from './paths.js';
import { OTHER_RULES } from './rules/other.js';
import { compareVersions } from './rules/versions.js';
import { filterItems, revalidateReport } from './scan.js';

const STOPPED = new Set(['exited', 'created', 'dead']);
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const KIND_ORDER = ['cache', 'leftover', 'build', 'agent-state', 'package'];

/**
 * Cleaning order: tier first, then caches and leftovers before project
 * dependencies, Docker objects, and stopped containers last; larger first.
 */
export function cleanOrder(a, b) {
  const rank = (item) => {
    if (item.kind === 'container') {
      return 4;
    }
    if (item.kind === 'docker') {
      return 3;
    }
    return KIND_ORDER.includes(item.kind) ? 1 : 2;
  };
  return (
    tierRank(a.tier) - tierRank(b.tier) ||
    rank(a) - rank(b) ||
    b.bytes - a.bytes
  );
}

function flagName(key) {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function sumBytes(usages) {
  let total = 0;
  for (const usage of usages.values()) {
    total += usage?.bytes ?? 0;
  }
  return total;
}

function entryFor(item) {
  return {
    id: item.id,
    env: item.env,
    envLabel: item.envLabel,
    rule: item.rule,
    tier: item.tier,
    kind: item.kind,
    description: item.description,
    path: item.path,
    paths: [...item.paths],
    pathCount: item.paths.length,
    deletedPaths: [],
    action: item.action?.type ?? 'none',
    plannedBytes: item.bytes,
    status: 'skipped',
    reason: null,
    freedBytes: 0,
    durationMs: 0,
  };
}

async function browserRevisionBlocker(env, item) {
  const rule = OTHER_RULES.find((candidate) => candidate.id === item.rule);
  if (!rule?.versionPattern) {
    return null;
  }
  for (const target of item.paths) {
    const parent = env.path.dirname(target);
    const match = rule.versionPattern.exec(env.path.basename(target));
    if (!match) {
      return `cannot verify browser revision ${target}`;
    }
    const siblings = await env.list(parent);
    const newer = siblings.some((entry) => {
      const other = rule.versionPattern.exec(entry.name);
      return (
        entry.type === 'dir' &&
        other &&
        other.groups.family === match.groups.family &&
        compareVersions(other.groups.version, match.groups.version) > 0
      );
    });
    if (!newer) {
      return `${target} is now the newest installed browser revision`;
    }
  }
  return null;
}

export class Cleaner {
  /**
   * @param {object} report output of `scan()`
   * @param {object} options resolved options plus `confirm`, `dryRun`, `env`
   */
  constructor(report, options) {
    this.report = report;
    this.options = options;
    this.contexts = new Map();
    this.descriptors = new Map(
      (report.environments ?? []).map((env) => [env.id, env])
    );
    this.backupRoot = path.join(
      backupDirectory(options),
      new Date(options.now()).toISOString().replace(/[:.]/g, '-')
    );
  }

  context(envId) {
    if (!this.contexts.has(envId)) {
      const descriptor = this.descriptors.get(envId) ?? {
        id: envId,
        chain: [],
      };
      const { env, executor } = resolveEnvironment(descriptor, this.options);
      this.contexts.set(envId, {
        env,
        executor,
        git: new GitInspector(env),
        liveness: new LivenessProbe(env, {
          staleAgeMs: this.options.staleAgeMs,
          now: this.options.now,
        }),
      });
    }
    return this.contexts.get(envId);
  }

  /**
   * Processes one item and returns its audit entry.
   */
  async process(item) {
    const started = Date.now();
    const entry = entryFor(item);
    try {
      await this.#process(item, entry);
    } catch (error) {
      entry.status = 'failed';
      entry.reason = error.message;
    }
    entry.durationMs = Date.now() - started;
    return entry;
  }

  async #process(item, entry) {
    if (item.blockers.length > 0) {
      entry.reason = item.blockers.join('; ');
      return;
    }
    if (!(await this.#confirmed(item))) {
      entry.reason = `needs ${flagName(item.requiresConfirmation)} or an interactive yes`;
      return;
    }
    const ctx = this.context(item.env);
    const fresh = await this.#recheck(ctx, item);
    if (fresh.reason) {
      entry.reason = fresh.reason;
      return;
    }
    entry.plannedBytes = fresh.item.bytes;
    entry.paths = [...fresh.item.paths];
    entry.pathCount = fresh.item.paths.length;
    if (this.options.dryRun) {
      entry.status = 'planned';
      return;
    }
    await this.#execute(ctx, fresh.item, entry);
  }

  async #confirmed(item) {
    const flag = item.requiresConfirmation;
    if (!flag || this.options[flag]) {
      return true;
    }
    return this.options.confirm
      ? Boolean(await this.options.confirm(item))
      : false;
  }

  async #recheck(ctx, item) {
    const type = item.action?.type;
    if (type === 'docker-rm') {
      const git = await containerGitState(
        new DockerCli(ctx.executor),
        item.action.containerId
      );
      const blockers = gitBlockersForRemoval(
        git,
        item.action.containerId,
        this.options
      );
      return blockers.length > 0 ? { reason: blockers.join('; ') } : { item };
    }
    if (type === 'none' || item.paths.length === 0) {
      return { item };
    }
    let paths = item.paths;
    const usages = await ctx.env.usageMany(paths);
    paths = paths.filter((target) => usages.get(target));
    if (paths.length === 0) {
      return { reason: 'nothing left to remove (already gone or rebuilt)' };
    }
    const newest = Math.max(
      0,
      ...[...usages.values()].map((u) => u?.newestMtimeMs ?? 0)
    );
    const fresh = {
      ...item,
      paths,
      bytes: type === 'remove' ? sumBytes(usages) : item.bytes,
      newestMtimeMs: newest || item.newestMtimeMs,
      action: type === 'remove' ? { ...item.action, paths } : item.action,
    };
    const staticBlocker = await this.#staticBlocker(ctx, fresh);
    if (staticBlocker) {
      return { reason: staticBlocker };
    }
    const safety = await this.#safetyBlocker(ctx, fresh, type);
    return safety ? { reason: safety } : { item: fresh };
  }

  async #staticBlocker(ctx, item) {
    if (
      item.recheck?.type === 'pyenv-envs' &&
      (await ctx.env.list(ctx.env.path.join(item.path, 'envs'))).length > 0
    ) {
      return 'contains pyenv virtual environments';
    }
    if (item.lockfiles) {
      const entries = await ctx.env.list(item.project);
      if (!entries.some((entry) => item.lockfiles.includes(entry.name))) {
        return `no lockfile remains in ${item.project}`;
      }
    }
    return browserRevisionBlocker(ctx.env, item);
  }

  async #safetyBlocker(ctx, item, type) {
    await ctx.liveness.refresh(true);
    await ctx.liveness.resolve(item.paths);
    const busy = ctx.liveness.busyReason(item);
    if (busy) {
      return `busy: ${busy}`;
    }
    const mount = await this.#bindMountBlocker(ctx, item, type);
    if (mount) {
      return mount;
    }
    return this.#gitBlocker(ctx, item);
  }

  async #bindMountBlocker(ctx, item, type) {
    if (
      ctx.env.kind === 'host' &&
      type === 'remove' &&
      this.report.docker?.daemons?.some((daemon) => daemon.env === ctx.env.id)
    ) {
      const mounts = await runningBindMounts(new DockerCli(ctx.executor));
      for (const mount of mounts) {
        if (
          item.paths.some(
            (target) =>
              isWithin(target, mount.source, ctx.env.path) ||
              isWithin(mount.source, target, ctx.env.path)
          )
        ) {
          return `bind-mounted by running container ${mount.containerId}`;
        }
      }
    }
    return null;
  }

  async #gitBlocker(ctx, item) {
    if (item.project || item.rule === 'gh-issue-solver-workdirs') {
      ctx.git.invalidate();
      const blockers =
        item.rule === 'gh-issue-solver-workdirs'
          ? await ctx.git.treeBlockers(item.path)
          : await ctx.git.pathBlockers(item.path, {
              requireClean: item.tier !== 'safe',
            });
      if (blockers.length > 0) {
        return blockers.join('; ');
      }
    }
    return null;
  }

  async #execute(ctx, item, entry) {
    const { action } = item;
    if (action.type === 'remove') {
      for (const target of action.paths) {
        await ctx.liveness.refresh(true);
        await ctx.liveness.resolve([target]);
        const busy = ctx.liveness.busyReason({ ...item, paths: [target] });
        if (busy) {
          entry.reason = `stopped before ${target}: busy: ${busy}`;
          return;
        }
        const usage = await ctx.env.usage(target);
        await ctx.env.remove([target]);
        entry.status = 'removed';
        entry.deletedPaths.push(target);
        entry.freedBytes += usage?.bytes ?? 0;
        await this.options.onProgress?.(entry);
      }
    } else if (action.type === 'command') {
      await this.#command(ctx, item, entry);
    } else if (action.type === 'docker-rm') {
      await this.#removeContainer(ctx, item, entry);
    } else {
      entry.reason = 'no safe action for this item';
    }
  }

  async #command(ctx, item, entry) {
    const { action } = item;
    const isDocker = action.argv[0] === 'docker';
    if (isDocker) {
      assertAllowed(action.argv.slice(1));
    }
    await ctx.liveness.refresh(true);
    const busy = ctx.liveness.busyReason(item);
    if (busy) {
      entry.reason = `busy: ${busy}`;
      return;
    }
    const measure = action.measure ?? [];
    const before = measure.length > 0 ? await ctx.env.usageMany(measure) : null;
    const result = await ctx.env.run(action.argv, {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    entry.command = action.argv.join(' ');
    if (result.code !== 0) {
      entry.status = 'failed';
      entry.reason = `\`${entry.command}\` exited with ${result.code}: ${result.stderr.trim().slice(0, 500)}`;
      return;
    }
    entry.status = 'removed';
    const reclaimed = /Total reclaimed space:\s*(\S+)/.exec(result.stdout);
    if (reclaimed) {
      entry.freedBytes = parseDockerSize(reclaimed[1]);
    } else if (before) {
      const after = await ctx.env.usageMany(measure);
      entry.freedBytes = Math.max(0, sumBytes(before) - sumBytes(after));
    } else {
      entry.freedBytes = item.bytes;
      entry.freedEstimated = true;
    }
  }

  async #removeContainer(ctx, item, entry) {
    const { containerId, name } = item.action;
    const docker = new DockerCli(ctx.executor);
    const [inspected] = await docker.inspect([containerId]).catch(() => []);
    if (!inspected) {
      entry.reason = 'container no longer exists';
      return;
    }
    const state = inspected.State?.Status;
    if (!STOPPED.has(state)) {
      entry.reason = `container is ${state} now, left alone`;
      return;
    }
    if (
      item.action.finishedAt &&
      inspected.State.FinishedAt !== item.action.finishedAt
    ) {
      entry.reason = 'container ran again since the scan, scan again first';
      return;
    }
    const git = await containerGitState(docker, containerId);
    const blockers = gitBlockersForRemoval(git, containerId, this.options);
    if (blockers.length > 0) {
      entry.reason = blockers.join('; ');
      return;
    }
    entry.backup = await this.#backupContainer(docker, ctx, item, inspected);
    const [beforeRm] = await docker.inspect([containerId]).catch(() => []);
    if (!beforeRm || !STOPPED.has(beforeRm.State?.Status)) {
      entry.reason = 'container state changed while saving logs, left alone';
      return;
    }
    if (beforeRm.State?.FinishedAt !== inspected.State?.FinishedAt) {
      entry.reason = 'container ran again while saving logs, left alone';
      return;
    }
    const removed = await docker.run(['rm', containerId]);
    if (removed.code !== 0) {
      entry.status = 'failed';
      entry.reason = `docker rm ${name} failed: ${removed.stderr.trim()}`;
      return;
    }
    entry.status = 'removed';
    entry.freedBytes = item.bytes;
  }

  async #backupContainer(docker, ctx, item, inspected) {
    const safe = (value) => value.replace(/[^\w.-]+/g, '_');
    const dir = path.join(
      this.backupRoot,
      safe(ctx.env.id),
      `${safe(item.action.name)}-${item.action.containerId.slice(0, 12)}`
    );
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'inspect.json'),
      `${JSON.stringify(inspected, null, 2)}\n`
    );
    const child = ctx.executor.spawn(
      docker.argv(['logs', '--timestamps', item.action.containerId])
    );
    const stdout = createWriteStream(path.join(dir, 'stdout.log'));
    const stderr = createWriteStream(path.join(dir, 'stderr.log'));
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    const [[code]] = await Promise.all([
      once(child, 'close'),
      finished(stdout),
      finished(stderr),
    ]);
    if (code !== 0) {
      throw new Error(`saving docker logs failed (exit ${code}), not removed`);
    }
    return dir;
  }
}

/**
 * Freed and remaining reclaimable bytes per environment.
 */
export function environmentTotals(report, entries) {
  const removed = new Set(
    entries.filter((e) => e.status === 'removed').map((e) => e.id)
  );
  const labels = new Map(
    (report.environments ?? []).map((env) => [env.id, env.label])
  );
  const totals = {};
  const bucket = (env, label) => {
    totals[env] ??= {
      label: labels.get(env) ?? label ?? env,
      freedBytes: 0,
      leftBytes: 0,
      removed: 0,
      planned: 0,
      skipped: 0,
      failed: 0,
    };
    return totals[env];
  };
  for (const entry of entries) {
    const env = bucket(entry.env, entry.envLabel);
    env.freedBytes += entry.freedBytes;
    env[entry.status]++;
  }
  const left = dropNested(report.items.filter((item) => !removed.has(item.id)));
  for (const item of left) {
    bucket(item.env, item.envLabel).leftBytes += item.bytes;
  }
  return totals;
}

/**
 * Report items that pass `only` and `exclude`, which also apply to a report
 * scanned earlier with other options.
 */
export function wantedItems(report, options) {
  const approved = options.approvedIds ? new Set(options.approvedIds) : null;
  return filterItems(report.items, { ...options, minSizeBytes: 0 }, [], path)
    .filter((item) => !approved || approved.has(item.id))
    .map((item) => {
      if (
        item.action?.type !== 'docker-rm' ||
        !options.allowDirtyContainers?.includes(item.action.containerId)
      ) {
        return item;
      }
      return {
        ...item,
        blockers: item.blockers.filter(
          (reason) =>
            !item.container?.gitBlockers?.includes(reason) ||
            !/^Git repository .+ has /.test(reason)
        ),
      };
    });
}

/**
 * Items `clean()` acts on for the chosen tier, in cleaning order.
 */
export function planItems(report, options) {
  return selectByTier(wantedItems(report, options), options.tier).sort(
    cleanOrder
  );
}

/** Options that only the cleaning run itself may grant. */
export const CONFIRMATION_FLAGS = [
  'removeStoppedContainers',
  'removeUnusedImages',
  'includeVolumes',
  'allowDirtyRepos',
  'allowDirtyContainers',
];

/**
 * Scan options of the report overlaid with the clean options. Consent
 * (confirmation flags) is never inherited from the report.
 */
export function cleanOptions(report, input) {
  const options = resolveOptions(input);
  if (options.tier === 'aggressive') {
    throw new Error('aggressive cleanup is available only in emergency mode');
  }
  return options;
}

/**
 * Cleans the items of `report` up to `options.tier`.
 * @param {object} report output of `scan()`
 * @param {object} [input] options (see ./options.js) plus `dryRun`,
 *   `confirm(item) → Promise<boolean>`, `env`, `audit: false`
 * @returns {Promise<object>} audit log
 */
export async function clean(report, input = {}) {
  report = await revalidateReport(report, input);
  const options = cleanOptions(report, input);
  const audit = startAudit(input.command ?? 'clean', {
    dryRun: Boolean(options.dryRun),
    tier: options.tier,
    report: { createdAt: report.createdAt, totals: report.totals },
  });
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
    onProgress: persistProgress,
  });
  if (options.audit !== false) {
    await writeAudit(audit, { ...options, inProgress: true });
  }
  for (const item of planItems(report, options)) {
    const entry = await cleaner.process(item);
    if (!audit.entries.includes(entry)) {
      audit.entries.push(entry);
    }
    options.onEntry?.(entry, item);
    if (options.audit !== false) {
      await writeAudit(audit, { ...options, inProgress: true });
    }
  }
  return finishAudit(audit, report, options);
}

/**
 * Adds totals and writes the audit log (unless `audit: false`).
 */
export async function finishAudit(audit, report, options) {
  audit.finishedAt = new Date().toISOString();
  audit.freedBytes = audit.entries.reduce((sum, e) => sum + e.freedBytes, 0);
  audit.plannedBytes = audit.entries
    .filter((e) => e.status === 'planned')
    .reduce((sum, e) => sum + e.plannedBytes, 0);
  audit.environments = environmentTotals(report, audit.entries);
  if (options.audit !== false) {
    await writeAudit(audit, options);
  }
  return audit;
}
