// Reproduces the Deno failure of command-stream loaded through use-m (esm.sh
// build): createRequire('shelljs') throws because Deno wants a file URL.
// Usage: deno run -A experiments/deno-use-m-probe.mjs
import { loadCommandStream } from '../scripts/use-module.mjs';

try {
  const commandStream = await loadCommandStream();
  console.log('loaded, typeof $ =', typeof commandStream.$);
} catch (error) {
  console.log('code:', error?.code);
  console.log('message:', error?.message);
  console.log(error?.stack);
}
