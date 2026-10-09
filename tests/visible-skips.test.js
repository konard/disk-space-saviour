import { describe, it, expect } from 'test-anywhere';
import { readdirSync, readFileSync } from 'node:fs';
import { findConditionalRegistrations } from './helpers/conditional-registration.js';
import { itUnless, missingDenoPermissions } from './helpers/skip.js';

// Deno used to register 158 fewer tests than Node and pass about 140 more
// without asserting anything, and every summary still read "ok". A test that
// cannot run on a runner has to say so: see tests/helpers/skip.js.

const lines = (...rows) => rows.join('\n');

describe('findConditionalRegistrations', () => {
  it('flags tests registered inside an if block', () => {
    const source = lines(
      "describe('x', () => {",
      '  if (canRunBash) {',
      "    it('runs', () => {});",
      '  }',
      '});'
    );

    expect(findConditionalRegistrations(source)).toEqual([
      { line: 2, kind: 'wrapped', text: 'if (canRunBash) {' },
    ]);
  });

  it('flags a describe callback that returns before registering', () => {
    const source = lines(
      "describe('x', () => {",
      '  // Deno cannot spawn here.',
      "  if (typeof Deno !== 'undefined') {",
      '    return; // nothing below runs',
      '  }',
      "  it('runs', () => {});",
      '});'
    );

    expect(findConditionalRegistrations(source).map((f) => f.kind)).toEqual([
      'early-return',
    ]);
  });

  it('flags a test body that passes early on an environment check', () => {
    const source = lines(
      "it('spawns', () => {",
      '  if (readOnlyRuntime()) {',
      '    return;',
      '  }',
      '  expect(run()).toBe(0);',
      '});',
      "it('lists', () => {",
      "  if (process.platform === 'win32') return;",
      '});'
    );

    expect(findConditionalRegistrations(source).map((f) => f.line)).toEqual([
      2, 8,
    ]);
  });

  it('leaves early returns on data and helper functions alone', () => {
    const source = lines(
      'function parse(text) {',
      "  if (typeof Deno !== 'undefined') {",
      '    return;',
      '  }',
      '}',
      "it('reads', () => {",
      '  if (!match) {',
      '    return;',
      '  }',
      '});'
    );

    expect(findConditionalRegistrations(source)).toEqual([]);
  });
});

describe('test registration', () => {
  const files = readdirSync('tests').filter((file) =>
    file.endsWith('.test.js')
  );

  for (const file of files) {
    it(`${file} registers every test unconditionally`, () => {
      const findings = findConditionalRegistrations(
        readFileSync(`tests/${file}`, 'utf8')
      ).map((finding) => `${file}:${finding.line} ${finding.kind}`);

      expect(findings).toEqual([]);
    });

    // Deno's --parallel workers share one process working directory.
    it(`${file} leaves the process working directory alone`, () => {
      expect(readFileSync(`tests/${file}`, 'utf8')).not.toMatch(
        /\b(?:process|Deno)\.chdir\(/
      );
    });
  }
});

describe('Deno CI leg', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

  it('grants the permissions the fixtures need, so nothing is skipped', () => {
    expect(workflow).toMatch(/"Deno test suite" deno test -A --parallel\n/);
  });
});

describe('skip helpers', () => {
  const fakeDeno = (granted) => ({
    permissions: {
      querySync: ({ name }) => ({
        state: granted.includes(name) ? 'granted' : 'prompt',
      }),
    },
  });

  it('lists the Deno permissions a run lacks', () => {
    expect(missingDenoPermissions(fakeDeno(['read', 'env']))).toEqual([
      'write',
      'run',
      'sys',
      'net',
      'ffi',
    ]);
    expect(
      missingDenoPermissions(
        fakeDeno(['read', 'write', 'run', 'env', 'sys', 'net', 'ffi'])
      )
    ).toEqual([]);
    expect(missingDenoPermissions(null)).toEqual([]);
  });

  it('returns the plain registrar when no reason applies', () => {
    expect(itUnless(null, false, undefined)).toBe(it);
  });

  it('returns a skipping registrar when a reason applies', () => {
    expect(itUnless(null, 'no shell')).not.toBe(it);
  });
});
