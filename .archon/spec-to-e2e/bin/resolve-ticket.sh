#!/usr/bin/env bash
# Works out which Jira ticket a spec folder belongs to, and fingerprints the folder.
#
# Usage: resolve-ticket.sh <spec-dir> [jira-projects]
#   jira-projects  the project keys a ticket ID may use, as an extended regex such as
#                  'PROJ|CORE'. "any" or empty allows any key, which also lets through
#                  look-alikes such as UTF-8 or SHA-256 in the related list, so set it.
#
# The ticket comes from, in this order:
#   1. the folder name: PROJ-123 or PROJ-123-anything
#   2. a file named TICKET in the folder
#   3. the only ticket ID mentioned anywhere in the folder's files
# Anything else fails with exit 2 and says why, rather than guessing.
#
# Prints one line of JSON:
#   {"ticket","spec_dir","spec_sha","files":[...],"related":[...]}
# spec_sha changes whenever any file in the folder changes, so a finished ticket can be
# re-run when its spec is edited. related lists the other ticket IDs the files mention.
set -eu

dir=${1:?usage: resolve-ticket.sh <spec-dir> [jira-projects]}
projects=${2:-any}
dir=${dir%/}

fail() { echo "resolve-ticket: $*" >&2; exit 2; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

[ -d "$dir" ] || fail "not a directory: $dir"
command -v jq >/dev/null 2>&1 || fail "jq is not installed"

case "$projects" in
  ''|any) key_re='[A-Z][A-Z0-9]+-[0-9]+' ;;
  *) key_re="($projects)-[0-9]+" ;;
esac

files=$(cd "$dir" && find . -type f ! -name '.*' | sed 's|^\./||' | LC_ALL=C sort)
[ -n "$files" ] || fail "no files in $dir"

# Every ticket ID mentioned in the files, once each. A key must not touch a letter, digit
# or hyphen on either side, so PROJ-12 is not read out of XPROJ-123.
mentioned=$(cd "$dir" && printf '%s\n' "$files" | while IFS= read -r f; do
  grep -ohE "(^|[^A-Za-z0-9-])$key_re([^A-Za-z0-9-]|$)" "$f" 2>/dev/null || true
done | grep -oE "$key_re" | LC_ALL=C sort -u || true)

name=$(basename "$dir")
ticket=$(printf '%s\n' "$name" | grep -oE "^$key_re" | head -n 1 || true)
if [ -z "$ticket" ] && [ -f "$dir/TICKET" ]; then
  ticket=$(grep -oE "$key_re" "$dir/TICKET" | head -n 1 || true)
  [ -n "$ticket" ] || fail "$dir/TICKET holds no ticket ID matching $key_re"
fi
if [ -z "$ticket" ]; then
  count=$(printf '%s' "$mentioned" | grep -c . || true)
  case "$count" in
    1) ticket=$mentioned ;;
    0) fail "no ticket ID in the folder name ($name), no TICKET file, and none in the files" ;;
    *) fail "the folder name ($name) has no ticket ID and the files mention several ($(printf '%s\n' "$mentioned" | paste -sd, -)); rename the folder or add a TICKET file" ;;
  esac
fi

spec_sha=$(cd "$dir" && printf '%s\n' "$files" | while IFS= read -r f; do
  printf '%s  %s\n' "$(sha < "$f")" "$f"
done | sha)

related=$(printf '%s\n' "$mentioned" | grep -vxF -- "$ticket" | grep . || true)

jq -cn \
  --arg ticket "$ticket" \
  --arg spec_dir "$dir" \
  --arg spec_sha "$spec_sha" \
  --arg files "$files" \
  --arg related "$related" \
  '{ticket: $ticket, spec_dir: $spec_dir, spec_sha: $spec_sha,
    files: ($files | split("\n") | map(select(length > 0))),
    related: ($related | split("\n") | map(select(length > 0)))}'
