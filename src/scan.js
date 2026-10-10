/**
 * `scan(options) → Report`: finds reclaimable space on the host and, through
 * Docker, inside running containers and nested daemons. Never deletes.
 */

import {
  configureContainerHost,
  resetWritableLayers,
} from './docker/writable.js';
import { setInterval, clearInterval } from 'node:timers';
import { scanDocker } from './docker/scan.js';
import { LocalEnv } from './env/local.js';
import { configureScanPolicy } from './env/policy.js';
import { configureCacheRoots } from './env/cache-roots.js';
import { checkSignal, environmentScope } from './env/scope.js';
import { block, tierTotals } from './items.js';
import { hostExecutor, trace } from './exec.js';
import { GitInspector } from './git.js';
import { LivenessProbe } from './liveness.js';
import { resolveOptions } from './options.js';
import { existingPaths, isWithin, matchesExcluded } from './paths.js';
import { scanAgents } from './scanners/agents.js';
import { scanGlobal } from './scanners/global.js';
import { scanProjects } from './scanners/projects.js';
import { scanSystem } from './scanners/system.js';
import { scanVersions } from './scanners/versions.js';

export const SCANNERS = {
  projects: scanProjects,
  global: scanGlobal,
  versions: scanVersions,
  agents: scanAgents,
  system: scanSystem,
};

export const REPORT_SCHEMA = 1;
const trustedReports = new WeakMap();
const reportEnvironments = new WeakMap();
export const scannedEnvironment = (report) => reportEnvironments.get(report);
const RESCAN_OPTIONS = new Set([
  'roots',
  'scanners',
  'containers',
  'host',
  'docker',
  'dockerDepth',
  'maxDepth',
  'staleAge',
  'olderThan',
  'inactive',
  'minSize',
  'only',
  'exclude',
  'includeVolumes',
  'removeStoppedContainers',
  'investigationMaxAge',
  'removeContainers',
  'removeImages',
  'allowDirtyRepos',
  'allowDirtyContainers',
  'noNative',
  'journalKeep',
  'env',
  'now',
  'signal',
  'scanBudget',
  'onScanProgress',
]);

function safetySnapshot(report) {
  return JSON.stringify(report);
}

function sealReport(report) {
  trustedReports.set(report, safetySnapshot(report));
  return report;
}

/** Rebuild scanner-derived actions when a report came from JSON or changed. */
export async function revalidateReport(saved, input = {}) {
  if (trustedReports.get(saved) === safetySnapshot(saved)) {
    return saved;
  }
  const scope = {
    roots: saved.options?.roots,
    scanners: saved.options?.scanners,
    containers: saved.options?.containers,
    host: saved.options?.host,
    docker: saved.options?.docker,
    dockerDepth: saved.options?.dockerDepth,
    maxDepth: saved.options?.maxDepth,
  };
  for (const [key, value] of Object.entries(input)) {
    if (RESCAN_OPTIONS.has(key) && value !== undefined && value !== null) {
      scope[key] = value;
    }
  }
  const current = await scan(scope);
  const selected = new Set((saved.items ?? []).map((item) => item.id));
  current.items = current.items.filter((item) => selected.has(item.id));
  current.totals = tierTotals(current.items);
  return sealReport(current);
}

/** Common project locations inside containers, scanned when present. */
export const CONTAINER_ROOTS = [
  '/workspace',
  '/workspaces',
  '/app',
  '/src',
  '/code',
  '/project',
  '/usr/src/app',
];

async function defaultRoots(env, homes, tmpDirs) {
  const roots = [...homes, ...tmpDirs];
  if (env.kind === 'container') {
    const present = await existingPaths(env, CONTAINER_ROOTS);
    roots.push(...CONTAINER_ROOTS.filter((root) => present.has(root)));
  }
  return [...new Set(roots)];
}

/**
 * Builds the scanner context of one environment.
 * @param {object} env environment adapter
 * @param {object} options resolved options
 * @param {{roots?: string[]|null}} [overrides]
 */
