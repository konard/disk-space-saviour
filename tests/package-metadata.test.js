import { describe, it, expect } from 'test-anywhere';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { runCli } from '../src/cli.js';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const lockJson = JSON.parse(readFileSync('package-lock.json', 'utf8'));

describe('publishable package metadata', () => {
  it('uses the disk-space-saviour package name', () => {
    expect(packageJson.name).toBe('disk-space-saviour');
    expect(packageJson.publishConfig).toEqual({ access: 'public' });
    expect(lockJson.name).toBe('disk-space-saviour');
    expect(lockJson.packages[''].name).toBe('disk-space-saviour');
  });

  it('defines globally installable dss and disk-space-saviour commands', () => {
    expect(packageJson.bin).toEqual({
      dss: './bin/dss.js',
      'disk-space-saviour': './bin/dss.js',
    });
    expect(existsSync('bin/dss.js')).toBe(true);
  });

  it('prints the package version through the CLI', async () => {
    const stdout = [];
    const stderr = [];
    const io = {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      interactive: false,
    };

    expect(await runCli(['--version'], { io })).toBe(0);
    expect(stdout).toEqual([packageJson.version]);
    expect(stderr).toEqual([]);
  });

  it('runs when invoked through an npm-style bin symlink', () => {
    if (typeof Deno !== 'undefined') {
      return;
    }

    const tempRoot = mkdtempSync(join(tmpdir(), 'dss-bin-'));
    const linkPath = join(tempRoot, 'dss');

    try {
      symlinkSync(resolve('bin/dss.js'), linkPath);
    } catch (error) {
      rmSync(tempRoot, { force: true, recursive: true });

      if (process.platform === 'win32') {
        expect(error.code).toBe('EPERM');
        return;
      }

      throw error;
    }

    try {
      const result = spawnSync(process.execPath, [linkPath, '--help'], {
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout.startsWith('Usage: dss')).toBe(true);
      expect(result.stderr).toBe('');
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('publishes only the package runtime surface', () => {
    expect(packageJson.files).toEqual([
      'bin/',
      'src/',
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
    ]);
  });
});
