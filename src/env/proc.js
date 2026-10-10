/** Linux proc inspection preserves evidence when only some PIDs are denied. */
import { promises as fsp } from 'node:fs';
import { checkSignal } from './scope.js';

export async function procIdentity(base, io = fsp) {
  const read = (name) => io.readFile(`${base}/${name}`, 'utf8').catch(() => '');
  const [status, comm, command] = await Promise.all([
    read('status'),
    read('comm'),
    read('cmdline'),
  ]);
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  const gid = /^Gid:\s+(\d+)/m.exec(status)?.[1];
  return {
    pid: Number(base.split('/').at(-1)),
    uid: uid === undefined ? null : Number(uid),
    gid: gid === undefined ? null : Number(gid),
    groups:
      /^Groups:\s*(.*)$/m
        .exec(status)?.[1]
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number) ?? null,
    name: comm.trim(),
    argv: command.split('\0').filter(Boolean),
    command: command.replaceAll('\0', ' '),
  };
}

export async function procOpenPaths(io = fsp, signal) {
  const paths = new Set();
  const unreadable = [];
  const pids = (await io.readdir('/proc')).filter((pid) => /^\d+$/.test(pid));
  for (const pid of pids) {
    checkSignal(signal);
    const base = `/proc/${pid}`;
    const stat = await io.readFile(`${base}/stat`, 'utf8').catch(() => '');
    if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) {
      continue;
    }
    let denied = false;
    const failure = (error) => {
      if (['EACCES', 'EPERM'].includes(error.code)) {
        denied = true;
      }
      return '';
    };
    const fds = await io.readdir(`${base}/fd`).catch((error) => {
      failure(error);
      return [];
    });
    for (const link of ['cwd', 'exe', ...fds.map((fd) => `fd/${fd}`)]) {
      checkSignal(signal);
      const target = await io.readlink(`${base}/${link}`).catch(failure);
      if (target.startsWith('/')) {
        paths.add(target.replace(/ \(deleted\)$/, ''));
      }
    }
    if (denied) {
      unreadable.push(await procIdentity(base, io));
    }
  }
  return { paths, unreadable };
}
