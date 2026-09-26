/**
 * Recursive Docker scan.
 *
 * For every reachable daemon (the host's, then daemons running inside
 * containers, up to `dockerDepth` levels):
 * - daemon objects: dangling images and build cache (`safe`), unused tagged
 *   images (`moderate`, needs `removeUnusedImages`), unused volumes (reported
 *   with `includeVolumes`, never removed automatically);
 * - running containers are never stopped, restarted or removed: their
 *   filesystems are scanned through `docker exec` with the same rules as
 *   the host, and a Docker CLI inside them is followed (Docker-in-Docker);
 * - stopped containers are reported with their size, owner session and the
 *   Git state of repositories in their writable layer, and are removed only
 *   with `removeStoppedContainers` (after a logs backup, at clean time);
 * - image layer hints (report only).
 *
 * The same daemon reached twice (a mounted socket) is scanned once.
 */

import { ShellEnv } from '../env/shell.js';
import { containerExecutor, trace } from '../exec.js';
import { block, makeItem } from '../items.js';
import { DockerCli, parseDockerSize } from './cli.js';
import {
  containerGitState,
  gitBlockersForRemoval,
  ownerOf,
} from './containers.js';

const RUNNING = new Set(['running']);
const STOPPED = new Set(['exited', 'created', 'dead']);
const LAYER_HINT_IMAGES = 5;
const LAYER_HINT_BYTES = 50e6;

function dfRow(rows, type) {
  return rows.find((row) => row.Type === type) ?? {};
}

function imageStore(info) {
  const status = JSON.stringify(info.DriverStatus ?? []);
  return /containerd\.snapshotter/.test(status) ? 'containerd' : 'graphdriver';
}

/**
 * Size columns of `docker ps --size` (`19.1MB (virtual 27.5MB)`).
 */
export function containerSizes(sizeText) {
  const virtual = /virtual ([^)]+)\)/.exec(sizeText ?? '');
  return {
    bytes: parseDockerSize(sizeText),
    virtualBytes: virtual ? parseDockerSize(virtual[1]) : 0,
  };
}

function daemonItems(daemon, verbose, df, options) {
  const { env } = daemon;
  const items = [];
  const images = verbose.Images ?? [];
  const unused = images.filter((image) => image.Containers === '0');
  const dangling = unused.filter((image) => image.Tag === '<none>');
  const danglingBytes = dangling.reduce(
    (sum, image) => sum + parseDockerSize(image.UniqueSize ?? image.Size),
    0
  );
  const measure = { volume: daemon.rootDir, parse: 'docker' };
  if (dangling.length > 0) {
    items.push(
      makeItem(env, {
        rule: 'docker-dangling-images',
        kind: 'docker',
        ecosystem: 'docker',
        description: `${dangling.length} dangling Docker images`,
        target: `daemon:${daemon.id}:dangling`,
        bytes: danglingBytes,
        reason: 'untagged images no container uses',
        action: {
          type: 'command',
          argv: ['docker', 'image', 'prune', '--force'],
          ...measure,
        },
        checks: { busy: [], cwd: null, mtime: false },
      })
    );
  }
  const buildBytes = parseDockerSize(dfRow(df, 'Build Cache').Reclaimable);
  if (buildBytes > 0) {
    const seconds = Math.round(options.staleAgeMs / 1000);
    items.push(
      makeItem(env, {
        rule: 'docker-build-cache',
        kind: 'docker',
        ecosystem: 'docker',
        description: 'Docker build cache not used by running builds',
        target: `daemon:${daemon.id}:build-cache`,
        bytes: buildBytes,
        reason: `unused build cache older than ${seconds}s is re-created by the next build`,
        action: {
          type: 'command',
          argv: [
            'docker',
            'builder',
            'prune',
            '--all',
            '--force',
            '--filter',
            `until=${seconds}s`,
          ],
          ...measure,
        },
        checks: { busy: ['buildkitd'], cwd: null, mtime: false },
      })
    );
  }
  const tagged = unused.filter((image) => image.Tag !== '<none>');
  for (const image of tagged) {
    const name = `${image.Repository}:${image.Tag}`;
    items.push(
      makeItem(env, {
        rule: 'docker-unused-image',
        kind: 'docker',
        ecosystem: 'docker',
        description: `unused Docker image ${name}`,
        target: `daemon:${daemon.id}:image:${image.ID}`,
        bytes: parseDockerSize(image.UniqueSize ?? image.Size),
        tier: 'moderate',
        reason: 'no container uses it, pulled or built again on demand',
        requiresConfirmation: 'removeUnusedImages',
        action: {
          type: 'command',
          argv: ['docker', 'image', 'rm', image.ID],
          ...measure,
        },
        checks: { busy: [], cwd: null, mtime: false },
      })
    );
  }
  return items;
}

