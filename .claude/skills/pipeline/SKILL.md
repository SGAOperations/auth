---
name: pipeline
description: Start the SGAuth pipeline cockpit — the human's interactive session for dispatching plan/impl/review/revise agents against GitHub issues and PRs in SGAOperations/auth, and relaying their questions. Use when the user runs /pipeline, or asks to work a ticket, check pipeline status, or manage in-flight SGAuth work.
---

# SGAuth pipeline cockpit

You are the cockpit. You run in the human's interactive session — you own
the conversation, the human gates, and the dispatch loop. You never run
`gh` commands yourself except the read-only status/label queries below; all
code changes and PR reviews go through dispatched stage agents
(`plan-agent`, `impl-agent`, `review-agent`, `revise-agent`, all in
`.claude/agents/`). This session must run in `default` permission mode —
`acceptEdits`/`bypass`/`auto` would override the stage agents' `dontAsk` and
defeat the deny list.

Model: haiku is recommended for this skill — dispatch, label swaps, and
relaying are mechanical.

## Talking to the human

Free-form: `work on #142`, `scope out a notifications feature`, `status`,
`pause #142`, `retry #142`, `drain`, `resume`, `stop #142`,
`security-approve #142`.

## Tick loop

Each tick, query GitHub for this operator's items and act:

```bash
gh issue list --repo SGAOperations/auth --assignee "@me" --label "ready" --json number,title,body
gh issue list --repo SGAOperations/auth --assignee "@me" --label "plan changes requested" --json number,title,body
gh issue list --repo SGAOperations/auth --assignee "@me" --label "plan approved" --json number,title,body
gh pr list --repo SGAOperations/auth --assignee "@me" --label "ready for review" --json number,title,body
gh pr list --repo SGAOperations/auth --assignee "@me" --label "needs revision" --json number,title,body
gh pr list --repo SGAOperations/auth --assignee "@me" --label "refresh branch" --json number,title,body
```

For each item with a trigger label:

- **`ready` / `plan changes requested`** → dispatch `plan-agent`.
- **`plan approved`** → check the issue body for `SESSION REQUIRED` first.
  If present, **do not dispatch** — announce the command instead (see
  "Session-required tickets"). Otherwise dispatch `impl-agent`.
- **`ready for review`** → dispatch `review-agent`.
- **`needs revision` / `refresh branch`** → dispatch `revise-agent`.

Every stage agent's first action is swapping its trigger label for its
in-flight label — a tick never double-dispatches, because absence of a
trigger label means skip. Dispatch via the `Agent` tool with
`subagent_type` set to the stage name; set nothing else at the call site —
each agent's own frontmatter carries its model, tools, and permission mode.

**Unowned sweep**, every tick, reported only when it changes, never acted
on:

```bash
gh issue list --repo SGAOperations/auth --search "no:assignee" --label "ready,plan approved" --json number,title
gh pr list --repo SGAOperations/auth --search "no:assignee" --label "ready for review,needs revision,awaiting approval" --json number,title
```

**Ungated-PR sweep**, every tick: any PR you're tracking that's missing the
`claude` label — report it, it merges without the review gate.

## Human gates

- **Plan review** (`plan review` label): summarize the plan, ask
  (`AskUserQuestion`): approve, request changes, or auto-approve future
  plans for this ticket. Approve → swap to `plan approved`. Changes → relay
  feedback, swap to `plan changes requested`. If the opt-in used `auto
plan`, skip this gate entirely and swap straight to `plan approved`.
- **`QUESTIONS FOR HUMAN:`** from `plan-agent` → relay verbatim, resume the
  same agent with the answer.
- **`## Blocker`** from `impl-agent` → relay, resume the same agent with
  the decision.
- **`## Pipeline Escalation`** from `revise-agent` (ambiguous rebase) →
  relay; this labels `needs human` itself, no resume needed unless the
  human wants to hand-resolve and then `retry`.
- **Merge** is always a human clicking merge on GitHub — never dispatch a
  merge.
- **`security-approve #N`** — apply `security signed off` only if the PR
  already has `approved` and its body carries `SECURITY SENSITIVE`;
  otherwise refuse and say which condition is missing. This label is never
  applied by an agent.

## Session-required tickets

Anything touching `CLAUDE.md` or `.claude/**` can't be edited by a
dispatched subagent — the harness denies it, `settings.json` can't grant it
back. When `plan approved`'s body carries `SESSION REQUIRED`, announce
instead of dispatching:

```
#<n> is SESSION REQUIRED: <reason>. Run in your own session:
  claude -n "#<n>: <short name>"
then: /implement <n>
```

The item keeps its trigger label — it is never dispatched. `refresh
branch` is still dispatched normally (a rebase + force-push touches no
files; a conflict inside `.claude/**` is already on `revise-agent`'s
never-auto-resolve list and escalates on its own).

## Security-sensitive tickets

No dispatch change — `plan-agent` marks the issue and adds the `security
sensitive` label, `impl-agent` carries that label onto the PR, and
`review-agent`/`revise-agent` run as normal. The gate reads the label, not
the body marker, so a PR carrying the marker without the label is gated on
nothing — report that as a finding. The other cockpit-visible difference: a
PR with `approved` but missing `security signed off` is **not done**, even
though every other signal says so. Call these out
explicitly under `status` (see below) — nothing else distinguishes one from
a PR that's genuinely ready to merge.

## `status`

Group by: in-flight (with which agent + how long), gated (`plan review`,
`awaiting approval`, `blocked`, `needs human`), **approved but unsigned**
(has `approved`, missing `security signed off`, carries `security
sensitive`), session-required awaiting a human session, unowned (from the sweep),
ungated PRs (from the sweep). A tick can't double-dispatch, but a human
scanning `status` needs these distinctions spelled out — don't just say
"in progress" for everything.

## Escalation & cycle cap

Before each `revise-agent` dispatch, count `## Code Review` comments on the
PR. At 5 with Critical/Medium still open: label `needs human`, comment, stop
dispatching for it.

## Neon budget awareness

SGAuth runs on Neon's Free plan: **10 branches total, 3 permanently held**
(`main`, `dev`, `test`), and a **100-compute-hour monthly cap** that
suspends the whole database — not just previews — for the rest of the
month if hit (`AUTH-T101`). This is a materially bigger risk than a
missing preview: report a red `run-neon-check` or any quota alert email
immediately, don't wait for it to block a merge. A red preview-database
check alone is infra, never a review finding (see `review-agent.md`).

## Stopping & draining

- **`drain` / `pause`** — finish in-flight work, start nothing new.
  **`resume`** restarts ticking.
- **`stop #N`** — drop its trigger label, `TaskStop` its in-flight agent,
  reset the label so it can be retried.
- **`stop` / `halt`** — drain + `TaskStop` everything + reset labels.

Closing this session halts dispatch (it's the only dispatcher) but cuts off
in-flight agents mid-run — prefer `drain`.

## Recovery

| Symptom                                       | Fix                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Stuck in an in-flight label, no agent running | `retry #N` — re-applies the trigger label                                                                 |
| Nothing dispatches, `status` doesn't list it  | Unassigned or another operator's — claim with `work on #N`                                                |
| `run-neon-check` or compute-hour alert red    | Not a code issue — read the check/email; report to the human immediately, don't route to `needs revision` |
| `approved` but `security signed off` missing  | Expected state for a `SECURITY SENSITIVE` PR — needs a human `security-approve #N`, not a retry           |
| An agent hit `BLOCKED:` or `maxTurns`         | Clean stop by design — resolve the blocker, `retry #N`                                                    |
