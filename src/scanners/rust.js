/**
 * Superseded Rust build artifacts inside a cargo `target` directory.
 *
 * Every compilation unit leaves entries named `<crate>-<16 hex hash>` in
 * `<profile>/deps`, `<profile>/build` and `<profile>/.fingerprint`, and
 * incremental state in `<profile>/incremental/<crate>-<hash>`. Changing
 * features, flags, the toolchain or dependency versions creates a new hash
 * next to the old one, so old hashes pile up.
 *
 * A unit's identity is read from its fingerprint (`<kind>-<target>.json`
 * with the `target` and `profile` hashes, which separate lib/bin/test and
 * check/build units). Units without a fingerprint fall back to crate name,
 * artifact kind and crate root source (first entry of the `.d` file).
 * Incremental directories are grouped by crate.
 *
 * For each identity the newest hash is kept, together with every hash built
 * within the same generation window (one build). Older hashes are reported
 * only when all of their files are outside the activity window.
 */

import { listMany } from './common.js';

const HASHED = /^(.+)-([0-9a-f]{16})(\..*)?$/;
const INCREMENTAL = /^(.+)-([0-9a-z]{8,20})$/;
const LIB_PREFIXED = new Set(['.rlib', '.rmeta', '.so', '.dylib', '.a']);
const KIND_ORDER = ['lib', 'dylib', 'staticlib', 'bin', 'rmeta', 'other'];
const NON_PROFILES = new Set(['doc', 'package', 'tmp', 'flycheck0']);
export const DEFAULT_GENERATION_MS = 10 * 60 * 1000;

function fileKind(extension) {
  const kinds = {
    '.rlib': 'lib',
    '.rmeta': 'rmeta',
    '.so': 'dylib',
    '.dylib': 'dylib',
    '.dll': 'dylib',
    '.a': 'staticlib',
    '.lib': 'staticlib',
    '': 'bin',
    '.exe': 'bin',
  };
  return kinds[extension] ?? 'other';
}

/**
 * Splits `libfoo_bar-0123456789abcdef.rlib` into crate, hash, extension.
 * @returns {{crate: string, hash: string, extension: string}|null}
 */
export function parseArtifactName(name) {
  const match = HASHED.exec(name);
  if (!match) {
    return null;
  }
  const extension = match[3] ?? '';
  let crate = match[1];
  if (LIB_PREFIXED.has(extension) && crate.startsWith('lib')) {
    crate = crate.slice(3);
  }
  return { crate, hash: match[2], extension };
}

/**
 * First dependency of a Makefile-style `.d` file: the crate root source.
 */
export function rootSourceOf(depInfo) {
  const line = (depInfo ?? '').split('\n')[0];
  const separator = line.search(/:\s/);
  if (separator === -1) {
    return '';
  }
  const deps = line
    .slice(separator + 1)
    .trim()
    .split(/(?<!\\)\s+/);
  return deps[0] ?? '';
}

/**
 * Unit identity from a fingerprint JSON file name and its beginning.
 */
export function fingerprintIdentity(jsonName, head) {
  const target = /"target":(\d+)/.exec(head ?? '');
  const profile = /"profile":(\d+)/.exec(head ?? '');
  return `${jsonName}:${target?.[1] ?? '?'}:${profile?.[1] ?? '?'}`;
}

/**
 * Profile directories (`target/debug`, `target/<triple>/release`, ...)
 * identified by their `deps` subdirectory.
 * @returns {Promise<string[]>}
 */
export async function findRustProfiles(env, targetDir) {
  const top = (await env.list(targetDir)).filter(
    (entry) => entry.type === 'dir' && !NON_PROFILES.has(entry.name)
  );
  const hasDeps = (entries) => entries.some((entry) => entry.name === 'deps');
  const listings = await listMany(
    env,
    top.map((entry) => entry.path)
  );
  const profiles = [];
  const nested = [];
  for (const entry of top) {
    const children = listings.get(entry.path) ?? [];
    if (hasDeps(children)) {
      profiles.push(entry.path);
      continue;
    }
    for (const child of children) {
      if (child.type === 'dir' && !NON_PROFILES.has(child.name)) {
        nested.push(env.path.join(entry.path, child.name));
      }
    }
  }
  const nestedListings = await listMany(env, nested);
  profiles.push(...nested.filter((dir) => hasDeps(nestedListings.get(dir))));
  return profiles.sort();
}

async function withDirUsage(env, entries) {
  const dirs = entries.filter((entry) => entry.type === 'dir');
  if (dirs.length === 0) {
    return entries;
  }
  const usages = await env.usageMany(dirs.map((entry) => entry.path));
  return entries.map((entry) => {
    const usage = entry.type === 'dir' ? usages.get(entry.path) : null;
    return usage
      ? {
          ...entry,
          bytes: usage.bytes,
          mtimeMs: Math.max(entry.mtimeMs, usage.newestMtimeMs ?? 0),
        }
      : entry;
  });
}

function hashedEntries(entries) {
  return (entries ?? []).filter((entry) => parseArtifactName(entry.name));
}

class UnitSet {
  constructor() {
    this.units = new Map();
  }