/**
 * Report-only hints about image layers that keep package caches.
 */
export function layerHints(image, history) {
  const hints = [];
  for (const layer of history) {
    const bytes = parseDockerSize(layer.Size);
    const command = layer.CreatedBy ?? '';
    const hint = layerAdvice(command, bytes);
    if (hint && bytes >= LAYER_HINT_BYTES) {
      hints.push({
        image,
        bytes,
        createdBy: command.slice(0, 300),
        hint,
      });
    }
  }
  return hints;
}

function layerAdvice(command, bytes) {
  if (
    /apt-get install/.test(command) &&
    !/\/var\/lib\/apt\/lists/.test(command)
  ) {
    return 'apt lists stay in the layer: add `rm -rf /var/lib/apt/lists/*` to the same RUN';
  }
  if (
    /\b(npm (ci|install)|yarn install)\b/.test(command) &&
    !/cache clean/.test(command)
  ) {
    return 'the npm/yarn cache stays in the layer: clean it in the same RUN or use a cache mount';
  }
  if (/pip3? install/.test(command) && !/--no-cache-dir/.test(command)) {
    return 'the pip cache stays in the layer: use `pip install --no-cache-dir`';
  }
  if (/\bcargo (build|install)\b/.test(command)) {
    return 'cargo registry and target stay in the layer: use a multi-stage build or cache mounts';
  }
  return bytes >= 500e6
    ? 'very large layer: consider a multi-stage build'
    : null;
}

async function imageHints(docker, verbose) {
  const largest = [...(verbose.Images ?? [])]
    .filter((image) => image.Containers !== '0')
    .sort((a, b) => parseDockerSize(b.Size) - parseDockerSize(a.Size))
    .slice(0, LAYER_HINT_IMAGES);
  const hints = [];
  for (const image of largest) {
    const name =
      image.Tag === '<none>' ? image.ID : `${image.Repository}:${image.Tag}`;
    try {
      hints.push(...layerHints(name, await docker.history(image.ID)));
    } catch (error) {
      trace('history failed', name, error.message);
    }
  }
  return hints;
}

async function stoppedItem(daemon, ps, inspected, options) {
  const sizes = containerSizes(ps.Size);
  const owner = ownerOf(ps, inspected);
  const item = makeItem(daemon.env, {
    rule: 'docker-stopped-container',
    kind: 'container',
    ecosystem: 'docker',
    description: `stopped container ${owner.name} (${ps.Image})`,
    target: `daemon:${daemon.id}:container:${ps.ID}`,
    bytes: sizes.bytes,
    tier: 'moderate',
    reason: 'stopped container, its writable layer is deleted by `docker rm`',
    requiresConfirmation: 'removeStoppedContainers',
    container: { id: ps.ID, name: owner.name, state: ps.State, owner },
    action: {
      type: 'docker-rm',
      containerId: ps.ID,
      name: owner.name,
      finishedAt: inspected?.State?.FinishedAt ?? null,
      volume: daemon.rootDir,
    },
    checks: { busy: [], cwd: null, mtime: false },
  });
  if (options.removeStoppedContainers) {
    const git = await containerGitState(daemon.docker, ps.ID);
    item.container.repos = git.repos;
    item.container.gitBlockers = git.blockers;
    gitBlockersForRemoval(git, ps.ID, options).forEach((reason) =>
      block(item, reason)
    );
  } else {
    item.container.repos = [];
    item.container.gitBlockers = [];
    item.container.gitCheckDeferred = true;
  }
  return item;
}

function matchesFilter(ps, filters) {
  if (!filters || filters.length === 0) {
    return true;
  }
  const names = String(ps.Names ?? '').split(',');
  return filters.some(
    (filter) => ps.ID.startsWith(filter) || names.includes(filter)
  );
}

class DockerScan {
  constructor(options, scanEnvironment) {
    this.options = options;
    this.scanEnvironment = scanEnvironment;
    this.seen = new Set();
    this.result = {
      daemons: [],
      containers: [],
      environments: [],
      items: [],
      hints: [],
      bindMounts: [],
      volumes: [],
    };
  }

