import {
  TokenActionPage,
  tokenActionMetadata,
} from "@/components/token-action-page";
import { loadPaCancelView } from "@/lib/jobs/pa-transfer-actions";
import { formatEt } from "@/lib/email/layout";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const metadata = tokenActionMetadata("Cancel Primary Admin transfer");

// Public on purpose: the emailed link must work with no session, so this sits
// outside the (app) and /admin layouts, which require one.
export default async function CancelTransferPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read-only: a GET never consumes the token.
  const view = await loadPaCancelView(await searchParams, prisma);

  return (
    <TokenActionPage
      title="Cancel Primary Admin transfer"
      description={
        view.state === "ready" ? (
          <>
            This stops the transfer to <strong>{view.recipientName}</strong>,
            scheduled for {formatEt(view.executesAt)}.
          </>
        ) : undefined
      }
      state={view.state}
      token={view.state === "ready" ? view.token : undefined}
      confirmPath="/transfer/cancel/confirm"
      actionLabel="Cancel transfer"
      messages={{
        done: {
          title: "Transfer cancelled",
          body: "Both of you have been emailed.",
        },
        invalid: {
          title: "This link is no longer valid",
          body: "The transfer may already be cancelled or complete.",
        },
      }}
    />
  );
}
