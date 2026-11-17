import { positionHoldersRoute } from "@/lib/product-api/position-holders-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST only, with a batch of keys in the body. Called by a product's server
// with its API key. Reads only.
export const POST = positionHoldersRoute;
