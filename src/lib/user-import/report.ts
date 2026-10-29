import type { ResultRow } from "@/lib/user-import/contract";

// Pure and client-safe: the form builds the report in the browser, and nothing
// about it is stored on the server.

const HEADER = [
  "line",
  "email",
  "name",
  "result",
  "positions_added",
  "invite",
  "errors",
] as const;

// A cell that starts with one of these runs as a formula in a spreadsheet.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string | number): string {
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The report CSV, CRLF-terminated lines, one row per file row. */
export function buildImportReport(rows: readonly ResultRow[]): string {
  const lines = [HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.line,
        row.email,
        row.name,
        row.result,
        row.addPositions.join("|"),
        row.invite ?? "",
        row.errors.map((error) => error.message).join("; "),
      ]
        .map(cell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
