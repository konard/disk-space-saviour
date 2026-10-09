# Issue 17: active runner packages and unfinished audits

## Incident and cause

The October 8 macOS report used npm's 0.13.1, while main already contained newer
work. Ten Node MCP processes executed scripts under one npx hash. The cleanup
removed the entire 263 MiB `_npx` root, including its own package, then stopped
after 17 of 28 planned entries with `finishedAt: null`. The audit and process
observations are quoted in [the archived issue](data/dss-issue-17.json); no full
original audit attachment was available. Removal and subsequent abort were
observed in sequence, but the report does not prove the exact abort exception.

The old rule selected a cache root and named `npx` as busy, missing interpreter
children named `node`. PR 15 already changed npx to individual hashes. Current
main still needed macOS script-argument evidence, own-installation protection,
equivalent runner rules and audit finalization.

## Every requirement, alternatives and solution

| Requirement                                       | Alternatives and implemented plan                                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protect executable, cwd and open paths            | Runner-name blocking is insufficient. Combine `/proc` or lsof evidence with resolved script paths in command arguments, including macOS process output.                                                    |
| Protect dss itself                                | Ignoring its PID avoids self-interference but loses protection. Protect the package installation path explicitly, including per-path rules.                                                                |
| Per-entry cleanup, idle siblings and explanations | Retain PR 15's hash candidates and skip busy entries with report blockers; remove idle eligible siblings. Remove npm's whole-cache native clean action because it could erase protected `_npx` siblings.   |
| bunx, pnpm dlx and Yarn dlx equivalents           | Extend the existing declarative cache rules with isolated package entries, keeping the same liveness checks.                                                                                               |
| Visible abort and completed partial audit         | SIGINT/SIGTERM use an AbortSignal; cleanup/emergency finalize audit in `finally`. Callback exceptions are recorded with `aborted`, `error` and `finishedAt`, including cancellation during the last entry. |

## Reproduction and coverage

Run `node --test --test-timeout=30000 tests/issue-14-caches.test.js tests/issue-27-processes.test.js tests/issue-27-caches.test.js tests/issue-27-rule-families.test.js`.
Tests supply a Node command referencing a package script, an ignored own PID,
busy/idle entries, runner-family paths, callback failure and last-entry abort.
They failed on the original behavior; the before/after logs are archived in
[issue 27's evidence](../issue-27/README.md). The shared liveness probe applies
to local and shell environments, every scanner and cleanup/emergency rechecks.

Primary component research and alternatives are in the
[aggregate report](../issue-27/README.md#components-and-primary-source-research).
Interpreter runner behavior is expected upstream behavior, so this is a dss
bug rather than a new npm/Bun/Yarn defect. Forced termination such as SIGKILL
cannot execute JavaScript audit finalizers; controlled aborts are covered.
