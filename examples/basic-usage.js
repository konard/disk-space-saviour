/**
 * Basic library usage: scan, print the report, then plan a safe-tier
 * clean as a dry run. Nothing is deleted.
 *
 * Run with: node examples/basic-usage.js [path...]
 */

import { clean, formatAudit, formatReport, scan } from '../src/index.js';

const roots = process.argv.slice(2);

const report = await scan({
  roots: roots.length > 0 ? roots : null,
  docker: false,
  auditDir: null,
});
console.log(formatReport(report));

const audit = await clean(report, {
  tier: 'safe',
  dryRun: true,
  audit: false,
});
console.log(`\n${formatAudit(audit)}`);
