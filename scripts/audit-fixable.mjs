#!/usr/bin/env node

/**
 * Fails the npm audit gate only on advisories an upgrade can fix.
 *
 * `npm audit --audit-level=high` also fails on advisories that no published
 * version fixes yet, which nobody can act on. This script runs the audit on
 * the lock file of the current directory and, for every high or critical
 * advisory, asks the registry whether a version newer than the installed one
 * lies outside the vulnerable range:
 * - fixable: printed as an error, exit code 1 (upgrade to that version);
 * - not fixable yet: printed as a warning, the gate passes.
 *
 * Usage (in the directory holding package-lock.json):
 *   node scripts/audit-fixable.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BLOCKING = new Set(['high', 'critical']);

function npmJson(args) {
  try {
    const output = execFileSync('npm', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.trim() ? JSON.parse(output) : null;
  } catch (error) {
    // npm audit exits non-zero when it finds advisories; its stdout is the report.
    if (error.stdout?.trim()) {
      return JSON.parse(error.stdout);
    }
    return null;
  }
}

// A range no version matches comes back as `{"error": ...}`.
const asList = (value) =>
  value === null || value.error ? [] : Array.isArray(value) ? value : [value];

/** `npm view <name>@<range> version --json`: the published versions in a range. */
export function registryVersions(name, range) {
  return asList(npmJson(['view', `${name}@${range}`, 'version', '--json']));
}

/**
 * Orders release versions (`major.minor.patch`, as range lookups return them;
 * the registry lists them in publish order, so a backport can follow a newer
 * major).
 */
export function compareVersions(left, right) {
  const parts = (version) => version.split(/[.+-]/).slice(0, 3).map(Number);
  const [a, b] = [parts(left), parts(right)];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Blocking advisories of an `npm audit --json` report, one per advisory URL. */
export function blockingAdvisories(report) {
  const advisories = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via) {
      if (typeof via === 'object' && BLOCKING.has(via.severity)) {
        advisories.set(via.url, via);
      }
    }
  }
  return [...advisories.values()];
}

/** Versions of a package the lock file installs. */
export function installedVersions(lock, name) {
  const suffix = `node_modules/${name}`;
  return [
    ...new Set(
      Object.entries(lock.packages ?? {})
        .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
        .map(([, entry]) => entry.version)
    ),
  ];
}

/**
 * The closest version newer than every installed one that is outside the
 * advisory's vulnerable range (so an upgrade within the same major wins over
 * the latest release), or null when the registry has none yet.
 */
export function fixedVersion(
  advisory,
  installed,
  versionsIn = registryVersions
) {
  const [first = [], ...rest] = installed.map((version) =>
    versionsIn(advisory.name, `>${version}`)
  );
  const newer = first.filter((version) =>
    rest.every((versions) => versions.includes(version))
  );
  const vulnerable = new Set(versionsIn(advisory.name, advisory.range));
  return (
    newer
      .filter((version) => !vulnerable.has(version))
      .sort(compareVersions)[0] ?? null
  );
}

/** Splits blocking advisories into fixable and not yet fixable ones. */
export function classify(report, lock, versionsIn = registryVersions) {
  const fixable = [];
  const unfixable = [];
  for (const advisory of blockingAdvisories(report)) {
    const installed = installedVersions(lock, advisory.name);
    const fix = fixedVersion(advisory, installed, versionsIn);
    (fix ? fixable : unfixable).push({ ...advisory, installed, fix });
  }
  return { fixable, unfixable };
}

function describe(advisory) {
  return `${advisory.name}@${advisory.installed.join(', ')} (${advisory.severity}, ${advisory.range}): ${advisory.title} ${advisory.url}`;
}

function main() {
  const report = npmJson(['audit', '--package-lock-only', '--json']);
  if (!report?.vulnerabilities) {
    console.error('npm audit produced no report');
    process.exit(1);
  }
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const { fixable, unfixable } = classify(report, lock);
  for (const advisory of unfixable) {
    console.log(
      `::warning::No fixed release yet, not blocking: ${describe(advisory)}`
    );
  }
  for (const advisory of fixable) {
    console.log(
      `::error::Fixed in ${advisory.name}@${advisory.fix}, upgrade: ${describe(advisory)}`
    );
  }
  console.log(
    `${fixable.length} fixable and ${unfixable.length} not yet fixable high or critical advisories`
  );
  process.exit(fixable.length > 0 ? 1 : 0);
}

const entry = process.argv[1];
if (
  entry &&
  realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
