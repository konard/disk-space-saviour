import { describe, it, expect } from 'test-anywhere';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const workflowPath = '.github/workflows/security.yml';
const probePath = 'scripts/check-dependency-graph.sh';
const canRunBash =
  typeof Deno === 'undefined' &&
  typeof process !== 'undefined' &&
  process.platform !== 'win32';
const workflow = existsSync(workflowPath)
  ? readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n')
  : '';

function getJobBlock(jobName) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);

  if (start === -1) {
    return '';
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[a-zA-Z0-9_-]+:\s*$/.test(line)
  );

  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

function listPackageLocks(directory = '.') {
  const locks = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      locks.push(...listPackageLocks(path));
    } else if (entry.name === 'package-lock.json') {
      locks.push(relative('.', path).replaceAll('\\', '/'));
    }
  }

  return locks.sort();
}

/**
 * Run the dependency graph probe against a curl stub that answers with the
 * given HTTP status and body, and return what the step would report.
 * @param {{status: string, body: string}} response
 */
function runProbe({ status, body }) {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-graph-'));
  try {
    const stub = join(dir, 'curl');
    writeFileSync(join(dir, 'body'), body);
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\nprintf '%s' "$*" > "${dir}/args"\ncat "${dir}/body"\nprintf '\\n${status}'\n`
    );
    chmodSync(stub, 0o755);
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', [probePath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_TOKEN: 'stub-token',
        GITHUB_API_URL: 'https://api.example.test',
        GITHUB_SERVER_URL: 'https://example.test',
        GITHUB_OUTPUT: output,
        REPOSITORY: 'acme/widget',
        BASE_SHA: 'base123',
        HEAD_SHA: 'head456',
      },
    });
    return {
      code: result.status,
      stdout: result.stdout,
      output: readFileSync(output, 'utf8'),
      args: readFileSync(join(dir, 'args'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('security workflow', () => {
  it('runs on main pushes, pull requests, weekly schedules, and manual dispatches', () => {
    expect(existsSync(workflowPath)).toBe(true);
    expect(workflow).toContain('  push:\n    branches: [main]');
    expect(workflow).toContain('  pull_request:');
    expect(workflow).toContain("    - cron: '0 6 * * 1'");
    expect(workflow).toContain('  workflow_dispatch:');
  });

  it('analyzes JavaScript and GitHub Actions with CodeQL', () => {
    const codeql = getJobBlock('codeql');

    expect(codeql).toContain('    timeout-minutes: 30');
    expect(codeql).toContain(
      '      group: check-${{ github.workflow }}-${{ github.ref }}-codeql-${{ matrix.language }}\n      cancel-in-progress: true'
    );
    expect(codeql).toContain(
      '        language: [javascript-typescript, actions]'
    );
    expect(codeql).toContain('      actions: read');
    expect(codeql).toContain('      security-events: write');
    expect(codeql).toContain('uses: actions/checkout@v6');
    expect(codeql).toContain('uses: github/codeql-action/init@v4');
    expect(codeql).toContain('languages: ${{ matrix.language }}');
    expect(codeql).toContain('uses: github/codeql-action/autobuild@v4');
    expect(codeql).toContain('uses: github/codeql-action/analyze@v4');
  });

  it('rejects high-severity dependency changes only on pull requests', () => {
    const dependencyReview = getJobBlock('dependency-review');

    expect(dependencyReview).toContain(
      "    if: github.event_name == 'pull_request'"
    );
    expect(dependencyReview).toContain('    timeout-minutes: 10');
    expect(dependencyReview).toContain(
      '      group: check-${{ github.workflow }}-${{ github.ref }}-dependency-review\n      cancel-in-progress: true'
    );
    expect(dependencyReview).toContain('      pull-requests: write');
    expect(dependencyReview).toContain(
      'uses: actions/dependency-review-action@v5'
    );
    expect(dependencyReview).toContain('          fail-on-severity: high');
    expect(dependencyReview).toContain(
      '          comment-summary-in-pr: on-failure'
    );
  });

  it('runs the dependency review only when the dependency graph answers', () => {
    const dependencyReview = getJobBlock('dependency-review');
    const probe = dependencyReview.indexOf(`run: bash ${probePath}`);
    const review = dependencyReview.indexOf(
      'uses: actions/dependency-review-action@v5'
    );

    expect(probe).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(probe);
    expect(dependencyReview).toContain('        id: dependency-graph');
    expect(dependencyReview).toContain(
      "        if: steps.dependency-graph.outputs.available == 'true'"
    );
    expect(dependencyReview).toContain(
      '          BASE_SHA: ${{ github.event.pull_request.base.sha }}'
    );
    expect(dependencyReview).toContain(
      '          HEAD_SHA: ${{ github.event.pull_request.head.sha }}'
    );
  });

  it('fails closed on high-severity advisories in every npm lock', () => {
    const audit = getJobBlock('npm-audit');
    const directoryList = audit.match(/directory: \[([^\]]+)\]/)?.[1] ?? '';
    const auditedLocks = directoryList
      .split(',')
      .map((directory) => directory.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
      .map((directory) =>
        directory === '.'
          ? 'package-lock.json'
          : `${directory}/package-lock.json`
      )
      .sort();

    expect(auditedLocks).toEqual(listPackageLocks());
    expect(audit).toContain('    timeout-minutes: 10');
    expect(audit).toContain('uses: actions/setup-node@v6');
    expect(audit).toContain('node-version: 24');
    expect(audit).toContain('working-directory: ${{ matrix.directory }}');
    expect(audit).toContain(
      'run: npm audit --package-lock-only --audit-level=high'
    );
  });
});

describe('dependency graph probe', () => {
  if (!canRunBash) {
    it('is skipped where bash is unavailable', () => {});
    return;
  }

  it('asks the compare API for the pull request range', () => {
    const { args } = runProbe({ status: '200', body: '[]' });

    expect(args).toContain(
      'https://api.example.test/repos/acme/widget/dependency-graph/compare/base123...head456'
    );
    expect(args).toContain('Authorization: Bearer stub-token');
  });

  it('enables the review when the dependency graph answers', () => {
    const result = runProbe({ status: '200', body: '[]' });

    expect(result.code).toBe(0);
    expect(result.output).toBe('available=true\n');
  });

  it('skips the review with a warning when the dependency graph is disabled', () => {
    const result = runProbe({
      status: '403',
      body: '{"message":"Forbidden","status":"403"}',
    });

    expect(result.code).toBe(0);
    expect(result.output).toBe('available=false\n');
    expect(result.stdout).toContain(
      '::warning title=Dependency review skipped::'
    );
    expect(result.stdout).toContain(
      'https://example.test/acme/widget/settings/security_analysis'
    );
  });

  it('fails on a rate-limited 403, which says nothing about the setting', () => {
    const result = runProbe({
      status: '403',
      body: '{"message":"API rate limit exceeded for installation."}',
    });

    expect(result.code).toBe(1);
    expect(result.output).toBe('');
    expect(result.stdout).toContain(
      '::error title=Dependency graph probe failed::'
    );
  });

  it('fails on any other answer, on one annotation line', () => {
    for (const status of ['404', '500', '000']) {
      const result = runProbe({
        status,
        body: '{\n  "message": "Not Found"\n}\n',
      });

      expect(result.code).toBe(1);
      expect(result.output).toBe('');
      const [annotation] = result.stdout.split('\n');
      expect(annotation).toContain(`answered HTTP ${status}:`);
      expect(annotation).toContain('"message": "Not Found"');
    }
  });
});
