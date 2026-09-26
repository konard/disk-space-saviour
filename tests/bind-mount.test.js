import { describe, it, expect } from 'test-anywhere';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
import { isHostBindSource } from '../src/docker/containers.js';
import { scan } from '../src/scan.js';
import { FakeDockerWorld } from './helpers/fake-docker.js';
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

describe('running Docker bind mounts', () => {
  it('recognizes absolute Windows and Unix sources', () => {
    expect(isHostBindSource('C:\\workspace\\project')).toBe(true);
    expect(isHostBindSource('/workspace/project')).toBe(true);
    expect(isHostBindSource('project')).toBe(false);
  });

  it('blocks host deletion at scan time and when a mount appears before clean', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = tempRoot('dss-bind-mount-');
    try {
      const project = join(root, 'app');
      const moduleFile = writeBlob(
        join(project, 'node_modules', 'pkg', 'index.js')
      );
      writeFileSync(join(project, 'package.json'), '{}');
      writeFileSync(join(project, 'package-lock.json'), '{}');
      age(root, 40 * DAY_MS);
      const container = {
        id: 'a1',
        name: 'service',
        state: 'running',
        mounts: [],
      };
      const world = new FakeDockerWorld({
        host: {
          info: { ID: 'HOST', Name: 'host', DockerRootDir: '/var/lib/docker' },
          containers: [container],
        },
      });
      const env = fixtureEnv(root);
      env.processes = async () => [];
      env.openPaths = async () => new Set();
      env.executor = world.executor();
      const which = env.which.bind(env);
      env.which = (name) =>
        name === 'docker' ? Promise.resolve(true) : which(name);
      const input = scanInput(env, [root], {
        scanners: ['projects'],
        docker: true,
      });
      container.mounts = [
        { Type: 'bind', Source: project, Destination: '/app' },
      ];
      const blocked = await scan(input);
      expect(
        blocked.items
          .find((item) => item.rule === 'node-modules')
          ?.blockers.join()
      ).toMatch(/bind-mounted/);
      container.mounts = [];
      const report = await scan(input);
      container.mounts = [
        { Type: 'bind', Source: project, Destination: '/app' },
      ];
      const audit = await clean(report, {
        env,
        tier: 'moderate',
        audit: false,
      });
      expect(
        audit.entries.find((entry) => entry.rule === 'node-modules')?.reason
      ).toMatch(/bind-mounted/);
      expect(existsSync(moduleFile)).toBe(true);
    } finally {
      removeRoot(root);
    }
  });
});
