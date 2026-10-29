import {
  fileIssue,
  IMPORT_COLUMNS,
  MAX_ROWS,
  type FileIssue,
} from "@/lib/user-import/contract";

// Pure: no database, so the tests and the client can load it.

export interface ParsedRow {
  /** The physical file line the row starts on; the header is line 1. */
  line: number;
  email: string;
  name: string;
  /** Trimmed, de-duplicated in order, never lower-cased. */
  positions: string[];
}

export type ParseResult =
  | { ok: true; rows: ParsedRow[] }
  | { ok: false; errors: FileIssue[] };

/** More issues than this say nothing new about a file that is plainly wrong. */
const MAX_ISSUES = 20;

interface RawRecord {
  line: number;
  cells: string[];
}

type Tokenized =
  | { ok: true; records: RawRecord[] }
  | { ok: false; error: FileIssue };

const BOM = "﻿";

/** RFC 4180: quoted fields, `""` escapes, embedded commas and newlines. */
function tokenize(input: string): Tokenized {
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const records: RawRecord[] = [];

  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const endField = () => {
    cells.push(field);
    field = "";
    fieldStart = true;
  };
  const endRecord = () => {
    endField();
    // A line with nothing on it is not a record.
    const blank = cells.length === 1 && cells[0]?.trim() === "" && !quoted;
    if (!blank) records.push({ line: recordLine, cells });
    cells = [];
    quoted = false;
  };
  const malformed = (): Tokenized => ({
    ok: false,
    error: fileIssue("MALFORMED_CSV", { line: recordLine }),
  });

  while (i < text.length) {
    const char = text[i];
    if (char === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
      i += 1;
      let closed = false;
      while (i < text.length) {
        const inner = text[i];
        if (inner === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          closed = true;
          i += 1;
          break;
        }
        if (inner === "\n") line += 1;
        field += inner;
        i += 1;
      }
      if (!closed) return malformed();
      const next = text[i];
      if (
        next !== undefined &&
        next !== "," &&
        next !== "\r" &&
        next !== "\n"
      ) {
        return malformed();
      }
    } else if (char === ",") {
      endField();
      i += 1;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      i += 1;
      line += 1;
      endRecord();
      recordLine = line;
    } else {
      field += char;
      fieldStart = false;
      i += 1;
    }
  }
  if (cells.length > 0 || field !== "" || quoted) endRecord();

  return { ok: true, records };
}

function splitPositions(raw: string): string[] {
  const keys = raw
    .split("|")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  return [...new Set(keys)];
}

/**
 * Parses an import file. Columns are `email`, `name` and `positions`, in any
 * order and any case. Position keys are split on `|` and never altered
 * beyond trimming: `positionKeySchema` rejects `VP-Finance` on purpose.
 */
export function parseImportCsv(text: string): ParseResult {
  const tokens = tokenize(text);
  if (!tokens.ok) return { ok: false, errors: [tokens.error] };

  const [header, ...body] = tokens.records;
  if (!header) return { ok: false, errors: [fileIssue("FILE_EMPTY")] };

  const names = header.cells.map((cell) => cell.trim().toLowerCase());
  const columns = IMPORT_COLUMNS.map((column) => names.indexOf(column));
  const exact =
    names.length === IMPORT_COLUMNS.length &&
    columns.every((index) => index !== -1);
  if (!exact) {
    return {
      ok: false,
      errors: [fileIssue("BAD_HEADER", { line: header.line })],
    };
  }
  const [emailAt, nameAt, positionsAt] = columns as [number, number, number];

  if (body.length === 0)
    return { ok: false, errors: [fileIssue("FILE_EMPTY")] };
  if (body.length > MAX_ROWS) {
    return {
      ok: false,
      errors: [fileIssue("TOO_MANY_ROWS", { count: body.length })],
    };
  }

  const ragged = body
    .filter((record) => record.cells.length !== IMPORT_COLUMNS.length)
    .slice(0, MAX_ISSUES)
    .map((record) => fileIssue("MALFORMED_CSV", { line: record.line }));
  if (ragged.length > 0) return { ok: false, errors: ragged };

  return {
    ok: true,
    rows: body.map((record) => ({
      line: record.line,
      email: (record.cells[emailAt] ?? "").trim(),
      name: (record.cells[nameAt] ?? "").trim(),
      positions: splitPositions(record.cells[positionsAt] ?? ""),
    })),
  };
}
