## Problem

On Windows, `Deno.utimeSync`, `Deno.utime` and `node:fs` `utimesSync` / `utimes` fail on a read-only file:

```
PermissionDenied: Access is denied. (os error 5): utime 'C:\Users\RUNNER~1\AppData\Local\Temp\dss-git-tracked-MEkmGU\app\.git\objects\61\03f30c97bac9a4996749d38da306571af0256c'
    at Object.utimeSync (ext:deno_fs/30_fs.js:1:6837)
```

Node and Bun set the times on the same file without trouble. Git writes its objects read-only, so any tool that dates a repository, such as a test that ages a fixture, fails only on Deno on Windows: [disk-space-saviour#31](https://github.com/link-foundation/disk-space-saviour/issues/31), job [114065863321](https://github.com/link-foundation/disk-space-saviour/actions/runs/38003106785/job/114065863321).

`ext/fs/std_fs.rs` implements `utime_sync` and `utime_async` with `filetime::set_file_times(path, atime, mtime)`. On Windows, filetime opens the path with `OpenOptions::new().write(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS)` (`src/windows.rs`, `open`). That is `GENERIC_WRITE`, which Windows refuses for a file with `FILE_ATTRIBUTE_READONLY`.

`SetFileTime` only needs `FILE_WRITE_ATTRIBUTES`. libuv, and so Node, opens the file with exactly that access (`src/win/fs.c`, `fs__utime_impl_from_path`: `CreateFileW(path, FILE_WRITE_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, flags, NULL)` with `flags = FILE_FLAG_BACKUP_SEMANTICS`, then `fs__utime_handle` on that handle).

## Reproduce

On Windows:

```js
// probe.mjs
import { chmodSync, utimesSync, writeFileSync } from 'node:fs';

writeFileSync('ro.txt', 'x');
chmodSync('ro.txt', 0o444);
const when = new Date(Date.now() - 3_600_000);
utimesSync('ro.txt', when, when);
console.log('ok');
```

```sh
node probe.mjs          # ok
deno run -A probe.mjs   # PermissionDenied: Access is denied. (os error 5): utime 'ro.txt'
```

## Workaround

If the call fails on a read-only file, temporarily add the write bit:

```js
const { mode } = statSync(file);
chmodSync(file, mode | 0o200);
try {
  utimesSync(file, atime, mtime);
} finally {
  chmodSync(file, mode);
}
```

Clearing and restoring the attribute does not change the times you just set.

## Suggested fix

On Windows, open the file with only `FILE_WRITE_ATTRIBUTES`, then set the times on the handle:

```rust
#[cfg(windows)]
fn utime(path: &Path, atime: FileTime, mtime: FileTime) -> io::Result<()> {
  use std::os::windows::fs::OpenOptionsExt;
  const FILE_WRITE_ATTRIBUTES: u32 = 0x100;
  const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
  let file = std::fs::OpenOptions::new()
    .access_mode(FILE_WRITE_ATTRIBUTES)
    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
    .open(path)?;
  filetime::set_file_handle_times(&file, Some(atime), Some(mtime))
}
```

The same change in filetime's `windows::open` would fix every caller. Rust's `File::set_times`, stable since 1.75, is another option once the file is opened like this.
