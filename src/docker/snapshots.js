/** One bounded, serialized change snapshot per executor/container per run. */
import { trace } from '../exec.js';
let queue = Promise.resolve();
const snapshots = new WeakMap();
export function resetDiffSnapshots(executor) {
  snapshots.delete(executor);
}
export function diffSnapshot(docker, id) {
  const executor = docker.executor;
  if (!snapshots.has(executor)) {
    snapshots.set(executor, new Map());
  }
  const registry = snapshots.get(executor);
  if (!registry.has(id)) {
    const acquire = async () => {
      const memory = await executor
        .run(['cat', '/proc/meminfo'])
        .catch(() => null);
      const available =
        Number(/^MemAvailable:\s+(\d+)/m.exec(memory?.stdout ?? '')?.[1]) *
        1024;
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
