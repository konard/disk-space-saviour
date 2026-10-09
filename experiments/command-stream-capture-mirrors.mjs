// Does command-stream's `.run({ capture: true })` also print the output live?
// publish-to-npm.mjs re-prints the captured output as "Changeset output:",
// which doubles every changeset publish log line if it does.
// Usage: node experiments/command-stream-capture-mirrors.mjs
import { loadCommandStream } from '../scripts/use-module.mjs';

const { $ } = await loadCommandStream();
const result = await $`echo live-line`.run({ capture: true });
console.log(`captured: ${JSON.stringify(result.stdout)}`);
