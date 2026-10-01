---
name: implement
description: Run stage 2 (implement) or stage 4 (revise) for a SESSION REQUIRED SGAuth ticket, in the operator's own named session. Use when the cockpit has announced a session-required item and handed you this command.
---

# /implement — session-required tickets

Use only for an issue or PR the cockpit announced as `SESSION REQUIRED`
(touches `CLAUDE.md` or `.claude/**`). Run in a **named** session
(`claude -n "#N: <short name>"`) — never the main checkout.

1. Resolve which stage from the item's labels: `plan approved` on an issue
   → implement (follow `.claude/agents/impl-agent.md`, unmodified);
   `needs revision` or `refresh branch` on a PR → revise (follow
   `.claude/agents/revise-agent.md`, unmodified).
2. Create a worktree at `.claude/worktrees/impl-<n>` if one doesn't already
   exist. Never work in the main checkout — editing `.claude/` from the
   session that's using it mutates your live config mid-task, and the
   ticket may be editing the very agent file this session is following.
   Read the agent file's instructions by absolute path from the main
   checkout; every edit lands in the worktree copy.
3. Follow the agent file exactly, with one override: you are not
   `dontAsk` — this is your own interactive session, so normal prompting
   applies. Everything else (worktree isolation, commit format, PR body
   format, rebase protocol) is unchanged.
4. Repeat the `SESSION REQUIRED` marker in the PR description you write,
   directly under `Closes #N`, same as the issue.
5. When done, tell the user to reclaim the worktree with `/worktree-clean`
   once the PR merges.

**Always in a worktree — no exceptions, even for a one-line `.claude/`
edit.**
