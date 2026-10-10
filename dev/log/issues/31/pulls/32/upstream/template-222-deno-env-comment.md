Follow-up from applying this fix downstream ([disk-space-saviour#32](https://github.com/link-foundation/disk-space-saviour/pull/32)). Once Deno runs with `-A`, some fixtures this template already has start failing on GitHub Actions only:

- `tests/install-git-hooks.test.js` `runPrepare` deletes `CI` and `HUSKY`;
- `tests/pr-guards.test.js` deletes `CI`, `GITHUB_*` and similar keys from `cleanEnv`;
- `tests/detect-code-changes.test.js` deletes `GITHUB_BASE_SHA`, `GITHUB_BEFORE_SHA` and `GITHUB_AFTER_SHA`.

Deno's `spawnSync` and `execFileSync` merge the `env` they are passed into the parent's environment, so a deleted key still reaches the child ([denoland/deno#36996](https://github.com/denoland/deno/issues/36996); the earlier fix in #27343 covered only async `spawn`). On a runner the child saw `CI=true`, and three tests failed on every Deno leg: [run 38003106785](https://github.com/link-foundation/disk-space-saviour/actions/runs/38003106785).

Workaround, applied in [9490eec](https://github.com/link-foundation/disk-space-saviour/commit/9490eec): blank the variable instead of deleting it. The scripts read these as truthy strings or with `?? ''`, so blank means unset to them, and a blank value reaches the child on every runtime:

```js
// tests/helpers/env.js
export function blankEnv(env, drop) {
  const copy = { ...env };
  for (const name of Object.keys(copy)) {
    if (drop(name)) {
      copy[name] = '';
    }
  }
  return copy;
}
```

A guard test fails on any `delete <...env...>.X` / `[...]` in `tests/*.test.js`. Two more issues appear only once fixtures run on Deno on Windows:

- `utimesSync` on read-only Git objects fails there ([denoland/deno#36997](https://github.com/denoland/deno/issues/36997)), if a fixture ages a repository;
- a regex over a workflow file must accept `\r?\n`, because Windows checkouts are CRLF.
