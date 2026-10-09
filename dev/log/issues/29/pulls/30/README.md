# Issue 29 / PR 30: false positives, false negatives, warnings and errors in CI/CD

Issue: https://github.com/link-foundation/disk-space-saviour/issues/29
Pull request: https://github.com/link-foundation/disk-space-saviour/pull/30

## Collected data

| Path                                 | Contents                                                                                                                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci-logs/run-<id>.log`               | Full logs of every `main` run listed in the issue, plus the earlier failed `main` runs that share their causes                                                                                                                                                                          |
| `ci-logs/run-<id>.json`              | Run metadata: event, commit, conclusion and per-job results                                                                                                                                                                                                                             |
| `ci-logs/run-37984955308-failed.log` | The failed Deno jobs on this branch (commit `bb08ca6`) that exposed the stale `deno.lock`                                                                                                                                                                                               |
| `ci-logs/annotations.tsv`            | Every `##[error]` / `##[warning]` annotation in the collected runs                                                                                                                                                                                                                      |
| `ci-logs/warn-summary.txt`           | Warning and error lines grouped by job and step, with counts, used to triage every warning                                                                                                                                                                                              |
| `upstream/template-*.txt`            | The same defects in the template's own `main` runs ([links](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/actions/runs/37637246815), [release](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/actions/runs/37637246715)) |

## Timeline

