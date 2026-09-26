/**
 * Docker safety and Docker-in-Docker recursion, against an in-memory Docker
 * world (tests/helpers/fake-docker.js).
 */

import { describe, it, expect } from 'test-anywhere';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  promises as fsp,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
import { assertAllowed, repoRootsFromDiff } from '../src/docker/cli.js';
import {
  containerGitState,
  gitBlockersForRemoval,
  ownerOf,
} from '../src/docker/containers.js';
import { scanDocker } from '../src/docker/scan.js';
import { makeItem } from '../src/items.js';
import { resolveOptions } from '../src/options.js';
import { buildReport } from '../src/scan.js';
import {
  FakeDockerWorld,
  containerId,
  fakeHostEnv,
} from './helpers/fake-docker.js';
import { pushedRepo } from './helpers/fixtures.js';

const LIFECYCLE = new Set([
  'stop',
  'kill',
  'restart',
  'pause',
  'unpause',
  'start',
  'update',
  'container',
]);

function daemonInfo(id, name) {
  return {
    ID: id,
    Name: name,
    ServerVersion: '29.0.0',
    Driver: 'overlay2',
    DockerRootDir: '/var/lib/docker',
  };
}

/**
 * host daemon
 *   solver-1 (running, session s-1, runs a daemon)
 *     inner daemon
 *       build-7 (running, runs a daemon)
 *         deepest daemon
 *           leaf (running)
 *       inner-old (stopped, clean)
 *   old-clean (stopped, no repositories in its layer)
 *   old-dirty (stopped, a repository in its writable layer)
 */
function world() {
  return new FakeDockerWorld({
    host: {
      info: daemonInfo('HOST', 'host-daemon'),
      buildCache: '2GB',
      containers: [
        {
          id: 'a1',
          name: 'solver-1',
          state: 'running',
          labels: { 'hive.session': 's-1' },
          daemon: 'inner',
        },
        {
          id: 'b2',
          name: 'old-clean',
          state: 'exited',
          size: '50MB (virtual 130MB)',
          labels: { 'hive.session': 's-2' },
          diff: 'C /tmp\nA /tmp/out.log\n',
          logs: '2026-09-20T10:00:00Z done\n',
        },
        {
          id: 'c3',
          name: 'old-dirty',
          state: 'exited',
          size: '70MB (virtual 150MB)',
          env: ['SESSION_ID=s-3', 'GITHUB_TOKEN=secret'],
          diff: 'C /work\nA /work/repo\nA /work/repo/.git\nA /work/repo/.git/HEAD\n',
        },
      ],
    },
    inner: {
      info: daemonInfo('INNER', 'inner-daemon'),
      containers: [
        { id: 'd4', name: 'build-7', state: 'running', daemon: 'deepest' },
        {
          id: 'e5',
          name: 'inner-old',
          state: 'exited',
          size: '10MB (virtual 90MB)',
          diff: '',
        },
      ],
    },
    deepest: {
      info: daemonInfo('DEEPEST', 'deepest-daemon'),
      containers: [{ id: 'f6', name: 'leaf', state: 'running' }],
    },
  });
}

/**
 * Deno CI grants read access only, while scans copy container repositories
 * to a local temp dir and cleaning writes backups.
 */
const readOnlyRuntime = () => typeof Deno !== 'undefined';

async function scanWorld(fake, input = {}) {
  const env = fakeHostEnv(fake);
  const options = resolveOptions({ docker: true, ...input });
  const scanned = [];
  const result = await scanDocker(
    { env, executor: env.executor, chain: [] },
    options,
    (inner) => {
      scanned.push(inner.id);
      return Promise.resolve([
        makeItem(inner, {
          rule: 'npm-cache',
          path: '/root/.npm/_cacache',
          bytes: 1e6,
        }),
      ]);
    }
  );
  const report = buildReport({
    options,
    env,
    items: result.items,
    environments: [
      { id: env.id, label: env.label, kind: 'host', depth: 0, chain: [] },
      ...result.environments,
    ],
    docker: result,
    errors: [],
    startedAt: options.now(),
  });
  return { env, result, report, scanned };
}

function lifecycleCalls(fake) {
  return fake
    .dockerCalls()
    .filter(
      (args) =>
        LIFECYCLE.has(args[0]) ||
        (args[0] === 'rm' && args.some((arg) => arg.startsWith('-')))
    );
}

