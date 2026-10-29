import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ProfileForm } from "@/components/account/profile-form";
import { SessionsCard } from "@/components/account/sessions-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toolHref, toolLetter } from "@/lib/account/tools";
import { loadAccountOverview } from "@/lib/account/server";
import { requireUser } from "@/lib/auth/guards";
import { cn } from "@/lib/utils";
import { displayName } from "@/lib/user-display";

export const metadata: Metadata = { title: "Your account" };

export default async function AccountPage() {
  const user = await requireUser("/account");
  const overview = await loadAccountOverview(user.id);
  if (!overview) redirect("/login");
  const { profile, positions, tools } = overview;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight break-words">
          Hi, {displayName(profile)}
        </h1>
        <p className="text-sm text-muted-foreground break-all">
          Signed in as {profile.email}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Your SGA tools</CardTitle>
          <CardDescription>
            One sign-in works across every SGA tool.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No tools are available to you yet. Tools appear here when an admin
              gives you a position or opens a tool to everyone.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tools.map((tool) => (
                <li key={tool.id}>
                  <a
                    href={toolHref(tool.baseUrl)}
                    className="flex h-full items-start gap-3 rounded-lg p-3 ring-1 ring-foreground/10 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-9 shrink-0 items-center justify-center rounded-md bg-brand font-semibold text-brand-foreground"
                    >
                      {toolLetter(tool.name)}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium break-words">
                        {tool.name}
                      </span>
                      <span className="line-clamp-2 block text-sm text-muted-foreground">
                        {tool.description}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            How your name appears across SGA tools.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm
            email={profile.email}
            name={profile.name}
            preferredName={profile.preferredName}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Positions</CardTitle>
          <CardDescription>
            Assigned by SGA admins. Positions decide which tools you can open.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {positions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              You don&apos;t hold any positions yet. An admin assigns them when
              you take on an SGA role.
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {positions.map((position) => (
                <li
                  key={position.key}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                >
                  <span className="break-words">{position.name}</span>
                  <Badge variant="outline" className="font-mono">
                    {position.key}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <SessionsCard />

      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
          <CardDescription>Password and two-step verification.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href="/account/security"
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            Manage security settings
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
