---
'disk-space-saviour': patch
---

Fix CI/CD false positives, false negatives, warnings and errors: release-preflight now proves npm trusted publishing with the OIDC package exchange, releases wait for every check (including the Docker-in-Docker job) and refuse to run after a failed or cancelled job, registry verification tolerates CDN lag, PR guards compare against a verified merge base, audit findings are cleared by upgrading Changesets, jscpd and lint-staged, and non-blocking advisories are reported as a notice. Runner images and workflow tools are pinned, CodeQL scans only shipped code, a missing GitHub release is recovered for a version already on npm, the link checker re-checks transient failures and no longer warns about an empty HTML glob, deno.lock is kept in step with package.json, and skipped tests name the real reason.
