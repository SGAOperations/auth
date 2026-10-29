import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TransferStatusCard } from "@/components/admin/transfer/transfer-status-card";
import { TransferWizard } from "@/components/admin/transfer/transfer-wizard";
import { buttonVariants } from "@/components/ui/button";
import {
  getInFlightTransfer,
  listRecipientCandidates,
} from "@/lib/admin/transfer-queries";
import { recipientOptions } from "@/lib/admin/transfer-view";
import { requireAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Transfer Primary Admin" };

const PATH = "/admin/transfer";

export default async function TransferPage() {
  // The layout is skipped on soft navigation, so the page checks again.
  const viewer = await requireAdmin(PATH);
  // A display gate: the transfer route enforces who may start one.
  if (!viewer.isPrimaryAdmin) notFound();

  const inFlight = await getInFlightTransfer();
  if (inFlight) {
    return (
      <div className="flex max-w-xl flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Transfer Primary Admin
        </h1>
        <p className="text-muted-foreground">
          A transfer is already in progress. Only one can run at a time.
        </p>
        <TransferStatusCard
          transfer={inFlight}
          viewer={viewer}
          now={new Date()}
        />
        <Link href="/admin" className={buttonVariants({ variant: "outline" })}>
          Back to the dashboard
        </Link>
      </div>
    );
  }

  const candidates = await listRecipientCandidates();
  const options = recipientOptions(
    candidates.filter((candidate) => candidate.id !== viewer.id),
    viewer.id,
  );
  return <TransferWizard options={options} />;
}
