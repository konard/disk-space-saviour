/**
 * Classify npm publish failures and build actionable guidance.
 *
 * Some publish failures are permanent: retrying a 404/401/403 (or any auth /
 * registry-configuration error) produces the same error every time and only
 * delays a clear, actionable message. The most common case is the FIRST publish
 * of a brand-new package via npm OIDC trusted publishing, which returns E404
 * because npm cannot bootstrap a new package with trusted publishing alone — a
 * trusted publisher can only be configured for a package that already exists.
 *
 * Addresses issue:
 * - link-foundation/js-ai-driven-development-pipeline-template#77
 */

// Failures caused by authentication / registry configuration. Retrying these is
// pointless and only hides the real cause behind a generic
// "Failed to publish after N attempts" message.
export const NON_RETRYABLE_PATTERNS = [
  'npm error 404',
  'npm error 401',
  'npm error 403',
  'e404',
  'e401',
  'e403',
  'access token expired',
  'eneedauth',
  'you must be logged in',
  'unable to authenticate',
];

/**
 * Determine whether a detected failure is caused by authentication / registry
 * configuration (and therefore should not be retried).
 * @param {string} output - Combined stdout and stderr (and/or error message)
 * @returns {boolean}
 */
export function isNonRetryableFailure(output) {
  const lowerOutput = String(output || '').toLowerCase();
  return NON_RETRYABLE_PATTERNS.some((pattern) =>
    lowerOutput.includes(pattern)
  );
}

/**
 * Build an actionable, human-readable explanation for an authentication /
 * registry-configuration publish failure (most commonly an E404 on the very
 * first publish of a brand-new package via OIDC trusted publishing).
 * @param {string} packageName - The package that failed to publish
 * @returns {string}
 */
export function buildAuthFailureGuidance(packageName) {
  return [
    '',
    '=== NPM PUBLISH AUTHENTICATION / REGISTRY FAILURE ===',
    '',
    `Failed to publish ${packageName}. This is an authentication or registry`,
    'configuration error, not a transient one, so it was not retried.',
    '',
    'For an existing package, verify Package settings -> Trusted publishing:',
    'the owner, repository and workflow must match the current GitHub repository.',
    'After a repository transfer, update the npm trusted publisher before retrying.',
    'For disk-space-saviour: owner link-foundation, repository disk-space-saviour,',
    'workflow release.yml. The published latest version may still be older.',
    '',
    'For a new package, the FIRST publish of a brand-new package via npm OIDC',
    'trusted publishing returns "E404 Not Found - PUT". npm cannot bootstrap a',
    'new package with trusted publishing alone, because a trusted publisher can',
    'only be configured for a package that already exists on the registry.',
    '',
    'SOLUTION: npm publishes only through trusted publishing, so no token is',
    'ever added. Publish the first version once and attach this workflow as',
    'the trusted publisher with package-registry-manager:',
    '  npx package-registry-manager setup --registry npm --execute',
    'It signs in through the browser, publishes the first version, attaches',
    'the trusted publisher on npmjs.com (Package settings -> Trusted',
    'publishing) and signs out again; later releases need no token at all.',
    '',
    'See: https://docs.npmjs.com/trusted-publishers',
    '',
  ].join('\n');
}
