# disk-space-saviour

`dss` finds and safely deletes regenerable disk usage: package manager
caches, build outputs, forgotten dependency folders, old toolchain versions,
agent and browser caches, system logs, and Docker data. That includes caches
inside running containers and in nested Docker-in-Docker daemons. It is a
command line tool and a JavaScript library (`scan()` → report,
`clean(report)` → audit log).

## Why

Build machines and AI agent hosts fill their disks with data that can be
rebuilt: `node_modules`, `target/`, `~/.cache`, Docker layers and caches left
inside long-lived containers. Deleting this data by hand is risky, because
the same folder may belong to a build that is running right now or to a
container holding unpushed work. `dss` only touches regenerable data. It
checks liveness and Git state again right before each deletion, and it never
deletes anything unless you ask it to.

## Quick Start

```bash
npm install -g disk-space-saviour   # or: npx disk-space-saviour scan

dss scan                 # report only, never deletes
dss clean                # plan for the safe tier (dry run)
dss clean --yes          # delete the safe tier
dss clean --tier moderate --yes
dss emergency --free 20G --yes      # escalate tiers until 20 GiB is free
dss docker scan --recursive         # containers and nested daemons
```

Example (`dss scan ~/work` on two projects untouched for 40 days):

```
disk-space-saviour scan of host (build-01) in 3.7s (report only, nothing was deleted)
/: 75.8 GiB free of 193 GiB (61% used)

MODERATE  2 items, 7.6 MiB
     4.8 MiB  cargo-target  /home/me/work/api/target
     2.9 MiB  node-modules  /home/me/work/web/node_modules

Reclaimable (cumulative): safe 0 B · moderate 7.6 MiB · aggressive 7.6 MiB; blocked 0 B
Audit log: /home/me/.local/state/disk-space-saviour/audit/dss-scan-2026-09-26T00-31-05-432Z-232874.json
Run `dss clean --tier safe` to see the plan, add --yes to delete.
```

`dss clean` without `--yes` asks on a terminal. When nobody can answer
(CI, agents, pipes), it prints the plan, deletes nothing, and says
`Dry run: pass --yes to delete non-interactively.` Add `--json` to any
command to get the report or audit log as JSON (`dss scan --json`).

## Commands

```
dss scan [paths...] [--docker] [--depth N] [--json]      # report only
dss clean [paths...] --tier safe|moderate [--yes] [--older-than 1h]
dss emergency --free 20G | --until 80% [--path /] [--yes]
dss docker scan|clean [--container ID] [--recursive]
```

| Exit code | Meaning                                  |
| --------- | ---------------------------------------- |
| 0         | success (a dry run counts as success)    |
| 1         | error, or at least one deletion failed   |
| 2         | usage error                              |
| 3         | `dss emergency` could not reach its goal |

Run `dss --help` for every option. The most useful ones:

- `--only NAME` limits a run to an ecosystem, rule or kind (`--only rust`,
  `--only npm-cache`, `--only docker-stopped-container`).
- `--exclude PATH|GLOB` prunes matching paths and descendants before reading
  them. Patterns containing separators match full paths and their ancestors;
  other patterns also match ancestor basenames.
- `--scanner NAME` restricts scanning to `projects`, `global`, `versions`,
  `agents` or `system`.
- `--report FILE` limits cleaning to items in a saved `dss scan --json`
  report. The current rules rescan those items before deletion.

## Tiers

Tiers are cumulative: `moderate` includes `safe`, and `aggressive` includes
both.