export async function environmentContext(env, options, overrides = {}) {
  await configureScanPolicy(env, {
    ...options,
    roots: overrides.roots ?? options.roots,
  });
  const liveness = new LivenessProbe(env, {
    staleAgeMs: options.staleAgeMs,
    now: options.now,
  });
  await liveness.refresh(true);
  const homes = await env.homeDirs();
  await configureCacheRoots(env, homes);
  const tmpDirs = await env.tmpDirs();
  const roots = overrides.roots ?? (await defaultRoots(env, homes, tmpDirs));
  return {
    env,
    git: new GitInspector(env),
    liveness,
    now: options.now(),
    options: { ...options, homes, tmpDirs, roots },
  };
}

/**
 * Runs every enabled scanner in one environment.
 * @param {object} env
 * @param {object} options resolved options
 * @param {{roots?: string[]|null, errors?: object[]}} [extra]
 * @returns {Promise<object[]>} items
 */
export async function scanEnvironment(env, options, extra = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) {
    abort();
  }
  const started = Date.now(),
    deadline = started + options.scanBudgetMs;
  const timer = setTimeout(
    () => controller.abort(new Error('scan time budget exceeded')),
    options.scanBudgetMs
  );
  const found = new Map();
  let scanner = 'context';
  const progress = () =>
    options.onScanProgress?.({
      env: env.id,
      scanner,
      elapsedMs: Date.now() - started,
      items: found.size,
      status: env.scanStatus,
    });
  env.scanStatus = 'scanning';
  const interval = setInterval(progress, 5000);
  try {
    return await environmentScope(
      env,
      controller.signal,
      () => {
        progress();
        return scanEnvironmentScoped(env, options, extra, found, (name) => {
          scanner = name;
          progress();
        });
      },
      deadline
    );
  } catch (error) {
    env.scanStatus = options.signal?.aborted
      ? 'aborted'
      : controller.signal.aborted
        ? 'budget-exceeded'
        : 'error';
    (extra.errors ?? []).push({ env: env.id, scanner, message: error.message });
    const items = [...found.values()];
    for (const item of items) {
      block(item, `scan incomplete: ${error.message}`);
    }
    return items;
  } finally {
    clearTimeout(timer);
    clearInterval(interval);
    options.signal?.removeEventListener('abort', abort);
    progress();
  }
}

async function scanEnvironmentScoped(env, options, extra, found, stage) {
  const errors = extra.errors ?? [];
  const context = await environmentContext(env, options, extra);
  context.emit = (item) => found.set(item.id, item);
  let incomplete = false;
  for (const name of options.scanners) {
    checkSignal(env.signal);
    stage(name);
    const scanner = SCANNERS[name];
    if (!scanner) {
      throw new Error(
        `Unknown scanner: ${name} (expected ${Object.keys(SCANNERS).join(', ')})`
      );
    }
    const started = Date.now();
    const previous = new Set(found.keys());
    try {
      const entries = await scanner(context);
      for (const item of entries) {
        context.emit(item);
      }
    } catch (error) {
      checkSignal(env.signal);
      incomplete = true;
      for (const [id, item] of found) {
        if (!previous.has(id)) {
          block(item, `scan incomplete: ${error.message}`);
        }
      }
      errors.push({ env: env.id, scanner: name, message: error.message });
    }
    trace('scanner', name, 'in', env.id, `${Date.now() - started}ms`);
  }
  stage('storage');
  const items = [...found.values()];
  await attributeStorage(env, items);
  for (const item of items) {
    for (const target of item.paths) {
      block(item, env.scanPolicy.removalReason(target));
    }
  }
  for (const message of env.accessErrors?.values() ?? []) {
    errors.push({ env: env.id, scanner: 'filesystem', message });
  }
  env.scanStatus = incomplete ? 'error' : 'complete';
  return items;
}

