import { slackLookupRoute } from "@/lib/slack/product-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST only, so a list of ids never lands in a URL or an access log. Called by
// a product's server with its API key (#312, #313). Reads only.
export const POST = slackLookupRoute;