  add(key, hash, entry) {
    if (!this.units.has(key)) {
      this.units.set(key, new Map());
    }
    const hashes = this.units.get(key);
    if (!hashes.has(hash)) {
      hashes.set(hash, { hash, entries: [], mtimeMs: 0 });
    }
    const unit = hashes.get(hash);
    unit.entries.push(entry);
    unit.mtimeMs = Math.max(unit.mtimeMs, entry.mtimeMs);
  }

  superseded({ staleAgeMs, now, generationMs }) {
    const stale = [];
    let kept = 0;
    for (const hashes of this.units.values()) {
      const ordered = [...hashes.values()].sort(
        (a, b) => b.mtimeMs - a.mtimeMs
      );
      const newest = ordered[0].mtimeMs;
      for (const unit of ordered) {
        const sameGeneration = newest - unit.mtimeMs <= generationMs;
        const idle = now - unit.mtimeMs >= staleAgeMs;
        if (sameGeneration || !idle) {
          kept++;
        } else {
          stale.push(unit);
        }
      }
    }
    return { stale, kept };
  }
}

async function fingerprintKeys(env, fingerprints) {
  const listings = await listMany(
    env,
    fingerprints.map((entry) => entry.path)
  );
  const jsonFiles = new Map();
  for (const entry of fingerprints) {
    const json = (listings.get(entry.path) ?? []).find(
      (child) => child.name.endsWith('.json') && !child.name.startsWith('dep-')
    );
    if (json) {
      jsonFiles.set(entry, json);
    }
  }
  const heads = await env.readHeads(
    [...jsonFiles.values()].map((json) => json.path),
    8192
  );
  const keys = new Map();
  for (const [entry, json] of jsonFiles) {
    const { crate, hash } = parseArtifactName(entry.name);
    keys.set(
      hash,
      `fp:${crate}:${fingerprintIdentity(json.name, heads.get(json.path))}`
    );
  }
  return keys;
}

async function fallbackDepsKeys(env, depsDir, entries, known) {
  const groups = new Map();
  for (const entry of entries) {
    const parsed = parseArtifactName(entry.name);
    if (known.has(parsed.hash)) {
      continue;
    }
    if (!groups.has(parsed.hash)) {
      groups.set(parsed.hash, { crate: parsed.crate, kinds: new Set() });
    }
    groups.get(parsed.hash).kinds.add(fileKind(parsed.extension));
  }
  const depFile = (hash, crate) => env.path.join(depsDir, `${crate}-${hash}.d`);
  const heads = await env.readHeads(
    [...groups].map(([hash, group]) => depFile(hash, group.crate)),
    4096
  );
  const keys = new Map();
  for (const [hash, group] of groups) {
    const kind = KIND_ORDER.find((k) => group.kinds.has(k)) ?? 'other';
    const root = rootSourceOf(heads.get(depFile(hash, group.crate)));
    keys.set(hash, `deps:${group.crate}:${kind}:${root}`);
  }
  return keys;
}

function buildRole(listing) {
  return (listing ?? []).some((c) => c.name.startsWith('build-script-'))
    ? 'script'
    : 'run';
}

/**
 * Superseded artifacts of one profile directory.
 * @param {object} env
 * @param {string} profileDir
 * @param {{staleAgeMs: number, now: number, generationMs?: number}} options
 * @returns {Promise<{entries: Array<{path: string, bytes: number,
 *   mtimeMs: number}>, bytes: number, kept: number, removed: number}>}
 */
export async function analyzeRustProfile(env, profileDir, options) {
  const settings = { generationMs: DEFAULT_GENERATION_MS, ...options };
  const sub = (name) => env.path.join(profileDir, name);
  const listings = await listMany(env, [
    sub('deps'),
    sub('build'),
    sub('incremental'),
    sub('.fingerprint'),
  ]);
  const fingerprints = hashedEntries(listings.get(sub('.fingerprint')));
  const deps = await withDirUsage(
    env,
    hashedEntries(listings.get(sub('deps')))
  );
  const builds = await withDirUsage(
    env,
    hashedEntries(listings.get(sub('build')))
  );
  const keys = await fingerprintKeys(env, fingerprints);
  const fallback = await fallbackDepsKeys(env, sub('deps'), deps, keys);
  const buildListings = await listMany(
    env,
    builds
      .filter((entry) => !keys.has(parseArtifactName(entry.name).hash))
      .map((entry) => entry.path)
  );

  const units = new UnitSet();
  for (const entry of [...deps, ...builds, ...fingerprints]) {
    const { crate, hash } = parseArtifactName(entry.name);
    const key =
      keys.get(hash) ??
      fallback.get(hash) ??
      `build:${crate}:${buildRole(buildListings.get(entry.path))}`;
    units.add(key, hash, entry);
  }
  const incremental = (listings.get(sub('incremental')) ?? []).filter(
    (entry) => entry.type === 'dir' && INCREMENTAL.test(entry.name)
  );
  for (const entry of await withDirUsage(env, incremental)) {
    const [, crate, hash] = INCREMENTAL.exec(entry.name);
    units.add(`incremental:${crate}`, `i${hash}`, entry);
  }

  const { stale, kept } = units.superseded(settings);
  const entries = stale
    .flatMap((unit) => unit.entries)
    .map(({ path, bytes, mtimeMs }) => ({ path, bytes, mtimeMs }));
  return {
    entries,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    kept,
    removed: stale.length,
  };
}
