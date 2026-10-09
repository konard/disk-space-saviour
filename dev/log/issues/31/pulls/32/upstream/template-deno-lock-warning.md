## Problem

Every Release job annotates a warning that nobody can act on:

```
##[warning]lockfile(s) for another package manager at the repository root: deno.lock. The npm declaration outranks them, but any tool embedding the same lockfile table without reading the declaration will pick the wrong agent.
```

The warning comes from `scripts/check-package-manager.mjs`, which says each foreign lockfile is "pure downside". `deno.lock` is not: `deno test` writes and reads it for `deno.json`, the Deno leg of the test matrix needs it, and the template keeps it in sync on purpose. The warning therefore fires on every release, and a warning that fires on every release teaches readers to skip warnings.

Seen downstream in disk-space-saviour run [37987850798](https://github.com/link-foundation/disk-space-saviour/actions/runs/37987850798) (attempt 2, job Release). The template's `scripts/check-package-manager.mjs` is byte-identical, and the template keeps `deno.lock` and `deno.json` at the root as well.

## Reproduce

```sh
git clone --depth 1 https://github.com/link-foundation/js-ai-driven-development-pipeline-template /tmp/tpl
cd /tmp/tpl && node scripts/check-package-manager.mjs
# ::warning::lockfile(s) for another package manager at the repository root: deno.lock. ...
```

## Workaround

None short of deleting `deno.lock`, which makes the Deno leg re-resolve every range (and trips Deno's minimum dependency age, see #220).

## Suggested fix (applied downstream in disk-space-saviour PR 32)

List a lockfile that a runtime keeps for its own config in the passing line instead of warning about it. Every other foreign lockfile still warns:

```js
const RUNTIME_LOCKFILES = {
  'deno.lock': ['deno.json', 'deno.jsonc'],
};

const foreign = FOREIGN_LOCKFILES.filter((lock) => existsSync(lock));
const runtimeKept = foreign.filter((lock) =>
  (RUNTIME_LOCKFILES[lock] ?? []).some((config) => existsSync(config))
);
const unexpected = foreign.filter((lock) => !runtimeKept.includes(lock));

if (declared === EXPECTED && unexpected.length > 0) {
  console.warn(
    `::warning::lockfile(s) for another package manager at the repository root: ${unexpected.join(', ')}. ...`
  );
}
```

The output becomes `Package manager check passed: declared "npm", 1 foreign lockfile(s) present (outranked by the declaration): deno.lock (kept by Deno for deno.json).` Tests: `tests/package-manager.test.js` asserts that the repository itself passes without `::warning::`, and that a `deno.lock` + `deno.json` fixture does not warn, while `bun.lock` + `deno.lock` without `deno.json` still warns. Commit: https://github.com/link-foundation/disk-space-saviour/commit/9691cfb
