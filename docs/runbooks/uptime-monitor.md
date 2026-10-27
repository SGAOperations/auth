# Runbook: uptime monitor for `/api/health`

SGAuth is probed from outside every 5 minutes by UptimeRobot (free plan), which
emails the admins when it goes down. This runbook covers the setup, how to read
a failure, and the outage test that proves the alerts work.

## The endpoint

`GET /api/health` and `HEAD /api/health` are public, read-only and never cached
(`Cache-Control: no-store`). They are exempt from the preview gate, so they
answer on `dev` without the gate cookie.

| Status | Body                                               | Meaning                           |
| ------ | -------------------------------------------------- | --------------------------------- |
| 200    | `{ "db": "ok", "jwks": "ok", "version": "<sha>" }` | Database and signing key are fine |
| 503    | the same shape, with a non-`ok` `db` and/or `jwks` | Something is down                 |

`version` is the first 7 characters of the deployed commit (`local` outside
Vercel). It is a deliberate choice to expose it.

## Monitor setup

Owner: the shared SGA operations UptimeRobot account, not a personal one.
Record the account's login owner here when the monitors are created:
`<owner: fill in on setup>`.

Create two monitors, both type **HTTP(s)**, interval **5 minutes**, where "up"
means a 2xx response (a 503 counts as down):

| Name          | URL                                               |
| ------------- | ------------------------------------------------- |
| `SGAuth prod` | `https://auth.northeasternsga.com/api/health`     |
| `SGAuth dev`  | `https://auth-dev.northeasternsga.com/api/health` |

If Vercel Deployment Protection is on for the dev domain, UptimeRobot gets a 401
and reports Down. Confirm `auth-dev.northeasternsga.com` is unprotected before
the outage test, or add a protection-bypass header to the dev monitor.

### Alert contacts

Add one **email** alert contact per current admin and attach all of them to
both monitors. Re-check the list whenever admin status is granted or revoked.

## First deploy to an environment

The signing key is created lazily by the jwt plugin, so a fresh environment
reports `jwks: "missing"` (503) until the key exists. After the first deploy to
each environment, fetch `/api/auth/jwks` once. Health then returns 200.

## Reading a 503

Check the response body, then the Vercel runtime logs for `health.check_failed`
(each line names the failing `check` and carries the error; the response never
does).

| Value             | Meaning                                        | Look at                                                                   |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `db: "error"`     | `SELECT 1` failed or took over 3 s             | Neon console (branch state, compute, limits), `DATABASE_URL`              |
| `jwks: "missing"` | The query worked but no signing key row exists | Fetch `/api/auth/jwks` once; if it stays missing, see the jwt plugin logs |
| `jwks: "error"`   | The key lookup failed or took over 3 s         | Same as `db`; usually both are `error` together                           |

## Outage test

Proves the acceptance criterion: the monitor goes Down and the alerts arrive
during a deliberate 10-minute dev outage.

1. Confirm both monitors show **Up** and every admin email is attached.
2. In the Vercel `dev` environment, change `DATABASE_URL` to one with an
   invalid password and redeploy. Note the time.
3. Leave it for 10 minutes. Confirm the dev monitor goes Down and every admin
   receives the down email.
4. Restore the real `DATABASE_URL`, redeploy, and confirm the up email arrives.
5. Add a row to the log below.

### Results log

| Date | Outage start | Outage end | Down alert received | Up alert received | Tester |
| ---- | ------------ | ---------- | ------------------- | ----------------- | ------ |
|      |              |            |                     |                   |        |
