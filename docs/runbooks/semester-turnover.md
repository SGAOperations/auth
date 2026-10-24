# Runbook: semester turnover checklist

Run this at the end of every semester, when officers change. Date each item as
you finish it.

## Who is authorized

The Primary Admin, with other admins helping. Start at least 8 days before the
handoff if the PA is leaving.

## Checklist

- [ ] **Unassign outgoing holders' positions.** Do it from each user's detail
      page. Date: **\_\_**
- [ ] **Bulk-import incoming officers** with their positions. See
      [bulk-import.md](bulk-import.md). Date: **\_\_**
- [ ] **Admins.** Revoke admin from departing admins and grant it to incoming
      ones. Incoming admins enroll TOTP. Date: **\_\_**
- [ ] **Primary Admin.** If the PA is graduating, start
      [pa-transfer.md](pa-transfer.md) at least 8 days ahead. Date: **\_\_**
- [ ] **Break-glass holders.** Confirm at least two current holders of the
      production `DIRECT_URL`, and update the table in
      [break-glass.md](break-glass.md). Date: **\_\_**
- [ ] **Shared credentials.** Rotate any credential a departing person held. See
      [rotate-secrets.md](rotate-secrets.md) (lands with #81). Date: **\_\_**
- [ ] **Ownership.** Hand over the shared mailboxes and the Resend, Neon, Vercel
      and Upstash org memberships. Date: **\_\_**
- [ ] **Registry.** Review each product's visible-to-positions list. Date: **\_\_**
- [ ] **Retention.** Review the retention job's admin and PA manual-review list
      (lands with #78). Date: **\_\_**
- [ ] **Audit log.** Skim it for anomalies since last semester. Date: **\_\_**
