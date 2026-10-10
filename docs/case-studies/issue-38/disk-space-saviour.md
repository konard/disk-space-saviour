# disk-space-saviour issue 38: Liveness probe still blocks every item in containers: unreadable process of another uid (no CAP_SYS_PTRACE / root daemons in DinD); blocked bytes reported as 0

Source: [issue #38](https://github.com/link-foundation/disk-space-saviour/issues/38). Implementation: [PR #41](https://github.com/link-foundation/disk-space-saviour/pull/41).

## Evidence and timeline

- 2026-10-10T10:15:02Z: issue opened; full API metadata/body in [data/dss-issue.json](data/dss-issue.json), readable body in [data/dss-issue-body.md](data/dss-issue-body.md), and supplied output in [data/reporter-excerpts.log](data/reporter-excerpts.log).
- 2026-10-10: all comments read; [data/dss-comments.json](data/dss-comments.json) was empty. No downloadable original trace or screenshots were attached.
- 2026-10-10: traced package 0.15.2 and related safety PRs, wrote regressions, reproduced failures, implemented fixes and ran local checks.

The reporter’s production sizes/timings are supplied observations, not measurements independently repeated on that machine. Parent [case study](../issue-40/disk-space-saviour.md) reconstructs their sequence and the common research requirements. Existing unrelated case-study READMEs inherited from the pipeline template are preserved.

## Root cause

Root is not sufficient for all /proc link reads: ptrace checks consider credentials/capabilities and dumpability. Blanket unknown-process blockers were safe but unnecessarily broad, and failed retries could discard readable evidence. Blocked totals counted zero writable bytes when merged size was still known, hiding the difference between absent and unmeasured data.

## Every functional requirement and solution plan

| ID   | Requirement                                                                            | Selected implementation/plan                                                                                                                                     | Alternatives and decision                                                                                      | Verification                                                                                  |
| ---- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 38.1 | Inspect unreadable same-UID processes when root lacks CAP_SYS_PTRACE                   | After normal/root probe, group denied processes by UID/GID and retry selected proc links via setpriv --clear-groups                                              | Read-only privileged Docker and sudo -n probes are retained; non-dumpable processes may still deny access      | Owner retry fixture resolves uncertainty and preserves open files                             |
| 38.2 | Retain all readable evidence and unresolved identities after failed/incomplete retries | Union readable cwd/fd/exe paths; accept coverage only when complete or structured partial; do not clear earlier evidence on failed retries                       | Assuming a successful shell means complete /proc coverage would be unsafe                                      | Denied/partial probe fixtures                                                                 |
| 38.3 | Scope unreadable-process uncertainty to plausible paths                                | Known root dockerd/containerd: explicit argument/storage roots; other identities: permissions and searchable ancestors; group/ACL uncertainty stays conservative | Never ignore unknown root processes or explicit open files; no writable-only shortcut that misses active reads | Daemon storage blocks while unrelated cache is eligible; private-owner and unknown-root tests |
| 38.4 | One useful environment inspection warning with UID/GID/capability guidance             | Store probeHint on each environment and render once; item blockers still explain decisions                                                                       | Removing item blockers would hide the reason from JSON consumers                                               | Report hint and retry coverage tests                                                          |
| 38.5 | Show blocked bytes rather than imply blocked data is absent                            | Deduplicate nested paths in totals.blocked.bytes; include totalBytes for unknown writable attribution and unknownBytes separately                                | Visible merged bytes are not claimed as reclaimable bytes                                                      | Nested unknown-size parent/child regression and report fixtures                               |
| 38.6 | Cover nonprivileged root, privileged nonroot, local and nested Docker probes           | Shared parser/retry helper; LocalEnv and ShellEnv adapters both use it                                                                                           | Do not change inspection privileges of deletion commands                                                       | tests/issue-38-permissions.test.js and existing process/cleanup suites                        |

Each row also inherits the common evidence, online research, upstream triage, tracing and whole-codebase requirements in [the parent matrix](../issue-40/disk-space-saviour.md#common-requirements).

## Existing components and online facts

[proc_pid_cwd](https://www.man7.org/linux/man-pages/man5/proc_pid_cwd.5.html) states that link access is subject to a ptrace filesystem-credentials check. [setpriv](https://man7.org/linux/man-pages/man1/setpriv.1.html) supplies an existing credential-changing helper. Retrying as owner is evidence-driven, not a guarantee for non-dumpable processes. sudo and privileged Docker are alternate probes; all remaining uncertainty stays explicit.

## Reproduction, evidence and limits

Run the corresponding `tests/issue-38*.test.js` with Node’s test runner (30-second test budget), or use the repository’s full Node/Bun/Deno commands. Regression logs before and after changes are retained in this directory’s data folder. Reproductions use temporary fixtures or fake executors; no large production Rust tree or unbounded memory experiment is required.

See [validation and limitations](../issue-40/disk-space-saviour.md#validation-and-limitations) for runtime results, infrastructure constraints and remaining conservative cases. No original safety override is weakened. Workarounds and alternative designs are recorded in the matrix above.
