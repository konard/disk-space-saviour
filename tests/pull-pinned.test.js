import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import { mirrorRef, pullPinned } from './integration/pull-pinned.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const IMAGE = `docker:28-dind@${DIGEST}`;

function fakeDocker(failingRefs) {
  const calls = [];
  const sleeps = [];
  const io = {
    docker: (args) => {
      calls.push(args.join(' '));
      return !failingRefs.includes(args.at(-1));
    },
    sleep: (ms) => sleeps.push(ms),
    log: () => {},
  };
  return { io, calls, sleeps };
}

describe('pullPinned', () => {
  it('maps official and namespaced images onto the mirror', () => {
    expect(mirrorRef(IMAGE)).toBe(`mirror.gcr.io/library/${IMAGE}`);
    expect(mirrorRef(`moby/buildkit@${DIGEST}`)).toBe(
      `mirror.gcr.io/moby/buildkit@${DIGEST}`
    );
  });

  it('pulls from Docker Hub when it answers', () => {
    const { io, calls, sleeps } = fakeDocker([]);

    expect(pullPinned(IMAGE, io)).toBe(IMAGE);
    expect(calls).toEqual([`pull -q ${IMAGE}`]);
    expect(sleeps).toEqual([]);
  });

  it('retries Docker Hub with a growing delay, then uses the mirror', () => {
    const { io, calls, sleeps } = fakeDocker([IMAGE]);
    const mirrored = mirrorRef(IMAGE);

    expect(pullPinned(IMAGE, io)).toBe(mirrored);
    expect(calls).toEqual([
      `pull -q ${IMAGE}`,
      `pull -q ${IMAGE}`,
      `pull -q ${IMAGE}`,
      `pull -q ${mirrored}`,
    ]);
    expect(sleeps).toEqual([5000, 10000]);
  });

  it('fails naming both sources when neither answers', () => {
    const { io } = fakeDocker([IMAGE, mirrorRef(IMAGE)]);

    expect(() => pullPinned(IMAGE, io)).toThrow(/could not pull .* or /);
  });

  it('refuses an image without a digest, which the mirror could serve differently', () => {
    const { io, calls } = fakeDocker([]);

    expect(() => pullPinned('docker:28-dind', io)).toThrow(/digest/);
    expect(calls).toEqual([]);
  });

  it('is what the Docker-in-Docker test pulls with', () => {
    const dind = readFileSync('tests/integration/dind.mjs', 'utf8');

    expect(dind).toContain('pullPinned(image, {');
    expect(dind).toContain('docker tag ${pulled} ${tag}');
    expect(dind).not.toMatch(/docker pull/);
  });
});
