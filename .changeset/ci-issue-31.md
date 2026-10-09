---
'disk-space-saviour': patch
---

Fix the remaining CI/CD false positives, false negatives and warnings: tests that cannot run on a runner are reported as skipped with the reason instead of passing vacuously or vanishing from the summary, the Deno leg runs with `-A --parallel`, the pedantic zizmor pass runs online and triggers on every file it reads, jscpd 5 receives the comment-skipping setting it understands, the example app reviews its locked install scripts, and release logs no longer warn about `deno.lock` or print the changeset publish output twice.
