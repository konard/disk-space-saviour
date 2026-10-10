import { describe, it, expect } from 'test-anywhere';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { startAudit, writeAudit } from '../src/audit.js';
import { removeRoot, tempRoot } from './helpers/fixtures.js';

describe('issue 39 scan audit failures', () => {
  it('prints the JSON report and a warning when the audit directory is unusable', async () => {
    const root = tempRoot();
    const file = join(root, 'file');
    writeFileSync(file, 'not a directory');
    const report = {
      createdAt: '2026-10-10T00:00:00Z',
      durationMs: 1,
      totals: {},
      environments: [],
      errors: [],
      items: [],
    };
    const out = [],
      err = [];
    try {
      const code = await runCli(
        ['scan', '--json', '--audit-dir', join(file, 'audit')],
        {
          api: { scan: async () => report },
          io: {
            stdout: (text) => out.push(text),
            stderr: (text) => err.push(text),
          },
        }
      );
      expect(code).toBe(0);
      expect(JSON.parse(out[0]).items).toEqual([]);
      expect(err.join('\n')).toMatch(/Audit log: not written.*ENOTDIR/);
    } finally {
      removeRoot(root);
    }
  });
  it('keeps destructive cleanup audit writes strict', async () => {
    const root = tempRoot();
    const file = join(root, 'file');
    writeFileSync(file, 'not a directory');
    try {
      let failure;
      try {
        await writeAudit(startAudit('clean'), {
          auditDir: join(file, 'audit'),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure.code).toBe('ENOTDIR');
    } finally {
      removeRoot(root);
    }
  });
});
