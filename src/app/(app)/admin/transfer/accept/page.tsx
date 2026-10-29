import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AcceptTransferPanel } from "@/components/admin/transfer/accept-transfer-panel";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAcceptView } from "@/lib/admin/transfer-queries";
import { acceptState } from "@/lib/admin/transfer-view";
import { requireAdmin } from "@/lib/auth/guards";
import { formatEt } from "@/lib/email/layout";

export const metadata: Metadata = { title: "Primary Admin transfer" };

const PATH = "/admin/transfer/accept";

// The emailed link carries no id: the page finds the transfer addressed to
// whoever is signed in. Anyone with none gets the same 404 as an unknown URL.
export default async function AcceptTransferPage() {
  // The layout is skipped on soft navigation, so the page checks again.
  const viewer = await requireAdmin(PATH);
  const view = await getAcceptView(viewer.id);
  if (!view) notFound();

  const state = acceptState(view, new Date());

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Card>
        {state.kind === "pending" ? (
          <>
            <CardHeader>
              <CardTitle className="text-xl">
                {state.fromName} wants to make you the Primary Admin
              </CardTitle>
              <CardDescription>
                Accept by {formatEt(state.expiresAt)}.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
                <li>
                  You become the only Primary Admin. {state.fromName} stays an
                  admin.
                </li>
                <li>
                  You may be asked for your password and an authentication code
                  to accept.
                </li>
                <li>
                  After you accept, {state.fromName} has 24 hours to cancel.
                </li>
                <li>
                  When it takes effect, you and {state.fromName} are both signed
                  out everywhere.
                </li>
              </ul>
              <AcceptTransferPanel
                transferId={view.id}
                fromName={state.fromName}
              />
            </CardContent>
          </>
        ) : (
          <CardHeader>
            <CardTitle className="text-xl">
              {state.kind === "cooling"
                ? "You accepted"
                : state.kind === "cancelled"
                  ? "This transfer was cancelled"
                  : state.kind === "expired"
                    ? "This request expired"
                    : "This transfer is complete"}
            </CardTitle>
            {state.kind === "cooling" ? (
              <CardDescription>
                {state.executesAt
                  ? `You become Primary Admin on ${formatEt(state.executesAt)}.`
                  : "You become Primary Admin when the 24-hour window ends."}
              </CardDescription>
            ) : null}
          </CardHeader>
        )}
      </Card>
      <Link href="/admin" className={buttonVariants({ variant: "outline" })}>
        Back to the dashboard
      </Link>
    </div>
  );
}
