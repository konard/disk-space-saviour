## Problem

Two gaps in `.github/workflows/workflows.yml`. Both make the job report less than it seems to.

1. **The pedantic pass runs offline.** The step `Audit for pedantic-only high-severity findings` runs `pipx run zizmor==1.30.1 … .github/workflows .github/actions` without a token. Every run logs:
   ```
   WARN audit: zizmor: zizmor is running in offline mode by default; some audits and auto-fixes will not be available
   ```
   (template run [37637246732](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/actions/runs/37637246732), job `zizmor`). The online audits are skipped: `known-vulnerable-actions`, `impostor-commit`, `ref-confusion` and `stale-action-refs`. The regular pass gets a token from `zizmor-action`, but the pedantic pass covers `uses: docker://`/`container:` references that the regular pass does not.
2. **The `paths` filters miss inputs the jobs audit or run.** The filters name only `.github/workflows/**` and `.github/zizmor.yml`. However, the pedantic pass audits `.github/actions` (`publish-dockerhub`, `setup-buildx-resilient`), and the status jobs run scripts from `scripts/`. A pull request that edits only a composite action or one of those scripts therefore skips the checks that cover it. Issue #218 reports the same class of gap for `.github/dependabot.yml`, which derived projects add. That fix belongs in the same list.

## Reproduce

```sh
pipx run zizmor==1.30.1 --config .github/zizmor.yml --persona pedantic \
  --min-severity high --min-confidence high .github/workflows .github/actions 2>&1 | grep offline
GH_TOKEN=$(gh auth token) pipx run zizmor==1.30.1 --config .github/zizmor.yml --persona pedantic \
  --min-severity high --min-confidence high .github/workflows .github/actions 2>&1 | grep -c offline   # 0
```

## Suggested fix (applied downstream in disk-space-saviour PR 32)

```yaml
      - name: Audit for pedantic-only high-severity findings
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          pipx run zizmor==1.30.1 ...
```

Also add `.github/actions/**` and every script that a job in this workflow runs to both `paths` lists. Then derive the expected list from the workflow in a test (`tests/workflows-lint.test.js` downstream), so a new script cannot be forgotten. Measured with zizmor 1.30.1 on template 4973fc4: offline and online both report "No findings to report", so the change restores coverage without adding new failures.
