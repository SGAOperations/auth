import { z } from "zod";

// The Slack Web API calls the title sync makes (#359), on a leader's own token.
// Pure apart from `fetch`, which is injectable. Never logs a token, and never
// returns one.
//
// Sources, read 2026-11-07:
// - https://docs.slack.dev/reference/methods/users.profile.get: scope
//   `users.profile:read`, Tier 4.
// - https://docs.slack.dev/reference/methods/users.profile.set: scope
//   `users.profile:write`, Tier 3 (50+ a minute). A token may update one
//   profile at most 10 times a minute and set at most 30 profiles a minute. A
//   custom `text` field holds at most 256 characters. The page gives no limit
//   for `title`, so SLACK_TITLE_MAX_LENGTH (title.ts) is still unverified; the
//   read-back is what catches a write Slack truncates or ignores. The page does
//   not say whether values are HTML-escaped either, so `normalizeSlackText`
//   undoes the escaping on read-back values.
// - https://docs.slack.dev/reference/methods/team.profile.get: scope
//   `users.profile:read`, Tier 3. Each field has `id`, `label` and `type`.
// - https://docs.slack.dev/apis/web-api/rate-limits: Tier 3 is 50+ a minute and
//   Tier 4 is 100+. A limited call answers HTTP 429 with `Retry-After` seconds.
// - Dead token codes (users.profile.set): `token_expired`, `token_revoked`,
//   `invalid_auth`, `account_inactive`, `not_authed`.

export const SLACK_PROFILE_GET_URL = "https://slack.com/api/users.profile.get";
export const SLACK_PROFILE_SET_URL = "https://slack.com/api/users.profile.set";
export const SLACK_TEAM_PROFILE_URL = "https://slack.com/api/team.profile.get";

/** The custom profile field a workspace admin creates for the leadership title. */
export const SLACK_LEADERSHIP_FIELD_LABEL = "Active Leadership";

/** The minimum gap between any two calls: 80 a minute, under Tier 4's 100. */
export const SLACK_CALL_INTERVAL_MS = 750;

/**
 * The minimum gap between two `users.profile.set` calls: about 40 a minute,
 * 20% under Tier 3's 50. Each profile is set once per run, so the per-profile
 * limit of 10 a minute is never close.
 */
export const SLACK_WRITE_INTERVAL_MS = 1_500;

const TIMEOUT_MS = 5_000;

export type SlackCallFailure =
  | { kind: "revoked"; error: string }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  /** Any other Slack error code, `network`, or `invalid_response`. */
  | { kind: "failed"; error: string };

const REVOKED = new Set([
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "not_authed",
]);

const DEFAULT_RETRY_AFTER_SECONDS = 30;

type Call<T> = ({ ok: true } & T) | { ok: false; failure: SlackCallFailure };

const failed = (error: string): { ok: false; failure: SlackCallFailure } => ({
  ok: false,
  failure: { kind: "failed", error },
});

/** POSTs to Slack and classifies everything that is not an `ok: true` body. */
async function call(
  doFetch: typeof fetch,
  url: string,
  token: string,
  json: unknown,
): Promise<
  { ok: true; body: unknown } | { ok: false; failure: SlackCallFailure }
> {
  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(json === undefined
          ? {}
          : { "Content-Type": "application/json; charset=utf-8" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After"));
      return {
        ok: false,
        failure: {
          kind: "rate_limited",
          retryAfterSeconds:
            Number.isFinite(seconds) && seconds > 0
              ? seconds
              : DEFAULT_RETRY_AFTER_SECONDS,
        },
      };
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("ok" in body)) {
      return failed("invalid_response");
    }
    if (body.ok === true) return { ok: true, body };
    const error =
      "error" in body && typeof body.error === "string"
        ? body.error.slice(0, 64)
        : "unknown";
    if (error === "ratelimited") {
      return {
        ok: false,
        failure: {
          kind: "rate_limited",
          retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        },
      };
    }
    if (REVOKED.has(error)) {
      return { ok: false, failure: { kind: "revoked", error } };
    }
    return failed(error);
  } catch {
    return failed("network");
  }
}

interface Deps {
  fetch?: typeof fetch;
}

const profileBody = z.object({
  profile: z.object({
    title: z.string().optional(),
    fields: z
      .record(z.string(), z.object({ value: z.string().optional() }))
      .nullish(),
  }),
});

/** The values a profile read returns: `title` and each custom field's value. */
export interface OwnSlackProfile {
  title: string;
  fields: Record<string, string>;
}

/** Reads the token owner's own profile (`users.profile.get`, no `user` argument). */
export async function getOwnSlackProfile(
  token: string,
  deps: Deps = {},
): Promise<Call<OwnSlackProfile>> {
  const result = await call(
    deps.fetch ?? fetch,
    SLACK_PROFILE_GET_URL,
    token,
    undefined,
  );
  if (!result.ok) return result;
  const parsed = profileBody.safeParse(result.body);
  if (!parsed.success) return failed("invalid_response");
  const { title, fields } = parsed.data.profile;
  return {
    ok: true,
    title: title ?? "",
    fields: Object.fromEntries(
      Object.entries(fields ?? {}).map(([id, field]) => [
        id,
        field.value ?? "",
      ]),
    ),
  };
}

/**
 * Writes the token owner's Title and one custom field in a single
 * `users.profile.set` call.
 */
export async function setOwnSlackProfile(
  token: string,
  input: { title: string; fieldId: string; value: string },
  deps: Deps = {},
): Promise<Call<object>> {
  const result = await call(deps.fetch ?? fetch, SLACK_PROFILE_SET_URL, token, {
    profile: {
      title: input.title,
      fields: { [input.fieldId]: { value: input.value, alt: "" } },
    },
  });
  return result.ok ? { ok: true } : result;
}

const teamProfileBody = z.object({
  profile: z.object({
    fields: z.array(
      z.object({ id: z.string(), label: z.string(), type: z.string() }),
    ),
  }),
});

/**
 * The id of the workspace's text field labelled "Active Leadership", or null
 * when there is none (a workspace admin has to create it).
 */
export async function findLeadershipFieldId(
  token: string,
  deps: Deps = {},
): Promise<Call<{ fieldId: string | null }>> {
  const result = await call(
    deps.fetch ?? fetch,
    SLACK_TEAM_PROFILE_URL,
    token,
    undefined,
  );
  if (!result.ok) return result;
  const parsed = teamProfileBody.safeParse(result.body);
  if (!parsed.success) return failed("invalid_response");
  const field = parsed.data.profile.fields.find(
    ({ label, type }) =>
      label === SLACK_LEADERSHIP_FIELD_LABEL && type === "text",
  );
  return { ok: true, fieldId: field?.id ?? null };
}

/**
 * Undoes Slack's escaping of `&`, `<` and `>` in a value read back, so a
 * position name containing `&` compares equal to what was sent. `&amp;` is
 * unescaped last, so `&amp;lt;` becomes `&lt;` and not `<`. Never applied to
 * what is written.
 */
export function normalizeSlackText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
