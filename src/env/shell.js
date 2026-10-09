/**
 * Environment adapter for a filesystem reached through an executor, usually
 * a running container via `docker exec`.
 *
 * It needs only a POSIX shell with `find`, `stat -c`, `du`, `df`, `head`,
 * `rm`, and `/proc` (GNU coreutils and busybox both qualify), so nothing is
 * installed into the container being inspected.
 */

import path from 'node:path';
import { sharedWritableLayer } from '../docker/writable.js';

import { containerExecutor, shellQuote, trace } from '../exec.js';
import { DEFAULT_SKIP_NAMES, parseDf, processAliases } from './local.js';

const STAT_FORMAT = '%F|%s|%b|%B|%Y|%n';
const ARG_BATCH = 200;
const RECORD = '\u0001';

const LIST_SCRIPT = `for d in "$@"; do
  printf '${RECORD}%s\\n' "$d"
  cd -- "$d" 2>/dev/null && stat -c '${STAT_FORMAT}' -- * .[!.]* ..?* 2>/dev/null
done
true`;

const HEADS_SCRIPT = `n="$1"; shift
for f in "$@"; do
  printf '${RECORD}%s\\n' "$f"
  head -c "$n" -- "$f" 2>/dev/null
done
true`;

const USAGE_MANY_SCRIPT = `for t in "$@"; do
  [ -e "$t" ] || [ -L "$t" ] || continue
  printf '${RECORD}%s\\n' "$t"
  du -skx -- "$t" 2>/dev/null | cut -f1
  find "$t" -xdev ! -type d -exec stat -c %Y {} + 2>/dev/null | awk 'BEGIN{m=0;n=0}{n++; if ($1>m) m=$1} END{print n, m}'
  stat -c %Y -- "$t"
done
true`;

const PROCESS_SCRIPT = `echo "$$"
for p in /proc/[0-9]*; do
  c=$(cat "$p/comm" 2>/dev/null) || continue
  e=$(readlink "$p/exe" 2>/dev/null)
  a=$(tr '\\000' '\\n' < "$p/cmdline" 2>/dev/null | head -n 1)
  w=$(readlink "$p/cwd" 2>/dev/null)
  q=$(tr '\\000' ' ' < "$p/cmdline" 2>/dev/null)
  t=$(sed 's/.*) //' "$p/stat" 2>/dev/null | cut -d' ' -f1,20)
  printf '%s|%s|%s|%s|%s|%s|%s\\n' "\${p#/proc/}" "$t" "$c" "$e" "$a" "$w" "$q"
done`;

export const OPEN_PATHS_SCRIPT = `failed=0
for p in /proc/[0-9]*; do
  [ -d "$p" ] || continue
  state=$(sed 's/.*) //' "$p/stat" 2>/dev/null | cut -d' ' -f1)
  [ "$state" = Z ] && continue
  unreadable=0
  ls "$p/fd" >/dev/null 2>&1 || unreadable=1
  for l in "$p/cwd" "$p/exe" "$p"/fd/*; do
    [ -L "$l" ] || continue
    readlink "$l" 2>/dev/null || { [ -L "$l" ] && unreadable=1; }
  done
  if [ "$unreadable" = 1 ] && [ -d "$p" ]; then
    printf 'unreadable pid %s (%s)\\n' "\${p#/proc/}" "$(cat "$p/comm" 2>/dev/null)" >&2
    uid=$(awk '/^Uid:/{print $2}' "$p/status" 2>/dev/null)
    command=$(tr '\\000' ' ' < "$p/cmdline" 2>/dev/null)
    printf 'DSS_UNREADABLE|%s|%s|%s|%s\\n' "\${p#/proc/}" "$uid" "$(cat "$p/comm" 2>/dev/null)" "$command" >&2
    failed=1
  fi
done
exit "$failed"`;

const REMOVE_SCRIPT = `rm -rf -- "$@" 2>/dev/null && exit 0
chmod -R u+w -- "$@" 2>/dev/null
rm -rf -- "$@"`;

const EXISTS_SCRIPT = `for p in "$@"; do
  if [ -e "$p" ] || [ -L "$p" ]; then printf '%s\\n' "$p"; fi
done`;

const HOMES_SCRIPT = `echo "$HOME"
while IFS=: read -r name pw uid gid gecos home shell; do
  case "$uid" in ''|*[!0-9]*) continue ;; esac
  if [ "$uid" -eq 0 ] || { [ "$uid" -ge 1000 ] && [ "$uid" -lt 65534 ]; }; then
    [ -d "$home" ] && [ "$home" != / ] && echo "$home"
  fi
done < /etc/passwd
for h in /home/*; do [ -d "$h" ] && echo "$h"; done
true`;

