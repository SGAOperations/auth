import { describe, expect, it } from "vitest";
import { escapeHtml, formatDuration, formatEt } from "./layout";
import { SAMPLES } from "./samples";
import {
  TEMPLATES,
  TEMPLATE_NAMES,
  prepareTemplate,
  renderTemplate,
} from "./templates";

const HOSTILE = "<script>alert(1)</script> & co";

describe("template registry", () => {
  it("holds exactly the 11 templates", () => {
    expect([...TEMPLATE_NAMES].sort()).toEqual([
      "account-locked",
      "account-unlock",
      "inactivity-notice",
      "pa-transfer-accepted",
      "pa-transfer-cancelled",
      "pa-transfer-completed",
      "pa-transfer-initiated",
      "reset-password",
      "security-notice",
      "set-password",
      "verify-email",
    ]);
  });

  it("has a sample for every template", () => {
    const sampled = new Set(SAMPLES.map((sample) => sample.template));
    expect([...sampled].sort()).toEqual([...TEMPLATE_NAMES].sort());
  });

  it("has unique sample ids", () => {
    const ids = SAMPLES.map((sample) => sample.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("rendering", () => {
  it.each(SAMPLES.map((sample) => [sample.id, sample] as const))(
    "renders %s with a subject, html and text",
    (_id, sample) => {
      const prepared = prepareTemplate(sample.template, sample.data);
      if (!prepared.ok) throw new Error(`sample ${sample.id} did not parse`);
      const { content } = prepared;
      expect(content.subject.length).toBeGreaterThan(0);
      expect(content.html.length).toBeGreaterThan(0);
      expect(content.text.length).toBeGreaterThan(0);
      expect(content).toMatchSnapshot();
    },
  );

  it("escapes a hostile name in HTML and never emits it raw", () => {
    const sample = SAMPLES.find((s) => s.id === "verify-email-hostile-name");
    if (sample?.template !== "verify-email") {
      throw new Error("missing hostile sample");
    }
    const { html, text } = renderTemplate(sample.template, sample.data);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    // Plain text is not HTML, so the name is printed as written.
    expect(text).toContain(HOSTILE);
  });

  it("puts each links field's URL in both the HTML and the text", () => {
    for (const sample of SAMPLES) {
      const prepared = prepareTemplate(sample.template, sample.data);
      if (!prepared.ok) throw new Error(`sample ${sample.id} did not parse`);
      for (const link of prepared.linkUrls) {
        expect(prepared.content.html).toContain(link);
        expect(prepared.content.text).toContain(link);
      }
    }
  });

  it("lists link fields only for templates that carry a URL", () => {
    expect(TEMPLATES["verify-email"].links).toEqual(["url"]);
    expect(TEMPLATES["pa-transfer-accepted"].links).toEqual(["cancelUrl"]);
    expect(TEMPLATES["inactivity-notice"].links).toEqual(["signInUrl"]);
    expect(TEMPLATES["account-locked"].links).toEqual([]);
  });
});

describe("schemas", () => {
  const url = "https://auth.northeasternsga.com/verify?token=t";

  it("rejects a missing url", () => {
    const prepared = prepareTemplate("verify-email", {
      expiresInMinutes: 60,
    });
    expect(prepared).toEqual({ ok: false, paths: ["url"] });
  });

  it("rejects a javascript: URL", () => {
    const prepared = prepareTemplate("verify-email", {
      url: "javascript:alert(1)",
      expiresInMinutes: 60,
    });
    expect(prepared.ok).toBe(false);
  });

  it("rejects a 101-character name", () => {
    const prepared = prepareTemplate("verify-email", {
      name: "n".repeat(101),
      url,
      expiresInMinutes: 60,
    });
    expect(prepared).toEqual({ ok: false, paths: ["name"] });
  });

  it("rejects a name with a line break", () => {
    const prepared = prepareTemplate("pa-transfer-initiated", {
      role: "initiator",
      toName: "Ada\r\nBcc: x@example.com",
      acceptBy: new Date(),
    });
    expect(prepared).toEqual({ ok: false, paths: ["toName"] });
  });

  it("names the issue path, never the value", () => {
    const prepared = prepareTemplate("verify-email", {
      url: "javascript:secret-value",
      expiresInMinutes: 60,
    });
    expect(JSON.stringify(prepared)).not.toContain("secret-value");
  });

  it("throws from renderTemplate on bad data", () => {
    expect(() =>
      renderTemplate("verify-email", {
        url: "nope",
        expiresInMinutes: 60,
      }),
    ).toThrow("Invalid data for email template verify-email: url");
  });
});

describe("layout helpers", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("formats a duration in days, hours or minutes", () => {
    expect(formatDuration(30)).toBe("30 minutes");
    expect(formatDuration(60)).toBe("1 hour");
    expect(formatDuration(1440)).toBe("24 hours");
    expect(formatDuration(2880)).toBe("2 days");
    expect(formatDuration(1440 * 7)).toBe("7 days");
    expect(formatDuration(120)).toBe("2 hours");
    expect(formatDuration(1500)).toBe("25 hours");
  });

  it("formats an Eastern time with its zone", () => {
    expect(formatEt(new Date("2026-10-16T19:00:00Z"))).toBe(
      "October 16, 2026 at 3:00 PM ET",
    );
  });
});
