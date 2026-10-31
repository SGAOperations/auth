import { hasPosition } from "@nusgaops/sgauth";
import { forbidden } from "next/navigation";
import { GATED_POSITION } from "../../lib/config";
import { requireSession } from "../../lib/session";

export const dynamic = "force-dynamic";

export default async function Gated() {
  const session = await requireSession();
  // 403 through app/forbidden.tsx, never a redirect.
  if (!hasPosition(session, GATED_POSITION)) forbidden();
  return <p>Access granted: {GATED_POSITION}.</p>;
}
