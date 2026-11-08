import type { Metadata } from "next";
import Link from "next/link";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ACCESS_REQUEST_TIME_ZONE,
  formatAccessRequest,
} from "@/lib/access-requests/format";
import {
  accessRequestPageSchema,
  listAccessRequests,
} from "@/lib/access-requests/list";
import { requireAccessRequestViewer } from "@/lib/access-requests/viewer";
import { prisma } from "@/lib/prisma";
import { displayName } from "@/lib/user-display";
import { CopyRequestButton } from "./copy-request-button";

export const metadata: Metadata = { title: "Access requests" };

const PATH = "/access";

type RawSearchParams = Record<string, string | string[] | undefined>;

const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: ACCESS_REQUEST_TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

function Heading() {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">Access requests</h1>
      <p className="text-muted-foreground">
        Requests for external product access, submitted with{" "}
        <code className="font-mono text-sm">/access</code> in Slack. Nothing
        here is granted automatically. Times are Eastern.
      </p>
    </div>
  );
}

function BackToNewest() {
  return (
    <Link href={PATH} className="underline-offset-4 hover:underline">
      ← Back to newest
    </Link>
  );
}

export default async function AccessRequestsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  // The layout is skipped on soft navigation, so the page checks again.
  await requireAccessRequestViewer(PATH);

  const parsed = accessRequestPageSchema.safeParse(await searchParams);
  if (!parsed.success) {
    return (
      <div className="flex flex-col gap-6">
        <Heading />
        <p role="alert" className="text-sm text-destructive">
          That page link isn&apos;t valid.
        </p>
        <nav aria-label="Pagination" className="text-sm">
          <BackToNewest />
        </nav>
      </div>
    );
  }

  const { cursor } = parsed.data;
  const { rows, nextCursor } = await listAccessRequests(
    prisma,
    cursor ?? undefined,
  );
  const olderHref = nextCursor
    ? `${PATH}?${new URLSearchParams({ cursor: nextCursor })}`
    : null;

  return (
    <div className="flex flex-col gap-6">
      <Heading />
      {rows.length === 0 ? (
        cursor ? (
          <p className="text-sm text-muted-foreground">No more requests.</p>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No access requests yet</EmptyTitle>
              <EmptyDescription>
                Requests made with <code className="font-mono">/access</code> in
                Slack show up here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      ) : (
        <Table label="Access requests">
          <TableHeader>
            <TableRow>
              <TableHead>Submitted</TableHead>
              <TableHead>Requester</TableHead>
              <TableHead>Position</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const text = formatAccessRequest(row);
              const requester = row.requester
                ? displayName(row.requester)
                : "Deleted user";
              return (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">
                    {timeFormat.format(row.createdAt)}
                  </TableCell>
                  <TableCell>
                    {row.requester ? (
                      <div className="flex flex-col">
                        <span>{requester}</span>
                        <span className="text-xs text-muted-foreground">
                          {row.requester.email}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">
                        Deleted user
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{row.positionName}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {row.positionKey}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal break-words">
                    {row.product}
                  </TableCell>
                  <TableCell className="whitespace-normal break-words">
                    <p>{row.access}</p>
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer text-muted-foreground">
                        Show text
                      </summary>
                      <code className="break-all font-mono text-xs">
                        {text}
                      </code>
                    </details>
                  </TableCell>
                  <TableCell>
                    <CopyRequestButton
                      text={text}
                      label={`Copy request from ${requester} for ${row.product}`}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {cursor || olderHref ? (
        <nav
          aria-label="Pagination"
          className="flex items-center gap-4 text-sm"
        >
          {cursor ? <BackToNewest /> : null}
          {olderHref ? (
            <Link
              href={olderHref}
              className="underline-offset-4 hover:underline"
            >
              Older requests →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
