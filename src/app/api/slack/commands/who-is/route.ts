import { whoIsRoute } from "@/lib/slack/who-is-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Called by Slack for SGAssist's `/who-is` (#349), signed with
// SLACK_SIGNING_SECRET. Reads only.
export const POST = whoIsRoute;
