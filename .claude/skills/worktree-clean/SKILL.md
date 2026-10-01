---
name: worktree-clean
description: Prune stale SGAuth pipeline worktrees under .claude/worktrees/ left behind by crashed or cut-off agents. Use when the user runs /worktree-clean or mentions orphaned worktrees / node_modules dirs piling up.
---

# /worktree-clean

Run from the main checkout only.

1. `git worktree list` to see registrations; `git worktree prune` to drop
   stale registrations for directories that no longer exist.
2. For a directory that still exists but its worktree is gone or broken
   (common on Windows once `node_modules` exists — `git worktree remove`
   alone fails with `Invalid argument`): force-delete the directory, then
   `git worktree prune` again.
3. Report what was removed. Never touch a worktree that has an agent
   currently running in it — check `TaskList`/`status` in the cockpit
   first if unsure.
