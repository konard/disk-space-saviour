/** One bounded, serialized change snapshot per executor/container per run. */
import { trace } from '../exec.js';
let queue = Promise.resolve();
const snapshots = new WeakMap();
export function resetDiffSnapshots(executor) {
  snapshots.delete(executor);
}
export function diffSnapshot(docker, id, { fresh = false } = {}) {
  const executor = docker.executor;
  if (!snapshots.has(executor)) {
    snapshots.set(executor, new Map());
  }
  const registry = snapshots.get(executor);
  if (fresh) {
    // Safety checks before container removal must see newly copied Git work.
    registry.delete(id);
  }
  if (!registry.has(id)) {
    const acquire = async () => {
      const memory = await executor
        .run(['cat', '/proc/meminfo'])
        .catch(() => null);
      let available =
        Number(/^MemAvailable:\s+(\d+)/m.exec(memory?.stdout ?? '')?.[1]) *
        1024;
      const cgroup = await executor
        .run([
          'cat',
          '/sys/fs/cgroup/memory.max',
          '/sys/fs/cgroup/memory.current',
        ])
        .catch(() => null);
      const [limit, used] = (cgroup?.stdout ?? '')
        .trim()
        .split(/\s+/)
        .map(Number);
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
        available = Math.min(available, Math.max(0, limit - used));
      }
      if (!available || available < 512 * 1024 ** 2) {
        trace(
          'skipping docker diff: memory headroom unavailable or below 512 MiB',
          id
        );
        return null;
      }
      trace('docker diff snapshot', id, '(concurrency 1)');
      const result = await docker.run(['diff', id], {
        maxCaptureBytes: 8 * 1024 ** 2,
      });
      return result.code === 0 &&
        !result.truncated &&
        result.stdout.split('\n').length <= 100000
        ? result.stdout
        : null;
    };
    const pending = queue.then(acquire, acquire);
    queue = pending.then(
      () => {},
      () => {}
    );
    registry.set(id, pending);
  }
  return registry.get(id);
}
