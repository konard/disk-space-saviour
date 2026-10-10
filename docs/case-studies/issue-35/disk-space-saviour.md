# disk-space-saviour issue 35: No working way to clean running containers on the containerd image store: in-container clean skips everything (size unknown), host mode needs GraphDriver.UpperDir which is null

Source: [issue #35](https://github.com/link-foundation/disk-space-saviour/issues/35). Implementation: [PR #41](https://github.com/link-foundation/disk-space-saviour/pull/41).

## Evidence and timeline

- 2026-10-09T22:52:25Z: issue opened; full API metadata/body in [data/dss-issue.json](data/dss-issue.json), readable body in [data/dss-issue-body.md](data/dss-issue-body.md), and supplied output in [data/reporter-excerpts.log](data/reporter-excerpts.log).
- 2026-10-10: all comments read; [data/dss-comments.json](data/dss-comments.json) was empty. No downloadable original trace or screenshots were attached.
- 2026-10-10: traced package 0.15.2 and related safety PRs, wrote regressions, reproduced failures, implemented fixes and ran local checks.

The reporter’s production sizes/timings are supplied observations, not measurements independently repeated on that machine. Parent [case study](../issue-40/disk-space-saviour.md) reconstructs their sequence and the common research requirements. Existing unrelated case-study READMEs inherited from the pipeline template are preserved.

## Root cause

The storage model assumed classic GraphDriver data. A snapshotter-backed running container can expose no GraphDriver while still having an authoritative overlay upperdir in its init process mount namespace. Merged-view usage includes image bytes, so those values cannot authorize deletion. The source must be read using the executor on the daemon host, not the caller’s unrelated /proc.

## Every functional requirement and solution plan

| ID   | Requirement                                                                          | Selected implementation/plan                                                                                        | Alternatives and decision                                                                                | Verification                                                         |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 35.1 | Find running-container upperdir when GraphDriver is null                             | Read daemon-side /proc/State.Pid/mountinfo root overlay upperdir; unescape octal paths; validate accessibility      | ctr snapshots mounts requires containerd socket, namespace and snapshotter configuration                 | Null GraphDriver fixture with an escaped upperdir and no docker diff |
| 35.2 | Combine fast in-container candidate/liveness discovery with host measurement         | Reuse batched POSIX scan through nested executors; measure candidate paths in authoritative upperdir                | Optional copied Node scan or user-provided layer-map adds deployment/staleness risk; neither is required | Writable and image-only candidate measurement fixtures               |
| 35.3 | Delete fresh idle candidate lists inside the container in a batch                    | Fresh health, liveness, size and boundary checks; one rm argv batch per bounded set (up to 200 paths/48 KiB)        | One unlimited xargs call risks ARG_MAX and stale checks; bounded batches preserve rechecks               | Two idle paths deleted in one call; open third path preserved        |
| 35.4 | Remeasure upperdir and report actual allocated bytes freed                           | Measure selected upperdir paths before/after deletion; include directory allocation; mark fallback estimates        | Whole-layer delta can include unrelated concurrent writes; path-local delta is better attributable       | Cleanup test compares freedBytes to measured allocated blocks        |
| 35.5 | Report storage source in JSON and text                                               | Environment layerSource: graphdriver-upperdir, mountinfo-upperdir, overlay-upperdir, docker-diff or unknown-overlay | Storage source cannot make inaccessible evidence authoritative                                           | Report and public-type updates; source assertion                     |
| 35.6 | Image-only data must report zero reclaimable bytes and never be deleted              | Retain separate imageBytes; block zero writable and unknown items; delete only through merged mount                 | Direct host upperdir deletion breaks OverlayFS semantics                                                 | Image-only cleaner fixture proves the cache survives                 |
| 35.7 | Keep conservative behavior when standalone in-container storage remains inaccessible | Do not guess writable sizes; daemon-host mode is the supported hybrid path                                          | A layer-map alternative would require freshness validation and is not added                              | Existing no-Docker and unknown-overlay tests                         |

Each row also inherits the common evidence, online research, upstream triage, tracing and whole-codebase requirements in [the parent matrix](../issue-40/disk-space-saviour.md#common-requirements).

## Existing components and online facts

[Docker containerd documentation](https://docs.docker.com/engine/storage/containerd/) explains snapshotters and Docker 29’s fresh-install default, supporting the inference that classic GraphDriver metadata is insufficient. [Kernel OverlayFS documentation](https://www.kernel.org/doc/html/latest/filesystems/overlayfs.html) describes merged upper/lower trees and whiteouts. Therefore measurement uses upperdir while deletion uses the merged mount. ctr is an alternative discovery component, but requires extra socket/configuration knowledge.

## Reproduction, evidence and limits

Run the corresponding `tests/issue-35*.test.js` with Node’s test runner (30-second test budget), or use the repository’s full Node/Bun/Deno commands. Regression logs before and after changes are retained in this directory’s data folder. Reproductions use temporary fixtures or fake executors; no large production Rust tree or unbounded memory experiment is required.

See [validation and limitations](../issue-40/disk-space-saviour.md#validation-and-limitations) for runtime results, infrastructure constraints and remaining conservative cases. No original safety override is weakened. Workarounds and alternative designs are recorded in the matrix above.
