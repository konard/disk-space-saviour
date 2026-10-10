## Problem

`child_process.spawnSync`, `execFileSync` and `execSync` give the child the parent's whole environment plus the `env` they are passed. Node gives the child only the `env` it is passed. So a variable that the caller removed from `env` still reaches the child.

Async `spawn` was fixed for this in #27343 (PR #27340), and it now clears the environment. The sync path was not fixed. On `main` (a18ce33715e30cd2b0d99c7e322ef11a65490e4d), `ext/node/polyfills/internal/child_process.ts` has two call sites:

- `ChildProcess` constructor (async `spawn`): `nodeSpawnChild(cmd, { args: cmdArgs, clearEnv: true, cwd, env, ... })`
- `spawnSync`: `nodeSpawnSyncChild({ args: [...], cwd, env: mapValues(env, ...), ..., clearEnv: false, ... })`

`normalizeSpawnArguments` already sets `env` to `options.env || Deno.env.toObject()`. So `clearEnv: true` would not change the default case, where no `env` is passed.

This hit us on GitHub Actions. A test removed `CI` from a copy of `process.env` and ran a script with `execFileSync`. The script still saw `CI=true` on every Deno runner, and it took its CI branch: [disk-space-saviour#31](https://github.com/link-foundation/disk-space-saviour/issues/31), run [38003106785](https://github.com/link-foundation/disk-space-saviour/actions/runs/38003106785).

## Reproduce

```js
// probe.mjs
import { spawn, spawnSync } from 'node:child_process';

const env = { ...process.env };
delete env.PROBE;
const script = 'echo "${PROBE-<unset>}"';

console.log('spawnSync:', spawnSync('sh', ['-c', script], { env, encoding: 'utf8' }).stdout.trim());
spawn('sh', ['-c', script], { env, stdio: 'inherit' }).on('close', () => {});
```

```sh
PROBE=leaked node probe.mjs          # spawnSync: <unset>   then  <unset>
PROBE=leaked deno run -A probe.mjs   # spawnSync: leaked    then  <unset>
```

(Deno 2.9.6.) The exact repro from #27343 shows the same thing with the sync API: `spawnSync('env', { env: { test: 'test' } })` prints the parent's variables as well as `test=test`.

## Workaround

Pass a blank value instead of deleting the key, as in `{ ...process.env, CI: '' }`. A blank value overrides the parent's value on every runtime. This only helps when the child treats an empty variable as unset.

## Suggested fix

In `spawnSync` in `ext/node/polyfills/internal/child_process.ts`, pass `clearEnv: true` as the async path does:

```diff
       uid,
       gid,
-      clearEnv: false,
+      clearEnv: true,
       extraStdio: extraStdioNormalized,
```

Port Node's `test-child-process-spawnsync-env.js` and an `execFileSync` variant of the #27343 test, to keep the sync path from drifting again.
