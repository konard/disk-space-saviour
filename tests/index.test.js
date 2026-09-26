/**
 * Library entry point: the public surface exported by src/index.js.
 */

import { describe, it, expect } from 'test-anywhere';
import * as dss from '../src/index.js';

describe('library entry point', () => {
  it('exports scan, clean and emergency', () => {
    expect(typeof dss.scan).toBe('function');
    expect(typeof dss.clean).toBe('function');
    expect(typeof dss.emergency).toBe('function');
    expect(typeof dss.runCli).toBe('function');
  });

  it('orders tiers from safest to most aggressive', () => {
    expect(dss.TIERS).toEqual(['safe', 'moderate', 'aggressive']);
  });

  it('exposes the report and option helpers', () => {
    expect(typeof dss.formatReport).toBe('function');
    expect(typeof dss.formatAudit).toBe('function');
    expect(typeof dss.resolveOptions).toBe('function');
    expect(dss.parseSize('1K')).toBe(1024);
  });

  it('defaults to the safe tier without removing stopped containers', () => {
    expect(dss.DEFAULTS.tier).toBe('safe');
    expect(dss.DEFAULTS.yes).toBe(false);
    expect(dss.DEFAULTS.removeStoppedContainers).toBe(false);
    expect(dss.DEFAULTS.allowDirtyRepos).toBe(false);
  });
});