function statType(label) {
  if (label === 'directory') {
    return 'dir';
  }
  if (label.startsWith('regular')) {
    return 'file';
  }
  if (label === 'symbolic link') {
    return 'symlink';
  }
  return 'other';
}

/**
 * Parses one `stat -c '%F|%s|%b|%B|%Y|%n'` line.
 * @param {string} line
 */
export function parseStatLine(line) {
  const parts = line.split('|');
  if (parts.length < 6) {
    return null;
  }
  const [type, size, blocks, blockSize, mtime] = parts;
  const name = parts.slice(5).join('|');
  return {
    name,
    type: statType(type),
    size: Number(size),
    bytes: Number(blocks) * Number(blockSize),
    mtimeMs: Number(mtime) * 1000,
  };
}

function splitRecords(output) {
  const records = new Map();
  for (const chunk of output.split(RECORD).slice(1)) {
    const newline = chunk.indexOf('\n');
    const key = newline === -1 ? chunk : chunk.slice(0, newline);
    records.set(key, newline === -1 ? '' : chunk.slice(newline + 1));
  }
  return records;
}

function parseUsage(body) {
  const [kib, counts = '', rootMtime] = body.trim().split('\n');
  const [files, newest] = counts.trim().split(/\s+/).map(Number);
  const bytes = Number(kib) * 1024;
  const newestSeconds = files > 0 ? newest : Number(rootMtime);
  return {
    bytes: Number.isFinite(bytes) ? bytes : 0,
    apparentBytes: Number.isFinite(bytes) ? bytes : 0,
    files: Number.isFinite(files) ? files : 0,
    errors: Number.isFinite(bytes) ? 0 : 1,
    newestMtimeMs: Number.isFinite(newestSeconds) ? newestSeconds * 1000 : 0,
  };
}

function batches(items, size = ARG_BATCH) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function findNameExpression(names) {
  return names.flatMap((name, index) =>
    index === 0 ? ['-name', name] : ['-o', '-name', name]
  );
}

export class ShellEnv {
  /**
   * @param {object} executor executor reaching the target filesystem
   * @param {{id?: string, label?: string, kind?: string, homes?: string[],
   *   skipNames?: string[]}} [options]
   */
  constructor(executor, options = {}) {
    this.executor = executor;
    this.writableLayer =
      executor.parent && executor.containerId
        ? sharedWritableLayer(executor.parent, executor.containerId)
        : null;
    this.id = options.id ?? executor.label;
    this.kind = options.kind ?? 'container';
    this.label = options.label ?? executor.label;
    this.path = path.posix;
    this.platform = 'linux';
    this.options = options;
    this.vars = {};
    this.currentHome = null;
    this.skipNames = options.skipNames ?? DEFAULT_SKIP_NAMES;
  }

  sh(script, args = [], options = {}) {
    return this.executor.run(['sh', '-c', script, 'sh', ...args], options);
  }

  async homeDirs() {
    if (this.options.homes) {
      return this.options.homes;
    }
    const result = await this.sh(HOMES_SCRIPT);
    const lines = result.stdout.split('\n').filter(Boolean);
    this.currentHome = lines[0] ?? null;
    return [...new Set(lines.filter((line) => line.startsWith('/')))];
  }

  tmpDirs() {
    return Promise.resolve(this.options.tmpDirs ?? ['/tmp']);
  }

  async exists(target) {
    const result = await this.sh('[ -e "$1" ] || [ -L "$1" ]', [target]);
    return result.code === 0;
  }

  /**
   * Existing paths among `targets`, one round trip per batch.
   * @returns {Promise<Set<string>>}
   */
  async existsMany(targets) {
    const existing = new Set();
    for (const batch of batches(targets)) {
      const result = await this.sh(EXISTS_SCRIPT, batch);
      result.stdout
        .split('\n')
        .filter(Boolean)
        .forEach((line) => existing.add(line));
    }
    return existing;
  }

  async stat(target) {
    const result = await this.executor.run([
      'stat',
      '-c',
      STAT_FORMAT,
      '--',
      target,
    ]);
    if (result.code !== 0) {
      return null;
    }
    const parsed = parseStatLine(result.stdout.trim());
    if (!parsed) {
      return null;
    }
    return {
      type: parsed.type,
      size: parsed.size,
      bytes: parsed.bytes,
      mtimeMs: parsed.mtimeMs,
    };
  }

  async readText(target, maxBytes = 1024 * 1024) {
    const result = await this.executor.run([
      'head',
      '-c',
      String(maxBytes),
      '--',
      target,
    ]);
    return result.code === 0 ? result.stdout : null;
  }

