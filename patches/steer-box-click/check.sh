#!/bin/sh
# Applies steer-box-click.patch to a scratch copy of original/ (stock 0.2.1) with the
# documented command and checks the result is byte-identical to modified/.
# Then checks that every file it changes or adds matches the repository root
# (line endings ignored there, since a Windows checkout may have CRLF). No
# other patch edits client/card.tsx, so the root copy is the patched one.
# Run from anywhere: sh patches/steer-box-click/check.sh. Exits non-zero on failure.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cp -R "$here/original/." "$scratch/"
cd "$scratch"
git -c core.autocrlf=false apply -p2 --directory=. --check "$here/steer-box-click.patch"
git -c core.autocrlf=false apply -p2 --directory=. "$here/steer-box-click.patch"
status=0
for file in $(cd "$here/modified" && find . -type f | sort); do
  if cmp -s "$here/modified/$file" "$scratch/$file"; then
    echo "same     $file"
  else
    echo "DIFFERS  $file"
    status=1
  fi
done
extra=$(find . -type f | sort | while read -r file; do [ -f "$here/modified/$file" ] || echo "$file"; done)
[ -z "$extra" ] || { echo "not in modified/: $extra"; status=1; }
cr=$(printf '\r')
for file in $(cd "$here/modified" && find . -type f | sort); do
  if tr -d "$cr" < "$root/$file" | cmp -s "$here/modified/$file" -; then
    echo "repo ok  $file"
  else
    echo "STALE    $file at the repository root differs from modified/"
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "ok: the patch on original/ reproduces modified/ exactly; the files match the repository"
exit "$status"
