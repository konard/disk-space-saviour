## Problem

`scripts/publish-to-npm.mjs` prints the whole `changeset publish` output twice, so each release log reads like two publishes:

```
> disk-space-saviour@0.15.1 changeset:publish
> changeset publish
🦋 changeset v3.0.3
These packages will be published as they were not found in the registry:
disk-space-saviour@0.15.1
◇  Successfully published:
disk-space-saviour@0.15.1
◇  Created git tags.
Changeset output:
> disk-space-saviour@0.15.1 changeset:publish
> changeset publish
🦋 changeset v3.0.3
These packages will be published as they were not found in the registry:
disk-space-saviour@0.15.1
◇  Successfully published:
disk-space-saviour@0.15.1
◇  Created git tags.
```

(downstream run [37987850798](https://github.com/link-foundation/disk-space-saviour/actions/runs/37987850798), attempt 2, job Release, step "Publish to npm"). While a publish incident is being investigated, "published, tags created" appearing twice is misleading.

The cause: command-stream's `.run({ capture: true })` captures the output **and** mirrors it live (mirroring is on by default). `analyzePublishResult` then prints the captured copy again:

```js
// Log the output for debugging
if (combinedOutput.trim()) {
  console.log('Changeset output:', combinedOutput);
}
```

The template's `scripts/publish-to-npm.mjs` has the same lines (line 178 on `main`).

## Reproduce

```js
// node repro.mjs, from the template root
import { loadCommandStream } from './scripts/use-module.mjs';
const { $ } = await loadCommandStream();
const result = await $`echo live-line`.run({ capture: true });
console.log(`captured: ${JSON.stringify(result.stdout)}`);
// live-line
// captured: "live-line\n"
```

## Workaround

Read only the first copy of the output.

## Suggested fix (applied downstream in disk-space-saviour PR 32)

Drop the re-print. `combinedOutput` is still needed for `detectPublishFailure`:

```js
// No need to print combinedOutput: command-stream mirrored it live.
```

A static test keeps it out: `expect(publishScript).not.toContain("console.log('Changeset output:'")`. Commit: https://github.com/link-foundation/disk-space-saviour/commit/3f3f3d5
