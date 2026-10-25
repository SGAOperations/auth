import { describe, expect, it, vi } from "vitest";
import { withSessionEndpointErrorCapture } from "@/lib/analytics/route";

function setup(handler: (req: Request) => Promise<Response>) {
  const capture = vi.fn();
  const wrapped = withSessionEndpointErrorCapture(handler, { capture });
  return { capture, wrapped };
}

const get = (path: string) => new Request(`http://auth.test${path}`);

describe("withSessionEndpointErrorCapture", () => {
  it.each(["/api/auth/get-session", "/api/auth/get-session/"])(
    "captures a 5xx from %s and returns the response unchanged",
    async (path) => {
      const response = new Response(null, { status: 503 });
      const { capture, wrapped } = setup(async () => response);
      await expect(wrapped(get(path))).resolves.toBe(response);
      expect(capture).toHaveBeenCalledWith("session_endpoint_error", {
        properties: { status: 503, kind: "server_error" },
      });
    },
  );

  it("captures a throw as an exception and rethrows it", async () => {
    const boom = new Error("boom");
    const { capture, wrapped } = setup(async () => {
      throw boom;
    });
    await expect(wrapped(get("/api/auth/get-session"))).rejects.toBe(boom);
    expect(capture).toHaveBeenCalledWith("session_endpoint_error", {
      properties: { status: null, kind: "exception" },
    });
  });

  it.each([200, 401])("captures nothing for a %s", async (status) => {
    const { capture, wrapped } = setup(
      async () => new Response(null, { status }),
    );
    await wrapped(get("/api/auth/get-session"));
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures nothing for another path, even on a 500", async () => {
    const { capture, wrapped } = setup(
      async () => new Response(null, { status: 500 }),
    );
    await wrapped(get("/api/auth/sign-in/email"));
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not capture a throw on another path", async () => {
    const { capture, wrapped } = setup(async () => {
      throw new Error("boom");
    });
    await expect(wrapped(get("/api/auth/sign-in/email"))).rejects.toThrow(
      "boom",
    );
    expect(capture).not.toHaveBeenCalled();
  });
});
