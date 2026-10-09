// Minimal reproduction for test-anywhere: on Deno, describe.skip registers
// nothing, so the skipped suite is missing from the summary instead of being
// reported as ignored. Run with: node --test / bun test / deno test <file>
import { describe, it, expect } from 'test-anywhere';

describe('runs', () => {
  it('counted as passed', () => {
    expect(1).toBe(1);
  });
});

describe.skip('skipped suite', () => {
  it('should be reported as skipped', () => {
    expect(1).toBe(2);
  });
});

it.skip('skipped test', () => {
  expect(1).toBe(2);
});