async function attributeStorage(env, items) {
  if (env.writableLayer) {
    const usages = await env.usageMany([
      ...new Set(items.flatMap((item) => item.paths)),
    ]);
    for (const item of items.filter((entry) => entry.paths.length > 0)) {
      const measured = item.paths
        .map((target) => usages.get(target))
        .filter(Boolean);
      item.bytes = measured.reduce((sum, usage) => sum + usage.bytes, 0);
      item.totalBytes = measured.reduce(
        (sum, usage) => sum + (usage.totalBytes ?? usage.bytes),
        0
      );
      item.imageBytes = measured.reduce(
        (sum, usage) => sum + (usage.imageBytes ?? 0),
        0
      );
      item.imageRef =
        measured.find((usage) => usage.imageRef)?.imageRef ?? null;
      item.sizeUnknown = measured.some((usage) => usage.sizeUnknown);
      if (!item.sizeUnknown && item.bytes === 0 && item.imageBytes > 0) {
        block(
          item,
          'all bytes are in the image layer; remove the stopped container and its unused image after the task completes, or rebuild without caches'
        );
      }
    }
  }
}

/**
 * Container ids of the container dss itself runs in (from mount sources
 * such as `/var/lib/docker/containers/<id>/hostname`).
 * @returns {Promise<string[]>}
 */
