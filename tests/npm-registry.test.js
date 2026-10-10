import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';

import {
  buildPackageMetadataUrl,
  isPackageVersionPublished,
} from '../scripts/npm-registry.mjs';

function jsonResponse(status, body, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async json() {
      return body;
    },
  };
}

describe('npm registry package version checks', () => {
  it('builds npm registry metadata URLs for scoped packages', () => {
    expect(buildPackageMetadataUrl('@scope/real-package')).toBe(
      'https://registry.npmjs.org/@scope%2Freal-package'
    );
  });

  it('returns true when package metadata contains the requested version', async () => {
    let request;
    const isPublished = await isPackageVersionPublished(
      '@scope/real-package',
      '1.2.3',
      {
        fetchFn: async (url, options) => {
          request = { url, options };
          return jsonResponse(200, { version: '1.2.3' });
        },
      }
    );

    expect(isPublished).toBe(true);
    expect(request.url).toContain('@scope%2Freal-package/1.2.3?_=');
    expect(request.options.headers['cache-control']).toBe('no-cache');
  });

  it('returns false for missing versions without throwing', async () => {
    const isPublished = await isPackageVersionPublished(
      '@scope/real-package',
      '9.9.9',
      {
        fetchFn: async () => jsonResponse(200, { version: '1.2.3' }),
      }
    );

    expect(isPublished).toBe(false);
  });

  it('asks the registry for an uncached answer every time', async () => {
    const requests = [];
    await isPackageVersionPublished('@scope/real-package', '1.2.3', {
      now: () => 42,
      fetchFn: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(200, { version: '1.2.3' });
      },
    });

    expect(requests[0].url).toBe(
      'https://registry.npmjs.org/@scope%2Freal-package/1.2.3?_=42'
    );
    expect(requests[0].init.cache).toBe('no-store');
    expect(requests[0].init.headers['cache-control']).toBe('no-cache');
  });

  it('treats package 404 as an expected unpublished result', async () => {
    const isPublished = await isPackageVersionPublished(
      '@scope/missing-package',
      '1.0.0',
      {
        fetchFn: async () => jsonResponse(404, {}, 'Not Found'),
      }
    );

    expect(isPublished).toBe(false);
  });

  it('throws for unexpected registry failures', async () => {
    let errorMessage = '';

    try {
      await isPackageVersionPublished('@scope/real-package', '1.2.3', {
        fetchFn: async () => jsonResponse(500, {}, 'Server Error'),
      });
    } catch (error) {
      errorMessage = error.message;
    }

    expect(errorMessage).toContain('500 Server Error');
  });
});

describe('release npm registry usage', () => {
  it('does not shell out to npm view for expected missing package versions', () => {
    const publishScript = readFileSync('scripts/publish-to-npm.mjs', 'utf8');
    const releaseCheckScript = readFileSync(
      'scripts/check-release-needed.mjs',
      'utf8'
    );

    expect(publishScript).not.toContain('npm view');
    expect(releaseCheckScript).not.toContain('npm view');
  });

  it('prints the changeset publish output once', () => {
    // command-stream's .run({ capture: true }) already mirrors the output
    // live (experiments/command-stream-capture-mirrors.mjs); printing the
    // captured copy too made each release log look like two publishes.
    const publishScript = readFileSync('scripts/publish-to-npm.mjs', 'utf8');

    expect(publishScript).not.toContain("console.log('Changeset output:'");
  });
});
