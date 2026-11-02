# Slack identity for products

How a product's Slack app finds out which SGAuth user is behind a Slack user (#312, #313, #314). A person links their Slack account to SGAuth once, and every product resolves them the same way. Products keep no Slack-link table of their own.

## What SGAuth stores

`SlackIdentity`: one Slack account per SGAuth user, and one SGAuth user per Slack account, in one workspace (`SLACK_TEAM_ID`). It records how the link was made (`SLACK_COMMAND`, `SLACK_OPENID` or `IMPORT`) and, for a link token, which product issued it. Unlinking or deleting the user removes it. A deactivated user's link stays, but no product can see it until the user is reactivated.

## How a person links Slack

Either way ends in a `SLACK_LINKED` audit event on the user.

- **From a product's slash command.** The product has verified Slack's request signature, so it knows which Slack user is asking. It asks SGAuth for a link token for that Slack user and DMs them the URL. The person opens it, signs in to SGAuth if needed, and presses **Link Slack** on `/account/slack/link`. The token lasts 15 minutes, works once, and names a Slack account but not an SGAuth user: whoever confirms it while signed in is linked.
- **From the SGAuth account page.** **Connect Slack** runs Sign in with Slack (OpenID Connect) on SGAuth's own Slack app, restricted to `SLACK_TEAM_ID`. The button appears only when `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_TEAM_ID` are set. Slack never becomes a way to sign in to SGAuth.

Neither path moves a Slack account away from a user who already holds it. The confirm page says the account is taken, and the holder has to unlink first. A user who links a second Slack account replaces the first.

## Product API keys

The Slack routes are called by a product's server, with no user cookie, so each product authenticates with its own key.

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

## Moving a product's existing links

A product that already linked Slack users exports `{ sgauthUserId, slackUserId }` pairs and an operator imports them with `npm run import:slack-links`. See [slack-link-import.md](../runbooks/slack-link-import.md).
