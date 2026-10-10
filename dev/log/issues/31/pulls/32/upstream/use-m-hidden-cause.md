## Problem

When every CDN mirror fails, use-m 8.16.4 reports only that each import failed, never **why**:

```
Error: Failed to import 'command-stream' from any CDN mirror.
Attempts:
  - deno (attempt 1/1): Failed to import module from 'https://esm.sh/command-stream@latest'.
  - jspm (attempt 1/1): Failed to import module from 'https://jspm.dev/command-stream'.
  - skypack (attempt 1/1): Failed to import module from 'https://cdn.skypack.dev/command-stream'.
```

The thrown error has only `stack` and `message`: no `cause` and no `errors`. The real failure here was `TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be a file URL object ... Received 'shelljs'` from the esm.sh build (https://github.com/link-foundation/command-stream/issues/219). Finding it meant importing the CDN URL by hand.

The cause is in `use.js`. `baseUse` wraps the import error correctly:

```js
throw new Error(`Failed to import module from '${modulePath}'.`, { cause: error });
```

But `loadWithFallback` keeps only the wrapper's `message` and throws a fresh `Error`:

```js
const reason = error && error.message ? error.message : String(error)
failures.push(`${describeSource(source)} (attempt ${attempt}/${maxAttemptsPerSource}): ${reason}`)
...
throw new Error(`Failed to ${label}...\nAttempts:\n  - ` + failures.join('\n  - '))
```

## Reproduce (Deno 2.9.6)

```js
// probe.mjs
const { use } = eval(await (await fetch('https://unpkg.com/use-m/use.js')).text());
try { await use('command-stream'); } catch (e) {
  console.log(e.message);
  console.log(Object.getOwnPropertyNames(e), e.cause);   // [ "stack", "message" ] undefined
}
```

`deno run -A --no-lock probe.mjs`

## Workaround

Import each mirror URL directly to see the real error, for example `await import('https://esm.sh/command-stream@latest')`.

## Suggested fix

Keep the chain of causes, both in the text and as data:

```js
const failures = [], errors = []
...
} catch (error) {
  errors.push(error)
  const root = error?.cause ?? error
  const reason = error?.message ?? String(error)
  const detail = root !== error && root?.message ? ` (${root.name ?? 'Error'}: ${root.message})` : ''
  failures.push(`${describeSource(source)} (attempt ${attempt}/${maxAttemptsPerSource}): ${reason}${detail}`)
}
...
throw new AggregateError(errors, `Failed to ${label}...\nAttempts:\n  - ` + failures.join('\n  - '))
```
