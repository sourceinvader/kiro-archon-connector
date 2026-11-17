#!/usr/bin/env bash
# Lists the files that must not change while step definitions are written for a ticket,
# with a hash of each: "<sha256>  <path>", sorted. Run from the suite directory.
#
# Usage: freeze-list.sh <TICKET>
#
# Frozen: the ticket's feature files, every step file outside steps/<TICKET>/ (other
# tickets' and shared steps), playwright.config.ts and package.json (a config edit can
# switch checks off: missingSteps, tags, retries). The workflow saves this list when it
# freezes the feature and compares it before every test run.
set -eu
T=${1:?usage: freeze-list.sh <TICKET>}
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

{
  [ -d "features/$T" ] && find "features/$T" -type f -name '*.feature'
  [ -d steps ] && find steps -type f ! -path "steps/$T/*"
  printf '%s\n' playwright.config.ts package.json
} | LC_ALL=C sort -u | while IFS= read -r f; do
  if [ -f "$f" ]; then printf '%s  %s\n' "$(sha < "$f")" "$f"; else printf 'missing  %s\n' "$f"; fi
done
