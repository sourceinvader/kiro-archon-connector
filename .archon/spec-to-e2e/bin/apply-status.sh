#!/usr/bin/env bash
# Writes the browser check's verdicts into a ticket's feature files as tags.
#
# Usage: apply-status.sh <feature-dir> <status-file>
#   status-file  one line per scenario that is NOT confirmed: <scenario name><TAB><status>
#                where status is app-mismatch, unreachable, needs-test-hook or unexplored.
#
# First removes every status tag (@app-mismatch @unreachable @needs-test-hook @unexplored
# @flagged) from every tag line, then adds @<status> to the tag line directly above each
# listed scenario. Only bash writes these tags, never the model: a model that tagged a hard
# scenario @unreachable would quietly take it out of the suite. The test run excludes them.
set -eu

dir=${1:?usage: apply-status.sh <feature-dir> <status-file>}
status_file=${2:?usage: apply-status.sh <feature-dir> <status-file>}

for f in "$dir"/*.feature; do
  [ -f "$f" ] || continue
  awk -v SF="$status_file" '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
    BEGIN {
      FS = "\t"
      while ((getline line < SF) > 0) { split(line, a, "\t"); if (a[1] != "") st[a[1]] = a[2] }
      FS = " "
    }
    { lines[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        t = trim(lines[i])
        if (t ~ /^@/) {                       # drop status tags, keep the rest and the indent
          match(lines[i], /^[ \t]*/); indent = substr(lines[i], 1, RLENGTH)
          n = split(t, tags, /[ \t]+/); out = ""
          for (j = 1; j <= n; j++)
            if (tags[j] !~ /^@(app-mismatch|unreachable|needs-test-hook|unexplored|flagged)$/)
              out = out (out == "" ? "" : " ") tags[j]
          lines[i] = indent out
        }
      }
      for (i = 1; i <= NR; i++) {
        t = trim(lines[i])
        if (t ~ /^Scenario( Outline)?:/ && i > 1 && trim(lines[i - 1]) ~ /^@/) {
          name = t; sub(/^Scenario( Outline)?:[ \t]*/, "", name)
          if (name in st) lines[i - 1] = lines[i - 1] " @" st[name]
        }
      }
      for (i = 1; i <= NR; i++) print lines[i]
    }
  ' "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
done
