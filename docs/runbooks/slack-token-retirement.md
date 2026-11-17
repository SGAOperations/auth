# Slack token retirement

The Slack title update feature (#358, #359) is removed (#390). Leaders who granted
it left an encrypted `xoxp-` user token in `SlackUserToken`, with
`users.profile:write`, and the token stays valid at Slack until it is revoked.
This runbook revokes every stored token at Slack and deletes its row.

After the #390 deploy nothing revokes these tokens at Slack: unlinking,
relinking, deactivation and deletion no longer touch them, and deleting a user
cascades to the row, which would drop the only copy of a token that is still
valid at Slack. **Run this script on an environment before the #390 deploy
reaches it, and on `production` before the deploy to `production`.** The script
works against the old schema and the new one alike, because the table stays
until the follow-up release. If it has to run after a deploy, do it as soon as
possible; a leader deleted or deactivated in between keeps a live token at Slack
that the script can no longer find.

The script revokes each token at Slack first, then deletes the row and writes the
audit row, so a run that stops partway leaves the row for the next run.

The script is `npm run slack:retire-tokens`. It does not load `.env`, so it only
ever acts on the database you point it at. Audit events: `SLACK_TOKEN_REVOKED`
(`reason: retired`) for each deleted row, and `SLACK_TOKEN_REVOKE_FAILED` when
Slack would not revoke one.

## Run it

Do `dev` first, then `production`, each before that environment's deploy. For
each environment:

1. In your shell, set the target's `DIRECT_URL`, `SGAUTH_ENV` (`dev` or
   `production`), `BETTER_AUTH_SECRET` and, once secrets have been rotated,
   `BETTER_AUTH_SECRETS`. The secrets are needed to read the stored tokens.
2. Dry run. It prints the target and how many rows exist, and writes nothing:

   ```bash
   npm run slack:retire-tokens -- --dry-run
   ```

3. Check the printed target is the environment you meant, then apply:

   ```bash
   npm run slack:retire-tokens -- --apply
   ```

   It prints how many tokens were revoked, how many Slack already reported dead
   (not a failure), and how many failed. A second `--apply` finds 0.

4. If it exits 1 it printed SGAuth user ids whose token Slack would not revoke.
   Their rows are already deleted. For each person, remove the app's
   authorization in Slack admin.

## Afterwards

Once both environments are done:

1. Remove the redirect URL `https://<sgauth host>/account/slack/profile-access/callback`
   from the Slack app, and the user scopes `users.profile:write` and
   `users.profile:read`. Removing a scope does not revoke tokens already issued,
   so do this after the script, not instead of it.
2. Unset `SLACK_TITLE_SYNC_TEAM_ID` on Vercel `dev`.
3. Merge the follow-up release that drops the `SlackUserToken` table and the
   `User` relation, and deletes this runbook, the script and its module. It
   merges only after the script has run on `production`
   ([MIGRATIONS.md](../MIGRATIONS.md), expand and contract).
