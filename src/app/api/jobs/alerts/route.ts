import { notImplementedJob } from "@/lib/jobs/handler";
import { jobRoute } from "@/lib/jobs/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stub.
export const POST = jobRoute("alerts", notImplementedJob("#89"));
