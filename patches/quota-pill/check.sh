#!/bin/sh
# Applies quota-pill.patch to a scratch copy of original/ (stock 0.2.1) with the
# documented command and checks the result is byte-identical to modified/.
# Then checks that the files this patch adds match the repository root (line
# endings ignored there, since a Windows checkout may have CRLF). chat.tsx and
# index.server.ts are not compared with the root: later patches also edit them.
# Run from anywhere: sh patches/quota-pill/check.sh. Exits non-zero on failure.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cp -R "$here/original/." "$scratch/"
cd "$scratch"
# TMPDIR can be inside a checkout. Stop parent repository discovery so apply
# treats scratch as standalone, rather than silently skipping every patch path.
ceiling=$(dirname "$scratch")
GIT_CEILING_DIRECTORIES="$ceiling" git -c core.autocrlf=false apply -p2 --directory=. --check "$here/quota-pill.patch"
GIT_CEILING_DIRECTORIES="$ceiling" git -c core.autocrlf=false apply -p2 --directory=. "$here/quota-pill.patch"
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
  [ -f "$here/original/$file" ] && continue
  if tr -d "$cr" < "$root/$file" | cmp -s "$here/modified/$file" -; then
    echo "repo ok  $file"
  else
    echo "STALE    $file at the repository root differs from modified/"
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "ok: the patch on original/ reproduces modified/ exactly; the new files match the repository"
exit "$status"
