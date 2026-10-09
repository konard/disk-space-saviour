## Problem

Every `Lint and Format Check` run prints:

```
Using config from .jscpd.json
config file .jscpd.json: unknown field 'skipComments'
```

(template run [37637246715](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/actions/runs/37637246715), job `Lint and Format Check`). The `jscpd` dependency is `^5.4.0`. jscpd 5 is a Rust rewrite whose config parser has no `skipComments` key; the jscpd 5 equivalent is `--skip-comments`, documented as "Alias for `--mode weak`". So the setting is ignored, a warning is printed, and the duplication check exits 0 as if the config had been applied. That counts as both a false positive (the check claims to apply settings it ignores) and a warning that hides others.

## Reproduce

```sh
npm ci
npx jscpd --reporters silent --threshold 100 .
# Using config from .jscpd.json
# config file .jscpd.json: unknown field 'skipComments'
```

## Suggested fix (applied downstream in disk-space-saviour PR 32)

```diff
-  "skipComments": true,
+  "mode": "weak",
```

Measured downstream with jscpd 5.4.0: the warning disappears, and the result is unchanged (317 clones, 6.89% duplicated lines in both cases). Add a test that runs jscpd with the repository config and fails on `unknown field`, so the next renamed key is caught. See `tests/jscpd-config.test.js` in https://github.com/link-foundation/disk-space-saviour/pull/32. On Deno it needs `-A`, like the other process-spawning tests.
