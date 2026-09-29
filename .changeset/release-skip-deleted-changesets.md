---
'disk-space-saviour': patch
---

Fix the release job: the formatting check before the release commit no longer
passes the changesets that `changeset version` deleted to prettier, which
failed on the missing files and stopped every release.

The `bin` paths in `package.json` drop the leading `./`, so `npm publish` no
longer warns that the `dss` commands were "invalid and removed" (npm only
normalized them; the commands were always installed).
