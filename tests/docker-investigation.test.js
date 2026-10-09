/**
 * Stopped containers show who owned them and how they ended; a container
 * that failed or was OOM killed is kept for investigation and removed only
 * when it is named with `--remove-container`.
 */

import { describe, it, expect } from 'test-anywhere';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
import {
  containerNamed,
  exitReason,
  investigationBlocker,
  ownerOf,
} from '../src/docker/containers.js';
import { formatReport } from '../src/report.js';
import {
  FakeDockerWorld,
  containerId,
  daemonInfo,
  scanWorld,
} from './helpers/fake-docker.js';
import { itUnless, sandboxed } from './helpers/skip.js';

const SESSION = '6f1c2a3b-0d4e-4f5a-8b6c-7d8e9f0a1b2c';
const TASK = 'https://github.com/o/r/issues/1';

/**
 * host daemon
 *   oom-task (exited 137, OOM killed, owned by a hive-mind session)
 *   done-task (exited 0)
 */
function world() {
  return new FakeDockerWorld({
    host: {
      info: daemonInfo('HOST', 'host-daemon'),
      containers: [
        {
          id: 'a1',
          name: 'oom-task',
          state: 'exited',
          size: '40MB (virtual 120MB)',
          exitCode: 137,
          oomKilled: true,
          env: [
            'SESSION_ID=other',
            `HIVE_MIND_PARENT_SESSION_ID=${SESSION}`,
            `ISSUE_URL=${TASK}`,
          ],
          diff: '',
        },
        {
          id: 'b2',
          name: 'done-task',
          state: 'exited',
          size: '20MB (virtual 100MB)',
          diff: '',
        },
      ],
    },
  });
}

const inspected = (state, env = []) => ({
  State: { Status: 'exited', FinishedAt: '2026-09-20T10:00:00Z', ...state },
  Config: { Labels: {}, Env: env },
});

describe('stopped container owner', () => {
  it('shows the session, task URL and how the container ended', () => {
    const owner = ownerOf(
      { Names: 'oom-task' },
      inspected({ ExitCode: 137, OOMKilled: true }, [
        'SESSION_ID=other',
        `HIVE_MIND_PARENT_SESSION_ID=${SESSION}`,
        `ISSUE_URL=${TASK}`,
        'TASK_URL=https://ghp_secret@example.com/x',
      ])
    );
    expect(owner.session).toBe(SESSION);
    expect(owner.sessionSource).toBe('env:HIVE_MIND_PARENT_SESSION_ID');
    expect(owner.taskUrl).toBe(TASK);
    expect(owner.exitCode).toBe(137);
    expect(owner.oomKilled).toBe(true);
    expect(owner.exitReason).toBe('killed: out of memory');
    expect(owner.finishedAt).toBe('2026-09-20T10:00:00Z');
  });

  it('falls back to a session id in the container name', () => {
    const owner = ownerOf(
      { Names: `solve-${SESSION}` },
      inspected({ ExitCode: 0 })
    );
    expect(owner.session).toBe(SESSION);
    expect(owner.sessionSource).toBe('name');
    expect(owner.exitReason).toBe('completed');
  });

  it('reports no exit code for a running container', () => {
    const owner = ownerOf(
      { Names: 'live' },
      { State: { Status: 'running', ExitCode: 0 } }
    );
    expect(owner.exitCode).toBe(null);
    expect(owner.exitReason).toBe(null);
  });

  it('explains the exit code', () => {
    const ended = (state) => exitReason({ Status: 'exited', ...state });
    expect(ended({ ExitCode: 1 })).toBe('failed with exit code 1');
    expect(ended({ ExitCode: 143 })).toBe('killed by signal 15');
    expect(ended({ ExitCode: 127, Error: 'exec: not found' })).toBe(
      'exec: not found'
    );
  });
});

