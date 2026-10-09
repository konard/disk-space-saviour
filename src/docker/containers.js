/**
 * Stopped container inspection without starting the container.
 *
 * `docker rm` (without `-v`) deletes only the container's writable layer,
 * so only work written there can be lost. `docker diff` lists that layer;
 * every changed `.git` directory marks a repository, which is copied out
 * with `docker cp` (dependency directories skipped) and checked with the
 * host's Git.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GitInspector, stateBlockers } from '../git.js';
import { LocalEnv } from '../env/local.js';
import { trace } from '../exec.js';
import { repoRootsFromDiff } from './cli.js';

export const COPY_EXCLUDES = [
  '*/node_modules',
  '*/target',
  '*/.venv',
  '*/venv',
  '*/__pycache__',
  '*/.gradle',
  '*/.next',
  '*/.nuxt',
  '*/.tox',
  '*/.mypy_cache',
  '*/.pytest_cache',
];

const DEFAULT_MAX_REPOS = 20;
const OWNER_HINT = /session|issue|pull|task|owner/i;
const SECRET = /token|secret|password|key$/i;
const TASK_URL_KEY = /(issue|pull|task)[\w.-]*url|url[\w.-]*(issue|pull|task)/i;
const TASK_URL = /^https:\/\/[\w.-]+(\/[\w.~%#/-]*)?$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHORT_ID = 12;
const ENDED = new Set(['exited', 'dead']);

function safeOwnerHint(key, value) {
  const text = String(value);
  return (
    OWNER_HINT.test(key) &&
    !SECRET.test(key) &&
    !/https?:\/\/|ghp_|github_pat_|sk-/.test(text)
  );
}

/** Only an exact container id can waive verified unsaved Git work. */
export function gitBlockersForRemoval(git, id, options = {}) {
  if (!(options.allowDirtyContainers ?? []).includes(id)) {
    return git.blockers;
  }
  return git.blockers.filter(
    (reason) => !/^Git repository .+ has /.test(reason)
  );
}

/** Bind mounts of running containers in the current Docker daemon. */
export function isHostBindSource(source) {
  return Boolean(
    source && (path.posix.isAbsolute(source) || path.win32.isAbsolute(source))
  );
}

export async function runningBindMounts(docker) {
  const running = (await docker.containers()).filter(
    (row) => row.State === 'running'
  );
  const inspected = await docker.inspect(running.map((row) => row.ID));
  return inspected.flatMap((container) =>
    (container.Mounts ?? [])
      .filter(
        (mount) => mount.Type === 'bind' && isHostBindSource(mount.Source)
      )
      .map((mount) => ({ source: mount.Source, containerId: container.Id }))
  );
}

/**
 * Who a container belongs to: labels and environment variables that look
 * like session, issue or task identifiers (`HIVE_MIND_PARENT_SESSION_ID`
 * first among them), else a session UUID in the container name; plus its
 * command, task URL and how it ended.
 * @param {object} ps row of `docker ps --format json`
 * @param {object} [inspected] `docker inspect` object
 */
export function ownerOf(ps, inspected) {
  const hints = ownerHints(inspected);
  const name = String(ps.Names ?? '').split(',')[0];
  const [sessionSource, session] = sessionOf(hints, name);
  const state = ENDED.has(inspected?.State?.Status) ? inspected.State : null;
  return {
    name,
    image: ps.Image,
    ...containerMetadata(ps, inspected),
    finishedAt: inspected?.State?.FinishedAt ?? null,
    exitCode: typeof state?.ExitCode === 'number' ? state.ExitCode : null,
    oomKilled: Boolean(state?.OOMKilled),
    exitReason: exitReason(state),
    taskUrl: taskUrlOf(inspected),
    session,
    sessionSource,
    hints,
  };
}

function containerMetadata(ps, inspected) {
  return {
    command: ps.Command
      ? ps.Command.replace(/^"|"$/g, '')
      : [
          ...(inspected?.Config?.Entrypoint ?? []),
          ...(inspected?.Config?.Cmd ?? []),
        ].join(' ') || null,
    createdAt: ps.CreatedAt ?? inspected?.Created ?? null,
  };
}

/** Counters and flags such as `1` or `true` are not session ids. */
function sessionLike(value) {
  const text = String(value).trim();
  return text !== '' && !/^(\d+|true|false|yes|no)$/i.test(text);
}

function sessionOf(hints, name) {
  const entries = Object.entries(hints).filter(([, value]) =>
    sessionLike(value)
  );
  const found =
    entries.find(([key]) => /HIVE_MIND_PARENT_SESSION_ID$/.test(key)) ??
    entries.find(([key]) => /session/i.test(key));
  if (found) {
    return found;
  }
  const fromName = UUID.exec(name)?.[0];
  return fromName ? ['name', fromName] : [null, null];
}

/**
 * How a stopped container ended, from `docker inspect` State.
 * @returns {string|null}
 */
export function exitReason(state) {
  if (!ENDED.has(state?.Status) || typeof state.ExitCode !== 'number') {
    return null;
  }
  if (state.Error) {
    return state.Error;
  }
  if (state.OOMKilled) {
    return 'killed: out of memory';
  }
  if (state.ExitCode === 0) {
    return 'completed';
  }
  return state.ExitCode > 128
    ? `killed by signal ${state.ExitCode - 128}`
    : `failed with exit code ${state.ExitCode}`;
}

/**
 * Why a task runner keeps a stopped container for investigation (it failed
 * or was OOM killed), or null.
 */
export function investigationReason(state) {
  const parts = [];
  if (state?.ExitCode) {
    parts.push(`exit ${state.ExitCode}`);
  }
  if (state?.OOMKilled) {
    parts.push('OOM killed');
  }
  return parts.length > 0
    ? `kept for investigation (${parts.join(', ')})`
    : null;
}

/**
 * Whether the operator named this container with `--remove-container`:
 * its name, full id or an id prefix of at least 12 characters.
 */
export function containerNamed(names, id, name) {
  return (names ?? []).some(
    (entry) =>
      entry === name ||
      entry === `/${name}` ||
      (entry.length >= SHORT_ID && id.startsWith(entry))
  );
}

export function investigationExpired(state, options = {}) {
  const age = options.investigationMaxAgeMs;
  const finished = Date.parse(state?.FinishedAt);
  return (
    age !== null &&
    age !== undefined &&
    Number.isFinite(age) &&
    age >= 0 &&
    Number.isFinite(finished) &&
    finished > 0 &&
    (options.now?.() ?? Date.now()) - finished >= age
  );
}

/** Blocker of a container kept for investigation that was not named. */
export function investigationBlocker(state, id, name, options = {}) {
  const reason = investigationReason(state);
  if (
    !reason ||
    investigationExpired(state, options) ||
    containerNamed(options.removeContainers, id, name)
  ) {
    return null;
  }
  return `${reason}; remove it only with --remove-container ${id.slice(0, SHORT_ID)}`;
}

function taskUrlOf(inspected) {
  const pairs = [
    ...Object.entries(inspected?.Config?.Labels ?? {}),
    ...(inspected?.Config?.Env ?? []).map((pair) => {
      const index = pair.indexOf('=');
      return [pair.slice(0, index), pair.slice(index + 1)];
    }),
  ];
  const found = pairs.find(
    ([key, value]) =>
      TASK_URL_KEY.test(key) &&
      !SECRET.test(key) &&
      TASK_URL.test(value) &&
      !/ghp_|github_pat_|sk-/.test(value)
  );
  return found?.[1] ?? null;
}

function ownerHints(inspected) {
  const hints = {};
  for (const [key, value] of Object.entries(inspected?.Config?.Labels ?? {})) {
    if (safeOwnerHint(key, value)) {
      hints[`label:${key}`] = value;
    }
  }
  for (const pair of inspected?.Config?.Env ?? []) {
    const index = pair.indexOf('=');
    const key = pair.slice(0, index);
    if (index > 0 && safeOwnerHint(key, pair.slice(index + 1))) {
      hints[`env:${key}`] = pair.slice(index + 1);
    }
  }
  return hints;
}

async function copyAndCheck(docker, id, root, git) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dss-container-git-'));
  try {
    const copied = await docker.copyOut(id, root, dir, COPY_EXCLUDES);
    if (copied.code !== 0) {
      return {
        root,
        error: `docker cp failed: ${copied.stderr.trim() || copied.code}`,
      };
    }
    const local = path.join(dir, path.basename(root));
    const state = await git.repoState(local);
    return { ...state, root };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Git state of every repository written in a stopped container.
 * @returns {Promise<{repos: object[], blockers: string[]}>}
 */
async function probeRepoRoots(docker, id, changed, roots, blockers) {
  if (changed.length > 500) {
    blockers.push('Git repository inspection limit exceeded');
  }
  const probed = new Map();
  for (const target of changed.slice(0, 500)) {
    for (let dir = target; dir !== '/'; dir = path.posix.dirname(dir)) {
      if (probed.has(dir)) {
        if (probed.get(dir)) {
          roots.add(dir);
        }
        break;
      }
      const exists = await docker.pathExists(
        id,
        path.posix.join(dir, '.git', 'HEAD')
      );
      if (exists === null) {
        blockers.push(`cannot inspect Git metadata near ${target}`);
        break;
      }
      probed.set(dir, exists);
      if (exists) {
        roots.add(dir);
        break;
      }
    }
  }
}

function excludedWorkBlockers(checked, changed, blockers) {
  const excluded = new Set(COPY_EXCLUDES.map((pattern) => pattern.slice(2)));
  for (const root of checked) {
    for (const target of changed) {
      if (!target.startsWith(`${root}/`)) {
        continue;
      }
      const parts = target.slice(root.length + 1).split('/');
      if (parts.slice(0, -1).some((part) => excluded.has(part))) {
        blockers.push(
          `changed work under excluded folder ${target} cannot be verified`
        );
      }
    }
  }
}

export async function containerGitState(docker, id, options = {}) {
  try {
    return await inspectContainerGitState(docker, id, options);
  } catch (error) {
    trace('container Git inspection failed', id, error.stack ?? error.message);
    return {
      repos: [],
      blockers: [`cannot verify Git work in the container: ${error.message}`],
    };
  }
}

async function inspectContainerGitState(docker, id, options) {
  const diff = await docker.diff(id, { fresh: options.fresh });
  if (diff === null) {
    return {
      repos: [],
      blockers: ['cannot list the writable layer (`docker diff` failed)'],
    };
  }
  const relevantDiff = diff
    .split('\n')
    .filter((line) => !excludedRepoPath(line.slice(2)))
    .join('\n');
  const roots = new Set(repoRootsFromDiff(relevantDiff));
  const maxRepos = options.maxRepos ?? DEFAULT_MAX_REPOS;
  const blockers = [];
  if (roots.has('/')) {
    blockers.push('the container root is a Git repository');
  }
  const changed = relevantDiff
    .split('\n')
    .map((line) => /^[ACD] (\/.+)$/.exec(line.trim())?.[1])
    .filter(Boolean);
  await probeRepoRoots(docker, id, changed, roots, blockers);
  const checked = [...roots].filter((root) => root !== '/').slice(0, maxRepos);
  excludedWorkBlockers(checked, changed, blockers);
  if (roots.size > checked.length + (roots.has('/') ? 1 : 0)) {
    blockers.push(
      `${roots.size} repositories changed, only ${maxRepos} were verified`
    );
  }
  const repos = [];
  if (checked.length === 0) {
    return { repos, blockers };
  }
  // `docker cp` copies to this machine, so Git always runs locally.
  const git = new GitInspector(options.env ?? new LocalEnv(), {
    recognizePreserved: true,
  });
  for (const root of checked) {
    const state = await copyAndCheck(docker, id, root, git);
    repos.push(state);
    blockers.push(...stateBlockers(`${root} (in container)`, state));
  }
  return { repos, blockers };
}

function excludedRepoPath(target) {
  return (
    /^\/var\/lib\/docker\/(?:overlay2|fuse-overlayfs|btrfs|containerd)\//.test(
      target
    ) || /\/\.codex\/(?:.*\/)?\.tmp\/plugins[^/]*(?:\/|$)/.test(target)
  );
}
