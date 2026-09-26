import { describe, it, expect } from 'test-anywhere';
import { join } from 'node:path';

import { compareVersions } from '../src/rules/versions.js';
import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  readOnlyRuntime,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

describe('version manager pruning', () => {
  it('compares SDKMAN numeric segments', () => {
    expect(compareVersions('java=21.0.1-tem', 'java=8') > 0).toBe(true);
  });

  it('keeps the newest version in each family and all opam switches', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-versions-');
    try {
      const home = join(root, 'home');
      for (const version of ['3.11.4', '3.12.0', 'anaconda3-2024']) {
        writeBlob(join(home, '.pyenv', 'versions', version, 'bin', 'python'));
      }
      for (const version of ['8', '21.0.1-tem']) {
        writeBlob(
          join(home, '.sdkman', 'candidates', 'java', version, 'bin', 'java')
        );
      }
      for (const name of ['local', 'release']) {
        writeBlob(join(home, '.opam', name, '.opam-switch', 'config'));
      }
      age(root, 40 * DAY_MS);
      const report = await scan(
        scanInput(fixtureEnv(root), [], { scanners: ['versions'] })
      );
      const paths = report.items.map((item) => item.path);
      expect(paths).toContain(join(home, '.pyenv', 'versions', '3.11.4'));
      expect(paths).not.toContain(join(home, '.pyenv', 'versions', '3.12.0'));
      expect(paths).not.toContain(
        join(home, '.pyenv', 'versions', 'anaconda3-2024')
      );
      expect(paths).toContain(join(home, '.sdkman', 'candidates', 'java', '8'));
      expect(paths).not.toContain(
        join(home, '.sdkman', 'candidates', 'java', '21.0.1-tem')
      );
      expect(
        paths.some((target) => target.startsWith(join(home, '.opam')))
      ).toBe(false);
    } finally {
      removeRoot(root);
    }
  });
});
