/**
 * Option defaults and normalization shared by `scan()`, `clean()` and
 * `emergency()`. Sizes and durations accept numbers (bytes, milliseconds)
 * or strings (`512M`, `1h`).
 */

import { parseDuration, parsePercent, parseSize } from './units.js';

export const DEFAULTS = {
  roots: null,
  maxDepth: 6,
  staleAge: '1h',
  inactive: '30d',
  minSize: '1M',
  docker: null,
  dockerDepth: 3,
  containers: [],
  scanners: ['projects', 'global', 'versions', 'agents', 'system'],
  only: [],
  exclude: [],
  includeVolumes: false,
  removeStoppedContainers: false,
  removeUnusedImages: false,
  allowDirtyRepos: false,
  noNative: false,
  journalKeep: '512M',
  tier: 'safe',
  yes: false,
  backupDir: null,
  auditDir: null,
};

function toBytes(value) {
  return typeof value === 'number' ? value : parseSize(value);
}

function toMs(value) {
  return typeof value === 'number' ? value : parseDuration(value);
}

function toList(value) {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  return (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Normalizes user options. `olderThan` is an alias of `staleAge`.
 * @param {object} [input]
 * @returns {object}
 */
export function resolveOptions(input = {}) {
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  const staleAge = input.olderThan ?? merged.staleAge;
  const roots = toList(merged.roots);
  return {
    ...merged,
    roots: roots.length > 0 ? roots : null,
    maxDepth: Number(merged.maxDepth),
    dockerDepth: Number(merged.dockerDepth),
    staleAgeMs: toMs(staleAge),
    inactiveMs: toMs(merged.inactive),
    minSizeBytes: toBytes(merged.minSize),
    journalKeepBytes: toBytes(merged.journalKeep),
    containerFilter: toList(merged.containers),
    scanners: toList(merged.scanners),
    only: toList(merged.only),
    exclude: toList(merged.exclude),
    now: merged.now ?? (() => Date.now()),
  };
}

/**
 * Parses an emergency goal: `free` (bytes to free, `20G`) and/or `until`
 * (target used percentage, `80%`).
 * @returns {{freeBytes: number|null, untilPercent: number|null}}
 */
export function resolveGoal({ free, until } = {}) {
  const goal = {
    freeBytes: free === undefined || free === null ? null : toBytes(free),
    untilPercent:
      until === undefined || until === null
        ? null
        : typeof until === 'number'
          ? until
          : parsePercent(until),
  };
  if (goal.freeBytes === null && goal.untilPercent === null) {
    throw new Error('emergency needs a goal: --free <size> or --until <N%>');
  }
  return goal;
}
