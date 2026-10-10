#!/usr/bin/env node
// Groups warning/error/skip lines of `gh run view --log` output by job and
// message, with counts, so every distinct warning can be triaged once.
// Usage: node experiments/summarize-ci-warnings.mjs run-1.log [run-2.log ...]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const INTERESTING =
  /warn|error|skip|deprecat|fail|not ok|vulnerab|timeout|retry|unable|cannot|denied|notice/i;
const NOISE =
  /fail-fast|##\[group\]|\[command\]|continue-on-error|--max-warnings|^# (fail|skipped|todo) \d|^ℹ (fail|skipped|todo) \d|"result":|"outputs":|^\s*[{}],?$/i;

for (const file of process.argv.slice(2)) {
  const counts = new Map();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const [job, , rest = ''] = raw.split('\t');
    const msg = rest
      .replace(/^\S+Z /, '')
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
      .replace(/\^\[\[[0-9;]*m/g, '')
      .trim();
    if (!msg || !INTERESTING.test(msg) || NOISE.test(msg)) {
      continue;
    }
    const key = `${job}\t${msg.slice(0, 240)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  console.log(`=== ${basename(file)}`);
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(6)} ${key}`);
  }
}
