import { describe, it, expect } from 'test-anywhere';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { LivenessProbe, matchingName } from '../src/liveness.js';
import { ShellEnv } from '../src/env/shell.js';
import { LocalEnv } from '../src/env/local.js';
import { containerExecutor } from '../src/exec.js';
import { readOnlyRuntime } from './helpers/fixtures.js';

const cache = (rule, target) => ({
  rule,
  paths: [target],
  newestMtimeMs: 1,
  checks: { busy: ['npm', 'npx'], mtime: false },
});

async function live(processes, open = []) {
  const probe = new LivenessProbe(
    {
      path: path.posix,
      processes: async () => processes,
      openPaths: async () => new Set(open),
    },
    { staleAgeMs: 0 }
  );
  await probe.refresh();
  return probe;
}

describe('issue 14 process matching', () => {
  it('does not match tool names in directory components or arguments', () => {
    for (const command of [
      'node /home/box/.bun/bin/hive-telegram-bot bun',
      'node /work/npm/server.js',
      'bash -c echo cargo',
    ]) {
      expect(
        matchingName({ name: command.split(' ')[0], command }, [
          'bun',
          'npm',
          'cargo',
        ])
      ).toBe(null);
    }
    expect(
      matchingName(
        {
          name: 'node',
          command: 'node /usr/lib/node_modules/npm/bin/npm-cli.js install',
        },
        ['npm']
      )
    ).toBe('npm');
  });

  it('allows idle download/header caches alongside an npm exec server', async () => {
    const probe = await live([
      { pid: 7, name: 'npm exec', command: 'npm exec @playwright/mcp@latest' },
    ]);
    for (const rule of ['npm-cache', 'node-gyp-cache']) {
      expect(probe.busyReason(cache(rule, '/home/box/.cache/data'))).toBe(null);
    }
    expect(
      probe.busyReason(cache('npm-cache', '/home/box/.npm/_cacache'))
    ).toBe(null);
  });

  it('protects only the npx hash used by an exec child', async () => {
    const probe = await live([
      { pid: 7, name: 'npm exec', command: 'npm exec @playwright/mcp@latest' },
      {
        pid: 8,
        name: 'node',
        command: 'node /home/box/.npm/_npx/active/node_modules/.bin/mcp',
      },
    ]);
    expect(
      probe.busyReason(cache('npx-cache', '/home/box/.npm/_npx/idle'))
    ).toBe(null);
    expect(
      probe.busyReason(cache('npx-cache', '/home/box/.npm/_npx/active'))
    ).toMatch(/in use/);
  });

  it('still blocks real npm installs and open cache files', async () => {
    const install = await live([
      { pid: 9, name: 'npm', command: 'npm install' },
    ]);
    expect(
      install.busyReason(cache('npm-cache', '/home/box/.npm/_cacache'))
    ).toMatch(/npm is running/);
    const open = await live([], ['/home/box/.npm/_cacache/blob']);
    expect(
      open.busyReason(cache('npm-cache', '/home/box/.npm/_cacache'))
    ).toMatch(/in use/);
  });

  it('recognizes npm process titles and does not waive install activity from a package argument', async () => {
    const install = await live([
      { pid: 9, name: 'npm install', argv: ['npm install'] },
    ]);
    expect(install.busyReason(cache('npm-cache', '/cache'))).toMatch(
      /npm is running/
    );
    const argument = await live([
      { pid: 10, name: 'npm', argv: ['npm', 'install', '/tmp/npx-cli.js'] },
    ]);
    expect(argument.busyReason(cache('npm-cache', '/cache'))).toMatch(
      /npm is running/
    );
  });

  it('protects an installed script named in a process command after its descriptor closes', async () => {
    const probe = await live([
      {
        pid: 12,
        name: 'node',
        cwd: '/home/box/.cache/copilot/pkg/linux-x64/1.0.91',
        argv: ['node', './copilot.js'],
      },
    ]);
    expect(
      probe.busyReason({
        rule: 'copilot-cli-versions',
        paths: ['/home/box/.cache/copilot/pkg/linux-x64/1.0.91'],
        checks: { busy: ['copilot'], mtime: false },
      })
    ).toMatch(/in use/);
  });
});

