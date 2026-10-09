import { describe, it, expect } from 'test-anywhere';
import path, { join } from 'node:path';
import { scan, filterItems } from '../src/scan.js';
import { resolveOptions } from '../src/options.js';
import { makeItem } from '../src/items.js';
import { ShellEnv } from '../src/env/shell.js';
import { ScanPolicy } from '../src/env/policy.js';
import { hostExecutor } from '../src/exec.js';
import {
  age,
  DAY_MS,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';
import { itUnless, notLinux, sandboxed } from './helpers/skip.js';

describe('issue 24 exclusion boundaries', () => {
  for (const pattern of ['/tmp/foo*', '/tmp/foo*/**', 'foo*', '/tmp/foo1']) {
    it(`excludes nested artifacts through ${pattern}`, () => {
      const env = { id: 'host', label: 'fixture' };
      const item = makeItem(env, {
        path: '/tmp/foo1/app/node_modules',
        bytes: 100,
      });
      expect(
        filterItems(
          [item],
          resolveOptions({ minSize: 0, exclude: [pattern] }),
          [],
          path.posix
        )
      ).toEqual([]);
    });
  }

  itUnless(sandboxed)(
    'prunes a matching tree before listing or measuring it',
    async () => {
      const root = tempRoot();
      try {
        const hidden = join(root, 'foo1');
        writeBlob(join(hidden, 'app', '__pycache__', 'code.pyc'));
        age(root, 40 * DAY_MS);
        const env = fixtureEnv(root);
        const listed = [];
        const list = env.list.bind(env);
        env.list = async (dir) => {
          listed.push(dir);
          return list(dir);
        };
        const report = await scan(
          scanInput(env, [root], {
            scanners: ['projects'],
            exclude: [join(root, 'foo*')],
          })
        );
        expect(report.items).toEqual([]);
        expect(listed.some((dir) => dir.startsWith(hidden))).toBe(false);
      } finally {
        removeRoot(root);
      }
    }
  );
});

describe('issues 22, 23 and 26 local container boundaries', () => {
  itUnless(sandboxed)(
    'does not contact Docker with docker:false even when its own ID is known',
    async () => {
      const root = tempRoot();
      try {
        const env = fixtureEnv(root);
        const original = env.readText.bind(env);
        env.readText = async (target, ...args) =>
          target === '/proc/self/cgroup'
            ? `0::/docker/${'a'.repeat(64)}`
            : original(target, ...args);
        env.which = async () => {
          throw new Error('must not discover Docker');
        };
        const report = await scan(scanInput(env, [root], { scanners: [] }));
        expect(report.errors).toEqual([]);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'does not list a nested same-device read-only image mount',
    async () => {
      const root = tempRoot();
      try {
        const mount = join(root, 'image');
        writeBlob(join(mount, '__pycache__', 'code.pyc'));
        const env = fixtureEnv(root);
        env.platform = 'linux';
        env.processes = async () => [];
        env.openPaths = async () => new Set();
        const original = env.readText.bind(env);
        env.readText = async (target, ...args) =>
          target === '/proc/self/mountinfo'
            ? `20 1 0:1 / / rw - ext4 /dev/root rw\n21 20 0:1 / ${mount} ro - overlay overlay ro,lowerdir=/layers`
            : original(target, ...args);
        const report = await scan(
          scanInput(env, [root], { scanners: ['projects'], staleAge: 0 })
        );
        expect(report.items).toEqual([]);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'leaves overlay bytes out of safe totals without Docker access',
    async () => {
      const root = tempRoot();
      try {
        writeBlob(join(root, 'home', '.npm', '_cacache', 'blob'));
        age(root, 40 * DAY_MS);
        const env = fixtureEnv(root);
        env.platform = 'linux';
        env.processes = async () => [];
        env.openPaths = async () => new Set();
        const original = env.readText.bind(env);
        env.readText = async (target, ...args) =>
          target === '/proc/self/mountinfo'
            ? '20 1 0:1 / / rw - overlay overlay rw,lowerdir=/layers,upperdir=/host/upper'
            : original(target, ...args);
        const report = await scan(
          scanInput(env, [root], { scanners: ['global'] })
        );
        const item = report.items.find((entry) => entry.rule === 'npm-cache');
        expect(item.bytes).toBe(0);
        expect(item.sizeUnknown).toBe(true);
        expect(item.totalBytes > 0).toBe(true);
        expect(report.totals.safe.bytes).toBe(0);
      } finally {
        removeRoot(root);
      }
    }
  );
});

describe('shell measurement boundaries', () => {
  itUnless(sandboxed, notLinux)(
    'prunes zero-depth globstars with real Linux shell tools',
    async () => {
      const root = tempRoot();
      try {
        const cache = join(root, 'cache');
        writeBlob(join(cache, 'keep', 'data'));
        for (const suffix of ['keep*', '**/keep', '**/keep/**']) {
          const env = new ShellEnv(hostExecutor());
          env.scanPolicy = new ScanPolicy(
            env,
            {
              roots: [root],
              exclude: [`${cache}/${suffix}`],
            },
            []
          );
          let measured = false;
          env.sh = async () => {
            measured = true;
            throw new Error('measurement crossed an exclusion');
          };
          expect((await env.rawUsageMany([cache])).size).toBe(0);
          expect(measured).toBe(false);
        }
      } finally {
        removeRoot(root);
      }
    }
  );

  for (const boundary of ['excluded', 'mounted', 'runtime']) {
    it(`does not measure a cache containing ${boundary} data`, async () => {
      const calls = [];
      const target = boundary === 'runtime' ? '/tmp' : '/cache';
      const child =
        boundary === 'runtime' ? '/tmp/containerd-mount123' : '/cache/keep';
      const env = new ShellEnv({
        run: async (argv) => {
          calls.push(argv);
          return {
            code: 0,
            stdout: argv[0] === 'find' ? `${child}\n` : '',
            stderr: '',
          };
        },
      });
      env.scanPolicy = new ScanPolicy(
        env,
        {
          roots: [target],
          exclude: boundary === 'excluded' ? ['/cache/keep*'] : [],
        },
        boundary === 'mounted'
          ? [{ path: child, readonly: true, type: 'overlay' }]
          : []
      );
      expect((await env.rawUsageMany([target])).size).toBe(0);
      expect(calls.some((argv) => argv[0] === 'sh')).toBe(false);
      expect(env.scanPolicy.removalReason(target) !== null).toBe(true);
    });
  }
});