| Tier         | What it removes                                                                                                                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safe`       | Download and application caches, idle package-runner entries, old browser revisions, inactive lockfile-backed `node_modules`, dangling Docker images and build cache. Includes writable caches inside running containers.                                                                             |
| `moderate`   | Whole `target/`, `.venv`, `build/` and similar folders of inactive projects; old agent scratch and Telegram downloaded media (secret-chat media may be irreplaceable); unused toolchain versions and tagged images; stopped containers. Container and tagged-image removal requires explicit consent. |
| `aggressive` | For emergencies: everything regenerable, including build outputs of projects in active use. Only `dss emergency` reaches it.                                                                                                                                                                          |

Covered ecosystems: JavaScript/TypeScript (npm, yarn, pnpm, bun, deno,
framework build caches), Python, Rust, JVM (Gradle, Maven, Kotlin, Android),
Go, C/C++ (CMake, ccache, vcpkg, Conan), .NET, PHP, Ruby, Swift/Xcode, Dart,
Haskell, Scala, Elixir, OCaml, Lean, Julia, R, Zig, and scripting languages.
Also covered: version managers (nvm, pyenv, rbenv, SDKMAN!, rustup, elan,
ghcup, opam, swiftly, VS Code Server, Claude Code and Copilot CLI), Playwright, playwright-go, Puppeteer
and Cypress browsers, HTTP caches of Chrome, Chromium, Edge, Brave, Opera,
Opera GX, Vivaldi, Arc, Yandex Browser, Naver Whale, 360, QQ Browser, Firefox,
LibreWolf, Waterfox, Zen and Floorp, IDE caches (JetBrains, VS Code, Cursor,
Windsurf, Qoder), AI agent caches and logs, the Discord cache, macOS app
updates staged by Sparkle and Squirrel, package manager archives, trash, crash
reports, core dumps and journald logs. Telegram pure caches, Safari/WebKit,
Chromium code/GPU/Dawn/service-worker caches and marker-validated Electron
caches are included. Telegram databases, browser profiles and Playwright MCP
profiles are preserved. macOS access failures explain when Full Disk Access
is needed. Agent scratch cleanup requires inactivity and Git safety checks.

## Safety

- **Dry run by default.** `scan` never deletes. `clean` and `emergency`
  delete only with `--yes` or an interactive yes, and never with
  `--dry-run`.
- **Regenerable data only.** Every rule describes data that a tool
  recreates: a cache, a build output or a dependency install.
- **Liveness checks, repeated right before each path is deleted.** Paths
  that a process holds open (`/proc/*/fd`, `cwd`, `exe`, or `lsof` on
  macOS) are skipped. So are projects with a running `cargo`, `gradle`,
  `npm`, `node` or similar tool, and anything modified within
  `--older-than` (1h).
- **Rust builds are pruned in two parts.** `cargo-superseded` removes
  older hashes of a unit (`.rlib`, `.rmeta`, `.so`/`.dylib`/`.a`,
  `build/*`, `.fingerprint`) that a newer build replaced, but never while
  `cargo` or `rustc` runs in the project: a running build may have judged
  them fresh. `cargo-superseded-leaf` removes incremental session
  directories idle for 3 hours and test/example binaries older than 3
  hours that a newer build replaced. Nothing links against them, so this
  part stays eligible while cargo runs; each file a process runs or holds
  open is skipped.
- **Running tasks must survive.** Before its first deletion in an
  environment (the host or a container), `clean` records PID 1, agents
  (`claude`, `codex`, `solve`, ...) and build tools (`cargo`, `gradle`,
  ...) with their start times. It checks them again after every removed
  path and item. If one is gone or its PID was reused, cleaning in that
  environment stops at once, and the audit log and summary say which
  process was lost. A build that simply finishes during the cleanup also
  stops it: an exit cannot be told apart from a crash.
- **Git awareness.** Whole projects and containers are protected while they
  have unsaved changes, unpushed commits or stashes. Ignored dependency and
  build outputs can be cleaned despite unrelated source changes; tracked or
  non-ignored files inside an artifact remain protected. Stopped-container scans show
  Git state before cleanup. Unstaged and untracked files can be recognized
  as preserved when their bytes and modes all match one cached remote ref,
  such as `origin/recovery/<branch>`. No remote fetch is performed; missing
  refs, staged work and unreadable files remain blockers. Detached upstream
  checkouts are accepted only when their commit is reachable from a remote
  ref. Nested Docker layer copies and temporary Codex plugin checkouts are
  excluded from this inspection. Unsaved container work requires an exact
  `--allow-dirty-container ID` override.
- **Audit log on every run.** Each run, dry runs included, writes
  `dss-<command>-<time>-<pid>.json` with every decision, the bytes freed
  and left per environment, and disk usage before and after. Scan audits
  include every candidate and its blockers; blocked candidates do not
  contribute to reclaimable tier totals.

Long-lived `npm exec`/`npx` servers allow idle npm download and node-gyp
header caches to be cleaned. Active npx hashes remain protected through
their child command paths, working directories and open files; other
hashes are separate candidates subject to the age window. Install commands
still block relevant caches. Bunx, pnpm dlx and Yarn dlx entries use the same
path protection, and dss always protects its own installation. Interrupts
finish the partial audit and report the abort. Unreadable processes retain
their readable identity; uncertain activity blocks relevant paths and owners
and produces one environment hint. Old isolation logs and sanitized upload staging
are moderate-tier candidates. Opam download cleanup removes its cache
directory directly and does not invoke `opam clean` or migrate the root.

## Docker

With `--docker`, or automatically when a daemon is reachable, `dss` handles
three kinds of Docker data:

- **Daemon data:** `docker system df`, dangling images and build cache.
  `--include-volumes` lists unattached volumes for manual inspection; it
  does not delete them.
- **Unused tagged images** are listed with their size, creation date and
  the container that used them last (from the `docker inspect` backups
  of containers dss removed), when known. No tier removes them, emergency
  mode included: approve each one with `--remove-image REF` (`repo:tag`,
  `repo` for `:latest`, or an id prefix of at least 12 characters) or an
  interactive yes for that image. The summary line counts them, and
  stopped containers that need consent, as `needs explicit consent`, so
  the tier totals match what `clean --tier … --yes` removes.
- **Running containers** are never stopped, restarted or removed. They are
  scanned and cleaned from the inside through `docker exec`, with the same
  rules and liveness checks as the host. An unreadable `/proc` probe is
  retried with a read-only root `docker exec --privileged` inspection. If
  this is denied or incomplete, cleanup stays blocked and names the
  unreadable processes. This also applies when dss runs inside a container
  with access to its Docker daemon.
- **Stopped containers** are listed with their size, image, command, owner
  session (`HIVE_MIND_PARENT_SESSION_ID` and other session labels or
  environment variables, else a session id in the container name), task
  URL, exit code and reason, OOM flag and end time, and the Git state of
  repositories in their writable layer. The layer is copied out with
  `docker cp` and checked with Git. A container is removed only with
  `--remove-stopped-containers` or after an interactive yes per container,
  and only when its Git state is clean. Before `docker rm`, its logs and
  `docker inspect` output are saved to `--backup-dir`.
- **Containers kept for investigation** (a non-zero exit code or OOM
  killed) are never removed by a tier or by `--remove-stopped-containers`,
  in emergency mode too. Name each one with `--remove-container ID|NAME`
  (a full name, or an id prefix of at least 12 characters) to remove it.
  Alternatively, `--investigation-max-age 7d` lifts holds for containers
  that ended at least seven days ago; removal still requires consent and
  Git checks. The default keeps investigation holds indefinitely.

Container cache sizes count changed writable-layer file blocks and mounted
data. Immutable image data is reported separately as `imageBytes` and is
excluded from reclaimable totals, including the host scan when dss runs
inside an identifiable container. Image-only caches stay visible and blocked;
rebuild the image to remove that data. These estimates exclude directory
metadata overhead. A small stopped container pinning a large image is shown
even below `--min-size`; its potential image bytes require a separate image
removal after the container is removed.

`--no-docker` makes no Docker calls, including for storage accounting and
saved-report cleanup. An overlay root without authoritative upperdir evidence
has unknown freeable bytes and contributes zero to reclaimable totals.
Measurements prefer accessible upperdirs; the diff fallback shares one
serialized snapshot and cached stats per container/run, checks host and cgroup
memory headroom, and skips excessive candidate counts. Fresh Git checks before
stopped-container removal still inspect new work. Verbose mode reports storage
measurement progress. Host scans prune runtime, nested overlay, read-only and
unselected mount points; explicitly selected ordinary mount roots are allowed.

Docker discovery uses a size-free container listing and measures each
container independently. Failed size queries are retried once; objects
remain visible with `sizeUnknown` when measurement fails. Scans continue
through other objects and nested daemons, report partial errors, and return
a nonzero CLI exit status when discovery is incomplete.

`--recursive` follows Docker-in-Docker: a container that runs its own daemon
is scanned as a new environment, down to `--depth` levels (default 3). The
CI job `Docker-in-Docker Integration` builds a host → l1 → l2 chain and runs
`tests/integration/dind.mjs` against it (`npm run test:dind`).

## Emergency mode

`dss emergency --free 20G` (at least 20 GiB available) or
`dss emergency --until 80%` (at most 80% used) works through the tiers in
order. Within a tier it removes caches first, then Docker objects, and
stopped containers last, only when approved. It re-reads the disk after
every deletion and stops as soon as the goal is met. It exits with 3 when
even the aggressive tier cannot reach the goal. `--path` chooses the volume
(default `/`); items on other host volumes are skipped.

## Library

```js
import { scan, clean, emergency, formatReport } from 'disk-space-saviour';

const report = await scan({ roots: ['/work'], docker: false });
console.log(formatReport(report));

// Library calls delete unless dryRun is set.
const audit = await clean(report, { tier: 'safe', dryRun: true });
console.log(audit.plannedBytes, audit.file);

await emergency({ free: '20G', removeStoppedContainers: false });
```

Types ship in `src/index.d.ts`. See `examples/basic-usage.js` for a runnable
example and `examples/universal-app` for a report viewer.

## Configuration

| Option / variable                | Default                                    | Purpose                                     |
| -------------------------------- | ------------------------------------------ | ------------------------------------------- |
| `--audit-dir`, `DSS_AUDIT_DIR`   | `$XDG_STATE_HOME/disk-space-saviour/audit` | Where audit logs go                         |
| `--backup-dir`, `DSS_BACKUP_DIR` | `…/disk-space-saviour/backups`             | Container log backups before `docker rm`    |
| `--older-than`                   | `1h`                                       | Activity window; newer files are kept       |
| `--inactive`                     | `30d`                                      | Project inactivity before `moderate`        |
| `--min-size`                     | `1M`                                       | Smaller items are not reported              |
| `--depth`                        | `3`                                        | Docker nesting depth                        |
| `--journal-keep`                 | `512M`                                     | journald size to keep                       |
| `--verbose`, `DSS_DEBUG=1`       | off                                        | List everything, trace commands and timings |

`$XDG_STATE_HOME` falls back to `~/.local/state`. Linux and macOS are
supported (liveness uses `/proc` on Linux and `lsof` on macOS).

### Repository settings

#### Protected-Branch Release Pull Requests

If `main` requires pull requests and the `Pipeline Status` check, configure a
repository secret named `RELEASE_PR_TOKEN`. It must be a fine-grained PAT for
an automation actor other than the workflow's built-in `GITHUB_TOKEN`, scoped
to this repository with Contents and Pull requests write access and Checks read
access. The release and generated-preview fallbacks use it to open the PR, wait
for the PR's own checks, and merge only after they pass. The manual
changeset-PR mode uses it for the same reason. Teams that generate short-lived
GitHub App installation tokens can wire that action output to the same workflow
inputs instead of storing a PAT.

Repositories that allow the release workflow to push directly to `main` do not
exercise the fallback, but manual changeset PR creation still requires this
secret.

#### Optional Docker Hub Publishing

Docker publishing is disabled by default. To enable it for a project that ships
a Docker image, add a `Dockerfile` and configure these GitHub Actions settings:

| Setting              | Type               | Description                                                                           |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| `DOCKERHUB_IMAGE`    | Variable           | Docker Hub image name, for example `namespace/image`. This enables Docker publishing. |
| `DOCKERHUB_USERNAME` | Variable           | Docker Hub username used by `docker/login-action`.                                    |
| `DOCKERHUB_TOKEN`    | Secret             | Docker Hub access token used for registry authentication.                             |
| `DOCKER_CONTEXT`     | Variable, optional | Docker build context. Defaults to `.`.                                                |
| `DOCKERFILE`         | Variable, optional | Dockerfile path. Defaults to `./Dockerfile`.                                          |

When enabled, the release workflow waits until the exact published npm version
is visible in the npm registry, then publishes Docker Hub tags for `latest` and
that same version. The Docker build also receives `NPM_PACKAGE_VERSION` as a
build argument so Dockerfiles can install the matching published package.

#### ESLint Rules

Customize ESLint in `eslint.config.js`. Current configuration:

- ES Modules support
- Prettier integration
- No console restrictions (common in CLI tools)
- Strict equality enforcement
- Async/await best practices
- **Strict unused variables rule**: No exceptions - all unused variables, arguments, and caught errors must be removed (no `_` prefix exceptions)

#### Prettier Options

Configured in `.prettierrc`:

- Single quotes
- Semicolons
- 2-space indentation
- 80-character line width
- ES5 trailing commas
- LF line endings

## Development

```bash
npm install
npm test                  # Node.js, 30s per test
bun test --timeout 30000  # Bun
deno test --allow-read    # Deno (read-only tests)
npm run check             # lint + format + duplication
npm run test:dind         # Docker-in-Docker integration (needs --privileged)
node bin/dss.js scan --verbose
```

### Project Structure

```
.
├── .changeset/           # Changeset configuration
├── .github/workflows/    # GitHub Actions CI/CD
├── .husky/               # Git hooks (pre-commit)
├── examples/             # Usage examples
│   └── universal-app/    # React + GitHub Pages + Electron + Capacitor app
├── scripts/              # Build and release scripts
├── src/                  # Source code
│   ├── index.js          # Main entry point
│   └── index.d.ts        # TypeScript definitions
├── tests/                # Test files
├── .eslintrc.js          # ESLint configuration
├── .prettierrc           # Prettier configuration
├── bunfig.toml           # Bun configuration
├── deno.json             # Deno configuration
└── package.json          # Node.js package manifest
```

### Multi-Runtime Support

This template is designed to work seamlessly with all major JavaScript runtimes:

- **Bun**: Primary runtime with highest performance, uses native test support (`bun test`)
- **Node.js**: Alternative runtime, uses built-in test runner (`node --test`)
- **Deno**: Secure runtime with built-in TypeScript support (`deno test`)

The [test-anywhere](https://github.com/link-foundation/test-anywhere) framework provides a unified testing API that works identically across all runtimes.

### Package Manager Agnostic

While `package.json` is the source of truth for dependencies, the template supports:

- **bun**: Primary choice, uses `bun.lockb`
- **npm**: Uses `package-lock.json`
- **yarn**: Uses `yarn.lock`
- **pnpm**: Uses `pnpm-lock.yaml`
- **deno**: Uses `deno.json` for configuration

Note: `package-lock.json` is not committed by default to allow any package manager.

### Universal App Example

The template includes `examples/universal-app`, a Vite React app that imports
`add` and `multiply` from `src/index.js` and renders a visual calculator UI.
The same static build is used by:

- GitHub Pages (`npm run example:web:build`)
- Electron desktop packaging (`npm run example:desktop:package`)
- Capacitor Android/iOS sync (`npm run example:mobile:sync`)

The example app has its own `package.json` and lockfile so template users can
opt into the frontend stack without adding React, Electron, or Capacitor to the
library package itself.

See [examples/universal-app/README.md](examples/universal-app/README.md) for
local web, desktop, Android, and iOS testing instructions.

### Code Quality

- **ESLint**: Configured with recommended rules + Prettier integration
- **Prettier**: Consistent code formatting
- **Husky + lint-staged**: Pre-commit hooks ensure code quality
- **File size limit**: Files must stay under 1500 lines for maintainability (enforced via ESLint and CI)

### Release Workflow

The release workflow uses [Changesets](https://github.com/changesets/changesets) for version management:

1. **Creating a changeset**: Run `bun run changeset` to document changes
2. **PR validation**: CI checks for valid changeset in each PR
3. **Automated versioning**: Merging to `main` triggers version bump
4. **npm publishing**: Automated via OIDC trusted publishing (no tokens needed)
5. **Optional Docker Hub publishing**: When configured, waits for the exact npm version and tags the Docker image with that version
6. **GitHub releases**: Auto-created with formatted release notes

> **First release of a brand-new package**: npm publishes only through
> trusted publishing, and a trusted publisher can only be attached to a package
> that already exists (the first publish from CI fails with `E404`). Publish the
> first version once with
> [package-registry-manager](https://github.com/link-foundation/package-registry-manager):
> `npx package-registry-manager setup --registry npm --execute`. It signs in
> through the browser, publishes, attaches this workflow as the trusted
> publisher and signs out again. No npm token is ever stored.

#### Manual Releases

Two manual release modes are available via GitHub Actions:

- **Instant release**: Immediately bump version and publish
- **Changeset PR**: Create a PR with changeset for review

### CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/release.yml`) implements a fast-fail pipeline:

**Fast checks** (~7-30s each, run first for fastest feedback):

1. **Test compilation**: Syntax-checks all `.mjs` files with `node --check`
2. **Lint, format & secrets scan**: ESLint, Prettier, jscpd, and [secretlint](https://github.com/secretlint/secretlint) for credential leak detection
3. **File line limits**: Enforces the 1500-line limit on JavaScript (`.js`, `.mjs`, `.cjs`) and Markdown (`.md`) files plus `release.yml`
4. **Changeset check**: Validates PR has exactly one changeset (added by that PR)
5. **Version check**: Blocks manual version changes in `package.json`
6. **Documentation validation**: Checks required doc files (doc line limits are enforced by the file line limits check)

**Slow checks** (only run after all fast checks pass):

7. **Test matrix**: 3 runtimes × 3 OS = 9 test combinations
8. **Broken link checks**: Validates all links in Markdown/HTML files (separate workflow)

**Release** (on merge to main):

9. **Changeset merge**: Combines multiple pending changesets at release time
10. **Release**: Automated versioning and npm publishing
11. **Optional Docker publish**: Publishes Docker Hub `latest` and npm-version tags after the npm package is visible

#### Reasonable Timeouts

Every CI job declares an explicit `timeout-minutes` so hung steps fail
in minutes instead of reaching the GitHub Actions default of six hours.
Fast checks use 5-10 minute caps, release jobs use 30 minutes, and the
link checker uses 10 minutes for external network variance.

That cap is a backstop, never the deadline: GitHub reports a job it
kills as **cancelled**, not **failed**. Long steps therefore own an
explicit budget via `scripts/run-with-budget-warning.sh`, which warns at
70% of the budget and fails the step with exit code 124 when it expires.
See [CI-TIMEOUT-BUDGETS.md](docs/CI-TIMEOUT-BUDGETS.md).

Individual tests are also capped inside supported runners:
`npm test` runs `node --test --test-timeout=30000`, and the CI Bun
runner uses `bun test --timeout 30000`. Both bound a _single test_, not
the suite, which is why the suite budget above exists. Deno does not
provide a single global per-test timeout flag, so Deno tests are
protected by their step budget and the matrix job backstop.

See [BEST-PRACTICES.md](docs/BEST-PRACTICES.md) for detailed explanations of each practice.

#### Robust Changeset Handling

The CI/CD pipeline is designed to handle concurrent PRs gracefully:

- **PR Validation**: Only validates changesets **added by the current PR**, not pre-existing ones from other merged PRs. This prevents false failures when multiple PRs merge before a release cycle completes.

- **Release-time Merging**: If multiple changesets exist when releasing, they are automatically merged into a single changeset with:
  - The highest version bump type (major > minor > patch)
  - All descriptions preserved in chronological order

This design decouples PR validation from the need to pull changes from the default branch, reducing conflicts and ensuring that even if CI/CD fails, all unpublished changesets will still get published when the error is resolved.

### Deploying the example app

The `example-app.yml` workflow deploys the universal example app to GitHub
Pages on every push to `main`. Before the first run on `main` in a new
repository created from this template, open **Settings → Pages** and set
**Source = GitHub Actions**. This is a one-time manual step and cannot be
configured from a workflow because the Pages source defaults to
_Deploy from a branch_. Without it, the `pages-deploy` job fails on
`actions/deploy-pages` with `Get Pages site failed` /
`Failed to create deployment`. After flipping the source, the workflow
provisions the Pages site on its first run.

### Auto-regenerated preview screenshots

The same `example-app.yml` workflow contains a `preview-regen` job that boots
the built example app in a headless Chromium via
[`browser-commander`](https://www.npmjs.com/package/browser-commander) +
Playwright and writes fresh screenshots to
`docs/screenshots/example-app/example-app-{locale}-{theme}.png` on every
push to `main` (and on `workflow_dispatch`). Any drift is committed back to
`main` so README/site images never go stale between releases. Screenshot-only
pushes do not match this workflow's path filter, while a protected-branch
fallback PR remains eligible for its required checks. The job runs in the
official Playwright container with the browser already installed, avoiding CI
stalls from live Chromium downloads.

The same script is available locally:

```bash
npm install --prefix examples/universal-app
npm run example:web:preview-images
# Verbose probe of <html data-theme>, <html lang>, and PNG signatures:
PREVIEW_VERBOSE=1 npm run example:web:preview-images
```

The matrix defaults to `{en, ru} × {light, dark}`. The shipped example app
has no localization or theme toggle yet, so every cell currently renders
the same UI — when a fork adds either, the matrix produces real per-cell
variants without script edits.

### Broken Link Checker

The link checker workflow (`.github/workflows/links.yml`) validates all links in Markdown and HTML files:

1. **Detection**: Uses [lychee](https://github.com/lycheeverse/lychee-action) to scan all `*.md` and `*.html` files
2. **Web Archive fallback**: For any broken links found, automatically checks the [Wayback Machine](https://web.archive.org) for archived versions
3. **Actionable suggestions**: Reports one of three outcomes for each broken link:
   - **Archived**: Suggests the Web Archive URL as a replacement
   - **Not archived**: Clearly reports the link is unrecoverable
4. **Scheduled checks**: Runs weekly to catch links that break over time (even if no files changed)
5. **Issue creation**: On scheduled runs, creates a GitHub Issue with the full broken links report

Add regex patterns to `.lycheeignore` to exclude URLs from checks (e.g., local dev URLs, example.com, known rate-limited sites).

### Scripts Reference

| Script                               | Description                                           |
| ------------------------------------ | ----------------------------------------------------- |
| `bun test --timeout 30000`           | Run tests with Bun and a 30s per-test cap             |
| `npm test`                           | Run tests with Node.js and a 30s per-test cap         |
| `bun run lint`                       | Check code with ESLint                                |
| `bun run lint:fix`                   | Fix ESLint issues automatically                       |
| `bun run format`                     | Format code with Prettier                             |
| `bun run format:check`               | Check formatting without changing files               |
| `bun run check`                      | Run all checks (lint + format)                        |
| `npm run example:web:dev`            | Start the universal app Vite dev server               |
| `npm run example:web:build`          | Build the universal app static web bundle             |
| `npm run example:web:preview-images` | Regenerate preview screenshots via browser-commander  |
| `npm run example:desktop:package`    | Package the Electron desktop app locally              |
| `npm run example:mobile:sync`        | Build and sync the app bundle into Capacitor projects |
| `bun run changeset`                  | Create a new changeset                                |

### Best Practices

The repository implements CI/CD best practices for AI-driven development. See [BEST-PRACTICES.md](docs/BEST-PRACTICES.md) for details on:

- File size limits for AI readability
- Automated formatting and linting
- Multi-runtime and cross-platform testing
- Changeset-based versioning
- Concurrency control for CI/CD pipelines

## Contributing

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for detailed contribution guidelines.

Quick steps:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Create a changeset: `bun run changeset`
5. Commit your changes (pre-commit hooks will run automatically)
6. Push and create a Pull Request

## License

[Unlicense](LICENSE) - Public Domain
