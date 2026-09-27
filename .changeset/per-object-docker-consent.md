---
'disk-space-saviour': minor
---

Restore the `cargo-superseded` rule and prune Rust leaf artifacts while cargo runs, keeping library artifacts. `dss clean` watches PID 1, agents and build tools in every environment and stops cleaning it when one of them disappears. Stopped containers show their owning session, task URL, exit code, OOM flag and end time; containers kept for investigation are removed only with `--remove-container ID`. Unused tagged images show size, creation date and last user, and are removed only with `--remove-image REF` or an interactive yes per image; `--remove-unused-images` is rejected.
