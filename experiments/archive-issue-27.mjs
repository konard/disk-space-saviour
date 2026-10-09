#!/usr/bin/env node
/** Preserve investigation inputs/logs without committing oversized plain logs. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const input = resolve(process.argv[2] ?? '/tmp/dss-investigation');
const output = resolve('docs/case-studies/issue-27/data');
mkdirSync(output, { recursive: true });
const manifest = [];
function archive(source, relative, compressed = false) {
  if (!existsSync(source)) {
    return;
  }
  const bytes = readFileSync(source);
  const destination = join(output, relative);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  writeFileSync(destination, compressed ? gzipSync(bytes) : bytes);
  manifest.push({
    path: relative,
    originalBytes: bytes.length,
    originalSha256: createHash('sha256').update(bytes).digest('hex'),
    encoding: compressed ? 'gzip' : 'utf8',
  });
}
for (const name of [
  'issue-27.json',
  'latest-27-comments.json',
  'npm-registry.json',
  'pr-15.json',
  'pr-15.patch',
  'pr-20.json',
  'pr-20.patch',
  'run-37847771589.json',
  'run-37948829224.json',
  'moby-image-changes.go',
  'moby-container-changes.go',
  'command-stream-result.mjs',
  'upstream-create.log',
  'upstream-search.json',
]) {
  archive(
    join(input, name),
    name.endsWith('.log') ? `${name}.gz` : name,
    name.endsWith('.log')
  );
}
for (const name of [
  'boundaries-before',
  'storage-before',
  'processes-before',
  'caches-before',
  'change-budget-before',
  'final-review-before',
  'boundaries-after',
  'storage-after',
  'processes-after',
  'caches-after',
  'node-final',
  'bun-final-review',
  'deno-final-review',
  'check-final-review',
  'dind',
]) {
  archive(join(input, `${name}.log`), `tests/${name}.log.gz`, true);
}
for (const id of ['37847771589', '37948829224']) {
  const name = `checks-release-${id}.log`;
  const source = resolve('ci-logs', name);
  archive(source, `ci-logs/${name}.gz`, true);
  if (existsSync(source)) {
    const lines = readFileSync(source, 'utf8').split('\n');
    const pattern =
      /NotCapable.*GITHUB_REPOSITORY|requires env access to "GITHUB_REPOSITORY"|E404 Not Found - PUT|❌ Publish failed|Publish failed: Command failed|npm publish finished/;
    const excerpt = lines.flatMap((line, index) =>
      pattern.test(line) ? [`${index + 1}: ${line}`] : []
    );
    writeFileSync(
      join(output, 'ci-logs', `${id}-errors.txt`),
      `${excerpt.join('\n')}\n`
    );
  }
}
writeFileSync(
  join(output, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`
);
