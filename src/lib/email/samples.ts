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

export const SAMPLES: readonly Sample[] = [
  {
    id: "verify-email",
    template: "verify-email",
    data: {
      name: "Avery",
      url: `${ORIGIN}/verify?token=sample`,
      expiresInMinutes: 1440,
    },
  },
  {
    // Exercises HTML escaping of a hostile display name.
    id: "verify-email-hostile-name",
    template: "verify-email",
    data: {
      name: "<script>alert(1)</script> & co",
      url: `${ORIGIN}/verify?token=sample`,
      expiresInMinutes: 1440,
    },
  },
  {
    id: "reset-password",
    template: "reset-password",
    data: {
      name: "Avery",
      url: `${ORIGIN}/reset-password?token=sample`,
      expiresInMinutes: 60,
    },
  },
  {
    id: "set-password-first-sign-in",
    template: "set-password",
    data: {
      url: `${ORIGIN}/set-password?token=sample`,
      expiresInMinutes: 10080,
      kind: "first-sign-in",
    },
  },
  {
    id: "set-password-admin-invite",
    template: "set-password",
    data: {
      name: "Avery",
      url: `${ORIGIN}/set-password?token=sample`,
      expiresInMinutes: 10080,
      kind: "admin-invite",
    },
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
      url: `${ORIGIN}/unlock?token=sample`,
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
    id: "pa-transfer-initiated-recipient",
    template: "pa-transfer-initiated",
    data: {
      role: "recipient",
      url: `${ORIGIN}/admin/transfer`,
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
      cancelUrl: `${ORIGIN}/admin/transfer`,
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
      deleteAfter: WEEK,
      signInUrl: `${ORIGIN}/sign-in`,
    },
  },
];
