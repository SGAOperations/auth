import { getConfig } from "../../lib/config";
import { requireSession } from "../../lib/session";

export const dynamic = "force-dynamic";

export default async function Protected() {
  const session = await requireSession();
  return (
    <p>
      Signed in as {session.user.email} on {getConfig().productName}.
    </p>
  );
}