  async readHeads(files, maxBytes = 4096) {
    const heads = new Map();
    for (const batch of batches(files)) {
      const result = await this.sh(HEADS_SCRIPT, [String(maxBytes), ...batch]);
      for (const [file, text] of splitRecords(result.stdout)) {
        heads.set(file, text);
      }
    }
    return heads;
  }

  /**
   * Lists many directories with one round trip per batch.
   * @param {string[]} dirs
   * @returns {Promise<Map<string, object[]>>}
   */
  async listMany(dirs) {
    const listings = new Map();
    for (const batch of batches(dirs)) {
      const result = await this.sh(LIST_SCRIPT, batch);
      for (const [dir, body] of splitRecords(result.stdout)) {
        const entries = body
          .split('\n')
          .map(parseStatLine)
          .filter(Boolean)
          .map((entry) => ({
            ...entry,
            path: path.posix.join(dir, entry.name),
          }));
        listings.set(dir, entries);
      }
    }
    return listings;
  }

  async list(dir) {
    return (await this.listMany([dir])).get(dir) ?? [];
  }

  async usage(target) {
    return (await this.usageMany([target])).get(target) ?? null;
  }

  /**
   * Measures many paths with one round trip per batch.
   * @param {string[]} targets
   * @returns {Promise<Map<string, object>>}
   */
  async usageMany(targets) {
    const usages = await this.rawUsageMany(targets);
    return this.writableLayer
      ? this.writableLayer.measure(this, usages)
      : usages;
  }

  async statMany(targets) {
    const stats = new Map();
    for (const batch of batches(targets)) {
      const result = await this.executor.run([
        'stat',
        '-c',
        `${STAT_FORMAT}|%d:%i:%u`,
        '--',
        ...batch,
      ]);
      for (const line of result.stdout.split('\n').filter(Boolean)) {
        const end = line.lastIndexOf('|');
        const stat = parseStatLine(line.slice(0, end));
        if (stat) {
          const identity = line.slice(end + 1).split(':');
          stats.set(stat.name, {
            ...stat,
            inode: identity.slice(0, 2).join(':'),
            uid: identity.length > 2 ? Number(identity[2]) : undefined,
          });
        }
      }
    }
    return stats;
  }

  async rawUsageMany(targets) {
    const usages = new Map();
    if (this.scanPolicy?.exclude.length) {
      for (const target of targets) {
        const expression = this.scanPolicy.exclude.flatMap((pattern, index) => [
          ...(index ? ['-o'] : []),
          /[/\\]/.test(pattern) ? '-path' : '-name',
          pattern.replaceAll('\\', '/'),
        ]);
        const found = await this.executor.run([
          'find',
          target,
          '-xdev',
          '-mindepth',
          '1',
          '(',
          ...expression,
          ')',
          '-print',
          '-quit',
        ]);
        for (const line of found.stdout.split('\n').filter(Boolean)) {
          this.scanPolicy.excludedPaths.add(line);
        }
        if (found.code !== 0) {
          this.scanPolicy.excludedPaths.add(target);
        }
      }
    }
    for (const batch of batches(targets)) {
      const result = await this.sh(USAGE_MANY_SCRIPT, batch);
      for (const [target, body] of splitRecords(result.stdout)) {
        usages.set(target, parseUsage(body));
      }
    }
    return usages;
  }

