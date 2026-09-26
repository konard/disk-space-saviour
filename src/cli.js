/**
 * `dss` command line: scan, clean, emergency and docker subcommands.
 *
 * Deleting needs `--yes`, or an interactive yes on a terminal; without
 * either, `clean` and `emergency` print what they would do (dry run).
 * Every run writes a JSON audit log.
 */

import { promises as fsp, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { URL } from 'node:url';
import { parseArgs } from 'node:util';

import { startAudit, writeAudit } from './audit.js';
import { clean } from './clean.js';
import { emergency } from './emergency.js';
import { setTrace } from './exec.js';
import { resolveGoal } from './options.js';
import { formatAudit, formatReport } from './report.js';
import { scan } from './scan.js';
import { formatBytes } from './units.js';

export const USAGE = `Usage: dss <command> [paths...] [options]

Commands:
  scan [paths...]            Report reclaimable space (never deletes)
  clean [paths...]           Delete what the chosen tier allows
  emergency                  Escalate tiers until a free-space goal is met
  docker scan|clean          Only Docker: daemons, containers, nested daemons
  help, version

Scope:
  --tier safe|moderate|aggressive   clean up to this tier (clean: safe or
                             moderate; emergency: aggressive)
  --docker / --no-docker     require / skip Docker (default: when reachable)
  --depth N                  Docker nesting depth to recurse into (default 3)
  --recursive                docker: recurse into nested daemons
  --container ID|NAME        limit Docker work to these containers (repeat)
  --max-depth N              directory depth for project search (default 6)
  --only NAME                only these ecosystems, rules or kinds (repeat)
  --exclude PATH|GLOB        never touch matching paths (repeat)
  --scanner NAME             projects, global, versions, agents, system
  --min-size SIZE            ignore smaller items (default 1M)
  --older-than AGE           activity window, newer files are kept (1h)
  --inactive AGE             project inactivity for moderate tier (30d)
  --journal-keep SIZE        journald size to keep (512M)

Goals (emergency):
  --free SIZE                at least SIZE available, e.g. 20G
  --until N%                 at most N% used, e.g. 80%
  --path PATH                volume to watch (default /)

Consent:
  -y, --yes                  delete without asking (non-interactive use)
  --dry-run                  never delete, show the plan
  --remove-stopped-containers  allow docker rm of verified stopped containers
  --remove-unused-images     allow removal of unused tagged images
  --include-volumes          list unattached volumes for manual review
  --allow-dirty-repos        allow dirty host repositories (dangerous)
  --allow-dirty-container ID  override verified Git work in this container

Output:
  --json                     print the report or audit log as JSON
  --report FILE              clean: use a report saved by scan --json
  --audit-dir DIR            audit logs ($DSS_AUDIT_DIR)
  --backup-dir DIR           container log backups ($DSS_BACKUP_DIR)
  --verbose                  list everything and trace commands (DSS_DEBUG=1)
  -h, --help, --version`;

const OPTIONS = {
  json: { type: 'boolean' },
  verbose: { type: 'boolean' },
  docker: { type: 'boolean' },
  'no-docker': { type: 'boolean' },
  depth: { type: 'string' },
  recursive: { type: 'boolean' },
  container: { type: 'string', multiple: true },
  'max-depth': { type: 'string' },
  only: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  scanner: { type: 'string', multiple: true },
  'min-size': { type: 'string' },
  'older-than': { type: 'string' },
  'stale-age': { type: 'string' },
  inactive: { type: 'string' },
  'journal-keep': { type: 'string' },
  tier: { type: 'string' },
  free: { type: 'string' },
  until: { type: 'string' },
  path: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
  'remove-stopped-containers': { type: 'boolean' },
  'remove-unused-images': { type: 'boolean' },
  'include-volumes': { type: 'boolean' },
  'allow-dirty-repos': { type: 'boolean' },
  'allow-dirty-container': { type: 'string', multiple: true },
  'no-native': { type: 'boolean' },
  report: { type: 'string' },
  'audit-dir': { type: 'string' },
  'backup-dir': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

const TIER_NAMES = new Set(['safe', 'moderate', 'aggressive']);

class UsageError extends Error {}

function readVersion() {
  const packageUrl = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(packageUrl, 'utf8')).version;
}

function dockerMode(values) {
  if (values['no-docker']) {
    return false;
  }
  return values.docker ? true : null;
}

function integer(value, flag) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function tierOf(values) {
  if (values.tier !== undefined && !TIER_NAMES.has(values.tier)) {
    throw new UsageError(
      `--tier must be safe, moderate or aggressive, got ${values.tier}`
    );
  }
  return values.tier;
}

/**
 * Maps parsed flags to library options.
 * @param {object} values parseArgs values
 * @param {string[]} paths positional roots
 */
export function toOptions(values, paths = []) {
  return {
    roots: paths.length > 0 ? paths : null,
    docker: dockerMode(values),
    dockerDepth: integer(values.depth, '--depth'),
    containers: values.container,
    maxDepth: integer(values['max-depth'], '--max-depth'),
    only: values.only,
    exclude: values.exclude,
    scanners: values.scanner,
    minSize: values['min-size'],
    staleAge: values['older-than'] ?? values['stale-age'],
    inactive: values.inactive,
    journalKeep: values['journal-keep'],
    tier: tierOf(values),
    free: values.free,
    until: values.until,
    path: values.path,
    removeStoppedContainers: values['remove-stopped-containers'],
    removeUnusedImages: values['remove-unused-images'],
    includeVolumes: values['include-volumes'],
    allowDirtyRepos: values['allow-dirty-repos'],
    allowDirtyContainers: values['allow-dirty-container'],
    noNative: values['no-native'],
    auditDir: values['audit-dir'],
    backupDir: values['backup-dir'],
  };
}

/**
 * Splits argv into a command, positionals and flag values.
 * `dss docker scan` becomes command `docker-scan`.
 */
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  let [command = 'help', ...rest] = positionals;
  if (values.version) {
    command = 'version';
  } else if (values.help) {
    command = 'help';
  }
  if (command === 'docker') {
    const [sub = 'scan', ...paths] = rest;
    if (sub !== 'scan' && sub !== 'clean') {
      throw new UsageError(`Unknown docker command: ${sub}`);
    }
    command = `docker-${sub}`;
    rest = paths;
  }
  return { command, paths: rest, values };
}

