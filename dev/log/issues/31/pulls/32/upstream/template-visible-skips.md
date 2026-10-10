## Problem

The test matrix reports a different number of tests on each runner, and no runner says why. From the latest `main` release run, [37637246715](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/actions/runs/37637246715):

| Runner | Tests reported | Skipped reported |
| --- | --- | --- |
| Node, ubuntu-24.04 / macos-15 | 569 | 0 |
| Node, windows-2025 | 528 | 0 |
| Bun, windows-2025 | 532 | 0 |
| Deno, all three OSes | 417 | 0 |

There are two causes, and both report a green run while covering less.

1. **Silent omission.** A test that is registered only under a condition does not exist where that condition is false. Examples are an `if (canRunBash) { it(...) }` block, a `describe` callback that does `if (typeof Deno !== 'undefined') return;`, and `cond ? describe : () => {}`. On top of that, test-anywhere's `describe.skip` registers nothing on Deno. The summary just shows fewer tests.
2. **Vacuous passes.** A test body that starts with `if (!canRunCheckerFixtures) { return; }` (or `if (!(await canListen())) return;`) is reported as **passed** without asserting anything. On Deno this applies to every fixture test, because the suite runs with `deno test --allow-read`, and spawning processes or writing temporary trees needs more than that.

So a regression in the fixture-driven tests can never fail the Deno legs. Nobody notices that 152 Node tests are missing and 31 more do nothing.

## Reproduce

The following detector, downstream in [disk-space-saviour PR 32](https://github.com/link-foundation/disk-space-saviour/pull/32), finds every registration-time gate, early `describe` return, swapped registrar and environment early return in a test body. The file is `tests/helpers/conditional-registration.js`.

```sh
git clone --depth 1 -b issue-31-90cff2ab8274 https://github.com/link-foundation/disk-space-saviour /tmp/dss
git clone --depth 1 https://github.com/link-foundation/js-ai-driven-development-pipeline-template /tmp/tpl
cd /tmp/dss && node experiments/find-conditional-tests.mjs /tmp/tpl/tests/*.test.js | tail -1
# 58 conditional registration(s)
# by kind: 13 early-return, 31 silent-pass, 13 wrapped, 1 swapped   (template 4973fc4)
```

## Workaround / suggested fix (applied downstream)

- **A skip helper that every runtime reports.** `it.skip` is the only skip that Node, Bun and Deno all report through test-anywhere. None of them prints a reason, so the reason goes into the name:
  ```js
  export function itUnless(...reasons) {
    const reason = reasons.find(Boolean);
    return reason ? (name, fn) => it.skip(`${name} [skipped: ${reason}]`, fn) : it;
  }
  ```
  The reasons are computed once, for example `sandboxed` (from `Deno.permissions.querySync`: "Deno lacks --allow-run …; run deno test -A"), `noPosixShell` (Windows) and `notLinux`.
- **Replace every gate** with `itUnless(reason)('name', fn)`.
- **Add a guard test** that runs the detector over `tests/*.test.js` and fails on any finding, so new gates cannot come back.
- **Run Deno as `deno test -A --parallel`**: `-A` because `/proc` reads and child processes need "all access", and `--parallel` because file-level concurrency brings the full suite from about 150s to about 35s. Deno's parallel workers share one process working directory, so no test may call `process.chdir`; a guard test pins that too.
- **Under Deno, start fixtures spawned from a shell wrapper with `deno run -A`.** Deno translates the arguments of `spawn(process.execPath, …)` from Node code, but not when a shell script calls `deno file.js`. CommonJS fixtures also need a `.cjs` extension, because Deno treats `.js` as ESM.

Result downstream: Node and Bun report 1102 tests and 0 skipped. `deno test -A --parallel` reports 1099 passed and 3 skipped, each with its reason. `deno test --allow-read` reports 717 passed and 385 skipped, each with its reason, where it used to report 746 passed and nothing else.
