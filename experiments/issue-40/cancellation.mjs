import { scan, SCANNERS } from '../../src/scan.js';
import { makeItem } from '../../src/items.js';
import {
  fixtureEnv,
  tempRoot,
  removeRoot,
  scanInput,
} from '../../tests/helpers/fixtures.js';
const root = tempRoot(),
  env = fixtureEnv(root),
  controller = new AbortController();
SCANNERS.interruptFixture = async (context) => {
  context.emit(makeItem(env, { rule: 'fixture', path: root, bytes: 8192 }));
  setTimeout(() => controller.abort(), 50);
  await context.env.run([process.execPath, '-e', 'setTimeout(()=>{},1000)']);
  return [];
};
try {
  console.log(
    JSON.stringify(
      await scan(
        scanInput(env, [], {
          scanners: ['interruptFixture'],
          signal: controller.signal,
          scanBudget: 5000,
        })
      ),
      null,
      2
    )
  );
} finally {
  removeRoot(root);
}
