import { describe, expect } from 'test-anywhere';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

describe('agent snapshot stores', () => {
  itUnless(sandboxed)(
    'protects a recorded worktree that is not visible from the host',
    async () => {
      const root = tempRoot('dss-agent-store-');
      try {
        const data = join(root, 'home', '.local', 'share', 'opencode');
        writeBlob(join(data, 'snapshot', 'old', 'objects', 'data'));
        const record = writeBlob(join(data, 'storage', 'project', 'old.json'));
        writeFileSync(
          record,
          JSON.stringify({ worktree: '/container/workspace' })
        );
        age(root, 40 * DAY_MS);
        writeBlob(join(data, 'snapshot', 'new', 'objects', 'data'));
        const env = fixtureEnv(root);
        const input = scanInput(env, [], { scanners: ['agents'] });
        const first = await scan(input);
        expect(
          first.items.some(
            (item) => item.path === join(data, 'snapshot', 'old')
          )
        ).toBe(false);
        rmSync(record);
        const second = await scan(input);
        expect(
          second.items.find(
            (item) => item.path === join(data, 'snapshot', 'old')
          )?.tier
        ).toBe('moderate');
      } finally {
        removeRoot(root);
      }
    }
  );
});
