import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createEmailVerificationToken } from "better-auth/api";
import {
  createResendVerifyEmailConsumer,
  createVerifyEmailConsumer,
  loadVerifyEmailView,
  readExpiredVerifyToken,
} from "@/lib/token-links/verify-email";
import { hashVerifyToken } from "@/lib/token-links/verify-email-token";

const SECRET = "s".repeat(32);
const EMAIL = "student@northeastern.edu";

type Db = Parameters<typeof loadVerifyEmailView>[1]["db"];

const live = () => createEmailVerificationToken(SECRET, EMAIL);
const expired = () =>
  createEmailVerificationToken(SECRET, EMAIL, undefined, -60);

/** A stand-in for the two tables the page and consumers read and write. */
function fakeDb({
  verified = false,
  used = [] as string[],
}: { verified?: boolean; used?: string[] } = {}) {
  const claimed = new Set(used.map(hashVerifyToken));
  const db = {
    user: {
      findUnique: vi.fn(async () => ({ emailVerified: verified })),
    },
    usedEmailVerificationToken: {
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) =>
        claimed.has(where.tokenHash) ? { tokenHash: where.tokenHash } : null,
      ),
      createMany: vi.fn(async ({ data }: { data: { tokenHash: string }[] }) => {
        const fresh = data.filter((row) => !claimed.has(row.tokenHash));
        for (const row of fresh) claimed.add(row.tokenHash);
        return { count: fresh.length };
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return { db: db as unknown as Db, mocks: db };
}

describe("readExpiredVerifyToken", () => {
  it("returns the address of an expired token this server signed", async () => {
    expect(await readExpiredVerifyToken(await expired(), SECRET)).toEqual({
      email: EMAIL,
    });
  });

  it("returns null for a live token", async () => {
    expect(await readExpiredVerifyToken(await live(), SECRET)).toBeNull();
  });

  it("returns null for an expired token signed with another secret", async () => {
    const forged = await createEmailVerificationToken(
      "x".repeat(32),
      EMAIL,
      undefined,
      -60,
    );
    expect(await readExpiredVerifyToken(forged, SECRET)).toBeNull();
  });

  it("returns null for an expired token with another algorithm", async () => {
    const hs512 = await new SignJWT({ email: EMAIL })
      .setProtectedHeader({ alg: "HS512" })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET));
    expect(await readExpiredVerifyToken(hs512, SECRET)).toBeNull();
  });

  it.each(["", "garbage", "a.b.c"])("returns null for %j", async (token) => {
    expect(await readExpiredVerifyToken(token, SECRET)).toBeNull();
  });

  it("returns null for an expired change-email token", async () => {
    const change = await createEmailVerificationToken(
      SECRET,
      EMAIL,
      "other@northeastern.edu",
      -60,
      { requestType: "change-email-verification" },
    );
    expect(await readExpiredVerifyToken(change, SECRET)).toBeNull();
  });

  it("returns null for an expired token whose address is not an email", async () => {
    const odd = await new SignJWT({ email: "not-an-email" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET));
    expect(await readExpiredVerifyToken(odd, SECRET)).toBeNull();
  });
});

describe("loadVerifyEmailView", () => {
  const view = (
    params: Record<string, string | undefined>,
    options?: Parameters<typeof fakeDb>[0],
  ) => {
    const { db, mocks } = fakeDb(options);
    return {
      mocks,
      result: loadVerifyEmailView(params, { secret: SECRET, db }),
    };
  };

  it("is ready for a live token on an unverified address", async () => {
    const token = await live();
    expect(await view({ token }).result).toEqual({
      state: "ready",
      token,
      email: EMAIL,
    });
  });

  it("offers a resend for an expired token on an unverified address", async () => {
    const token = await expired();
    expect(await view({ token }).result).toEqual({ state: "expired", token });
  });

  it.each([
    ["live", live],
    ["expired", expired],
  ])("shows %s tokens of a verified address as used", async (_name, make) => {
    const token = await make();
    expect(await view({ token }, { verified: true }).result).toEqual({
      state: "used",
    });
  });

  it("shows a token already consumed as used", async () => {
    const token = await live();
    expect(await view({ token }, { used: [token] }).result).toEqual({
      state: "used",
    });
  });

  it.each([
    ["no token", {}],
    ["garbage", { token: "garbage" }],
    ["an unknown result", { result: "nope" }],
  ])("is invalid for %s", async (_name, params) => {
    expect(await view(params).result).toEqual({ state: "invalid" });
  });

  it("shows the result the POST redirected with", async () => {
    expect(await view({ result: "sent" }).result).toEqual({ state: "sent" });
    expect(await view({ result: "rate" }).result).toEqual({ state: "rate" });
  });

  it("writes nothing", async () => {
    const token = await expired();
    const { mocks, result } = view({ token });
    await result;
    expect(mocks.usedEmailVerificationToken.createMany).not.toHaveBeenCalled();
    expect(mocks.usedEmailVerificationToken.deleteMany).not.toHaveBeenCalled();
  });
});

