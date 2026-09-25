/**
 * Human-readable rendering of scan reports and audit logs. The JSON forms
 * (`--json`) are the report and audit objects themselves.
 */

import { TIERS } from './items.js';
import { formatBytes } from './units.js';

const DEFAULT_LIMIT = 25;

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function manyEnvironments(report) {
  return new Set(report.items.map((item) => item.env)).size > 1;
}

function pad(text, width) {
  return String(text).padStart(width);
}

function percentUsed(disk) {
  const total = disk.used + disk.free;
  return total > 0 ? Math.round((disk.used / total) * 100) : 0;
}

/**
 * One line describing the free space of a volume.
 */
export function formatDisk(disk, label = '') {
  if (!disk) {
    return `${label}free space unknown`;
  }
  const where = disk.path ? `${disk.path}: ` : '';
  return `${label}${where}${formatBytes(disk.free)} free of ${formatBytes(
    disk.used + disk.free
  )} (${percentUsed(disk)}% used)`;
}

function itemLocation(item) {
  if (item.path) {
    const more = item.paths.length > 1 ? ` (+${item.paths.length - 1})` : '';
    return `${item.path}${more}`;
  }
  return item.description;
}

function itemLine(item, showEnv) {
  const env = showEnv ? `[${item.envLabel}] ` : '';
  const confirm = item.requiresConfirmation
    ? `  (needs --${kebab(item.requiresConfirmation)})`
    : '';
  return `  ${pad(formatBytes(item.bytes), 10)}  ${env}${item.rule}  ${itemLocation(item)}${confirm}`;
}

