#!/usr/bin/env node
/**
 * Docker-in-Docker integration test (needs a Docker daemon that allows
 * `--privileged`). Builds host → l1 → l2 nested daemons and checks that
 * `dss docker scan --recursive` reaches containers two daemons deep, that
 * `dss docker clean` empties a cache inside a running container without
 * stopping anything, and that stopped containers are removed only when
 * approved, with a log backup, and kept while their Git work is unsaved.
 *
 *   node tests/integration/dind.mjs [--keep]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const DIND_IMAGE =
  'docker:28-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac';
const BUSYBOX_IMAGE =
  'busybox@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e';
const DIND_TAG = 'dss-it/dind:pinned';
const BUSYBOX_TAG = 'dss-it/busybox:pinned';
const L1 = 'dss-it-l1';
const L2 = 'dss-it-l2';
const CACHE_BYTES = 2 * 1024 * 1024;

const DSS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bin',
  'dss.js'
);
const work = mkdtempSync(join(tmpdir(), 'dss-dind-'));
const keep = process.argv.includes('--keep');

function log(message) {
  process.stdout.write(`[dind] ${message}\n`);
}

function sh(command, { input, check = true } = {}) {
  const result = spawnSync('sh', ['-c', command], {
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (check && result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
const inL1 = (command) => `docker exec ${L1} sh -c ${quote(command)}`;
const inL2 = (command) => inL1(`docker exec ${L2} sh -c ${quote(command)}`);

function waitForDaemon(prefix, label) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (spawnSync('sh', ['-c', `${prefix}docker info`]).status === 0) {
      log(`${label} daemon is up`);
      return;
    }
    spawnSync('sleep', ['1']);
  }
  throw new Error(`${label} daemon did not start`);
}

function teardown() {
  sh(`docker rm -f ${L1}`, { check: false });
  sh(`docker rmi ${DIND_TAG} ${BUSYBOX_TAG}`, { check: false });
}

function buildChain() {
  teardown();
  for (const [image, tag] of [
    [DIND_IMAGE, DIND_TAG],
    [BUSYBOX_IMAGE, BUSYBOX_TAG],
  ]) {
    sh(`docker pull -q ${image} && docker tag ${image} ${tag}`);
  }
  const daemon = `--privileged -e DOCKER_TLS_CERTDIR= ${DIND_TAG}`;
  sh(`docker run -d --name ${L1} ${daemon}`);
  waitForDaemon(`docker exec ${L1} `, 'l1');
  sh(
    `docker save ${DIND_TAG} ${BUSYBOX_TAG} | docker exec -i ${L1} docker load`
  );
  sh(inL1(`docker run -d --name ${L2} ${daemon}`));
  waitForDaemon(`docker exec ${L1} docker exec ${L2} `, 'l2');
  sh(inL1(`docker save ${BUSYBOX_TAG} | docker exec -i ${L2} docker load`));

  const busybox = (args) => sh(inL2(`docker ${args}`));
  busybox(
    `run -d --name app ${BUSYBOX_TAG} sh -c "mkdir -p /root/.npm/_cacache && head -c ${CACHE_BYTES} /dev/urandom > /root/.npm/_cacache/blob && sleep 86400"`
  );
  busybox(`run --name stopped-work ${BUSYBOX_TAG} echo finished job output`);
  // A stopped container whose only copy of a commit and an edit lives in
  // its writable layer: the Git check must keep it.
  sh(
    inL2(
      'mkdir -p /tmp/repo && cd /tmp/repo && git init -q && echo one > a && ' +
        'git add a && git -c user.email=it@dss -c user.name=it commit -qm one && ' +
        'echo two >> a'
    )
  );
  busybox(`create --name unsaved-work ${BUSYBOX_TAG} true`);
  busybox('cp /tmp/repo unsaved-work:/work');
  busybox('start -a unsaved-work');
  for (let attempt = 0; attempt < 30; attempt++) {
    const ready = inL2('docker exec app test -f /root/.npm/_cacache/blob');
    if (spawnSync('sh', ['-c', ready]).status === 0) {
      return;
    }
    spawnSync('sleep', ['1']);
  }
  throw new Error('app container did not write its cache');
}

function dss(args) {
  const argv = [
    DSS,
    'docker',
    ...args,
    '--recursive',
    '--container',
    L1,
    '--scanner',
    'global',
    '--min-size',
    '0',
    '--older-than',
    '0',
    '--no-native',
    '--audit-dir',
    join(work, 'audit'),
    '--backup-dir',
    join(work, 'backup'),
    '--json',
  ];
  log(`dss ${argv.slice(1).join(' ')}`);
  const started = Date.now();
  const stdout = execFileSync(process.execPath, argv, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  log(`finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return JSON.parse(stdout);
}

const APP_ENV = `host/${L1}/${L2}/app`;
const byRule = (items, rule) => items.filter((item) => item.rule === rule);
const stoppedNamed = (items, name) =>
  byRule(items, 'docker-stopped-container').find(
    (item) => item.container?.name === name
  );

function checkScan(report) {
  const depths = new Map(report.environments.map((e) => [e.id, e.depth]));
  assert.equal(depths.get(`host/${L1}`), 1);
  assert.equal(depths.get(`host/${L1}/${L2}`), 2);
  assert.equal(depths.get(APP_ENV), 3);
  const daemons = report.docker.daemons.map((d) => d.depth).sort();
  assert.deepEqual(daemons, [0, 1, 2]);

  const cache = byRule(report.items, 'npm-cache').find(
    (item) => item.env === APP_ENV
  );
  assert.ok(cache, 'npm cache inside the nested running container');
  assert.equal(cache.path, '/root/.npm/_cacache');
  assert.ok(cache.bytes >= CACHE_BYTES, `cache size ${cache.bytes}`);

  const stopped = stoppedNamed(report.items, 'stopped-work');
  assert.ok(stopped, 'stopped container two daemons deep');
  assert.equal(stopped.tier, 'moderate');
  assert.deepEqual(stopped.blockers, []);
  assert.equal(stopped.requiresConfirmation, 'removeStoppedContainers');
  const unsaved = stoppedNamed(report.items, 'unsaved-work');
  assert.equal(unsaved.container.gitCheckDeferred, true);
  assert.deepEqual(unsaved.container.repos, []);
  assert.ok(report.errors.length === 0, JSON.stringify(report.errors));
}

function running() {
  return [
    sh(`docker inspect -f '{{.State.Running}}' ${L1}`),
    sh(inL1(`docker inspect -f '{{.State.Running}}' ${L2}`)),
    sh(inL2(`docker inspect -f '{{.State.Running}}' app`)),
  ];
}

function containerNames() {
  return sh(inL2("docker ps -a --format '{{.Names}}'")).split('\n').sort();
}

function checkCacheClean(audit) {
  const removed = audit.entries.filter((e) => e.status === 'removed');
  assert.deepEqual(
    removed.map((e) => [e.rule, e.env]),
    [['npm-cache', APP_ENV]]
  );
  assert.equal(
    sh(inL2('docker exec app ls -A /root/.npm/_cacache'), { check: false }),
    ''
  );
  assert.deepEqual(running(), ['true', 'true', 'true']);
  assert.ok(audit.environments[APP_ENV].freedBytes >= CACHE_BYTES);
}

function checkContainerClean(audit, planned) {
  assert.deepEqual(
    planned.entries.map((e) => [e.description, e.status]).sort(),
    audit.entries.map((e) => [e.description, 'planned']).sort()
  );
  const status = Object.fromEntries(
    audit.entries.map((e) => [
      /stopped container (\S+)/.exec(e.description)[1],
      e,
    ])
  );
  assert.equal(status['stopped-work'].status, 'removed');
  assert.notEqual(status['unsaved-work']?.status, 'removed');
  assert.deepEqual(containerNames(), ['app', 'unsaved-work']);
  const backup = status['stopped-work'].backup;
  assert.ok(backup.startsWith(join(work, 'backup')));
  assert.match(
    readFileSync(join(backup, 'stdout.log'), 'utf8'),
    /finished job output/
  );
  assert.ok(readdirSync(backup).includes('inspect.json'));
  assert.deepEqual(running(), ['true', 'true', 'true']);
}

function main() {
  try {
    buildChain();
    checkScan(dss(['scan']));
    log('scan reached depth 2 daemons and depth 3 containers');

    checkCacheClean(dss(['clean', '--yes', '--only', 'npm-cache']));
    log('cache removed inside a running container, nothing stopped');

    const containers = [
      '--tier',
      'moderate',
      '--only',
      'docker-stopped-container',
    ];
    const withoutApproval = dss(['clean', '--yes', ...containers]);
    assert.ok(withoutApproval.entries.every((e) => e.status !== 'removed'));
    const planned = dss([
      'clean',
      '--dry-run',
      '--remove-stopped-containers',
      ...containers,
    ]);
    assert.ok(
      !planned.entries.some((entry) =>
        entry.description.includes('unsaved-work')
      ),
      'unsaved Git work is excluded from the removal plan'
    );
    const cleaned = dss([
      'clean',
      '--yes',
      '--remove-stopped-containers',
      ...containers,
    ]);
    checkContainerClean(cleaned, planned);
    log('stopped container removed after a log backup, unsaved Git work kept');

    const audits = readdirSync(join(work, 'audit'));
    assert.equal(audits.length, 5, audits.join(', '));
    log('an audit log was written for every run');
    log('PASS');
  } finally {
    if (keep) {
      log(`kept ${L1} and ${work}`);
    } else {
      teardown();
      rmSync(work, { recursive: true, force: true });
    }
  }
}

main();
