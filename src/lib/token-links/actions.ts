import type { TemplateName } from "@/lib/email/templates";

// Registry of every emailed link. Pure (no `server-only`, no env), so the
// proxy, the mailer and tests can import it. A token is consumed only by the
// page's POST, never by opening the link.

export type TokenActionStatus = "live" | "pending";

export interface TokenAction {
  path: string;
  /** The ticket that owns the page. */
  owner: string;
  /** `pending` has no page yet, so nothing may mail a link to it. */
  status: TokenActionStatus;
}

export const TOKEN_ACTIONS = {
  "verify-email": {
    path: "/verify-email",
    owner: "AUTH-T103 / T18 / T24",
    status: "live",
  },
  "reset-password": {
    path: "/reset-password",
    owner: "AUTH-T19 #31",
    status: "live",
  },
  "set-password": {
    path: "/set-password",
    owner: "AUTH-T22 #34",
    status: "live",
  },
  "account-unlock": {
    path: "/unlock",
    owner: "AUTH-T64 #76",
    status: "live",
  },
  // Mailed to the new address of an admin-initiated email change. Public: the
  // new mailbox's owner has no session.
  "email-change": {
    path: "/verify-email-change",
    owner: "AUTH-T24 #36",
    status: "live",
  },
  // Public, so it sits outside /admin: the sender may have no session.
  "pa-transfer-cancel": {
    path: "/transfer/cancel",
    owner: "AUTH-T37 #49",
    status: "live",
  },
} as const satisfies Record<string, TokenAction>;

export type TokenActionName = keyof typeof TOKEN_ACTIONS;

/** Links with no token and no GET side effect. */
export const PLAIN_LINKS = {
  "sign-in": { path: "/sign-in" },
  // Acceptance carries no token: its authority is the recipient's session and a
  // fresh re-authentication, and only one transfer can be in flight.
  "pa-transfer-accept": { path: "/admin/transfer/accept" },
} as const satisfies Record<string, { path: string }>;

export type PlainLinkName = keyof typeof PLAIN_LINKS;

export type LinkTarget =
  | { kind: "token"; action: TokenActionName }
  | { kind: "plain"; link: PlainLinkName };

/**
 * For each email template, the registered target of every field in its
 * `links` list. A template with no links maps to `{}`.
 */
export const TEMPLATE_LINK_TARGETS: Record<
  TemplateName,
  Record<string, LinkTarget>
> = {
  "verify-email": { url: { kind: "token", action: "verify-email" } },
  "reset-password": { url: { kind: "token", action: "reset-password" } },
  "set-password": { url: { kind: "token", action: "set-password" } },
  "account-locked": {},
  "account-unlock": { url: { kind: "token", action: "account-unlock" } },
  "security-notice": {},
  "email-change-verify": { url: { kind: "token", action: "email-change" } },
  "email-change-notice": {},
  "pa-transfer-initiated": {
    url: { kind: "plain", link: "pa-transfer-accept" },
  },
  "pa-transfer-accepted": {
    cancelUrl: { kind: "token", action: "pa-transfer-cancel" },
  },
  "pa-transfer-cancelled": {},
  "pa-transfer-completed": {},
  "inactivity-notice": { signInUrl: { kind: "plain", link: "sign-in" } },
  "security-alert": {},
  "sign-in-code": {},
};

/** Every token-action path, pending ones included. The proxy matches on it. */
export const TOKEN_LINK_PATHS: ReadonlySet<string> = new Set(
  Object.values(TOKEN_ACTIONS).map((action) => action.path),
);

export function tokenLinkUrl(
  origin: string,
  action: TokenActionName,
  token: string,
): string {
  const entry: TokenAction = TOKEN_ACTIONS[action];
  if (entry.status === "pending") {
    throw new Error(`Token link action ${action} has no page yet (pending)`);
  }
  if (token.length === 0) {
    throw new Error(`Token link action ${action} needs a token`);
  }
  return `${origin}${entry.path}?token=${encodeURIComponent(token)}`;
}

export function plainLinkUrl(origin: string, link: PlainLinkName): string {
  return `${origin}${PLAIN_LINKS[link].path}`;
}

export type LinkTargetResult =
  | { ok: true }
  | { ok: false; reason: "unmapped" | "pending" | "path" | "query" };

/**
 * Checks that `url`, held in `template`'s `field`, points at that field's
 * registered page: the same path, and exactly one non-empty `token` for a
 * token link or no query at all for a plain one. The origin is checked
 * separately, by the mailer.
 */
export function resolveLinkTarget(
  template: TemplateName,
  field: string,
  url: string,
): LinkTargetResult {
  const target = Object.hasOwn(TEMPLATE_LINK_TARGETS[template], field)
    ? TEMPLATE_LINK_TARGETS[template][field]
    : undefined;
  if (!target) return { ok: false, reason: "unmapped" };

  const expected: { path: string; status: TokenActionStatus } =
    target.kind === "token"
      ? TOKEN_ACTIONS[target.action]
      : { path: PLAIN_LINKS[target.link].path, status: "live" };
  if (expected.status === "pending") return { ok: false, reason: "pending" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "path" };
  }
  if (parsed.pathname !== expected.path) return { ok: false, reason: "path" };

  const keys = [...parsed.searchParams.keys()];
  if (target.kind === "plain") {
    return keys.length === 0 && parsed.search === ""
      ? { ok: true }
      : { ok: false, reason: "query" };
  }
  const token = parsed.searchParams.get("token");
  return keys.length === 1 && keys[0] === "token" && token
    ? { ok: true }
    : { ok: false, reason: "query" };
}
