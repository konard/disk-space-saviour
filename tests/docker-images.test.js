/**
 * Unused tagged images are removed only with per-image consent
 * (`--remove-image REF` or an interactive yes for that image), in every
 * tier and in emergency mode; the report shows size, creation date and the
 * container that used the image last.
 */

import { describe, it, expect } from 'test-anywhere';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clean } from '../src/clean.js';
import { imageNamed, lastUserOf, lastUsers } from '../src/docker/images.js';
import { emergency } from '../src/emergency.js';
import { resolveOptions } from '../src/options.js';
import { formatReport } from '../src/report.js';
import {
  FakeDockerWorld,
  daemonInfo,
  fakeHostEnv,
  scanWorld,
} from './helpers/fake-docker.js';
import { itUnless, sandboxed } from './helpers/skip.js';

const BIG = 'ab12cd34ef56ab12cd34ef56';
const SMALL = 'ff00ee11dd22cc33bb44aa55';
const SESSION = '6f1c2a3b-0d4e-4f5a-8b6c-7d8e9f0a1b2c';

// eslint-disable-next-line local/no-changelog-comments -- `docker system df` time format
const CREATED = '2026-08-01 09:00:00 +0000 UTC';

function image(id, repository, tag, size) {
  return {
    ID: id,
    Repository: repository,
    Tag: tag,
    Size: size,
    UniqueSize: size,
    Containers: '0',
    CreatedAt: CREATED,
  };
}

function world() {
  return new FakeDockerWorld({
    host: {
      info: daemonInfo('HOST', 'host-daemon'),
      containers: [],
      images: [
        image(BIG, 'ghcr.io/link-assistant/formal-ai', 'latest', '24.3GB'),
        image(SMALL, 'alpine', '3.20', '8MB'),
      ],
    },
  });
}

/** A backup of a removed container that ran the big image. */
function writeBackup(backupDir) {
  const dir = join(backupDir, '2026-09-20T10-00-00-000Z', 'host', 'solve-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'inspect.json'),
    JSON.stringify({
      Name: '/solve-1',
      Image: `sha256:${BIG}${'0'.repeat(40)}`,
      State: { Status: 'exited', FinishedAt: '2026-09-20T10:00:00Z' },
      Config: {
        Image: 'ghcr.io/link-assistant/formal-ai:latest',
        Env: [`HIVE_MIND_PARENT_SESSION_ID=${SESSION}`],
        Labels: {},
      },
    })
  );
}

function withDirs(run) {
  const root = mkdtempSync(join(tmpdir(), 'dss-images-'));
  const backupDir = join(root, 'backups');
  return run({ root, backupDir }).finally(() =>
    rmSync(root, { recursive: true, force: true })
  );
}

const imageRms = (fake) =>
  fake.dockerCalls().filter((args) => args[0] === 'image' && args[1] === 'rm');

describe('naming unused images', () => {
  const big = { ref: 'ghcr.io/link-assistant/formal-ai:latest', id: BIG };

  it('matches a reference, a repository at latest or an id prefix', () => {
    for (const name of [
      big.ref,
      'ghcr.io/link-assistant/formal-ai',
      BIG.slice(0, 12),
      `sha256:${BIG}`,
    ]) {
      expect(imageNamed([name], big)).toBe(true);
    }
    for (const name of ['formal-ai', BIG.slice(0, 6), 'alpine:3.20']) {
      expect(imageNamed([name], big)).toBe(false);
    }
    expect(imageNamed(undefined, big)).toBe(false);
    expect(imageNamed([BIG], { ref: 'x:1', id: '' })).toBe(false);
  });

  it('refuses blanket consent for every unused image', () => {
    expect(() => resolveOptions({ removeUnusedImages: true })).toThrow(
      '--remove-image REF'
    );
  });

  itUnless(sandboxed)(
    'finds the last container that used an image in the backups',
    async () => {
      await withDirs(async ({ backupDir }) => {
        writeBackup(backupDir);
        const users = await lastUsers(backupDir);
        const user = lastUserOf(users, big);
        expect(user.container).toBe('solve-1');
        expect(user.session).toBe(SESSION);
        expect(user.finishedAt).toBe('2026-09-20T10:00:00Z');
        expect(lastUserOf(users, { ref: big.ref, id: 'other' })).toEqual(user);
        expect(lastUserOf(users, { ref: 'alpine:3.20', id: SMALL })).toBe(null);
        expect((await lastUsers(join(backupDir, 'missing'))).size).toBe(0);
      });
    }
  );
});

