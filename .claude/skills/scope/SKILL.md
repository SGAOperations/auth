---
name: scope
description: Scope out a new SGAuth feature or fix into a tracked epic and sub-tickets. Use when the user asks to scope, plan out, or break down new work for SGAuth ahead of dispatching the pipeline.
---

# Scope a new epic

Interactive — the human is in this conversation, unlike the dispatched
stages. Use the session's own model (opus/fable recommended over haiku for
this one).

1. Talk through the feature with the user: what, why, who it affects, which
   existing epic (E1–E13 in the SGAuth Technical Ticket Guide) it extends
   or whether it's new.
2. Check whether it's security-sensitive by the same rule `plan-agent`
   uses: does it touch login, sessions, tokens, credential storage,
   authorization, or the position/admin model? If so, say so up front — it
   will carry `SECURITY SENSITIVE` once ticketed, and the human should
   expect the sign-off gate on it.
3. Break it into tickets, dependency-ordered, each with: a ticket ID
   following the repo's `AUTH-Txx` convention (next free number), a
   priority (Urgent/High/Medium/Low), a Fibonacci point estimate, its
   dependencies, what it does, and a "Done when" line — same shape as every
   existing entry in the ticket guide.
4. Create the GitHub issues (`gh issue create --repo SGAOperations/auth
--body-file .temp/ticket-<id>.md`), linked and cross-referenced by
   number, left **unassigned** — opt-in (`work on #N` in the cockpit) is
   what claims and labels them, not scoping.
5. Report the created issue numbers back to the user; don't label them
   `ready` yourself.
