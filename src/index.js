/**
 * disk-space-saviour: safely reclaims disk space on hosts, inside running
 * containers and in nested Docker daemons.
 *
 * - `scan(options) → Report` never deletes anything;
 * - `clean(report, options) → AuditLog` deletes what the tier allows;
 * - `emergency({free, until}) → AuditLog` escalates tiers until the goal
 *   is met.
 */

export { scan, SCANNERS, REPORT_SCHEMA, CONTAINER_ROOTS } from './scan.js';
export {
  clean,
  planItems,
  environmentTotals,
  CONFIRMATION_FLAGS,
} from './clean.js';
export { emergency, goalMet, bytesNeeded, usedPercent } from './emergency.js';
export {
  AUDIT_SCHEMA,
  auditDirectory,
  backupDirectory,
  writeAudit,
} from './audit.js';
export { formatReport, formatAudit, formatDisk } from './report.js';
export { runCli, parseCli, USAGE } from './cli.js';
export { DEFAULTS, resolveOptions, resolveGoal } from './options.js';
export {
  TIERS,
  tierRank,
  tierTotals,
  selectByTier,
  dropNested,
} from './items.js';
export {
  parseSize,
  parseDuration,
  parsePercent,
  formatBytes,
  formatDuration,
} from './units.js';
export { ECOSYSTEMS, PROJECT_RULES, CACHE_RULES } from './rules/ecosystems.js';
export { OTHER_RULES } from './rules/other.js';
export { VERSION_RULES } from './rules/versions.js';
export { analyzeRustProfile, findRustProfiles } from './scanners/rust.js';
export { GitInspector } from './git.js';
export { LivenessProbe } from './liveness.js';
export { LocalEnv } from './env/local.js';
export { ShellEnv } from './env/shell.js';
export { resolveEnvironment } from './env/resolve.js';
export { hostExecutor, containerExecutor, setTrace } from './exec.js';
export { DockerCli, assertAllowed } from './docker/cli.js';