  async readLink(target) {
    const result = await this.executor.run(['readlink', '--', target]);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async realPath(target) {
    const result = await this.executor.run(['readlink', '-f', '--', target]);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  async isRoot() {
    if (this.root === undefined) {
      const result = await this.executor.run(['id', '-u']);
      this.root = result.stdout.trim() === '0';
    }
    return this.root;
  }

  async findDirs(roots, { globs, maxDepth = 6, skipNames } = {}) {
    const matches = await this.#find(roots, 'd', globs, maxDepth, skipNames);
    const parents = [...new Set(matches.map((m) => path.posix.dirname(m)))];
    const listings = await this.listMany(parents);
    return matches.map((match) => {
      const parent = path.posix.dirname(match);
      const siblings = (listings.get(parent) ?? []).map(
        ({ name, type, mtimeMs }) => ({ name, type, mtimeMs })
      );
      return {
        path: match,
        name: path.posix.basename(match),
        parent,
        siblings,
      };
    });
  }

  findFiles(roots, { names, maxDepth = 6, skipNames } = {}) {
    return this.#find(roots, 'f', names, maxDepth, skipNames);
  }

  /**
   * Runs one `find` that prints entries of `type` matching `globs` (without
   * descending into matched directories) and prunes `skipNames`.
   */
  async #find(roots, type, globs, maxDepth, skipNames) {
    roots = roots.filter(
      (root) => !this.scanPolicy || this.scanPolicy.allows(root)
    );
    if (roots.length === 0 || globs.length === 0) {
      return [];
    }
    const skip = skipNames ?? this.skipNames ?? [];
    const pruneSkipped =
      skip.length > 0
        ? ['-type', 'd', '(', ...findNameExpression(skip), ')', '-prune', '-o']
        : [];
    const argv = [
      'find',
      ...roots,
      '-xdev',
      '-mindepth',
      '1',
      '-maxdepth',
      String(maxDepth),
      ...this.#prunePaths(),
      ...(type === 'd'
        ? ['-type', 'd', '(', ...findNameExpression(globs), ')', '-print']
        : []),
      ...(type === 'd' ? ['-prune', '-o'] : []),
      ...pruneSkipped,
      ...(type === 'f'
        ? ['-type', 'f', '(', ...findNameExpression(globs), ')', '-print']
        : ['-name', '']),
    ];
    const result = await this.executor.run(argv);
    return result.stdout
      .split('\n')
      .filter(
        (target) =>
          target && (!this.scanPolicy || this.scanPolicy.allows(target))
      );
  }

  #prunePaths() {
    const policy = this.scanPolicy;
    if (!policy) {
      return [];
    }
    const excluded = [
      ...policy.exclude,
      ...policy.pruned,
      '/var/lib/docker',
      '/var/lib/containerd',
      '/run/containerd',
      '/var/lib/containers',
      '/tmp/containerd-mount*',
    ];
    return excluded.flatMap((pattern) => [
      '(',
      /[/\\]/.test(pattern) ? '-path' : '-name',
      pattern,
      ')',
      '-prune',
      '-o',
    ]);
  }

  async remove(targets) {
    for (const batch of batches(targets)) {
      const result = await this.sh(REMOVE_SCRIPT, batch);
      if (result.code !== 0) {
        throw new Error(
          `rm failed in ${this.label}: ${result.stderr.trim() || result.code}`
        );
      }
    }
  }

  async processes() {
    const result = await (this.probeExecutor ?? this.executor).run([
      'sh',
      '-c',
      PROCESS_SCRIPT,
    ]);
    if (result.code !== 0) {
      return null;
    }
    const [selfPid, ...lines] = result.stdout.split('\n');
    return lines
      .map((line) =>
        /^(\d+)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/.exec(line)
      )
      .filter((m) => m && !m[2].startsWith('Z '))
      .map((m) => ({
        pid: Number(m[1]),
        startTime: m[2].split(' ')[1] || null,
        name: m[3],
        aliases: processAliases(m[4], m[5]),
        cwd: m[6] || null,
        command: m[7],
      }))
      .filter((proc) => String(proc.pid) !== selfPid.trim());
  }

  async openPaths() {
    let result = await (this.probeExecutor ?? this.executor).run([
      'sh',
      '-c',
      OPEN_PATHS_SCRIPT,
    ]);
    this.probeDiagnostic = null;
    if (
      result.code !== 0 &&
      this.executor.parent &&
      this.executor.containerId
    ) {
      const diagnostic = result.stderr.trim();
      trace(
        'retrying process inspection as privileged root',
        this.id,
        diagnostic
      );
      const inspector = containerExecutor(
        this.executor.parent,
        this.executor.containerId,
        { user: '0', privileged: true }
      );
      result = await inspector.run(['sh', '-c', OPEN_PATHS_SCRIPT]);
      if (result.code !== 0) {
        this.probeDiagnostic = `${diagnostic}; privileged inspection failed: ${result.stderr.trim()}`;
      } else {
        this.probeExecutor = inspector;
      }
    }
    this.unreadableProcesses = result.stderr
      .split('\n')
      .filter((line) => line.startsWith('DSS_UNREADABLE|'))
      .map((line) => {
        const [, pid, uid, name, ...command] = line.split('|');
        return {
          pid: Number(pid),
          uid: uid ? Number(uid) : null,
          name,
          command: command.join('|'),
        };
      });
    if (result.code !== 0) {
      this.probeDiagnostic ??= result.stderr.trim();
      if (!this.unreadableProcesses.length) {
        return null;
      }
      this.probeHint =
        'some processes could not be inspected; run as root for full verification';
    }
    return new Set(
      result.stdout
        .split('\n')
        .filter((line) => line.startsWith('/'))
        .map((line) => line.replace(/ \(deleted\)$/, ''))
    );
  }

  run(argv, options) {
    return this.executor.run(argv, options);
  }

  async which(command) {
    const result = await this.sh(`command -v ${shellQuote(command)}`);
    return result.code === 0 && result.stdout.trim() !== '';
  }

  async diskUsage(target) {
    const result = await this.executor.run(['df', '-Pk', target]);
    return result.code === 0 ? parseDf(result.stdout) : null;
  }
}
