import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createTokenActionHandler,
  type TokenActionOutcome,
} from "@/lib/token-links/handler";

const ORIGIN = "https://auth.northeasternsga.com";
const URL_ = `${ORIGIN}/verify-email/confirm`;

function form(body: Record<string, string>) {
  return new URLSearchParams(body).toString();
}

function post(
  body: string | null,
  headers: Record<string, string> = { origin: ORIGIN },
  contentType = "application/x-www-form-urlencoded",
) {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": contentType, ...headers },
    body,
  });
}

function setup(
  outcome: TokenActionOutcome | Error = { result: "done" },
  options: { allowed?: boolean; fields?: z.ZodObject } = {},
) {
  const consume = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const limit = vi.fn(async () => ({
    allowed: options.allowed ?? true,
    retryAfterSeconds: 0,
  }));
  const log = { error: vi.fn() };
  const handle = createTokenActionHandler({
    action: "verify-email",
    fields: options.fields,
    consume,
    limit,
    log,
  });
  return { handle, consume, limit, log };
}

const location = (response: Response) =>
  new URL(response.headers.get("location") ?? "");

describe("createTokenActionHandler", () => {
  it.each([
    ["no Origin or Referer", {}],
    ["a foreign Origin", { origin: "https://evil.example.com" }],
    ["a foreign Referer", { referer: "https://evil.example.com/x" }],
  ])("answers 403 for %s and never consumes", async (_label, headers) => {
    const { handle, consume, limit } = setup();
    const response = await handle(post(form({ token: "t" }), headers));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(consume).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it("accepts a same-origin Referer when Origin is missing", async () => {
    const { handle, consume } = setup();
    const response = await handle(
      post(form({ token: "t" }), { referer: `${ORIGIN}/verify-email?token=t` }),
    );
    expect(response.status).toBe(303);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("redirects a rate-limited request to ?result=rate without consuming", async () => {
    const { handle, consume } = setup({ result: "done" }, { allowed: false });
    const response = await handle(post(form({ token: "t" })));
    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe("/verify-email");
    expect(location(response).searchParams.get("result")).toBe("rate");
    expect(consume).not.toHaveBeenCalled();
  });

  it("keys the limit on the client IP", async () => {
    const { handle, limit } = setup();
    await handle(
      post(form({ token: "t" }), {
        origin: ORIGIN,
        "x-real-ip": "203.0.113.9",
      }),
    );
    expect(limit).toHaveBeenCalledWith("203.0.113.9");
  });

  it("treats a non-form body as invalid", async () => {
    const { handle, consume } = setup();
    const response = await handle(
      post("{}", { origin: ORIGIN }, "application/json"),
    );
    expect(location(response).searchParams.get("result")).toBe("invalid");
    expect(consume).not.toHaveBeenCalled();
  });

  it("treats a missing token as invalid", async () => {
    const { handle, consume } = setup();
    const response = await handle(post(form({ other: "x" })));
    expect(location(response).searchParams.get("result")).toBe("invalid");
    expect(consume).not.toHaveBeenCalled();
  });

  it("passes the token and the parsed extra fields to consume", async () => {
    const { handle, consume } = setup(
      { result: "done" },
      { fields: z.object({ password: z.string().min(3) }) },
    );
    await handle(post(form({ token: "t", password: "abcd" })));
    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({ token: "t", fields: { password: "abcd" } }),
    );
  });

  it("sends a bad extra field back to the form with the token", async () => {
    const { handle, consume } = setup(
      { result: "done" },
      { fields: z.object({ password: z.string().min(3) }) },
    );
    const response = await handle(post(form({ token: "t", password: "a" })));
    expect(location(response).searchParams.get("token")).toBe("t");
    expect(location(response).searchParams.get("error")).toBe("fields");
    expect(consume).not.toHaveBeenCalled();
  });

  it("maps done to ?result=done and copies every set-cookie", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    const { handle } = setup({ result: "done", headers });
    const response = await handle(post(form({ token: "t" })));
    expect(response.status).toBe(303);
    expect(location(response).searchParams.get("result")).toBe("done");
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  });

  it("follows a same-origin redirectTo", async () => {
    const { handle } = setup({ result: "done", redirectTo: "/welcome" });
    const response = await handle(post(form({ token: "t" })));
    expect(location(response).toString()).toBe(`${ORIGIN}/welcome`);
  });

  it.each(["https://evil.example.com/", "//evil.example.com", "/\\evil"])(
    "falls back to ?result=done for the off-site redirectTo %s",
    async (redirectTo) => {
      const { handle } = setup({ result: "done", redirectTo });
      const response = await handle(post(form({ token: "t" })));
      expect(location(response).origin).toBe(ORIGIN);
      expect(location(response).pathname).toBe("/verify-email");
      expect(location(response).searchParams.get("result")).toBe("done");
    },
  );

  it("maps used to ?result=used with no token in the URL", async () => {
    const { handle } = setup({ result: "used" });
    const response = await handle(post(form({ token: "secret-token" })));
    expect(location(response).searchParams.get("result")).toBe("used");
    expect(response.headers.get("location")).not.toContain("secret-token");
  });

  it("maps invalid to ?result=invalid", async () => {
    const { handle } = setup({ result: "invalid" });
    const response = await handle(post(form({ token: "t" })));
    expect(location(response).searchParams.get("result")).toBe("invalid");
  });

  it("sends retry back to the form with the token and the error", async () => {
    const { handle } = setup({ result: "retry", error: "weak" });
    const response = await handle(post(form({ token: "t" })));
    expect(location(response).searchParams.get("token")).toBe("t");
    expect(location(response).searchParams.get("error")).toBe("weak");
    expect(location(response).searchParams.get("result")).toBeNull();
  });

  it("logs one line for a throw, with neither the token nor the message", async () => {
    const { handle, log } = setup(new TypeError("boom secret-token"));
    const response = await handle(post(form({ token: "secret-token" })));
    expect(location(response).searchParams.get("result")).toBe("error");
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith("token_link_failed", {
      action: "verify-email",
      errorName: "TypeError",
    });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret-token");
    expect(response.headers.get("location")).not.toContain("secret-token");
  });

  it("sends no-store on every response", async () => {
    const outcomes: TokenActionOutcome[] = [
      { result: "done" },
      { result: "used" },
      { result: "invalid" },
      { result: "retry", error: "x" },
    ];
    for (const outcome of outcomes) {
      const { handle } = setup(outcome);
      const response = await handle(post(form({ token: "t" })));
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const { handle } = setup(new Error("x"));
    expect(
      (await handle(post(form({ token: "t" })))).headers.get("cache-control"),
    ).toBe("no-store");
  });
});
