# Issue 40 work plan

- [x] Verify prepared branch and clean working tree; read repository contribution rules.
- [x] Read parent and every sub-issue, all issue comments and all three PR comment types.
- [x] Preserve source issue data and available logs under each requested case-study folder; retain inherited template case studies.
- [x] Research primary Docker, Linux, Node.js and toolchain documentation; compare related recent PRs and existing components.
- [x] Record every requirement, timeline, root cause, alternatives and implementation/test plan for issues 33–40.
- [x] Add failing regressions before each independently useful implementation step.
- [x] Fix audit persistence (39), namespace health checks (37), cache rules/configured roots (36), containerd accounting (35), scan cancellation (34), batched remote scanning/budgets/progress (33), and permission-aware liveness/blocked sizes (38).
- [x] Apply cross-cutting fixes to local, remote, nested Docker, clean/emergency pre-scans, report output and public types.
- [x] Keep experiments bounded; retain executable repro scripts in experiments; save large check output to files.
- [x] Run focused tests and all local CI checks before atomic commits; add a release changeset rather than manually changing version.
- [x] Review complete PR diff for regressions and unchanged safety boundaries; merge latest main into prepared branch if needed.
- [ ] Push only issue-40-bcb1f5ac3122; replace PR title/body with concrete reproduction, tests, limitations and separate Fixes references for all eight issues.
- [ ] Inspect latest CI run timestamps/SHAs; preserve/analyze failed logs, fix verified failures, repeat required checks.
- [ ] Mark PR 41 ready; verify passing checks, clean tree, final code/test/docs consistency and no unfinished background work.
