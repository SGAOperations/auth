import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatRelative, formatTime } from "@/lib/admin/format";
import { disabledReason } from "@/lib/admin/denial-copy";
import {
  listActivePositions,
  listUserAudit,
  listUserSessions,
} from "@/lib/admin/user-detail-queries";
import { getUserDetail } from "@/lib/admin/users/queries";
import { getSession } from "@/lib/auth/server";
import { requireAdmin } from "@/lib/auth/guards";
import { can, type UserAction } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { displayName } from "@/lib/user-display";
import { AccountActions } from "./account-actions";
import { AuditTimeline } from "./audit-timeline";
import { PositionsEditor } from "./positions-editor";
import { ProfileForm } from "./profile-form";
import { SessionsTable } from "./sessions-table";

export const metadata: Metadata = { title: "User" };

const idSchema = z.uuid();

type RawSearchParams = Record<string, string | string[] | undefined>;

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-lg border bg-muted/50 px-3 py-2 text-sm"
    >
      {children}
    </p>
  );
}

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { id } = await params;
  const path = `/admin/users/${id}`;
  // The layout is skipped on soft navigation, so the page checks again.
  const actor = await requireAdmin(path);
  if (!idSchema.safeParse(id).success) notFound();

  const now = new Date();
  const auditCursor = (await searchParams).auditCursor;
  const cursor = typeof auditCursor === "string" ? auditCursor : undefined;

  const user = await getUserDetail(prisma, id, now);
  if (!user) notFound();

  const deleted = user.status === "DELETED";
  const [timeline, sessions, options, session, slack] = await Promise.all([
    listUserAudit(prisma, id, cursor),
    deleted ? [] : listUserSessions(prisma, id, now),
    deleted ? [] : listActivePositions(prisma),
    getSession(),
    // Read-only here: only the user links or unlinks their Slack account.
    deleted
      ? null
      : prisma.slackIdentity.findUnique({
          where: { userId: id },
          select: { slackUserId: true },
        }),
  ]);

  const positionIds = [
    ...new Set(
      timeline.events.flatMap((row) => {
        const metadata = row.metadata;
        return typeof metadata === "object" &&
          metadata !== null &&
          !Array.isArray(metadata) &&
          typeof metadata.positionId === "string"
          ? [metadata.positionId]
          : [];
      }),
    ),
  ];
  const positionNames = new Map(
    (positionIds.length === 0
      ? []
      : await prisma.position.findMany({
          where: { id: { in: positionIds } },
          select: { id: true, key: true, name: true },
        })
    ).map((position) => [position.id, `${position.name} (${position.key})`]),
  );

  const shown = displayName(user);
  const invited = user.status === "ACTIVE" && !user.hasPassword;
  const decide = (action: UserAction) =>
    disabledReason(can(actor, action, user));

  const header = (
    <header className="flex flex-col gap-2">
      <Link
        href="/admin/users"
        className="w-fit text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        ← All users
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {deleted ? "Deleted user" : shown}
        </h1>
        {user.isPrimaryAdmin ? (
          <Badge>Primary Admin</Badge>
        ) : user.isAdmin ? (
          <Badge variant="secondary">Admin</Badge>
        ) : null}
        {invited ? <Badge variant="outline">Invited</Badge> : null}
        {user.status === "DEACTIVATED" ? (
          <Badge variant="secondary">Deactivated</Badge>
        ) : null}
        {user.lockedUntil ? (
          <Badge variant="destructive">
            Locked until {formatTime(user.lockedUntil)}
          </Badge>
        ) : null}
      </div>
      {deleted ? null : (
        <>
          <p className="break-all text-muted-foreground">{user.email}</p>
          <p className="text-sm text-muted-foreground">
            Created {formatDate(user.createdAt)} · Last sign-in{" "}
            {user.lastLoginAt ? formatRelative(user.lastLoginAt, now) : "never"}
            {" · "}Slack{" "}
            {slack ? (
              <span className="font-mono">{slack.slackUserId}</span>
            ) : (
              "not linked"
            )}
          </p>
        </>
      )}
    </header>
  );

  if (deleted) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Banner>
          This account was deleted
          {user.deletedAt ? ` on ${formatDate(user.deletedAt)}` : ""}. Personal
          data has been removed.
        </Banner>
        <AuditTimeline
          timeline={timeline}
          positionNames={positionNames}
          basePath={path}
          now={now}
          isFirstPage={cursor === undefined}
        />
      </div>
    );
  }

  const optionByKey = new Map(options.map((option) => [option.key, option]));
  const held = user.positions.flatMap((position) => {
    const option = optionByKey.get(position.key);
    return option ? [option] : [];
  });

  const isSelf = session?.user.id === user.id;
  const sessionItems = sessions.map((row) => ({
    ...row,
    isCurrent: isSelf && row.id === session?.session.id,
  }));

  const adminReason = decide(user.isAdmin ? "revokeAdmin" : "grantAdmin");
  const reasons = {
    admin: adminReason,
    deactivate: decide("deactivate"),
    reactivate: decide("reactivate"),
    unlock:
      decide("unlock") ??
      (user.lockedUntil ? null : "This account isn't locked."),
    resendInvite:
      decide("resendInvite") ??
      (user.status !== "ACTIVE"
        ? "Reactivate this account before sending an invite."
        : user.hasPassword
          ? "This user has already set a password."
          : null),
  };

  return (
    <div className="flex flex-col gap-6">
      {header}
      {user.status === "DEACTIVATED" ? (
        <Banner>This account is deactivated. They can&apos;t sign in.</Banner>
      ) : null}
      <ProfileForm
        userId={user.id}
        email={user.email}
        name={user.name}
        preferredName={user.preferredName}
        disabledReason={decide("updateProfile")}
      />
      <PositionsEditor
        userId={user.id}
        held={held}
        options={options}
        assignReason={decide("assignPosition")}
        unassignReason={decide("unassignPosition")}
      />
      <AccountActions
        userId={user.id}
        name={shown}
        email={user.email}
        isAdmin={user.isAdmin}
        status={user.status === "DEACTIVATED" ? "DEACTIVATED" : "ACTIVE"}
        reasons={reasons}
      />
      <SessionsTable
        userId={user.id}
        name={shown}
        sessions={sessionItems}
        revokeReason={decide("revokeSessions")}
      />
      <AuditTimeline
        timeline={timeline}
        positionNames={positionNames}
        basePath={path}
        now={now}
        isFirstPage={cursor === undefined}
      />
    </div>
  );
}
