/**
 * jscpd 5 (the Rust rewrite) ignores config keys it does not know and only
 * prints "config file .jscpd.json: unknown field '<key>'", so the duplication
 * check stays green while running without the setting. jscpd 4's
 * `skipComments` is such a key; its jscpd 5 spelling is `"mode": "weak"`.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'test-anywhere';
import { itUnless, sandboxed } from './helpers/skip.js';

describe('jscpd config', () => {
  itUnless(sandboxed)('is read by jscpd without unknown fields', () => {
    // The silent reporter writes no report files; the threshold is the
    // duplication check's job, not this test's.
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/jscpd/run-jscpd.js',
        '--reporters',
        'silent',
        '--threshold',
        '100',
        '.',
      ],
      { encoding: 'utf8' }
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(output).toContain('Using config from .jscpd.json');
    expect(output).not.toContain('unknown field');
    expect(result.status).toBe(0);
  });

  it('skips comment tokens', () => {
    const config = JSON.parse(readFileSync('.jscpd.json', 'utf8'));

    expect(config.mode).toBe('weak');
    expect(config.skipComments).toBe(undefined);
  });
});
