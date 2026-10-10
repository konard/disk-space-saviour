## Problem

This is a follow-up to #14, part 1, which is closed. In dss 0.15.2 the liveness probe still blocks **every** item in the two in-container setups we run, so nothing can be cleaned there. The reason is always the same: some process of another uid can't be inspected.

### 1. Bot container (not privileged), dss run as root via `docker exec -u 0`

`docker exec` has no `CAP_SYS_PTRACE`, so root can't read the bot user's `/proc/<pid>/cwd`:

```
$ docker exec -u 0 hive-mind sh -c 'readlink /proc/1/cwd; echo rc=$?'
rc=1
$ docker exec hive-mind sh -c 'id -u; readlink /proc/1/cwd'     # as the owner
1001
/home/box
```

`dss scan --no-docker --json --tier safe` (HOME=/home/box) gives `totals.blocked.items = 159` out of 159 items. Every one carries the same blocker:

```
safe 0 bun-cache /home/box/.bun/install/cache | busy: unreadable process bash (pid 1, uid 1001) may use /home/box/.bun/install/cache
safe 0 npm-cache /home/box/.npm/_cacache    | busy: unreadable process bash (pid 1, uid 1001) may use /home/box/.npm/_cacache
```

`du` shows 3.1 GiB in `~/.bun/install/cache`, 330 MiB in `~/.npm/_cacache` and 1.8 GiB in `~/.cache`. The same scan run **as uid 1001** unblocks 31 safe items, and the clean then freed 1 GiB from the container's writable layer.

### 2. Privileged DinD task container, dss run as the main process's user (1001)

Now the root `dockerd`/`containerd` inside the container are the unreadable processes. 89 safe items were blocked in one container. As root, which is allowed in a privileged container, the same container gives 9 safe items with 2 blocked.

So dss gives correct results only if the caller guesses which identity can see every process. Nothing in the report says that this is the problem.

### Also

Blocked items report `bytes: 0`, and `totals.blocked.bytes` is 0. So the report hides that 5+ GiB is blocked, not absent (related: #35).

## Suggestions

1. Probe per process with the identity that can read it. When dss runs as root without `CAP_SYS_PTRACE`, re-read an unreadable process's `cwd`/`fd`/`exe` as that process's uid (`setpriv --reuid <uid> --regid <gid> --clear-groups readlink /proc/<pid>/cwd`, or a forked helper that drops privileges). That works for same-uid processes that aren't dumpable-restricted.
2. Treat an unreadable process as "may use" only paths it could plausibly touch, i.e. paths it can write. A root `dockerd` with an unreadable cwd is not evidence that `~/.cargo/registry` is in use, unless `/proc/<pid>/fd` (readable in a privileged container) shows it.
3. Print a single environment-level warning instead of a bare blocker on every item. For example: "liveness: 1 process unreadable (bash pid 1 uid 1001); run as uid 1001 or with CAP_SYS_PTRACE".
4. Report the size of blocked items, so "blocked" bytes are visible.

## Workaround

link-assistant/hive-control-center `auto-fix/disk-clean.mjs` scans as root in privileged containers, and otherwise as the uid of the container's pid 1. Deletion runs as root.

We need to download all logs and data related about the issue to this repository, make sure we compile that data to `./docs/case-studies/issue-{id}` folder, and use it to do deep case study analysis (also make sure to search online for additional facts and data), in which we will reconstruct timeline/sequence of events, list of each and all requirements from the issue, find root causes of the each problem, and propose possible solutions and solution plans for each requirement (we should also check known existing components/libraries, that solve similar problem or can help in solutions).

If there is not enough data to find actual root cause, add debug output and verbose mode if not present, that will allow us to find root cause on next iteration.

If issue related to any other repository/project, where we can report issues on GitHub, please do so. Each issue must contain reproducible examples, workarounds and suggestions for fix the issue in code. Also double check to fully apply requirements to entire codebase, so if we have issue in multiple places, it should be fixed in all them.

Please plan and execute everything in this single pull request, you have unlimited time and context, as context auto-compacts and you can continue indefinitely, until it is each and every requirement fully addressed, and everything is totally done.
