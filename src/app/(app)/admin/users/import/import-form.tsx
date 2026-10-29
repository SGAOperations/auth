"use client";

import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { useReauth } from "@/components/reauth-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  MAX_FILE_CHARS,
  MAX_ROWS,
  type ApplyResponse,
  type FileIssue,
  type ImportRow,
  type PreviewResponse,
} from "@/lib/user-import/contract";
import { buildImportReport } from "@/lib/user-import/report";

const PREVIEW_PATH = "/api/sgauth/admin/users/import/preview";
const APPLY_PATH = "/api/sgauth/admin/users/import";

const COPY = {
  tooLarge: "This file is over 1 MB. Split it into smaller files.",
  failed: "The import failed and nothing was changed. Try again.",
  previewFailed: "Couldn't check the file. Try again.",
  changed:
    "Accounts or positions changed since your preview. Review the updated preview before importing.",
  conflict:
    "Someone else changed these accounts at the same time. Preview again.",
  rateLimited: "Too many requests. Wait a minute and try again.",
  signedOut: "Your session has ended. Sign in again.",
  reauth: "Confirm your password to import.",
} as const;

const TEMPLATE =
  "email,name,positions\r\njane.doe@northeastern.edu,Jane Doe,vp-finance|senator\r\n";

type Filter = "all" | "problems" | "new" | "existing";

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "problems", label: "Problems" },
  { id: "new", label: "New" },
  { id: "existing", label: "Existing" },
];

const matches: Record<Filter, (row: ImportRow) => boolean> = {
  all: () => true,
  problems: (row) => row.action === "invalid",
  new: (row) => row.action === "create",
  existing: (row) => row.action === "update" || row.action === "unchanged",
};

type Phase =
  | { name: "idle" }
  | { name: "checking" }
  | { name: "preview"; preview: PreviewResponse }
  | { name: "applying"; preview: PreviewResponse }
  | { name: "done"; result: ApplyResponse; sendInvites: boolean };

interface ErrorBody {
  code?: string;
  issues?: FileIssue[];
  preview?: PreviewResponse;
}