describe('docker command allowlist', () => {
  it('refuses lifecycle commands and forced removal', () => {
    for (const args of [
      ['stop', 'x'],
      ['kill', 'x'],
      ['restart', 'x'],
      ['pause', 'x'],
      ['start', 'x'],
      ['rm', '-f', 'x'],
      ['rm', '--force', 'x'],
      ['rm', '-v', 'x'],
      ['container', 'rm', 'x'],
      ['container', 'prune'],
      ['system', 'prune', '-af'],
      ['volume', 'prune'],
    ]) {
      expect(() => assertAllowed(args)).toThrow();
    }
  });

  it('allows read-only commands and a plain rm', () => {
    for (const args of [
      ['info'],
      ['ps', '--all'],
      ['inspect', 'x'],
      ['logs', 'x'],
      ['system', 'df'],
      ['rm', 'x'],
      ['image', 'prune', '--force'],
      ['builder', 'prune', '--all', '--force'],
    ]) {
      expect(() => assertAllowed(args)).not.toThrow();
    }
  });
});

describe('docker diff and owner parsing', () => {
  it('finds repositories written in the writable layer', () => {
    expect(
      repoRootsFromDiff(
        'A /work/repo/.git\nC /work/repo/.git/index\nA /a/b/.git/HEAD\nC /tmp\n'
      ).sort()
    ).toEqual(['/a/b', '/work/repo']);
  });

  it('reads the session from labels and environment, never secrets', () => {
    const owner = ownerOf(
      { Names: 'box', Image: 'img', Command: '"run"' },
      {
        Config: {
          Labels: { 'hive.session': 'abc', 'owner.password': 'secret' },
          Env: ['ISSUE_URL=https://x/1', 'GITHUB_TOKEN=t', 'PATH=/bin'],
        },
        State: { FinishedAt: 'f' },
      }
    );
    expect(owner.session).toBe('abc');
    expect(owner.hints['env:ISSUE_URL']).toBe(undefined);
    expect(Object.keys(owner.hints)).not.toContain('env:GITHUB_TOKEN');
    expect(Object.keys(owner.hints)).not.toContain('label:owner.password');
    expect(owner.command).toBe('run');
  });

  it('finds edited files in an image repository with an untouched .git', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'dss-docker-untouched-git-'));
    try {
      const repo = pushedRepo(join(root, 'repo'));
      writeFileSync(join(repo, 'README.md'), 'edited in container\n');
      const docker = {
        diff: async () => 'C /workspace/repo/README.md\n',
        pathExists: async (_id, target) =>
          target === '/workspace/repo/.git/HEAD',
        copyOut: async (_id, _source, destination) => {
          await fsp.cp(repo, join(destination, 'repo'), { recursive: true });
          return { code: 0, stderr: '' };
        },
      };
      const state = await containerGitState(docker, 'container');
      expect(state.repos.map((entry) => entry.root)).toEqual([
        '/workspace/repo',
      ]);
      expect(state.blockers.join()).toMatch(/uncommitted change/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks a nested repository even when its parent is already known', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const visited = [];
    const docker = {
      diff: async () =>
        'C /work/parent/.git/index\nC /work/parent/nested/README.md\n',
      pathExists: async (_id, target) =>
        ['/work/parent/.git/HEAD', '/work/parent/nested/.git/HEAD'].includes(
          target
        ),
      copyOut: async (_id, source) => {
        visited.push(source);
        return { code: 1, stderr: 'copy unavailable' };
      },
    };
    await containerGitState(docker, 'container');
    expect(visited).toContain('/work/parent');
    expect(visited).toContain('/work/parent/nested');
  });

  it('requires an exact per-container override for verified dirty Git work', () => {
    const state = {
      blockers: [
        'Git repository /work has 1 uncommitted change',
        'cannot inspect Git metadata near /other',
      ],
    };
    expect(
      gitBlockersForRemoval(state, 'full-id', {
        allowDirtyRepos: true,
      })
    ).toEqual(state.blockers);
    expect(
      gitBlockersForRemoval(state, 'full-id', {
        allowDirtyContainers: ['other-id'],
      })
    ).toEqual(state.blockers);
    expect(
      gitBlockersForRemoval(state, 'full-id', {
        allowDirtyContainers: ['full-id'],
      })
    ).toEqual(['cannot inspect Git metadata near /other']);
  });

  it('blocks changed work hidden by the Git copy exclusions', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const docker = {
      diff: async () =>
        'A /work/repo/.git/HEAD\nA /work/repo/target/notes.txt\n',
      pathExists: async () => false,
      copyOut: async () => ({ code: 1, stderr: 'unavailable' }),
    };
    const state = await containerGitState(docker, 'container');
    expect(state.blockers.join()).toMatch(/excluded folder/);
  });
});

