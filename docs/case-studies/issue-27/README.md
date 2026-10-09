# Aggregate cleanup investigation: issue 27

This PR addresses all nine child issues in one branch. The complete requirement
inventory, alternatives and execution checklist are in [plan.md](plan.md).
Each report below records the incident, root cause, chosen implementation,
reproduction tests, coverage and remaining measurement limits.

| Issue | Investigation                                                                | Regression coverage                                                                     |
| ----- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 17    | [Active package-runner caches and aborts](../issue-17/disk-space-saviour.md) | `issue-27-processes`, `issue-27-caches`, `npx-cache`, `issue-27-rule-families`          |
| 18    | [Missing application caches and defaults](../issue-18/disk-space-saviour.md) | `issue-27-caches`, `issue-27-rule-families`, `issue-27-details`, project/browser suites |
| 19    | [Unreleased fixes and name prefixes](../issue-19/disk-space-saviour.md)      | metadata, opam, publish classifier/output, Docker prefix suites                         |
| 21    | [Repeated writable-layer measurement](../issue-21/disk-space-saviour.md)     | `issue-27-storage`, `issue-27-details`, writable-layer suites                           |
| 22    | [Docker side effects and daemon OOM](../issue-22/disk-space-saviour.md)      | fixture Docker guard, `issue-27-boundaries`, `issue-27-storage`, saved-report cleanup   |
| 23    | [Mounted image trees](../issue-23/disk-space-saviour.md)                     | `issue-27-boundaries`, `issue-27-rule-families`, shell/environment suites               |
| 24    | [Path glob exclusions and pruning](../issue-24/disk-space-saviour.md)        | `issue-27-boundaries`, `issue-27-caches`, path matching suites                          |
| 25    | [Partial process inspection](../issue-25/disk-space-saviour.md)              | `issue-27-processes`, `issue-27-details`, liveness/local/shell suites                   |
| 26    | [Image bytes misreported as freeable](../issue-26/disk-space-saviour.md)     | `issue-27-boundaries`, `issue-27-details`, writable-layer/Rust/report suites            |

## Evidence and timeline

The issue JSON and complete paginated comments are under each issue's `data/`.
There were no comments except the confirming name-prefix comment on issue 19.
The original machine logs, audits and kernel journal were quoted in the issue
bodies, without attached downloadable files. Those quotes are archived exactly;
we do not claim to have recovered the original full host traces.

