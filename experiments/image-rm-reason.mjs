// Prints why an approved `docker image rm` entry fails against the fake world.
import { clean } from '../src/clean.js';
import {
  FakeDockerWorld,
  daemonInfo,
  scanWorld,
} from '../tests/helpers/fake-docker.js';

const fake = new FakeDockerWorld({
  host: {
    info: daemonInfo('HOST', 'host-daemon'),
    containers: [],
    images: [
      {
        ID: 'ff00ee11dd22cc33bb44aa55',
        Repository: 'alpine',
        Tag: '3.20',
        Size: '8MB',
        UniqueSize: '8MB',
        Containers: '0',
      },
    ],
  },
});
const { env, report } = await scanWorld(fake);
const audit = await clean(report, {
  env,
  tier: 'moderate',
  only: ['docker-unused-image'],
  removeImages: ['alpine:3.20'],
  audit: false,
});
console.log(audit.entries.map((e) => [e.status, e.reason, e.error]));
console.log(fake.dockerCalls());
