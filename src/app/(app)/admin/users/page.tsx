import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/admin/format";
import { listActivePositions } from "@/lib/admin/user-detail-queries";
import {
  clampPage,
  hasActiveFilters,
  parseUsersListParams,
  serializeUsersListParams,
  toListQuery,
} from "@/lib/admin/users-list-params";
import { listUsers, type AdminUser } from "@/lib/admin/users/queries";
import { requireAdmin } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { displayName } from "@/lib/user-display";
import { UsersFilters } from "./users-filters";

export const metadata: Metadata = { title: "Users" };

const PATH = "/admin/users";
const MAX_POSITION_BADGES = 3;
const INVITED_HINT =
  "Password not set — they'll get a set-password link the first time they sign in.";

type RawSearchParams = Record<string, string | string[] | undefined>;

function PositionBadges({ positions }: { positions: AdminUser["positions"] }) {
  if (positions.length === 0) {
    return <span className="text-muted-foreground">None</span>;
  }
  const shown = positions.slice(0, MAX_POSITION_BADGES);
  const more = positions.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((position) => (
        <Badge key={position.key} variant="outline">
          {position.name}
        </Badge>
      ))}
      {more > 0 ? <Badge variant="secondary">+{more}</Badge> : null}
    </div>
  );
}

function NameCell({ user }: { user: AdminUser }) {
  const shown = displayName(user);
  const invited = user.status === "ACTIVE" && !user.hasPassword;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href={`${PATH}/${user.id}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {shown}
        </Link>
        {user.isPrimaryAdmin ? (
          <Badge>Primary Admin</Badge>
        ) : user.isAdmin ? (
          <Badge variant="secondary">Admin</Badge>
        ) : null}
        {invited ? (
          <Badge variant="outline" title={INVITED_HINT}>
            Invited
            <span className="sr-only">. {INVITED_HINT}</span>
          </Badge>
        ) : null}
      </div>
      {shown !== user.name ? (
        <span className="text-xs text-muted-foreground">{user.name}</span>
      ) : null}
    </div>
  );
}

function StatusCell({ status }: { status: AdminUser["status"] }) {
  if (status === "DEACTIVATED") {
    return <Badge variant="secondary">Deactivated</Badge>;
  }
  if (status === "DELETED") return <Badge variant="destructive">Deleted</Badge>;
  return <span>Active</span>;
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  // The layout is skipped on soft navigation, so the page checks again.
  await requireAdmin(PATH);
  const params = parseUsersListParams(await searchParams);

  const [positions, first] = await Promise.all([
    listActivePositions(prisma),
    listUsers(prisma, toListQuery(params, params.page)),
  ]);
  // A page past the end reads as the last page.
  const page = clampPage(params.page, first.total, first.pageSize);
  const result =
    page === params.page
      ? first
      : await listUsers(prisma, toListQuery(params, page));

  const { users, total, pageSize } = result;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const pageHref = (target: number) => {
    const query = serializeUsersListParams({ ...params, page: target });
    return query.size > 0 ? `${PATH}?${query}` : PATH;
  };
  const hasPrevious = page > 1;
  const hasNext = to < total;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-muted-foreground">
          {total.toLocaleString("en-US")} {total === 1 ? "user" : "users"}
        </p>
      </div>

      <UsersFilters params={params} positions={positions} />

      {users.length === 0 ? (
        <p className="text-muted-foreground">
          {hasActiveFilters(params)
            ? "No users match these filters."
            : "No users yet."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Positions</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last sign-in</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="whitespace-normal">
                  <NameCell user={user} />
                </TableCell>
                <TableCell className="break-all whitespace-normal">
                  {user.status === "DELETED" ? "—" : user.email}
                </TableCell>
                <TableCell className="whitespace-normal">
                  <PositionBadges positions={user.positions} />
                </TableCell>
                <TableCell>
                  <StatusCell status={user.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {user.lastLoginAt ? formatDate(user.lastLoginAt) : "Never"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {total > 0 ? (
        <nav
          aria-label="Pagination"
          className="flex flex-wrap items-center justify-between gap-3 text-sm"
        >
          <p className="text-muted-foreground">
            Showing {from.toLocaleString("en-US")}–{to.toLocaleString("en-US")}{" "}
            of {total.toLocaleString("en-US")}
          </p>
          <div className="flex gap-2">
            {hasPrevious ? (
              <Link
                href={pageHref(page - 1)}
                className={buttonVariants({ variant: "outline" })}
              >
                Previous
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className={
                  buttonVariants({ variant: "outline" }) + " opacity-50"
                }
              >
                Previous
              </span>
            )}
            {hasNext ? (
              <Link
                href={pageHref(page + 1)}
                className={buttonVariants({ variant: "outline" })}
              >
                Next
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className={
                  buttonVariants({ variant: "outline" }) + " opacity-50"
                }
              >
                Next
              </span>
            )}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
