## Problem

A scan of the hive-mind box image (`konard/hive-mind-dind:2.34.0`, built on link-foundation/box, which installs the toolchains of many languages in `/home/box`) shows reclaimable caches that dss 0.15.0 (`main`, `7c23a4a`) **does not report at all**. Sizes are from `du -xsk` inside the running root container:

| Path | Size | What it is | Suggested rule (tier) |
|---|---|---|---|
| `~/.perl5/build` | 245 MB | perlbrew build trees left after `perlbrew install` | `perlbrew-build` (safe; native `perlbrew clean`) |
| `~/.perl5/dists` | 20 MB | perlbrew source tarballs | same rule |
| `~/.sdkman/tmp` | 138 MB | SDKMAN download leftovers | `sdkman-tmp` (safe; native `sdk flush tmp`) |
| `~/.sdkman/archives` | (empty here) | SDKMAN candidate zips | `sdkman-archives` (safe; `sdk flush archives`) |
| `~/.nvm/.cache` | 88 MB | nvm downloaded Node tarballs | `nvm-cache` (safe; native `nvm cache clear`) |
| `<project>/target/semver-checks` | **1.02 GB** in one router task | cargo-semver-checks baseline builds (`git-origin_main`, `local-…`), rebuilt on demand | `cargo-semver-checks-cache` (safe when idle, busy on `cargo-semver-checks`); today it is only counted inside `cargo-target` (aggressive) |
| `~/.rbenv/versions/*/lib/ruby/gems/*/cache` (also `~/.rvm/gems/*/cache`, `~/.local/share/gem/ruby/*/cache`) | 3.6 MB here, grows with every `gem install` | downloaded `.gem` files kept after install | `ruby-gem-cache` (safe; native `gem cleanup` does not remove them, so delete `*.gem` only) |

And one rule that misses its target on this image:

- **`go-mod-cache` is hard-coded to `~/go/pkg/mod`**, but the image sets `GOPATH=/home/box/.go/path`, so `go env GOMODCACHE` → `/home/box/.go/path/pkg/mod`. Any module downloads there are never found. `GOCACHE` happens to match the default `~/.cache/go-build`. The same applies to every tool whose cache location is configurable: `npm config get cache`, `pip cache dir`, `yarn cache dir`, `pnpm store path`, `cargo` (`CARGO_HOME`), `RUSTUP_HOME`, `GRADLE_USER_HOME`, `DENO_DIR`, `BUN_INSTALL_CACHE_DIR`, `XDG_CACHE_HOME`.

Checked and fine (no gap): `.cache/ms-playwright` (one revision per browser, nothing superseded), `.elan`/`.rustup` (one toolchain each), `.opam/download-cache`, `deno`, `bun`, `npm`, `node-gyp`, `homebrew`, `copilot`/`claude` versions.

## Suggested fix

- Add the rules above, each with a `busy` process list (`perlbrew`, `sdk`, `nvm`/`node`, `cargo-semver-checks`, `gem`/`bundle`) and the native command where one exists.
- Resolve cache roots from the tool or its environment first (`go env GOMODCACHE GOCACHE`, `npm config get cache`, env vars), and fall back to the static default paths. This matters most on images like box that install toolchains under non-default homes.
- Add a fixture test per rule, and one "configured location" test (for example `GOMODCACHE` outside `~/go`).

---

We need to download all logs and data related about the issue to this repository, make sure we compile that data to `./docs/case-studies/issue-{id}` folder, and use it to do deep case study analysis (also make sure to search online for additional facts and data), in which we will reconstruct timeline/sequence of events, list of each and all requirements from the issue, find root causes of the each problem, and propose possible solutions and solution plans for each requirement (we should also check known existing components/libraries, that solve similar problem or can help in solutions).

If there is not enough data to find actual root cause, add debug output and verbose mode if not present, that will allow us to find root cause on next iteration.

If issue related to any other repository/project, where we can report issues on GitHub, please do so. Each issue must contain reproducible examples, workarounds and suggestions for fix the issue in code. Also double check to fully apply requirements to entire codebase, so if we have issue in multiple places, it should be fixed in all them.

Please plan and execute everything in this single pull request, you have unlimited time and context, as context auto-compacts and you can continue indefinitely, until it is each and every requirement fully addressed, and everything is totally done.
