/**
 * Task health check: `clean` snapshots PID 1, agents and build tools before
 * its first deletion in an environment, re-checks them after every step and
 * stops cleaning that environment when one of them is gone.
 */

import { describe, it, expect } from 'test-anywhere';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
import { parseProcStat } from '../src/env/local.js';
import { ShellEnv } from '../src/env/shell.js';
import { HealthWatch, lostProcesses, watchedProcesses } from '../src/health.js';
import { formatAudit } from '../src/report.js';
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

const SLEEP = ['/bin/sleep', '/usr/bin/sleep'].find((file) => existsSync(file));

const proc = (pid, name, startTime = '100', aliases = []) => ({
  pid,
  name,
  startTime,
  aliases,
});

/** Environment whose process list the test replaces between calls. */
function scriptedEnv(lists) {
  let call = 0;
  return {
    processes: () => {
      const list = lists[Math.min(call, lists.length - 1)];
      call += 1;
      return Promise.resolve(list);
    },
  };
}

describe('process start times', () => {
  it('reads the state and start time after a name with spaces and parens', () => {
    const rest = Array.from({ length: 20 }, (_, index) => String(index + 4));
    rest[18] = '4242';
    expect(parseProcStat(`7 (a) b (c)) S ${rest.join(' ')}`)).toEqual({
      state: 'S',
      startTime: '4242',
    });
    expect(parseProcStat('')).toEqual({ state: null, startTime: null });
  });

  it('lists container processes with their start times', async () => {
    if (process.platform !== 'linux' || readOnlyRuntime()) {
      return;
    }
    const executor = {
      label: 'local sh',
      run: ([command, ...args]) =>
        new Promise((resolve) => {
          execFile(command, args, (error, stdout, stderr) =>
            resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
          );
        }),
    };
    const processes = await new ShellEnv(executor).processes();
    const own = processes.find((entry) => entry.pid === process.pid);
    const stat = parseProcStat(readFileSync('/proc/self/stat', 'utf8'));
    expect(own.startTime).toBe(stat.startTime);
    expect(own.aliases).toContain('node');
  });
});

describe('health watch', () => {
  it('watches PID 1, agents and build tools', () => {
    const watched = watchedProcesses([
      proc(1, 'tini'),
      proc(20, 'MainThread', '5', ['node', 'claude']),
      proc(21, 'cargo'),
      proc(22, 'bash'),
      proc(23, 'rustc'),
    ]);
    expect(watched.map((entry) => entry.pid)).toEqual([1, 20, 21]);
  });

  it('reports exited processes and reused PIDs', () => {
    const watched = [proc(1, 'init'), proc(20, 'claude'), proc(21, 'cargo')];
    const lost = lostProcesses(watched, [
      proc(1, 'init'),
      proc(21, 'cargo', '999'),
    ]);
    expect(lost.map((entry) => [entry.pid, entry.reason])).toEqual([
      [20, 'exited'],
      [21, 'restarted with a new start time'],
    ]);
    expect(
      lostProcesses([proc(20, 'claude', null)], [proc(20, 'claude', null)])
    ).toEqual([]);
  });

  it('stops only the environment that lost a process', async () => {
    const health = new HealthWatch();
    const item = { id: 'a:x', env: 'a', envLabel: 'container a' };
    const other = { id: 'b:x', env: 'b', envLabel: 'container b' };
    const env = scriptedEnv([
      [proc(1, 'init'), proc(20, 'claude')],
      [proc(1, 'init'), proc(20, 'claude')],
      [proc(1, 'init')],
    ]);
    await health.baseline(env, item);
    await health.baseline(scriptedEnv([[proc(1, 'init')]]), other);
    expect(await health.check(env, item)).toBe(null);
    expect(await health.check(env, item)).toContain(
      'claude (pid 20) exited while cleaning a:x'
    );
    expect(health.stopReason(item)).toContain(
      'cleaning stopped in this environment'
    );
    expect(health.stopReason(other)).toBe(null);
    expect(health.records.map((record) => record.lost.length)).toEqual([1, 0]);
  });

  it('stops when the processes can no longer be listed', async () => {
    const health = new HealthWatch();
    const item = { id: 'a:x', env: 'a' };
    await health.baseline(scriptedEnv([[proc(1, 'init')], null]), item);
    expect(health.verify(item, null)).toBe(
      'cannot list processes to verify running tasks'
    );
  });
});

/** A Node project with installed dependencies, inactive for 40 days. */
function nodeProject(root, name) {
  const project = join(root, name);
  const modules = join(project, 'node_modules');
  writeBlob(join(modules, 'dep', 'index.js'));
  writeFileSync(join(project, 'package.json'), '{}');
  writeFileSync(join(project, 'package-lock.json'), '{}');
  age(project, 40 * DAY_MS);
  return modules;
}

/** Starts a copy of `sleep` named `claude`, working inside `root`. */
async function fakeAgent(root) {
  const bin = join(root, 'agent');
  mkdirSync(bin, { recursive: true });
  const file = join(bin, 'claude');
  copyFileSync(SLEEP, file);
  chmodSync(file, 0o755);
  const child = spawn(file, ['600'], { cwd: bin, stdio: 'ignore' });
  await once(child, 'spawn');
  return child;
}

async function cleanFixture(stopAgent) {
  const root = tempRoot('dss-health-');
  const modules = ['a', 'b', 'c'].map((name) => nodeProject(root, name));
  const agent = await fakeAgent(root);
  try {
    const env = fixtureEnv(root);
    const report = await scan(
      scanInput(env, [root], { scanners: ['projects'] })
    );
    const audit = await clean(report, {
      env,
      tier: 'moderate',
      audit: false,
      onEntry: () => stopAgent && agent.kill('SIGKILL'),
    });
    return {
      audit,
      agent,
      remaining: modules.filter((dir) => existsSync(dir)).length,
    };
  } finally {
    agent.kill('SIGKILL');
    removeRoot(root);
  }
}

describe('clean with a health check', () => {
  const unsupported = () =>
    readOnlyRuntime() || process.platform !== 'linux' || !SLEEP;

  it('records the watched processes that survived', async () => {
    if (unsupported()) {
      return;
    }
    const { audit, agent, remaining } = await cleanFixture(false);
    expect(remaining).toBe(0);
    expect(audit.health.length).toBe(1);
    const [record] = audit.health;
    expect(record.watched.map((entry) => entry.pid)).toEqual([agent.pid]);
    expect(record.stopped).toBe(null);
    expect(record.checks > 0).toBe(true);
    expect(formatAudit(audit)).toContain('1 watched processes still running');
  });

  it('stops cleaning the environment when an agent disappears', async () => {
    if (unsupported()) {
      return;
    }
    const { audit, agent, remaining } = await cleanFixture(true);
    expect(audit.entries.map((entry) => entry.status)).toEqual([
      'removed',
      'skipped',
      'skipped',
    ]);
    expect(remaining).toBe(2);
    expect(audit.entries[1].reason).toContain(
      `claude (pid ${agent.pid}) exited`
    );
    expect(audit.entries[2].reason).toContain(
      'cleaning stopped in this environment'
    );
    expect(audit.health[0].lost.map((entry) => entry.pid)).toEqual([agent.pid]);
    expect(formatAudit(audit)).toContain('STOPPED cleaning');
  });
});
