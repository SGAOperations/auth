import { describe, expect, it, vi } from "vitest";
import {
  SLACK_LEADERSHIP_FIELD_LABEL,
  SLACK_PROFILE_GET_URL,
  SLACK_PROFILE_SET_URL,
  SLACK_TEAM_PROFILE_URL,
  findLeadershipFieldId,
  getOwnSlackProfile,
  normalizeSlackText,
  setOwnSlackProfile,
} from "@/lib/slack/profile-api";

const TOKEN = "xoxp-test-token";

const stub = (respond: () => Response | Promise<Response>) =>
  vi.fn<typeof fetch>(async () => respond());

describe("getOwnSlackProfile", () => {
  it("parses a profile with a title and custom fields", async () => {
    const fetchStub = stub(() =>
      Response.json({
        ok: true,
        profile: {
          title: "President",
          fields: { Xf1: { value: "President", alt: "" } },
        },
      }),
    );
    expect(await getOwnSlackProfile(TOKEN, { fetch: fetchStub })).toEqual({
      ok: true,
      title: "President",
      fields: { Xf1: "President" },
    });
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe(SLACK_PROFILE_GET_URL);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("parses a profile whose fields are null or missing", async () => {
    const nullFields = stub(() =>
      Response.json({ ok: true, profile: { fields: null } }),
    );
    expect(await getOwnSlackProfile(TOKEN, { fetch: nullFields })).toEqual({
      ok: true,
      title: "",
      fields: {},
    });
  });

  it("answers invalid_response for a body of the wrong shape", async () => {
    const result = await getOwnSlackProfile(TOKEN, {
      fetch: stub(() => Response.json({ ok: true, profile: "nope" })),
    });
    expect(result).toEqual({
      ok: false,
      failure: { kind: "failed", error: "invalid_response" },
    });
  });
});

describe("setOwnSlackProfile", () => {
  it("sends the exact JSON body and the bearer header", async () => {
    const fetchStub = stub(() => Response.json({ ok: true }));
    const result = await setOwnSlackProfile(
      TOKEN,
      { title: "A | B", fieldId: "Xf1", value: "A | B" },
      { fetch: fetchStub },
    );
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe(SLACK_PROFILE_SET_URL);
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      profile: {
        title: "A | B",
        fields: { Xf1: { value: "A | B", alt: "" } },
      },
    });
  });
});

describe("findLeadershipFieldId", () => {
  const teamProfile = (fields: unknown[]) =>
    stub(() => Response.json({ ok: true, profile: { fields } }));

  it("finds the text field with the label", async () => {
    const fetchStub = teamProfile([
      { id: "Xf0", label: "Phone", type: "text" },
      { id: "Xf1", label: SLACK_LEADERSHIP_FIELD_LABEL, type: "text" },
    ]);
    expect(await findLeadershipFieldId(TOKEN, { fetch: fetchStub })).toEqual({
      ok: true,
      fieldId: "Xf1",
    });
    expect(fetchStub.mock.calls[0][0]).toBe(SLACK_TEAM_PROFILE_URL);
  });

  it("returns null when the label is missing", async () => {
    const fetchStub = teamProfile([
      { id: "Xf0", label: "Phone", type: "text" },
    ]);
    expect(await findLeadershipFieldId(TOKEN, { fetch: fetchStub })).toEqual({
      ok: true,
      fieldId: null,
    });
  });

  it("returns null when the field is not a text field", async () => {
    const fetchStub = teamProfile([
      { id: "Xf1", label: SLACK_LEADERSHIP_FIELD_LABEL, type: "long_text" },
    ]);
    expect(await findLeadershipFieldId(TOKEN, { fetch: fetchStub })).toEqual({
      ok: true,
      fieldId: null,
    });
  });
});

describe("failure classification", () => {
  it.each([
    "invalid_auth",
    "token_revoked",
    "token_expired",
    "account_inactive",
    "not_authed",
  ])("maps %s to revoked", async (error) => {
    const result = await getOwnSlackProfile(TOKEN, {
      fetch: stub(() => Response.json({ ok: false, error })),
    });
    expect(result).toEqual({
      ok: false,
      failure: { kind: "revoked", error },
    });
  });

  it("maps HTTP 429 with Retry-After to rate_limited", async () => {
    const result = await setOwnSlackProfile(
      TOKEN,
      { title: "t", fieldId: "Xf1", value: "t" },
      {
        fetch: stub(
          () =>
            new Response("", { status: 429, headers: { "Retry-After": "12" } }),
        ),
      },
    );
    expect(result).toEqual({
      ok: false,
      failure: { kind: "rate_limited", retryAfterSeconds: 12 },
    });
  });

  it("maps the ratelimited error body to rate_limited", async () => {
    const result = await getOwnSlackProfile(TOKEN, {
      fetch: stub(() => Response.json({ ok: false, error: "ratelimited" })),
    });
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "rate_limited" },
    });
  });

  it("maps a network error, non-JSON and unknown errors to failed", async () => {
    const network = await getOwnSlackProfile(TOKEN, {
      fetch: vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    const notJson = await getOwnSlackProfile(TOKEN, {
      fetch: stub(() => new Response("<html>", { status: 502 })),
    });
    const unknown = await getOwnSlackProfile(TOKEN, {
      fetch: stub(() => Response.json({ ok: false, error: "fatal_error" })),
    });
    expect(network).toEqual({
      ok: false,
      failure: { kind: "failed", error: "network" },
    });
    expect(notJson).toEqual({
      ok: false,
      failure: { kind: "failed", error: "network" },
    });
    expect(unknown).toEqual({
      ok: false,
      failure: { kind: "failed", error: "fatal_error" },
    });
  });

  it("never puts the token in a failure", async () => {
    const result = await getOwnSlackProfile(TOKEN, {
      fetch: stub(() => Response.json({ ok: false, error: "invalid_auth" })),
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("normalizeSlackText", () => {
  it("unescapes &, < and >", () => {
    expect(normalizeSlackText("A &amp; B &lt;C&gt;")).toBe("A & B <C>");
  });

  it("turns &amp;lt; into &lt;, not <", () => {
    expect(normalizeSlackText("&amp;lt;")).toBe("&lt;");
  });
});