describe('recursive docker scan', () => {
  it('follows Docker-in-Docker to depth 2 and deeper', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const fake = world();
    const { result, scanned } = await scanWorld(fake, { dockerDepth: 3 });

    expect(result.daemons.map((d) => [d.id, d.depth])).toEqual([
      ['HOST', 0],
      ['INNER', 1],
      ['DEEPEST', 2],
    ]);
    expect(scanned).toEqual([
      'host/solver-1',
      'host/solver-1/build-7',
      'host/solver-1/build-7/leaf',
    ]);
    const leaf = result.environments.find((e) => e.id.endsWith('/leaf'));
    expect(leaf.depth).toBe(3);
    expect(leaf.chain.map((link) => link.name)).toEqual([
      'solver-1',
      'build-7',
      'leaf',
    ]);
  });

  it('stops at the depth limit and says so', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const fake = world();
    const { result, scanned } = await scanWorld(fake, { dockerDepth: 1 });

    expect(scanned).toEqual(['host/solver-1']);
    const build = result.containers.find((c) => c.name === 'build-7');
    expect(build.scanned).toBe(false);
    expect(build.note).toContain('Docker depth limit 1');
    expect(
      result.items.some((item) => item.container?.name === 'inner-old')
    ).toBe(false);
  });

  it('lists unattached volumes without offering a delete action', async () => {
    const fake = world();
    fake.daemons.host.volumes = [
      { Name: 'workspace-data', Links: '0', Size: '1GB' },
    ];
    const { result } = await scanWorld(fake, { includeVolumes: true });
    expect(result.volumes.map((volume) => volume.name)).toEqual([
      'workspace-data',
    ]);
    expect(
      result.items.some((item) => item.rule === 'docker-dangling-volume')
    ).toBe(false);
    expect(() => assertAllowed(['volume', 'rm', 'workspace-data'])).toThrow();
  });

  it('never sends a lifecycle command while scanning', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const fake = world();
    await scanWorld(fake, { dockerDepth: 3 });

    expect(lifecycleCalls(fake)).toEqual([]);
    expect(fake.dockerCalls().some((args) => args[0] === 'rm')).toBe(false);
  });

  it('reports stopped containers with size, owner and Git state', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const fake = world();
    const { result } = await scanWorld(fake, {
      dockerDepth: 3,
      removeStoppedContainers: true,
    });
    const stopped = result.items.filter(
      (item) => item.rule === 'docker-stopped-container'
    );
    const byName = new Map(stopped.map((item) => [item.container.name, item]));

    expect([...byName.keys()].sort()).toEqual([
      'inner-old',
      'old-clean',
      'old-dirty',
    ]);
    const cleanOne = byName.get('old-clean');
    expect(cleanOne.bytes).toBe(50e6);
    expect(cleanOne.container.owner.session).toBe('s-2');
    expect(cleanOne.requiresConfirmation).toBe('removeStoppedContainers');
    expect(cleanOne.blockers).toEqual([]);
    expect(byName.get('inner-old').env).toBe('host/solver-1');

    const dirty = byName.get('old-dirty');
    expect(dirty.container.owner.session).toBe('s-3');
    expect(dirty.container.repos.map((repo) => repo.root)).toEqual([
      '/work/repo',
    ]);
    expect(dirty.blockers.length).toBe(1);
    expect(dirty.blockers[0]).toContain('/work/repo (in container)');
  });

  it('marks running containers as scanned, never as items', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const fake = world();
    const { result } = await scanWorld(fake, { dockerDepth: 3 });

    const running = result.containers.filter((c) => c.state === 'running');
    expect(running.every((c) => c.scanned)).toBe(true);
    expect(
      result.items.some(
        (item) =>
          item.kind === 'container' &&
          running.some((c) => c.id === item.container.id)
      )
    ).toBe(false);
    expect(running.find((c) => c.name === 'solver-1').owner.session).toBe(
      's-1'
    );
  });
});

function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), 'dss-docker-test-'));
  return { root, backupDir: join(root, 'backups') };
}

