import { describe, it, expect } from 'test-anywhere';
import { readdirSync, readFileSync } from 'node:fs';
import { blankEnv } from './helpers/env.js';

describe('blankEnv', () => {
  it('blanks the dropped names and keeps the rest', () => {
    const env = { CI: 'true', HUSKY: '0', PATH: '/bin' };

    expect(blankEnv(env, (name) => name !== 'PATH')).toEqual({
      CI: '',
      HUSKY: '',
      PATH: '/bin',
    });
    expect(env.CI).toBe('true');
  });
});

describe('fixture environments', () => {
  // Deno's spawnSync hands the child the parent's value of a variable that
  // was deleted from the env it was passed, see tests/helpers/env.js.
  const DELETES_FROM_ENV = /\bdelete\s+[\w$.]*env[\w$]*\s*[.[]/i;
  const files = readdirSync('tests').filter((file) =>
    file.endsWith('.test.js')
  );

  for (const file of files) {
    it(`${file} blanks variables instead of deleting them`, () => {
      const lines = readFileSync(`tests/${file}`, 'utf8')
        .split('\n')
        .filter((line) => DELETES_FROM_ENV.test(line));

      expect(lines).toEqual([]);
    });
  }
});
