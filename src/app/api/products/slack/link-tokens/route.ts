import { slackLinkTokenRoute } from "@/lib/slack/product-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST only. Called by a product's server with its API key (#312, #313).
export const POST = slackLinkTokenRoute;
