import { formatDateTime } from "@/lib/admin/format";

// Pure. The one line an access request is copied as, from the structured
// fields. The Slack reply (#342) and the access page (#344) both build it here,
// so the two surfaces always show the same string.

export interface AccessRequestCopyFields {
  /** `displayName(user)`, or `null` for a tombstoned requester. */
  requesterName: string | null;
  positionName: string;
  product: string;
  access: string;
  createdAt: Date;
}

export function buildAccessRequestCopyString({
  requesterName,
  positionName,
  product,
  access,
  createdAt,
}: AccessRequestCopyFields): string {
  const who = requesterName ?? "a deleted user";
  return `Access request: ${who} (${positionName}) needs ${access} on ${product}. Submitted ${formatDateTime(createdAt.toISOString())} ET.`;
}
