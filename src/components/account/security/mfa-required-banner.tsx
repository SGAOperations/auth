import { MFA_ERROR_CODES } from "@/lib/auth/mfa-policy";

export function MfaRequiredBanner() {
  return (
    <div
      role="note"
      className="rounded-lg border border-amber-400 bg-amber-100 px-4 py-3 text-sm text-amber-950"
    >
      {MFA_ERROR_CODES.MFA_REQUIRED.message} Set it up below to get back into
      admin tools.
    </div>
  );
}
