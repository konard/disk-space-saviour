// Minimal reproduction for test-anywhere: on Deno, describe.skip registers
// nothing, so the summary lists no ignored suite while Node and Bun report it
// as skipped. Not named *.test.* so the suite runners leave it out; run it with
// node --test, bun test ./<file> or deno test <file>.
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
