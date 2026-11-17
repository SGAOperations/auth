# Slack identity for products

How a product's Slack app finds out which SGAuth user is behind a Slack user (#312, #313, #314). A person links their Slack account to SGAuth once, and every product resolves them the same way. Products keep no Slack-link table of their own.

## What SGAuth stores

`SlackIdentity`: one Slack account per SGAuth user, and one SGAuth user per Slack account, in one workspace (`SLACK_TEAM_ID`). It records how the link was made (`SLACK_COMMAND`, `SLACK_OPENID`, `SLACK_OAUTH` or `IMPORT`) and, for a link token, which product issued it. Unlinking or deleting the user removes it. A deactivated user's link stays, but no product can see it until the user is reactivated.

## How a person links Slack

Either way ends in a `SLACK_LINKED` audit event on the user.

- **From a product's slash command.** The product has verified Slack's request signature, so it knows which Slack user is asking. It asks SGAuth for a link token for that Slack user and DMs them the URL. The person opens it, signs in to SGAuth if needed, and presses **Link Slack** on `/account/slack/link`. The token lasts 15 minutes, works once, and names a Slack account but not an SGAuth user: whoever confirms it while signed in is linked.
- **From the SGAuth account page.** **Connect Slack** runs Sign in with Slack (OpenID Connect) on SGAuth's own Slack app, restricted to `SLACK_TEAM_ID`. The button appears only when `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_TEAM_ID` are set. Slack never becomes a way to sign in to SGAuth.

Neither path moves a Slack account away from a user who already holds it. The confirm page says the account is taken, and the holder has to unlink first. A user who links a second Slack account replaces the first.

## Product API keys

The Slack routes are called by a product's server, with no user cookie, so each product authenticates with its own key. The same key also authenticates the position-holders route ([position-holders.md](position-holders.md)).

1. An SGAuth admin opens **Admin → Products → (product) → API keys** and creates a key. The key is shown once. A product can hold three live keys, so it can rotate without downtime.
2. Store it as a secret environment variable in the product, one key per environment, and send it as `Authorization: Bearer sgak_…`.
3. To rotate: create a new key, deploy it, then revoke the old one. A revoked key, or a key of an inactive product, is refused on the next request.

Only the key's SHA-256 is stored. The admin page shows each key's public prefix and when it was last used. Creating and revoking write `PRODUCT_API_KEY_CREATED` and `PRODUCT_API_KEY_REVOKED`.

## Endpoints

Both are `POST` with a JSON body, sit outside `/api/sgauth` (so no `Origin` header is needed), are exempt from the preview gate, and allow 600 requests a minute per product. A bad key answers `401`, a malformed body `400` with the offending field names, and a workspace other than `SLACK_TEAM_ID` `403 { "error": "wrong_team" }`. Responses are `Cache-Control: no-store`.

### `POST /api/products/slack/lookup`

```json
{ "slackTeamId": "T0123", "slackUserIds": ["U0456"], "userIds": [] }
```

Each list holds at most 100 ids, and at least one id must be given. The answer lists the links that match either list, for active users only:

```json
{
  "identities": [
    {
      "userId": "<sgauth user id>",
      "slackTeamId": "T0123",
      "slackUserId": "U0456"
    }
  ]
}
```

An id that is missing from the answer is not linked, or its user may not sign in. It carries no email or name: map `userId` to your own row through your `sgauthUserId` column. Slack expects an answer to a command within three seconds, so cache a positive answer briefly (Chambers caches for 60 seconds).

### `POST /api/products/slack/link-tokens`

```json
{ "slackTeamId": "T0123", "slackUserId": "U0456" }
```

Answers `{ "url": "https://auth.northeasternsga.com/account/slack/link?token=…", "expiresAt": "…" }`. Send the URL only to that Slack user, in a DM. Never log it.

## Setting up Connect Slack

1. Create a Slack app for SGAuth in the SGA workspace. Under **OAuth & Permissions**, add the redirect URL `https://<sgauth host>/account/slack/callback` for each environment, and the user scope `openid`.
2. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_TEAM_ID` per Vercel scope ([ENVIRONMENTS.md](../ENVIRONMENTS.md)).

## SGAssist slash commands

### `/who-is` (#349)

`/who-is @person` shows who a person is in SGAuth: their name, their active positions with category and whether each is a leadership position, and the manager position each one reports to. The full chain belongs to the org chart.

- **Endpoint and authentication.** Slack calls `POST /api/slack/commands/who-is`. The Slack request signature, checked with `SLACK_SIGNING_SECRET`, is the only credential: there is no product API key, no Origin check, and the path is exempt from the preview gate. Any unverified request (unsigned, bad signature, stale, or secret unset) gets the same `401`.
- **Reply.** Always ephemeral, so only the caller sees it. The mentioned person is not notified. A person who is not linked, or is deactivated or deleted, gets the same "hasn't linked" reply, so a member learns nothing about someone else's account status. A caller who is not linked and active is told to link Slack first, with the link to the account page.
- **Who may use it.** Any linked, active user (`canUseWhoIs`). Lookups are read only and are not audited.

#### Setting it up

In the SGAssist Slack app, under **Slash Commands**, for each environment:

1. Create the command `/who-is` with the Request URL `https://<sgauth host>/api/slack/commands/who-is` and the usage hint `@person`.
2. Under the same command, turn on **Escape channels, users, and links sent to your app**. Without it a mention arrives as plain text and gets the usage reply.
3. Set `SLACK_SIGNING_SECRET` for the environment ([ENVIRONMENTS.md](../ENVIRONMENTS.md)). Every request is refused while it is unset.

