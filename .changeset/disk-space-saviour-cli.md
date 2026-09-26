---
'disk-space-saviour': minor
---

Add `disk-space-saviour` (`dss`): a CLI and library that safely reclaims disk
space. `dss scan` reports caches and build outputs of 20+ ecosystems, version
managers, browser/IDE/AI caches, agent snapshots, system logs and forgotten
projects, and recurses into Docker: host daemons, running containers (scanned
through `docker exec`, never stopped), stopped containers (inspected with
`docker cp`, git-verified, never removed without confirmation) and nested
Docker-in-Docker daemons. `dss clean --tier safe|moderate|aggressive` deletes
with liveness and git re-checks before every item, and `dss emergency --free
20G | --until 80%` escalates tiers until the goal is met. Every run writes a
JSON audit log.

Liveness detection matches tools by executable name as well as process name,
so a Node.js tool whose main thread is renamed (for example `MainThread`) is
still seen as running. A Docker-in-Docker CI job (`npm run test:dind`) checks
recursion two daemons deep, cleaning inside running containers, and the
approval, Git and log-backup rules for stopped containers.

Open files are matched through symlinks (a scan of `/var/...` sees files that
`lsof` reports under `/private/var/...` on macOS), and process working
directories are read with `lsof` on macOS, so a tool running elsewhere does not
block a project it is not using.
