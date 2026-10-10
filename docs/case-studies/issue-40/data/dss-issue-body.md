<!-- hive-mind-solve-repository-mode -->

## Objective

Address every open issue listed below in [link-foundation/disk-space-saviour](https://github.com/link-foundation/disk-space-saviour) with a **single pull request**.

This issue was generated automatically by `/solve https://github.com/link-foundation/disk-space-saviour` (repository mode). Native sub-issues and the complete closing-reference block below jointly define the required scope.

## Scope

- Open issues found in the repository: 7
- Issues requested in this single pull request: 7
- Issues selected for native sub-issue attachment: 7
- GitHub sub-issue limit per parent issue: 100

## Issues to address

- [ ] #33 Recursive docker scan runs one docker exec per path (2,361 readlink -f in one container) and does not finish in 43 min on Rust task containers — opened 2026-10-09
- [ ] #34 dss scan ignores SIGTERM/SIGINT: Ctrl-C and timeout cannot stop it, only SIGKILL, and no partial report is written — opened 2026-10-09
- [ ] #35 No working way to clean running containers on the containerd image store: in-container clean skips everything (size unknown), host mode needs GraphDriver.UpperDir which is null — opened 2026-10-09
- [ ] #36 Missing cache rules on the box toolchain image: perlbrew build/dists, sdkman tmp/archives, nvm .cache, cargo-semver-checks cache, Ruby gem caches; go-mod-cache ignores GOMODCACHE — opened 2026-10-09
- [ ] #37 Host clean is stopped by the task-health watcher when an agent process in a container exits (watches all PID namespaces) — opened 2026-10-09
- [ ] #38 Liveness probe still blocks every item in containers: unreadable process of another uid (no CAP_SYS_PTRACE / root daemons in DinD); blocked bytes reported as 0 — opened 2026-10-10
- [ ] #39 dss scan loses its whole report when the audit log cannot be written (EACCES on a root-owned state dir) — opened 2026-10-10

## Requirements

1. Read every issue listed above (including its comments) and fully implement what it asks for.
2. Do all of the work in this single pull request. Do not defer any listed issue to a follow-up pull request.
3. The pull request description **must** close this issue and **every** issue listed above, so that merging the pull request closes all of them at once.
4. GitHub requires the full closing syntax for each issue: one keyword per issue. `Fixes #1, #2` only closes `#1`. Use the block below verbatim (plus `Fixes #<this issue>` for this issue).
5. If an issue turns out to be already resolved or not reproducible, say so explicitly in the pull request description — but still keep its closing reference so it is closed on merge.

## Required closing references in the pull request description

```
Fixes #33
Fixes #34
Fixes #35
Fixes #36
Fixes #37
Fixes #38
Fixes #39
```
