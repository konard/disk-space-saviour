# Issue 25: one unreadable PID blocks the environment

The pre-existing README in this directory concerns inherited template material;
this report concerns disk-space-saviour only.

## Timeline and causal evidence

The October 9 15:43:09 UTC report compared containers with and without root
DinD processes. As uid 1001, two containers had every item blocked; without
inner root dockerd only actual active caches were blocked. Running as root
reduced one environment to one genuinely recent cache blocker. The exact
comparison and EACCES error are archived under `data/`.

Local rawOpenPaths threw on the first denied process symlink, discarding all
readable paths and triggering an environment-wide probe error. PR 15's privileged
shell fix did not solve this local non-root path.

## Every requirement, alternatives and solution

| Requirement                         | Alternatives and implemented plan                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partial per-process degradation     | Read UID, comm and cmdline independently; keep readable cwd/exe/fds from all processes and record denied PIDs instead of discarding the whole probe.                                                 |
| Scope plausible usage               | Resolve candidate ownership and command paths. Block matching UID paths, explicitly referenced paths and known daemon data roots, including `--data-root`; unidentified processes stay conservative. |
| Try privileged read-only inspection | Reuse an available privileged shell inspector, then noninteractive `sudo -n` local read-only proc inspection. No interactive password prompt. Retain readable evidence even if retry fails.          |
| One environment-level root hint     | Report the unreadable-process count and a root inspection suggestion once, while retaining specific relevant item blockers.                                                                          |
| Unrelated cache regression          | Fixture supplies unreadable UID-0 daemon plus UID-1001 cache; cache remains unblocked while matching owner/data roots are protected.                                                                 |
| All code paths and evidence         | Common liveness logic applies to local and shell scans, every scanner and cleanup/emergency refresh. Archive before/after logs and issue/comments.                                                   |

## Verification and upstream assessment

Run `node --test --test-timeout=30000 tests/issue-27-processes.test.js tests/issue-27-details.test.js tests/liveness.test.js tests/issue-14-liveness.test.js`.
The shell test retains readable stdout alongside structured denied PID stderr.
macOS interpreted script arguments and own-installation protection are also
covered in the process suite.

[Linux procfs](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
documents identity and process paths; denied symlinks are expected access
control, not an upstream kernel bug. The defect was dss's all-or-nothing
handling, so no separate upstream report is appropriate. A completely unknown
process identity still blocks conservatively. Noninteractive privileged retry
may not be available in every environment; the partial result remains useful.
