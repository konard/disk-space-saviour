/**
 * Superseded cargo artifacts: the newest hash of every unit is kept, older
 * hashes are reported only outside the activity window, and a build
 * generation stays together.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
import { scan } from '../src/scan.js';
import {
  analyzeRustProfile,
  parseArtifactName,
  rootSourceOf,
} from '../src/scanners/rust.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  readOnlyRuntime,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

const HOUR_MS = 60 * 60 * 1000;
const OLD = '0123456789abcdef';
const NEW = 'fedcba9876543210';
const SAME_BUILD = 'aaaaaaaaaaaaaaaa';

function touch(target, ageMs) {
  const when = new Date(Date.now() - ageMs);
  utimesSync(target, when, when);
}

/**
 * Writes the artifacts cargo leaves for one build of the `foo` library
 * with `hash` into `profile` and dates them `ageMs` ago.
 * @returns {string[]} the written top-level entries
 */
function unit(profile, hash, ageMs, crate = 'foo') {
  const fingerprint = join(profile, '.fingerprint', `${crate}-${hash}`);
  mkdirSync(fingerprint, { recursive: true });
  writeFileSync(
    join(fingerprint, `lib-${crate}.json`),
    `{"rustc":1,"features":"[]","target":42${crate.length},"profile":7}`
  );
  const deps = join(profile, 'deps');
  const files = [
    writeBlob(join(deps, `lib${crate}-${hash}.rlib`), 48 * 1024),
    writeBlob(join(deps, `lib${crate}-${hash}.rmeta`), 16 * 1024),
  ];
  writeFileSync(
    join(deps, `${crate}-${hash}.d`),
    `${deps}/lib${crate}-${hash}.rlib: src/lib.rs\n`
  );
  files.push(join(deps, `${crate}-${hash}.d`));
  age(fingerprint, ageMs);
  files.forEach((file) => touch(file, ageMs));
  return [fingerprint, ...files];
}

function cargoProject(root) {
  const project = join(root, 'crate');
  mkdirSync(join(project, 'target', 'debug', 'deps'), { recursive: true });
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "foo"\n');
  writeFileSync(join(project, 'target', 'CACHEDIR.TAG'), '');
  return { project, profile: join(project, 'target', 'debug') };
}

describe('Rust artifact names', () => {
  it('splits crate, hash and extension', () => {
    expect(parseArtifactName(`libserde_json-${OLD}.rlib`)).toEqual({
      crate: 'serde_json',
      hash: OLD,
      extension: '.rlib',
    });
    expect(parseArtifactName(`app-${OLD}`)).toEqual({
      crate: 'app',
      hash: OLD,
      extension: '',
    });
    expect(parseArtifactName('README.md')).toBe(null);
  });

  it('reads the crate root of a dep-info file', () => {
    expect(rootSourceOf('/t/libfoo-1.rlib: src/lib.rs src/a.rs\n')).toBe(
      'src/lib.rs'
    );
    expect(rootSourceOf('')).toBe('');
  });
});

describe('Rust pruning', () => {
  it('keeps the newest hash and reports the superseded one', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-rust-');
    const { profile } = cargoProject(root);
    const old = unit(profile, OLD, 3 * DAY_MS);
    const kept = unit(profile, NEW, 2 * HOUR_MS);
    const result = await analyzeRustProfile(fixtureEnv(root), profile, {
      staleAgeMs: HOUR_MS,
      now: Date.now(),
    });
    expect(result.entries.map((e) => e.path).sort()).toEqual(old.sort());
    expect(result.kept).toBe(1);
    expect(result.removed).toBe(1);
    expect(kept.every((path) => existsSync(path))).toBe(true);
    removeRoot(root);
  });

  it('keeps an older hash that was written inside the activity window', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-rust-window-');
    const { profile } = cargoProject(root);
    unit(profile, OLD, 30 * 60 * 1000);
    unit(profile, NEW, 60 * 1000);
    const result = await analyzeRustProfile(fixtureEnv(root), profile, {
      staleAgeMs: HOUR_MS,
      now: Date.now(),
    });
    expect(result.entries).toEqual([]);
    expect(result.kept).toBe(2);
    removeRoot(root);
  });

  it('keeps every hash of the newest build generation', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-rust-generation-');
    const { profile } = cargoProject(root);
    unit(profile, OLD, 5 * DAY_MS);
    unit(profile, SAME_BUILD, 2 * DAY_MS + 5 * 60 * 1000);
    unit(profile, NEW, 2 * DAY_MS);
    const result = await analyzeRustProfile(fixtureEnv(root), profile, {
      staleAgeMs: HOUR_MS,
      now: Date.now(),
    });
    const hashes = result.entries.map(
      (e) => parseArtifactName(e.path.split('/').pop())?.hash
    );
    expect([...new Set(hashes)]).toEqual([OLD]);
    expect(result.kept).toBe(2);
    removeRoot(root);
  });

  it('treats different crates as different units', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-rust-crates-');
    const { profile } = cargoProject(root);
    unit(profile, OLD, 3 * DAY_MS, 'foo');
    unit(profile, NEW, 2 * HOUR_MS, 'barbaz');
    const result = await analyzeRustProfile(fixtureEnv(root), profile, {
      staleAgeMs: HOUR_MS,
      now: Date.now(),
    });
    expect(result.entries).toEqual([]);
    removeRoot(root);
  });

  it('does not prune reusable feature variants in the safe tier', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-rust-clean-');
    const { profile } = cargoProject(root);
    const old = unit(profile, OLD, 3 * DAY_MS);
    const kept = unit(profile, NEW, 2 * HOUR_MS);
    const env = fixtureEnv(root);
    const report = await scan(
      scanInput(env, [root], { scanners: ['projects'], inactive: '30d' })
    );
    const item = report.items.find((i) => i.rule === 'cargo-superseded');
    expect(item).toBe(undefined);
    const target = report.items.find((i) => i.rule === 'cargo-target');
    expect(target.tier).toBe('aggressive');

    const audit = await clean(report, { env, tier: 'safe', audit: false });
    expect(audit.entries).toEqual([]);
    expect(old.every((path) => existsSync(path))).toBe(true);
    expect(kept.every((path) => existsSync(path))).toBe(true);
    removeRoot(root);
  });
});
