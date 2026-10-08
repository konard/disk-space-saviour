import { describe, it, expect } from 'test-anywhere';
import { DockerCli } from '../src/docker/cli.js';
import { filterItems } from '../src/scan.js';
import { resolveOptions } from '../src/options.js';
import { formatReport } from '../src/report.js';
import {
  FakeDockerWorld,
  daemonInfo,
  scanWorld,
} from './helpers/fake-docker.js';

function world() {
  return new FakeDockerWorld({
    host: {
      info: daemonInfo('HOST', 'host-daemon'),
      containers: [
        {
          id: 'a1',
          name: 'failed-task',
          state: 'exited',
          exitCode: 127,
          size: '573kB',
          image: 'resume/task:1',
        },
      ],
      images: [
        {
          ID: 'img',
          Repository: 'resume/task',
          Tag: '1',
          Containers: '1',
          Size: '5GB',
          UniqueSize: '4.4GB',
        },
      ],
    },
  });
}

function brokenDf(fake) {
  const original = fake.run.bind(fake);
  fake.run = (argv) =>
    argv[0] === 'docker' && argv[1] === 'system'
      ? {
          code: 1,
          stdout: '',
          stderr: 'snapshotter.Usage failed: no such file or directory',
        }
      : original(argv);
}

describe('issue 14 Docker discovery', () => {
  it('does not ask docker ps to compute writable layer sizes', async () => {
    const calls = [];
    const docker = new DockerCli({
      run: async (argv) => {
        calls.push(argv);
        return {
          code: 0,
          stdout: 'abc\tbox\trunning\tUp 1 hour\timg\n',
          stderr: '',
        };
      },
    });
    const containers = await docker.containers();
    expect(calls[0]).not.toContain('--size');
    expect(calls[0].at(-1)).not.toContain('{{json .}}');
    expect(containers[0].ID).toBe('abc');
  });

  it('preserves containers and images after repeated global size failures', async () => {
    const fake = world();
    brokenDf(fake);
    const { result } = await scanWorld(fake);
    expect(result.daemons.length).toBe(1);
    expect(result.containers.length).toBe(1);
    expect(result.errors.length > 0).toBe(true);
    expect(
      result.items.some((item) => item.container?.name === 'failed-task')
    ).toBe(true);
  });

  it('shows the image pinned by a small stopped container as potential bytes', async () => {
    const { result } = await scanWorld(world());
    const item = result.items.find((entry) => entry.container);
    expect(item.container.pinnedImage.bytes).toBe(4.4e9);
    expect(item.bytes).toBe(573e3);
    expect(filterItems([item], resolveOptions({ minSize: '1M' }))).toEqual([
      item,
    ]);
    expect(formatReport((await scanWorld(world())).report)).toMatch(
      /4.1 GiB.*image/
    );
  });

  it('checks stopped Git work in a plain scan', async () => {
    const fake = world();
    fake.daemons.host.containers[0].diff = 'A /work/repo/.git/HEAD\n';
    const { result } = await scanWorld(fake);
    const item = result.items.find((entry) => entry.container);
    expect(item.container.gitCheckDeferred).not.toBe(true);
    expect(item.container.gitBlockers.length > 0).toBe(true);
  });

  it('retains one failed container size as unknown and scans the others', async () => {
    const fake = world();
    fake.daemons.host.images = [];
    const original = fake.run.bind(fake);
    fake.run = (argv) =>
      argv.includes('--size') && argv[1] === 'inspect'
        ? { code: 1, stdout: '', stderr: 'rw layer snapshot not found' }
        : original(argv);
    const { result } = await scanWorld(fake);
    expect(result.containers[0].sizeUnknown).toBe(true);
    expect(result.containers[0].bytes).toBe(0);
    const item = result.items.find((entry) => entry.container);
    expect(item.sizeUnknown).toBe(true);
    expect(filterItems([item], resolveOptions({ minSize: '1M' }))).toEqual([
      item,
    ]);
    expect(
      result.errors.some((error) => error.message.includes('rw layer snapshot'))
    ).toBe(true);
  });

  it('retains dangling images with unavailable size measurements', async () => {
    const fake = world();
    fake.daemons.host.images.push({
      ID: 'dangling',
      Repository: '<none>',
      Tag: '<none>',
      Containers: '0',
      Size: '1GB',
      UniqueSize: '1GB',
    });
    brokenDf(fake);
    const { result } = await scanWorld(fake);
    const item = result.items.find(
      (entry) => entry.rule === 'docker-dangling-images'
    );
    expect(item.sizeUnknown).toBe(true);
    expect(filterItems([item], resolveOptions({ minSize: '1M' }))).toEqual([
      item,
    ]);
  });
});
