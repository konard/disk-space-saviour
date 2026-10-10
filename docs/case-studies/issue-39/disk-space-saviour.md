# disk-space-saviour issue 39: dss scan loses its whole report when the audit log cannot be written (EACCES on a root-owned state dir)

Source: [issue #39](https://github.com/link-foundation/disk-space-saviour/issues/39). Implementation: [PR #41](https://github.com/link-foundation/disk-space-saviour/pull/41).

## Evidence and timeline

- 2026-10-10T10:15:03Z: issue opened; full API metadata/body in [data/dss-issue.json](data/dss-issue.json), readable body in [data/dss-issue-body.md](data/dss-issue-body.md), and supplied output in [data/reporter-excerpts.log](data/reporter-excerpts.log).
- 2026-10-10: all comments read; [data/dss-comments.json](data/dss-comments.json) was empty. No downloadable original trace or screenshots were attached.
- 2026-10-10: traced package 0.15.2 and related safety PRs, wrote regressions, reproduced failures, implemented fixes and ran local checks.

The reporter’s production sizes/timings are supplied observations, not measurements independently repeated on that machine. Parent [case study](../issue-40/disk-space-saviour.md) reconstructs their sequence and the common research requirements. Existing unrelated case-study READMEs inherited from the pipeline template are preserved.

## Root cause

Cli.scan awaited audit persistence before producing output and let the exception escape. Root runs with a foreign HOME could create state owned by root, causing subsequent user scans to fail after doing all the expensive read-only work.

## Every functional requirement and solution plan

| ID   | Requirement                                                                          | Selected implementation/plan                                                                                        | Alternatives and decision                                                                    | Verification                                                                          |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 39.1 | Audit write failure must not lose read-only scan report                              | Catch scan-only writeAudit failure, stderr warning and JSON audit error/file diagnostic, then print report          | Moving JSON before persistence can lose structured warning; catch preserves report semantics | CLI regression uses invalid audit ancestor; verifies parseable report despite ENOTDIR |
| 39.2 | Avoid root-owned state under another user’s HOME                                     | Default root audit destination uses private mkdtemp directory when HOME owner differs; 0700 and process-local reuse | Chown arbitrary state trees is intrusive; caller can choose --audit-dir                      | Ownership guard review and normal audit suite                                         |
| 39.3 | Keep explicit writable audit-dir workaround and conservative cleanup audit semantics | Explicit directory remains authoritative; destructive command audit errors are not silently ignored                 | Only scan treats audit as an optional side record                                            | Cleanup write still rejects; configured-audit tests                                   |

Each row also inherits the common evidence, online research, upstream triage, tracing and whole-codebase requirements in [the parent matrix](../issue-40/disk-space-saviour.md#common-requirements).

## Existing components and online facts

[Node filesystem API](https://nodejs.org/api/fs.html) provides mkdtemp and write errors; [Node os.tmpdir](https://nodejs.org/api/os.html#ostmpdir) provides the platform temporary root. mkdtemp plus mode 0700 avoids predictable shared-directory collisions. Chowning an existing user state tree was rejected; explicit audit-dir remains the operational workaround.

## Reproduction, evidence and limits

Run the corresponding `tests/issue-39*.test.js` with Node’s test runner (30-second test budget), or use the repository’s full Node/Bun/Deno commands. Regression logs before and after changes are retained in this directory’s data folder. Reproductions use temporary fixtures or fake executors; no large production Rust tree or unbounded memory experiment is required.

See [validation and limitations](../issue-40/disk-space-saviour.md#validation-and-limitations) for runtime results, infrastructure constraints and remaining conservative cases. No original safety override is weakened. Workarounds and alternative designs are recorded in the matrix above.
