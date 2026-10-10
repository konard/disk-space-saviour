/** Finite CLI signal reproduction; the child finishes naturally after ten seconds. */
import { SCANNERS } from '../../src/scan.js';
import { makeItem } from '../../src/items.js';

SCANNERS.global = async (context) => {
  context.emit(
    makeItem(context.env, {
      rule: 'signal-fixture',
      path: context.options.roots[0],
      bytes: 8192,
    })
  );
  process.stderr.write('fixture ready\n');
  await context.env.run(['node', '-e', 'setTimeout(() => {}, 10000)']);
  return [];
};
