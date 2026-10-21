import { notImplementedJob } from "@/lib/jobs/handler";
import { jobRoute } from "@/lib/jobs/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stub until #89 supplies the alert checks.
export const POST = jobRoute("alerts", notImplementedJob("#89"));
