## Problem

Every `npm ci` in `example-app.yml` prints a warning (Build web app, and all three Package desktop app legs):

```
npm warn install-scripts 2 packages have install scripts not yet covered by allowScripts:
npm warn install-scripts   electron-winstaller@5.4.0 (install: node ./script/select-7z-arch.js)
npm warn install-scripts   esbuild@0.25.12 (postinstall: node install.js)
```

On macOS there are 3 packages, with `fsevents@2.3.3` added. Seen in the template's own run [37558225923](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/actions/runs/37558225923). The cause is npm 11.19, bundled with Node.js 24.21, which `node-version: '24.x'` now resolves to. That version warns about every lifecycle script that `allowScripts` in package.json does not cover. The scripts still run, because `strict-allow-scripts` defaults to `false`, so the warning is pure noise that hides real warnings in those jobs.

## Reproduce

```sh
cd examples/universal-app
npx -y npm@11.19 ci --no-audit --no-fund 2>&1 | grep install-scripts
```

## Suggested fix (applied downstream in disk-space-saviour PR 32)

Review the three scripts and approve them by name in `examples/universal-app/package.json`. Leave them unpinned, so routine version bumps need no edit:

```json
"allowScripts": {
  "electron-winstaller": true,
  "esbuild": true,
  "fsevents": true
}
```

Then add a test that lists every lockfile entry with `hasInstallScript: true` and requires each one to have an `allowScripts` decision. A new install script then fails CI instead of adding a warning. See `tests/install-scripts-policy.test.js` in https://github.com/link-foundation/disk-space-saviour/pull/32.
