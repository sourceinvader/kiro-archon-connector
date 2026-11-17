#!/usr/bin/env bash
# Checks one ticket's step definitions for ways to make a failing test look green.
# Run from the suite directory.
#
# Usage: bash scripts/lint-steps.sh <TICKET>
#
# Prints STEPS-OK and exits 0, or STEPS-FAIL and the offending lines and exits 1.
# Rejected in steps/<TICKET>/:
#   test.skip/fixme/fail/only, testInfo.skip/fail/fixme, $test.   skip or invert the test
#   expect.soft                                                   failure no longer stops it
#   try/catch, .catch(                                            swallows the failure
#   waitForTimeout                                                sleeps instead of waiting for a state
#   tags:                                                         step scoping that can hide steps
#   a literal http(s):// URL                                      ties the test to one server; use
#                                                                 paths relative to baseURL (BASE_URL)
# None of this proves an assertion is strong enough; the frozen, quoted Then values do the
# rest (see scripts/lint-features.sh).
set -u
T=${1:?usage: lint-steps.sh <TICKET>}
dir="steps/$T"

if ! find "$dir" -type f -name '*.ts' 2>/dev/null | grep -q .; then
  echo "STEPS-FAIL"
  echo "no .ts step files in $dir"
  exit 1
fi

pattern='test\.(skip|fixme|fail|only)|testInfo\.(skip|fail|fixme)|\$test\.|expect\.soft|(^|[^A-Za-z0-9_])catch([^A-Za-z0-9_]|$)|waitForTimeout|(^|[^A-Za-z0-9_])tags[[:space:]]*:|https?://'
hits=$(grep -rnE "$pattern" "$dir" --include='*.ts' || true)

if [ -n "$hits" ]; then
  echo "STEPS-FAIL"
  printf '%s\n' "$hits"
  exit 1
fi
echo "STEPS-OK"
