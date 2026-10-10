## Problem

`dss scan` ignores SIGTERM and SIGINT, so neither Ctrl-C nor `timeout` can stop a long scan. Only SIGKILL works, and then no partial report is written.

Environment: dss **0.15.0** from `main` (`7c23a4a`, run from source; npm still has 0.13.1 because the release job fails, #31). Host: Ubuntu 24.04, 6 CPU, 11.7 GB RAM, Docker 29.6.1 with the containerd image store, `live-restore: true`. Five running containers: the hive-mind root container plus four hive-mind DinD task containers, each with a Rust `target/` dir of 9–21 GiB.

```bash
timeout 2400 node bin/dss.js scan --recursive --json > out.json
```
After 43 minutes, 3 minutes past the 2400 s timeout, `timeout` was still waiting on `node` (`ps`: `SN timeout 2400 node …`, child `SNl node …/dss.js scan …`), and dss kept issuing `docker exec` calls. `out.json` stayed empty. It took `kill -KILL`.

## Root cause

`bin/dss.js` installs handlers that replace Node's default terminate-on-signal behaviour:
```js
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
```
`signal.aborted` is only checked in `src/clean.js` and `src/audit.js`. The scan path (`scan.js`, scanners, docker executor) never checks it, and running child processes are not killed. So a signal during `scan` (or during the scan phase of `clean`/`emergency`) does nothing.

## Suggested fix

- Check `options.signal` in the scan loop (between environments, scanners and items), and pass it to every `spawn`/`execFile` (`{ signal }`) so in-flight `docker exec`/`find` children are killed.
- On abort, write what was found so far, marked `"aborted": true` / "scan incomplete", and exit 130 (SIGINT) or 143 (SIGTERM).
- If a second signal arrives, or the scan has not stopped within about 5 s, exit immediately: `process.once` handlers that only flip a flag must not make the process unkillable.
- Test: start a scan on a fixture with a slow fake executor, send SIGTERM, and expect an exit within a few seconds with a partial report.

---

We need to download all logs and data related about the issue to this repository, make sure we compile that data to `./docs/case-studies/issue-{id}` folder, and use it to do deep case study analysis (also make sure to search online for additional facts and data), in which we will reconstruct timeline/sequence of events, list of each and all requirements from the issue, find root causes of the each problem, and propose possible solutions and solution plans for each requirement (we should also check known existing components/libraries, that solve similar problem or can help in solutions).

If there is not enough data to find actual root cause, add debug output and verbose mode if not present, that will allow us to find root cause on next iteration.

If issue related to any other repository/project, where we can report issues on GitHub, please do so. Each issue must contain reproducible examples, workarounds and suggestions for fix the issue in code. Also double check to fully apply requirements to entire codebase, so if we have issue in multiple places, it should be fixed in all them.

Please plan and execute everything in this single pull request, you have unlimited time and context, as context auto-compacts and you can continue indefinitely, until it is each and every requirement fully addressed, and everything is totally done.
