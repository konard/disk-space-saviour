# Issue 23: host traversal into container mounts

This investigation is separate from the inherited README/data already present
in this directory.

## Timeline and root cause

At October 9 14:51:47 UTC the reporter documented 44 read-only containerd image
mounts. The host scan proposed 235.8 MiB Python bytecode as safe and 436.6 MiB
node_modules as aggressive from those mounts, taking 232 seconds. A write would
fail EROFS there; a writable foreign root could be modified instead. The exact
mount line, measurements and proposed reproduction are archived in `data/`.

Traversal was path-based without a shared mount policy. A device-ID-only fix
would miss same-device bind mounts; result filtering would still incur the
foreign tree walk and allow parent recursive deletion to cross a mount.

## Every requirement, alternatives and solution

| Requirement                         | Alternatives and implemented plan                                                                                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do not cross filesystems by default | Combine decoded mountinfo boundaries with local device checks and shell `find -xdev`; apply before list/stat/usage.                                                                                                                                                     |
| Explicit ordinary roots allowed     | An explicitly selected ordinary mount root or selected subdirectory is allowed; unrelated mounted trees remain pruned.                                                                                                                                                  |
| Always skip runtime roots           | Prune `/tmp/containerd-mount*`, private-tmp equivalent, Docker/containerd/podman runtime roots and nested overlay/fuse-overlayfs mounts, even when explicitly selected.                                                                                                 |
| Read-only filesystems excluded      | Reject targets inside read-only mounts and ancestor recursive deletion containing a pruned mount.                                                                                                                                                                       |
| Entire codebase                     | Common policy wraps all local/shell scanners, direct cache expansion, Rust walks and cleanup rechecks. The overlay filesystem root itself remains scannable with conservative unknown storage attribution.                                                              |
| Case study/research/upstream        | Archive the original body/comments and regressions; see the aggregate component table. There is no separate mount implementation defect demonstrated upstream. Related Docker changes cost is reported in [moby/moby#53906](https://github.com/moby/moby/issues/53906). |

## Reproduction and verification

`issue-27-boundaries.test.js` models a same-device read-only overlay below a scan
root and asserts it is never listed. `issue-27-rule-families.test.js` tests the
ordinary explicit-subroot exception and runtime/overlay/read-only rejection.
Existing environment/shell suites test traversal. Synthetic mountinfo avoids
mounting a real host root in a test.

The [Linux procfs documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [OverlayFS documentation](https://www.kernel.org/doc/html/latest/filesystems/overlayfs.html)
support combining mount metadata with filesystem identity. Runtime roots are
explicit policy exclusions, not an inference that every ordinary bind mount is
container-owned. Readonly/runtime decisions are checked again before deletion.