On October 8, the macOS 0.13.1 run deleted an active npx root and exposed missing
cache rules (#17/#18). The first failed main release had Deno's missing
`GITHUB_REPOSITORY` permission. PR 15 had already fixed per-hash npx cleanup,
direct opam cache removal and privileged shell probing. PR 20 subsequently fixed
the Deno metadata gate. On October 9, the Docker profile and OOM (#21/#22) were
followed by image-mount findings (#23), then current-main exclusions, non-root
liveness and image accounting reports (#24–#26). Parent #27 collected them at
17:43:24 UTC. Exact issue creation timestamps are preserved in the raw JSON.

The second main release, run 37948829224 at 15:03:25 UTC on SHA `1068067`, passed
Deno but failed npm publishing. Its log has E404 PUT failures at lines 15351,
15382 and 15412, followed by failure exit at 15433. Run 37847771589 has the old
Deno permission error at lines 9149, 10722 and 12305. Complete logs are archived
compressed in `data/ci-logs/`; readable excerpts retain original line numbers.
PR 28's fresh checks must be judged against its own head SHA, not these older
main runs. Release repairs satisfy the requested loud-failure alternative;
we do not claim that npm has accepted a new version.

The first regression runs failed before implementation. Their logs, passing
suite logs, registry snapshot, related PR patches and primary source excerpts
are archived under `data/` with checksums. To inspect a compressed log, use
`gzip -dc FILE.log.gz`; read large logs in chunks of at most 1500 lines.

## Components and primary-source research

| Component/source                                                                                                                                                                        | Relevant behavior and decision                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Linux OverlayFS](https://www.kernel.org/doc/html/latest/filesystems/overlayfs.html)                                                                                                    | Lower deletion records a whiteout; merged directory sizes cannot establish host space freed. Prefer authoritative upperdir blocks and otherwise report unknown.                                                                             |
| [containerd Snapshotter API](https://github.com/containerd/containerd/blob/main/core/snapshots/snapshotter.go)                                                                          | Usage excludes parent snapshots but is aggregate, and active usage may scale with resource size. Do not allocate aggregate bytes to arbitrary cache paths or assume every `ctr` usage call is constant-time.                                |
| [containerd overlay snapshotter](https://github.com/containerd/containerd/blob/main/plugins/snapshots/overlay/overlay.go)                                                               | Upperdir mount metadata can supply a cheaper authoritative path. Docker graphdriver metadata or visible mountinfo upperdir is preferred; inaccessible data stays unknown.                                                                   |
| [Moby containerd changes implementation](https://github.com/moby/moby/blob/master/daemon/containerd/image_changes.go)                                                                   | Compares mounted image and container trees. A client capture cap cannot bound daemon allocation. Filed [moby/moby#53906](https://github.com/moby/moby/issues/53906) with a bounded proposed reproduction, workarounds and code suggestions. |
| [Linux procfs](https://www.kernel.org/doc/html/latest/filesystems/proc.html)                                                                                                            | UID and command identity can remain readable when process symlinks are denied. Preserve each readable fact and scope uncertainty per PID; retain conservative behavior for unidentified processes.                                          |
| [Node path.matchesGlob](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern) / [minimatch](https://github.com/isaacs/minimatch)                                                | Built-in glob matching requires newer Node than this package's Node 20 floor. Minimatch offers richer syntax, but would add a runtime dependency. Extend existing documented wildcard/segment matching and test ancestor semantics instead. |
| [Playwright browser management](https://playwright.dev/docs/browsers) / [persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) | Downloaded browser executables can be restored; persistent user-data directories hold state. Keep the newest version and all explicitly recognized profiles, remove only old idle revisions.                                                |
| [Electron app paths](https://www.electronjs.org/docs/latest/api/app#appgetpathname)                                                                                                     | Application data and caches can share a profile root. Require markers and target cache leaves, preserving cookies, preferences and local storage.                                                                                           |
| [Bun bunx](https://bun.sh/docs/cli/bunx), [Yarn dlx](https://yarnpkg.com/cli/dlx), [pnpm dlx](https://pnpm.io/cli/dlx)                                                                  | Runners execute installed package entries, often through interpreters. Protect executable/script paths and temporary entries rather than use only runner process names.                                                                     |
| [BleachBit Chromium cleaner](https://github.com/bleachbit/bleachbit/blob/master/cleaners/google_chrome.xml)                                                                             | Existing declarative cache-leaf approach supports this design. No BleachBit code is copied or GPL dependency added.                                                                                                                         |
| [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)                                                                                                                    | Publisher owner/repository/workflow and permitted publish action must match. E404 alone cannot prove which setting is wrong. Retain OIDC; expose captured stderr, fail fast and explain transfer/configuration checks.                      |
| [command-stream result implementation](https://github.com/link-foundation/command-stream/blob/main/src/result.mjs)                                                                      | Rejected commands retain stdout/stderr/result fields. The publishing wrapper must recover them before classifying permanent failures.                                                                                                       |

## Verification and practical limits

Node and Bun each passed 794 tests; Deno passed 691 tests and eight steps with
read-only permissions. The runtimes are run separately
to avoid Deno rewriting its auto-managed dependency symlinks during another
runtime's tests. Focused cases cover every new application rule, plus cleanup
and cancellation. Lint, formatting, duplication, syntax, file limits and required
documentation checks are part of local/PR verification.

The bounded real DinD integration could not start on this host: Docker rejected
the memory-capped container with `cannot enter cgroupv2 ... invalid state`.
It cleaned up its temporary roots and containers. Its log is archived, and CI
runs the same integration on a supported runner. Local Docker uses fuse-overlayfs,
not the incident's Docker 29.6.1 containerd store; no original host OOM was
reproduced. Memory checks and candidate/output budgets reduce risk but cannot
hard-bound a remote daemon's entire changes walk. The upstream report states
this explicitly. Unknown sizes and blocked cleanup preserve safety.

Whole agent scratch copies remain moderate with a 30-day inactivity window and
Git safety; unidentified loose temporary files are not assumed disposable. This
is the conservative implementation of #18's requested inactivity/Git safeguards.
Telegram downloaded media remains moderate because secret-chat data may be
irreplaceable. No cache rule removes a message database or browser profile.
