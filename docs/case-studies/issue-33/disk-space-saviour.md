# disk-space-saviour issue 33: Recursive docker scan runs one docker exec per path (2,361 readlink -f in one container) and does not finish in 43 min on Rust task containers

Source: [issue #33](https://github.com/link-foundation/disk-space-saviour/issues/33). Implementation: [PR #41](https://github.com/link-foundation/disk-space-saviour/pull/41).

## Evidence and timeline

- 2026-10-09T22:24:11Z: issue opened; full API metadata/body in [data/dss-issue.json](data/dss-issue.json), readable body in [data/dss-issue-body.md](data/dss-issue-body.md), and supplied output in [data/reporter-excerpts.log](data/reporter-excerpts.log).
- 2026-10-10: all comments read; [data/dss-comments.json](data/dss-comments.json) was empty. No downloadable original trace or screenshots were attached.
- 2026-10-10: traced package 0.15.2 and related safety PRs, wrote regressions, reproduced failures, implemented fixes and ran local checks.

The reporter’s production sizes/timings are supplied observations, not measurements independently repeated on that machine. Parent [case study](../issue-40/disk-space-saviour.md) reconstructs their sequence and the common research requirements. Existing unrelated case-study READMEs inherited from the pipeline template are preserved.

## Root cause

The Rust scanner already had bulk listing, but canonical-path, type/ownership stat and boundary discovery fanned out into one remote command per leaf. At the reporter’s 100–150 ms transport latency, thousands of small commands dominate CPU work. Reducing transport calls is the fix; replacing du with another traversal library alone would not help.

## Every functional requirement and solution plan

| ID   | Requirement                                                                         | Selected implementation/plan                                                             | Alternatives and decision                                                                           | Verification                                                                                                    |
| ---- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 33.1 | Batch canonical paths/readlink rather than one Docker exec per path                 | ShellEnv.realPathMany plus LivenessProbe.resolve; cache within one refresh               | Node-in-container fast path also works, but requires copying executable code and trusting a runtime | Count 1,000 realpaths in at most five bounded calls                                                             |
| 33.2 | Batch stat, sizes and boundary walks, bounded below ARG_MAX                         | 200-path/48-KiB argv batches for metadata, filesystem boundaries, du and head reads      | Dockerode changes the transport but still needs batching; no new dependency                         | 1,000 boundary/usage candidates in at most ten calls                                                            |
| 33.3 | Cargo grouping must list fingerprint/deps trees once, without remote per-file walks | Retain existing bulk Rust listing/head parsing; prewarm all canonical paths and metadata | Optional in-container Node fast path not selected; shared POSIX batching works without Node         | Full fake Rust analyzer and liveness fixture: 1,000 fingerprints, 999 superseded, fewer than 40 transport calls |
| 33.4 | Per-environment budget, elapsed progress and explicit incomplete state              | scanBudget default 2m; periodic stderr progress; scanStatus and blocked partial findings | Unlimited scan was rejected; callers can select a larger finite budget                              | Budget/cancellation fixtures and CLI stderr/JSON tests                                                          |
| 33.5 | Keep docker diff serialization/memory guards and normal container behavior          | Prefer authoritative upperdir, preserve bounded shared diff fallback                     | No daemon-wide parallel diff experiment                                                             | Existing Docker/boundary suites plus issue 35 fixtures                                                          |

Each row also inherits the common evidence, online research, upstream triage, tracing and whole-codebase requirements in [the parent matrix](../issue-40/disk-space-saviour.md#common-requirements).

## Existing components and online facts

[Dockerode](https://github.com/apocas/dockerode) supplies Docker API exec/stream primitives but does not remove per-path round trips. Existing POSIX coreutils and bounded argv transport work in containers without Node. A copied Node scan is a reasonable optional optimization, but adds packaging, runtime and report-merging concerns. No runtime dependency is added.

## Reproduction, evidence and limits

Run the corresponding `tests/issue-33*.test.js` with Node’s test runner (30-second test budget), or use the repository’s full Node/Bun/Deno commands. Regression logs before and after changes are retained in this directory’s data folder. Reproductions use temporary fixtures or fake executors; no large production Rust tree or unbounded memory experiment is required.

See [validation and limitations](../issue-40/disk-space-saviour.md#validation-and-limitations) for runtime results, infrastructure constraints and remaining conservative cases. No original safety override is weakened. Workarounds and alternative designs are recorded in the matrix above.
