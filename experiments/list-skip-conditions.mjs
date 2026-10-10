#!/usr/bin/env node
// Counts each distinct condition of an `if (...) { return; }` statement in
// the test files, to see which gates decide whether a test body runs.
import { readdirSync, readFileSync } from 'node:fs';
const counts = new Map();
for (const file of readdirSync('tests').filter((f) => f.endsWith('.test.js'))) {
  const text = readFileSync(`tests/${file}`, 'utf8');
  for (const m of text.matchAll(/^\s*if \((.+)\) \{\n\s*return;\n\s*\}$/gm)) {
    const key = m[1];
    const entry = counts.get(key) ?? { n: 0, files: new Set() };
    entry.n += 1;
    entry.files.add(file);
    counts.set(key, entry);
  }
}
for (const [cond, { n, files }] of [...counts].sort(
  (a, b) => b[1].n - a[1].n
)) {
  console.log(`${n}\t${cond}\t${[...files].join(',')}`);
}