function dockerOnly(options, values) {
  const nested = values.recursive ? 3 : 1;
  return {
    ...options,
    host: false,
    docker: true,
    dockerDepth: options.dockerDepth ?? nested,
  };
}

/**
 * Summary of a scan for the audit log.
 */
export function scanAudit(report) {
  return startAudit('scan', {
    dryRun: true,
    report: {
      createdAt: report.createdAt,
      durationMs: report.durationMs,
      totals: report.totals,
      environments: report.environments.map((env) => env.id),
      errors: report.errors,
    },
    entries: report.items.map((item) => ({
      id: item.id,
      env: item.env,
      rule: item.rule,
      tier: item.tier,
      path: item.path,
      bytes: item.bytes,
      status: item.blockers.length > 0 ? 'blocked' : 'found',
      reason: item.blockers.join('; ') || item.reason,
    })),
  });
}

/**
 * Terminal I/O used by the CLI; tests pass their own.
 */
export function processIo() {
  return {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async ask(question) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
  };
}

const API = { scan, clean, emergency };

class Cli {
  constructor(io, api) {
    this.io = io;
    this.api = api;
  }

  print(values, json, text) {
    this.io.stdout(values.json ? JSON.stringify(json, null, 2) : text());
  }

  async scan(options, values) {
    const report = await this.api.scan(options);
    const audit = scanAudit(report);
    if (options.audit !== false) {
      await writeAudit(audit, options);
    }
    this.print(values, report, () =>
      [
        formatReport(report, { verbose: values.verbose }),
        `Audit log: ${audit.file ?? 'not written'}`,
        'Run `dss clean --tier safe` to see the plan, add --yes to delete.',
      ].join('\n')
    );
    return 0;
  }

