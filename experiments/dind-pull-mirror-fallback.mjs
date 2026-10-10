// Runs tests/integration/pull-pinned.mjs against a real Docker daemon with
// Docker Hub "down" (every pull of the canonical reference fails), then tags
// the mirrored image the way tests/integration/dind.mjs does.
//   node experiments/dind-pull-mirror-fallback.mjs
import { spawnSync } from 'node:child_process';
import { pullPinned } from '../tests/integration/pull-pinned.mjs';

const image =
  'busybox@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e';
const tag = 'dss-it/busybox:fallback-experiment';
const docker = (args) =>
  spawnSync('docker', args, { stdio: ['ignore', 'ignore', 'inherit'] })
    .status === 0;

const pulled = pullPinned(image, {
  docker: (args) => args.at(-1) !== image && docker(args),
  sleep: () => {},
  log: (message) => console.log(`[pull] ${message}`),
});
console.log('pulled', pulled);
console.log('tag ok', docker(['tag', pulled, tag]));
console.log(
  'tagged id',
  spawnSync('docker', ['image', 'inspect', '-f', '{{.Id}}', tag], {
    encoding: 'utf8',
  }).stdout.trim()
);
docker(['rmi', tag, pulled]);
