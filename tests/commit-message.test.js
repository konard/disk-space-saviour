import { describe, expect } from 'test-anywhere';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStrict } from '../scripts/run-command.mjs';
import { itUnless, sandboxed } from './helpers/skip.js';

const source = readFileSync('scripts/version-and-commit.mjs', 'utf8');

describe('exact release commit message', () => {
  for (const [name, ending] of [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ]) {
    const script = source.replace(/\r?\n/g, ending);
    itUnless(sandboxed)(
      `preserves an exact Git commit message with ${name} source endings`,
      async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'commit-message-'));
        try {
          const git = (...args) =>
            execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
          git('init', '-b', 'main');
          git('config', 'user.name', 'Fixture');
          git('config', 'user.email', 'fixture@example.invalid');
          const block = script.match(
            / {6}\/\/ Commit with version number as message\r?\n([\s\S]*?)\r?\n {6}\/\/ Push directly/
          )[1];
          // The block runs against the fixture through a cwd-bound runStrict.
          // process.chdir would also move every test running beside this one
          // (Deno's --parallel workers share the process working directory),
          // and a `$` command would run in the real checkout.
          expect(block).not.toContain('await $');
          const runInFixture = (command, args, options = {}) =>
            runStrict(command, args, { ...options, cwd });
          // Create a staged file so git commit uses its normal production flags.
          git('config', 'core.hooksPath', join(cwd, 'no-hooks'));
          writeFileSync(join(cwd, 'file'), 'fixture');
          git('add', 'file');
          const message =
            '1.2.3 "quoted" \\ path $HOME $(printf nope) `printf nope`';
          const commit = new Function(
            'newVersion',
            'runStrict',
            `return (async () => {${block}})();`
          );
          await commit(message, runInFixture);
          expect(git('log', '-1', '--format=%B')).toBe(message);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      }
    );
  }
});