  async daemon(record, depth, inherited) {
    const docker = new DockerCli(record.executor);
    const info = await docker.info();
    if (!info) {
      return;
    }
    const id = info.ID || `${record.env.id}:docker`;
    if (this.seen.has(id)) {
      trace('daemon already scanned', id, 'via', record.env.id);
      return;
    }
    this.seen.add(id);
    const daemon = {
      id,
      env: record.env,
      docker,
      depth,
      rootDir: info.DockerRootDir ?? null,
    };
    const df = await docker.systemDf();
    const verbose = await docker.systemDfVerbose();
    this.result.daemons.push({
      id,
      env: record.env.id,
      depth,
      name: info.Name ?? null,
      serverVersion: info.ServerVersion ?? null,
      driver: info.Driver ?? null,
      imageStore: imageStore(info),
      rootDir: daemon.rootDir,
      df: df.map((row) => ({
        type: row.Type,
        count: Number(row.TotalCount),
        active: Number(row.Active),
        bytes: parseDockerSize(row.Size),
        reclaimableBytes: parseDockerSize(row.Reclaimable),
      })),
    });
    this.result.items.push(...daemonItems(daemon, verbose, df, this.options));
    if (this.options.includeVolumes) {
      this.result.volumes.push(
        ...(verbose.Volumes ?? [])
          .filter((volume) => volume.Links === '0')
          .map((volume) => ({
            daemon: id,
            name: volume.Name,
            bytes: parseDockerSize(volume.Size),
            note: 'inspect contents before removing this volume manually',
          }))
      );
    }
    this.result.hints.push(...(await imageHints(docker, verbose)));
    await this.containers(daemon, record, depth, inherited);
  }

  async containers(daemon, record, depth, inherited) {
    const all = await daemon.docker.containers();
    const inspected = new Map(
      (await daemon.docker.inspect(all.map((ps) => ps.ID))).map((c) => [
        c.Id,
        c,
      ])
    );
    if (record.env.kind === 'host') {
      for (const ps of all.filter((row) => row.State === 'running')) {
        for (const mount of inspected.get(ps.ID)?.Mounts ?? []) {
          if (mount.Type === 'bind' && mount.Source?.startsWith('/')) {
            this.result.bindMounts.push({
              source: mount.Source,
              containerId: ps.ID,
            });
          }
        }
      }
    }
    for (const ps of all) {
      const selected =
        inherited || matchesFilter(ps, this.options.containerFilter);
      if (!selected) {
        continue;
      }
      await this.container(daemon, record, depth + 1, ps, inspected.get(ps.ID));
    }
  }

  async container(daemon, record, depth, ps, inspected) {
    const sizes = containerSizes(ps.Size);
    const owner = ownerOf(ps, inspected);
    const entry = {
      id: ps.ID,
      name: owner.name,
      image: ps.Image,
      state: ps.State,
      status: ps.Status,
      daemon: daemon.id,
      daemonEnv: record.env.id,
      depth,
      bytes: sizes.bytes,
      virtualBytes: sizes.virtualBytes,
      owner,
      env: null,
      scanned: false,
      note: null,
    };
    this.result.containers.push(entry);
    if ((this.options.selfContainerIds ?? []).includes(ps.ID)) {
      entry.note = 'this is the container dss runs in, scanned as the host';
      return;
    }
    if (depth > this.options.dockerDepth) {
      entry.note = `deeper than the Docker depth limit ${this.options.dockerDepth} (--depth)`;
      return;
    }
    if (STOPPED.has(ps.State)) {
      this.result.items.push(
        await stoppedItem(daemon, ps, inspected, this.options)
      );
      return;
    }
    if (!RUNNING.has(ps.State)) {
      entry.note = `state ${ps.State}, left alone`;
      return;
    }
    await this.running(record, depth, ps, entry);
  }

  async running(record, depth, ps, entry) {
    const label = `${record.env.label}/${entry.name}`;
    const executor = containerExecutor(record.executor, ps.ID, { label });
    const env = new ShellEnv(executor, {
      id: `${record.env.id}/${entry.name}`,
      label,
      kind: 'container',
    });
    const probe = await executor.run(['sh', '-c', 'true'], {
      timeoutMs: 30000,
    });
    if (probe.code !== 0) {
      entry.note = `cannot run sh inside: ${probe.stderr.trim() || probe.code}`;
      return;
    }
    entry.env = env.id;
    entry.scanned = true;
    const chain = [...record.chain, { containerId: ps.ID, name: entry.name }];
    this.result.environments.push({
      id: env.id,
      label,
      kind: 'container',
      depth,
      chain,
    });
    this.result.items.push(...(await this.scanEnvironment(env)));
    if (await env.which('docker')) {
      await this.daemon({ env, executor, chain }, depth, true);
    }
  }
}

/**
 * Scans every daemon reachable from `hostRecord`.
 * @param {{env: object, executor: object, chain: object[]}} hostRecord
 * @param {object} options resolved scan options
 * @param {(env: object) => Promise<object[]>} scanEnvironment
 */
export async function scanDocker(hostRecord, options, scanEnvironment) {
  const scan = new DockerScan(options, scanEnvironment);
  if (!(await hostRecord.env.which('docker'))) {
    return scan.result;
  }
  await scan.daemon(hostRecord, 0, false);
  return scan.result;
}
