---
'disk-space-saviour': patch
---

Release: npm publishes only through trusted publishing. The workflow no longer reads an `NPM_TOKEN` secret, the credential preflight requires the OIDC permission and flags any npm token, and the first-publish guidance points to package-registry-manager instead of a token.
