# Runbook: position lifecycle (create, rename, retire)

Positions are the roles products check, such as `vp-finance` or `aplio-admin`.
Assigning and unassigning a position happens on the user detail page and is not
repeated here.

> Status: the positions pages land with #61. Check labels against the merged UI
> during the dev walkthrough. Keep production definitions in sync with
> [positions-sync.md](positions-sync.md).

## Who is authorized

Any admin.

## Create

1. Open the positions pages and choose to create a position.
2. Enter the name. The key is suggested from it and can be edited before you
   save.
3. Check the key against the rules:
   - Format `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 2 to 64 characters, no capitals.
   - Organization roles use bare keys (`vp-finance`).
   - Product roles use the product slug as a prefix (`aplio-admin`).
4. Save. The key **can never change** after creation.

A key retired in the last 365 days is refused with `KEY_RETIRED`. Pick another
key or wait out the window.

Audit event: `POSITION_CREATED`.

## Rename

You can change the name, category and description. The key stays. Holders and
product permissions are unaffected. Audit event: `POSITION_UPDATED`.

## Retire

1. Open the position and check the **holder count**.
2. Tell the owner of every product whose code checks this key.
3. Choose delete, then type the key to confirm.
4. Holders lose the position on their next session lookup. Tokens issued to
   Supabase-backed products can keep it for up to 10 minutes. If a holder must
   lose access immediately, use **Force re-login** on their user detail page.
5. The key cannot be reused for 365 days.

Audit event: `POSITION_DELETED`.

## Verify afterwards

- [ ] The audit log shows the matching `POSITION_*` event.
- [ ] After a retirement, the position is gone from a former holder's session and
      is listed on the deleted positions tab.
- [ ] Affected product owners have been told.
