import { describe, expect, it } from "vitest";
import {
  MAX_LOGGED_LENGTH,
  MAX_REPORTS_PER_REQUEST,
  parseCspReports,
  redactUrl,
} from "./csp-report";

describe("parseCspReports", () => {
  it("normalises the legacy csp-report body", () => {
    expect(
      parseCspReports({
        "csp-report": {
          "document-uri": "http://localhost:3000/reset?token=abc#frag",
          "violated-directive": "script-src",
          "effective-directive": "script-src",
          "blocked-uri": "inline",
          disposition: "report",
          "line-number": 4,
        },
      }),
    ).toEqual([
      {
        documentUrl: "http://localhost:3000/reset",
        blockedUrl: "inline",
        effectiveDirective: "script-src",
        disposition: "report",
        sourceFile: undefined,
        lineNumber: 4,
      },
    ]);
  });

  it("falls back to violated-directive when effective is absent", () => {
    const result = parseCspReports({
      "csp-report": { "violated-directive": "img-src" },
    });
    expect(result?.[0].effectiveDirective).toBe("img-src");
  });

  it("normalises the Reporting API array and skips other report types", () => {
    const result = parseCspReports([
      { type: "deprecation", url: "https://x.test/", body: { id: "x" } },
      {
        type: "csp-violation",
        url: "https://auth.test/",
        body: {
          documentURL: "https://auth.test/verify?token=secret",
          blockedURL: "https://evil.test/a.js?x=1",
          effectiveDirective: "script-src-elem",
          disposition: "enforce",
          sourceFile: null,
          lineNumber: null,
        },
      },
    ]);
    expect(result).toEqual([
      {
        documentUrl: "https://auth.test/verify",
        blockedUrl: "https://evil.test/a.js",
        effectiveDirective: "script-src-elem",
        disposition: "enforce",
        sourceFile: undefined,
        lineNumber: undefined,
      },
    ]);
  });

  it("returns at most MAX_REPORTS_PER_REQUEST violations (BT28)", () => {
    const entry = {
      type: "csp-violation",
      body: { effectiveDirective: "img-src" },
    };
    const result = parseCspReports(Array(300).fill(entry));
    expect(result).toHaveLength(MAX_REPORTS_PER_REQUEST);
    expect(MAX_REPORTS_PER_REQUEST).toBe(5);
  });

  it("cuts every logged string to MAX_LOGGED_LENGTH (BT28)", () => {
    const long = "x".repeat(5000);
    const [legacy] =
      parseCspReports({
        "csp-report": {
          "document-uri": `https://a.test/${long}`,
          "blocked-uri": long,
          "effective-directive": long,
          disposition: long,
          "source-file": `https://a.test/${long}`,
        },
      }) ?? [];
    const [reporting] =
      parseCspReports([
        {
          type: "csp-violation",
          body: {
            documentURL: `https://a.test/${long}`,
            blockedURL: long,
            effectiveDirective: long,
            disposition: long,
            sourceFile: `https://a.test/${long}`,
          },
        },
      ]) ?? [];
    for (const violation of [legacy, reporting]) {
      expect(violation).toBeDefined();
      for (const value of Object.values(violation ?? {})) {
        if (typeof value === "string") {
          expect(value.length).toBeLessThanOrEqual(MAX_LOGGED_LENGTH);
        }
      }
    }
    expect(MAX_LOGGED_LENGTH).toBe(100);
  });

  it("accepts an empty reports array", () => {
    expect(parseCspReports([])).toEqual([]);
  });

  it.each([
    ["an empty object", {}],
    ["a string", "nope"],
    ["null", null],
    ["a legacy body without a directive", { "csp-report": {} }],
    [
      "a csp-violation without a directive",
      [{ type: "csp-violation", body: {} }],
    ],
    ["a non-object array entry", [1]],
  ])("rejects %s", (_name, input) => {
    expect(parseCspReports(input)).toBeNull();
  });
});

describe("redactUrl", () => {
  it("drops query and fragment", () => {
    expect(redactUrl("https://a.test/p?token=1#x")).toBe("https://a.test/p");
  });

  it("keeps non-URL keywords verbatim", () => {
    expect(redactUrl("inline")).toBe("inline");
    expect(redactUrl("eval")).toBe("eval");
  });

  it("reduces non-http schemes to the scheme", () => {
    expect(redactUrl("data:text/html,secret")).toBe("data:");
  });
});
