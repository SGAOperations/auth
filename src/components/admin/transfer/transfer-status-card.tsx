import Link from "next/link";
import { TransferConfirmAction } from "@/components/admin/transfer/transfer-confirm-action";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  statusCardView,
  type InFlightTransfer,
} from "@/lib/admin/transfer-view";
import type { AuthzSubject } from "@/lib/authz";
import { displayName } from "@/lib/user-display";

/**
 * The in-flight transfer, shown to every admin so a transfer started from a
 * hijacked Primary Admin account is noticed. Only its two parties get buttons.
 */
export function TransferStatusCard({
  transfer,
  viewer,
  now,
}: {
  transfer: InFlightTransfer;
  viewer: AuthzSubject;
  now: Date;
}) {
  const view = statusCardView(transfer, viewer, now);
  const recipient = displayName(transfer.toUser);
  const hasActions = view.canCancel || view.canAccept || view.canDecline;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{view.title}</CardTitle>
        <CardDescription>{view.description}</CardDescription>
      </CardHeader>
      {hasActions ? (
        <CardFooter className="flex flex-wrap gap-2">
          {view.canAccept ? (
            <Link href="/admin/transfer/accept" className={buttonVariants()}>
              Review and accept
            </Link>
          ) : null}
          {view.canDecline ? (
            <TransferConfirmAction
              transferId={transfer.id}
              action="decline"
              viewer="recipient"
              triggerLabel="Decline"
              title="Decline the transfer?"
              description={`${displayName(transfer.fromUser)} stays Primary Admin and will be notified.`}
              keepLabel="Not yet"
              confirmLabel="Decline transfer"
              successMessage="Transfer declined."
            />
          ) : null}
          {view.canCancel ? (
            <TransferConfirmAction
              transferId={transfer.id}
              action="cancel"
              viewer="sender"
              triggerLabel="Cancel transfer"
              title={`Cancel the transfer to ${recipient}?`}
              description="They'll be notified."
              keepLabel="Keep transfer"
              confirmLabel="Cancel transfer"
              successMessage="Transfer cancelled."
            />
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}
