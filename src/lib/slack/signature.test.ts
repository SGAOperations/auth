import { describe, expect, it, vi } from "vitest";
import {
  SLACK_SIGNATURE_MAX_AGE_SECONDS,
  slackSignature,
  verifySlackRequest,
} from "@/lib/slack/signature";

const SECRET = "test-signing-secret";
const NOW_SECONDS = 1_700_000_000;
const NOW = new Date(NOW_SECONDS * 1000);
const BODY =
  "token=abc&team_id=T0123&user_id=U0456&command=%2Faccess&text=read+the+docs%21";

function request(options: {
  body?: string;
  timestamp?: string | null;
  signature?: string | null;
}): Request {
  const body = options.body ?? BODY;
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });
  if (options.timestamp !== null) {
    headers.set(
      "x-slack-request-timestamp",
      options.timestamp ?? String(NOW_SECONDS),
    );
  }
  if (options.signature !== null) {
    headers.set(
      "x-slack-signature",
      options.signature ??
        slackSignature(SECRET, options.timestamp ?? String(NOW_SECONDS), BODY),
    );
  }
  return new Request("https://auth.example.test/api/slack/access", {
    method: "POST",
    headers,
    body,
  });
}

function signedAt(secondsAgo: number): Request {
  const timestamp = String(NOW_SECONDS - secondsAgo);
  return request({
    timestamp,
    signature: slackSignature(SECRET, timestamp, BODY),
  });
}

describe("verifySlackRequest", () => {
  it("passes a valid signed request and returns the raw body", async () => {
    const result = await verifySlackRequest(request({}), SECRET, NOW);
    expect(result).toEqual({ ok: true, body: BODY });
  });

  describe("unsigned", () => {
    it("rejects a request without a signature", async () => {
      const result = await verifySlackRequest(
        request({ signature: null }),
        SECRET,
        NOW,
      );
      expect(result).toEqual({ ok: false, reason: "missing_headers" });
    });

    it("rejects a request without a timestamp", async () => {
      const result = await verifySlackRequest(
        request({ timestamp: null }),
        SECRET,
        NOW,
      );
      expect(result).toEqual({ ok: false, reason: "missing_headers" });
    });

    it("rejects a non-numeric timestamp", async () => {
      const result = await verifySlackRequest(
        request({ timestamp: "yesterday" }),
        SECRET,
        NOW,
      );
      expect(result).toEqual({ ok: false, reason: "missing_headers" });
    });
  });

  describe("wrong signature", () => {
    const valid = slackSignature(SECRET, String(NOW_SECONDS), BODY);
    const flipped = `${valid.slice(0, -1)}${valid.endsWith("0") ? "1" : "0"}`;

    it.each([
      ["one digit changed", flipped],
      ["a short signature", "v0=abc"],
      ["another secret", slackSignature("other", String(NOW_SECONDS), BODY)],
    ])("rejects %s", async (_label, signature) => {
      const result = await verifySlackRequest(
        request({ signature }),
        SECRET,
        NOW,
      );
      expect(result).toEqual({ ok: false, reason: "bad_signature" });
    });

    it("rejects a body changed after signing", async () => {
      const result = await verifySlackRequest(
        request({ body: `${BODY}&extra=1`, signature: valid }),
        SECRET,
        NOW,
      );
      expect(result).toEqual({ ok: false, reason: "bad_signature" });
    });
  });

  describe("stale", () => {
    it("rejects a request older than the window", async () => {
      const result = await verifySlackRequest(
        signedAt(SLACK_SIGNATURE_MAX_AGE_SECONDS + 1),
        SECRET,
        NOW,
      );
      expect(result).toEqual({ ok: false, reason: "stale" });
    });

    it("passes a request exactly at the window", async () => {
      const result = await verifySlackRequest(
        signedAt(SLACK_SIGNATURE_MAX_AGE_SECONDS),
        SECRET,
        NOW,
      );
      expect(result.ok).toBe(true);
    });

    it("rejects a timestamp too far in the future", async () => {
      const result = await verifySlackRequest(
        signedAt(-(SLACK_SIGNATURE_MAX_AGE_SECONDS + 1)),
        SECRET,
        NOW,
      );
      expect(result).toEqual({ ok: false, reason: "stale" });
    });
  });

  describe("unset secret", () => {
    it.each([undefined, ""])(
      "refuses everything for %j without reading the body",
      async (secret) => {
        const req = request({});
        const result = await verifySlackRequest(req, secret, NOW);
        expect(result).toEqual({ ok: false, reason: "not_configured" });
        expect(req.bodyUsed).toBe(false);
      },
    );
  });

  it("reads the body exactly once", async () => {
    const req = request({});
    const text = vi.spyOn(req, "text");
    const result = await verifySlackRequest(req, SECRET, NOW);
    expect(result.ok).toBe(true);
    expect(text).toHaveBeenCalledTimes(1);
    expect(req.bodyUsed).toBe(true);
  });
});

describe("slackSignature", () => {
  // The worked example in Slack's "Verifying requests from Slack" guide.
  it("reproduces Slack's documented signature", () => {
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    expect(
      slackSignature("8f742231b10e8888abcd99yyyzzz85a5", "1531420618", body),
    ).toBe(
      "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
    );
  });
});
