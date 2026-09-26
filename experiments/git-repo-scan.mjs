// Prints how scan() classifies node_modules in a fresh pushed repository.
import { join } from 'node:path';
import { scan } from '../src/scan.js';
import {
  age,
  fixtureEnv,
  pushedRepo,
  scanInput,
  tempRoot,
  writeBlob,
  DAY_MS,
  removeRoot,
} from '../tests/helpers/fixtures.js';
import { writeFileSync } from 'node:fs';

const root = tempRoot('dss-exp-git-');
const repo = pushedRepo(join(root, 'app'));
writeFileSync(join(repo, 'package.json'), '{}');
writeBlob(join(repo, 'node_modules', 'x', 'index.js'));
age(root, 40 * DAY_MS);
const report = await scan(
  scanInput(fixtureEnv(root), [root], { scanners: ['projects'] })
);
console.log(
  report.items.map((i) => ({
    rule: i.rule,
    tier: i.tier,
    reason: i.reason,
    blockers: i.blockers,
    project: i.project,
  }))
);
removeRoot(root);
