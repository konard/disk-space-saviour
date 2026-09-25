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
const OWNER_HINT = /session|issue|pull|task|owner|repo|url|solver|agent/i;
const SECRET = /token|secret|password|key$/i;

/**
 * Who a container belongs to: labels and environment variables that look
 * like session, issue or task identifiers, plus its command.
 * @param {object} ps row of `docker ps --format json`
 * @param {object} [inspected] `docker inspect` object
 */
export function ownerOf(ps, inspected) {
  const hints = ownerHints(inspected);
  const session =
    Object.entries(hints).find(([key]) => /session/i.test(key))?.[1] ??
    Object.values(hints)[0] ??
    null;
  return {
    name: String(ps.Names ?? '').split(',')[0],
    image: ps.Image,
    command: ps.Command ? ps.Command.replace(/^"|"$/g, '') : null,
    createdAt: ps.CreatedAt ?? null,
    finishedAt: inspected?.State?.FinishedAt ?? null,
    session,
    hints,
  };
}

function ownerHints(inspected) {
  const hints = {};
  for (const [key, value] of Object.entries(inspected?.Config?.Labels ?? {})) {
    if (OWNER_HINT.test(key)) {
      hints[`label:${key}`] = value;
    }
  }
  for (const pair of inspected?.Config?.Env ?? []) {
    const index = pair.indexOf('=');
    const key = pair.slice(0, index);
    if (index > 0 && OWNER_HINT.test(key) && !SECRET.test(key)) {
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
export async function containerGitState(docker, id, options = {}) {
  const diff = await docker.diff(id);
  if (diff === null) {
    return {
      repos: [],
      blockers: ['cannot list the writable layer (`docker diff` failed)'],
    };
  }
  const roots = repoRootsFromDiff(diff);
  const maxRepos = options.maxRepos ?? DEFAULT_MAX_REPOS;
  const blockers = [];
  if (roots.includes('/')) {
    blockers.push('the container root is a Git repository');
  }
  const checked = roots.filter((root) => root !== '/').slice(0, maxRepos);
  if (roots.length > checked.length + (roots.includes('/') ? 1 : 0)) {
    blockers.push(
      `${roots.length} repositories changed, only ${maxRepos} were verified`
    );
  }
  const git = new GitInspector(options.env ?? new LocalEnv());
  const repos = [];
  for (const root of checked) {
    const state = await copyAndCheck(docker, id, root, git);
    repos.push(state);
    blockers.push(...stateBlockers(`${root} (in container)`, state));
  }
  return { repos, blockers };
}
