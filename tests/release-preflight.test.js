import { describe, expect, it } from 'test-anywhere';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { itUnless, sandboxed } from './helpers/skip.js';

// Spawns processes and writes temporary trees; see tests/helpers/skip.js.
const itFixture = itUnless(sandboxed);

const SCRIPT = 'scripts/preflight-credentials.sh';
// PATH entries are directories, so the stub lives at
// tests/fixtures/preflight-stub/curl and the directory goes on PATH.
const STUB_DIR = 'tests/fixtures/preflight-stub';
const WORKFLOW = readFileSync(
  '.github/workflows/release.yml',
  'utf8'
).replaceAll('\r\n', '\n');

function getJobBlock(workflow, jobName) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);

  if (start === -1) {
    return '';
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[a-zA-Z0-9_-]+:$/.test(line)
  );

  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

const OIDC_URL = 'https://token.actions.githubusercontent.com';

function makeFixtures({
  whoamiStatus = 200,
  postStatus = 202,
  oidcStatus = 200,
  exchangeStatus = 201,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-fixtures-'));
  writeFileSync(join(dir, 'whoami_status'), String(whoamiStatus));
  writeFileSync(join(dir, 'whoami.json'), '{"username":"stub-user"}');
  writeFileSync(join(dir, 'token.json'), '{"token":"stub-registry-token"}');
  writeFileSync(join(dir, 'post_status'), String(postStatus));
  writeFileSync(join(dir, 'oidc_status'), String(oidcStatus));
  writeFileSync(
    join(dir, 'oidc.json'),
    JSON.stringify({ value: 'private-fixture-jwt' })
  );
  writeFileSync(join(dir, 'exchange_status'), String(exchangeStatus));
  writeFileSync(
    join(dir, 'exchange.json'),
    JSON.stringify({ token: 'private-fixture-npm-token' })
  );
  return dir;
}

function runPreflight(env, fixtureDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT], {
      env: {
        ...process.env,
        // The stub prepends itself ahead of the real curl; everything else
        // (notably node, which the script uses for JSON parsing) stays real.
        PATH: `${STUB_DIR}:${process.env.PATH}`,
        PREFLIGHT_FIXTURE_DIR: fixtureDir,
        // Start from a runner-free environment so a developer's own
        // credentials never leak into the probe.
        ACTIONS_ID_TOKEN_REQUEST_URL: '',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-request-token',
        NPM_TOKEN: '',
        DOCKERHUB_IMAGE: '',
        DOCKERHUB_USERNAME: '',
        DOCKERHUB_TOKEN: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

describe('release-preflight workflow wiring (issues #176, #181)', () => {
  it('runs the preflight job before anything can publish', () => {
    expect(WORKFLOW).toContain('  release-preflight:');
    expect(WORKFLOW).toContain('bash scripts/preflight-credentials.sh');
    // The runner only injects ACTIONS_ID_TOKEN_REQUEST_URL when the job may
    // mint OIDC tokens; npm publishes with provenance, so the preflight
    // checks the same envelope the publishing jobs use.
    expect(WORKFLOW).toMatch(
      /release-preflight:[\s\S]*?permissions:[\s\S]*?id-token: write/
    );
  });

  it('probes with a write, not a login', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('/blobs/uploads/');
    expect(script).toContain('-X POST');
    // The opened upload session is cancelled: nothing is stored, no tag moves.
    expect(script).toContain('-X DELETE');
  });

  it('gates every publishing job on an explicit preflight success', () => {
    const releaseBlock = getJobBlock(WORKFLOW, 'release');
    const instantBlock = getJobBlock(WORKFLOW, 'instant-release');
    const dockerConfigBlock = getJobBlock(WORKFLOW, 'docker-publish-config');

    expect(releaseBlock).toContain('        release-preflight,');
    expect(instantBlock).toContain('        release-preflight,');
    expect(dockerConfigBlock).toContain(
      'needs: [release, instant-release, release-preflight]'
    );

    for (const block of [releaseBlock, instantBlock, dockerConfigBlock]) {
      expect(block).toContain("needs.release-preflight.result == 'success'");
    }
  });

  it('fails on main and manual instant releases, reports on pull requests', () => {
    const preflightBlock = getJobBlock(WORKFLOW, 'release-preflight');

    expect(preflightBlock).toContain(
      "github.event_name == 'push' && github.ref == 'refs/heads/main'"
    );
    expect(preflightBlock).toContain(
      "github.event_name == 'workflow_dispatch' && github.event.inputs.release_mode == 'instant'"
    );
    expect(preflightBlock).toContain("&& 'release' || 'report'");
  });

  it('passes the publishing credentials to the probe', () => {
    const preflightBlock = getJobBlock(WORKFLOW, 'release-preflight');

    expect(preflightBlock).not.toContain('NPM_TOKEN');
    expect(preflightBlock).toContain(
      'DOCKERHUB_IMAGE: ${{ vars.DOCKERHUB_IMAGE }}'
    );
    expect(preflightBlock).toContain(
      'DOCKERHUB_USERNAME: ${{ vars.DOCKERHUB_USERNAME }}'
    );
    expect(preflightBlock).toContain(
      'DOCKERHUB_TOKEN: ${{ secrets.DOCKERHUB_TOKEN }}'
    );
  });

  it('keeps the preflight checkout credential-free and observes the job', () => {
    const preflightBlock = getJobBlock(WORKFLOW, 'release-preflight');

    expect(preflightBlock).toContain('persist-credentials: false');

    const statusBlock = getJobBlock(WORKFLOW, 'pipeline-status');
    expect(statusBlock).toContain('- release-preflight');
  });
});

describe('release-preflight probe behaviour (offline, curl stub)', () => {
  // The probe fixtures spawn bash and write outside the sandbox, so a Deno
  // run without -A reports them as skipped.

  itFixture(
    'passes in release mode when OIDC publishing is available',
    async () => {
      const fixtures = makeFixtures();
      const { code, stdout } = await runPreflight(
        { PREFLIGHT_MODE: 'release', ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL },
        fixtures
      );

      expect(code).toBe(0);
      expect(stdout).toContain('npm OIDC package exchange verified');
      const requests = readFileSync(join(fixtures, 'requests'), 'utf8');
      expect(requests).toContain('audience=npm%3Aregistry.npmjs.org');
      expect(requests).toContain('/exchange/package/disk-space-saviour');
      expect(stdout).not.toContain('private-fixture');
    }
  );

  itFixture(
    'fails in release mode when there is nothing to publish with',
    async () => {
      const fixtures = makeFixtures();
      const { code, stdout } = await runPreflight(
        { PREFLIGHT_MODE: 'release' },
        fixtures
      );

      expect(code).toBe(1);
      expect(stdout).toContain('::error::');
      expect(stdout).toContain('npm has no publish path');
    }
  );

  itFixture(
    'passes in report mode when there is nothing to publish with',
    async () => {
      const fixtures = makeFixtures();
      const { code, stdout } = await runPreflight(
        { PREFLIGHT_MODE: 'report' },
        fixtures
      );

      expect(code).toBe(0);
      expect(stdout).toContain('::warning::');
      expect(stdout).toContain('Report mode');
    }
  );

  itFixture(
    'verifies the Docker Hub write when the registry accepts it',
    async () => {
      const fixtures = makeFixtures({ postStatus: 202 });
      const { code, stdout } = await runPreflight(
        {
          PREFLIGHT_MODE: 'release',
          ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
          DOCKERHUB_IMAGE: 'acme/widget',
          DOCKERHUB_USERNAME: 'acme',
          DOCKERHUB_TOKEN: 'stub',
        },
        fixtures
      );

      expect(code).toBe(0);
      expect(stdout).toContain('accepted a blob-upload write for acme/widget');
    }
  );

  itFixture(
    'fails in release mode when Docker Hub refuses the write',
    async () => {
      const fixtures = makeFixtures({ postStatus: 403 });
      const { code, stdout } = await runPreflight(
        {
          PREFLIGHT_MODE: 'release',
          ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
          DOCKERHUB_IMAGE: 'acme/widget',
          DOCKERHUB_USERNAME: 'acme',
          DOCKERHUB_TOKEN: 'stub',
        },
        fixtures
      );

      expect(code).toBe(1);
      expect(stdout).toContain('::error::');
      expect(stdout).toContain('refused the write for acme/widget (403)');
    }
  );

  itFixture('never blocks a pull request on a refused credential', async () => {
    const fixtures = makeFixtures({ postStatus: 403 });
    const { code, stdout } = await runPreflight(
      {
        PREFLIGHT_MODE: 'report',
        ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
        DOCKERHUB_IMAGE: 'acme/widget',
        DOCKERHUB_USERNAME: 'acme',
        DOCKERHUB_TOKEN: 'stub',
      },
      fixtures
    );

    expect(code).toBe(0);
    expect(stdout).toContain('::warning::');
    expect(stdout).toContain('refused the write for acme/widget (403)');
  });

  itFixture(
    'records a rate-limited probe as unknown and holds the release',
    async () => {
      const fixtures = makeFixtures({ postStatus: 429 });
      const { code, stdout } = await runPreflight(
        {
          PREFLIGHT_MODE: 'release',
          ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
          DOCKERHUB_IMAGE: 'acme/widget',
          DOCKERHUB_USERNAME: 'acme',
          DOCKERHUB_TOKEN: 'stub',
        },
        fixtures
      );

      // A 429 has not said the credential is broken, so it is UNKNOWN, not
      // FAIL -- but a release must not run on an unproven credential either.
      expect(code).toBe(1);
      expect(stdout).toContain(
        'UNKNOWN: Docker Hub rate-limited the write probe (429)'
      );
      expect(stdout).not.toContain('FAIL: Docker Hub');
    }
  );

  itFixture(
    'fails in release mode when an npm token secret is present',
    async () => {
      const fixtures = makeFixtures();
      const { code, stdout } = await runPreflight(
        {
          PREFLIGHT_MODE: 'release',
          ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
          NPM_TOKEN: 'stub-token',
        },
        fixtures
      );

      expect(code).toBe(1);
      expect(stdout).toContain('::error::');
      expect(stdout).toContain(
        'npm publishes only through trusted publishing -- delete the secret'
      );
    }
  );

  itFixture(
    'fails in release mode without the OIDC permission npm needs',
    async () => {
      // npm publishes only through trusted publishing, so a job without
      // id-token: write has no way to publish at all.
      const fixtures = makeFixtures();
      const { code, stdout } = await runPreflight(
        { PREFLIGHT_MODE: 'release' },
        fixtures
      );

      expect(code).toBe(1);
      expect(stdout).toContain('::error::');
      expect(stdout).toContain('npm has no publish path');
    }
  );
});

describe('npm OIDC package exchange', () => {
  itFixture(
    'fails in release mode when npm rejects the trusted publisher (404)',
    async () => {
      // A trusted publisher naming another repository (for example the owner
      // before a repository transfer) makes every publish end in
      // `404 Not Found - PUT`; the preflight must report it before the build.
      const fixtures = makeFixtures({ exchangeStatus: 404 });
      const { code, stdout } = await runPreflight(
        { PREFLIGHT_MODE: 'release', ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL },
        fixtures
      );

      expect(code).toBe(1);
      expect(stdout).toContain('::error::');
      expect(stdout).toContain('npm refused the OIDC package exchange (404)');
      expect(stdout).not.toContain('PASS: npm');
    }
  );

  itFixture(
    'only warns on a pull request when npm rejects the trusted publisher',
    async () => {
      const fixtures = makeFixtures({ exchangeStatus: 404 });
      const { code, stdout } = await runPreflight(
        { PREFLIGHT_MODE: 'report', ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL },
        fixtures
      );

      expect(code).toBe(0);
      expect(stdout).toContain('::warning::');
      expect(stdout).toContain('npm refused the OIDC package exchange (404)');
    }
  );

  for (const exchangeStatus of [401, 403, 404, 429, 500, 0]) {
    itFixture(
      `does not let a Docker Hub pass hide npm exchange status ${exchangeStatus}`,
      async () => {
        const fixtures = makeFixtures({ exchangeStatus });
        const { code, stdout } = await runPreflight(
          {
            PREFLIGHT_MODE: 'release',
            ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
            DOCKERHUB_IMAGE: 'acme/widget',
            DOCKERHUB_USERNAME: 'acme',
            DOCKERHUB_TOKEN: 'stub',
          },
          fixtures
        );

        expect(code).toBe(1);
        expect(stdout).not.toContain('npm OIDC package exchange verified');
        expect(stdout).not.toContain('private-fixture');
      }
    );
  }

  for (const body of ['invalid JSON', '{}', '{"token":42}', '{"token":""}']) {
    itFixture(`rejects a malformed npm exchange body ${body}`, async () => {
      const fixtures = makeFixtures();
      writeFileSync(join(fixtures, 'exchange.json'), body);
      const { code, stdout } = await runPreflight(
        { PREFLIGHT_MODE: 'release', ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL },
        fixtures
      );

      expect(code).toBe(1);
      expect(stdout).not.toContain('npm OIDC package exchange verified');
    });
  }

  itFixture('never sends a malformed GitHub OIDC answer to npm', async () => {
    const fixtures = makeFixtures();
    writeFileSync(join(fixtures, 'oidc.json'), '{}');
    const { code } = await runPreflight(
      { PREFLIGHT_MODE: 'release', ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL },
      fixtures
    );

    expect(code).toBe(1);
    expect(readFileSync(join(fixtures, 'requests'), 'utf8')).not.toContain(
      '/exchange/'
    );
  });

  itFixture(
    'treats an unanswered GitHub OIDC request as unknown and blocks a release',
    async () => {
      const fixtures = makeFixtures({ oidcStatus: 503 });
      const { code, stdout } = await runPreflight(
        { PREFLIGHT_MODE: 'release', ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL },
        fixtures
      );

      expect(code).toBe(1);
      expect(stdout).toContain(
        'UNKNOWN: GitHub OIDC token request answered 503'
      );
    }
  );

  itFixture('rejects a missing GitHub request token', async () => {
    const fixtures = makeFixtures();
    const { code, stdout } = await runPreflight(
      {
        PREFLIGHT_MODE: 'release',
        ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
      },
      fixtures
    );

    expect(code).toBe(1);
    expect(stdout).toContain('ACTIONS_ID_TOKEN_REQUEST_TOKEN is not set');
  });
});
