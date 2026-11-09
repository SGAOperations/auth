import { slackAccessCommandRoute } from "@/lib/slack/command-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST only. Slack calls this route (#342); the Slack request signature is its
// only credential, so it takes no cookie and no product API key.
export const POST = slackAccessCommandRoute;
