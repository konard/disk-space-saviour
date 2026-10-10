import { describe, it, expect } from 'test-anywhere';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scan } from '../src/scan.js';
import { clean } from '../src/clean.js';
import {
  age,
  DAY_MS,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writeBlob,
} from './helpers/fixtures.js';

const locations = [
  ['perlbrew-build', '.perl5/build/perl-5/build.o'],
  ['perlbrew-build', '.perl5/dists/perl.tar.gz'],
  ['sdkman-tmp', '.sdkman/tmp/java.zip'],
  ['sdkman-archives', '.sdkman/archives/java.zip'],
  ['nvm-cache', '.nvm/.cache/bin/node.tar.gz'],
  ['ruby-gem-cache', '.rbenv/versions/3.3/lib/ruby/gems/3.3.0/cache/test.gem'],
  ['ruby-gem-cache', '.rvm/gems/ruby-3.3/cache/test.gem'],
  ['ruby-gem-cache', '.local/share/gem/ruby/3.3.0/cache/test.gem'],
];

describe('issue 36 toolchain caches', () => {
  for (const [rule, location] of locations) {
    it(`finds ${location} safely and respects its busy tools`, async () => {
      const root = tempRoot(),
        home = join(root, 'home');
      writeBlob(join(home, location), 8192);
      age(root, 40 * DAY_MS);
      const env = fixtureEnv(root),
        options = scanInput(env, [], { scanners: ['global'] });
      try {
        const report = await scan(options),
          item = report.items.find((i) => i.rule === rule);
        expect(Boolean(item)).toBe(true);
        expect(item.tier).toBe('safe');
        expect(item.checks.busy.length > 0).toBe(true);
        expect(
          item.paths.every(
            (p) => !p.endsWith('/cache') || rule !== 'ruby-gem-cache'
          )
        ).toBe(true);
        env.processes = () =>
          Promise.resolve([{ pid: 7, name: item.checks.busy[0], cwd: home }]);
        const active = (await scan(options)).items.find((i) => i.rule === rule);
        expect(active.blockers.join('\n')).toMatch(/busy/);
      } finally {
        removeRoot(root);
      }
    });
  }
  it('cleans only downloaded gem files, preserving other cache content', async () => {
    const root = tempRoot(),
      home = join(root, 'home'),
      cache = join(home, '.rvm/gems/ruby-3.3/cache');
    writeBlob(join(cache, 'test.gem'), 8192);
    writeBlob(join(cache, 'keep.txt'), 8192);
    age(root, 40 * DAY_MS);
    const env = fixtureEnv(root),
      options = scanInput(env, [], { scanners: ['global'] });
    try {
      await clean(await scan(options), { ...options, audit: false });
      expect(existsSync(join(cache, 'test.gem'))).toBe(false);
      expect(existsSync(join(cache, 'keep.txt'))).toBe(true);
    } finally {
      removeRoot(root);
    }
  });
  it('honors configured cache roots and GOPATH outside the home default', async () => {
    const root = tempRoot(),
      home = join(root, 'home');
    const vars = {
      GOPATH: join(root, 'go'),
      CARGO_HOME: join(root, 'cargo'),
      DENO_DIR: join(root, 'deno'),
      BUN_INSTALL_CACHE_DIR: join(root, 'bun'),
      XDG_CACHE_HOME: join(root, 'xdg'),
      GRADLE_USER_HOME: join(root, 'gradle'),
      npm_config_cache: join(root, 'npm'),
      PIP_CACHE_DIR: join(root, 'pip'),
      YARN_CACHE_FOLDER: join(root, 'yarn'),
      PNPM_STORE_DIR: join(root, 'pnpm'),
    };
    const expected = [
      ['go-mod-cache', join(vars.GOPATH, 'pkg/mod')],
      ['cargo-registry', join(vars.CARGO_HOME, 'registry/cache')],
      ['deno-cache', vars.DENO_DIR],
      ['bun-cache', vars.BUN_INSTALL_CACHE_DIR],
      ['pip-cache', vars.PIP_CACHE_DIR],
      ['yarn-cache', vars.YARN_CACHE_FOLDER],
      ['pnpm-store', vars.PNPM_STORE_DIR],
      ['npm-cache', join(vars.npm_config_cache, '_cacache')],
      ['gradle-caches', join(vars.GRADLE_USER_HOME, 'caches')],
      ['go-build-cache', join(vars.XDG_CACHE_HOME, 'go-build')],
    ];
    for (const [, dir] of expected) {
      writeBlob(join(dir, 'blob'), 8192);
    }
    writeBlob(join(home, 'Library/pnpm/store/default-blob'), 8192);
    age(root, 40 * DAY_MS);
    const env = fixtureEnv(root);
    env.vars = vars;
    env.currentHome = home;
    env.which = async () => false;
    try {
      const report = await scan(scanInput(env, [], { scanners: ['global'] }));
      expect(
        report.items.some(
          (i) =>
            i.rule === 'pnpm-store' && i.path.includes('Library/pnpm/store')
        )
      ).toBe(false);
      for (const [rule, path] of expected) {
        expect(
          report.items.some((i) => i.rule === rule && i.path === path)
        ).toBe(true);
      }
    } finally {
      removeRoot(root);
    }
  });
  it('reports semver baseline builds at safe tier and blocks an active semver check', async () => {
    const root = tempRoot(),
      home = join(root, 'home'),
      project = join(home, 'repo');
    writeBlob(join(project, 'Cargo.toml'), 64);
    writeBlob(join(project, 'target/semver-checks/git-main/blob'), 8192);
    writeBlob(join(project, 'target/CACHEDIR.TAG'), 64);
    age(root, 40 * DAY_MS);
    const env = fixtureEnv(root),
      options = scanInput(env, [home], { scanners: ['projects'] });
    try {
      let report = await scan(options),
        item = report.items.find((i) => i.rule === 'cargo-semver-checks-cache');
      expect(item?.tier).toBe('safe');
      env.processes = async () => [
        { pid: 7, name: 'cargo-semver-checks', cwd: project },
      ];
      report = await scan(options);
      item = report.items.find((i) => i.rule === 'cargo-semver-checks-cache');
      expect(item.blockers.join('\n')).toMatch(/busy.*cargo-semver/);
    } finally {
      removeRoot(root);
    }
  });
});
