# Issue 21: repeated container measurements

This file concerns disk-space-saviour. The pre-existing README in this directory
is retained as inherited case-study material for a different project.

## Timeline and causal evidence

The report was opened October 9 at 14:51:42 UTC. Its profile records 24 diffs
consuming 2,022 seconds, 1,207 stat calls taking 273 seconds and 31 inspect calls.
One container was diffed six times. A later real cleanup hit a 50-minute timeout
before audit completion; a local cached patch's timed run was interrupted by
the related host incident. These facts are archived in `data/dss-issue-21.json`;
no original full profile attachment was available.

`WritableLayer.measure` obtained diff/inspect anew for each measurement.
Planning and per-item remeasurements amplified that cost. Docker's containerd
changes implementation compares merged trees, including unchanged large lower
contents, explaining why even few cache candidates could cost minutes.

## Every requirement, alternatives and solution

| Requirement                                             | Alternatives and implemented plan                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One diff/inspect per container measurement run          | Share a layer and snapshot promise by executor and container ID; reuse discovery inspect data. Isolate different daemons and reset at the next scan.                                                                                                                           |
| Cache stat results and invalidate removed paths         | Cache changed-file metadata; forget deleted descendants and omit them from subsequent measurements without another measurement diff.                                                                                                                                           |
| Prefer upperdir/snapshot usage                          | Probe readable graphdriver or mountinfo upperdir first. Aggregate containerd Usage is evaluated but cannot attribute cache paths; never proportionally spread it over merged trees.                                                                                            |
| Explicit concurrency one and memory guard               | A centralized queue covers all DockerCli diff callers, including Git discovery. Check host/cgroup headroom and candidate/captured-output budgets; return unknown on unsafe/unavailable evidence.                                                                               |
| Measurement progress                                    | Verbose traces identify the container, snapshot start/end, upperdir selection and skip reasons. Existing scanner progress remains available.                                                                                                                                   |
| Complete case study, logs, research and upstream report | Archive issue/comment JSON, failing/passing regression logs and related source/release evidence; component research is linked below. Filed [moby/moby#53906](https://github.com/moby/moby/issues/53906).                                                                       |
| Apply across the codebase                               | Shared state serves running-container shell adapters, the identifiable host container, all scanners and cleanup measurement. Fresh serialized Git discovery before stopped-container removal intentionally bypasses a stale measurement snapshot to protect newly copied work. |

## Reproduction, limits and alternatives

`issue-27-storage.test.js` repeats/concurrently invokes measurement and asserts
one diff, one inspect, shared identities, serialized requests, cached/deleted
paths and low host/cgroup memory skips. `issue-27-details.test.js` asserts direct
upperdir accounting without diff. Before logs and final suites are archived in
[issue 27](../issue-27/README.md). The component table compares
[containerd, Moby and upperdir APIs](../issue-27/README.md#components-and-primary-source-research).

A cache measurement snapshot can age during a run; removal rechecks current
paths, liveness and content, and newly added Git work gets fresh discovery.
Client candidate/output caps do not hard-bound the daemon's full comparison;
the upstream report requests cancellation and cheaper bounded change discovery.
No speedup ratio is claimed without a comparable incident-host timing.
