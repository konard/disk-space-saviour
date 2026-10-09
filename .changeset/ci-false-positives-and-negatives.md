---
'disk-space-saviour': patch
---

Fix CI/CD false positives, false negatives, warnings and errors: release-preflight now proves npm trusted publishing with the OIDC package exchange, releases wait for every check (including the Docker-in-Docker job) and refuse to run after a failed or cancelled job, registry verification tolerates CDN lag, PR guards compare against a verified merge base, and audit findings are cleared by upgrading Changesets, jscpd and lint-staged.
