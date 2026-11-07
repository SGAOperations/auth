import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  allowSlackTitleUpdates,
  connectSlack,
  stopSlackTitleUpdates,
  unlinkSlack,
} from "@/app/(app)/account/slack/actions";
import type { SlackResult } from "@/lib/slack/result";

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/**
 * The account page's Slack card (#313, #314): the linked Slack account, with
 * Unlink, or a way to link one, and for leaders the Slack title consent (#358).
 * Plain forms, so it works without JavaScript.
 */
export function SlackCard({
  identity,
  canConnect,
  isLeadership,
  profileAccess,
  result,
}: {
  identity: { slackTeamId: string; slackUserId: string; linkedAt: Date } | null;
  canConnect: boolean;
  isLeadership: boolean;
  profileAccess: { grantedAt: Date } | null;
  result: { result: SlackResult; message: string } | null;
}) {
  // Withdrawing needs no Slack settings and no leadership, so a held grant
  // always shows its Stop button.
  const showTitleUpdates =
    profileAccess !== null || (isLeadership && canConnect);
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
              {profileAccess && (
                <p className="text-muted-foreground">
                  Unlinking also stops Slack title updates.
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
            {canConnect && (
              <form action={connectSlack}>
                <Button type="submit">Connect Slack</Button>
              </form>
            )}
          </>
        )}
        {showTitleUpdates && (
          <section
            aria-labelledby="slack-title-heading"
            className="flex flex-col gap-3 border-t pt-4"
          >
            <h3 id="slack-title-heading" className="font-medium">
              Slack title
            </h3>
            {profileAccess ? (
              <>
                <p>
                  SGAuth can update your Slack title. Allowed on{" "}
                  {dateFormat.format(profileAccess.grantedAt)}.
                </p>
                <form action={stopSlackTitleUpdates}>
                  <Button type="submit" variant="outline">
                    Stop title updates
                  </Button>
                </form>
              </>
            ) : (
              <>
                <p className="text-muted-foreground">
                  SGAuth can keep your Slack title matched to your leadership
                  positions. Slack will ask you to let SGAuth view and edit your
                  profile.
                  {identity ? "" : " This also links your Slack account."}
                </p>
                <form action={allowSlackTitleUpdates}>
                  <Button type="submit">Allow Slack title updates</Button>
                </form>
              </>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
