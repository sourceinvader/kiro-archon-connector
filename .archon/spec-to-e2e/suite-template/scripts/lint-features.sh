#!/usr/bin/env bash
# Checks one ticket's feature files against the suite's rules. Run from the suite directory.
#
# Usage: bash scripts/lint-features.sh <TICKET>
#
# Prints LINT-OK and exits 0, or LINT-FAIL and one problem per line and exits 1.
# The workflow's model runs this itself after writing a feature, and a bash node runs it
# again as a gate, so the rules are the same for both.
#
# Rules:
#   - features/<TICKET>/ holds at least one .feature file.
#   - The line above each Feature: is a tag line with @<TICKET>.
#   - The line above each Scenario: is that scenario's tag line, with @<TICKET>, or with
#     @emergent and @origin-<TICKET> for behaviour found in the app that the spec missed.
#   - Scenario names are unique within the ticket (status tags are matched by name).
#   - Each scenario has a Then step, and every Then step quotes its expected value
#     ("..." or an Outline <placeholder>), so the expected outcome is data that can be
#     compared, not wording the model can soften.
#   - At most one When per scenario: one behaviour per scenario. Long journeys belong in a
#     separate @journey suite.
#   - No tag that skips or inverts a test: @skip @fixme @fail @only @slow @timeout:...
set -u
T=${1:?usage: lint-features.sh <TICKET>}
dir="features/$T"

problems=$(
  if ! ls "$dir"/*.feature >/dev/null 2>&1; then
    echo "no .feature files in $dir"
    exit 0
  fi
  for f in "$dir"/*.feature; do
    awk -v T="$T" -v F="$f" '
      function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
      function has(line, tag,   n, i, a) { n = split(line, a, /[ \t]+/); for (i = 1; i <= n; i++) if (a[i] == tag) return 1; return 0 }
      function problem(at, msg) { printf "%s:%d: %s\n", F, at, msg }
      function close_scenario() {
        if (scn != "") {
          if (thens == 0) problem(scnline, "scenario \"" scn "\" has no Then step")
          if (whens > 1) problem(scnline, "scenario \"" scn "\" has " whens " When steps: keep one behaviour per scenario")
        }
        scn = ""
      }
      {
        l = trim($0)
        if (l ~ /^@/ && (l ~ /(^|[ \t])@(skip|fixme|fail|only|slow)([ \t]|$)/ || l ~ /(^|[ \t])@timeout:/))
          problem(NR, "tag that skips or inverts a test: " l)
        if (l ~ /^Feature:/) {
          features++
          if (!(prev ~ /^@/ && has(prev, "@" T))) problem(NR, "the line above Feature: must be a tag line with @" T)
        }
        if (l ~ /^(Background|Rule):/) close_scenario()
        if (l ~ /^Scenario( Outline)?:/) {
          close_scenario()
          scn = l; sub(/^Scenario( Outline)?:[ \t]*/, "", scn); scnline = NR; thens = 0; whens = 0
          if (scn == "") { problem(NR, "scenario without a name"); scn = "(unnamed)" }
          if (!(prev ~ /^@/)) problem(NR, "scenario \"" scn "\" needs its tag line directly above it")
          else if (!has(prev, "@" T) && !(has(prev, "@emergent") && has(prev, "@origin-" T)))
            problem(NR, "scenario \"" scn "\" needs @" T " (or @emergent @origin-" T ") in its tag line")
        }
        if (scn != "" && l ~ /^When /) whens++
        if (scn != "" && l ~ /^Then /) {
          thens++
          if (l !~ /"[^"]+"/ && l !~ /<[^>]+>/) problem(NR, "Then step must quote its expected value: " l)
        }
        prev = l
      }
      END {
        close_scenario()
        if (!features) problem(1, "no Feature:")
      }
    ' "$f"
  done
  grep -hE '^[[:space:]]*Scenario( Outline)?:' "$dir"/*.feature \
    | sed -E 's/^[[:space:]]*Scenario( Outline)?:[[:space:]]*//; s/[[:space:]]+$//' \
    | LC_ALL=C sort | uniq -d | sed 's/^/duplicate scenario name: /'
)

if [ -n "$problems" ]; then
  echo "LINT-FAIL"
  printf '%s\n' "$problems"
  exit 1
fi
count=$(grep -hcE '^[[:space:]]*Scenario( Outline)?:' "$dir"/*.feature | awk '{s += $1} END {print s}')
echo "LINT-OK $count scenarios in $dir"
