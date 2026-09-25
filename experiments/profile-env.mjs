// Usage: node experiments/profile-env.mjs <scanner> [roots...]
// Counts and times environment adapter calls made by one scanner.
import { performance } from 'node:perf_hooks';

import { LocalEnv } from '../src/env/local.js';
import { GitInspector } from '../src/git.js';
import { LivenessProbe } from '../src/liveness.js';

const [name, ...roots] = process.argv.slice(2);
const stats = new Map();
const env = new Proxy(new LocalEnv(), {
  get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') {
      return value;
    }
    return async (...args) => {
      const started = performance.now();
      try {
        return await value.apply(target, args);
      } finally {
        const entry = stats.get(key) ?? { calls: 0, ms: 0 };
        entry.calls++;
        entry.ms += performance.now() - started;
        stats.set(key, entry);
      }
    };
  },
});
const module = await import(`../src/scanners/${name}.js`);
const scan = Object.entries(module).find(([key]) => key.startsWith('scan'))[1];
const liveness = new LivenessProbe(env, { staleAgeMs: 3600e3 });
await liveness.refresh();
const homes = await env.homeDirs();
const started = performance.now();
await scan({
  env,
  git: new GitInspector(env),
  liveness,
  now: Date.now(),
  options: {
    roots: roots.length ? roots : homes,
    homes,
    tmpDirs: await env.tmpDirs(),
    maxDepth: 6,
    staleAgeMs: 3600e3,
    inactiveMs: 30 * 86400e3,
  },
});
console.log(`total ${Math.round(performance.now() - started)} ms`);
for (const [key, entry] of [...stats].sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(
    `${String(key).padEnd(14)} ${entry.calls} calls ${Math.round(entry.ms)} ms`
  );
}
