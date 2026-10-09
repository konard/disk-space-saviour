/**
 * The Deno leg of the test matrix resolves npm packages through deno.lock.
 * When the lock's workspace no longer matches package.json, Deno re-resolves
 * every range on the runner, and that resolution honours Deno's minimum
 * dependency age: a range whose floor was published less than a day ago then
 * fails with "Could not find npm package … matching", even though npm installs
 * it fine. Keeping the lock in step with package.json makes that resolution
 * happen locally, when the lock is regenerated, not in CI.
 */

import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Deno records `^0.y.z` as the equivalent `~0.y.z`.
 * @param {string} range
 * @returns {string}
 */
function normalizeRange(range) {
  return range.replace(/^\^(0\.\d+\.\d+)/, '~$1');
}

/**
 * The `npm:` specifiers Deno derives from package.json.
 * @param {Record<string, Record<string, string>>} packageJson
 * @returns {string[]}
 */
export function expectedWorkspaceSpecifiers(packageJson) {
  return Object.entries({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  })
    .map(([name, range]) => `npm:${name}@${normalizeRange(range)}`)
    .sort();
}

describe('deno.lock', () => {
  it('normalizes 0.x caret ranges the way Deno records them', () => {
    expect(
      expectedWorkspaceSpecifiers({
        devDependencies: { b: '^0.8.48', a: '^1.2.3' },
      })
    ).toEqual(['npm:a@^1.2.3', 'npm:b@~0.8.48']);
  });

  it('records the same dependency ranges as package.json', () => {
    const lock = readJson('deno.lock');
    const recorded = [...lock.workspace.packageJson.dependencies].sort();

    expect(recorded).toEqual(
      expectedWorkspaceSpecifiers(readJson('package.json'))
    );
  });
});
