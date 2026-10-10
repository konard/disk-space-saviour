/**
 * Pulls a digest-pinned image the way .github/actions/setup-buildx-resilient
 * does: retry Docker Hub with a growing delay, then try a pull-through
 * mirror. The digest makes the mirror's copy byte-identical, so the caller
 * tags whichever reference was pulled.
 */

export const DEFAULT_MIRROR = 'mirror.gcr.io';

/** `busybox@sha256:…` → `mirror.gcr.io/library/busybox@sha256:…` */
export function mirrorRef(image, mirror = DEFAULT_MIRROR) {
  const name = image.split(/[:@]/, 1)[0];
  return `${mirror}/${name.includes('/') ? '' : 'library/'}${image}`;
}

/**
 * @param {string} image digest-pinned reference
 * @param {object} io
 * @param {(args: string[]) => boolean} io.docker runs docker, true on success
 * @param {(ms: number) => void} io.sleep
 * @param {(message: string) => void} io.log
 * @returns {string} the reference that was pulled
 */
export function pullPinned(
  image,
  { docker, sleep, log, mirror = DEFAULT_MIRROR, attempts = 3, delayMs = 5000 }
) {
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(`${image} is not pinned to a digest`);
  }
  const candidates = mirror ? [image, mirrorRef(image, mirror)] : [image];
  for (const ref of candidates) {
    let delay = delayMs;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      log(`pulling ${ref} (attempt ${attempt}/${attempts})`);
      if (docker(['pull', '-q', ref])) {
        return ref;
      }
      if (attempt < attempts) {
        sleep(delay);
        delay *= 2;
      }
    }
  }
  throw new Error(`could not pull ${image} from ${candidates.join(' or ')}`);
}
