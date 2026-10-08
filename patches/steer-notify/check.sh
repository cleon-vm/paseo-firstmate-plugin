#!/bin/sh
# Reproduce the overlay from original/ and compare all stored and root files.
# Scratch is retained for inspection. Run with sh patches/steer-notify/check.sh.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
scratch=$(mktemp -d)
cp -R "$here/original/." "$scratch/"
cd "$scratch"
ceiling=$(dirname "$scratch")
GIT_CEILING_DIRECTORIES="$ceiling" git -c core.autocrlf=false apply --check "$here/steer-notify.patch"
GIT_CEILING_DIRECTORIES="$ceiling" git -c core.autocrlf=false apply "$here/steer-notify.patch"
cr=$(printf '\r')
for file in $(cd "$here/modified" && find . -type f | sort); do
  cmp "$here/modified/$file" "$scratch/$file"
  tr -d "$cr" < "$root/$file" | cmp "$here/modified/$file" -
  echo "same and repo ok  $file"
done
extra=$(find . -type f | sort | while read -r file; do [ -f "$here/modified/$file" ] || echo "$file"; done)
[ -z "$extra" ] || { echo "not in modified/: $extra"; exit 1; }
# The base is the tree after the status-report overlay: the file both edit must be its result.
cmp "$here/original/index.server.ts" "$here/../status-line-reads/modified/index.server.ts"
echo "base ok           ./index.server.ts is the status-report overlay's result"
echo "ok: overlay reproduces modified/ exactly; all eleven files match the repository"
