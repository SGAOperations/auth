import { describe, expect, it } from "vitest";
import { parseAccessCommandText } from "@/lib/access-requests/input";

describe("parseAccessCommandText", () => {
  it("splits on the bar and collapses whitespace", () => {
    expect(
      parseAccessCommandText(
        "  Notion   Pro \t|\n Edit   access  to  Finance ",
      ),
    ).toEqual({
      ok: true,
      product: "Notion Pro",
      access: "Edit access to Finance",
    });
  });

  it.each([[""], ["   "], ["help"], ["  HELP "], ["Notion"], ["Notion edit"]])(
    "answers usage for %j",
    (text) => {
      expect(parseAccessCommandText(text)).toEqual({
        ok: false,
        error: "usage",
      });
    },
  );

  it.each([[" | x"], ["x | "], ["|"], ["  |  "]])(
    "reports a missing part for %j",
    (text) => {
      expect(parseAccessCommandText(text)).toEqual({
        ok: false,
        error: "missing_part",
      });
    },
  );

  it("keeps a bar inside the access text", () => {
    expect(parseAccessCommandText("Notion | read | write")).toEqual({
      ok: true,
      product: "Notion",
      access: "read | write",
    });
  });

  it("accepts the limits and rejects one past them", () => {
    const product = (n: number) => `${"p".repeat(n)} | x`;
    const access = (n: number) => `x | ${"a".repeat(n)}`;
    expect(parseAccessCommandText(product(100)).ok).toBe(true);
    expect(parseAccessCommandText(product(101))).toEqual({
      ok: false,
      error: "product_too_long",
    });
    expect(parseAccessCommandText(access(500)).ok).toBe(true);
    expect(parseAccessCommandText(access(501))).toEqual({
      ok: false,
      error: "access_too_long",
    });
  });

  it("counts an entity and an astral character once", () => {
    expect(parseAccessCommandText(`${"&amp;".repeat(100)} | x`).ok).toBe(true);
    expect(parseAccessCommandText(`${"😀".repeat(100)} | x`).ok).toBe(true);
    expect(parseAccessCommandText(`${"😀".repeat(101)} | x`).ok).toBe(false);
  });

  it("decodes Slack's escaping", () => {
    expect(parseAccessCommandText("R&amp;D &lt;tool&gt; | x")).toEqual({
      ok: true,
      product: "R&D <tool>",
      access: "x",
    });
  });

  it.each([["No`tion | x"], ["x | a`b"], ["x | a\u0007b"], ["x\u0000y | z"]])(
    "refuses a backtick or control character in %j",
    (text) => {
      expect(parseAccessCommandText(text)).toEqual({
        ok: false,
        error: "bad_characters",
      });
    },
  );
});
