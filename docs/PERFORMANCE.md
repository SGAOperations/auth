# Performance

## Session endpoint load sanity (AUTH-T98)

Target: `GET /api/sgauth/session` on the `auth-dev` deployment, 100 concurrent virtual users with valid cookies for 2 minutes, against Neon.

Pass criteria: **p95 < 250 ms and zero connection errors at 100 VUs.**

This is a 100-VU check from a client machine, so p95 is end to end. The p95 < 120 ms target from a same-region Vercel function belongs to #40 and is measured separately.

## Setup

1. Install k6: `winget install k6` or `brew install k6`.
2. Create a dedicated load-test account on `auth-dev`, using an email on `SGAUTH_SIGNUP_ALLOWLIST`. It is not an admin and is never a real person's account. Store its password in the team password manager.
3. Announce the run in the ops channel first. It loads the shared Neon `dev` branch that `auth-dev` and every preview use (see [`ENVIRONMENTS.md`](ENVIRONMENTS.md)). Run at a quiet time.
4. Confirm the endpoint is deployed: `curl -s -o /dev/null -w "%{http_code}" https://auth-dev.northeasternsga.com/api/sgauth/session` returns `401`, not `404`.

## Run

```sh
export LOADTEST_EMAIL=...
export LOADTEST_PASSWORD=...
k6 run --summary-export .temp/k6-session.json scripts/load/session.k6.js
```

`.temp/` is gitignored. A non-zero exit means a threshold failed.

The script runs three scenarios one after another:

| Scenario   | Load                       | Purpose                                                                                                                   |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `baseline` | 1 VU, 20 s, `/api/auth/ok` | Network and function overhead without the database. The floor the session numbers are read against.                       |
| `warmup`   | 5 VUs, 30 s                | Absorbs Neon scale-to-zero resume and function cold starts, so they stay out of the AC numbers.                           |
| `load`     | 100 VUs, 2 min             | The measurement. The thresholds apply to this scenario only: p95 < 250 ms, `http_req_failed` rate 0, every check passing. |

Optional variables. Only the defaults count toward the AC; the overrides are for cheap smoke runs.

| Variable                   | Default                                | Meaning                                                                                    |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `BASE_URL`                 | `https://auth-dev.northeasternsga.com` | Deployment under test.                                                                     |
| `SESSION_COUNT`            | `5`                                    | Distinct sessions minted in setup. Lower it on a 429.                                      |
| `SGAUTH_COOKIE`            | unset                                  | Full `Cookie` header of an existing session. Skips sign-in and sign-out.                   |
| `VERCEL_PROTECTION_BYPASS` | unset                                  | Sent as `x-vercel-protection-bypass`, for a protected preview.                             |
| `LOAD_VUS`                 | `100`                                  | Virtual users in `load`.                                                                   |
| `LOAD_DURATION`            | `2m`                                   | Length of `load`.                                                                          |
| `THINK_TIME_S`             | `0.5`                                  | Sleep per iteration in `load`. `0` costs about 10 times as much; don't repeat it casually. |

Smoke run: `-e SESSION_COUNT=1 -e LOAD_VUS=2 -e LOAD_DURATION=10s`.

## What to record during the load scenario

- **k6 summary:** load-scenario p50 (`med`), p95, p99, max, request count and `http_req_failed` rate, plus baseline-scenario p50 and p95.
- **Neon console**, `dev` branch compute, Monitoring, for the run window: connections count, pooler client connections, pooler server connections, CPU, and the compute size it scaled to. Note any waiting pooler clients, which mean the pooler is saturated.
- **Neon SQL Editor** on `dev`, run 3 to 4 times during the load scenario:
  `SELECT state, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY state;`
  Run `SHOW max_connections;` once.
- **Neon compute settings:** min and max CU, and the scale-to-zero setting.
- **Vercel**, Observability, for the run window: function invocations, error count, and function duration p95 if shown.
- **Usage:** Vercel and Neon usage before and after the run (invocations, active CPU, CU-hours).
- **Client:** location and network (for example "Boston, home fiber"), and the k6 version.

## Tuning decision tree

Make one change at a time, re-run, and record each run as its own row in Results.

1. **Errors or p95 spikes only in the first seconds** mean a cold start. Warmup already excludes these. If they show up inside `load`, lengthen warmup to 60 s. Don't change compute.
2. **Neon CPU near 100%, or pooler server connections pinned at the pool limit with clients waiting:** raise the `dev` compute's autoscaling max CU (2 CU at most on the Free plan). This also raises `max_connections`, and with it the pooler's pool size. Record the old and new values.
3. **Neon and the pooler have headroom but p95 is high, or the errors are connection-acquire timeouts** (the 5 s `POOL_CONNECTION_TIMEOUT_MS`): the per-instance `pg` pool is the bottleneck.
   - Raise `POOL_MAX` in `src/lib/prisma.ts` from 5 to 10, and update its comment.
   - Keep `instances x POOL_MAX` well under the pooler's client limit, and under `max_connections` as a sanity bound.
   - Re-run.
4. **Baseline p95 already near 250 ms:** the client's network is the bottleneck, not SGAuth. Re-run from a better-connected machine before tuning anything, and say so in the results.

Revert any compute change made only for the test, and record the revert. Production compute settings are out of scope here and belong to the upgrade runbook (AUTH-T101, `runbooks/neon-upgrade.md`).

If the tree runs out without a pass (2 CU max and `POOL_MAX` at 10, with p95 still at or above 250 ms or errors still present), record the failing runs honestly, leave the AC unchecked, and escalate. The next step is a plan change (the Neon Launch plan). Never loosen the thresholds in the script.

## Results

| Date (UTC)          | `dev` SHA | Client | VUs / duration / think | Requests | p50 | p95 | p99 | Max | Error rate | Baseline p95 | Peak Neon conns | Peak pooler client / server | Waiting clients | CU  | `POOL_MAX` | Pass |
| ------------------- | --------- | ------ | ---------------------- | -------- | --- | --- | --- | --- | ---------- | ------------ | --------------- | --------------------------- | --------------- | --- | ---------- | ---- |
| _pending first run_ |           |        |                        |          |     |     |     |     |            |              |                 |                             |                 |     |            |      |

### Findings

_Pending first run._

### Changes made

_Pending first run._
