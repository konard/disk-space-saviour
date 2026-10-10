# disk-space-saviour issue 34: dss scan ignores SIGTERM/SIGINT: Ctrl-C and timeout cannot stop it, only SIGKILL, and no partial report is written

Source: [issue #34](https://github.com/link-foundation/disk-space-saviour/issues/34). Implementation: [PR #41](https://github.com/link-foundation/disk-space-saviour/pull/41).

## Evidence and timeline

- 2026-10-09T22:24:13Z: issue opened; full API metadata/body in [data/dss-issue.json](data/dss-issue.json), readable body in [data/dss-issue-body.md](data/dss-issue-body.md), and supplied output in [data/reporter-excerpts.log](data/reporter-excerpts.log).
- 2026-10-10: all comments read; [data/dss-comments.json](data/dss-comments.json) was empty. No downloadable original trace or screenshots were attached.
- 2026-10-10: traced package 0.15.2 and related safety PRs, wrote regressions, reproduced failures, implemented fixes and ran local checks.

The reporter’s production sizes/timings are supplied observations, not measurements independently repeated on that machine. Parent [case study](../issue-40/disk-space-saviour.md) reconstructs their sequence and the common research requirements. Existing unrelated case-study READMEs inherited from the pipeline template are preserved.

## Root cause

The CLI intercepted termination signals without propagating the AbortSignal into scan adapters. A flag used only during deletion cannot interrupt context construction, an in-flight remote command, or Docker streams. Results were assembled only after a scanner returned, so interruption lost already-completed findings.

## Every functional requirement and solution plan

| ID   | Requirement                                                                                | Selected implementation/plan                                                                                 | Alternatives and decision                                                                                             | Verification                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 34.1 | Check signals between environments/scanners/items, including clean and emergency pre-scans | Scope every environment executor, process probe and Docker stream to signal/deadline; local walk/proc checks | Native child_process signal support alone does not cover all nested adapters                                          | Captured and streaming child cancellation tests                                                                   |
| 34.2 | Terminate in-flight docker exec/find and transport descendants                             | Kill detached Unix subprocess group on abort; direct child on Windows                                        | Execa offers cancellation/escalation, but replacing the executor adds a dependency and does not solve partial results | Finite slow child stops before its natural exit                                                                   |
| 34.3 | Preserve completed findings, mark aborted/incomplete, print JSON/text and exit 130/143     | Emit completed items incrementally; block incomplete scan output; CLI retains signal-specific status         | Printing only after successful scan loses the entire run                                                              | Actual scan, clean and emergency CLI SIGINT/SIGTERM tests verify JSON, retained findings, status and elapsed time |
| 34.4 | Second signal or five-second grace period forces immediate exit                            | Persistent handlers record first signal; second exits; unref five-second fallback                            | Repeated flag-only handlers were rejected                                                                             | bin/dss.js review plus bounded CLI fixture                                                                        |
| 34.5 | Slow fake-executor regression with a few-second exit bound                                 | Preloaded finite synthetic scanner and library budget fixture                                                | Production host stress is unnecessary and unsafe                                                                      | tests/issue-34-cancellation.test.js; experiments/issue-40/cancellation.mjs                                        |

Each row also inherits the common evidence, online research, upstream triage, tracing and whole-codebase requirements in [the parent matrix](../issue-40/disk-space-saviour.md#common-requirements).

## Existing components and online facts

[Node child-process documentation](https://nodejs.org/api/child_process.html) documents signal-driven cancellation and distinguishes signal delivery from process termination. [Execa termination](https://github.com/sindresorhus/execa/blob/main/docs/termination.md) offers cancellation and escalation; dss retains its existing executor because it must also propagate scope through nested Docker and retain reports.

## Reproduction, evidence and limits

Run the corresponding `tests/issue-34*.test.js` with Node’s test runner (30-second test budget), or use the repository’s full Node/Bun/Deno commands. Regression logs before and after changes are retained in this directory’s data folder. Reproductions use temporary fixtures or fake executors; no large production Rust tree or unbounded memory experiment is required.

See [validation and limitations](../issue-40/disk-space-saviour.md#validation-and-limitations) for runtime results, infrastructure constraints and remaining conservative cases. No original safety override is weakened. Workarounds and alternative designs are recorded in the matrix above.
