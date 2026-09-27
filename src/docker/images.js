/**
 * Unused tagged images: who used them last and per-image consent.
 *
 * An unused tagged image is never removed by a tier, emergency mode
 * included: only an operator naming it with `--remove-image REF` (or an
 * interactive yes for that image) approves `docker image rm`.
 *
 * "Last used by" comes from the `inspect.json` backups dss writes before it
 * removes a stopped container (`<backupDir>/<run>/<env>/<container>/`).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { ownerOf } from './containers.js';

const SHORT_ID = 12;
const MAX_BACKUPS = 200;

const bareId = (id) => String(id ?? '').replace(/^sha256:/, '');

/**
 * Whether the operator named this image: `repo:tag`, `repo` for
 * `repo:latest`, or an image id (with or without `sha256:`) prefix of at
 * least 12 characters.
 * @param {string[]} names
 * @param {{ref: string, id: string}} image
 */
export function imageNamed(names, image) {
  const id = bareId(image.id);
  return (names ?? []).some((entry) => {
    const bare = bareId(entry);
    return (
      entry === image.ref ||
      `${entry}:latest` === image.ref ||
      (bare.length >= SHORT_ID &&
        id.length >= SHORT_ID &&
        /^[0-9a-f]+$/i.test(bare) &&
        (id.startsWith(bare) || bare.startsWith(id)))
    );
  });
}

async function subdirs(dir) {
  const entries = await fsp
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

async function inspectBackups(backupDir) {
  const runs = (await subdirs(backupDir)).sort().reverse();
  const files = [];
  for (const run of runs) {
    for (const env of await subdirs(run)) {
      for (const container of await subdirs(env)) {
        files.push(path.join(container, 'inspect.json'));
        if (files.length >= MAX_BACKUPS) {
          return files;
        }
      }
    }
  }
  return files;
}

function lastUser(inspected) {
  const name = String(inspected.Name ?? '').replace(/^\//, '');
  const owner = ownerOf({ Names: name }, inspected);
  return {
    container: name,
    session: owner.session,
    taskUrl: owner.taskUrl,
    finishedAt: owner.finishedAt,
  };
}

/**
 * The last removed container of every image, keyed by image id and by
 * `ref:<image reference>`.
 * @param {string} backupDir
 * @returns {Promise<Map<string, object>>}
 */
export async function lastUsers(backupDir) {
  const users = new Map();
  const remember = (key, user) => {
    const known = users.get(key);
    if (!known || String(user.finishedAt) > String(known.finishedAt)) {
      users.set(key, user);
    }
  };
  for (const file of await inspectBackups(backupDir)) {
    try {
      const inspected = JSON.parse(await fsp.readFile(file, 'utf8'));
      const user = lastUser(inspected);
      if (inspected.Image) {
        remember(bareId(inspected.Image), user);
      }
      if (inspected.Config?.Image) {
        remember(`ref:${inspected.Config.Image}`, user);
      }
    } catch {
      // A partial or foreign backup says nothing about image use.
    }
  }
  return users;
}

/**
 * Looks up the last user of an image by id prefix, then by reference.
 */
export function lastUserOf(users, image) {
  const id = bareId(image.id);
  for (const [key, user] of users) {
    if (id.length >= SHORT_ID && key.startsWith(id)) {
      return user;
    }
  }
  return users.get(`ref:${image.ref}`) ?? null;
}
