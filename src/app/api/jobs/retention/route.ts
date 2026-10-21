import { notImplementedJob } from "@/lib/jobs/handler";
import { jobRoute } from "@/lib/jobs/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stub until #90 supplies the retention sweep.
export const POST = jobRoute("retention", notImplementedJob("#90"));
