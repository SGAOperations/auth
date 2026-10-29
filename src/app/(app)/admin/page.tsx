import type { Metadata } from "next";
import Link from "next/link";
import { TransferStatusCard } from "@/components/admin/transfer/transfer-status-card";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getInFlightTransfer } from "@/lib/admin/transfer-queries";
import { requireAdmin } from "@/lib/auth/guards";
import { ADMIN_NAV } from "@/lib/admin-nav";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  // The layout is skipped on soft navigation, so the page checks again.
  const viewer = await requireAdmin("/admin");
  const inFlight = await getInFlightTransfer();
  const sections = ADMIN_NAV.filter((section) => section.href !== "/admin");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="text-muted-foreground">
            Manage SGA accounts, positions, and connected tools.
          </p>
        </div>
        {viewer.isPrimaryAdmin && !inFlight ? (
          <Link
            href="/admin/transfer"
            className={buttonVariants({ variant: "outline" })}
          >
            Transfer Primary Admin
          </Link>
        ) : null}
      </div>
      {inFlight ? (
        <TransferStatusCard
          transfer={inFlight}
          viewer={viewer}
          now={new Date()}
        />
      ) : null}
      {sections.length === 0 ? (
        <p className="text-muted-foreground">
          Admin tools will appear here as they&apos;re added.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((section) => (
            <Link
              key={section.href}
              href={section.href}
              className="rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring"
            >
              <Card className="h-full hover:bg-muted/50">
                <CardHeader>
                  <CardTitle>{section.label}</CardTitle>
                  <CardDescription>{section.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
