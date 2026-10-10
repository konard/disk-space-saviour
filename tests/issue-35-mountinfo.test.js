import { describe, expect } from 'test-anywhere';
import { hostExecutor } from '../src/exec.js';
import { WritableLayer } from '../src/docker/writable.js';
import { upperdirBytes } from '../src/docker/upperdir.js';
import { Cleaner } from '../src/clean.js';
import { makeItem } from '../src/items.js';
import { resolveOptions } from '../src/options.js';
import { existsSync, rmSync } from 'node:fs';
import { itUnless, sandboxed, notLinux } from './helpers/skip.js';
import {
  fixtureEnv,
  tempRoot,
  removeRoot,
  writeBlob,
} from './helpers/fixtures.js';
import { join } from 'node:path';

describe('issue 35 containerd writable storage', () => {
  itUnless(sandboxed, notLinux)(
    'finds the authoritative root upperdir when GraphDriver is null',
    async () => {
      const root = tempRoot(),
        upper = join(root, 'upper space'),
        env = fixtureEnv(root);
      writeBlob(join(upper, 'root/cache/blob'), 8192);
      const local = hostExecutor(),
        calls = [];
      const executor = {
        label: 'daemon',
        run: (argv, options) => {
          calls.push(argv);
          if (argv[0] === 'docker') {
            return Promise.resolve({
              code: 0,
              stdout: JSON.stringify([
                {
                  Id: 'c',
                  State: { Pid: 42 },
                  GraphDriver: null,
                  Mounts: [],
                  Config: { Image: 'image' },
                },
              ]),
              stderr: '',
            });
          }
          if (argv.includes('/proc/42/mountinfo')) {
            return Promise.resolve({
              code: 0,
              stdout: `1 0 0:1 / / rw - overlay overlay rw,lowerdir=/lower,upperdir=${upper.replaceAll(' ', '\\040')},workdir=/work\n`,
              stderr: '',
            });
          }
          return local.run(argv, options);
        },
      };
      try {
        const layer = new WritableLayer(executor, 'c');
        const measured = await layer.measure(
          env,
          new Map([
            ['/root/cache', { bytes: 32768, files: 2 }],
            ['/root/image-only', { bytes: 8192, files: 1 }],
          ])
        );
        expect(measured.get('/root/cache').bytes > 0).toBe(true);
        expect(measured.get('/root/image-only').bytes).toBe(0);
        expect(measured.get('/root/image-only').imageBytes).toBe(8192);
        expect(measured.get('/root/cache').sizeUnknown).toBe(false);
        expect(layer.source).toBe('mountinfo-upperdir');
        expect(calls.some((argv) => argv[1] === 'diff')).toBe(false);
      } finally {
        removeRoot(root);
      }
    }
  );
});
describe('issue 35 containerd cleanup', () => {
  itUnless(sandboxed, notLinux)(
    'batches idle writable paths, preserves open paths and measures reclaimed blocks',
    async () => {
      const root = tempRoot(),
        env = fixtureEnv(root),
        upper = join(root, 'upper');
      env.kind = 'container';
      const paths = ['a', 'b', 'busy'].map((name) => join(root, 'cache', name));
      const upperPath = (target) => `${upper}/${target.replace(/^\/+/, '')}`;
      for (const target of paths) {
        writeBlob(join(target, 'data'), 8192);
        writeBlob(join(upperPath(target), 'data'), 4096);
      }
      const host = hostExecutor();
      const executor = {
        label: 'daemon',
        run: (argv, options) =>
          argv[0] === 'cat'
            ? Promise.resolve({
                code: 0,
                stdout: `1 0 0:1 / / rw - overlay overlay rw,upperdir=${upper},workdir=/work\n`,
                stderr: '',
              })
            : host.run(argv, options),
      };
      const layer = new WritableLayer(executor, 'box');
      layer.inspected = {
        Id: 'box',
        State: { Pid: 42 },
        GraphDriver: null,
        Mounts: [],
      };
      env.writableLayer = layer;
      env.processes = async () => [];
      env.openPaths = async () => new Set([join(paths[2], 'data')]);
      const removals = [];
      env.remove = async (selected) => {
        removals.push(selected);
        for (const target of selected) {
          rmSync(target, { recursive: true, force: true });
          rmSync(upperPath(target), { recursive: true, force: true });
        }
      };
      const item = makeItem(env, {
        rule: 'fixture',
        paths,
        path: paths[0],
        bytes: 50000,
        checks: { perPath: true, mtime: false },
      });
      const cleaner = new Cleaner(
        { environments: [{ id: env.id, chain: [] }], options: {} },
        resolveOptions({ env, docker: false, audit: false, staleAge: 0 })
      );
      try {
        const before = await upperdirBytes(
          host,
          paths.slice(0, 2).map(upperPath)
        );
        const entry = await cleaner.process(item);
        expect(entry.status).toBe('removed');
        expect(removals.length).toBe(1);
        expect(entry.deletedPaths).toEqual(paths.slice(0, 2));
        expect(entry.freedBytes).toBe(
          [...before.values()].reduce((sum, bytes) => sum + bytes, 0)
        );
        expect(existsSync(paths[2])).toBe(true);
      } finally {
        removeRoot(root);
      }
    }
  );
  itUnless(sandboxed, notLinux)(
    'never deletes an image-only cache with a containerd upperdir',
    async () => {
      const root = tempRoot(),
        env = fixtureEnv(root),
        cache = join(root, 'cache');
      writeBlob(join(cache, 'lower-layer'), 8192);
      const layer = new WritableLayer(hostExecutor(), 'box');
      layer.snapshot = async () => ({
        container: { Mounts: [] },
        upperdir: root,
      });
      env.writableLayer = layer;
      env.processes = async () => [];
      env.openPaths = async () => new Set();
      const item = makeItem(env, {
        rule: 'fixture',
        path: cache,
        bytes: 8192,
        checks: { mtime: false },
      });
      const cleaner = new Cleaner(
        { environments: [{ id: env.id, chain: [] }], options: {} },
        resolveOptions({ env, docker: false, audit: false })
      );
      try {
        const entry = await cleaner.process(item);
        expect(entry.status).toBe('skipped');
        expect(entry.reason).toMatch(/image layer/);
        expect(existsSync(cache)).toBe(true);
      } finally {
        removeRoot(root);
      }
    }
  );
});
