/* eslint local/no-changelog-comments: "off" */

/**
 * End-to-end guard for the use-m interop shim.
 *
 * The unit tests in use-module.test.js pin the shapes we normalise; this file
 * loads `command-stream` through the real, unpinned use-m on the same Node
 * version the release jobs run (`node-version: '24.x'`) and asserts `$` is
 * callable. Without it the interop breakage only surfaces on `main`, inside a
 * job that pushes tags and publishes to npm.
 *
 * The test needs network access. When the fetch of use.js or the package
 * install fails, it logs the reason and passes, so offline development and
 * sandboxed runs are not blocked by an unreachable CDN.
 *
 * On Windows it runs too, and skips only when the ESM loader rejects a bare
 * drive-letter path with ERR_UNSUPPORTED_ESM_URL_SCHEME ("On Windows,
 * absolute paths must be valid file:// URLs"). use-m converts such paths to
 * file:// URLs before importing them; the skip keeps an older or regressed
 * use-m from failing the Windows leg on a loader bug that is independent of
 * the namespace shape this shim normalises.
 */

import { describe, it, expect } from 'test-anywhere';

import { loadCommandStream, USE_M_URL } from '../scripts/use-module.mjs';

/**
 * Explain why use.js cannot be fetched, or return null when it can.
 * Deno without --allow-net denies the fetch before any request is made, so
 * that case is reported as a permission, not as an unreachable CDN.
 * @returns {Promise<string|null>} skip reason
 */
async function networkSkipReason() {
  if (typeof globalThis.Deno?.permissions?.query === 'function') {
    const host = new globalThis.URL(USE_M_URL).host;
    const { state } = await globalThis.Deno.permissions.query({
      name: 'net',
      host,
    });
    if (state !== 'granted') {
      return `Deno net permission for ${host} is ${state}`;
    }
  }

  try {
    const response = await fetch(USE_M_URL, { method: 'HEAD' });
    return response.ok ? null : `${USE_M_URL} answered HTTP ${response.status}`;
  } catch (error) {
    const cause = error?.cause?.message;
    return `${USE_M_URL} is unreachable (${cause ?? error?.message ?? error})`;
  }
}

/**
 * Whether use-m hit the Windows ESM loader's bare-path rejection.
 * @param {unknown} error
 * @param {string} [platform]
 * @returns {boolean}
 */
export function isWindowsFileUrlError(error, platform = process.platform) {
  return (
    platform === 'win32' &&
    (error?.code === 'ERR_UNSUPPORTED_ESM_URL_SCHEME' ||
      /ERR_UNSUPPORTED_ESM_URL_SCHEME/.test(error?.message ?? ''))
  );
}

/**
 * Load command-stream through the real use-m, or return null after logging
 * why the test environment cannot (offline, sandboxed fetch, Windows loader).
 * @returns {Promise<Record<string, unknown>|null>} command-stream exports
 */
async function loadOrSkip() {
  const skipReason = await networkSkipReason();
  if (skipReason) {
    console.log(`Skipping: ${skipReason}, so use-m cannot be evaluated.`);
    return null;
  }

  try {
    return await loadCommandStream();
  } catch (error) {
    if (isWindowsFileUrlError(error)) {
      console.log(
        'Skipping: use-m imported a path without a file:// scheme, which ' +
          'the Windows ESM loader rejects (ERR_UNSUPPORTED_ESM_URL_SCHEME).'
      );
      return null;
    }
    if (
      /fetch|network|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|registry/i.test(
        error.message
      )
    ) {
      console.log(`Skipping: ${error.message}`);
      return null;
    }
    throw error;
  }
}

describe('isWindowsFileUrlError', () => {
  const loaderError = Object.assign(new Error("Received protocol 'c:'"), {
    code: 'ERR_UNSUPPORTED_ESM_URL_SCHEME',
  });

  it('matches the loader rejection only on Windows', () => {
    expect(isWindowsFileUrlError(loaderError, 'win32')).toBe(true);
    expect(isWindowsFileUrlError(loaderError, 'linux')).toBe(false);
  });

  it('matches the code when use-m rethrows it inside a message', () => {
    const wrapped = new Error(
      'Failed to import: ERR_UNSUPPORTED_ESM_URL_SCHEME on c:/x.js'
    );
    expect(isWindowsFileUrlError(wrapped, 'win32')).toBe(true);
    expect(isWindowsFileUrlError(new Error('boom'), 'win32')).toBe(false);
  });
});

describe('use-m loads command-stream on this Node version', () => {
  it('exposes a callable $ from command-stream', async () => {
    const commandStream = await loadOrSkip();

    if (!commandStream) {
      return;
    }

    console.log(`Loaded command-stream on ${process.version}`);
    expect(typeof commandStream.$).toBe('function');
  });

  it('rejects when a command exits non-zero', async () => {
    const { $ } = (await loadOrSkip()) ?? {};

    if (!$) {
      return;
    }

    let rejected = false;

    try {
      await $`exit 3`;
    } catch (error) {
      rejected = true;
      expect(error.code).toBe(3);
    }

    expect(rejected).toBe(true);
  });
});
