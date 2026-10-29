import { describe, expect, it } from "vitest";
import type { ResultRow } from "@/lib/user-import/contract";
import { buildImportReport } from "@/lib/user-import/report";

function row(overrides: Partial<ResultRow> = {}): ResultRow {
  return {
    line: 2,
    email: "ann@northeastern.edu",
    name: "Ann",
    action: "create",
    addPositions: [],
    errors: [],
    result: "created",
    ...overrides,
  };
}

describe("buildImportReport", () => {
  it("writes the header and one line per row", () => {
    const report = buildImportReport([
      row({ addPositions: ["senator", "vp-finance"], invite: "sent" }),
      row({
        line: 3,
        email: "bad",
        action: "invalid",
        result: "skipped",
        errors: [
          { code: "INVALID_EMAIL", message: "Not a valid email address." },
          { code: "NAME_REQUIRED", message: "New accounts need a name." },
        ],
      }),
    ]);
    expect(report.split("\r\n")).toEqual([
      "line,email,name,result,positions_added,invite,errors",
      "2,ann@northeastern.edu,Ann,created,senator|vp-finance,sent,",
      "3,bad,Ann,skipped,,,Not a valid email address.; New accounts need a name.",
      "",
    ]);
  });

  it("quotes a name with a comma, a quote or a newline", () => {
    const report = buildImportReport([
      row({ name: 'Doe, "Jo"' }),
      row({ name: "Two\nLines" }),
    ]);
    expect(report).toContain('"Doe, ""Jo"""');
    expect(report).toContain('"Two\nLines"');
  });

  it.each([
    ['=HYPERLINK("http://evil","x")', `"'=HYPERLINK(""http://evil"",""x"")"`],
    ["+1", "'+1"],
    ["-2", "'-2"],
    ["@x", "'@x"],
    ["\tTab", "'\tTab"],
  ])("neutralises the formula name %j", (name, expected) => {
    const [, line] = buildImportReport([row({ name })]).split("\r\n");
    expect(line).toContain(`,${expected},`);
  });

  it("leaves an ordinary name alone", () => {
    expect(buildImportReport([row({ name: "Mary-Jane O'Neil" })])).toContain(
      ",Mary-Jane O'Neil,",
    );
  });
});
