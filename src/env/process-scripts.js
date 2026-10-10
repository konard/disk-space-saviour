/** Read-only probes shared by local identity retries and Docker adapters. */
export const OPEN_PATHS_SCRIPT = `failed=0
[ "$#" -gt 0 ] || set -- /proc/[0-9]*
for p do
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
    gid=$(awk '/^Gid:/{print $2}' "$p/status" 2>/dev/null)
    printf 'DSS_GID|%s|%s\\n' "\${p#/proc/}" "$gid" >&2
    command=$(tr '\\000' ' ' < "$p/cmdline" 2>/dev/null)
    printf 'DSS_UNREADABLE|%s|%s|%s|%s\\n' "\${p#/proc/}" "$uid" "$(cat "$p/comm" 2>/dev/null)" "$command" >&2
    failed=1
  fi
done
exit "$failed"`;
