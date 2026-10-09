import { describe, it, expect } from 'test-anywhere';
import path from 'node:path';
import * as storage from '../src/docker/writable.js';
import { DockerCli } from '../src/docker/cli.js';
import { containerGitState } from '../src/docker/containers.js';
const { WritableLayer, sharedWritableLayer } = storage;

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
function fixture({ memory = 1024 * 1024, diff = 'A /cache/new\n' } = {}) {
  const calls = [];
  const executor = {
    label: 'fixture',
    run: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'cat') {
        return ok(`MemAvailable: ${memory} kB`);
      }
      if (argv[1] === 'inspect') {
        return ok(JSON.stringify([{ Id: 'box', Mounts: [] }]));
      }
      if (argv[1] === 'diff') {
        return ok(diff);
      }
      return ok();
    },
  };
  const env = {
    path: path.posix,
    statMany: async (targets) =>
      new Map(
        targets.map((target) => [
          target,
          { type: 'file', bytes: 100, inode: target },
        ])
      ),
  };
  const usages = new Map([['/cache', { bytes: 1000 }]]);
  return { executor, calls, env, usages };
}

describe('issue 21 bounded storage snapshots', () => {
  it('honors a tighter cgroup memory limit than host MemAvailable', async () => {
    const { executor, calls, env, usages } = fixture();
    const run = executor.run;
    executor.run = (argv) =>
      argv[1] === '/sys/fs/cgroup/memory.max'
        ? Promise.resolve(ok(`${1024 ** 3}\n${950 * 1024 ** 2}\n`))
        : run(argv);
    const result = await new WritableLayer(executor, 'box').measure(
      env,
      usages
    );
    expect(calls.some((argv) => argv[1] === 'diff')).toBe(false);
    expect(result.get('/cache').sizeUnknown).toBe(true);
  });

  it('uses metadata already inspected during discovery', async () => {
    const { executor, calls, env, usages } = fixture();
    const layer = new WritableLayer(executor, 'box');
    layer.inspected = { Id: 'box', Mounts: [] };
    await layer.measure(env, usages);
    expect(calls.some((argv) => argv[1] === 'inspect')).toBe(false);
  });

  it('refreshes Git discovery before removal if a new repository was copied into a stopped container', async () => {
    const { executor } = fixture({ diff: '' });
    const docker = new DockerCli(executor);
    await containerGitState(docker, 'box');
    const run = executor.run;
    executor.run = (argv) =>
      argv[1] === 'diff'
        ? Promise.resolve(ok('A /work/.git/HEAD\n'))
        : run(argv);
    docker.pathExists = async () => true;
    docker.copyOut = async () => ({ code: 1, stderr: 'copy denied' });
    const current = await containerGitState(docker, 'box', { fresh: true });
    expect(current.blockers.length > 0).toBe(true);
  });

  it('diffs and inspects only once across repeated and concurrent measurements', async () => {
    const { executor, calls, env, usages } = fixture();
    const layer = new WritableLayer(executor, 'box');
    await Promise.all([layer.measure(env, usages), layer.measure(env, usages)]);
    await layer.measure(env, usages);
    expect(calls.filter((argv) => argv[1] === 'diff').length).toBe(1);
    expect(calls.filter((argv) => argv[1] === 'inspect').length).toBe(1);
  });

  it('shares snapshots by executor and container, without sharing different daemons', () => {
    const { executor } = fixture();
    expect(sharedWritableLayer(executor, 'box')).toBe(
      sharedWritableLayer(executor, 'box')
    );
    expect(
      sharedWritableLayer(executor, 'box') ===
        sharedWritableLayer(fixture().executor, 'box')
    ).toBe(false);
  });

  it('skips a diff with insufficient host headroom', async () => {
    const { executor, calls, env, usages } = fixture({ memory: 100 });
    const result = await new WritableLayer(executor, 'box').measure(
      env,
      usages
    );
    expect(calls.some((argv) => argv[1] === 'diff')).toBe(false);
    expect(result.get('/cache').sizeUnknown).toBe(true);
    expect(result.get('/cache').bytes).toBe(0);
  });

  it('skips a diff before contacting the daemon when the candidate change budget is excessive', async () => {
    const { executor, calls, env, usages } = fixture();
    usages.get('/cache').files = 100001;
    const result = await new WritableLayer(executor, 'box').measure(
      env,
      usages
    );
    expect(calls.some((argv) => argv[1] === 'diff')).toBe(false);
    expect(result.get('/cache').sizeUnknown).toBe(true);
  });

  it('drops deleted paths and cached stats without another diff', async () => {
    const { executor, calls, env, usages } = fixture();
    const layer = new WritableLayer(executor, 'box');
    expect((await layer.measure(env, usages)).get('/cache').bytes).toBe(100);
    layer.forget('/cache/new', path.posix);
    expect((await layer.measure(env, usages)).get('/cache').bytes).toBe(0);
    expect(calls.filter((argv) => argv[1] === 'diff').length).toBe(1);
  });

  it('serializes snapshots even for different executors', async () => {
    let active = 0;
    let maximum = 0;
    const fixtures = [fixture(), fixture()];
    for (const { executor } of fixtures) {
      const run = executor.run;
      executor.run = async (argv) => {
        if (argv[1] !== 'diff') {
          return run(argv);
        }
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = await run(argv);
        active--;
        return result;
      };
    }
    await Promise.all(
      fixtures.map(({ executor, env, usages }) =>
        new WritableLayer(executor, 'box').measure(env, usages)
      )
    );
    expect(maximum).toBe(1);
  });
});
