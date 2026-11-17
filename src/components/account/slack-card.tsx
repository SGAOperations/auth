import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { connectSlack, unlinkSlack } from "@/app/(app)/account/slack/actions";
import type { SlackResult } from "@/lib/slack/result";

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/**
 * The account page's Slack card (#313, #314): the linked Slack account, with
 * Unlink, or a way to link one. Plain forms, so it works without JavaScript.
 */
export function SlackCard({
  identity,
  canConnect,
  mandateRequired,
  result,
}: {
  identity: { slackTeamId: string; slackUserId: string; linkedAt: Date } | null;
  canConnect: boolean;
  /** The Slack mandate is on and this user is a leader (#361). */
  mandateRequired: boolean;
  result: { result: SlackResult; message: string } | null;
}) {
  return (
    <Card id="slack">
      <CardHeader>
        <CardTitle>Slack</CardTitle>
        <CardDescription>
          Lets SGA tools such as Chambers recognise you when you use their Slack
          commands.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {result && (
          <p role="status" className="rounded-md border px-3 py-2">
            {result.message}
          </p>
        )}
        {identity ? (
          <>
            <p>
              Linked to Slack user{" "}
              <span className="font-mono">{identity.slackUserId}</span> since{" "}
              {dateFormat.format(identity.linkedAt)}.
            </p>
            <form action={unlinkSlack} className="flex flex-col gap-2">
              <div>
                <Button type="submit" variant="outline">
                  Unlink Slack
                </Button>
              </div>
              {mandateRequired && (
                <p className="text-muted-foreground">
                  Unlinking closes SGA tools to you while you hold a leadership
                  position.
                </p>
              )}
            </form>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              No Slack account is linked. Run a Chambers command in Slack, such
              as <span className="font-mono">/chambers-room</span>, and open the
              link it sends you
              {canConnect ? ", or connect here" : ""}.
            </p>
            {mandateRequired && (
              <p className="text-muted-foreground">
                Required for leadership positions: SGA tools stay closed to you
                until you link Slack.
              </p>
            )}
            {canConnect && (
              <form action={connectSlack}>
                <Button type="submit">Connect Slack</Button>
              </form>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
