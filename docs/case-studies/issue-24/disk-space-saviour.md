# Issue 24: full-path globs and pre-traversal exclusions

## Timeline and cause

At October 9 15:43:07 UTC the current-main report showed 88 of 92 items still
under `/tmp/containerd-mount*` after an explicit exclusion. The excluded run
took 264 seconds, exceeding the earlier 232-second scan. Source matched globs
only against each final basename, while literal `isWithin` treated `*` as text;
filtering occurred after the walk. Full details are archived under `data/`.

## Every requirement, alternatives and solution

| Requirement                                | Alternatives and implemented plan                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full-path and all-ancestor glob matching   | Extend existing segment matcher with globstar; test every ancestor. Patterns with separators match full paths; separator-free patterns can match ancestor basenames. Normalize Windows separators/case through the platform path API. |
| Prune before reading excluded directories  | Install a common environment policy before scanner discovery and wrap single/batched list/stat/exists operations. Local and shell usage/walk also apply it.                                                                           |
| Requested four regressions                 | Pin `/tmp/foo*`, `/tmp/foo*/**`, `foo*` and literal `/tmp/foo1` against nested artifacts. Spy on listing to assert excluded roots were never visited.                                                                                 |
| Cleanup never touches excluded descendants | Retain observed excluded paths and reject recursive ancestor deletion. Recheck exclusions discovered during the final usage walk before remove.                                                                                       |
| Every scanner and saved-report path        | Shared policy covers projects, agents, versions, global/direct app paths, system and cleanup; filterItems uses the same semantics.                                                                                                    |
| Evidence/research/upstream                 | Archive issue/comments and failing/passing regressions. Compare Node path.matchesGlob and minimatch in the aggregate research. No upstream glob bug is established; this was dss's matching contract.                                 |

## Components and verification

[Node's path.matchesGlob](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern)
does not meet the package's Node 20 runtime floor. [Minimatch](https://github.com/isaacs/minimatch)
would provide a wider grammar at the cost of a runtime dependency; the selected
change keeps the existing wildcard grammar and adds path/ancestor/globstar
semantics needed here. This does not claim support for all shell extglob or brace
syntax.

Run `node --test --test-timeout=30000 tests/issue-27-boundaries.test.js tests/issue-27-caches.test.js tests/index.test.js`.
Exclusion tests do not need real containerd mounts. Pruning traces are visible
with verbose mode and the tests distinguish correct results from avoiding the
underlying read.

Final review also reproduced shell measurement crossing an excluded descendant:
discovering the path blocked deletion, but the subsequent `du` still walked it.
Shell measurements now omit ancestors containing excluded, mounted or runtime
data before either recursive command runs. A real Linux shell regression covers
zero-depth globstars: `find` does not share JavaScript's optional `**/` semantics.
Its pruning expressions conservatively recognize those boundaries; final item
matching still uses the common path matcher. The finite reproduction is
`node experiments/issue-27-shell-boundaries.mjs`; before/after logs are archived.
