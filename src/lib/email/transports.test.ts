import { describe, expect, it, vi } from "vitest";
import {
  EmailTransportError,
  createConsoleTransport,
  createResendTransport,
  discardTransport,
} from "./transports";

const message = {
  from: "SGA Auth <no-reply@mail.northeasternsga.com>",
  to: "avery@northeastern.edu",
  subject: "Verify your email for SGA Auth",
  html: "<p>hi</p>",
  text: "hi",
  template: "verify-email",
};

describe("Resend transport", () => {
  it("posts the message with a bearer key and a template tag", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ id: "re_123" }, { status: 200 }),
    );
    const transport = createResendTransport({ apiKey: "re_key", fetch });

    const result = await transport.send(message);

    expect(result).toEqual({ id: "re_123" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer re_key" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags: [{ name: "template", value: "verify-email" }],
    });
  });

  it("returns no id when the response body has none", async () => {
    const fetch = vi.fn(async () => new Response("not json", { status: 200 }));
    const transport = createResendTransport({ apiKey: "k", fetch });
    expect(await transport.send(message)).toEqual({ id: undefined });
  });

  it("throws an EmailTransportError carrying the status only", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: `bad ${message.to}` }), {
          status: 422,
        }),
    );
    const transport = createResendTransport({ apiKey: "k", fetch });

    const error = await transport.send(message).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmailTransportError);
    expect((error as EmailTransportError).status).toBe(422);
    expect((error as EmailTransportError).message).not.toContain(message.to);
    expect((error as EmailTransportError).message).not.toContain("bad");
  });
});

describe("console transport", () => {
  it("writes the recipient, the subject and the text body", async () => {
    const write = vi.fn();
    const transport = createConsoleTransport({ write });
    await transport.send(message);
    expect(write).toHaveBeenCalledTimes(1);
    const output = String(write.mock.calls[0][0]);
    expect(output).toContain(`To: ${message.to}`);
    expect(output).toContain(`Subject: ${message.subject}`);
    expect(output).toContain(message.text);
  });
});

describe("discard transport", () => {
  it("sends nothing and succeeds", async () => {
    expect(await discardTransport.send(message)).toEqual({});
    expect(discardTransport.name).toBe("discard");
  });
});
