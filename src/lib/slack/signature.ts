import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Pure on purpose, like jobs/handler.ts: no `server-only`, no env and no
// Prisma, so it is unit-testable without mocks. The caller passes the secret
// (`env.SLACK_SIGNING_SECRET`).

export const SLACK_SIGNATURE_MAX_AGE_SECONDS = 300;

export type SlackVerifyFailure =
  | "not_configured"
  | "missing_headers"
  | "stale"
  | "bad_signature";

export type SlackVerifyResult =
  | { ok: true; body: string }
  | { ok: false; reason: SlackVerifyFailure };

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Slack's v0 signature: `v0=` and the hex HMAC-SHA256 of `v0:<timestamp>:<body>`. */
export function slackSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return `v0=${digest}`;
}

/**
 * Verifies that a request came from Slack. Reads the body once, as raw text,
 * and returns it: the caller parses that string and never reads `req` again.
 *
 * `reason` is for logs and tests only. Answer every failure with the same
 * generic 401, so a caller learns nothing about why it was refused. Never log
 * the secret, the presented signature or the body. An unset secret refuses
 * everything without reading the body.
 */
export async function verifySlackRequest(
  req: Request,
  signingSecret: string | undefined,
  now: Date = new Date(),
): Promise<SlackVerifyResult> {
  if (!signingSecret) return { ok: false, reason: "not_configured" };

  const timestamp = req.headers.get("x-slack-request-timestamp");
  const presented = req.headers.get("x-slack-signature");
  if (!timestamp || !presented || !/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: "missing_headers" };
  }

  // A timestamp this far in the future could be replayed for longer, so it is
  // stale too.
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    Math.abs(nowSeconds - Number(timestamp)) > SLACK_SIGNATURE_MAX_AGE_SECONDS
  ) {
    return { ok: false, reason: "stale" };
  }

  const body = await req.text();
  const expected = slackSignature(signingSecret, timestamp, body);
  // Fixed-length digests: a length difference neither throws nor leaks timing.
  if (!timingSafeEqual(sha256(presented), sha256(expected))) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, body };
}
