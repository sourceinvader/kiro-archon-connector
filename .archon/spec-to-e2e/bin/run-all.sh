#!/usr/bin/env bash
# Works through a folder of spec folders, one kiro-spec-to-e2e run per spec, one at a time.
# Safe to stop (Ctrl-C) and start again: the state files in the suite say what is done.
#
# Usage: .archon/spec-to-e2e/bin/run-all.sh <specs-root> <base-url> [options]
#   --suite DIR           the suite folder (default: acceptance)
#   --jira-projects RE    Jira project keys, e.g. 'PROJ|CORE' (default: any)
#   --limit N             start at most N runs, then stop
#   --retry STATUSES      also re-run tickets with these statuses, comma-separated:
#                         flagged, needs-human, error (default: none)
#   --commit              pass commit=yes, so each run commits its ticket's files
#   --dry-run             only print what would run
#
# A spec folder runs when its ticket has no state file, or the state file is for an older
# version of the spec (spec_sha differs), or its status is listed in --retry. Tickets that
# are done or no-e2e for this exact spec are skipped. Run it from the repository root.
#
# Prints one line per spec folder (RUN, SKIP, HELD, BAD) and a status count at the end.
# Each run's console output goes to <suite>/reports/runs/<TICKET>.log (gitignored).
set -u

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 2 ] || usage
root=${1%/}
base_url=$2
shift 2
suite=acceptance
projects=any
limit=0
retry=","
commit=no
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --suite) suite=${2:?}; shift 2 ;;
    --jira-projects) projects=${2:?}; shift 2 ;;
    --limit) limit=${2:?}; shift 2 ;;
    --retry) retry=",${2:?},"; shift 2 ;;
    --commit) commit=yes; shift ;;
    --dry-run) dry=1; shift ;;
    *) usage ;;
  esac
done

bin=$(cd "$(dirname "$0")" && pwd)
[ -d "$root" ] || { echo "not a directory: $root" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "jq is not installed" >&2; exit 2; }
logs="$suite/reports/runs"
mkdir -p "$logs"
seen=""
started=0

for d in "$root"/*/; do
  d=${d%/}
  if ! info=$(bash "$bin/resolve-ticket.sh" "$d" "$projects" 2>&1); then
    echo "BAD   $d: $info"
    continue
  fi
  ticket=$(printf '%s' "$info" | jq -r '.ticket')
  sha=$(printf '%s' "$info" | jq -r '.spec_sha')
  case " $seen " in
    *" $ticket "*) echo "BAD   $d: ticket $ticket already came from another folder in this pass"; continue ;;
  esac
  seen="$seen $ticket"

  state="$suite/state/$ticket.json"
  if [ -f "$state" ] && [ "$(jq -r '.spec_sha' "$state")" = "$sha" ]; then
    status=$(jq -r '.status' "$state")
    case "$status" in
      done|no-e2e) echo "SKIP  $ticket ($status)"; continue ;;
    esac
    case "$retry" in
      *",$status,"*) ;;
      *) echo "HELD  $ticket ($status: $(jq -r '.reason' "$state")); --retry $status to run it again"; continue ;;
    esac
  fi

  if [ "$limit" -gt 0 ] && [ "$started" -ge "$limit" ]; then
    echo "LIMIT reached ($limit runs); stopping"
    break
  fi
  started=$((started + 1))
  echo "RUN   $ticket ($d)"
  [ "$dry" -eq 1 ] && continue

  archon workflow run kiro-spec-to-e2e --no-worktree \
    --input spec_dir="$d" --input base_url="$base_url" --input suite_dir="$suite" \
    --input jira_projects="$projects" --input commit="$commit" \
    > "$logs/$ticket.log" 2>&1
  code=$?
  if [ -f "$state" ] && [ "$(jq -r '.spec_sha' "$state")" = "$sha" ]; then
    echo "      -> $(jq -r '.status + " (" + .reason + ")"
      + (if (.to_review // 0) > 0 then ", \(.to_review) scenario(s) to review" else "" end)' "$state")"
  else
    echo "      -> no state file written (exit $code); see $logs/$ticket.log"
  fi
done

echo
echo "Tickets by status in $suite/state:"
if ls "$suite"/state/*.json >/dev/null 2>&1; then
  jq -r '.status' "$suite"/state/*.json | sort | uniq -c
else
  echo "  none yet"
fi
