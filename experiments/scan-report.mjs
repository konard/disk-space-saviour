// Runs the full scan() and prints a summary (or the JSON report with --json).
// Usage: node experiments/scan-report.mjs [--json] [--no-docker] [root...]
import { scan } from '../src/scan.js';
import { formatBytes } from '../src/units.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const docker = args.includes('--no-docker') ? false : null;
const roots = args.filter((arg) => !arg.startsWith('--'));
const report = await scan({ roots, docker });
if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const item of report.items) {
    const blocked = item.blockers.length ? ` BLOCKED: ${item.blockers[0]}` : '';
    console.log(
      `${item.tier.padEnd(10)} ${formatBytes(item.bytes).padStart(10)} ${item.envLabel.padEnd(30)} ${item.rule.padEnd(24)} ${item.path ?? item.target ?? ''}${blocked}`
    );
  }
  console.log(report.totals, report.errors, `${report.durationMs}ms`);
}
