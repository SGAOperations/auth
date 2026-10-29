import {
  TOKEN_ACTIONS,
  plainLinkUrl,
  tokenLinkUrl,
  type TokenActionName,
} from "@/lib/token-links/actions";
import type { TemplateData, TemplateName } from "./templates";

// Pure: fixed sample data for every template and every variant. Shared by the
// snapshot test and scripts/email-preview.ts, so what a reviewer previews is
// what the snapshot pins.

export type Sample = {
  [N in TemplateName]: {
    /** File-name safe: the template, plus the variant when it has several. */
    id: string;
    template: N;
    data: TemplateData<N>;
  };
}[TemplateName];

const ORIGIN = "https://auth.northeasternsga.com";
const NOW = new Date("2026-10-16T19:00:00Z");
const LATER = new Date("2026-10-17T19:00:00Z");
const WEEK = new Date("2026-10-23T19:00:00Z");
const EARLIER = new Date("2026-04-16T19:00:00Z");

// Samples only render and are never sent, so a pending action, which
// `tokenLinkUrl` refuses, still gets its registered path.
function sampleTokenUrl(action: TokenActionName): string {
  const entry: { path: string; status: string } = TOKEN_ACTIONS[action];
  return entry.status === "live"
    ? tokenLinkUrl(ORIGIN, action, "sample-token")
    : `${ORIGIN}${entry.path}?token=sample-token`;
}

export const SAMPLES: readonly Sample[] = [
  {
    id: "verify-email",
    template: "verify-email",
    data: {
      name: "Avery",
      url: sampleTokenUrl("verify-email"),
      expiresInMinutes: 1440,
    },
  },
  {
    // Exercises HTML escaping of a hostile display name.
    id: "verify-email-hostile-name",
    template: "verify-email",
    data: {
      name: "<script>alert(1)</script> & co",
      url: sampleTokenUrl("verify-email"),
      expiresInMinutes: 1440,
    },
  },
  {
    id: "reset-password",
    template: "reset-password",
    data: {
      name: "Avery",
      url: sampleTokenUrl("reset-password"),
      expiresInMinutes: 60,
    },
  },
  {
    id: "set-password-first-sign-in",
    template: "set-password",
    data: {
      url: sampleTokenUrl("set-password"),
      expiresInMinutes: 10080,
      kind: "first-sign-in",
    },
  },
  {
    id: "set-password-admin-invite",
    template: "set-password",
    data: {
      name: "Avery",
      url: sampleTokenUrl("set-password"),
      expiresInMinutes: 10080,
      kind: "admin-invite",
    },
  },
  {
    id: "sign-in-code",
    template: "sign-in-code",
    data: { otp: "123456", expiresMinutes: 10 },
  },
  {
    id: "account-locked",
    template: "account-locked",
    data: { name: "Avery", lockedUntil: LATER },
  },
  {
    id: "account-unlock",
    template: "account-unlock",
    data: {
      name: "Avery",
      url: sampleTokenUrl("account-unlock"),
      expiresInMinutes: 60,
    },
  },
  {
    id: "security-notice-password-changed",
    template: "security-notice",
    data: { name: "Avery", event: "password-changed", occurredAt: NOW },
  },
  {
    id: "security-notice-password-reset",
    template: "security-notice",
    data: { name: "Avery", event: "password-reset", occurredAt: NOW },
  },
  {
    id: "security-notice-admin-granted",
    template: "security-notice",
    data: { event: "admin-granted", occurredAt: NOW },
  },
  {
    id: "security-notice-mfa-reset",
    template: "security-notice",
    data: { name: "Avery", event: "mfa-reset", occurredAt: NOW },
  },
  {
    id: "pa-transfer-initiated-recipient",
    template: "pa-transfer-initiated",
    data: {
      role: "recipient",
      url: plainLinkUrl(ORIGIN, "pa-transfer-accept"),
      fromName: "Jordan Lee",
      acceptBy: WEEK,
    },
  },
  {
    id: "pa-transfer-initiated-initiator",
    template: "pa-transfer-initiated",
    data: { role: "initiator", toName: "Sam Rivera", acceptBy: WEEK },
  },
  {
    id: "pa-transfer-accepted-initiator",
    template: "pa-transfer-accepted",
    data: {
      role: "initiator",
      cancelUrl: sampleTokenUrl("pa-transfer-cancel"),
      toName: "Sam Rivera",
      executesAt: LATER,
    },
  },
  {
    id: "pa-transfer-accepted-recipient",
    template: "pa-transfer-accepted",
    data: { role: "recipient", fromName: "Jordan Lee", executesAt: LATER },
  },
  ...(
    ["cancelled", "declined", "expired", "recipient-ineligible"] as const
  ).flatMap((reason) =>
    (["initiator", "recipient"] as const).map(
      (role): Sample => ({
        id: `pa-transfer-cancelled-${reason}-${role}`,
        template: "pa-transfer-cancelled",
        data: { role, otherName: "Sam Rivera", reason },
      }),
    ),
  ),
  ...(["initiator", "recipient", "admin"] as const).map(
    (role): Sample => ({
      id: `pa-transfer-completed-${role}`,
      template: "pa-transfer-completed",
      data: {
        role,
        fromName: "Jordan Lee",
        toName: "Sam Rivera",
        completedAt: LATER,
      },
    }),
  ),
  {
    id: "inactivity-notice",
    template: "inactivity-notice",
    data: {
      name: "Avery",
      lastLoginAt: EARLIER,
      deactivateAfter: WEEK,
      signInUrl: plainLinkUrl(ORIGIN, "sign-in"),
    },
  },
  {
    id: "security-alert-one-rule",
    template: "security-alert",
    data: {
      name: "Avery",
      checkedAt: NOW,
      items: [{ rule: "login-failed-spike", count: 51 }],
    },
  },
  {
    id: "security-alert-every-rule",
    template: "security-alert",
    data: {
      checkedAt: NOW,
      items: [
        { rule: "login-failed-spike", count: 64 },
        { rule: "account-locked-spike", count: 6 },
        { rule: "break-glass", count: 1, since: EARLIER },
        { rule: "pa-transfer-initiated", count: 2, since: EARLIER },
        { rule: "jwks-rotated", count: 1, since: EARLIER },
        {
          rule: "job-failed",
          count: 3,
          since: EARLIER,
          jobs: ["alerts", "pa-transfer"],
        },
        { rule: "upstash-fail-open", count: 4, since: EARLIER },
      ],
    },
  },
];
