import { describe, it, expect } from 'test-anywhere';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formattableFiles,
  STAGED_FILES_ARGS,
} from '../scripts/staged-formattable.mjs';
import { readOnlyRuntime } from './helpers/fixtures.js';

const prettierBin = createRequire(import.meta.url).resolve(
  'prettier/bin/prettier.cjs'
);

const script = readFileSync('scripts/version-and-commit.mjs', 'utf8');
const useModule = readFileSync('scripts/use-module.mjs', 'utf8');

describe('version-and-commit.mjs formats the release commit', () => {
  it('checks staged files with prettier between staging and committing', () => {
    // The formatting logic lives in checkStagedFormatting(), which is defined
    // above main(); the ordering that matters is at the call site.
    const staged = script.indexOf('await $`git add -A`');
    const checkCall = script.indexOf('await checkStagedFormatting();');
    const prettier = script.indexOf('npx prettier --check');
    const commit = script.indexOf('await $`git commit');

    expect(staged).toBeGreaterThan(-1);
    expect(prettier).toBeGreaterThan(-1);
    expect(checkCall).toBeGreaterThan(staged);
    expect(commit).toBeGreaterThan(checkCall);
  });

  it('checks only the formattable staged files, not the whole tree', () => {
    expect(script).toContain('prettier --check ${formattable}');
    expect(script).toContain('formattableFiles(stagedResult.stdout)');
    expect(formattableFiles('a.md\nb.png\n c.mjs \n\nd.json')).toEqual([
      'a.md',
      'c.mjs',
      'd.json',
    ]);
  });

  it('leaves consumed changesets out of the check, so prettier passes', () => {
    // Regression for #7: prettier failed with "No files matching the pattern
    // were found" on the changesets `changeset version` had deleted.
    if (readOnlyRuntime()) {
      return;
    }
    const repo = mkdtempSync(join(tmpdir(), 'dss-release-'));
    const git = (...args) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    mkdirSync(join(repo, '.changeset'));
    writeFileSync(join(repo, '.changeset', 'consumed.md'), '# Consumed\n');
    writeFileSync(join(repo, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    rmSync(join(repo, '.changeset', 'consumed.md'));
    writeFileSync(join(repo, 'package.json'), '{\n  "version": "1.1.0"\n}\n');
    git('add', '-A');

    expect(git('diff', '--cached', '--name-only')).toContain(
      '.changeset/consumed.md'
    );
    const prettierCheck = (files) =>
      spawnSync(process.execPath, [prettierBin, '--check', ...files], {
        cwd: repo,
        encoding: 'utf8',
      }).status;
    // Without the filter prettier exits 2 on the deleted file.
    expect(
      prettierCheck(formattableFiles(git('diff', '--cached', '--name-only')))
    ).toBe(2);
    const files = formattableFiles(git(...STAGED_FILES_ARGS));
    expect(files).toEqual(['package.json']);
    expect(prettierCheck(files)).toBe(0);
    rmSync(repo, { recursive: true, force: true });
  });

  it('skips the check when nothing formattable is staged', () => {
    expect(script).toContain('formattable.length > 0');
  });
});

describe('version-and-commit.mjs push failure reporting', () => {
  // $ now rejects on non-zero (errexit), so a push that never landed reaches
  // the catch as a rejection and must say which version failed to land.
  it('reports the version when the push helper exits non-zero', () => {
    expect(script).toContain('Failed to push version');
    expect(script).not.toContain('resolves (it does not throw)');
    expect(script).not.toContain('pushResult.code');
  });
});

describe('loadCommandStream shell semantics', () => {
  it('enables errexit, the semantics the release scripts are written for', () => {
    expect(useModule).toContain('shell.errexit(true)');
  });
});
