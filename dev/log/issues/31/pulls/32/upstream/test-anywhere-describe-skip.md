## Problem

`describe.skip` behaves differently on each runtime, and on Deno the skipped suite disappears from the report:

| Runtime | What `describe.skip('suite', fn)` reports |
| --- | --- |
| Node (`node --test`) | `﹣ skipped suite # SKIP` |
| Bun (`bun test`) | each child test as `skip` |
| Deno (`deno test`) | **nothing**: no test, no `ignored` entry |

The source is the same in 0.8.48 and in the latest release, 0.9.1 (`src/index.js`):

```js
describe.skip = function (name, fn) {
  if (runtime === 'bun') {
    return bunTest.describe.skip(name, fn);
  } else if (runtime === 'deno') {
    // For Deno, just don't execute the function (skip the entire suite)
    return;
  } ...
```

A suite skipped on Deno therefore looks exactly like a suite that does not exist, and the summary says `0 ignored`. Downstream ([disk-space-saviour#31](https://github.com/link-foundation/disk-space-saviour/issues/31), [js-ai-driven-development-pipeline-template#222](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/issues/222)) this, together with registration-time `if` gates, made Deno report 746 tests against Node's 904, with nothing saying why.

There is also no way to give a skip **reason** through the shared API. Node's `test(name, { skip: 'reason' }, fn)` prints `# SKIP reason`, and Deno's `ignore` takes no reason. Callers end up embedding the reason in the test name.

## Reproduce

`describe-skip.test.mjs`:

```js
import { describe, it, expect } from 'test-anywhere';

describe('runs', () => {
  it('counted as passed', () => expect(1).toBe(1));
});
describe.skip('skipped suite', () => {
  it('should be reported as skipped', () => expect(1).toBe(2));
});
it.skip('skipped test', () => expect(1).toBe(2));
```

```
$ node --test describe-skip.test.mjs   # ﹣ skipped suite # SKIP, ﹣ skipped test # SKIP; tests 2, pass 1, skipped 1
$ bun test ./describe-skip.test.mjs    # 1 pass, 2 skip
$ deno test describe-skip.test.mjs     # ok | 1 passed | 0 failed | 1 ignored   <- the suite is gone
```

(test-anywhere 0.9.1, Node 26.11, Bun 1.x, Deno 2.9.6)

## Workaround

Do not use `describe.skip`. Use `it.skip`, which maps to `Deno.test({ ignore: true })` and is reported by all three runtimes, and put the reason in the name:

```js
export function itUnless(...reasons) {
  const reason = reasons.find(Boolean);
  return reason ? (name, fn) => it.skip(`${name} [skipped: ${reason}]`, fn) : it;
}
```

## Suggested fix

1. **Report a skipped suite on Deno.** The simplest option is one ignored entry for the suite:
   ```js
   } else if (runtime === 'deno') {
     return Deno.test({ name, ignore: true, fn: () => {} });
   }
   ```
   Matching Bun more closely means running `fn` with `it`/`test` temporarily bound to their `.skip` variants, so that each child is registered as ignored and the counts agree across runtimes.
2. **Add an optional reason**, for example `it.skip(name, fn, { reason })` or a Bun/Vitest-style `it.skipIf(condition, reason?)` / `describe.skipIf`. Pass it to Node as `{ skip: reason }`; on Bun and Deno, which have no reason field, append it to the name.
