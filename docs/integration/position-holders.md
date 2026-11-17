# Position holders for products

How a product's server asks who holds a position right now (#384), for background work that has no user session, such as sending a notification after a request completes.

## Authentication

`Authorization: Bearer sgak_…`, the same product API key as the Slack routes ([slack.md](slack.md#product-api-keys)). A missing, malformed, unknown, wrong-secret or revoked key, or the key of an inactive product, all answer `401 { "error": "unauthorized" }`. Any product with a live key may ask about any position: positions, names and emails are directory-level data.

The route is a `POST` under `/api/products`, outside `/api/sgauth`, so no `Origin` header is needed. It is exempt from the preview gate and allows 600 requests a minute per product (shared with the Slack routes). Responses are `Cache-Control: no-store`.

## `POST /api/products/positions/holders`

```json
{ "keys": ["comptroller", "vpoa"] }
```

One to 20 position keys. A key is lower-case letters, digits and single hyphens, as in the admin positions page; it is never lower-cased for you. Duplicates are collapsed. Unknown fields are refused.

```json
{
  "positions": [
    {
      "key": "comptroller",
      "name": "Comptroller",
      "holders": [
        {
          "id": "<sgauth user id>",
          "email": "sam@northeastern.edu",
          "name": "Sam Example",
          "preferredName": null
        }
      ]
    }
  ],
  "unknownKeys": ["no-such-position"]
}
```

- `positions` follows the order of the request. A vacant position is present with `"holders": []`.
- Holders are sorted by when they were assigned, then by id.
- A key with no active position (never used, or deleted) is in `unknownKeys`, not an error, so one stale key does not fail the batch.
- The holder fields match the `user` object of `/api/sgauth/session`, without the admin flags.

## What "current" means

Only active users who hold a position that is not deleted are returned. The answer is read live on every call, with no cache in SGAuth, so deactivating a user or deleting a position takes effect on the next request. A user with a locked account, or a leader blocked by the Slack mandate, is still active and still the holder.

| Status | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| `200`  | The answer above                                               |
| `400`  | Malformed JSON or a schema failure; `issues` lists field paths |
| `401`  | Key missing, malformed, unknown, revoked or product inactive   |
| `429`  | Over the rate limit; honour `Retry-After`                      |
| `500`  | `{ "error": "internal_error" }`                                |

## Messaging a holder on Slack

Pass `holders[].id` to `POST /api/products/slack/lookup` as `userIds` to get each holder's Slack user id, then DM them:

```json
{ "slackTeamId": "T0123", "slackUserIds": [], "userIds": ["<holders[].id>"] }
```

A holder with no linked Slack account is missing from that answer.

## Replacing a sign-in stopgap

A product that records each user's positions when they sign in, to guess the current holder, can drop that and call this route when it needs the holder. The stopgap goes stale when an officer is deactivated and never signs in again; this route does not.
