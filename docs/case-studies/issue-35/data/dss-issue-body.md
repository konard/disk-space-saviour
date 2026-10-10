## Problem

On a host with the Docker **containerd image store**, dss 0.15.0 has **no working way to clean caches inside running containers**:

- **In-container** (`docker exec -u 0 -e HOME=/home/box <c> node dss.js clean --no-docker --tier safe`): every item gets `sizeUnknown: true`, `bytes: 0`, and `clean` skips all of them: `skipped cargo-superseded … (writable-layer size unknown; inspect container/image storage before cleanup)` → `Would free 0 B`. That is the right conservative behaviour for #26, but it means nothing is ever cleaned.
- **From the host** (`dss scan --recursive`): it would have the layer data, but it does not finish (#33, one `docker exec` per path). And its "authoritative upperdir" source is `container.GraphDriver?.Data?.UpperDir` (`src/docker/writable.js`), which is **`null`** with the containerd store (`docker inspect -f '{{json .GraphDriver}}' <c>` → `null`).

Environment: dss **0.15.0** from `main` (`7c23a4a`). Docker 29.6.1, containerd image store (`io.containerd.snapshotter.v1.overlayfs`), five running containers (hive-mind root + DinD task containers).

## Working method (done by hand on this host; dss could do it)

1. **Upperdir from the host, without dockerd:** `/proc/<State.Pid>/mountinfo` of the container's init process, root mount (`$5 == "/"`), option `upperdir=…`:
   ```
   router#724 task  → /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/7140/fs   22G
   router#727 task  → …/snapshots/7146/fs   16G
   hive-mind root   → …/snapshots/6845/fs   3.4G
   ```
   (`ctr -n moby snapshots --snapshotter overlayfs mounts` gives the same.) This works for overlay2 and the containerd snapshotter alike, and takes milliseconds.
2. **Candidates from the fast in-container scan** (`scan --no-docker --json` inside each container: 29–189 s each, all 5 in about 7 min).
3. **Freeable bytes** = `du -sk <upperdir><path>` on the host for every candidate path. Result for safe + unblocked items: router#724 `cargo-superseded(-leaf)` 16.4 GiB, router#727 5.5 GiB, deno/bun/homebrew caches 0.25 GiB. In the same containers, `bun-cache` (2.3–2.7 GiB) was 0 B freeable: it is in the image.
4. **Delete inside the container** (so overlayfs records whiteouts correctly), with the exact path list of a fresh `scan --only cargo-superseded --only cargo-superseded-leaf` (liveness re-evaluated; the 2 items marked `busy: cargo is running` were left out): `docker cp list; docker exec -u 0 <c> sh -c 'xargs -0 rm -rf -- < list'` → the 724 writable layer went **22 GB → 15 GB**, host free **95 → 102 GB**, and the task kept running (its Codex rollout was written 1 s after the cleanup).

## Suggested fix

- In host mode, get the upperdir from `/proc/<pid>/mountinfo` (or `ctr … snapshots mounts`) when `GraphDriver` is `null`. Do not depend on `GraphDriver.Data.UpperDir` alone.
- **Hybrid mode** (`dss docker clean --recursive` / `dss clean --container X`): run the in-container scan for candidates and liveness (fast, #33), measure each candidate in the host-side upperdir (`du` on the host), and delete through **one** batched `docker exec … xargs -0 rm -rf` per container. Then re-measure the upperdir and report the actual bytes freed.
- Alternatively, let the in-container run accept a writable-layer map from the outer run (`--layer-map FILE`: path → upper bytes), so `clean` there no longer has to skip on `sizeUnknown`.
- Report the layer source per environment (`upperdir via mountinfo`, `GraphDriver`, `unknown`) in the JSON and the summary.
- Tests: a fake `docker inspect` with `GraphDriver: null` plus a mountinfo fixture with `upperdir=` must give known sizes, and an image-only cache must report 0 B and not be deleted.

---

We need to download all logs and data related about the issue to this repository, make sure we compile that data to `./docs/case-studies/issue-{id}` folder, and use it to do deep case study analysis (also make sure to search online for additional facts and data), in which we will reconstruct timeline/sequence of events, list of each and all requirements from the issue, find root causes of the each problem, and propose possible solutions and solution plans for each requirement (we should also check known existing components/libraries, that solve similar problem or can help in solutions).

If there is not enough data to find actual root cause, add debug output and verbose mode if not present, that will allow us to find root cause on next iteration.

If issue related to any other repository/project, where we can report issues on GitHub, please do so. Each issue must contain reproducible examples, workarounds and suggestions for fix the issue in code. Also double check to fully apply requirements to entire codebase, so if we have issue in multiple places, it should be fixed in all them.

Please plan and execute everything in this single pull request, you have unlimited time and context, as context auto-compacts and you can continue indefinitely, until it is each and every requirement fully addressed, and everything is totally done.
