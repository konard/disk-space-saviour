## Problem

`dss scan` is read-only, but it **fails and loses its whole report** when it can't write its audit log. `Cli.scan()` (`src/cli.js`) runs the full scan (minutes on a busy machine) and only then calls `writeAudit()`. `writeAudit` throws on `EACCES`, and nothing is printed, not even with `--json`:

```
$ docker exec -u 1001 -e HOME=/home/box <task> node dss.js scan --no-docker --json --tier safe
dss: EACCES: permission denied, open '/home/box/.local/state/disk-space-saviour/audit/dss-scan-2026-10-10T10-01-35-916Z-28090.json'
(exit 1, no JSON on stdout)
```

It's easy to hit: an earlier run as root (`docker exec -u 0`, or `sudo dss`) creates `~/.local/state/disk-space-saviour/audit` as root. Every later run as the real user then fails. It happened in all 4 of our task containers.

## Expected

- The audit log is a side record. If it can't be written, warn (`Audit log: not written (EACCES ...)`) and still print the report. The text output already supports `Audit log: not written`.
- Or fall back to a private temp dir (`os.tmpdir()/dss-audit-<uid>`).
- When dss runs as root with `HOME` pointing at another user's home, create the state dir with that home's owner, or don't create it under that home at all.

## Workaround

Pass `--audit-dir` with a writable dir, as link-assistant/hive-control-center `auto-fix/disk-clean.mjs` now does.

We need to download all logs and data related about the issue to this repository, make sure we compile that data to `./docs/case-studies/issue-{id}` folder, and use it to do deep case study analysis (also make sure to search online for additional facts and data), in which we will reconstruct timeline/sequence of events, list of each and all requirements from the issue, find root causes of the each problem, and propose possible solutions and solution plans for each requirement (we should also check known existing components/libraries, that solve similar problem or can help in solutions).

If there is not enough data to find actual root cause, add debug output and verbose mode if not present, that will allow us to find root cause on next iteration.

If issue related to any other repository/project, where we can report issues on GitHub, please do so. Each issue must contain reproducible examples, workarounds and suggestions for fix the issue in code. Also double check to fully apply requirements to entire codebase, so if we have issue in multiple places, it should be fixed in all them.

Please plan and execute everything in this single pull request, you have unlimited time and context, as context auto-compacts and you can continue indefinitely, until it is each and every requirement fully addressed, and everything is totally done.
