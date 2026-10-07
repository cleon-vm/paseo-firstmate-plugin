#!/bin/sh
# Reproduce the overlay from original/ and compare all stored and root files.
# Scratch is retained for inspection. Run with sh patches/status-line-reads/check.sh.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
scratch=$(mktemp -d)
cp -R "$here/original/." "$scratch/"
cd "$scratch"
ceiling=$(dirname "$scratch")
GIT_CEILING_DIRECTORIES="$ceiling" git -c core.autocrlf=false apply --check "$here/status-line-reads.patch"
GIT_CEILING_DIRECTORIES="$ceiling" git -c core.autocrlf=false apply "$here/status-line-reads.patch"
cr=$(printf '\r')
for file in $(cd "$here/modified" && find . -type f | sort); do
  cmp "$here/modified/$file" "$scratch/$file"
  tr -d "$cr" < "$root/$file" | cmp "$here/modified/$file" -
  echo "same and repo ok  $file"
done
extra=$(find . -type f | sort | while read -r file; do [ -f "$here/modified/$file" ] || echo "$file"; done)
[ -z "$extra" ] || { echo "not in modified/: $extra"; exit 1; }
echo "ok: overlay reproduces modified/ exactly; all four files match the repository"
