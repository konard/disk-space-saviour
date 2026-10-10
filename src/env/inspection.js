import { OPEN_PATHS_SCRIPT } from './process-scripts.js';
import { trace } from '../exec.js';

export function parseProcessProbe(result) {
  const gids = new Map(
    result.stderr
      .split('\n')
      .filter((line) => line.startsWith('DSS_GID|'))
      .map((line) => {
        const [, pid, gid] = line.split('|');
        return [Number(pid), gid ? Number(gid) : null];
      })
  );
  return {
    paths: new Set(
      result.stdout
        .split('\n')
        .filter((line) => line.startsWith('/'))
        .map((line) => line.replace(/ \(deleted\)$/, ''))
    ),
    unreadable: result.stderr
      .split('\n')
      .filter((line) => line.startsWith('DSS_UNREADABLE|'))
      .map((line) => {
        const [, pid, uid, name, ...command] = line.split('|');
        return {
          pid: Number(pid),
          uid: uid ? Number(uid) : null,
          gid: gids.get(Number(pid)) ?? null,
          name,
          command: command.join('|'),
        };
      }),
  };
}

/** Root without ptrace can often inspect a dumpable process as its own UID/GID. */
export async function retryProcessOwners(executor, evidence) {
  const groups = new Map();
  for (const proc of evidence.unreadable) {
    if (
      !Number.isInteger(proc.uid) ||
      !Number.isInteger(proc.gid) ||
      proc.uid === 0
    ) {
      continue;
    }
    const key = `${proc.uid}:${proc.gid}`;
    groups.set(key, [...(groups.get(key) ?? []), proc]);
  }
  const unresolved = new Map(
    evidence.unreadable.map((proc) => [proc.pid, proc])
  );
  for (const [identity, procs] of groups) {
    const [uid, gid] = identity.split(':');
    trace(
      'process inspection as owning uid/gid',
      identity,
      procs.map((proc) => proc.pid)
    );
    const result = await executor.run([
      'setpriv',
      `--reuid=${uid}`,
      `--regid=${gid}`,
      '--clear-groups',
      'sh',
      '-c',
      OPEN_PATHS_SCRIPT,
      'dss',
      ...procs.map((proc) => `/proc/${proc.pid}`),
    ]);
    const retried = parseProcessProbe(result);
    for (const target of retried.paths) {
      evidence.paths.add(target);
    }
    if (result.code === 0 || retried.unreadable.length) {
      for (const proc of procs) {
        unresolved.delete(proc.pid);
      }
      for (const proc of retried.unreadable) {
        unresolved.set(proc.pid, proc);
      }
    }
  }
  return { paths: evidence.paths, unreadable: [...unresolved.values()] };
}

export function inspectionHint(unreadable) {
  if (!unreadable.length) {
    return null;
  }
  const identities = unreadable
    .slice(0, 5)
    .map(
      (proc) =>
        `${proc.name || 'unknown'} pid ${proc.pid} uid ${proc.uid ?? '?'} gid ${proc.gid ?? '?'}`
    )
    .join('; ');
  return `${unreadable.length} processes are unreadable (${identities}). Activity uncertainty is scoped to daemon storage and accessible paths. Inspect as the owning UID/GID (setpriv), or grant CAP_SYS_PTRACE for read-only inspection; root alone may lack that capability.`;
}
