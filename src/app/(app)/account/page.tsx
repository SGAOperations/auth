import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ProfileForm } from "@/components/account/profile-form";
import { SessionsCard } from "@/components/account/sessions-card";
import { SlackCard } from "@/components/account/slack-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { loadAccountOverview } from "@/lib/account/server";
import { requireUser } from "@/lib/auth/guards";
import { slackResultMessage } from "@/lib/slack/result";
import { getOwnSlackIdentity, slackOpenIdConfig } from "@/lib/slack/service";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Your account" };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("/account");
  const [overview, slackIdentity] = await Promise.all([
    loadAccountOverview(user.id),
    getOwnSlackIdentity(user.id),
  ]);
  if (!overview) redirect("/login");
  const { profile, positions } = overview;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight break-words">
          Your account
        </h1>
        <p className="text-sm text-muted-foreground break-all">
          Signed in as {profile.email}
        </p>
      </header>

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

      <SlackCard
        identity={slackIdentity}
        canConnect={slackOpenIdConfig() !== null}
        result={slackResultMessage((await searchParams).slack)}
      />

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
