import { describe, it, expect } from 'test-anywhere';
import { HealthWatch } from '../src/health.js';

const item = { env: 'host', envLabel: 'host', id: 'host:cache' };
const proc = (pid, name, mountNamespace) => ({
  pid,
  name,
  startTime: '100',
  mountNamespace,
});

describe('issue 37 task health namespace boundaries', () => {
  it('ignores an agent in a container namespace but still watches host builds', async () => {
    const init = proc(1, 'init', 'mnt:[1]');
    const cargo = proc(2, 'cargo', 'mnt:[1]');
    const agent = proc(3, 'claude', 'mnt:[2]');
    let processes = [init, cargo, agent];
    const env = {
      kind: 'host',
      mountNamespace: 'mnt:[1]',
      processes: async () => processes,
    };
    const watch = new HealthWatch();
    await watch.baseline(env, item);
    expect(watch.records[0].watched.map((p) => p.pid)).toEqual([1, 2]);
    processes = [init, cargo];
    expect(await watch.check(env, item)).toBe(null);
    processes = [init];
    expect(await watch.check(env, item)).toMatch(/cargo.*exited/);
  });
  it('keeps agents watched when namespace metadata is unavailable or cleaning a container', async () => {
    for (const kind of ['host', 'container']) {
      const watch = new HealthWatch();
      const env = {
        kind,
        mountNamespace: 'mnt:[1]',
        processes: async () => [
          proc(3, 'codex', kind === 'host' ? null : 'mnt:[2]'),
        ],
      };
      await watch.baseline(env, item);
      expect(watch.verify(item, [])).toMatch(/codex.*exited/);
    }
  });
});
