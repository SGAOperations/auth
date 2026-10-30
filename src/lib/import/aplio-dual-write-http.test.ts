import { describe, expect, it, vi } from "vitest";
import {
  createAplioDualWriteHandler,
  type AplioProvisionResult,
} from "@/lib/import/aplio-dual-write-http";

const SECRET = "d".repeat(32);
const CUTOVER = "2026-12-01T05:00:00-05:00";
const BEFORE = new Date("2026-12-01T00:00:00-05:00");
const USER_ID = "0192f1a0-0000-7000-8000-000000000001";

const body = {
  aplioId: "a-1",
  email: "Ada@Northeastern.edu",
  name: "Ada",
};

function setup(
  options: {
    secret?: string | undefined;
    cutoverAt?: string | undefined;
    now?: Date;
    result?: AplioProvisionResult;
    fail?: Error;
  } = {},
) {
  const provision = vi.fn(async (): Promise<AplioProvisionResult> => {
    if (options.fail) throw options.fail;
    return options.result ?? { status: "created", userId: USER_ID };
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handler = createAplioDualWriteHandler({
    secret: "secret" in options ? options.secret : SECRET,
    cutoverAt: "cutoverAt" in options ? options.cutoverAt : CUTOVER,
    provision,
    log,
    now: () => options.now ?? BEFORE,
  });
  return { provision, log, handler };
}

function request(
  payload: unknown = body,
  authorization: string | null = `Bearer ${SECRET}`,
) {
  return new Request("https://auth.example.test/api/provision/aplio/users", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function read(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe("createAplioDualWriteHandler", () => {
  it("answers 404 when the secret is unset, even for a valid bearer", async () => {
    const { handler, provision } = setup({ secret: undefined });
    expect(await read(await handler(request()))).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect(provision).not.toHaveBeenCalled();
  });

  it("answers 404 when the cutover is unset", async () => {
    const { handler } = setup({ cutoverAt: undefined });
    expect((await handler(request())).status).toBe(404);
  });

  it.each([
    ["no header", null],
    ["a wrong bearer", `Bearer ${"x".repeat(32)}`],
    ["another scheme", `Basic ${SECRET}`],
  ])("answers 401 for %s", async (_label, authorization) => {
    const { handler, provision, log } = setup();
    const response = await handler(request(body, authorization));
    expect(await read(response)).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
    expect(provision).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("aplio_dual_write.unauthorized");
  });

  it("checks the bearer before the window", async () => {
    const { handler } = setup({ now: new Date(CUTOVER) });
    expect((await handler(request(body, null))).status).toBe(401);
  });

  it("answers 410 at the cutover instant and after it", async () => {
    for (const now of [
      new Date(CUTOVER),
      new Date(Date.parse(CUTOVER) + 60_000),
    ]) {
      const { handler, provision } = setup({ now });
      expect(await read(await handler(request()))).toEqual({
        status: 410,
        body: { error: "cutover_passed" },
      });
      expect(provision).not.toHaveBeenCalled();
    }
  });

  it("accepts a request one millisecond before the cutover", async () => {
    const { handler } = setup({ now: new Date(Date.parse(CUTOVER) - 1) });
    expect((await handler(request())).status).toBe(200);
  });

  it("answers 400 with paths only for a bad body", async () => {
    const { handler, provision } = setup();
    const response = await handler(
      request({ ...body, email: "not-an-email-secret", name: 7 }),
    );
    const result = await read(response);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: "bad_request",
      issues: expect.arrayContaining(["email", "name"]),
    });
    expect(JSON.stringify(result.body)).not.toContain("not-an-email-secret");
    expect(provision).not.toHaveBeenCalled();
  });

  it("answers 400 naming an extra field", async () => {
    const { handler } = setup();
    const result = await read(
      await handler(request({ ...body, isAdmin: true })),
    );
    expect(result).toEqual({
      status: 400,
      body: { error: "bad_request", issues: ["isAdmin"] },
    });
  });

  it("answers 400 for a body that is not JSON", async () => {
    const { handler } = setup();
    const result = await read(await handler(request("{nope")));
    expect(result).toEqual({
      status: 400,
      body: { error: "bad_request", issues: ["$"] },
    });
  });

  it("answers 200 created, passing the normalised input", async () => {
    const { handler, provision, log } = setup();
    expect(await read(await handler(request()))).toEqual({
      status: 200,
      body: { sgauthUserId: USER_ID, outcome: "created" },
    });
    expect(provision).toHaveBeenCalledWith({
      aplioId: "a-1",
      email: "ada@northeastern.edu",
      name: "Ada",
    });
    expect(log.info).toHaveBeenCalledWith("aplio_dual_write.provisioned", {
      aplioId: "a-1",
      outcome: "created",
    });
  });

  it("answers 200 existing, and accepts a null name", async () => {
    const { handler } = setup({
      result: { status: "existing", userId: USER_ID },
    });
    const result = await read(await handler(request({ ...body, name: null })));
    expect(result).toEqual({
      status: 200,
      body: { sgauthUserId: USER_ID, outcome: "existing" },
    });
  });

  it.each([
    ["tombstoned", "tombstoned"],
    ["unverified", "unverified_account"],
  ] as const)("answers 409 for %s", async (status, error) => {
    const { handler } = setup({ result: { status } });
    expect(await read(await handler(request()))).toEqual({
      status: 409,
      body: { error },
    });
  });

  it("answers 500 and logs the error name and code, never the address", async () => {
    const failure = Object.assign(new Error("boom ada@northeastern.edu"), {
      name: "PrismaClientKnownRequestError",
      code: "P2024",
    });
    const { handler, log } = setup({ fail: failure });
    expect(await read(await handler(request()))).toEqual({
      status: 500,
      body: { error: "internal" },
    });
    expect(log.error).toHaveBeenCalledWith("aplio_dual_write.failed", {
      aplioId: "a-1",
      errorName: "PrismaClientKnownRequestError",
      errorCode: "P2024",
    });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("northeastern");
  });

  it("sends Cache-Control: no-store on every response", async () => {
    const responses = [
      await setup({ secret: undefined }).handler(request()),
      await setup().handler(request(body, null)),
      await setup({ now: new Date(CUTOVER) }).handler(request()),
      await setup().handler(request({})),
      await setup().handler(request()),
    ];
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
