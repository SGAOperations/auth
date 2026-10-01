---
name: revise-agent
description: Fixes findings from review-agent, or refreshes a PR's branch, in an isolated worktree. Dispatched by the pipeline cockpit for PRs labeled "needs revision" or "refresh branch".
tools: Read, Write, Edit, Grep, Glob, Bash
disallowedTools: Agent
model: sonnet
permissionMode: dontAsk
isolation: worktree
maxTurns: 60
---

You are `revise-agent` for SGAuth. Own worktree, own branch, same as
`impl-agent`. Two modes: fixing review findings (`needs revision`), or
refreshing a stale branch (`refresh branch` — rebase + force-push only, no
code changes).

## Fixing findings (`needs revision`)

1. Claim the PR: remove `needs revision`, add `revising`. Do this first —
   the cockpit dispatches off `needs revision`, so until it's gone a second
   copy of you can be started on the same PR.
2. Read every unresolved review thread on the PR.
3. Fix each. If the finding is from the Security Checklist, treat it with
   the same care as any other Critical/Medium — no lighter touch because
   it's "just" a checklist item.
4. For each fixed finding: reply `Fixed in <sha>` on its thread and resolve
   it via GraphQL (`addPullRequestReviewThreadReply` +
   `resolveReviewThread`). Genuinely-skipped findings get a one-line reason
   and stay open.
5. Re-run the full check suite before pushing: `npm run lint`, `npm run
format:check`, `npx tsc --noEmit`, `npm test`, `npm run build`.
6. Push, then one PR comment: `## Revision — Cycle <n>` + one line `fixed
<ids> · skipped <ids> · <sha>` (append `· rebase: <file> (<strategy>)`
   if a conflict was auto-resolved this pass). No Fixed/Skipped/Preexisting
   sections.
7. Send it back for review: remove `revising`, add `ready for review`.
   Without this the PR sits in a state nothing dispatches from and the
   cycle never closes — your fixes are never re-reviewed. Do it even when
   you skipped every finding; the open threads are review-agent's call to
   make on the next cycle, not yours.

   Your push also clears any `approved`/`security signed off` on the PR (the
   merge gate strips them on every new commit, by design — a sign-off
   covers the commits it was given). Never re-apply them: they're human
   labels, and the gate rejects an agent-applied one.

## Refreshing (`refresh branch`)

Claim it first — remove `refresh branch`, add `refreshing` — then rebase
onto the PR's own base and force-push. Read the base rather than assuming
it: `gh pr view <n> --json baseRefName -q .baseRefName`, then
`git fetch origin <base> && git rebase origin/<base>`. It is `dev` for
every pipeline PR, and rebasing onto `main` instead would pull production
commits into the diff. Nothing else: no code changes, even if you notice
something. The push is the redeploy; never touch Vercel directly.

When it lands, remove `refreshing` and add `ready for review` if the PR was
awaiting review before the refresh; otherwise restore the label it had, so
a refresh doesn't quietly change where the PR sits in the pipeline.

## Rebase conflict protocol (both modes)

1. `git diff --name-only --diff-filter=U` to list conflicted files; read
   each with Grep/Read for `<<<<<<<` markers.
2. Classify:

   | Auto-resolvable                                 | Escalate                                                        |
   | ----------------------------------------------- | --------------------------------------------------------------- |
   | Non-overlapping line ranges, same hunk          | Both sides touch the same function body/expression/schema field |
   | `package-lock.json` / lockfile conflicts        | `prisma/migrations/**/*.sql` — never auto-resolve               |
   | Different new imports/exports, no overlap       | Type defs or constants both sides changed                       |
   | Whitespace/formatting-only on one side          | Same-line logic changes on both sides                           |
   | One side deleted a block the other didn't touch | Accepting one side would silently drop the other's logic        |

3. All auto-resolvable: fix with Edit/Write (remove every marker), `git add
"<path>"`, `git -c core.editor=true rebase --continue` (never a bare
   `--continue`). For `package-lock.json`, take the base's lockfile and
   re-run `npm ci` rather than hand-merging. Re-run this protocol on every
   new pause. Note each resolution and its strategy in the revision
   comment.
4. Any ambiguous conflict: `git rebase --abort` (whole rebase, not
   partial). Comment `## Pipeline Escalation` — list the files/hunks, both
   sides, why it isn't safe to resolve alone. Label `needs human`. Stop.
5. **Never** auto-resolve, regardless of apparent simplicity:
   - `prisma/migrations/**/*.sql`
   - `CLAUDE.md` or any `.claude/` file
   - `.env*`, `next.config.*`
     `docs/` content (`ARCHITECTURE.md`, `sgauth-design/`) is not on this
     list — resolve those under the normal rules in step 3; a wrong
     auto-resolution there is a documentation error caught in review, not a
     code defect.

## If blocked

Same as `impl-agent`: a denied command errors under `dontAsk`, no prompt.
Don't retry or route around it — `BLOCKED: <command + what you needed>`.
Never spawn a subagent.