  async loadReport(options, values) {
    if (!values.report) {
      return this.api.scan(options);
    }
    return JSON.parse(await fsp.readFile(values.report, 'utf8'));
  }

  confirmItem() {
    return async (item) => {
      const owner = item.container?.owner?.session
        ? `, session ${item.container.owner.session}`
        : '';
      const answer = await this.io.ask(
        `Remove ${item.description} (${formatBytes(item.bytes)}${owner})? [y/N] `
      );
      return /^y(es)?$/i.test(answer);
    };
  }

  /**
   * Decides between deleting and a dry run, asking on a terminal.
   * @param {(extra: object) => Promise<object>} run
   */
  async consent(values, run) {
    if (values['dry-run']) {
      return run({ dryRun: true });
    }
    if (values.yes) {
      return run({ dryRun: false });
    }
    if (!this.io.interactive) {
      this.io.stderr('Dry run: pass --yes to delete non-interactively.');
      return run({ dryRun: true });
    }
    const plan = await run({ dryRun: true, audit: false });
    this.io.stderr(formatAudit(plan, { verbose: values.verbose }));
    const answer = await this.io.ask('Delete the planned items? [y/N] ');
    if (!/^y(es)?$/i.test(answer)) {
      this.io.stderr('Nothing was deleted.');
      return run({ dryRun: true });
    }
    return run({
      dryRun: false,
      confirm: this.confirmItem(),
      approvedIds: plan.entries
        .filter((entry) => entry.status === 'planned')
        .map((entry) => entry.id),
    });
  }

  async clean(options, values) {
    const report = await this.loadReport(options, values);
    const audit = await this.consent(values, (extra) =>
      this.api.clean(report, { ...options, ...extra })
    );
    this.print(values, audit, () =>
      formatAudit(audit, { verbose: values.verbose })
    );
    return audit.entries.some((entry) => entry.status === 'failed') ? 1 : 0;
  }

  async emergency(options, values) {
    try {
      resolveGoal(options);
    } catch (error) {
      throw new UsageError(error.message);
    }
    const report = await this.loadReport(options, values);
    const audit = await this.consent(values, (extra) =>
      this.api.emergency({ ...options, report, ...extra })
    );
    this.print(values, audit, () =>
      formatAudit(audit, { verbose: values.verbose })
    );
    if (audit.entries.some((entry) => entry.status === 'failed')) {
      return 1;
    }
    return audit.goalMet ? 0 : 3;
  }
}

function dropUndefined(options) {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined)
  );
}

function dispatch(cli, command, options, values) {
  switch (command) {
    case 'scan':
      return cli.scan(options, values);
    case 'clean':
      return cli.clean(options, values);
    case 'emergency':
      return cli.emergency(options, values);
    case 'docker-scan':
      return cli.scan(dockerOnly(options, values), values);
    case 'docker-clean':
      return cli.clean(dockerOnly(options, values), values);
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

/**
 * Runs the CLI.
 * @param {string[]} argv arguments after the program name
 * @param {{io?: object, api?: object}} [deps]
 * @returns {Promise<number>} exit code: 0 ok, 1 error or failed deletion,
 *   2 usage error, 3 emergency goal not met
 */
export async function runCli(argv, deps = {}) {
  const io = deps.io ?? processIo();
  try {
    const { command, paths, values } = parseCli(argv);
    if (command === 'help') {
      io.stdout(USAGE);
      return 0;
    }
    if (command === 'version') {
      io.stdout(readVersion());
      return 0;
    }
    if (values.verbose) {
      setTrace(true);
    }
    const options = dropUndefined(toOptions(values, paths));
    return await dispatch(
      new Cli(io, deps.api ?? API),
      command,
      options,
      values
    );
  } catch (error) {
    io.stderr(`dss: ${error.message}`);
    if (error instanceof UsageError) {
      io.stderr('Run `dss --help` for usage.');
      return 2;
    }
    return 1;
  }
}
