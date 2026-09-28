---
'disk-space-saviour': patch
---

Fix the release job: the formatting check before the release commit no longer
passes the changesets that `changeset version` deleted to prettier, which
failed on the missing files and stopped every release.