describe('unused images in a scan and a clean', () => {
  itUnless(sandboxed)('reports size, creation date and last user', async () => {
    await withDirs(async ({ backupDir }) => {
      writeBackup(backupDir);
      const { result, report } = await scanWorld(world(), { backupDir });
      const images = result.items.filter((item) => item.image);
      expect(images.map((item) => item.requiresConfirmation)).toEqual([
        'removeImages',
        'removeImages',
      ]);
      const text = formatReport(report);
      expect(text).toContain(
        `image ghcr.io/link-assistant/formal-ai:latest (${BIG.slice(0, 12)}) unused, `
      );
      expect(text).toContain(`created ${CREATED}`);
      expect(text).toContain(
        `last used by container solve-1 (session ${SESSION}, ended 2026-09-20T10:00:00Z)`
      );
      expect(text).toContain(
        'needs --remove-image ghcr.io/link-assistant/formal-ai:latest'
      );
      expect(text).toContain('alpine:3.20');
      expect(text).toContain('last use unknown');
    });
  });

  itUnless(sandboxed)('never removes an image by tier alone', async () => {
    const fake = world();
    const { env, report } = await scanWorld(fake);
    const audit = await clean(report, {
      env,
      tier: 'moderate',
      only: ['docker-unused-image'],
      removeStoppedContainers: true,
      audit: false,
    });
    expect(audit.entries.map((entry) => entry.status)).toEqual([
      'skipped',
      'skipped',
    ]);
    expect(audit.entries[0].reason).toContain(
      'needs --remove-image ghcr.io/link-assistant/formal-ai:latest'
    );
    expect(imageRms(fake)).toEqual([]);
  });

  itUnless(sandboxed)('removes only the named image', async () => {
    const fake = world();
    const { env, report } = await scanWorld(fake);
    const audit = await clean(report, {
      env,
      tier: 'moderate',
      only: ['docker-unused-image'],
      removeImages: ['alpine:3.20'],
      audit: false,
    });
    const status = Object.fromEntries(
      audit.entries.map((entry) => [entry.description, entry.status])
    );
    expect(status).toEqual({
      'unused Docker image ghcr.io/link-assistant/formal-ai:latest': 'skipped',
      'unused Docker image alpine:3.20': 'removed',
    });
    expect(imageRms(fake)).toEqual([['image', 'rm', SMALL]]);
  });

  itUnless(sandboxed)(
    'asks about each image when no image is named',
    async () => {
      const fake = world();
      const { env, report } = await scanWorld(fake);
      const asked = [];
      await clean(report, {
        env,
        tier: 'moderate',
        only: ['docker-unused-image'],
        confirm: (item) => {
          asked.push(item.image.ref);
          return item.image.ref === 'alpine:3.20';
        },
        audit: false,
      });
      expect(asked.sort()).toEqual([
        'alpine:3.20',
        'ghcr.io/link-assistant/formal-ai:latest',
      ]);
      expect(imageRms(fake)).toEqual([['image', 'rm', SMALL]]);
    }
  );

  itUnless(sandboxed)('keeps unnamed images in emergency mode', async () => {
    const fake = world();
    const { report } = await scanWorld(fake);
    const env = {
      ...fakeHostEnv(fake),
      diskUsage: () => Promise.resolve({ used: 99e9, free: 1e9 }),
    };
    const audit = await emergency({
      env,
      report,
      free: '100G',
      only: ['docker-unused-image'],
      removeStoppedContainers: true,
      audit: false,
    });
    expect(audit.goalMet).toBe(false);
    expect(audit.entries.every((entry) => entry.status !== 'removed')).toBe(
      true
    );
    expect(imageRms(fake)).toEqual([]);
  });
});
