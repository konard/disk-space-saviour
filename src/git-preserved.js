/** Verify unstaged work against cached remote refs without running filters. */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';

async function blob(root, file, algorithm) {
  const target = path.join(root, file);
  const stat = await fsp.lstat(target).catch((error) => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
      return null;
    }
    throw error;
  });
  if (!stat) {
    return null;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error('non-file change');
  }
  const link = stat.isSymbolicLink()
    ? Buffer.from(await fsp.readlink(target))
    : null;
  const hash = createHash(algorithm);
  hash.update(`blob ${link ? link.length : stat.size}\0`);
  if (link) {
    hash.update(link);
  } else {
    for await (const chunk of createReadStream(target)) {
      hash.update(chunk);
    }
  }
  return {
    oid: hash.digest('hex'),
    mode: link ? '120000' : stat.mode & 0o111 ? '100755' : '100644',
  };
}

/** All changes must be preserved by one ref; staged changes remain protected. */
export async function preservedWork(root, git) {
  const status = await git([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (status.code !== 0) {
    return {};
  }
  const records = status.stdout.split('\0').filter(Boolean);
  const untracked = records.filter((line) => line.startsWith('?? ')).length;
  const result = { untracked, dirty: records.length };
  if (
    !records.length ||
    records.length > 2000 ||
    records.some((line) => ![' ', '?'].includes(line[0]))
  ) {
    return result;
  }
  const refs = await git([
    'for-each-ref',
    '--format=%(refname)',
    'refs/remotes',
  ]);
  const format = await git(['rev-parse', '--show-object-format']);
  if (refs.code !== 0 || format.code !== 0) {
    return result;
  }
  const algorithm = format.stdout.trim();
  if (!['sha1', 'sha256'].includes(algorithm)) {
    return result;
  }
  try {
    const files = new Map();
    for (const record of records) {
      const file = record.slice(3);
      files.set(file, await blob(root, file, algorithm));
    }
    for (const ref of refs.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, 100)) {
      const tree = await git([
        'ls-tree',
        '-r',
        '-z',
        ref,
        '--',
        ...[...files.keys()].map((file) => `:(literal)${file}`),
      ]);
      if (tree.code !== 0) {
        continue;
      }
      const saved = new Map(
        tree.stdout
          .split('\0')
          .filter(Boolean)
          .map((line) => {
            const tab = line.indexOf('\t');
            const [mode, , oid] = line.slice(0, tab).split(' ');
            return [line.slice(tab + 1), { mode, oid }];
          })
      );
      if (
        [...files].every(([file, current]) =>
          current
            ? saved.get(file)?.oid === current.oid &&
              saved.get(file)?.mode === current.mode
            : !saved.has(file)
        )
      ) {
        result.preservedOn = ref.replace(/^refs\/remotes\//, '');
        break;
      }
    }
  } catch {
    // Unreadable files and unsupported changes keep the original blocker.
  }
  return result;
}
