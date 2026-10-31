# Import a product's Slack links

Carries the Slack links a product kept itself into SGAuth (#315), so nobody has to link again when the product starts asking SGAuth. Written for Chambers' `slack_connections`; any product whose users already have SGAuth ids can produce the same file.

**Who:** an operator with the target environment's `DIRECT_URL`. **Audit:** one `BULK_IMPORT` with `source: "slack_links"` and counts.

## The source file

A JSON list of `{ "sgauthUserId": "<uuid>", "slackUserId": "U…" }`. No addresses. Each user and each Slack account appears at most once; a repeat stops the import before it connects. Chambers writes this file with `scripts/sgauth/export-slack-links.mjs`, into its own `.temp/`. Keep it out of git and delete it once the import is done.

## Steps

1. Run a dry run against the target. It reads only, and writes a report under `.temp/slack-link-import/`:

   ```bash
   npm run import:slack-links -- --source <slack-links.json> --team <T…> --dry-run
   ```

2. Read the counts:
   - `link`: rows that will be linked.
   - `unchanged`: already linked the same way.
   - `conflict`: the user, or the Slack account, is linked differently in SGAuth already. The link in SGAuth wins and is left alone; the person can relink from the account page if it is wrong.
   - `missing user`: the SGAuth user does not exist or is deleted.
3. Apply:

   ```bash
   npm run import:slack-links -- --source <slack-links.json> --team <T…> --apply
   ```

   The apply re-reads the database and writes everything, with its `BULK_IMPORT` row, in one transaction. If someone links their own Slack account in the meantime, the apply fails on the unique index and changes nothing; run it again.

4. Confirm in **Admin → Audit** that one `BULK_IMPORT` with `source: slack_links` was written, with the counts you saw.

The report lists the SGAuth ids that were not linked and why, never a Slack id. Re-running the apply is safe: rows already linked count as `unchanged`.