describe('cleaning stopped containers', () => {
  it('keeps stopped containers without explicit consent', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const fake = world();
    const { env, report } = await scanWorld(fake, { dockerDepth: 3 });
    const audit = await clean(report, {
      env,
      tier: 'moderate',
      audit: false,
    });

    const entries = audit.entries.filter((e) => e.kind === 'container');
    expect(entries.length).toBe(3);
    for (const entry of entries) {
      expect(entry.status).toBe('skipped');
      expect(entry.reason).toContain('--remove-stopped-containers');
    }
    expect(fake.dockerCalls().some((args) => args[0] === 'rm')).toBe(false);
  });

  it('plans but does not remove in a dry run', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const fake = world();
    const { env, report } = await scanWorld(fake, { dockerDepth: 3 });
    const audit = await clean(report, {
      env,
      tier: 'moderate',
      only: ['docker'],
      dryRun: true,
      removeStoppedContainers: true,
      audit: false,
    });

    const planned = audit.entries.filter((e) => e.status === 'planned');
    expect(planned.map((e) => e.rule).sort()).toEqual([
      'docker-build-cache',
      'docker-stopped-container',
      'docker-stopped-container',
    ]);
    expect(audit.plannedBytes).toBe(2e9 + 50e6 + 10e6);
    expect(fake.dockerCalls().some((args) => args[0] === 'rm')).toBe(false);
  });

  it('backs up logs, then removes only verified stopped containers', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const fake = world();
    const { env, report } = await scanWorld(fake, { dockerDepth: 3 });
    const { root, backupDir } = tempDirs();
    try {
      const audit = await clean(report, {
        env,
        tier: 'moderate',
        only: ['docker-stopped-container'],
        removeStoppedContainers: true,
        backupDir,
        audit: false,
      });
      const removed = audit.entries.filter((e) => e.status === 'removed');

      expect(removed.map((e) => e.description).sort()).toEqual([
        'stopped container inner-old (ubuntu:24.04)',
        'stopped container old-clean (ubuntu:24.04)',
      ]);
      const rmCalls = fake.dockerCalls().filter((args) => args[0] === 'rm');
      expect(rmCalls).toEqual([
        ['rm', containerId('b2')],
        ['rm', containerId('e5')],
      ]);
      expect(lifecycleCalls(fake)).toEqual([]);

      const backup = removed.find((e) =>
        e.description.includes('old-clean')
      ).backup;
      expect(existsSync(join(backup, 'inspect.json'))).toBe(true);
      expect(readFileSync(join(backup, 'stdout.log'), 'utf8')).toBe(
        '2026-09-20T10:00:00Z done\n'
      );
      expect(audit.environments['host/solver-1'].removed).toBe(1);
      expect(audit.environments.host.removed).toBe(1);
      expect(fake.daemons.host.containers.map((c) => c.name).sort()).toEqual([
        'old-dirty',
        'solver-1',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a container alone when it started again after the scan', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const fake = world();
    const { env, report } = await scanWorld(fake, { dockerDepth: 1 });
    fake.daemons.host.containers.find((c) => c.name === 'old-clean').state =
      'running';
    const { root, backupDir } = tempDirs();
    try {
      const audit = await clean(report, {
        env,
        tier: 'moderate',
        only: ['docker-stopped-container'],
        removeStoppedContainers: true,
        backupDir,
        audit: false,
      });
      const entry = audit.entries.find((e) =>
        e.description.includes('old-clean')
      );

      expect(entry.status).toBe('skipped');
      expect(entry.reason).toBe('container is running now, left alone');
      expect(
        fake
          .dockerCalls()
          .some((args) => args.includes(containerId('b2')) && args[0] === 'rm')
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('asks the confirm callback when the flag is missing', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const fake = world();
    const { env, report } = await scanWorld(fake, { dockerDepth: 1 });
    const { root, backupDir } = tempDirs();
    const asked = [];
    try {
      const audit = await clean(report, {
        env,
        tier: 'moderate',
        only: ['docker-stopped-container'],
        backupDir,
        audit: false,
        confirm: (item) => {
          asked.push(item.container.owner.session);
          return false;
        },
      });

      expect(asked).toEqual(['s-3', 's-2']);
      expect(audit.entries.every((e) => e.status === 'skipped')).toBe(true);
      expect(fake.dockerCalls().some((args) => args[0] === 'rm')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