| When (UTC)       | Event                                                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-02 12:10 | `disk-space-saviour` first published to npm from `konard/disk-space-saviour`; the npm trusted publisher is bound to that repository.                                                                                                                        |
| 2026-10-06 12:14 | `0.13.1` published. It is still the latest version on npm; its `repository.url` is `git+https://github.com/konard/disk-space-saviour.git`.                                                                                                                  |
| 2026-10-07 13:17 | The repository moves to `link-foundation`. Workflows run [37627288421](https://github.com/link-foundation/disk-space-saviour/actions/runs/37627288421): the Pipeline Status checkout of the old `konard/` URL returns `403`, and the run is cancelled.      |
| 2026-10-08 07:08 | Release run [37741640150](https://github.com/link-foundation/disk-space-saviour/actions/runs/37741640150): `npm error 404 Not Found - PUT https://registry.npmjs.org/disk-space-saviour` for `0.14.0`.                                                      |
| 2026-10-08 21:34 | Run [37847771589](https://github.com/link-foundation/disk-space-saviour/actions/runs/37847771589): all three Deno legs fail with `NotCapable: Requires env access to "GITHUB_REPOSITORY"`.                                                                  |
| 2026-10-09 11:23 | Commit `352beec` stops reading `GITHUB_REPOSITORY` under Deno; the Deno legs pass again.                                                                                                                                                                    |
| 2026-10-09 15:03 | Release run [37948829224](https://github.com/link-foundation/disk-space-saviour/actions/runs/37948829224): the same `E404 - PUT` for `0.14.1`.                                                                                                              |
| 2026-10-09 19:22 | Release run [37979761428](https://github.com/link-foundation/disk-space-saviour/actions/runs/37979761428), named in the issue: the preflight prints `PASS: npm OIDC trusted publishing is available`, then the publish of `0.15.0` fails with `E404 - PUT`. |
| 2026-10-09 19:39 | Issue 29 opened; PR 30 opened one minute later.                                                                                                                                                                                                             |
| 2026-10-09 20:10 | This branch at `bb08ca6`: the Deno legs fail with `Could not find npm package 'jscpd' matching '^5.4.1'` (Deno's 24-hour minimum dependency age; jscpd 5.4.1 was published at 11:42). Fixed in `5957fb1`.                                                   |

## Requirements

| #   | Requirement (from the issue and the solver task)                                                                                 | Where it is addressed                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Fix the failing "Checks and release" run 37979761428                                                                             | E1 below. The code side is fixed; the npm trusted publisher needs a maintainer (see "Manual step")                                                                                                                 |
| R2  | Fix the cancelled "Workflows" run 37627288421                                                                                    | E3 below                                                                                                                                                                                                           |
| R3  | Find every false positive, false negative, warning and error, not only the two red runs                                          | F1–F9 and W1–W8 below                                                                                                                                                                                              |
| R4  | Compare the whole workflow and script tree with the JS template and adopt its practices                                          | "Template comparison" below                                                                                                                                                                                        |
| R5  | Report defects that the template shares upstream                                                                                 | [template#219](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/issues/219), [template#220](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/issues/220) |
| R6  | Follow hive-mind's [CI-CD-BEST-PRACTICES.md](https://github.com/link-assistant/hive-mind/blob/main/docs/CI-CD-BEST-PRACTICES.md) | "Best-practice checklist" below                                                                                                                                                                                    |
| R7  | Everything in one pull request                                                                                                   | PR 30                                                                                                                                                                                                              |
| R8  | Collect logs and data here and write a deep analysis                                                                             | This directory                                                                                                                                                                                                     |
| R9  | Add debug output / verbose mode, off by default, where data was insufficient                                                     | `RECHECK_VERBOSE` (links), preflight per-target diagnostics, audit notice, per-attempt registry log lines                                                                                                          |
| R10 | Apply each fix everywhere the problem occurs                                                                                     | Each fix below lists every place it applies; guard tests pin them                                                                                                                                                  |

## Root causes and solutions

### Errors

**E1. npm publish returns `404 Not Found - PUT` (runs 37741640150, 37948829224, 37979761428).**
An npm trusted publisher authorises one exact `owner/repo` + workflow file. It was configured for `konard/disk-space-saviour`. After the transfer, the OIDC token's `repository` claim is `link-foundation/disk-space-saviour`. npm then refuses the token exchange, and `npm publish` reports that refusal as a 404 on `PUT`, the documented symptom of a publisher mismatch. Evidence: every version after `0.13.1` (the last pre-transfer publish) failed. `npm view disk-space-saviour repository.url` still names `konard/`.
_Manual step (cannot be done from CI):_ on npmjs.com → `disk-space-saviour` → Settings → Trusted publishing, change the repository to `link-foundation/disk-space-saviour` and keep workflow `release.yml`. Then run the release workflow again, or push to `main`. The missing GitHub release is recovered automatically for any version that is already on npm (`75f0d64`).

**E2. Deno legs fail with `NotCapable: Requires env access to "GITHUB_REPOSITORY"` (run 37847771589).**
The suite runs under `deno test --allow-read`, and a metadata test read `process.env`. This was fixed on `main` by `352beec`. This PR keeps the rule: tests that read the environment guard the read.

**E3. Workflows run cancelled (37627288421).**
This was a one-off during the repository transfer. The Pipeline Status job's checkout still targeted `konard/disk-space-saviour`, got a 403, and the run was cancelled. No code defect remains: later runs check out `link-foundation/…`. The Pipeline Status gate correctly turned the cancellation into a failure and did not report success.

**E4. Deno legs fail on this branch with `Could not find npm package 'jscpd' matching '^5.4.1'` (run 37984955308).**
`deno.lock` no longer matched `package.json` (it already recorded `test-anywhere@~0.8.48` against `^0.8.48` on `main`). That made Deno re-resolve every range on the runner. Deno 2.9 enforces a 24-hour minimum dependency age during resolution, so a floor published that day is rejected, while npm installs the same range without complaint.
_Fix (`5957fb1`):_ regenerate `deno.lock` in a scratch directory; use the `^5.4.0` floor, which npm already satisfies with 5.4.1. Also add `tests/deno-lock.test.js`, which fails on every runtime when the lock drifts.

### False positives (a check passed or stayed silent when it should not have)

| #   | Symptom                                                                                                      | Root cause                                                                                                                       | Fix                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Preflight `PASS: npm OIDC trusted publishing is available` immediately before the E404                       | The probe only checked that `ACTIONS_ID_TOKEN_REQUEST_URL` was set, which proves GitHub can mint a token, not that npm trusts it | `3c2f1cb`: call npm's package OIDC exchange (`/-/npm/v1/oidc/token/exchange/package/<name>`), the same endpoint `npm publish` uses, and discard the token (template port)   |
| F2  | A release could start after a failed or cancelled check (the Docker-in-Docker job was not among its `needs`) | Release `needs` listed only some jobs, and the conditions did not reject `cancelled`                                             | `2f2306d`: release and instant-release need every check, including `dind`, and run only when none failed or was cancelled                                                   |
| F3  | Registry verification could read a stale CDN answer and report the wrong publish state                       | Plain GETs of `registry.npmjs.org/<pkg>/<version>` are cached at the edge                                                        | `2f2306d`: unique cache-busting query, `cache: 'no-store'`, `cache-control: no-cache`; a 5xx or network error is "unknown", never "not published"                           |
| F4  | Version and changeset guards compared against a moving `origin/main` and could pass or fail the wrong diff   | No verified merge base; the release bot's PR was detected by branch name                                                         | `2f4744b`, `1fae24e`: compare `GITHUB_BASE_SHA`..`GITHUB_HEAD_SHA` through a verified merge base; identify the release PR by actor; exact changeset moves are not new files |
| F5  | `audit-fixable` printed a clean summary while the example app had 8 moderate advisories                      | Lower-severity counts were dropped                                                                                               | `fbb6a46`: print a `::notice::` with the non-blocking counts                                                                                                                |
| F6  | Windows legs never exercised the use-m interop (always "Skipping")                                           | The test skipped unconditionally on Windows; use-m 8.16.4 already converts drive-letter paths to `file://` URLs                  | `d18e299`: run on Windows and skip only on the actual `ERR_UNSUPPORTED_ESM_URL_SCHEME`                                                                                      |
| F7  | A missing GitHub release stayed missing when the version was already on npm                                  | `check-release-needed` looked only at npm                                                                                        | `75f0d64`: also check the GitHub release and recover it                                                                                                                     |
| F8  | Runner images and tools could change underneath a green branch                                               | `macos-latest`, `windows-latest`, unpinned secretlint/zizmor                                                                     | `c57ca1b`: `macos-15`, `windows-2025`, `secretlint@13.0.7`, zizmor 1.30.1 via a pinned action                                                                               |
| F9  | Changeset versioning was only exercised on `main`, inside the release job                                    | No pull-request dry run                                                                                                          | `e0ec812`: `npm run changeset:version` on pull requests, with the tree restored                                                                                             |

### Warnings and misleading output

| #   | Line in the logs                                                                                          | Verdict and fix                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | `[WARN] ./**/*.html: No files found for this input source` (every link-check run)                         | The only HTML file is the excluded Vite source. `bb08ca6` makes lychee walk `.` with `--extensions md,html --hidden`. Its inputs match `git ls-files` exactly and now include `.changeset/*.md`. Reported upstream: template#219                |
| W2  | `Skipping: https://unpkg.com/use-m/use.js is unreachable` (Deno legs)                                     | Wrong reason: Deno denied the net permission. `9bd9a14` queries the permission and logs `Deno net permission for unpkg.com is prompt`. Reported upstream: template#220                                                                          |
| W3  | npm audit: 22 findings at the root                                                                        | `84b2f1c` upgrades Changesets 3, jscpd 5 and lint-staged 16.4; root `npm audit` reports 0. `braces@3.0.3` (GHSA-vfj7-8cjw-p6xm) has no fixed release, so the old "not yet fixable" output was correct and disappeared with the upgrade          |
| W4  | Example app: 8 moderate advisories (`sprintf-js` via `electron-builder` → `global-agent`)                 | No fixed version exists. `npm audit fix` proposes downgrading electron-builder from 26.15.3 to 26.5.0, which is not a fix. Now visible as a notice (F5)                                                                                         |
| W5  | `Error response from daemon: Get "https://registry-1.docker.io/v2/": timeout`                             | Expected: echoed by the stubbed `docker` in `tests/setup-buildx-resilient.test.js` to test the retry path. Not a real daemon call                                                                                                               |
| W6  | `Skipping: this runtime is not allowed to listen on 127.0.0.1` (Deno)                                     | Expected: Deno runs with `--allow-read` only; the message already names the real reason                                                                                                                                                         |
| W7  | `LF will be replaced by CRLF` (Windows)                                                                   | Expected: Git's `core.autocrlf` on Windows runners while tests write fixture repositories; harmless                                                                                                                                             |
| W8  | Deno prints "The following packages are deprecated: `npm:eslint@9.39.4`"                                  | Informational: ESLint 9 has reached end of support. Moving to ESLint 10 is a separate migration of the flat config and plugins, outside this issue's scope                                                                                      |
| W9  | `npm warn deprecated glob@7.2.3`, `inflight@1.0.6`, `rimraf@2.6.3`, `boolean@3.2.0` (example app install) | Informational: transitive dependencies of `@electron/asar`, `@capacitor/cli` → `temp`, and `global-agent` → `roarr` (electron-builder). The app cannot pin them without overriding upstream packages; they leave with upstream releases         |
| W10 | `🦋 error npm notice npm tokens that bypass 2FA are being restricted…` (Publish to npm)                   | Misleading prefix: `changeset publish` relays all of npm's stderr with an `error` label, including notices. The publish uses OIDC trusted publishing, not a token, so the notice does not apply. The real error is the `E404` that follows (E1) |

## Template comparison

The template ([link-foundation/js-ai-driven-development-pipeline-template](https://github.com/link-foundation/js-ai-driven-development-pipeline-template)) does not share history with this repository. Every workflow and every script under `scripts/` was therefore diffed file by file against the template's `main`. Each template commit since this repository was created was ported with its tests. Template-specific paths were excluded from the patches: case studies, issue experiments and `.gitkeep`.

Ported commits: OIDC package exchange preflight (`3c2f1cb`), full release gating and registry cache-busting (`2f2306d`), release-note / commit-message / budget-diagnostic fixes (`db574ac`), GitHub release recovery (`75f0d64`), runner and tool pins with scoped CodeQL (`c57ca1b`), changeset-move guards and Windows commit messages (`1fae24e`), and the transient link re-check (`098816b`).

Repository-specific differences kept on purpose: the Docker-in-Docker integration job, the example-app workflow, and the CLI's own tests.

Defects the template shares, now reported upstream:

- [template#219](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/issues/219): the lychee HTML glob warning (W1)
- [template#220](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/issues/220): the Deno use-m skip reason (W2), plus the missing `deno.lock` drift guard (E4)

The template's own `main` release currently fails in Release Preflight with `npm OIDC package exchange rejected (404)`. That is the probe working as designed for a package without a trusted publisher, so it was not reported.

## Best-practice checklist (hive-mind CI-CD-BEST-PRACTICES)

- Fail closed: a status gate turns cancelled or failed jobs into a red run (Pipeline Status), and releases need every check (F2).
- `!cancelled()` instead of `always()` in dependent jobs (docs/BEST-PRACTICES.md §14).
- Timeouts on every job and test step, with budget warnings (docs/CI-TIMEOUT-BUDGETS.md).
- Pinned runners, actions by SHA, and pinned tool versions (F8); zizmor and actionlint on every workflow change.
- Credentials proven before release (F1); trusted publishing only, with no npm token anywhere (`tests/workflow-reliability.test.js`).
- Registry checks that tell "not published" apart from "could not ask" (F3).
- Retries only for transient failures (links re-check, buildx setup), with verbose logs available on demand.
- Every lockfile in step (E4); dependency audits that block only on fixable high-severity advisories, while still reporting the rest (F5).

## Existing tools considered

- **lychee / lychee-action** (link checking): kept. The fix uses its directory input with `--extensions`; `--dump-inputs` was used to prove coverage parity.
- **npm trusted publishing (OIDC)**: kept. The preflight calls the same exchange endpoint as `npm publish`, so the result cannot drift from what `npm publish` actually does.
- **zizmor, actionlint, CodeQL, secretlint**: kept and pinned. zizmor 1.30.1 reports no findings in either the regular or the pedantic pass.
- **Deno minimum dependency age** (`minimumDependencyAge` in `deno.json`): disabling it would hide supply-chain risk, so the lock is kept in sync instead.
- **`npm audit fix`**: rejected for the example app, because its only proposal is a downgrade.

## Verification

- Every fix has a test that fails without it. Examples: `tests/deno-lock.test.js` fails on the old lock; the lychee input test fails on the old `links.yml`; `tests/release-preflight.test.js` fails on the old environment-variable probe.
- Local: `npm run lint`, `npm run format:check`, `npm run check:duplication`, `npm test`, `bun test --timeout 30000`, `deno test --allow-read`.
- CI on this branch: see the PR checks. The link-check run reports 0 errors and no `No files found` warning. In [run 37985930630](https://github.com/link-foundation/disk-space-saviour/actions/runs/37985930630), the Windows legs load use-m (`Loaded command-stream on v24.21.0` under Node, `v26.3.0` under Bun) where they used to skip (F6).

## Remaining limits

- E1 needs the manual npm setting above; until then, every release run fails in Release Preflight with an explicit message, not at publish time.
- The Deno legs still skip the use-m interop, because the suite runs without `--allow-net`. The skip now names the denied permission (W2). Granting network access to the whole Deno suite would widen what every test may do, so it was not changed.
