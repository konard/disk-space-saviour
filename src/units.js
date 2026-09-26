/**
 * Size, duration, and percentage parsing and formatting.
 *
 * Pure functions with no runtime dependencies, so they are safe to import
 * from browsers (the universal example app uses them) as well as from
 * Node.js, Bun, and Deno.
 */

const SIZE_UNITS = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

const DURATION_UNITS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Parses a human size such as `20G`, `512MiB`, `1.5 TB` or `1024` (bytes).
 * Binary multiples are used for every suffix, matching `du -h` and `df -h`.
 * @param {string|number} value
 * @returns {number} bytes
 */
export function parseSize(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(String(value).trim());
  const unit = match && SIZE_UNITS[match[2].toLowerCase()];
  if (!match || unit === undefined) {
    throw new Error(`Invalid size: ${value} (expected e.g. 20G, 512M, 1024)`);
  }
  return Math.round(Number(match[1]) * unit);
}

/**
 * Parses a duration such as `1h`, `30m`, `7d`, `90s` or `0`.
 * A bare number is interpreted as seconds.
 * @param {string|number} value
 * @returns {number} milliseconds
 */
export function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value * 1000;
  }
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(String(value).trim());
  const unitName = match ? match[2].toLowerCase() || 's' : '';
  const unit = DURATION_UNITS[unitName];
  if (!match || unit === undefined) {
    throw new Error(`Invalid duration: ${value} (expected e.g. 1h, 30m, 7d)`);
  }
  return Math.round(Number(match[1]) * unit);
}

/**
 * Parses a percentage such as `80%` or `80`.
 * @param {string|number} value
 * @returns {number} percentage in the range 0..100
 */
export function parsePercent(value) {
  const match = /^(\d+(?:\.\d+)?)\s*%?$/.exec(String(value).trim());
  const percent = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`Invalid percentage: ${value} (expected e.g. 80%)`);
  }
  return percent;
}

/**
 * Formats bytes using binary multiples, e.g. `27.7 GiB`.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return 'unknown';
  }
  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  const digits = index === 0 || value >= 100 ? 0 : 1;
  return `${sign}${value.toFixed(digits)} ${units[index]}`;
}

/**
 * Formats a duration in milliseconds as a compact human string.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return 'unknown';
  }
  const abs = Math.abs(ms);
  const steps = [
    ['d', DURATION_UNITS.d],
    ['h', DURATION_UNITS.h],
    ['m', DURATION_UNITS.m],
    ['s', DURATION_UNITS.s],
  ];
  for (const [label, size] of steps) {
    if (abs >= size) {
      return `${Math.floor(abs / size)}${label}`;
    }
  }
  return `${Math.round(abs)}ms`;
}
