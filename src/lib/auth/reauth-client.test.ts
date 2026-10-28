import { describe, expect, it, vi } from "vitest";
import { fetchWithReauth } from "@/lib/auth/reauth-client";

const required = () =>
  Response.json({ code: "REAUTH_REQUIRED", message: "x" }, { status: 403 });

function setup(responses: Response[], prompt: boolean) {
  const send = vi.fn<typeof fetch>();
  for (const response of responses) send.mockResolvedValueOnce(response);
  const onReauthRequired = vi.fn().mockResolvedValue(prompt);
  const run = () =>
    fetchWithReauth(
      "/api/thing",
      { method: "POST", body: "{}" },
      { onReauthRequired, fetch: send },
    );
  return { send, onReauthRequired, run };
}

describe("fetchWithReauth", () => {
  it("passes a response that is not a 403 through with one fetch", async () => {
    const ok = Response.json({ ok: true });
    const { send, onReauthRequired, run } = setup([ok], true);
    expect(await run()).toBe(ok);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onReauthRequired).not.toHaveBeenCalled();
  });

  it("retries once after a confirmed prompt and returns the retry", async () => {
    const retried = Response.json({ ok: true });
    const { send, onReauthRequired, run } = setup([required(), retried], true);
    expect(await run()).toBe(retried);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onReauthRequired).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  });

  it("returns the original 403 when the prompt is cancelled", async () => {
    const first = required();
    const { send, run } = setup([first], false);
    expect(await run()).toBe(first);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not loop on a second REAUTH_REQUIRED", async () => {
    const second = required();
    const { send, onReauthRequired, run } = setup([required(), second], true);
    expect(await run()).toBe(second);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onReauthRequired).toHaveBeenCalledTimes(1);
  });

  it("does not prompt for a 403 with a different code", async () => {
    const other = Response.json({ code: "NOT_ADMIN" }, { status: 403 });
    const { onReauthRequired, run } = setup([other], true);
    expect(await run()).toBe(other);
    expect(onReauthRequired).not.toHaveBeenCalled();
  });

  it("does not prompt for a 403 that is not JSON", async () => {
    const plain = new Response("forbidden", { status: 403 });
    const { onReauthRequired, run } = setup([plain], true);
    expect(await run()).toBe(plain);
    expect(onReauthRequired).not.toHaveBeenCalled();
  });

  it("leaves the original response body readable by the caller", async () => {
    const first = required();
    const { run } = setup([first], false);
    const response = await run();
    expect(await response.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
  });
});
