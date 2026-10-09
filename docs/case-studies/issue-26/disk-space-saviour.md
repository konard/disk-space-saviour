# Issue 26: immutable image bytes presented as reclaimable

## Timeline and cause

At October 9 15:43:11 UTC the report compared 345.4 MiB writable usage with
13.79 GiB advertised safe cleanup, and 5.9 GiB with 16.41 GiB in another task.
Large Cargo leaf and Bun caches predated `docker commit` resume images. This
reproduced on current main after earlier #14 work, with Docker explicitly
disabled. The comparison is archived in `data/dss-issue-26.json`.

Merged filesystem usage cannot distinguish immutable lower files from writable
upper blocks. Host-container configuration depended on Docker identity/access,
and some leaf measurements escaped storage attribution. Deleting a lower file
adds a whiteout instead of recovering image data.

## Every requirement, alternatives and solution

| Requirement                                      | Alternatives and implemented plan                                                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Count only writable blocks                       | Prefer authoritative visible upperdir usage; otherwise use a guarded cached changes list and changed file blocks. Exclude mount destinations from image accounting because their data is separate.                   |
| Evaluate containerd snapshot Usage               | Aggregate snapshot usage excludes parents but cannot identify per-cache bytes. Do not turn it into a proportional per-path estimate. Upperdir evidence is the selected per-path source.                              |
| Detect overlay without host Docker               | Read local mountinfo; attach unknown-layer accounting before the docker:false early return. Zero known freeable bytes, original merged totalBytes and sizeUnknown survive reporting.                                 |
| Image bytes separate, image reference and advice | Expose imageBytes/imageRef where authoritative data exists; block image-only deletion and explain container/image removal or rebuilding after work finishes, including start-command-resume images.                  |
| Lower-cache fixture                              | Overlay fixture with a cache reports bytes zero and unknown without any Docker discovery. Upperdir fixture attributes only upper blocks and retains image bytes/reference.                                           |
| Entire codebase                                  | Final attribution includes Rust leaf items and all scanner results; report totals, text/JSON, saved-report cleanup and emergency remeasurement preserve conservative fields.                                         |
| Case study/research/upstream                     | Archive issue/comments and regressions; evaluate OverlayFS/containerd APIs in the aggregate research. Related expensive Docker changes are reported in [moby/moby#53906](https://github.com/moby/moby/issues/53906). |

## Verification and limitations

Run `node --test --test-timeout=30000 tests/issue-27-boundaries.test.js tests/issue-27-details.test.js tests/issue-14-storage.test.js tests/index.test.js`.
No original 13.79 GiB cleanup or daemon OOM is attempted. Tests use finite mock
layers and allocated blocks. Unknown attribution is excluded from reclaimable
totals and cannot authorize destructive cleanup.

[OverlayFS](https://www.kernel.org/doc/html/latest/filesystems/overlayfs.html)
explains whiteouts, while the
[containerd Snapshotter interface](https://github.com/containerd/containerd/blob/main/core/snapshots/snapshotter.go)
defines aggregate usage excluding parents. Neither promises per-path host space
recovery on every snapshotter. Estimates exclude metadata overhead; inaccessible
upperdirs and unsafe diff fallback remain unknown instead of guessed.
