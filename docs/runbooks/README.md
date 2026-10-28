# Runbooks

Step-by-step procedures for operating SGAuth. Every runbook names the audit
events it produces, so you can confirm the result in the audit log.

| Task                               | Use it when                                   | Who may run it                 | Runbook                                                 |
| ---------------------------------- | --------------------------------------------- | ------------------------------ | ------------------------------------------------------- |
| Transfer the Primary Admin         | A planned handoff of the PA role              | The Primary Admin              | [pa-transfer.md](pa-transfer.md)                        |
| Break-glass Primary Admin recovery | The PA cannot sign in and no transfer can run | Two credential holders         | [break-glass.md](break-glass.md)                        |
| Unlock a user                      | A user is locked out of their account         | Any admin                      | [unlock-user.md](unlock-user.md)                        |
| Bulk import users                  | Adding many users with positions from a CSV   | Any admin                      | [bulk-import.md](bulk-import.md)                        |
| Position lifecycle                 | Creating, renaming or retiring a position     | Any admin                      | [positions.md](positions.md)                            |
| Key and secret rotation            | A secret or key is due or exposed             | Admins with env access         | [rotate-secrets.md](rotate-secrets.md) (lands with #81) |
| Incident response                  | A suspected compromise                        | Admins, plus a second operator | [incident-response.md](incident-response.md)            |
| Onboard a product                  | A new product joins SGAuth                    | Any admin                      | [onboard-product.md](onboard-product.md)                |
| Semester turnover                  | Officers change at the end of a semester      | The Primary Admin              | [semester-turnover.md](semester-turnover.md)            |
| Restore the Neon `main` branch     | Production data needs a point-in-time restore | Neon org Admin                 | [neon-restore.md](neon-restore.md)                      |

Other runbooks: [neon-upgrade.md](neon-upgrade.md), [on-call.md](on-call.md),
[positions-sync.md](positions-sync.md), [legacy-bcrypt.md](legacy-bcrypt.md),
[chambers-export.md](chambers-export.md).

## Verification log

A runbook counts as verified only after someone **other than its author** has run
it end to end on `auth-dev.northeasternsga.com` with synthetic users, fixed any
step that did not match reality, and filled in its row here.

| Runbook           | Verified on dev (date) | By  | Corrections PR |
| ----------------- | ---------------------- | --- | -------------- |
| pa-transfer       | not yet verified       |     |                |
| unlock-user       | not yet verified       |     |                |
| bulk-import       | not yet verified       |     |                |
| positions         | not yet verified       |     |                |
| incident-response | not yet verified       |     |                |
| onboard-product   | not yet verified       |     |                |
| semester-turnover | not yet verified       |     |                |
| break-glass       | not yet verified       |     |                |
| rotate-secrets    | not yet verified       |     |                |
