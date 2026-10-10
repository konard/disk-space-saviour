import { batches } from '../env/batches.js';

/** Root overlay from the running container's mount namespace, read by its daemon. */
export function rootUpperdir(mountinfo) {
  for (const line of mountinfo.split('\n')) {
    const [mount, filesystem] = line.split(' - ');
    if (mount.split(' ')[4] !== '/' || !filesystem?.startsWith('overlay ')) {
      continue;
    }
    const options = filesystem.split(' ').slice(2).join(' ');
    const upper = /(?:^|,)upperdir=([^,]+)/.exec(options)?.[1];
    if (upper) {
      return upper.replace(/\\([0-7]{3})/g, (_, code) =>
        String.fromCharCode(Number.parseInt(code, 8))
      );
    }
  }
  return null;
}

/** One transport call per bounded batch; null means inaccessible, never guessed. */
export async function upperdirBytes(executor, paths) {
  const measured = new Map();
  const script = `for t do
    printf '\\001%s\\n' "$t"
    value=$(LC_ALL=C du -skx -- "$t" 2>&1)
    code=$?
    if [ "$code" = 0 ]; then printf '%s\\n' "$value" | cut -f1
    else case "$value" in *'No such file or directory'*) echo 0 ;; *) echo unknown ;; esac; fi
  done`;
  for (const batch of batches(paths)) {
    const result = await executor.run(['sh', '-c', script, 'dss', ...batch]);
    for (const record of result.stdout.split('\u0001').slice(1)) {
      const newline = record.indexOf('\n'),
        target = record.slice(0, newline),
        value = record.slice(newline + 1).trim();
      measured.set(
        target,
        result.code === 0 && /^\d+$/.test(value) ? Number(value) * 1024 : null
      );
    }
  }
  return measured;
}
