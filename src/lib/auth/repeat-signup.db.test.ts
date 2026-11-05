import { afterAll, describe, expect, it, vi } from "vitest";
import { createEmailVerificationToken } from "better-auth/api";
import {
  createSetPasswordConsumer,
  setPasswordFields,
} from "@/lib/set-password/consumer";
import { createTokenActionHandler } from "@/lib/token-links/handler";
import {
  createVerifyEmailConsumer,
  loadVerifyEmailView,
} from "@/lib/token-links/verify-email";
import { hashVerifyToken } from "@/lib/token-links/verify-email-token";
import {
  BASE_URL,
  SECRET,
  createSetPasswordHarness,
} from "@/test/set-password-harness";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const ATTACKER = "attacker-password-A1";
const VICTIM = "victim-password-B2!!";
const CHOSEN = "victim-chosen-passphrase";

// AUTH-T17 (red-team B2, black-team BT1): a verify link never confirms a
// password the mailbox owner did not choose, however many times either party
// signs up.
describe.skipIf(!url)("repeat sign-up of an unverified account", () => {
  const h = createSetPasswordHarness(url ?? "", "t17-reclaim");
  const log = { error: vi.fn() };
  const tokens: string[] = [];

  const setPassword = createTokenActionHandler({
    action: "set-password",
    fields: setPasswordFields,
    consume: createSetPasswordConsumer({
      prisma: h.prisma,
      auth: h.auth,
      now: () => new Date(),
    }),
    limit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    log,
  });
  const verifyEmail = createTokenActionHandler({
    action: "verify-email",
    consume: createVerifyEmailConsumer({
      auth: h.auth,
      db: h.prisma,
      secret: SECRET,
      resolveRedirect: async () => "/account",
    }),
    limit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    log,
  });

  afterAll(async () => {
    await h.prisma.usedEmailVerificationToken.deleteMany({
      where: { tokenHash: { in: tokens.map(hashVerifyToken) } },
    });
    await h.cleanup();
  });

  const form = (path: string, fields: Record<string, string>) =>
    new Request(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE_URL,
      },
      body: new URLSearchParams(fields).toString(),
    });

  const result = (response: Response) =>
    new URL(response.headers.get("location") ?? "").searchParams.get("result");

  async function signInFails(email: string, password: string) {
    const error = await h.auth.api
      .signInEmail({ body: { email, password } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toMatchObject({
      statusCode: 401,
      body: { code: "INVALID_EMAIL_OR_PASSWORD" },
    });
  }

  const signUp = (email: string, password: string, name: string) =>
    h.auth.api.signUpEmail({ body: { email, password, name } });

  it("lets only the mailbox owner choose the password", async () => {
    const email = h.freshEmail();
    await signUp(email, ATTACKER, "Attacker");
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    // The link the attacker's sign-up mailed to the victim's inbox.
    const oldToken = await createEmailVerificationToken(SECRET, email);
    tokens.push(oldToken);
    await h.prisma.session.create({
      data: {
        token: `t17-${h.rand}-session`,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await h.prisma.passkey.create({
      data: {
        userId: user.id,
        name: "Attacker key",
        publicKey: "pk",
        credentialID: `t17-cred-${h.rand}`,
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      },
    });
    // The cutoff is in whole seconds, so the repeat sign-up comes a second later.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await signUp(email, VICTIM, "Victim");

    // Neither registrant's password works, and nothing hangs off the account.
    await signInFails(email, ATTACKER);
    await signInFails(email, VICTIM);
    expect(await h.prisma.session.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(await h.prisma.passkey.count({ where: { userId: user.id } })).toBe(
      0,
    );

    // The old verify link is refused, on the page and on the POST.
    expect(
      await loadVerifyEmailView(
        { token: oldToken },
        { secret: SECRET, db: h.prisma },
      ),
    ).toEqual({ state: "invalid" });
    expect(
      result(
        await verifyEmail(form("/verify-email/confirm", { token: oldToken })),
      ),
    ).toBe("invalid");
    expect(
      (await h.prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .emailVerified,
    ).toBe(false);

    // The set-password link went to the mailbox; it sets the owner's chosen
    // password and verifies the address.
    const link = h.linkTo(email);
    expect(link?.template).toBe("set-password");
    const response = await setPassword(
      form("/set-password/confirm", {
        token: h.tokenOf(link),
        password: CHOSEN,
        confirmPassword: CHOSEN,
      }),
    );
    expect(result(response)).toBe("done");
    const after = await h.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.emailVerified).toBe(true);
    expect(
      (await h.auth.api.signInEmail({ body: { email, password: CHOSEN } })).user
        .id,
    ).toBe(user.id);
    await signInFails(email, ATTACKER);
    await signInFails(email, VICTIM);
  });

  it("keeps the account password-less when the attacker signs up again", async () => {
    const email = h.freshEmail();
    await signUp(email, ATTACKER, "Attacker");
    await signUp(email, VICTIM, "Victim");
    await signUp(email, "attacker-again-A2!!", "Attacker");

    await signInFails(email, ATTACKER);
    await signInFails(email, VICTIM);
    await signInFails(email, "attacker-again-A2!!");
    // Each repeat sign-up mailed the mailbox a set-password link.
    expect(
      h.mailer.to(email).filter((m) => m.template === "set-password").length,
    ).toBeGreaterThanOrEqual(1);
  });
});
