# Issue 19: unreleased fixes and silent container filtering

## Timeline, evidence and root causes

The October 9 10:01:47 UTC report tested npm 0.13.1: every in-container item
was blocked and opam 2.6 attempted to operate on a 2.2 root. PR 15 had already
fixed privileged shell inspection and switched opam to guarded directory removal.
The 14:53:51 UTC comment confirmed ID-prefix/exact-name-only filtering and silent
failure for a name prefix. Both issue and comment are archived under `data/`.

Release run 37847771589 failed Deno environment access before publishing.
PR 20 fixed that metadata test. Fresh run 37948829224 then passed Deno but
failed npm PUT with E404 three times. The classifier already knew E404 was
permanent, but the publishing catch retained only a generic rejected-command
message, losing the captured output used by classification. npm `latest` was
still 0.13.1 at this investigation's registry snapshot.

## Every requirement, alternatives and solution

| Requirement                                                | Alternatives and implemented plan                                                                                                                                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deliver the container/opam fixes                           | Preserve already-resolved PR 15 changes and test them alongside the new fixes. Add a minor changeset for the automatic release pipeline.                                                                                         |
| Fix Deno metadata gate                                     | Already resolved by PR 20; verify restricted-permission Deno tests and archived fresh release logs.                                                                                                                              |
| Publish newest fixes or fail loudly                        | Recover error stdout/stderr/result, classify auth/registry failures before retrying, and print publisher owner/repository/workflow/direct-publish-action guidance. No token fallback or unverified successful-publication claim. |
| Optional guarded fallback for failed native cache commands | Not needed for opam: direct cache deletion avoids running an incompatible binary at all. Whole npm native cache clean is removed to preserve active runner packages. Other rule semantics are retained.                          |
| Unique container-name prefixes                             | Exact name or ID match takes priority; then resolve unique ID/name prefixes.                                                                                                                                                     |
| No matching filter must warn/fail                          | Return an explicit report error for zero or ambiguous matches rather than silently target only the host.                                                                                                                         |

## Verification and external authority

Metadata, opam and shell tests cover the existing fixes. `issue-27-details.test.js`
covers prefixes and captured E404, including the command-stream-style rejected
error. Existing publish tests verify classification and failure propagation.
Full logs and original line-numbered excerpts are in
[issue 27 data](../issue-27/README.md#evidence-and-timeline).

[npm's trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/)
supports checking publisher configuration after a transfer, but E404 does not
prove the exact npm-side setting. This environment has no authenticated package
settings session to inspect or change it. The requested loud-failure alternative
is implemented and tested; publication is not claimed. The command-stream API
already exposes diagnostic fields, so the defect was in dss's wrapper and does
not require a separate upstream report.
