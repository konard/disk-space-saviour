/**
 * Tier selection, nesting and totals of report items, plus size, duration
 * and percentage parsing.
 */

import { describe, it, expect } from 'test-anywhere';

import {
  block,
  dropNested,
  makeItem,
  selectByTier,
  tierRank,
  tierTotals,
} from '../src/items.js';
import {
  formatBytes,
  formatDuration,
  parseDuration,
  parsePercent,
  parseSize,
} from '../src/units.js';

const HOST = { id: 'host', label: 'host' };
const INNER = { id: 'inner', label: 'container' };

const item = (path, tier, bytes, fields = {}) =>
  makeItem(HOST, { rule: 'r', path, tier, bytes, ...fields });

describe('tier selection', () => {
  const cache = item('/home/u/.cache/pip', 'safe', 10);
  const modules = item('/w/app/node_modules', 'moderate', 100);
  const inner = item('/w/app/node_modules/.cache', 'safe', 5);
  const recent = item('/w/new/node_modules', 'aggressive', 1000);
  const busy = block(item('/w/busy/target', 'safe', 7), 'busy: cargo');
  const items = [cache, modules, inner, recent, busy];

  it('ranks tiers and rejects unknown ones', () => {
    expect(tierRank('safe')).toBe(0);
    expect(tierRank('aggressive')).toBe(2);
    expect(() => tierRank('nuclear')).toThrow();
  });

  it('includes lower tiers and never blocked items', () => {
    const ids = (tier) => selectByTier(items, tier).map((i) => i.path);
    expect(ids('safe')).toEqual([cache.path, inner.path]);
    expect(ids('moderate')).toEqual([cache.path, modules.path]);
    expect(ids('aggressive')).toEqual([cache.path, modules.path, recent.path]);
  });

  it('drops items inside another item of the same environment', () => {
    const elsewhere = makeItem(INNER, {
      rule: 'r',
      path: '/w/app/node_modules/.cache',
    });
    const child = item('/x/deps', 'safe', 1, { parentId: modules.id });
    expect(
      dropNested([modules, inner, elsewhere, child]).map((i) => i.id)
    ).toEqual([modules.id, elsewhere.id]);
  });

  it('counts nested items once in cumulative totals', () => {
    const totals = tierTotals(items);
    expect(totals.safe).toEqual({ items: 2, bytes: 15 });
    expect(totals.moderate).toEqual({ items: 2, bytes: 110 });
    expect(totals.aggressive).toEqual({ items: 3, bytes: 1110 });
    expect(totals.blocked).toEqual({ items: 1, bytes: 7 });
  });

  it('adds each blocker once', () => {
    const target = item('/t', 'safe', 1);
    block(target, 'dirty');
    block(target, 'dirty');
    block(target, '');
    expect(target.blockers).toEqual(['dirty']);
  });
});

describe('units', () => {
  it('parses binary sizes', () => {
    expect(parseSize('20G')).toBe(20 * 1024 ** 3);
    expect(parseSize('1.5 MiB')).toBe(1.5 * 1024 ** 2);
    expect(parseSize(1024)).toBe(1024);
    expect(() => parseSize('lots')).toThrow();
  });

  it('parses durations and percentages', () => {
    expect(parseDuration('1h')).toBe(3600e3);
    expect(parseDuration('30d')).toBe(30 * 86400e3);
    expect(parseDuration(90)).toBe(90e3);
    expect(() => parseDuration('soon')).toThrow();
    expect(parsePercent('80%')).toBe(80);
    expect(() => parsePercent('120%')).toThrow();
  });

  it('formats bytes and durations', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(27.7 * 1024 ** 3)).toBe('27.7 GiB');
    expect(formatBytes(NaN)).toBe('unknown');
    expect(formatDuration(90e3)).toBe('1m');
    expect(formatDuration(3 * 86400e3)).toBe('3d');
    expect(formatDuration(250)).toBe('250ms');
  });
});
