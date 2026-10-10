# disk-space-saviour issue 37: Host clean is stopped by the task-health watcher when an agent process in a container exits (watches all PID namespaces)

Source: [issue #37](https://github.com/link-foundation/disk-space-saviour/issues/37). Implementation: [PR #41](https://github.com/link-foundation/disk-space-saviour/pull/41).

## Evidence and timeline

- 2026-10-09T22:55:27Z: issue opened; full API metadata/body in [data/dss-issue.json](data/dss-issue.json), readable body in [data/dss-issue-body.md](data/dss-issue-body.md), and supplied output in [data/reporter-excerpts.log](data/reporter-excerpts.log).
- 2026-10-10: all comments read; [data/dss-comments.json](data/dss-comments.json) was empty. No downloadable original trace or screenshots were attached.
- 2026-10-10: traced package 0.15.2 and related safety PRs, wrote regressions, reproduced failures, implemented fixes and ran local checks.

The reporter’s production sizes/timings are supplied observations, not measurements independently repeated on that machine. Parent [case study](../issue-40/disk-space-saviour.md) reconstructs their sequence and the common research requirements. Existing unrelated case-study READMEs inherited from the pipeline template are preserved.

## Root cause

The host PID namespace sees container tasks, but visibility does not imply that the host filesystem cleanup can affect them. The watcher treated every visible matching name as a host task. Shared filtering now uses mount namespace identity while retaining start-time/PID-reuse guards.

## Every functional requirement and solution plan

| ID   | Requirement                                                           | Selected implementation/plan                                                                                             | Alternatives and decision                                                                 | Verification                                                    |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 37.1 | Host cleanup must not stop because an unrelated container agent exits | Compare process mount namespace with dss own namespace for host watcher                                                  | Path/open-file intersection is an alternative but needs more unreadable-process inference | Foreign mount namespace exit leaves host cleanup running        |
| 37.2 | Still stop on host-namespace agent/build-tool exit and PID reuse      | Keep identity/start-time health checks; unknown namespace remains conservative; containers watch their own visible tasks | Optional informational logging of foreign exits is unnecessary for correctness            | Same-namespace cargo exit stops cleanup; unknown namespace test |
| 37.3 | Apply same watcher scope to host and nested cleanup paths             | Filter watch list in shared health module, not CLI-specific path                                                         | PID namespace comparison alone is less precise for filesystem isolation                   | Existing cleanup and Docker health suites                       |

Each row also inherits the common evidence, online research, upstream triage, tracing and whole-codebase requirements in [the parent matrix](../issue-40/disk-space-saviour.md#common-requirements).

## Existing components and online facts

[Linux namespace documentation](https://www.man7.org/linux/man-pages/man7/namespaces.7.html) describes namespace links under /proc/pid/ns and comparing their identity. Mount namespace membership aligns with filesystem scope more directly than process visibility. Existing health start-time checks remain the identity component; no third-party process library is needed.

## Reproduction, evidence and limits

Run the corresponding `tests/issue-37*.test.js` with Node’s test runner (30-second test budget), or use the repository’s full Node/Bun/Deno commands. Regression logs before and after changes are retained in this directory’s data folder. Reproductions use temporary fixtures or fake executors; no large production Rust tree or unbounded memory experiment is required.

See [validation and limitations](../issue-40/disk-space-saviour.md#validation-and-limitations) for runtime results, infrastructure constraints and remaining conservative cases. No original safety override is weakened. Workarounds and alternative designs are recorded in the matrix above.
