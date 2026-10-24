# Runbook: unlock a locked account

Restores sign-in for a user whose account is locked after repeated failed
passwords.

> Status: lockout lands with #76. The Unlock control is part of the admin user
> detail page (#60). Check labels against the merged UI during the dev
> walkthrough.

## How lockout works

- 5 failed password attempts within 15 minutes lock the account for 15 minutes.
- Each later lock doubles the time (30 minutes, 1 hour, 2 hours, and so on) up to
  24 hours. A lock is never permanent, and the level decays after 24 hours clean.
- A browser holding a valid known-device cookie for the account is **exempt** from
  the lock. A user who says they are locked out on their usual browser most likely
  has a wrong password, not a lock. Send them to password reset instead.
- While locked, sign-in shows the same generic error as a wrong password.
- The Primary Admin can be locked too.

## Who is authorized

Any admin. Unlocking on request is a social-engineering path, so follow the
identity check below.

## Procedure

1. **Try self-service first.** The user was emailed an unlock link when the lock
   began. It is single-use and expires after 1 hour. Ask them to use it.
2. If they cannot, **confirm the requester's identity out of band** before you
   unlock: call them, or message them on a channel you already trust. Do not rely
   on the email thread that asked for the unlock.
3. Open the user's detail page in the admin area and press **Unlock**.
4. Tell the user to sign in. If they still cannot, send them to password reset.

If the **Unlock** control is disabled for the Primary Admin, the PA uses the
emailed unlock link.

## Verify afterwards

- [ ] The audit log shows `ACCOUNT_UNLOCKED` for the user (and `ACCOUNT_LOCKED`
      earlier).
- [ ] The user can sign in.
- [ ] If several accounts are locked at once, treat it as an attack and follow
      [incident-response.md](incident-response.md).
