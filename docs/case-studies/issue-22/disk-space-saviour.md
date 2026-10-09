# Issue 22: accidental Docker access and OOM

## Timeline and root causes

The October 9 14:51:45 UTC report describes 22 real concurrent changes calls
during unit tests. dockerd reached 7,302,520 kB anonymous RSS on an 11.7 GB host;
OOM killed it and its restart killed every task container. Seven emergency
fixture trees remained in `/tmp`. Kernel and cancellation lines are quoted in
the archived issue JSON; full original host journals were not attached.

Scan unconditionally discovered its own container and configured Docker layer
measurement despite `docker: false`. Fixture adapters inherited real `/proc`
reads. Parallel Node files then created independent layer objects and diffed
the same host container. Teardown depended on tests reaching their final lines.

## Every requirement, alternatives and solution

| Requirement                                     | Alternatives and implemented plan                                                                                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hermetic `/proc` and no real Docker in tests    | Fixture adapters supply identity/process/open-path metadata and reject Docker run/spawn. FakeDockerWorld handles intentional Docker tests. Do not rely on an invalid DOCKER_HOST alone.                                                             |
| No Docker accounting under --no-docker          | Gate self-ID discovery, binary discovery, inspect, layer configuration, scanner discovery and saved-report Docker actions; use local overlay-unknown accounting without Docker calls.                                                               |
| Shared layer per executor/container/process/run | Use a registry and per-run reset, ensuring adapters for one container share measurement state. Different Node worker processes cannot share JS state; hermetic guards prevent cross-worker daemon calls.                                            |
| Serialized diff and budgets                     | Central queue concurrency is one within a process. Check available host/cgroup memory, skip excessive candidate counts before measurement diff, cap captured result bytes/change lines and mark unknown.                                            |
| Every temporary root removed                    | Register fixture roots and remove in afterAll even after assertion failures; retain integration `finally` teardown. Integration containers/tags include PID to avoid collisions and have finite memory/PID caps.                                    |
| Evidence/research/upstream                      | Archive JSON, reproducing logs and DinD failure evidence. Submitted [moby/moby#53906](https://github.com/moby/moby/issues/53906); [report text](upstream-report.md) includes finite inputs, caps, workarounds and suggested implementation changes. |
| All analogous paths                             | Guards apply during normal scan, clean, saved-report clean and emergency mode. Every DockerCli diff caller uses the centralized queue.                                                                                                              |

## Reproduction and limits

Run the full unit suite; fixture guards fail immediately if a test accidentally
issues Docker. `issue-27-boundaries.test.js` supplies a known self-ID with
Docker disabled and a Docker discovery method that throws if touched.
`issue-27-storage.test.js` verifies headroom, candidate count and serialization;
saved-report behavior is pinned by `issue-27-details.test.js`.

The real DinD attempt was bounded but this checkout's host rejected cgroup
configuration before daemon startup; [the archived integration log](../issue-27/README.md)
records that infrastructure limit. No uncontrolled host OOM reproduction was
performed. The source-level upstream report is explicit that client limits do
not prevent every remote daemon allocation. Risk reduction and unknown sizes
are conservative fallbacks, not a daemon memory guarantee.
