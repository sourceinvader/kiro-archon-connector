#!/usr/bin/env bash
# Reads playwright-bdd's Cucumber JSON report and prints one line of JSON:
#
#   executions  scenario runs in the report (3 per scenario with --repeat-each=3)
#   first_bad   per scenario run, the first step status that is not "passed" ("passed" if
#               none), counted: {"passed": 4, "failed": 2}. Any key other than passed or
#               failed (skipped, pending, undefined, ambiguous) means a step did not really
#               run, and the run must not count as green.
#   failing     every failed step: {step: "<feature-uri>:<line>", text, scenario, kind, error}
#               Hooks have no line and show as "hook:Before" / "hook:After"; a hook failure
#               is always the test code's fault, never the feature's.
#
# kind is a first guess from the error text:
#   locator         strict mode violation: the locator matched several elements
#   not-found       the element was never found
#   value-mismatch  the element was found but showed a different value (Expected/Received);
#                   the one kind that can mean the app and the spec disagree
#   timeout         an action or wait timed out
#   error           anything else (exceptions, network errors, ...)
#
# Usage: test-report.sh <cucumber.json>
set -eu
report=${1:?usage: test-report.sh <cucumber.json>}

jq -c '
  def kind:
    if test("strict mode violation") then "locator"
    elif test("element\\(s\\) not found") then "not-found"
    elif test("Expected") and test("Received") then "value-mismatch"
    elif test("[Tt]imeout|timed out") then "timeout"
    else "error" end;
  [ .[] as $f | $f.elements[] | . + {uri: $f.uri} ] as $els
  | ($els | map(select(.type != "background"))) as $runs
  | {
      executions: ($runs | length),
      first_bad: ($runs
        | map([.steps[] | select(.line != null) | .result.status | select(. != "passed")][0] // "passed")
        | group_by(.) | map({key: .[0], value: length}) | from_entries),
      failing: [ $els[] as $e | $e.steps[] | select(.result.status == "failed")
        | { step: (if .line != null then "\($e.uri):\(.line)" else "hook:\(.keyword)" end),
            text: "\(.keyword)\(.name // "")",
            scenario: $e.name,
            kind: ((.result.error_message // "") | kind),
            error: ((.result.error_message // "") | gsub("\u001b\\[[0-9;]*m"; "") | .[0:600]) } ]
    }
' "$report"
