# Slack title sync

Writes each consenting leader's leadership title to their own Slack profile,
reads it back, and records the result. Design: [slack.md](../integration/slack.md#title-sync-359).

Audit events: `SLACK_TITLE_SET`, `SLACK_TITLE_MISMATCH`, `SLACK_TOKEN_REVOKED`
(reason `revoked_at_slack`).

## Enable it

1. As a Slack workspace admin, create a profile field named **Active Leadership**.
   Type **Text**, editable by members.
2. Set `SLACK_TITLE_SYNC_TEAM_ID` to the workspace id on the **dev** Vercel scope
   (SGA Testing). It must equal `SLACK_TEAM_ID`, or startup fails. Redeploy dev.
   Leave it unset in production until the epic's gates pass.

## Run it

- Scheduled: daily, from `.github/workflows/scheduled-jobs.yml`. Where the variable
  is unset the run answers `{"disabled":true}`.
- By hand: **Actions > Scheduled jobs > Run workflow**, job `slack-titles`,
  environment `dev`.
- Rehearsal, writing nothing: `POST /api/jobs/slack-titles?dryRun=1` with the
  bearer `CRON_SECRET`, for example with curl.

## Read the result

| Count        | Meaning                                                  | What to do                                                                      |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `synced`     | Written, and the read-back matched                       | Nothing                                                                         |
| `unchanged`  | The profile already matched                              | Nothing                                                                         |
| `mismatched` | Slack accepted the write but the read-back differed      | Check the field is an editable text field, not admin-only or directory-synced   |
| `unlinked`   | Slack said the token is dead; the token row was deleted  | Nothing. The person can allow title updates again. Their Slack link is kept     |
| `refused`    | The title is longer than the limit                       | Shorten a position name, or review the limit                                    |
| `errors`     | A Slack call failed for another reason. The run goes red | Read the `slack_title_sync_error` log lines (user id, step, Slack's error code) |
| `wouldWrite` | Dry run only: people a real run would write              | Nothing                                                                         |
| `remaining`  | People not reached because the run stopped early         | Run again, or wait for the next daily run                                       |

`stoppedReason`:

- `time_budget`: the 35 s budget ran out. The next run starts with whoever was
  not checked. After a mass consent it can take several days to catch up.
- `rate_limited`: Slack answered HTTP 429. Wait, then run again.
- `null`: every candidate was processed.

A run fails with `slack_leadership_field_missing` when the workspace has no text
field labelled **Active Leadership**. Create it (step 1 above).
