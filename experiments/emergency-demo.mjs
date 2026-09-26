// Dry-run emergency mode on this machine: escalates tiers until the goal
// is met (simulated for dry runs). Usage: node experiments/emergency-demo.mjs 5G
import { emergency } from '../src/emergency.js';

const audit = await emergency({
  free: process.argv[2] ?? '1T',
  dryRun: true,
  docker: false,
  auditDir: '/tmp/dss-emergency-audit',
});
for (const entry of audit.entries) {
  console.log(
    entry.status.padEnd(8),
    entry.tier.padEnd(10),
    entry.rule,
    entry.plannedBytes,
    entry.reason ?? ''
  );
}
console.log({
  goal: audit.goal,
  reachedTier: audit.reachedTier,
  goalMet: audit.goalMet,
  before: audit.diskBefore,
  after: audit.diskAfter,
  file: audit.file,
});
