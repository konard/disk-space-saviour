// Usage: node experiments/rust-prune-demo.mjs <target-dir> [staleAge] [generation]
// Prints which Rust artifacts would be pruned as superseded.
import { LocalEnv } from '../src/env/local.js';
import { analyzeRustProfile, findRustProfiles } from '../src/scanners/rust.js';
import { parseDuration, formatBytes } from '../src/units.js';

const [target, stale = '0', generation = '0'] = process.argv.slice(2);
const env = new LocalEnv();
for (const profile of await findRustProfiles(env, target)) {
  const result = await analyzeRustProfile(env, profile, {
    staleAgeMs: parseDuration(stale),
    now: Date.now(),
    generationMs: parseDuration(generation),
  });
  console.log(
    `${profile}: remove ${result.removed} units (${formatBytes(result.bytes)}), keep ${result.kept}`
  );
  for (const entry of result.entries) {
    console.log(`  ${entry.path.slice(profile.length + 1)} ${entry.bytes}`);
  }
}
