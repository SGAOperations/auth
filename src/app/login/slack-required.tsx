import Link from "next/link";
import { allowSlackTitleUpdatesToContinue } from "@/app/(app)/account/slack/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SlackResult } from "@/lib/slack/result";
import { UseDifferentAccount } from "./use-different-account";

/**
 * The /login body for a leadership holder the Slack mandate blocks (#361): why,
 * and the one step that fixes it. Plain forms; only sign-out needs JavaScript.
 */
export function SlackRequired({
  linked,
  result,
}: {
  linked: boolean;
  result: { result: SlackResult; message: string } | null;
}) {
  const isFailure =
    result !== null &&
    result.result !== "title_updates_allowed" &&
    result.result !== "title_updates_stopped";
  return (
    <>
      <p className="text-sm">
        You hold an SGA leadership position. To use SGA tools, SGAuth needs to
        keep your Slack title matched to your positions. Slack will ask you to
        let SGAuth view and edit your profile.
        {linked ? "" : " This also links your Slack account."}
      </p>
      {result ? (
        <p
          role={isFailure ? "alert" : "status"}
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            isFailure && "text-destructive",
          )}
        >
          {result.message}
        </p>
      ) : null}
      <form action={allowSlackTitleUpdatesToContinue}>
        <Button type="submit" className="w-full">
          Allow Slack title updates
        </Button>
      </form>
      <Link
        href="/"
        className={cn(buttonVariants({ variant: "outline" }), "w-full")}
      >
        Go to SGAuth home
      </Link>
      <UseDifferentAccount />
    </>
  );
}
