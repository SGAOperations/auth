import { aplioDualWriteRoute } from "@/lib/import/aplio-dual-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST only. Called by Aplio's server for each new signup until
// APLIO_READ_CUTOVER_AT, guarded by the APLIO_DUAL_WRITE_SECRET bearer.
export const POST = aplioDualWriteRoute;