describe("createVerifyEmailConsumer", () => {
  const request = new Request("https://auth.example.com/verify-email/confirm", {
    method: "POST",
  });

  function setup(options?: Parameters<typeof fakeDb>[0]) {
    const { db, mocks } = fakeDb(options);
    const headers = new Headers({ "set-cookie": "session=1" });
    const verifyEmail = vi.fn(async () => ({ headers }));
    const resolveRedirect = vi.fn(async () => "https://app.example.com/home");
    const consume = createVerifyEmailConsumer({
      auth: { api: { verifyEmail } },
      db,
      secret: SECRET,
      resolveRedirect,
    });
    return { consume, mocks, verifyEmail, resolveRedirect, headers };
  }

  it("verifies, then follows the resolved redirect with the session headers", async () => {
    const { consume, verifyEmail, headers } = setup();
    const token = await live();
    expect(await consume({ token, fields: {}, request })).toEqual({
      result: "done",
      headers,
      redirectTo: "https://app.example.com/home",
    });
    expect(verifyEmail).toHaveBeenCalledOnce();
  });

  it("still returns the session headers when resolving the redirect throws", async () => {
    const { consume, resolveRedirect, headers } = setup();
    resolveRedirect.mockRejectedValueOnce(new Error("registry down"));
    const token = await live();
    expect(await consume({ token, fields: {}, request })).toEqual({
      result: "done",
      headers,
      redirectTo: undefined,
    });
  });

  it("answers an already-verified address used, with no claim and no verify", async () => {
    const { consume, mocks, verifyEmail } = setup({ verified: true });
    const token = await live();
    expect(await consume({ token, fields: {}, request })).toEqual({
      result: "used",
    });
    expect(mocks.usedEmailVerificationToken.createMany).not.toHaveBeenCalled();
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it("answers an expired token invalid without a claim", async () => {
    const { consume, mocks, verifyEmail } = setup();
    expect(
      await consume({ token: await expired(), fields: {}, request }),
    ).toEqual({ result: "invalid" });
    expect(mocks.usedEmailVerificationToken.createMany).not.toHaveBeenCalled();
    expect(verifyEmail).not.toHaveBeenCalled();
  });
});

describe("createResendVerifyEmailConsumer", () => {
  const request = new Request("https://auth.example.com/verify-email/resend", {
    method: "POST",
  });

  function setup(allowed = true) {
    const sendVerificationEmail = vi.fn(async () => ({ status: true }));
    const limit = vi.fn(async () => allowed);
    const consume = createResendVerifyEmailConsumer({
      auth: { api: { sendVerificationEmail } },
      secret: SECRET,
      limit,
    });
    return { consume, sendVerificationEmail, limit };
  }

  it("sends a new link to the address in an expired token", async () => {
    const { consume, sendVerificationEmail, limit } = setup();
    expect(
      await consume({ token: await expired(), fields: {}, request }),
    ).toEqual({ result: "sent" });
    expect(limit).toHaveBeenCalledWith(EMAIL);
    expect(sendVerificationEmail).toHaveBeenCalledWith({
      body: { email: EMAIL },
    });
  });

  it("does not send once the address is over its limit", async () => {
    const { consume, sendVerificationEmail } = setup(false);
    expect(
      await consume({ token: await expired(), fields: {}, request }),
    ).toEqual({ result: "rate" });
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["garbage", "garbage"],
    ["a forged token", "x".repeat(10)],
  ])("answers %s invalid and spends nothing", async (_name, token) => {
    const { consume, sendVerificationEmail, limit } = setup();
    expect(await consume({ token, fields: {}, request })).toEqual({
      result: "invalid",
    });
    expect(limit).not.toHaveBeenCalled();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
});
