import { describe, expect, it, vi } from "vitest";
import { createCapturingMailer } from "@/test/capturing-mailer";
import { createEmailCaps, createMemoryCapStore, type CapStore } from "./caps";
import {
  createMailer,
  hashRecipient,
  type EmailMessage,
  type Mailer,
} from "./mailer";
import { EmailTransportError, type Transport } from "./transports";

const ORIGIN = "https://auth.northeasternsga.com";
const FROM = "SGA Auth <no-reply@auth.northeasternsga.com>";

type VerifyMessage = Extract<EmailMessage, { template: "verify-email" }>;

const verify = (to = "Avery@Northeastern.edu"): VerifyMessage => ({
  to,
  template: "verify-email",
  data: {
    name: "Avery",
    url: `${ORIGIN}/verify?token=t`,
    expiresInMinutes: 1440,
  },
});

function setup(
  options: { transport?: Transport; store?: CapStore; dailyCap?: number } = {},
) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const transport: Transport = options.transport ?? {
    name: "test",
    send: vi.fn(async () => ({ id: "msg_1" })),
  };
  const store = options.store ?? createMemoryCapStore();
  const caps = createEmailCaps({
    store,
    dailyCap: options.dailyCap ?? 500,
    log,
  });
  const mailer = createMailer({
    transport,
    caps,
    from: FROM,
    linkOrigin: ORIGIN,
    log,
  });
  return { mailer, transport, log, store };
}

describe("sendEmail", () => {
  it("renders, sends and logs a hashed recipient, never the address", async () => {
    const { mailer, transport, log } = setup();

    expect(await mailer.sendEmail(verify())).toEqual({ status: "sent" });

    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: FROM,
        to: "avery@northeastern.edu",
        subject: "Verify your email for SGA Auth",
        template: "verify-email",
      }),
    );
    const expectedHash = hashRecipient("avery@northeastern.edu");
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("email_sent", {
      template: "verify-email",
      recipientHash: expectedHash,
      transport: "test",
      providerId: "msg_1",
    });
    const logged = JSON.stringify([
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
    ]);
    expect(logged).not.toContain("avery@northeastern.edu");
    expect(logged).not.toContain("Verify your email");
  });

  it("hashes the normalised address, so case and spacing do not matter", async () => {
    const { mailer, log } = setup();
    await mailer.sendEmail(verify("  AVERY@northeastern.EDU "));
    expect(log.info.mock.calls[0][1].recipientHash).toBe(
      hashRecipient("avery@northeastern.edu"),
    );
  });

  it("returns capped with a warning and does not call the transport", async () => {
    const { mailer, transport, log } = setup();
    for (let i = 0; i < 10; i += 1) await mailer.sendEmail(verify());

    expect(await mailer.sendEmail(verify())).toEqual({
      status: "capped",
      cap: "recipient:1h",
    });
    expect(transport.send).toHaveBeenCalledTimes(10);
    expect(log.warn).toHaveBeenCalledWith("email_capped", {
      template: "verify-email",
      recipientHash: hashRecipient("avery@northeastern.edu"),
      cap: "recipient:1h",
    });
  });

  it("returns failed, never a rejection, when the transport throws", async () => {
    const transport: Transport = {
      name: "resend",
      send: vi.fn(async () => {
        throw new EmailTransportError(429);
      }),
    };
    const { mailer, log } = setup({ transport });

    expect(await mailer.sendEmail(verify())).toEqual({ status: "failed" });
    expect(log.error).toHaveBeenCalledWith("email_failed", {
      template: "verify-email",
      recipientHash: hashRecipient("avery@northeastern.edu"),
      transport: "resend",
      errorName: "EmailTransportError",
      status: 429,
    });
  });

  it("logs a generic error name for a non-transport failure", async () => {
    const transport: Transport = {
      name: "resend",
      send: vi.fn(async () => {
        throw new TypeError("secret avery@northeastern.edu");
      }),
    };
    const { mailer, log } = setup({ transport });
    expect(await mailer.sendEmail(verify())).toEqual({ status: "failed" });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret");
  });
});

describe("sendEmail programmer errors", () => {
  it("throws on a link off the configured origin", async () => {
    const { mailer, transport } = setup();
    await expect(
      mailer.sendEmail({
        ...verify(),
        data: {
          url: "https://evil.example.com/verify",
          expiresInMinutes: 60,
        },
      }),
    ).rejects.toThrow("Link for email template verify-email is not on");
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("throws on invalid data, naming paths and not values", async () => {
    const { mailer } = setup();
    const error = await mailer
      .sendEmail({
        to: "avery@northeastern.edu",
        template: "verify-email",
        data: { url: "javascript:secret", expiresInMinutes: 60 },
      })
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Invalid data for email template verify-email: url",
    );
  });

  it("throws on an invalid recipient", async () => {
    const { mailer } = setup();
    await expect(mailer.sendEmail(verify("not-an-email"))).rejects.toThrow(
      "Invalid recipient for email template verify-email",
    );
  });

  it("never reaches the cap store with invalid data or an off-site link", async () => {
    const store: CapStore = { incr: vi.fn(async () => [1, 1]) };
    const { mailer } = setup({ store });

    await mailer
      .sendEmail({
        to: "avery@northeastern.edu",
        template: "verify-email",
        data: { url: "javascript:alert(1)", expiresInMinutes: 60 },
      })
      .catch(() => undefined);
    await mailer
      .sendEmail({
        ...verify(),
        data: { url: "https://evil.example.com/", expiresInMinutes: 60 },
      })
      .catch(() => undefined);
    await mailer.sendEmail(verify("nope")).catch(() => undefined);

    expect(store.incr).not.toHaveBeenCalled();
  });
});

describe("Mailer compatibility", () => {
  it("is satisfied by the capturing mailer", async () => {
    const mailer: Mailer = createCapturingMailer();
    expect(await mailer.sendEmail(verify())).toEqual({ status: "sent" });
  });
});
