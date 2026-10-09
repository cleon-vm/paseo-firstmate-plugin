#!/bin/sh
# Applies files-images.patch to a scratch copy of original/ with the documented
# command and checks the result is byte-identical to modified/. original/ is
# 0.3.4 with the quota pill and Windows watches.
# Then checks each file in modified/: where a later overlay edits it, against
# that overlay's original/ (its base); otherwise against the repository root
# (line endings ignored there, since a Windows checkout may have CRLF).
# Scratch is retained for inspection. Run from anywhere:
# sh patches/files-images/check.sh. Exits non-zero on failure.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
# Overlays applied after this one, in order.
later="notification-relay reveal-in-explorer chat-input-lag steer-box-click status-line-reads steer-notify permission-broker"
scratch=$(mktemp -d)
cp -R "$here/original/." "$scratch/"
cd "$scratch"
# TMPDIR can be inside a checkout. Stop parent repository discovery so apply
# treats scratch as standalone, rather than silently skipping every patch path.
ceiling=$(dirname "$scratch")
GIT_CEILING_DIRECTORIES="$ceiling" git -c core.autocrlf=false apply --check "$here/files-images.patch"
GIT_CEILING_DIRECTORIES="$ceiling" git -c core.autocrlf=false apply "$here/files-images.patch"
status=0
cr=$(printf '\r')
for file in $(cd "$here/modified" && find . -type f | sort); do
  applied=$file
  if ! cmp -s "$here/modified/$file" "$scratch/$applied"; then
    echo "DIFFERS  $applied"
    status=1
    continue
  fi
  next=""
  for overlay in $later; do
    if [ -f "$here/../$overlay/original/$applied" ]; then next=$overlay; break; fi
  done
  if [ -n "$next" ]; then
    if cmp -s "$here/modified/$file" "$here/../$next/original/$applied"; then
      echo "same, base ok  $applied (next edited by $next)"
    else
      echo "BASE     $applied differs from $next's original/"
      status=1
    fi
  elif tr -d "$cr" < "$root/$applied" | cmp -s "$here/modified/$file" -; then
    echo "same, repo ok  $applied"
  else
    echo "STALE    $applied at the repository root differs from modified/"
    status=1
  fi
done
extra=$(find . -type f | sort | while read -r file; do [ -f "$here/modified/$file" ] || echo "$file"; done)
[ -z "$extra" ] || { echo "not in modified/: $extra"; status=1; }
[ "$status" -eq 0 ] && echo "ok: the patch on original/ reproduces modified/ exactly; each file matches the repository or the next overlay's base"
exit "$status"
