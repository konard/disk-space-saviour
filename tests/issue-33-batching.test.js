import { describe, it, expect } from 'test-anywhere';
import { ShellEnv } from '../src/env/shell.js';
import { LivenessProbe } from '../src/liveness.js';
import { analyzeRustProfile } from '../src/scanners/rust.js';

const targets = Array.from(
  { length: 1000 },
  (_, i) => `/repo/target/debug/.fingerprint/crate-${i}`
);

describe('issue 33 bounded remote round trips', () => {
  it('analyzes a 1000-fingerprint fixture with fewer than 40 transport calls', async () => {
    const profile = '/repo/target/debug',
      now = Date.now();
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      name: `crate-${i.toString(16).padStart(16, '0')}`,
      seconds: Math.floor((now - (i === 999 ? 86400000 : 864000000)) / 1000),
    }));
    const byPath = new Map(
      entries.map((entry) => [`${profile}/.fingerprint/${entry.name}`, entry])
    );
    let calls = 0;
    const env = new ShellEnv({
      label: 'counted transport',
      run: (argv) => {
        calls++;
        const script = argv[2],
          paths = argv.slice(4);
        let stdout = '';
        for (const target of paths) {
          const entry = byPath.get(target);
          if (script.includes('cd --')) {
            stdout += `\u0001${target}\n`;
            if (target.endsWith('/.fingerprint')) {
              stdout += entries
                .map((e) => `directory|4096|8|512|${e.seconds}|${e.name}\n`)
                .join('');
            } else if (entry) {
              stdout += `regular file|512|8|512|${entry.seconds}|lib-crate.json\n`;
            }
          } else if (script.includes('du -skx')) {
            stdout += `\u0001${target}\n8\n1 ${entry.seconds}\n${entry.seconds}\n`;
          } else if (script.includes('head -c') && target.startsWith('/')) {
            stdout += `\u0001${target}\n{"target":1,"profile":1}\n`;
          } else if (script.includes('readlink -f')) {
            stdout += `\u0001${target}\n${target}\n`;
          }
        }
        return Promise.resolve({ code: 0, stdout, stderr: '' });
      },
    });
    env.scanPolicy = {
      exclude: [],
      pruned: [],
      excludedPaths: new Set(),
      removalReason: () => null,
    };
    const result = await analyzeRustProfile(env, profile, {
      staleAgeMs: 0,
      now,
    });
    await new LivenessProbe(env, { staleAgeMs: 0 }).resolve(
      result.entries.map((entry) => entry.path)
    );
    expect(result.removed).toBe(999);
    expect(calls < 40).toBe(true);
  });
  it('resolves 1000 fingerprint paths in five transport batches', async () => {
    let calls = 0;
    const env = new ShellEnv({
      label: 'remote',
      run: () => {
        calls++;
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    });
    await new LivenessProbe(env, { staleAgeMs: 0 }).resolve(targets);
    expect(calls <= 5).toBe(true);
  });
  it('batches exclusion boundary probes as well as usage measurement', async () => {
    let calls = 0;
    const env = new ShellEnv({
      label: 'remote',
      run: () => {
        calls++;
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    });
    env.scanPolicy = {
      exclude: [],
      pruned: [],
      excludedPaths: new Set(),
      removalReason: () => null,
    };
    await env.rawUsageMany(targets);
    expect(calls <= 10).toBe(true);
  });
});
