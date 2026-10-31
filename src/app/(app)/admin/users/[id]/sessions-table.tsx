"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { DisabledReason } from "@/components/admin/disabled-reason";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAdminAction } from "@/hooks/use-admin-action";
import { formatDateTime } from "@/lib/admin/format";
import { forceRelogin, revokeUserSession } from "../actions";

const CURRENT_SESSION_REASON =
  "This is your current session. Sign out from the account menu.";

export interface SessionItem {
  id: string;
  device: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  /** The admin's own session, on the admin's own page. */
  isCurrent: boolean;
}

type Confirm = { kind: "session"; id: string } | { kind: "all" } | null;

export function SessionsTable({
  userId,
  name,
  sessions,
  revokeReason,
}: {
  userId: string;
  name: string;
  sessions: readonly SessionItem[];
  /** Why revoking is off for every row, or null when the admin may revoke. */
  revokeReason: string | null;
}) {
  const { run, pending } = useAdminAction();
  const [confirm, setConfirm] = useState<Confirm>(null);

  const count = sessions.length;
  const forceReason =
    revokeReason ?? (count === 0 ? "There are no active sessions." : null);

  function confirmed() {
    if (confirm?.kind === "session") {
      const { id } = confirm;
      void run(() => revokeUserSession(userId, id), {
        success: "Session revoked.",
      });
    } else if (confirm?.kind === "all") {
      void run(() => forceRelogin(userId), {
        success: `${name} was signed out everywhere.`,
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <CardDescription>
          Where this account is signed in right now.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {count === 0 ? (
          <p className="text-sm text-muted-foreground">No active sessions.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Signed in</TableHead>
                <TableHead>Last active</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => {
                const rowReason =
                  revokeReason ??
                  (session.isCurrent ? CURRENT_SESSION_REASON : null);
                return (
                  <TableRow key={session.id}>
                    <TableCell className="whitespace-normal">
                      <span title={session.userAgent ?? undefined}>
                        {session.device}
                      </span>
                      {session.isCurrent ? (
                        <Badge variant="secondary" className="ml-2">
                          This device
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {session.ip ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(session.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(session.lastActiveAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(session.expiresAt)}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <DisabledReason reason={rowReason} busy={pending}>
                        {(controlProps) => (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            {...controlProps}
                            onClick={() =>
                              setConfirm({ kind: "session", id: session.id })
                            }
                          >
                            Revoke
                            <span className="sr-only"> {session.device}</span>
                          </Button>
                        )}
                      </DisabledReason>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <DisabledReason reason={forceReason} busy={pending}>
          {(controlProps) => (
            <Button
              type="button"
              variant="destructive"
              {...controlProps}
              onClick={() => setConfirm({ kind: "all" })}
            >
              Force re-login
            </Button>
          )}
        </DisabledReason>
      </CardContent>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={
          confirm?.kind === "all"
            ? `Sign ${name} out everywhere?`
            : "Revoke this session?"
        }
        description={
          confirm?.kind === "all"
            ? `All ${count} ${count === 1 ? "session ends" : "sessions end"} now. Products that use tokens may keep access for up to 10 minutes.`
            : "The device is signed out right away."
        }
        confirmLabel={
          confirm?.kind === "all" ? "Sign out everywhere" : "Revoke"
        }
        destructive
        onConfirm={confirmed}
      />
    </Card>
  );
}
