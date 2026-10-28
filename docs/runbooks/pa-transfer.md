# Runbook: transfer the Primary Admin

Hands the Primary Admin (PA) role from the current PA to another admin through
the guarded transfer flow. Use it for a planned handoff, such as a graduating PA.
If the PA cannot sign in at all, use [break-glass.md](break-glass.md) instead;
this runbook does not cover that case.

> Status: the transfer flow lands with #49 and its pages with #64. Button labels
> below follow the design and must be checked against the merged UI during the
> dev walkthrough (see the verification log in [README.md](README.md)).

## Who is authorized

- **Outgoing PA:** starts the transfer and may cancel it.
- **Recipient:** an active admin with TOTP enrolled. Accepts or declines.
- Nobody else can act on a transfer. Only one transfer can be in flight.

## Before you start

1. Confirm the recipient is an active admin and has TOTP enrolled. A recipient
   without TOTP is not selectable.
2. Start at least **8 days** before the handoff date. The recipient has up to 7
   days to accept, and the cooling window adds 24 hours.
3. Agree the handoff date with the recipient out of band.

## Procedure

1. Outgoing PA: open the admin dashboard and start the Primary Admin transfer.
   <!-- screenshot: pa-transfer-01-initiate.png -->
2. Read the consequences screen, then choose the recipient.
3. Re-authenticate when asked, then type the recipient's email address exactly.
   <!-- screenshot: pa-transfer-02-confirm.png -->
4. Submit. The transfer is now pending acceptance. The recipient gets an accept
   link by email and you get a confirmation. Audit event:
   `PA_TRANSFER_INITIATED`.
5. Recipient: follow the email link. It opens a page and does nothing by itself.
   Sign in, re-authenticate, then confirm acceptance.
   <!-- screenshot: pa-transfer-03-accept.png -->
6. The transfer enters a **24-hour cooling window**. The outgoing PA receives a
   cancel link by email, and the same cancel control is shown in the app. Audit
   event: `PA_TRANSFER_ACCEPTED`.
   <!-- screenshot: pa-transfer-04-cooling.png -->
7. When the window ends, the scheduler executes the transfer. It runs hourly, so
   execution can lag the window by up to an hour. Until it runs, the outgoing PA
   keeps the role and can still cancel. Audit event: `PA_TRANSFER_COMPLETED`.
8. Both users are signed out everywhere and must sign in again. Every admin gets
   an email.

## Cancelling or ending early

- **Outgoing PA, in the app:** cancel from the status card, with re-auth.
- **Outgoing PA, from the email:** open the cancel link and press the Cancel
  button. No sign-in is needed and the link works once.
- **Recipient:** decline from the acceptance page.
- **Expiry:** a transfer nobody accepts within 7 days expires. Audit event:
  `PA_TRANSFER_EXPIRED`.
- **Automatic cancel:** if the recipient loses admin or is deactivated before
  execution, the transfer is cancelled and the PA is notified.

Every cancellation writes `PA_TRANSFER_CANCELLED`.

## Verify afterwards

- [ ] Exactly one user is the Primary Admin, and it is the recipient.
- [ ] Both users are still admins.
- [ ] Both users had to sign in again.
- [ ] The audit log shows `PA_TRANSFER_INITIATED`, `PA_TRANSFER_ACCEPTED` and
      `PA_TRANSFER_COMPLETED` for the same transfer.
- [ ] The new PA can open the PA-only pages.

## If something goes wrong

- **The transfer did not execute after the window.** Check that the scheduled
  job ran (`/api/jobs/pa-transfer`, hourly) and that the recipient is
  still an active admin. An ineligible recipient cancels the transfer.
- **The old PA lost access mid-handoff.** Use [break-glass.md](break-glass.md).
