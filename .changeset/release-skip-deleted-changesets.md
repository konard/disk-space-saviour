---
'disk-space-saviour': patch
---

Fix the release job: the formatting check before the release commit no longer
passes the changesets that `changeset version` deleted to prettier, which
failed on the missing files and stopped every release.

The `bin` paths in `package.json` drop the leading `./`, so `npm publish` no
longer warns that the `dss` commands were "invalid and removed" (npm only
normalized them; the commands were always installed).

Report fixes from #7: `dss docker scan` lists a layer shared by several
images and tags once, with every tag on one line; the summary counts items
that need `--remove-image` or another explicit consent as `needs explicit
consent` instead of adding them to the tier totals; and a container is no
longer labelled with a session taken from a counter or flag such as `1`.
