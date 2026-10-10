## Problem

`command-stream@2.0.0` cannot be imported from esm.sh on Deno. Every import fails, including `import { $ } from 'https://esm.sh/command-stream@2.0.0'`, even when only `$` is used:

```
TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received 'shelljs'
    at createRequire (node:module:5:4312)
    at https://esm.sh/command-stream@2.0.0/denonext/shelljs.mjs:4:1729
    at https://esm.sh/command-stream@2.0.0/denonext/shelljs.mjs:4:463
```

The cause is two pieces of code working together:

- `src/$.mjs` line 1 loads the ShellJS compatibility layer eagerly: `import shelljs from './shelljs/index.mjs';`.
- `src/shelljs/index.cjs` resolves the real package path at load time:
  ```js
  const { createRequire } = require('node:module');
  const shellRequire = createRequire(require.resolve('shelljs'));
  ```

esm.sh has no file system to resolve against, so it compiles `require.resolve('shelljs')` to the bare string `'shelljs'`. Deno's `node:module.createRequire` rejects anything that is not an absolute path or a file URL. Node and Bun are unaffected, because there `require.resolve` returns a real path.

This matters because use-m, which the link-foundation pipeline template uses to load `command-stream` in its release scripts, loads packages from CDNs (esm.sh first) on Deno. Downstream, [disk-space-saviour#31](https://github.com/link-foundation/disk-space-saviour/issues/31) has to skip its use-m integration tests on Deno because of this.

## Reproduce

```sh
cat > probe.mjs <<'JS'
const { $ } = await import('https://esm.sh/command-stream@2.0.0');
console.log(typeof $);
JS
deno run -A --no-lock probe.mjs     # TypeError [ERR_INVALID_ARG_VALUE] ... Received 'shelljs'
```

(Deno 2.9.6.)

## Workaround

On Deno, import from npm instead of a CDN. This works:

```js
const { $ } = await import('npm:command-stream@2.0.0');
console.log((await $`echo hi`).stdout); // "hi\n"
```

## Suggested fix

Any one of the following:

1. **Load the ShellJS layer lazily**, so that importing `$` never evaluates `shelljs/index.cjs`. The getter already exists (`Object.defineProperty($tagged, 'shelljs', { get: () => shelljs })`). It could load the module on first access, or the compat layer could move to its own export subpath (`command-stream/shelljs`).
2. **Make the patch independent of `createRequire`.** `require('fast-glob')` resolves from command-stream's own dependency tree, which is the same `fast-glob` that a hoisted install gives ShellJS. Alternatively, guard the call:
   ```js
   let shellRequire = require;
   try {
     const resolved = require.resolve('shelljs');
     if (require('node:path').isAbsolute(resolved)) shellRequire = createRequire(resolved);
   } catch {}
   ```
3. **Add a Deno CI leg** that imports the published package from esm.sh, so CDN-build regressions are caught before release.
