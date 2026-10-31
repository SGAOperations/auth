import { z } from "zod";
import { MAX_ACTIVE_POSITIONS_PER_USER } from "@/lib/position-key";

// Pure and client-safe: zod and constants only, no database and no
// `server-only`, so the import form loads it too.

export const MAX_FILE_CHARS = 1_000_000;
export const MAX_ROWS = 1_000;
/** The most invite emails one import sends; the rest wait for a second run. */
export const INVITE_BATCH_MAX = 50;
export const NAME_MAX = 100;

export const IMPORT_COLUMNS = ["email", "name", "positions"] as const;

export const previewRequestSchema = z.strictObject({
  csv: z.string().min(1).max(MAX_FILE_CHARS),
});

export const applyRequestSchema = previewRequestSchema.extend({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  skipInvalid: z.boolean(),
  sendInvites: z.boolean(),
});

export type ApplyRequest = z.output<typeof applyRequestSchema>;

export type FileErrorCode =
  | "FILE_EMPTY"
  | "TOO_MANY_ROWS"
  | "BAD_HEADER"
  | "MALFORMED_CSV";

export type RowErrorCode =
  | "INVALID_EMAIL"
  | "DUPLICATE_EMAIL"
  | "NAME_REQUIRED"
  | "NAME_TOO_LONG"
  | "INVALID_POSITION_KEY"
  | "UNKNOWN_POSITION"
  | "DELETED_POSITION"
  | "POSITION_LIMIT"
  | "ACCOUNT_DEACTIVATED"
  | "ACCOUNT_DELETED"
  | "NOT_PERMITTED";

/** What a message needs beyond its code. */
export interface MessageParams {
  /** The row's own line, or the line the message points at. */
  line?: number;
  /** A position key. */
  key?: string;
  /** A count. */
  count?: number;
  /** An authorization denial reason. */
  reason?: string;
}

// Exhaustive, so a new code fails tsc until it has its copy.
const FILE_ERROR_COPY: Record<
  FileErrorCode,
  (params: MessageParams) => string
> = {
  FILE_EMPTY: () => "The file has no rows.",
  TOO_MANY_ROWS: ({ count }) =>
    `The file has ${count} rows; the limit is ${MAX_ROWS.toLocaleString("en-US")}.`,
  BAD_HEADER: ({ line }) =>
    `Row ${line}: expected exactly the columns email, name, positions.`,
  MALFORMED_CSV: ({ line }) =>
    `Row ${line}: a quoted value is not closed properly, or the row has the wrong number of values.`,
};

// The one place the row-error copy lives.
export const ROW_ERROR_COPY: Record<
  RowErrorCode,
  (params: MessageParams) => string
> = {
  INVALID_EMAIL: () => "Not a valid email address.",
  DUPLICATE_EMAIL: ({ line }) => `Same email as row ${line}.`,
  NAME_REQUIRED: () => "New accounts need a name.",
  NAME_TOO_LONG: () => `Name is over ${NAME_MAX} characters.`,
  INVALID_POSITION_KEY: ({ key }) =>
    `“${key}” isn't a valid position key (lower-case letters, digits and hyphens).`,
  UNKNOWN_POSITION: ({ key }) => `No position with key “${key}”.`,
  DELETED_POSITION: ({ key }) => `Position “${key}” was deleted.`,
  POSITION_LIMIT: ({ count }) =>
    `Would hold ${count} positions; the limit is ${MAX_ACTIVE_POSITIONS_PER_USER}.`,
  ACCOUNT_DEACTIVATED: () => "Account is deactivated. Reactivate it first.",
  ACCOUNT_DELETED: () => "Account was deleted and can't be imported.",
  NOT_PERMITTED: ({ reason }) => `You can't change this account (${reason}).`,
};

export interface FileIssue {
  code: FileErrorCode;
  line?: number;
  message: string;
}

export function fileIssue(
  code: FileErrorCode,
  params: MessageParams = {},
): FileIssue {
  return {
    code,
    ...(params.line === undefined ? {} : { line: params.line }),
    message: FILE_ERROR_COPY[code](params),
  };
}

export interface RowIssue {
  code: RowErrorCode;
  message: string;
}

export function rowIssue(
  code: RowErrorCode,
  params: MessageParams = {},
): RowIssue {
  return { code, message: ROW_ERROR_COPY[code](params) };
}

export type RowAction = "create" | "update" | "unchanged" | "invalid";

export interface ImportRow {
  line: number;
  email: string;
  name: string;
  action: RowAction;
  /** Position keys this import would add. Empty for an invalid row. */
  addPositions: string[];
  /** An existing account whose name differs from the file; the file's loses. */
  nameDiffers?: boolean;
  errors: RowIssue[];
}

export interface ImportSummary {
  rows: number;
  valid: number;
  invalid: number;
  create: number;
  update: number;
  unchanged: number;
  assignments: number;
}

export interface PreviewResponse {
  digest: string;
  summary: ImportSummary;
  rows: ImportRow[];
}

export type RowResult = "created" | "updated" | "unchanged" | "skipped";

export type InviteStatus =
  | "sent"
  | "rate_limited"
  | "failed"
  | "skipped_has_password"
  | "skipped_already_invited"
  | "deferred_batch"
  | "deferred_daily_cap";

export interface InviteCounts {
  sent: number;
  deferredBatch: number;
  deferredDailyCap: number;
  rateLimited: number;
  failed: number;
  skippedHasPassword: number;
  skippedAlreadyInvited: number;
}

export type ResultRow = ImportRow & {
  result: RowResult;
  invite?: InviteStatus;
};

export interface ApplyResponse {
  summary: ImportSummary;
  rows: ResultRow[];
  /** Null when the admin did not ask for invites. */
  invites: InviteCounts | null;
}
