/**
 * Leaf Rust pruning while cargo runs: idle incremental sessions and
 * superseded test/example binaries stay removable, library artifacts
 * (`.rlib`, `.rmeta`, `build/*`, `.fingerprint`) are left alone, and files
 * a process has open are skipped one by one.
 *
 * A copy of `sleep` named `cargo` stands in for a running build. Linux
 * only: the in-use check reads `/proc/*`.
 */

import { describe, expect } from 'test-anywhere';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
import { scan } from '../src/scan.js';
import { analyzeRustProfile } from '../src/scanners/rust.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';
import { itUnless, notLinux, sandboxed } from './helpers/skip.js';

const HOUR_MS = 60 * 60 * 1000;
const OLD = '0123456789abcdef';
const NEW = 'fedcba9876543210';
const SLEEP = ['/bin/sleep', '/usr/bin/sleep'].find((file) => existsSync(file));

const noSleep = SLEEP ? null : 'no sleep binary to stand in for a process';

/** Library artifacts of one build of `foo`, dated `ageMs` ago. */
function libraryUnit(profile, hash, ageMs) {
  const fingerprint = join(profile, '.fingerprint', `foo-${hash}`);
  mkdirSync(fingerprint, { recursive: true });
  writeFileSync(
    join(fingerprint, 'lib-foo.json'),
    '{"rustc":1,"target":42,"profile":7}'
  );
  const rlib = writeBlob(join(profile, 'deps', `libfoo-${hash}.rlib`));
  const build = join(profile, 'build', `foo-${hash}`);
  writeBlob(join(build, 'out', 'generated.rs'), 1024);
  [fingerprint, rlib, build].forEach((target) => age(target, ageMs));
  return [fingerprint, rlib, build];
}

/** An executable artifact (a copy of `sleep`), dated `ageMs` ago. */
function executable(file, ageMs) {
  mkdirSync(join(file, '..'), { recursive: true });
  copyFileSync(SLEEP, file);
  chmodSync(file, 0o755);
  age(file, ageMs);
  return file;
}

/** Incremental directory with one session, dated `ageMs` ago. */
function incremental(profile, name, ageMs, session = 's-abc-def') {
  const dir = join(profile, 'incremental', name);
  writeBlob(join(dir, session, 'query-cache.bin'), 32 * 1024);
  age(dir, ageMs);
  return dir;
}

async function run(file, cwd) {
  const child = spawn(file, ['600'], { cwd, stdio: 'ignore' });
  await once(child, 'spawn');
  return child;
}

function fixture(root) {
  const project = join(root, 'crate');
  const profile = join(project, 'target', 'debug');
  mkdirSync(join(profile, 'deps'), { recursive: true });
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "foo"\n');
  writeFileSync(join(project, 'target', 'CACHEDIR.TAG'), '');
  const library = libraryUnit(profile, OLD, 3 * DAY_MS);
  const current = libraryUnit(profile, NEW, 2 * HOUR_MS);
  const leaves = {
    idleSession: incremental(profile, 'foo-2p0o4l8a1', 5 * HOUR_MS),
    oldTest: executable(join(profile, 'deps', `foo-${OLD}`), 3 * DAY_MS),
    oldExample: executable(
      join(profile, 'examples', 'demo-1111111111111111'),
      3 * DAY_MS
    ),
    runningExample: executable(
      join(profile, 'examples', 'busy-3333333333333333'),
      3 * DAY_MS
    ),
  };
  const kept = [
    ...current,
    incremental(profile, 'foo-3q1p5m9b2', 10 * 60 * 1000),
    incremental(profile, 'bar-4r2q6n0c3', 5 * HOUR_MS, 's-xyz-working'),
    executable(join(profile, 'deps', `foo-${NEW}`), 2 * HOUR_MS),
    executable(join(profile, 'examples', 'demo-2222222222222222'), HOUR_MS),
    executable(join(profile, 'examples', 'busy-4444444444444444'), HOUR_MS),
  ];
  const cargo = executable(join(root, 'bin', 'cargo'), DAY_MS);
  return { project, profile, library, kept, leaves, cargo };
}

describe('Rust leaf pruning', () => {
  itUnless(
    sandboxed,
    notLinux,
    noSleep
  )('splits a profile into library and leaf parts', async () => {
    const root = tempRoot('dss-rust-parts-');
    const { profile, library, leaves } = fixture(root);
    const result = await analyzeRustProfile(fixtureEnv(root), profile, {
      staleAgeMs: HOUR_MS,
      now: Date.now(),
    });
    const paths = (part) => part.entries.map((entry) => entry.path).sort();
    expect(paths(result.library)).toEqual(
      [...library, `${profile}/deps/foo-${OLD}.d`]
        .filter((target) => existsSync(target))
        .sort()
    );
    expect(paths(result.leaf)).toEqual(Object.values(leaves).sort());
    expect(result.entries.length).toBe(
      result.library.entries.length + result.leaf.entries.length
    );
    removeRoot(root);
  });

  itUnless(
    sandboxed,
    notLinux,
    noSleep
  )('prunes only unused leaf artifacts while cargo runs', async () => {
    const root = tempRoot('dss-rust-leaf-');
    const { project, library, kept, leaves, cargo } = fixture(root);
    const children = [
      await run(cargo, project),
      await run(leaves.runningExample, root),
    ];
    try {
      const env = fixtureEnv(root);
      const report = await scan(
        scanInput(env, [root], { scanners: ['projects'] })
      );
      const libraryItem = report.items.find(
        (item) => item.rule === 'cargo-superseded'
      );
      expect(libraryItem.blockers.join('; ')).toContain('cargo is running');
      const leaf = report.items.find(
        (item) => item.rule === 'cargo-superseded-leaf'
      );
      expect(leaf.tier).toBe('safe');
      expect(leaf.blockers).toEqual([]);
      expect([...leaf.paths].sort()).toEqual(
        [leaves.idleSession, leaves.oldTest, leaves.oldExample].sort()
      );

      // Started after the scan: the cleaner's own check must catch it.
      children.push(await run(leaves.oldExample, root));
      const audit = await clean(report, { env, tier: 'safe', audit: false });
      expect(audit.entries.map((e) => [e.rule, e.status])).toEqual([
        ['cargo-superseded-leaf', 'removed'],
      ]);
      const [entry] = audit.entries;
      expect(entry.deletedPaths.sort()).toEqual(
        [leaves.idleSession, leaves.oldTest].sort()
      );
      expect(entry.skippedPaths.map((skip) => skip.path)).toEqual([
        leaves.oldExample,
      ]);
      expect(entry.skippedPaths[0].reason).toContain('in use');
      expect(existsSync(leaves.idleSession)).toBe(false);
      expect(existsSync(leaves.oldTest)).toBe(false);
      expect(existsSync(leaves.oldExample)).toBe(true);
      expect(existsSync(leaves.runningExample)).toBe(true);
      expect(library.every((target) => existsSync(target))).toBe(true);
      expect(kept.every((target) => existsSync(target))).toBe(true);
    } finally {
      for (const child of children) {
        child.kill('SIGKILL');
      }
      removeRoot(root);
    }
  });
});
