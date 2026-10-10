/** Bound argument count and encoded size below common exec limits. */
export function batches(items, size = 200, maxBytes = 48000) {
  const result = [];
  let batch = [],
    bytes = 0;
  for (const item of items) {
    const length = Buffer.byteLength(String(item)) + 1;
    if (batch.length && (batch.length >= size || bytes + length > maxBytes)) {
      result.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += length;
  }
  if (batch.length) {
    result.push(batch);
  }
  return result;
}