describe('issue 14 Docker process inspection', () => {
  it('skips zombie metadata while retaining command paths of live processes', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const zombie = '/proc/2147483600';
    const live = '/proc/2147483601';
    const original = {
      readdir: fsp.readdir,
      readFile: fsp.readFile,
      readlink: fsp.readlink,
    };
    const reads = [];
    fsp.readdir = async (target, ...args) =>
      target === '/proc'
        ? ['2147483600', '2147483601']
        : original.readdir(target, ...args);
    fsp.readFile = async (target, ...args) => {
      if (target.startsWith(zombie) || target.startsWith(live)) {
        reads.push(target);
        if (target.endsWith('/stat')) {
          const state = target.startsWith(zombie) ? 'Z' : 'S';
          return `1 (agent) ${state} ${Array(18).fill('0').join(' ')} 123`;
        }
        return target.endsWith('/comm')
          ? 'node\n'
          : '/usr/bin/node\0/cache/active/server.js\0';
      }
      return original.readFile(target, ...args);
    };
    fsp.readlink = async (target, ...args) => {
      if (target.startsWith(zombie) || target.startsWith(live)) {
        reads.push(target);
        return target.endsWith('/cwd') ? '/cache/active' : '/usr/bin/node';
      }
      return original.readlink(target, ...args);
    };
    try {
      const processes = await new LocalEnv({ platform: 'linux' }).processes();
      expect(processes.length).toBe(1);
      expect(processes[0].argv).toEqual([
        '/usr/bin/node',
        '/cache/active/server.js',
      ]);
      expect(reads.filter((target) => target.startsWith(zombie))).toEqual([
        `${zombie}/stat`,
      ]);
    } finally {
      Object.assign(fsp, original);
    }
  });

  it('uses the same read-only fallback when dss runs inside the container', async () => {
    if (readOnlyRuntime()) {
      return;
    }
    const env = new LocalEnv();
    env.rawOpenPaths = async () => {
      throw new Error('EACCES: pid 7 (dockerd)');
    };
    env.processInspector = {
      probeExecutor: {},
      openPaths: async () => new Set(['/cache/open']),
      processes: async () => [{ pid: 7, name: 'dockerd' }],
    };
    expect([...(await env.openPaths())]).toEqual(['/cache/open']);
    expect(await env.processes()).toEqual([{ pid: 7, name: 'dockerd' }]);
  });
  it('retries an incomplete probe as a privileged root read-only exec', async () => {
    const calls = [];
    const parent = {
      label: 'host',
      run: async (argv) => {
        calls.push(argv);
        return argv.includes('--privileged')
          ? { code: 0, stdout: '/home/box/cache/open\n', stderr: '' }
          : { code: 1, stdout: '', stderr: 'unreadable pid 7 (dockerd)\n' };
      },
    };
    const env = new ShellEnv(containerExecutor(parent, 'box'));
    expect([...(await env.openPaths())]).toEqual(['/home/box/cache/open']);
    expect(calls[1].slice(0, 6)).toEqual([
      'docker',
      'exec',
      '--privileged',
      '--user',
      '0',
      'box',
    ]);
    expect(calls[1]).not.toContain('rm');
  });

  it('reports unreadable process names when the fallback is denied', async () => {
    const env = new ShellEnv(
      containerExecutor(
        {
          label: 'host',
          run: async (argv) => ({
            code: 1,
            stdout: '',
            stderr: argv.includes('--privileged')
              ? 'denied'
              : 'unreadable pid 7 (dockerd)\n',
          }),
        },
        'box'
      )
    );
    const probe = new LivenessProbe(env, { staleAgeMs: 0 });
    env.processes = async () => [];
    await probe.refresh();
    expect(probe.busyReason(cache('npm-cache', '/cache'))).toMatch(/dockerd/);
  });
});
