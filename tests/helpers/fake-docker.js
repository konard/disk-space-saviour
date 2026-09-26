/**
 * In-memory Docker world for tests: daemons with running and stopped
 * containers, where a running container can run its own daemon
 * (Docker-in-Docker). The executor answers the `docker` commands dss issues,
 * unwraps `docker exec <id> ...` hops, and records every call so tests can
 * assert that no lifecycle command was ever sent.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr, code = 1) => ({ code, stdout: '', stderr });

/**
 * @param {string} id short readable id, padded to 64 hex-like characters
 */
export function containerId(id) {
  return id.padEnd(64, '0');
}

export class FakeDockerWorld {
  /**
   * @param {Record<string, {info: object, containers: object[],
   *   buildCache?: string, images?: object[]}>} daemons keyed by daemon
   *   name; `host` is the daemon of the machine running dss. Containers:
   *   `{id, name, state, image, size, labels, env, finishedAt, diff,
   *   daemon}` where `daemon` names the daemon running inside.
   */
  constructor(daemons) {
    this.daemons = daemons;
    this.calls = [];
    this.execs = [];
  }

  executor() {
    return {
      label: 'host',
      depth: 0,
      run: (argv) => Promise.resolve(this.run(argv)),
      spawn: (argv) => this.spawn(argv),
    };
  }

  /** Docker subcommands sent to any daemon, e.g. `['rm', id]`. */
  dockerCalls() {
    return this.calls.map((call) => call.args);
  }

  #find(daemon, id) {
    return this.daemons[daemon]?.containers.find(
      (c) => containerId(c.id) === id || c.name === id
    );
  }

  /**
   * Follows `docker exec` hops.
   * @returns {{daemon: string|null, container: object|null, argv: string[]}}
   */
  #unwrap(argv) {
    let daemon = 'host';
    let container = null;
    let rest = argv;
    while (rest[0] === 'docker' && rest[1] === 'exec') {
      let index = 2;
      while (rest[index].startsWith('-')) {
        index += rest[index] === '--user' ? 2 : 1;
      }
      container = this.#find(daemon, rest[index]);
      if (!container || container.state !== 'running') {
        return { daemon: null, container: null, argv: rest };
      }
      this.execs.push({ daemon, container: container.name });
      daemon = container.daemon ?? null;
      rest = rest.slice(index + 1);
    }
    return { daemon, container, argv: rest };
  }

  run(argv) {
    const target = this.#unwrap(argv);
    if (target.daemon === null && target.container === null) {
      return fail('Error response from daemon: container is not running');
    }
    const [command, ...args] = target.argv;
    if (command === 'sh') {
      return this.#shell(target, args);
    }
    if (command !== 'docker') {
      return fail(`${command}: not found`, 127);
    }
    if (!target.daemon || !this.daemons[target.daemon]) {
      return fail('Cannot connect to the Docker daemon');
    }
    this.calls.push({ daemon: target.daemon, args });
    return this.#docker(this.daemons[target.daemon], target.daemon, args);
  }

  #shell(target, args) {
    const script = args[1] ?? '';
    if (script === 'true') {
      return ok();
    }
    if (script.startsWith('command -v')) {
      return target.container?.daemon ? ok('/usr/bin/docker\n') : fail('');
    }
    return fail('unsupported script in the fake world');
  }

  #docker(daemon, name, args) {
    const [command, sub] = args;
    const handlers = {
      info: () => ok(JSON.stringify(daemon.info)),
      system: () => this.#systemDf(daemon, sub, args),
      ps: () =>
        ok(daemon.containers.map((c) => JSON.stringify(psRow(c))).join('\n')),
      inspect: () =>
        ok(
          JSON.stringify(
            args
              .slice(3)
              .map((id) => this.#find(name, id))
              .filter(Boolean)
              .map(inspectObject)
          )
        ),
      diff: () => {
        const container = this.#find(name, args[1]);
        return container ? ok(container.diff ?? '') : fail('No such container');
      },
      cp: () => fail('Could not find the file in the container'),
      history: () => ok(''),
      rm: () => this.#remove(daemon, name, args),
      builder: () => {
        daemon.buildCache = '0B';
        return ok('Total reclaimed space: 2GB\n');
      },
    };
    const handler = handlers[command];
    return handler ? handler() : fail(`unsupported: docker ${args.join(' ')}`);
  }

  #systemDf(daemon, sub, args) {
    if (sub !== 'df') {
      return fail(`unsupported: docker system ${sub}`);
    }
    if (args.includes('-v')) {
      return ok(
        JSON.stringify({
          Images: daemon.images ?? [],
          Volumes: daemon.volumes ?? [],
        })
      );
    }
    return ok(
      JSON.stringify({
        Type: 'Build Cache',
        TotalCount: '1',
        Active: '0',
        Size: daemon.buildCache ?? '0B',
        Reclaimable: daemon.buildCache ?? '0B',
      })
    );
  }

  #remove(daemon, name, args) {
    const container = this.#find(name, args.at(-1));
    if (!container) {
      return fail('No such container');
    }
    if (container.state === 'running') {
      return fail('cannot remove a running container');
    }
    daemon.containers.splice(daemon.containers.indexOf(container), 1);
    return ok(`${containerId(container.id)}\n`);
  }

  spawn(argv) {
    const target = this.#unwrap(argv);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const [, command, ...args] = target.argv;
    this.calls.push({ daemon: target.daemon, args: [command, ...args] });
    const container =
      command === 'logs' ? this.#find(target.daemon, args.at(-1)) : null;
    setImmediate(() => {
      if (container) {
        child.stdout.end(container.logs ?? '');
        child.stderr.end('');
        child.emit('close', 0);
        return;
      }
      child.stdout.end();
      child.stderr.end(`unsupported: docker ${command}`);
      child.emit('close', 1);
    });
    return child;
  }
}

function psRow(container) {
  return {
    ID: containerId(container.id),
    Names: container.name,
    Image: container.image ?? 'ubuntu:24.04',
    Command: '"sleep infinity"',
    // eslint-disable-next-line local/no-changelog-comments -- `docker ps` time format
    CreatedAt: '2026-09-01 10:00:00 +0000 UTC',
    State: container.state,
    Status: container.state === 'running' ? 'Up 2 hours' : 'Exited (0)',
    Size: container.size ?? '0B (virtual 80MB)',
  };
}

function inspectObject(container) {
  return {
    Id: containerId(container.id),
    Name: `/${container.name}`,
    State: {
      Status: container.state,
      FinishedAt: container.finishedAt ?? '2026-09-20T10:00:00Z',
    },
    Config: {
      Labels: container.labels ?? {},
      Env: container.env ?? [],
    },
    Mounts: container.mounts ?? [],
  };
}

/**
 * Host environment adapter backed by the fake executor.
 */
export function fakeHostEnv(world) {
  const executor = world.executor();
  return {
    id: 'host',
    label: 'host (test)',
    kind: 'host',
    platform: 'linux',
    executor,
    run: (argv, options) => executor.run(argv, options),
    which: (command) => Promise.resolve(command === 'docker'),
  };
}
