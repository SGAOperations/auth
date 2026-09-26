#!/usr/bin/env bash
# Label setup for SGAOperations/auth. Run from anywhere with gh
# authenticated against that repo. Safe to re-run: an existing label is
# reported as a skip, and --force updates its color/description to match
# this file.
#
# It distinguishes "already exists" from a real failure (unauthenticated,
# no permission, rate-limited) and exits non-zero if any label could not be
# created, rather than reporting every error as a harmless skip.
set -uo pipefail

REPO="SGAOperations/auth"
failed=0

create() {
  local name="$1" color="$2" desc="$3" out
  if out=$(gh label create "$name" --repo "$REPO" --color "$color" \
             --description "$desc" --force 2>&1); then
    echo "ok: $name"
  elif grep -qi "already exists" <<<"$out"; then
    echo "skip (exists): $name"
  else
    echo "FAILED: $name — $out" >&2
    failed=1
  fi
}

# Issue labels
create "claude"                   "5319E7" "Claude is handling this ticket"
create "ready"                    "0E8A16" "Dispatch plan-agent"
create "planning"                 "FBCA04" "Plan being researched/written"
create "plan review"              "D93F0B" "Plan written — awaiting human approval"
create "plan changes requested"   "D93F0B" "Dispatch plan-agent in revision mode"
create "plan approved"            "0E8A16" "Dispatch impl-agent"
create "auto plan"                "C5DEF5" "Plan gate skipped: auto-approved"
create "in progress"              "FBCA04" "Implementation underway"
create "pr opened"                "0E8A16" "PR open; state tracked on the PR"
create "blocked"                  "B60205" "Needs human decision"
create "security sensitive"       "B60205" "Touches login/sessions/tokens/credentials/authorization — gates on 'security signed off' as well as 'approved'. Set from the plan's SECURITY SENSITIVE marker; the merge gate reads this label, not the PR body."

# PR labels
create "ready for review"         "0E8A16" "Dispatch review-agent"
create "reviewing"                "FBCA04" "Review underway"
create "needs revision"           "D93F0B" "Dispatch revise-agent"
create "revising"                 "FBCA04" "Fixes underway"
create "awaiting approval"        "C5DEF5" "Review passed the cycle's bar — awaiting a human 'approved'"
create "approved"                 "0E8A16" "Human sign-off to merge — never set by an agent; the merge gate rejects it if an app/bot applied it"
create "security signed off"      "5319E7" "Human security sign-off — required alongside approved on SECURITY SENSITIVE PRs, never set by an agent"
create "needs human"              "B60205" "Cycle cap hit or ambiguous rebase — pipeline stops"
create "refresh branch"           "C5DEF5" "Dispatch revise-agent in refresh mode"
create "refreshing"               "FBCA04" "Branch refresh underway"

if [ "$failed" -ne 0 ]; then
  echo >&2
  echo "One or more labels could not be created — see FAILED lines above." >&2
  echo "The merge gate reads 'approved', 'security signed off' and" >&2
  echo "'security sensitive'; it cannot work until those exist." >&2
  exit 1
fi

echo "Done. Branch protection on 'dev' and 'main' should require the"
echo "'Approval Check / check-approval' status check. Do NOT add"
echo "'Neon Branch Check / run-neon-check' as a required check."
