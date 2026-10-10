/**
 * JSON audit log written on every run (scan, clean, emergency), including
 * dry runs, so every decision and every deleted byte can be traced later.
 *
 * Location: `auditDir` option, `$DSS_AUDIT_DIR`, `$XDG_STATE_HOME/
 * disk-space-saviour/audit`, or `~/.local/state/disk-space-saviour/audit`.
 * Container log backups default to a `backups` directory next to it.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AUDIT_SCHEMA = 1;
let privateAuditDirectory;

export function throwIfAborted(options) {
  if (options.signal?.aborted) {
    throw new Error('cleanup aborted');
  }
}

function stateDir(vars) {
  const base =
    vars.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'disk-space-saviour');
}

/**
 * @param {{auditDir?: string|null}} [options]
 * @param {Record<string, string|undefined>} [vars] environment variables
 */
export function auditDirectory(options = {}, vars = process.env) {
  return (
    options.auditDir || vars.DSS_AUDIT_DIR || path.join(stateDir(vars), 'audit')
  );
}

/**
 * Where `docker logs` and `docker inspect` backups of removed containers go.
 */
export function backupDirectory(options = {}, vars = process.env) {
  return (
    options.backupDir ||
    vars.DSS_BACKUP_DIR ||
    path.join(stateDir(vars), 'backups')
  );
}

/**
 * Starts an audit record.
 * @param {string} command `scan`, `clean`, `emergency`
 * @param {object} [fields]
 */
export function startAudit(command, fields = {}) {
  return {
    schema: AUDIT_SCHEMA,
    tool: 'disk-space-saviour',
    command,
    pid: process.pid,
    user: os.userInfo().username,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    dryRun: false,
    entries: [],
    ...fields,
  };
}

/**
 * Writes the audit record, returning the file path.
 * @param {object} audit
 * @param {{auditDir?: string|null}} [options]
 * @returns {Promise<string>}
 */
export async function writeAudit(audit, options = {}) {
  let dir = auditDirectory(options);
  // sudo/docker exec may retain another user's HOME. Do not leave root-owned
  // default state there; explicit audit locations remain the caller's choice.
  if (
    !options.auditDir &&
    !process.env.DSS_AUDIT_DIR &&
    process.getuid?.() === 0
  ) {
    const home = os.homedir();
    const owner = await fsp.stat(home).catch(() => null);
    if (owner && owner.uid !== 0 && dir.startsWith(`${home}${path.sep}`)) {
      privateAuditDirectory ??= fsp.mkdtemp(
        path.join(os.tmpdir(), 'dss-audit-0-')
      );
      dir = await privateAuditDirectory;
    }
  }
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!options.inProgress) {
    audit.finishedAt ??= new Date().toISOString();
  }
  const stamp = audit.startedAt.replace(/[:.]/g, '-');
  const file = path.join(
    dir,
    `dss-${audit.command}-${stamp}-${audit.pid}.json`
  );
  await fsp.writeFile(file, `${JSON.stringify(audit, null, 2)}\n`);
  audit.file = file;
  return file;
}