### `/access` command (#342)

`/access <product> | <access you need>` records a request for access to an external product. **Nothing is granted automatically**: SGAuth keeps the request, writes `ACCESS_REQUEST_SUBMITTED` on the requester, and replies with a one-line string the person copies into an email or a sheet. Requests appear on the access page (#344).

The command is called by Slack, not by a product, so there is **no product API key**. Slack signs the request, and the signature is the only credential.

### Endpoint

`POST https://<sgauth host>/api/slack/commands/access`, a Slack-signed form body (`application/x-www-form-urlencoded`). SGAuth verifies `X-Slack-Signature` against `SLACK_SIGNING_SECRET` with a five-minute window. Any failure (secret unset, missing headers, stale, bad signature) answers one `401 { "error": "unauthorized" }`. A body that is not a `/access` command, or whose `response_url` is not `https://hooks.slack.com/...`, answers `400`. The route sits outside `/api/sgauth` (so no `Origin` header is needed) and is exempt from the preview gate. Responses are `Cache-Control: no-store`.

The person is identified only by the signed `team_id` and `user_id`, resolved through their `SlackIdentity` link. Nothing in the text can name another user.

### What it does

Every reply is ephemeral, so only the person who ran the command sees it. A refusal writes no row and no audit event.

- **Success.** The text is split on the first `|`. The row records the requester, the position they submitted as, and the product and access text. A person holding several listed positions is recorded under the one with the lowest key.
- **Not linked.** The reply points to **Connect Slack** on the SGAuth account page.
- **Account not active, or not on the submitter list.** Only holders of a position on the admin-managed submitter list (#340, #343) may submit. Admin status grants nothing, and an empty list refuses everyone.
- **Bad input.** Empty text, `help` or no `|` shows the usage. Both parts are required, the product is at most 100 characters and the access at most 500, and backticks and control characters are refused.
- **Another workspace.** A `team_id` other than `SLACK_TEAM_ID` (when set) is refused.

Slack drops a command that is not answered within three seconds. The handler waits up to two seconds for the work and replies inline. If the work is slower (a cold database, for example), it replies "Submitting your access request…" and posts the final reply to Slack's `response_url`, replacing the first. A failure of the work answers "Something went wrong and your request was not recorded", and the log line carries the error name only.

### Setting it up

1. In the SGAssist app, create the slash command `/access` with the request URL `https://<sgauth host>/api/slack/commands/access`, one per environment.
2. Leave **Escape channels, users, and links** off.
3. Set `SLACK_SIGNING_SECRET` to the SGAssist app's signing secret. While it is unset, every request is refused with `401`, so the command is dormant, not open.

## The leadership Slack mandate (#361)

A policy gate, off by default (`SGAUTH_SLACK_MANDATE_ENABLED`). When on, anyone holding a non-deleted leadership position must have a linked Slack account, so that products such as SGAssist can message them through it. Any `SlackIdentity` satisfies it, however it was linked: Connect Slack, a product's DM link, or the import. Admin status grants nothing, and non-leaders are never blocked by it.

It blocks only the two endpoints products get identity from: `GET /api/sgauth/session` (and `/minimal`), and Better Auth's `GET /api/auth/token`. SGAuth's own pages never block, so a leader can always reach the fix.

- **Session endpoint.** A blocked leader gets the existing `401 {"error":"unauthenticated"}`, byte-identical to signed out. The `200` body and the published schemas do not change.
- **Token endpoint.** A blocked leader gets `401` with the code `SLACK_LINK_REQUIRED`.
- **What the user sees.** The SDK treats a `401` as signed out and sends the browser to SGAuth's `/login?redirect=<product>`. For a blocked leader, `/login` shows "Link Slack to continue" instead of "You're signed in". **Connect Slack** there returns to `/login` once the account is linked, where **Continue** spends the redirect.

Products need no change. The SDK caches a `200` for up to 60 seconds and a `401` for 10, so a flip, a link or an unlink reaches products up to a minute late. Each block is audited as `SLACK_MANDATE_BLOCKED`, at most once per user per day plus once after each link (`SLACK_LINKED`). Turning it on or off is [runbooks/slack-mandate.md](../runbooks/slack-mandate.md).

## Moving a product's existing links

A product that already linked Slack users exports `{ sgauthUserId, slackUserId }` pairs and an operator imports them with `npm run import:slack-links`. See [slack-link-import.md](../runbooks/slack-link-import.md).