function kebab(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function limited(lines, limit) {
  if (lines.length <= limit) {
    return lines;
  }
  return [
    ...lines.slice(0, limit),
    `  … ${lines.length - limit} more (use --verbose or --json)`,
  ];
}

function tierSection(report, tier, options) {
  const items = report.items
    .filter((item) => item.tier === tier && item.blockers.length === 0)
    .sort((a, b) => b.bytes - a.bytes);
  if (items.length === 0) {
    return [];
  }
  const showEnv = manyEnvironments(report);
  const bytes = items.reduce((sum, item) => sum + item.bytes, 0);
  return [
    '',
    `${tier.toUpperCase()}  ${plural(items.length, 'item')}, ${formatBytes(bytes)}`,
    ...limited(
      items.map((item) => itemLine(item, showEnv)),
      options.limit
    ),
  ];
}

function blockedSection(report, options) {
  const items = report.items.filter((item) => item.blockers.length > 0);
  if (items.length === 0) {
    return [];
  }
  const lines = [];
  for (const item of items.sort((a, b) => b.bytes - a.bytes)) {
    lines.push(itemLine(item, manyEnvironments(report)));
    for (const blocker of item.blockers) {
      lines.push(`      blocked: ${blocker}`);
    }
  }
  return [
    '',
    `BLOCKED  ${plural(items.length, 'item')} (kept)`,
    ...limited(lines, options.limit * 2),
  ];
}

function repoSummary(repo) {
  if (repo.error) {
    return `${repo.root}: ${repo.error}`;
  }
  const parts = [];
  if (repo.dirty) {
    parts.push(`${repo.dirty} uncommitted`);
  }
  if (repo.unpushed) {
    parts.push(`${repo.unpushed} unpushed`);
  }
  if (repo.stashes) {
    parts.push(`${repo.stashes} stashed`);
  }
  return `${repo.root}: ${parts.length > 0 ? parts.join(', ') : 'clean and pushed'}`;
}

function containerLines(container, stoppedItems) {
  const session = container.owner?.session
    ? `session ${container.owner.session}`
    : 'no session label';
  const scanned = container.scanned ? ', scanned via exec' : '';
  const lines = [
    `  ${container.name} (${container.id.slice(0, 12)}) ${container.state}, ${container.image}, ${formatBytes(container.bytes)} written, ${session}${scanned}`,
  ];
  if (container.note) {
    lines.push(`      ${container.note}`);
  }
  const item = stoppedItems.get(container.id);
  for (const repo of item?.container?.repos ?? []) {
    lines.push(`      git ${repoSummary(repo)}`);
  }
  return lines;
}

function dockerSection(report) {
  const docker = report.docker;
  if (!docker || docker.daemons.length === 0) {
    return [];
  }
  const stoppedItems = new Map(
    report.items
      .filter((item) => item.container)
      .map((item) => [item.container.id, item])
  );
  const lines = ['', 'DOCKER'];
  for (const daemon of docker.daemons) {
    lines.push(
      `  daemon ${daemon.name} (depth ${daemon.depth}, ${daemon.serverVersion}, ${daemon.driver}) via ${daemon.env}`
    );
  }
  for (const container of docker.containers) {
    lines.push(...containerLines(container, stoppedItems));
  }
  for (const hint of docker.hints ?? []) {
    lines.push(
      `  hint ${hint.image}: ${formatBytes(hint.bytes)} layer, ${hint.hint}`
    );
  }
  return lines;
}

function totalsSection(report) {
  const parts = TIERS.map(
    (tier) => `${tier} ${formatBytes(report.totals[tier].bytes)}`
  );
  return [
    '',
    `Reclaimable (cumulative): ${parts.join(' · ')}; blocked ${formatBytes(report.totals.blocked.bytes)}`,
  ];
}

function errorsSection(errors) {
  if (!errors || errors.length === 0) {
    return [];
  }
  return [
    '',
    'ERRORS',
    ...errors.map(
      (error) => `  ${error.env} ${error.scanner}: ${error.message}`
    ),
  ];
}

/**
 * Renders a scan report.
 * @param {object} report
 * @param {{verbose?: boolean}} [options]
 * @returns {string}
 */
export function formatReport(report, options = {}) {
  const limit = options.verbose ? Infinity : DEFAULT_LIMIT;
  const host = report.environments[0];
  const lines = [
    `disk-space-saviour scan of ${host.label} in ${(report.durationMs / 1000).toFixed(1)}s (report only, nothing was deleted)`,
    formatDisk(host.disk),
  ];
  for (const tier of TIERS) {
    lines.push(...tierSection(report, tier, { limit }));
  }
  lines.push(...blockedSection(report, { limit }));
  lines.push(...dockerSection(report));
  lines.push(...errorsSection(report.errors));
  lines.push(...totalsSection(report));
  return lines.join('\n');
}

function entryLine(entry) {
  const bytes =
    entry.status === 'removed' ? entry.freedBytes : entry.plannedBytes;
  const size = entry.status === 'skipped' ? '' : formatBytes(bytes ?? 0);
  const reason = entry.reason ? `  (${entry.reason})` : '';
  const location = entry.path ?? entry.description;
  return `  ${entry.status.padEnd(7)} ${pad(size, 10)}  ${entry.rule}  ${location}${reason}`;
}

function statusCounts(env) {
  return ['removed', 'planned', 'skipped', 'failed']
    .filter((status) => env[status] > 0)
    .map((status) => `${env[status]} ${status}`)
    .join(', ');
}

function environmentLines(environments) {
  return Object.values(environments ?? {}).map(
    (env) =>
      `  ${env.label}: freed ${formatBytes(env.freedBytes)}, left ${formatBytes(env.leftBytes)} (${statusCounts(env)})`
  );
}

function emergencyLines(audit) {
  if (audit.command !== 'emergency') {
    return [];
  }
  const goal = [
    audit.goal.freeBytes === null
      ? null
      : `${formatBytes(audit.goal.freeBytes)} free`,
    audit.goal.untilPercent === null
      ? null
      : `at most ${audit.goal.untilPercent}% used`,
  ]
    .filter(Boolean)
    .join(' and ');
  return [
    `goal: ${goal} on ${audit.path}`,
    formatDisk(audit.diskBefore, 'before: '),
    formatDisk(
      audit.diskAfter,
      audit.dryRun ? 'after (estimated): ' : 'after: '
    ),
    `goal ${audit.goalMet ? 'met' : 'NOT met'}, highest tier used: ${audit.reachedTier ?? 'none'}`,
  ];
}

/**
 * Renders the audit log of `clean` or `emergency`.
 * @param {object} audit
 * @param {{verbose?: boolean}} [options]
 */
export function formatAudit(audit, options = {}) {
  const limit = options.verbose ? Infinity : DEFAULT_LIMIT * 2;
  const mode = audit.dryRun ? 'dry run, nothing was deleted' : 'deleting';
  const shown = options.verbose
    ? audit.entries
    : audit.entries.filter((entry) => entry.status !== 'skipped');
  const hidden = audit.entries.length - shown.length;
  const lines = [
    `disk-space-saviour ${audit.command} (${mode})`,
    ...emergencyLines(audit),
    '',
    ...limited(shown.map(entryLine), limit),
  ];
  if (hidden > 0) {
    lines.push(`  ${hidden} skipped (use --verbose to list them)`);
  }
  lines.push('', 'Per environment:', ...environmentLines(audit.environments));
  lines.push(
    '',
    audit.dryRun
      ? `Would free ${formatBytes(audit.plannedBytes)} (run with --yes to delete)`
      : `Freed ${formatBytes(audit.freedBytes)}`
  );
  if (audit.file) {
    lines.push(`Audit log: ${audit.file}`);
  }
  return lines.join('\n');
}
