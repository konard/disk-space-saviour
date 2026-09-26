/**
 * `scan(options) → Report`: finds reclaimable space on the host and, through
 * Docker, inside running containers and nested daemons. Never deletes.
 */

import { scanDocker } from './docker/scan.js';
import { LocalEnv } from './env/local.js';
import { hostExecutor, trace } from './exec.js';
import { GitInspector } from './git.js';
import { tierTotals } from './items.js';
import { LivenessProbe } from './liveness.js';
import { resolveOptions } from './options.js';
import { existingPaths, isWithin, matchesGlob } from './paths.js';
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
  const liveness = new LivenessProbe(env, {
    staleAgeMs: options.staleAgeMs,
    now: options.now,
  });
  await liveness.refresh(true);
  const homes = await env.homeDirs();
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
  const errors = extra.errors ?? [];
  let context;
  try {
    context = await environmentContext(env, options, extra);
  } catch (error) {
    errors.push({ env: env.id, scanner: 'context', message: error.message });
    return [];
  }
  const items = [];
  for (const name of options.scanners) {
    const scanner = SCANNERS[name];
    if (!scanner) {
      throw new Error(
        `Unknown scanner: ${name} (expected ${Object.keys(SCANNERS).join(', ')})`
      );
    }
    const started = Date.now();
    try {
      items.push(...(await scanner(context)));
    } catch (error) {
      errors.push({ env: env.id, scanner: name, message: error.message });
    }
    trace('scanner', name, 'in', env.id, `${Date.now() - started}ms`);
  }
  return items;
}

/**
 * Container ids of the container dss itself runs in (from mount sources
 * such as `/var/lib/docker/containers/<id>/hostname`).
 * @returns {Promise<string[]>}
 */
export async function selfContainerIds(env) {
  if (env.platform !== 'linux') {
    return [];
  }
  const ids = new Set();
  for (const file of ['/proc/self/mountinfo', '/proc/self/cgroup']) {
    const text = (await env.readText(file).catch(() => null)) ?? '';
    for (const match of text.matchAll(
      /(?:containers\/|docker[-/])([0-9a-f]{64})/g
    )) {
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
  return item.paths.some((target) =>
    exclude.some(
      (pattern) =>
        isWithin(target, pattern, pathApi) ||
        matchesGlob(pathApi.basename(target), pattern)
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
      item.bytes >= options.minSizeBytes &&
      matchesOnly(item, options.only) &&
      !excluded(item, options.exclude, pathApi) &&
      !underDaemonRoot(item, daemons, pathApi)
  );
}

function envDescriptor(env, depth, chain) {
  return { id: env.id, label: env.label, kind: env.kind, depth, chain };
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
export async function scan(input = {}) {
  const options = resolveOptions(input);
  const env = input.env ?? new LocalEnv();
  const startedAt = options.now();
  const errors = [];
  const hostItems =
    options.host === false
      ? []
      : await scanEnvironment(env, options, { roots: options.roots, errors });
  const docker = await dockerSection(env, options, errors);
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
  return buildReport({
    options,
    env,
    items,
    environments,
    docker,
    errors,
    startedAt,
  });
}

function reportOptions(options) {
  const serializable = { ...options };
  delete serializable.now;
  delete serializable.env;
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
  return {
    schema: REPORT_SCHEMA,
    tool: 'disk-space-saviour',
    createdAt: new Date(options.now()).toISOString(),
    durationMs: options.now() - startedAt,
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
        }
      : null,
    errors,
  };
}