export async function selfContainerIds(env) {
  if (env.platform !== 'linux' || typeof env.readText !== 'function') {
    return [];
  }
  const ids = new Set();
  const pattern = /(?:containers\/|docker[-/])([0-9a-f]{64})/g;
  const cgroup =
    (await env.readText('/proc/self/cgroup').catch(() => null)) ?? '';
  for (const match of cgroup.matchAll(pattern)) {
    ids.add(match[1]);
  }
  const mounts =
    (await env.readText('/proc/self/mountinfo').catch(() => null)) ?? '';
  for (const line of mounts.split('\n')) {
    const mountpoint = line.split(' ')[4];
    if (
      !['/etc/hostname', '/etc/hosts', '/etc/resolv.conf'].includes(mountpoint)
    ) {
      continue;
    }
    for (const match of line.matchAll(pattern)) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

function matchesOnly(item, only) {
  return (
    only.length === 0 ||
    only.some(
      (entry) =>
        entry === item.ecosystem || entry === item.rule || entry === item.kind
    )
  );
}

function excluded(item, exclude, pathApi) {
  return item.paths.some(
    (target) =>
      matchesExcluded(target, exclude, pathApi) ||
      exclude.some(
        (pattern) =>
          !/[*?[]/.test(pattern) && isWithin(pattern, target, pathApi)
      )
  );
}

function underDaemonRoot(item, daemons, pathApi) {
  return daemons.some(
    (daemon) =>
      daemon.env === item.env &&
      daemon.rootDir &&
      item.action?.type === 'remove' &&
      item.paths.some((target) => isWithin(target, daemon.rootDir, pathApi))
  );
}

/**
 * Applies `only`, `exclude` and `minSize`, and drops paths owned by a
 * Docker daemon (those are reclaimed through Docker only).
 */
export function filterItems(items, options, daemons = [], pathApi) {
  return items.filter(
    (item) =>
      (item.bytes >= options.minSizeBytes ||
        item.sizeUnknown ||
        item.imageBytes >= options.minSizeBytes ||
        item.container?.pinnedImage?.bytes >= options.minSizeBytes) &&
      matchesOnly(item, options.only) &&
      !excluded(item, options.exclude, pathApi) &&
      !underDaemonRoot(item, daemons, pathApi)
  );
}

function envDescriptor(env, depth, chain) {
  return {
    id: env.id,
    label: env.label,
    kind: env.kind,
    depth,
    chain,
    hint: env.probeHint ?? null,
    scanStatus: env.scanStatus ?? null,
    layerSource: env.writableLayer?.source ?? null,
  };
}

async function withDisk(env, descriptor) {
  const target = env.platform === 'win32' ? env.currentHome : '/';
  const disk = await env.diskUsage(target).catch(() => null);
  return { ...descriptor, disk: disk ? { path: target, ...disk } : null };
}

async function dockerSection(env, options, errors) {
  if (options.docker === false) {
    return null;
  }
  const hostRecord = {
    env,
    executor: env.executor ?? hostExecutor(),
    chain: [],
  };
  try {
    const result = await scanDocker(
      hostRecord,
      { ...options, selfContainerIds: await selfContainerIds(env) },
      (inner) => scanEnvironment(inner, options, { errors })
    );
    errors.push(...result.errors);
    if (options.docker === true && result.daemons.length === 0) {
      errors.push({
        env: env.id,
        scanner: 'docker',
        message: 'no reachable Docker daemon',
      });
    }
    return result;
  } catch (error) {
    errors.push({ env: env.id, scanner: 'docker', message: error.message });
    return null;
  }
}

/**
 * Scans and returns a report. Nothing is modified.
 * @param {object} [input] options, see ./options.js; `host: false` skips the
 *   host file system (Docker only); `env` injects the host environment
 *   adapter (tests).
 * @returns {Promise<object>} report
 */
function blockMountedHostItems(items, mounts, pathApi) {
  for (const item of items) {
    if (item.action?.type !== 'remove') {
      continue;
    }
    for (const mount of mounts) {
      if (
        item.paths.some(
          (target) =>
            isWithin(target, mount.source, pathApi) ||
            isWithin(mount.source, target, pathApi)
        )
      ) {
        block(item, `bind-mounted by running container ${mount.containerId}`);
      }
    }
  }
}

export async function scan(input = {}) {
  const env = input.env ?? new LocalEnv();
  try {
    return await environmentScope(env, input.signal, () =>
      scanScoped({ ...input, env })
    );
  } catch (error) {
    if (!input.signal?.aborted) {
      throw error;
    }
    env.scanStatus = 'aborted';
    const options = resolveOptions(input);
    return buildReport({
      options,
      env,
      items: [],
      environments: [envDescriptor(env, 0, [])],
      docker: null,
      errors: [{ env: env.id, scanner: 'context', message: error.message }],
      startedAt: options.now(),
    });
  }
}

async function scanScoped(input) {
  const options = resolveOptions(input);
  const env = input.env ?? new LocalEnv();
  const startedAt = options.now();
  const errors = [];
  resetWritableLayers(env.executor);
  env.writableLayer = null;
  env.scanPolicy = null;
  await configureScanPolicy(env, options);
  await configureContainerHost(
    env,
    options.docker === false ? [] : await selfContainerIds(env),
    options
  );
  const hostItems =
    options.host === false
      ? []
      : await scanEnvironment(env, options, { roots: options.roots, errors });
  const docker = await dockerSection(env, options, errors);
  blockMountedHostItems(hostItems, docker?.bindMounts ?? [], env.path);
  const items = filterItems(
    [...hostItems, ...(docker?.items ?? [])],
    options,
    docker?.daemons ?? [],
    env.path
  );
  const environments = [envDescriptor(env, 0, [])];
  for (const inner of docker?.environments ?? []) {
    environments.push(inner);
  }
  environments[0] = await withDisk(env, environments[0]);
  const report = buildReport({
    options,
    env,
    items,
    environments,
    docker,
    errors,
    startedAt,
  });
  reportEnvironments.set(report, env);
  return report;
}

function reportOptions(options) {
  const serializable = { ...options };
  delete serializable.now;
  delete serializable.env;
  delete serializable.signal;
  delete serializable.onScanProgress;
  return serializable;
}

/**
 * Assembles the JSON-serializable report.
 */
export function buildReport({
  options,
  env,
  items,
  environments,
  docker,
  errors,
  startedAt,
}) {
  return sealReport({
    schema: REPORT_SCHEMA,
    tool: 'disk-space-saviour',
    createdAt: new Date(options.now()).toISOString(),
    durationMs: options.now() - startedAt,
    aborted: Boolean(options.signal?.aborted),
    host: { env: env.id, label: env.label, platform: env.platform },
    options: reportOptions(options),
    environments,
    items,
    totals: tierTotals(items),
    docker: docker
      ? {
          daemons: docker.daemons,
          containers: docker.containers,
          hints: docker.hints,
          volumes: docker.volumes,
        }
      : null,
    errors,
  });
}
