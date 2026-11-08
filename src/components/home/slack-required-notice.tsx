import { allowSlackTitleUpdates } from "@/app/(app)/account/slack/actions";
import { Button } from "@/components/ui/button";

/**
 * Shown above the tools when the Slack mandate blocks a leader (#361). The
 * tiles stay; opening one lands on the /login interstitial. Plain form.
 */
export function SlackRequiredNotice({ linked }: { linked: boolean }) {
  return (
    <section
      aria-labelledby="slack-required-heading"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <h2
        id="slack-required-heading"
        className="font-heading text-base leading-snug font-medium"
      >
        SGA tools need one more step
      </h2>
      <p className="text-sm text-muted-foreground">
        Because you hold a leadership position, SGA tools stay closed until you
        allow SGAuth to update your Slack title.
        {linked ? "" : " This also links your Slack account."}
      </p>
      <form action={allowSlackTitleUpdates}>
        <Button type="submit">Allow Slack title updates</Button>
      </form>
    </section>
  );
}
