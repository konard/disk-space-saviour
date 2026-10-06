/**
 * The npm audit gate blocks only advisories that a newer release fixes.
 */

import { describe, it, expect } from 'test-anywhere';

import {
  blockingAdvisories,
  classify,
  fixedVersion,
  installedVersions,
} from '../scripts/audit-fixable.mjs';

const advisory = (name, range, severity = 'high') => ({
  name,
  range,
  severity,
  title: `${name} issue`,
  url: `https://github.com/advisories/${name}`,
});

// A registry where `>x` lists the published versions above x and the
// vulnerable range lists the published versions inside it.
function registry(published, vulnerable) {
  return (name, range) => {
    if (/^>\d/.test(range)) {
      const floor = range.slice(1);
      return published[name].filter(
        (version) => version.localeCompare(floor, 'en', { numeric: true }) > 0
      );
    }
    return vulnerable[name];
  };
}

const lock = {
  packages: {
    '': { name: 'app' },
    'node_modules/braces': { version: '3.0.3' },
    'node_modules/http-cache-semantics': { version: '4.2.0' },
    'node_modules/got/node_modules/http-cache-semantics': { version: '4.1.1' },
  },
};

describe('audit-fixable', () => {
  it('keeps high and critical advisories once each', () => {
    const report = {
      vulnerabilities: {
        braces: { via: [advisory('braces', '<=3.0.3')] },
        micromatch: { via: ['braces', advisory('braces', '<=3.0.3')] },
        minimist: { via: [advisory('minimist', '<1.2.6', 'moderate')] },
      },
    };
    expect(blockingAdvisories(report).map((entry) => entry.name)).toEqual([
      'braces',
    ]);
  });

  it('reads every installed copy of a package from the lock', () => {
    expect(installedVersions(lock, 'http-cache-semantics').sort()).toEqual([
      '4.1.1',
      '4.2.0',
    ]);
  });

  it('finds the newer release outside the vulnerable range', () => {
    const versionsIn = registry(
      { 'http-cache-semantics': ['4.1.1', '4.2.0', '4.3.0'] },
      { 'http-cache-semantics': ['4.1.1', '4.2.0'] }
    );
    expect(
      fixedVersion(
        advisory('http-cache-semantics', '<=4.2.0'),
        ['4.2.0'],
        versionsIn
      )
    ).toBe('4.3.0');
  });

  it('prefers the closest fixed release to the latest one', () => {
    const versionsIn = registry(
      { '@capacitor/ios': ['7.6.4', '7.6.8', '7.6.9', '8.5.2'] },
      { '@capacitor/ios': ['7.6.4', '7.6.8'] }
    );
    expect(
      fixedVersion(
        advisory('@capacitor/ios', '>=7.0.0 <7.6.9'),
        ['7.6.4'],
        versionsIn
      )
    ).toBe('7.6.9');
  });

  it('needs a fix newer than every installed copy', () => {
    const versionsIn = registry(
      { 'http-cache-semantics': ['4.1.1', '4.2.0', '4.3.0'] },
      { 'http-cache-semantics': ['4.1.1'] }
    );
    expect(
      fixedVersion(
        advisory('http-cache-semantics', '<=4.1.1'),
        ['4.1.1', '4.2.0'],
        versionsIn
      )
    ).toBe('4.3.0');
  });

  it('blocks fixable advisories and only warns about the rest', () => {
    const report = {
      vulnerabilities: {
        braces: { via: [advisory('braces', '<=3.0.3')] },
        'http-cache-semantics': {
          via: [advisory('http-cache-semantics', '<=4.2.0')],
        },
      },
    };
    const versionsIn = registry(
      {
        braces: ['3.0.2', '3.0.3'],
        'http-cache-semantics': ['4.1.1', '4.2.0', '4.3.0'],
      },
      {
        braces: ['3.0.2', '3.0.3'],
        'http-cache-semantics': ['4.1.1', '4.2.0'],
      }
    );
    const { fixable, unfixable } = classify(report, lock, versionsIn);
    expect(fixable.map((entry) => [entry.name, entry.fix])).toEqual([
      ['http-cache-semantics', '4.3.0'],
    ]);
    expect(unfixable.map((entry) => entry.name)).toEqual(['braces']);
  });
});
