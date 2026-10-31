import type { Metadata } from "next";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { readSlackLinkToken } from "@/lib/slack/identity";
import { SLACK_LINK_PATH } from "@/lib/slack/links";
import { cn } from "@/lib/utils";
import { confirmSlackLink } from "../actions";

export const metadata: Metadata = { title: "Link Slack" };

// The page a product's DM'd link opens (#313). Reading the token changes
// nothing, because Slack's link preview fetches this page too; only Confirm
// links the account.
export default async function SlackLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;
  const raw = typeof token === "string" && token.length <= 128 ? token : "";
  const user = await requireUser(
    raw
      ? `${SLACK_LINK_PATH}?token=${encodeURIComponent(raw)}`
      : SLACK_LINK_PATH,
  );
  const view = raw ? await readSlackLinkToken(prisma, raw) : null;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Link your Slack account</CardTitle>
          <CardDescription className="break-all">
            Signed in as {user.email}
          </CardDescription>
        </CardHeader>
        {view ? (
          <>
            <CardContent className="flex flex-col gap-2 text-sm">
              <p>
                {view.productName} asked to link the Slack account{" "}
                <span className="font-mono">{view.slackUserId}</span> to this
                SGA account. SGA tools will then know your Slack messages and
                commands are from you.
              </p>
              <p className="text-muted-foreground">
                Only confirm if you just ran a command in Slack and this is your
                account. Replaces any Slack account linked before.
              </p>
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2">
              <form action={confirmSlackLink}>
                <input type="hidden" name="token" value={raw} />
                <Button type="submit">Link Slack</Button>
              </form>
              <Link
                href="/account"
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Cancel
              </Link>
            </CardFooter>
          </>
        ) : (
          <CardContent className="text-sm">
            <p>
              This link has expired or was already used. Run the command in
              Slack again to get a new one.
            </p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
