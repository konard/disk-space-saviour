/**
 * System reclaimers that only the owning tool can clean correctly:
 * journald archives (`journalctl --vacuum-size`), disabled snap revisions
 * (`snap remove --revision`) and Homebrew's old versions and downloads
 * (`brew cleanup`). Plain cache directories live in ../rules/other.js.
 */

import { block, makeItem } from '../items.js';
import { parseSize } from '../units.js';
import { scanTimeBusy } from './common.js';

export const DEFAULT_JOURNAL_KEEP = 512 * 1024 ** 2;

/**
 * Bytes reported by `journalctl --disk-usage`.
 * @returns {number|null}
 */
export function parseJournalUsage(output) {
  const match = /take up ([\d.]+\s*[A-Za-z]*) in the file system/.exec(
    output ?? ''
  );
  return match ? parseSize(match[1]) : null;
}

/**
 * Disabled revisions from `snap list --all`.
 * @returns {Array<{name: string, revision: string}>}
 */
export function parseDisabledSnaps(output) {
  const lines = (output ?? '').split('\n').filter(Boolean);
  const header = lines.shift() ?? '';
  if (!/^Name\s+Version\s+Rev\b/.test(header)) {
    return [];
  }
  return lines
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 6 && /\bdisabled\b/.test(cols.at(-1)))
    .map((cols) => ({ name: cols[0], revision: cols[2] }));
}

/**
 * Size freed according to `brew cleanup --dry-run`.
 * @returns {number}
 */
export function parseBrewCleanup(output) {
  const total = /would free approximately ([\d.]+\s*[A-Za-z]+)/.exec(
    output ?? ''
  );
  if (total) {
    return parseSize(total[1]);
  }
  return [...(output ?? '').matchAll(/,\s*([\d.]+\s*[KMGT]?B)\)$/gm)].reduce(
    (sum, match) => sum + parseSize(match[1]),
    0
  );
}

function withBusy(context, item) {
  const busy = scanTimeBusy(context, item);
  if (busy) {
    block(item, `busy: ${busy}`);
  }
  return item;
}

async function journalItems(context, isRoot) {
  const { env, options } = context;
  if (!(await env.which('journalctl'))) {
    return [];
  }
  const result = await env.run(['journalctl', '--disk-usage']);
  const total = parseJournalUsage(`${result.stdout}\n${result.stderr}`);
  const keep = options.journalKeepBytes ?? DEFAULT_JOURNAL_KEEP;
  if (total === null || total <= keep) {
    return [];
  }
  const item = makeItem(env, {
    rule: 'journald-archives',
    kind: 'logs',
    ecosystem: 'system',
    description: 'systemd journal archives above the kept size',
    path: '/var/log/journal',
    bytes: total - keep,
    tier: 'moderate',
    reason: `journals take ${total} bytes, vacuuming keeps the newest ${keep}`,
    action: {
      type: 'command',
      argv: ['journalctl', `--vacuum-size=${keep}`],
      measure: ['/var/log/journal', '/run/log/journal'],
    },
    checks: { busy: [], cwd: null, mtime: false },
  });
  if (!isRoot) {
    block(item, 'system location, run as root to clean it');
  }
  return [item];
}

async function snapItems(context, isRoot) {
  const { env } = context;
  if (!(await env.which('snap'))) {
    return [];
  }
  const result = await env.run(['snap', 'list', '--all']);
  const items = [];
  for (const { name, revision } of parseDisabledSnaps(result.stdout)) {
    const file = `/var/lib/snapd/snaps/${name}_${revision}.snap`;
    const stat = await env.stat(file);
    const item = makeItem(env, {
      rule: 'snap-disabled-revision',
      kind: 'package',
      ecosystem: 'system',
      description: `disabled snap revision ${name} ${revision}`,
      path: file,
      bytes: stat?.bytes ?? 0,
      newestMtimeMs: stat?.mtimeMs ?? 0,
      tier: 'safe',
      reason: 'superseded revision kept only for rollback',
      action: {
        type: 'command',
        argv: ['snap', 'remove', name, `--revision=${revision}`],
        measure: [file],
      },
      checks: { busy: ['snap', 'snapd'], cwd: null, mtime: false },
    });
    if (!isRoot) {
      block(item, 'system location, run as root to clean it');
    }
    items.push(withBusy(context, item));
  }
  return items;
}

async function brewItems(context, isRoot) {
  const { env } = context;
  if (isRoot || !(await env.which('brew'))) {
    return [];
  }
  const result = await env.run(['brew', 'cleanup', '--dry-run']);
  const bytes = result.code === 0 ? parseBrewCleanup(result.stdout) : 0;
  if (bytes === 0) {
    return [];
  }
  const prefix = (await env.run(['brew', '--prefix'])).stdout.trim();
  const item = makeItem(env, {
    rule: 'brew-cleanup',
    kind: 'package',
    ecosystem: 'system',
    description: 'Homebrew outdated versions and stale downloads',
    path: prefix || 'brew',
    bytes,
    tier: 'moderate',
    reason: 'Homebrew may remove old kegs and unneeded dependencies',
    action: { type: 'command', argv: ['brew', 'cleanup'], measure: [] },
    checks: { busy: ['brew'], cwd: null, mtime: false },
  });
  return [withBusy(context, item)];
}

/**
 * Scans journald, snap and Homebrew.
 * @returns {Promise<object[]>} report items
 */
export async function scanSystem(context) {
  const isRoot = await context.env.isRoot();
  return [
    ...(await journalItems(context, isRoot)),
    ...(await snapItems(context, isRoot)),
    ...(await brewItems(context, isRoot)),
  ];
}
