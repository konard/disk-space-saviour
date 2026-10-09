import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';

// npm 11.19 (bundled with Node.js 24.21) warns on every `npm ci` about each
// locked package whose install script is not covered by `allowScripts`.
// With `strict-allow-scripts` off (the default) the scripts still run, so the
// warning is pure noise in CI - until someone turns strict mode on and the
// install silently skips them. Keeping the policy in step with the lockfile
// makes the review explicit and keeps the CI logs free of the warning.
const PROJECTS = ['.', 'examples/universal-app'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function packagesWithInstallScripts(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path !== '' && entry.hasInstallScript)
    .map(([path]) => path.slice(path.lastIndexOf('node_modules/') + 13));
}

function coveredNames(allowScripts = {}) {
  // Keys are either a bare name or a pinned `name@version`; a scoped name
  // starts with `@`, so the version separator is the last `@` after index 0.
  return new Set(
    Object.keys(allowScripts).map((key) => {
      const at = key.lastIndexOf('@');
      return at > 0 ? key.slice(0, at) : key;
    })
  );
}

describe('install-script policy', () => {
  for (const project of PROJECTS) {
    it(`${project} reviews every locked install script in allowScripts`, () => {
      const manifest = readJson(`${project}/package.json`);
      const lock = readJson(`${project}/package-lock.json`);
      const covered = coveredNames(manifest.allowScripts);
      const missing = packagesWithInstallScripts(lock).filter(
        (name) => !covered.has(name)
      );

      expect(missing).toEqual([]);
    });

    it(`${project} has no allowScripts entry for a package that is not locked`, () => {
      const manifest = readJson(`${project}/package.json`);
      const lock = readJson(`${project}/package-lock.json`);
      const locked = new Set(packagesWithInstallScripts(lock));
      const stale = [...coveredNames(manifest.allowScripts)].filter(
        (name) => !locked.has(name)
      );

      expect(stale).toEqual([]);
    });
  }
});
