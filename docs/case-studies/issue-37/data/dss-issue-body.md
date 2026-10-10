## Problem

Running `dss clean` **on a Docker host**, the task-health watcher stops the whole host cleanup when an agent process **inside a container** exits, although host cache deletions cannot affect it:

```
$ dss clean --no-docker --tier safe -y --exclude /var/lib/containerd --exclude /var/lib/docker …   # as root on the host
  removed   67.5 MiB  npm-cache  /root/.npm/_cacache  (watched process claude (pid 3141776) exited while cleaning host:npm-cache:/root/.npm/_cacache)
Task health:
  host (vmi2955137): STOPPED cleaning: watched process claude (pid 3141776) exited while cleaning host:npm-cache:/root/.npm/_cacache
Freed 67.5 MiB
```

`pid 3141776` was a `claude` process of a hive-mind task container (its own PID and mount namespace) that finished on its own. Removing `/root/.npm/_cacache` on the host cannot touch it. On an agent host where task containers start and finish all the time, this means host cleanup almost always stops after the first item.

Environment: dss 0.15.0 (`main`, `7c23a4a`), Ubuntu 24.04, Docker 29.6.1, five running containers with `claude`/`codex`/`solve`/`cargo` processes.

## Root cause

`src/health.js` snapshots every process named in `AGENT_NAMES`/`BUILD_TOOL_NAMES` that is visible from the environment. From the host that includes the processes of **all containers**, because the host PID namespace sees them. Any of them exiting during the run counts as "gone".

## Suggested fix

- For the host environment, watch only processes in the host's own mount namespace (`/proc/<pid>/ns/mnt` equal to dss's own), or whose `cwd`/`root`/open files are under the paths being cleaned. Container processes are watched by that container's own environment when dss cleans inside it.
- Optionally still log container agents that exited, as information rather than a stop.
- Test: a fixture process in another mount namespace exiting during a host clean must not stop it, while a host-namespace `cargo` exiting still must.

---

We need to download all logs and data related about the issue to this repository, make sure we compile that data to `./docs/case-studies/issue-{id}` folder, and use it to do deep case study analysis (also make sure to search online for additional facts and data), in which we will reconstruct timeline/sequence of events, list of each and all requirements from the issue, find root causes of the each problem, and propose possible solutions and solution plans for each requirement (we should also check known existing components/libraries, that solve similar problem or can help in solutions).

If there is not enough data to find actual root cause, add debug output and verbose mode if not present, that will allow us to find root cause on next iteration.

If issue related to any other repository/project, where we can report issues on GitHub, please do so. Each issue must contain reproducible examples, workarounds and suggestions for fix the issue in code. Also double check to fully apply requirements to entire codebase, so if we have issue in multiple places, it should be fixed in all them.

Please plan and execute everything in this single pull request, you have unlimited time and context, as context auto-compacts and you can continue indefinitely, until it is each and every requirement fully addressed, and everything is totally done.
