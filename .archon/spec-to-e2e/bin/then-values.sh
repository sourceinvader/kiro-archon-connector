#!/usr/bin/env bash
# Prints every quoted expected value in the Then part of the scenarios in a folder of
# feature files, one per line, sorted (duplicates kept).
#
# Usage: then-values.sh <feature-dir>
#
# The Then part is a Then step and the And/But steps that follow it. Comparing this list
# before and after a revision shows whether the model changed WHAT a scenario expects
# (not allowed) rather than HOW it is checked (allowed): every value present before must
# still be present after. New values may appear, because a revised feature goes through
# the browser check again before any test runs.
set -eu
dir=${1:?usage: then-values.sh <feature-dir>}

for f in "$dir"/*.feature; do
  [ -f "$f" ] || continue
  awk '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
    { l = trim($0) }
    l ~ /^(Scenario|Scenario Outline|Background|Rule|Examples):/ { inthen = 0 }
    l ~ /^(Given|When) / { inthen = 0 }
    l ~ /^Then / { inthen = 1 }
    inthen && l ~ /^(Then|And|But) / {
      s = l
      while (match(s, /"[^"]*"/)) { print substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH) }
    }
  ' "$f"
done | LC_ALL=C sort
