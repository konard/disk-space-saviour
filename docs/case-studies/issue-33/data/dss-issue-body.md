## Problem

`dss scan --recursive` from the host does not finish: after **43 minutes** it was still inside the second of five containers. It runs one `docker exec` per path, about 120 ms each.

Environment: dss **0.15.0** from `main` (`7c23a4a`, run from source; npm still has 0.13.1 because the release job fails, #31). Host: Ubuntu 24.04, 6 CPU, 11.7 GB RAM, Docker 29.6.1 with the containerd image store, `live-restore: true`. Five running containers: the hive-mind root container plus four hive-mind DinD task containers, each with a Rust `target/` dir of 9–21 GiB.

```bash
DSS_DEBUG=1 dss scan --recursive --json      # as root on the host
```

Trace after 43 min (37,579 lines, `out.json` still empty; the run was then killed, see the signal issue):

| container | `docker exec … readlink -f` | `docker exec … sh -c` | other |
|---|---|---|---|
| router#727 task (`230afff13654`, `target/` ≈ 17 GiB) | **2,361** + still running | 79 | `find` per `target/debug/incremental/*` and `deps/*.d` dir, one exec each |
| another task (`fda2cb1f60c2`) | 173 | 135 | 23 `stat` |
| `680352ddcd35`, `b2699cb57be3` | 10–11 | 112–116 | 27 `stat` |

```
[dss] exec ["docker","exec","230afff1…","readlink","-f","--","/tmp/gh-issue-solver-1791515915848/target/debug/.fingerprint/zstd-safe-7018b99d35aa…"]
[dss] exit 0 after 125ms
[dss] exec ["docker","exec","230afff1…","find","/tmp/gh-issue-solver-resume-…/target/debug/deps/cli_contract_test-eb6d2284a80cd634.d","-xdev","-mindepth","1",…]
```

The good news: the `docker diff` fixes (#21/#22) hold. A guard sampling every 2 s saw **0** concurrent `docker diff`, dockerd RSS max 110 MB, and MemAvailable never below 8.2 GB.

For comparison, running the same dss **inside** each container (`docker exec -u 0 -e HOME=/home/box <c> node dss.js scan --no-docker`) took about 1 minute per container in 0.14.1 (#25/#26 runs).

## Root cause

The container environment (`src/env/` docker executor) implements per-path file operations (`realpath`/`readlink -f`, `stat`, `find` size walks, `head`) as one `docker exec` each. `docker exec` costs about 100–150 ms (API round trip, exec create/start, process spawn), so a Cargo `target/` with thousands of fingerprint/incremental entries takes hours. This is per-path work, not per-item work.

## Suggested fix

- **Batch per container:** send many paths in one exec, e.g. `docker exec -i <c> sh -c 'while IFS= read -r p; do printf "%s\0%s\0" "$p" "$(readlink -f -- "$p")"; done'` with paths on stdin (NUL-separated). Do the same for `stat` and sizes (`du -sk --apparent-size -- p1 p2 …` or `find … -printf '%s %p\n'` once per item root). Chunk to stay under ARG_MAX.
- **Or run dss itself inside the container** when `node` exists there (copy `bin/`+`src/` with `docker cp`, run `--no-docker --json`, and merge the report). That is the fast path that already works.
- Never walk below a known build-output root per file. `cargo-superseded` can list `target/*/.fingerprint` and `deps` in **one** `find … -printf` and do the grouping in JS.
- Add a per-environment time budget and a progress line (`container X: N/M items, elapsed`), and report "scan incomplete" for that environment instead of running indefinitely.
- Test: a fake executor that counts exec calls. Scanning a fixture `target/` with 1,000 fingerprints must use O(1) execs, not O(n).

---

We need to download all logs and data related about the issue to this repository, make sure we compile that data to `./docs/case-studies/issue-{id}` folder, and use it to do deep case study analysis (also make sure to search online for additional facts and data), in which we will reconstruct timeline/sequence of events, list of each and all requirements from the issue, find root causes of the each problem, and propose possible solutions and solution plans for each requirement (we should also check known existing components/libraries, that solve similar problem or can help in solutions).

If there is not enough data to find actual root cause, add debug output and verbose mode if not present, that will allow us to find root cause on next iteration.

If issue related to any other repository/project, where we can report issues on GitHub, please do so. Each issue must contain reproducible examples, workarounds and suggestions for fix the issue in code. Also double check to fully apply requirements to entire codebase, so if we have issue in multiple places, it should be fixed in all them.

Please plan and execute everything in this single pull request, you have unlimited time and context, as context auto-compacts and you can continue indefinitely, until it is each and every requirement fully addressed, and everything is totally done.