async function readBody<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function count(n: number, noun: string) {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function statusMessage(status: number): string {
  if (status === 429) return COPY.rateLimited;
  if (status === 401) return COPY.signedOut;
  return COPY.failed;
}

export function ImportForm() {
  const fileId = useId();
  const skipId = useId();
  const invitesId = useId();
  const reauth = useReauth();

  const [csv, setCsv] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [fileIssues, setFileIssues] = useState<FileIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [sendInvites, setSendInvites] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  function reset() {
    setPhase({ name: "idle" });
    setFileIssues([]);
    setMessage(null);
    setNotice(null);
    setSkipInvalid(false);
    setFilter("all");
  }

  async function onFile(file: File | undefined) {
    reset();
    if (!file) {
      setCsv(null);
      return;
    }
    const text = await file.text();
    if (text.length > MAX_FILE_CHARS) {
      setCsv(null);
      setMessage(COPY.tooLarge);
      return;
    }
    setCsv(text);
  }

  function showPreview(preview: PreviewResponse, why: string | null) {
    setPhase({ name: "preview", preview });
    setNotice(why);
    setMessage(null);
    setFilter("all");
  }

  async function runPreview() {
    if (csv === null) return;
    setPhase({ name: "checking" });
    setFileIssues([]);
    setMessage(null);
    setNotice(null);
    try {
      const response = await fetch(PREVIEW_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      if (response.ok) {
        const preview = await readBody<PreviewResponse>(response);
        if (preview) {
          showPreview(preview, null);
          return;
        }
      }
      const body = await readBody<ErrorBody>(response);
      if (response.status === 422 && body?.code === "INVALID_FILE") {
        setFileIssues(body.issues ?? []);
      } else {
        setMessage(
          response.ok ? COPY.previewFailed : statusMessage(response.status),
        );
      }
    } catch {
      setMessage(COPY.previewFailed);
    }
    setPhase({ name: "idle" });
  }

  async function runApply(preview: PreviewResponse) {
    if (csv === null) return;
    setPhase({ name: "applying", preview });
    setMessage(null);
    setNotice(null);
    try {
      const response = await reauth.fetch(APPLY_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csv,
          digest: preview.digest,
          skipInvalid,
          sendInvites,
        }),
      });
      if (response.ok) {
        const result = await readBody<ApplyResponse>(response);
        if (result) {
          setPhase({ name: "done", result, sendInvites });
          return;
        }
      }
      const body = await readBody<ErrorBody>(response);
      const code = body?.code;
      if (
        (code === "PLAN_CHANGED" || code === "INVALID_ROWS") &&
        body?.preview
      ) {
        showPreview(body.preview, COPY.changed);
        return;
      }
      if (code === "REAUTH_REQUIRED") {
        setMessage(COPY.reauth);
      } else if (code === "CONFLICT" || code === "POSITION_LIMIT") {
        setMessage(COPY.conflict);
      } else if (response.status === 422 && code === "INVALID_FILE") {
        setFileIssues(body?.issues ?? []);
      } else {
        setMessage(statusMessage(response.status));
        if (response.status >= 500) toast.error(COPY.failed);
      }
    } catch {
      setMessage(COPY.failed);
      toast.error(COPY.failed);
    }
    setPhase({ name: "preview", preview });
  }

  const busy = phase.name === "checking" || phase.name === "applying";
  const estimatedRows =
    csv === null
      ? 0
      : Math.max(
          0,
          csv.split(/\r?\n/).filter((l) => l.trim() !== "").length - 1,
        );

  return (
    <div className="flex flex-col gap-6">
      {phase.name === "done" ? (
        <Done
          result={phase.result}
          sendInvites={phase.sendInvites}
          onAnother={() => {
            setCsv(null);
            setSendInvites(false);
            reset();
          }}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>CSV file</CardTitle>
            <CardDescription>
              Columns: email, name, positions. Separate position keys with |,
              for example vp-finance|senator. Up to{" "}
              {MAX_ROWS.toLocaleString("en-US")} rows.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor={fileId}>CSV file</Label>
              <Input
                id={fileId}
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={(event) => void onFile(event.target.files?.[0])}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => download("user-import-template.csv", TEMPLATE)}
              >
                Download template
              </Button>
              <Button
                type="button"
                disabled={csv === null || busy}
                onClick={() => void runPreview()}
              >
                {phase.name === "checking"
                  ? `Checking ${count(estimatedRows, "row")}…`
                  : "Preview import"}
              </Button>
            </div>
            {message ? (
              <p role="alert" className="text-sm text-destructive">
                {message}
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}

      {fileIssues.length > 0 ? (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">
              This file can&apos;t be imported
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul
              role="alert"
              className="flex list-disc flex-col gap-1 pl-5 text-sm"
            >
              {fileIssues.map((issue, index) => (
                <li key={`${issue.code}-${issue.line ?? index}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {phase.name === "preview" || phase.name === "applying" ? (
        <Preview
          preview={phase.preview}
          notice={notice}
          filter={filter}
          onFilter={setFilter}
          skipInvalid={skipInvalid}
          onSkipInvalid={setSkipInvalid}
          sendInvites={sendInvites}
          onSendInvites={setSendInvites}
          skipId={skipId}
          invitesId={invitesId}
          applying={phase.name === "applying"}
          onApply={() => void runApply(phase.preview)}
        />
      ) : null}
    </div>
  );
}

interface PreviewProps {
  preview: PreviewResponse;
  notice: string | null;
  filter: Filter;
  onFilter(filter: Filter): void;
  skipInvalid: boolean;
  onSkipInvalid(value: boolean): void;
  sendInvites: boolean;
  onSendInvites(value: boolean): void;
  skipId: string;
  invitesId: string;
  applying: boolean;
  onApply(): void;
}

function Preview({
  preview,
  notice,
  filter,
  onFilter,
  skipInvalid,
  onSkipInvalid,
  sendInvites,
  onSendInvites,
  skipId,
  invitesId,
  applying,
  onApply,
}: PreviewProps) {
  const { summary } = preview;
  // Problems first, then file order.
  const rows = useMemo(
    () =>
      preview.rows
        .filter(matches[filter])
        .sort(
          (a, b) =>
            Number(b.action === "invalid") - Number(a.action === "invalid") ||
            a.line - b.line,
        ),
    [preview.rows, filter],
  );

  const hasProblems = summary.invalid > 0;
  const blocked = hasProblems && !skipInvalid;
  const noWork = summary.create + summary.update === 0 && !sendInvites;
  const nothing = summary.valid === 0;
  const disabled = applying || blocked || nothing || noWork;

  let label = `Import ${count(summary.valid, "row")}`;
  if (applying) label = "Importing…";
  else if (!blocked && nothing) label = "Nothing to import.";
  else if (!blocked && noWork) {
    label = "Nothing to import. Every row already matches.";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview</CardTitle>
        {notice ? (
          <CardDescription role="status">{notice}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Badge>{summary.create} new</Badge>
          <Badge variant="secondary">
            {summary.update + summary.unchanged} existing
          </Badge>
          <Badge variant="secondary">{summary.unchanged} unchanged</Badge>
          <Badge variant="secondary">
            {summary.assignments} positions to assign
          </Badge>
          {hasProblems ? (
            <Badge variant="destructive">{summary.invalid} with problems</Badge>
          ) : null}
        </div>

        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Filter rows"
        >
          {FILTERS.map(({ id, label: text }) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant={filter === id ? "secondary" : "outline"}
              aria-pressed={filter === id}
              onClick={() => onFilter(id)}
            >
              {text}
            </Button>
          ))}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Row</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>Positions to add</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.line}>
                <TableCell>{row.line}</TableCell>
                <TableCell className="align-top">
                  <div className="break-all">{row.email || "—"}</div>
                  {row.errors.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5 text-xs text-destructive">
                      {row.errors.map((error) => (
                        <li key={error.code + error.message}>
                          {error.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </TableCell>
                <TableCell className="align-top">
                  {row.name}
                  {row.nameDiffers ? (
                    <div className="text-xs text-muted-foreground">
                      name in file ignored
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <ChangeBadge action={row.action} />
                </TableCell>
                <TableCell className="break-all">
                  {row.addPositions.join(", ") || "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {hasProblems ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              {count(summary.invalid, "row")} have problems. Nothing is imported
              until they&apos;re fixed. Fix the file and preview again, or skip
              them.
            </p>
            <div className="flex items-start gap-2">
              <Checkbox
                id={skipId}
                className="mt-0.5"
                checked={skipInvalid}
                disabled={applying}
                onCheckedChange={onSkipInvalid}
              />
              <Label htmlFor={skipId}>
                Skip the {summary.invalid} rows with problems
              </Label>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <div className="flex items-start gap-2">
            <Checkbox
              id={invitesId}
              className="mt-0.5"
              checked={sendInvites}
              disabled={applying}
              onCheckedChange={onSendInvites}
            />
            <Label htmlFor={invitesId}>Send set-password emails now</Label>
          </div>
          <p className="pl-6 text-sm text-muted-foreground">
            Users can set a password themselves from the sign-in page, so this
            is optional. Up to 50 emails per import; import the same file again
            to send more. People who were already invited are skipped.
          </p>
        </div>

        <div>
          <Button type="button" disabled={disabled} onClick={onApply}>
            {label}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ChangeBadge({ action }: { action: ImportRow["action"] }) {
  switch (action) {
    case "create":
      return <Badge>New</Badge>;
    case "update":
      return <Badge variant="secondary">Existing</Badge>;
    case "unchanged":
      return <Badge variant="outline">Unchanged</Badge>;
    case "invalid":
      return <Badge variant="destructive">Problem</Badge>;
  }
}

function Done({
  result,
  sendInvites,
  onAnother,
}: {
  result: ApplyResponse;
  sendInvites: boolean;
  onAnother(): void;
}) {
  const created = result.rows.filter((row) => row.result === "created").length;
  const updated = result.rows.filter((row) => row.result === "updated").length;
  const skipped = result.rows.filter((row) => row.result === "skipped").length;
  const { invites } = result;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import complete</CardTitle>
        <CardDescription role="status">
          Created {count(created, "account")}, updated {updated}, skipped{" "}
          {skipped}. Assigned {count(result.summary.assignments, "position")}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sendInvites && invites ? (
          <div className="flex flex-col gap-1 text-sm">
            <p>Sent {count(invites.sent, "set-password email")}.</p>
            {invites.deferredBatch > 0 ? (
              <p>
                {invites.deferredBatch} not sent yet: import the same file again
                with emails on.
              </p>
            ) : null}
            {invites.deferredDailyCap > 0 ? (
              <p>Stopped at today&apos;s email limit. Try again tomorrow.</p>
            ) : null}
            {invites.failed + invites.rateLimited > 0 ? (
              <p>
                {invites.failed + invites.rateLimited} couldn&apos;t be sent.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() =>
              download(
                `user-import-${new Date().toISOString().slice(0, 10)}.csv`,
                buildImportReport(result.rows),
              )
            }
          >
            Download report
          </Button>
          <Button type="button" variant="outline" onClick={onAnother}>
            Import another file
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
