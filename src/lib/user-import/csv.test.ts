import { describe, expect, it } from "vitest";
import { MAX_ROWS } from "@/lib/user-import/contract";
import { parseImportCsv } from "@/lib/user-import/csv";

function rows(text: string) {
  const result = parseImportCsv(text);
  if (!result.ok) {
    throw new Error(`expected rows, got ${JSON.stringify(result.errors)}`);
  }
  return result.rows;
}

function codes(text: string) {
  const result = parseImportCsv(text);
  if (result.ok) throw new Error("expected errors");
  return result.errors.map((issue) => issue.code);
}

describe("parseImportCsv", () => {
  it("reads a plain file", () => {
    expect(
      rows("email,name,positions\na@x.edu,Ann,vp-finance|senator\n"),
    ).toEqual([
      {
        line: 2,
        email: "a@x.edu",
        name: "Ann",
        positions: ["vp-finance", "senator"],
      },
    ]);
  });

  it("handles a BOM and CRLF line endings", () => {
    const parsed = rows(
      "﻿email,name,positions\r\na@x.edu,Ann,\r\nb@x.edu,Bo,\r\n",
    );
    expect(parsed.map((row) => [row.line, row.email])).toEqual([
      [2, "a@x.edu"],
      [3, "b@x.edu"],
    ]);
  });

  it("reads a quoted comma and an escaped quote", () => {
    const [row] = rows('email,name,positions\na@x.edu,"Doe, ""Jo"" Ann",\n');
    expect(row?.name).toBe('Doe, "Jo" Ann');
  });

  it("keeps the start line when a quoted value spans lines", () => {
    const parsed = rows(
      'email,name,positions\na@x.edu,"Two\nLines",\nb@x.edu,Bo,\n',
    );
    expect(parsed.map((row) => row.line)).toEqual([2, 4]);
    expect(parsed[0]?.name).toBe("Two\nLines");
  });

  it("flags an unterminated quote at its starting line", () => {
    const result = parseImportCsv(
      'email,name,positions\na@x.edu,"Ann,\nb@x.edu,Bo,\n',
    );
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: "MALFORMED_CSV", line: 2 }],
    });
  });

  it("flags text after a closing quote", () => {
    expect(codes('email,name,positions\na@x.edu,"Ann"x,\n')).toEqual([
      "MALFORMED_CSV",
    ]);
  });

  it("flags a row with the wrong number of values", () => {
    const result = parseImportCsv("email,name,positions\na@x.edu,Ann\n");
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: "MALFORMED_CSV", line: 2 }],
    });
  });

  it("accepts the header in any case and order", () => {
    const [row] = rows(" Positions ,EMAIL,Name\nsenator,a@x.edu,Ann\n");
    expect(row).toMatchObject({
      email: "a@x.edu",
      name: "Ann",
      positions: ["senator"],
    });
  });

  it.each([
    ["an extra column", "email,name,positions,notes\na@x.edu,Ann,,\n"],
    ["a missing column", "email,name\na@x.edu,Ann\n"],
    ["a renamed column", "Email,Full name,positions\na@x.edu,Ann,\n"],
    ["a duplicate column", "email,email,name\na@x.edu,a@x.edu,Ann\n"],
  ])("rejects %s", (_label, text) => {
    expect(codes(text)).toEqual(["BAD_HEADER"]);
  });

  it("skips blank lines", () => {
    const parsed = rows(
      "\nemail,name,positions\n\na@x.edu,Ann,\n\n\nb@x.edu,Bo,\n",
    );
    expect(parsed.map((row) => row.line)).toEqual([4, 7]);
  });

  it.each(["", "\n\n", "email,name,positions\n", "email,name,positions\n\n"])(
    "calls %j empty",
    (text) => {
      expect(codes(text)).toEqual(["FILE_EMPTY"]);
    },
  );

  it("refuses more than the row limit before reading rows", () => {
    const body = Array.from(
      { length: MAX_ROWS + 1 },
      (_, n) => `u${n}@x.edu,U${n},`,
    ).join("\n");
    expect(codes(`email,name,positions\n${body}\n`)).toEqual(["TOO_MANY_ROWS"]);
  });

  it("accepts exactly the row limit", () => {
    const body = Array.from(
      { length: MAX_ROWS },
      (_, n) => `u${n}@x.edu,U${n},`,
    ).join("\n");
    expect(rows(`email,name,positions\n${body}\n`)).toHaveLength(MAX_ROWS);
  });

  it("splits positions on a pipe, trims, drops empties and de-duplicates", () => {
    const [row] = rows("email,name,positions\na@x.edu,Ann,a| |b|a\n");
    expect(row?.positions).toEqual(["a", "b"]);
  });

  it("never lower-cases a position key", () => {
    const [row] = rows("email,name,positions\na@x.edu,Ann,VP-Finance\n");
    expect(row?.positions).toEqual(["VP-Finance"]);
  });

  it("reads a last row with no trailing newline", () => {
    expect(rows("email,name,positions\na@x.edu,Ann,senator")).toHaveLength(1);
  });
});
