/**
 * Docker CLI access through an executor (the host, or a container running
 * its own daemon for Docker-in-Docker).
 *
 * Every invocation passes `assertAllowed`: dss never stops, kills,
 * restarts, pauses or force-removes anything, and `docker rm` is only used
 * for containers that are verified stopped right before removal.
 */

import { pipeInto } from '../exec.js';

const DECIMAL_UNITS = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

const ALLOWED = new Map([
  ['version', null],
  ['info', null],
  ['ps', null],
  ['inspect', null],
  ['diff', null],
  ['logs', null],
  ['cp', null],
  ['history', null],
  ['exec', null],
  ['rm', 'rm'],
  ['system', new Set(['df'])],
  ['image', new Set(['prune', 'rm', 'ls', 'inspect', 'history'])],
  ['builder', new Set(['prune', 'du'])],
  ['volume', new Set(['ls', 'rm', 'inspect'])],
  ['container', new Set(['inspect', 'ls', 'diff', 'logs'])],
]);

const FORCE_FLAGS = new Set(['-f', '--force', '-v', '--volumes', '-l']);

/**
 * Throws unless `args` (the arguments after `docker`) is a command dss may
 * run. `docker exec` payloads are not inspected: they run inside a
 * container, never against its lifecycle.
 * @param {string[]} args
 */
export function assertAllowed(args) {
  const [command, sub] = args;
  if (!ALLOWED.has(command)) {
    throw new Error(`dss refuses to run \`docker ${command}\``);
  }
  const rule = ALLOWED.get(command);
  if (rule instanceof Set && !rule.has(sub)) {
    throw new Error(`dss refuses to run \`docker ${command} ${sub}\``);
  }
  if (rule === 'rm' && args.slice(1).some((arg) => FORCE_FLAGS.has(arg))) {
    throw new Error('dss never force-removes containers or their volumes');
  }
}

/**
 * Parses sizes printed by Docker (`19.1MB`, `0B`, `1.2GB (virtual 3GB)`),
 * which use decimal multiples.
 * @returns {number} bytes
 */
export function parseDockerSize(value) {
  const match = /^\s*([\d.]+)\s*([a-z]*)/i.exec(String(value ?? ''));
  if (!match) {
    return 0;
  }
  const unit = DECIMAL_UNITS[(match[2] || 'b').toLowerCase()] ?? 1;
  return Math.round(Number(match[1]) * unit);
}

/**
 * Parses newline-delimited JSON (`--format '{{json .}}'`).
 * @returns {object[]}
 */
export function jsonLines(text) {
  return (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}

/**
 * Parses the comma-separated `Labels` column of `docker ps`.
 * @returns {Record<string, string>}
 */
export function parseLabels(text) {
  const labels = {};
  for (const pair of (text ?? '').split(',')) {
    const index = pair.indexOf('=');
    if (index > 0) {
      labels[pair.slice(0, index)] = pair.slice(index + 1);
    }
  }
  return labels;
}

/**
 * Paths of Git directories changed in a container's writable layer, from
 * `docker diff` output, mapped to their work trees.
 * @returns {string[]}
 */
export function repoRootsFromDiff(text) {
  const roots = new Set();
  for (const line of (text ?? '').split('\n')) {
    const match = /^[AC] (.+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const gitIndex = match[1].search(/\/\.git(\/|$)/);
    if (gitIndex !== -1) {
      roots.add(match[1].slice(0, gitIndex) || '/');
    }
  }
  return [...roots].sort();
}

export class DockerCli {
  /**
   * @param {object} executor where the docker CLI runs
   * @param {{docker?: string}} [options]
   */
  constructor(executor, options = {}) {
    this.executor = executor;
    this.docker = options.docker ?? 'docker';
  }

  argv(args) {
    assertAllowed(args);
    return [this.docker, ...args];
  }

  run(args, options = {}) {
    return this.executor.run(this.argv(args), options);
  }

  async json(args) {
    const result = await this.run(args);
    if (result.code !== 0) {
      throw new Error(
        `docker ${args.join(' ')} failed: ${result.stderr.trim() || result.code}`
      );
    }
    return result.stdout;
  }

  /**
   * Daemon facts, or null when no daemon is reachable.
   * @returns {Promise<object|null>}
   */
  async info() {
    const result = await this.run(['info', '--format', '{{json .}}'], {
      timeoutMs: 30000,
    });
    if (result.code !== 0) {
      return null;
    }
    try {
      const info = JSON.parse(result.stdout);
      return info.ID || info.ServerVersion ? info : null;
    } catch {
      return null;
    }
  }

  async systemDf() {
    return jsonLines(
      await this.json(['system', 'df', '--format', '{{json .}}'])
    );
  }

  async systemDfVerbose() {
    return JSON.parse(
      await this.json(['system', 'df', '-v', '--format', '{{json .}}'])
    );
  }

  async containers() {
    return jsonLines(
      await this.json([
        'ps',
        '--all',
        '--size',
        '--no-trunc',
        '--format',
        '{{json .}}',
      ])
    );
  }

  async inspect(ids) {
    if (ids.length === 0) {
      return [];
    }
    return JSON.parse(
      await this.json(['inspect', '--type', 'container', ...ids])
    );
  }

  async diff(id) {
    const result = await this.run(['diff', id]);
    return result.code === 0 ? result.stdout : null;
  }

  async history(image) {
    return jsonLines(
      await this.json([
        'history',
        '--no-trunc',
        '--format',
        '{{json .}}',
        image,
      ])
    );
  }

  /**
   * Streams `docker cp <id>:<path> -` into `tar -x` on the machine running
   * dss, skipping `excludes`. Works through nested executors because only
   * the tar stream crosses them.
   */
  copyOut(id, source, destination, excludes = []) {
    const stream = this.executor.spawn(
      this.argv(['cp', `${id}:${source}`, '-'])
    );
    return pipeInto(stream, [
      'tar',
      '-x',
      '-C',
      destination,
      ...excludes.map((pattern) => `--exclude=${pattern}`),
    ]);
  }
}
