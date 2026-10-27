import type { Metadata } from "next";
import Link from "next/link";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth/guards";
import { ADMIN_NAV } from "@/lib/admin-nav";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  // The layout is skipped on soft navigation, so the page checks again.
  await requireAdmin("/admin");
  const sections = ADMIN_NAV.filter((section) => section.href !== "/admin");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-muted-foreground">
          Manage SGA accounts, positions, and connected tools.
        </p>
      </div>
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
              className="rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
