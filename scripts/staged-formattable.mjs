/**
 * Staged files the release commit checks with prettier.
 *
 * Deleted paths (the changesets `changeset version` consumed) no longer
 * exist, and prettier fails on a path it cannot find, so `--diff-filter=d`
 * leaves deletions out.
 */

export const STAGED_FILES_ARGS = [
  'diff',
  '--cached',
  '--name-only',
  '--diff-filter=d',
];

const FORMATTABLE = /\.(m?js|json|md|ts)$/;

/**
 * Picks the prettier-formattable paths out of `git diff --name-only` output.
 * @param {string} output
 * @returns {string[]}
 */
export function formattableFiles(output) {
  return output
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => FORMATTABLE.test(file));
}