describe('containers kept for investigation', () => {
  const id = containerId('a1');

  it('holds failed and OOM killed containers until they are named', () => {
    const state = { ExitCode: 137, OOMKilled: true };
    expect(investigationBlocker(state, id, 'oom-task')).toBe(
      'kept for investigation (exit 137, OOM killed); ' +
        `remove it only with --remove-container ${id.slice(0, 12)}`
    );
    expect(investigationBlocker({ ExitCode: 0 }, id, 'oom-task')).toBe(null);
    for (const name of ['oom-task', '/oom-task', id, id.slice(0, 12)]) {
      expect(
        investigationBlocker(state, id, 'oom-task', {
          removeContainers: [name],
        })
      ).toBe(null);
    }
  });

  it('never matches a short id prefix', () => {
    expect(containerNamed(['a1'], id, 'oom-task')).toBe(false);
    expect(containerNamed(undefined, id, 'oom-task')).toBe(false);
  });

  itUnless(sandboxed)(
    'reports the owner and the hold in the scan',
    async () => {
      const { result, report } = await scanWorld(world());
      const byName = new Map(
        result.items.map((item) => [item.container.name, item])
      );
      const oom = byName.get('oom-task');
      expect(oom.blockers.length).toBe(1);
      expect(oom.blockers[0]).toContain('kept for investigation');
      expect(byName.get('done-task').blockers).toEqual([]);

      const text = formatReport(report);
      expect(text).toContain(`session ${SESSION}`);
      expect(text).toContain(
        'exit 137 (killed: out of memory), OOM killed, ended 2026-09-20T10:00:00Z'
      );
      expect(text).toContain(`task ${TASK}`);
      expect(text).toContain('--remove-container a10000000000');
    }
  );

  itUnless(sandboxed)(
    'keeps it even with --remove-stopped-containers',
    async () => {
      const fake = world();
      const { env, report } = await scanWorld(fake);
      const dir = mkdtempSync(join(tmpdir(), 'dss-investigation-'));
      try {
        const audit = await clean(report, {
          env,
          tier: 'moderate',
          only: ['docker-stopped-container'],
          removeStoppedContainers: true,
          backupDir: join(dir, 'backups'),
          audit: false,
        });
        expect(
          audit.entries.map((entry) => [entry.description, entry.status])
        ).toEqual([['stopped container done-task (ubuntu:24.04)', 'removed']]);
        expect(
          fake.daemons.host.containers.map((container) => container.name)
        ).toEqual(['oom-task']);
        expect(fake.dockerCalls().filter((args) => args[0] === 'rm')).toEqual([
          ['rm', containerId('b2')],
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  itUnless(sandboxed)(
    'removes only the container named with --remove-container',
    async () => {
      const fake = world();
      const { env, report } = await scanWorld(fake);
      const dir = mkdtempSync(join(tmpdir(), 'dss-investigation-'));
      try {
        const audit = await clean(report, {
          env,
          tier: 'moderate',
          only: ['docker-stopped-container'],
          removeContainers: [containerId('a1').slice(0, 12)],
          backupDir: join(dir, 'backups'),
          audit: false,
        });
        const removed = audit.entries.filter(
          (entry) => entry.status === 'removed'
        );
        expect(removed.map((entry) => entry.description)).toEqual([
          'stopped container oom-task (ubuntu:24.04)',
        ]);
        expect(fake.dockerCalls().filter((args) => args[0] === 'rm')).toEqual([
          ['rm', containerId('a1')],
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  itUnless(sandboxed)(
    're-checks the hold when the container changed since the scan',
    async () => {
      const fake = world();
      const { env, report } = await scanWorld(fake);
      const done = fake.daemons.host.containers.find(
        (container) => container.name === 'done-task'
      );
      done.exitCode = 1;
      const dir = mkdtempSync(join(tmpdir(), 'dss-investigation-'));
      try {
        const audit = await clean(report, {
          env,
          tier: 'moderate',
          only: ['docker-stopped-container'],
          removeStoppedContainers: true,
          backupDir: join(dir, 'backups'),
          audit: false,
        });
        const entry = audit.entries.find((e) => e.description.includes('done'));
        expect(entry.status).toBe('skipped');
        expect(entry.reason).toContain('kept for investigation (exit 1)');
        expect(fake.dockerCalls().some((args) => args[0] === 'rm')).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
