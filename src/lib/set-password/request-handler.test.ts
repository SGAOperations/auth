import { describe, expect, it, vi } from "vitest";
import { createSetPasswordRequestHandler } from "@/lib/set-password/request-handler";

const ORIGIN = "https://auth.example.com";

function setup(
  options: {
    mode?: "json" | "form";
    allowed?: boolean;
    requestLink?: () => Promise<void>;
  } = {},
) {
  const { mode = "json", allowed = true } = options;
  const requestLink = vi.fn(options.requestLink ?? (async () => {}));
  const limit = vi.fn(async () => ({
    allowed,
    retryAfterSeconds: allowed ? 0 : 42,
  }));
  const deferred: Array<() => Promise<void>> = [];
  const log = { error: vi.fn() };
  const handle = createSetPasswordRequestHandler({
    mode,
    service: { requestLink },
    limit,
    defer: (task) => {
      deferred.push(task);
    },
    log,
  });
  return { handle, requestLink, limit, deferred, log };
}

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = { origin: ORIGIN },
) {
  return new Request(`${ORIGIN}/api/sgauth/sign-in/email-step`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function formRequest(
  fields: Record<string, string>,
  headers: Record<string, string> = { origin: ORIGIN },
) {
  return new Request(`${ORIGIN}/set-password/request`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const resultOf = (response: Response) =>
  new URL(response.headers.get("location") ?? "").searchParams.get("result");

describe("origin", () => {
  it.each([
    ["missing", {}],
    ["foreign", { origin: "https://evil.example.com" }],
  ])("refuses a %s Origin and defers nothing", async (_name, headers) => {
    const { handle, limit, deferred } = setup();
    const response = await handle(
      jsonRequest({ email: "a@northeastern.edu" }, headers),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(limit).not.toHaveBeenCalled();
    expect(deferred).toEqual([]);
  });

  it("accepts the Referer when Origin is absent", async () => {
    const { handle, deferred } = setup();
    const response = await handle(
      jsonRequest(
        { email: "a@northeastern.edu" },
        { referer: `${ORIGIN}/login` },
      ),
    );
    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(1);
  });
});

describe("input", () => {
  it.each([
    ["malformed JSON", "{not json"],
    ["a non-email value", { email: "nope" }],
    ["an extra key", { email: "a@northeastern.edu", extra: 1 }],
    ["a non-string email", { email: 1 }],
    ["a missing email", {}],
  ])("answers %s with 400 INVALID_EMAIL in JSON mode", async (_n, body) => {
    const { handle, limit, deferred } = setup();
    const response = await handle(jsonRequest(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_EMAIL",
      message: "Enter a valid email address.",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(limit).not.toHaveBeenCalled();
    expect(deferred).toEqual([]);
  });

  it.each([
    ["a non-email value", { email: "nope" }],
    ["an extra key", { email: "a@northeastern.edu", extra: "1" }],
    ["a missing email", {}],
  ])("redirects %s to invalid-email in form mode", async (_n, fields) => {
    const { handle, deferred } = setup({ mode: "form" });
    const response = await handle(formRequest(fields));
    expect(response.status).toBe(303);
    expect(resultOf(response)).toBe("invalid-email");
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/set-password",
    );
    expect(deferred).toEqual([]);
  });

  it("redirects a non-form body to invalid-email in form mode", async () => {
    const { handle } = setup({ mode: "form" });
    const response = await handle(
      new Request(`${ORIGIN}/set-password/request`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "text/plain" },
        body: "email=a@northeastern.edu",
      }),
    );
    expect(resultOf(response)).toBe("invalid-email");
  });
});

describe("rate limit", () => {
  it("answers 429 in JSON mode and defers nothing", async () => {
    const { handle, deferred } = setup({ allowed: false });
    const response = await handle(jsonRequest({ email: "a@northeastern.edu" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(deferred).toEqual([]);
  });

  it("redirects to rate in form mode and defers nothing", async () => {
    const { handle, deferred } = setup({ mode: "form", allowed: false });
    const response = await handle(formRequest({ email: "a@northeastern.edu" }));
    expect(response.status).toBe(303);
    expect(resultOf(response)).toBe("rate");
    expect(deferred).toEqual([]);
  });

  it("keys the limit on the IP and the normalized email", async () => {
    const { handle, limit } = setup();
    await handle(
      jsonRequest(
        { email: "A@Northeastern.EDU" },
        { origin: ORIGIN, "x-real-ip": "203.0.113.9" },
      ),
    );
    expect(limit).toHaveBeenCalledWith({
      ip: "203.0.113.9",
      email: "a@northeastern.edu",
    });
  });
});

describe("a valid email", () => {
  it("answers 200 and defers exactly one lookup in JSON mode", async () => {
    const { handle, requestLink, deferred } = setup();
    const response = await handle(jsonRequest({ email: "A@Northeastern.edu" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");

    // The lookup has not run yet: it is after the response.
    expect(requestLink).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await deferred[0]();
    expect(requestLink).toHaveBeenCalledExactlyOnceWith({
      email: "a@northeastern.edu",
      via: "sign_in",
    });
  });

  it("redirects to sent and defers one link_request in form mode", async () => {
    const { handle, requestLink, deferred } = setup({ mode: "form" });
    const response = await handle(formRequest({ email: "a@northeastern.edu" }));
    expect(response.status).toBe(303);
    expect(resultOf(response)).toBe("sent");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await deferred[0]();
    expect(requestLink).toHaveBeenCalledExactlyOnceWith({
      email: "a@northeastern.edu",
      via: "link_request",
    });
  });

  it("logs a deferred failure without the email", async () => {
    const { handle, deferred, log } = setup({
      requestLink: async () => {
        throw new TypeError("boom for a@northeastern.edu");
      },
    });
    const response = await handle(jsonRequest({ email: "a@northeastern.edu" }));
    expect(response.status).toBe(200);
    await deferred[0]();
    expect(log.error).toHaveBeenCalledExactlyOnceWith(
      "set_password_request_failed",
      { via: "sign_in", errorName: "TypeError" },
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("northeastern");
  });
});
