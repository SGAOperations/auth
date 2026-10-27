# Runbook: bulk import users from a CSV

Creates many users at once, with their positions, from one CSV file.

> Status: bulk import lands with #53. Check labels against the merged UI during
> the dev walkthrough.

## Who is authorized

Any admin.

## Before you start

1. Have the list of position keys ready. Every key must already exist (see
   [positions.md](positions.md)).
2. Build the CSV with the header `email,name,positions`. Separate multiple
   position keys with `|`.

   ```csv
   email,name,positions
   ada@northeastern.edu,Ada Lovelace,vp-finance
   grace@northeastern.edu,Grace Hopper,vp-operations|senator
   alan@northeastern.edu,Alan Turing,
   ```

   A row with no positions leaves the last column empty.

## Procedure

1. Open the bulk import page in the admin area and upload the file.
2. Read the preview. It lists new users, existing users and position changes,
   and every invalid row with its error.
3. Choose how invalid rows are handled:
   - **All-or-nothing (default):** nothing is imported until every error is fixed.
   - **Skip invalid:** an explicit toggle that imports the valid rows only.
4. Apply the import.
5. Download the report and keep it with your notes.

## Things to know

- Re-importing the same file is safe. It creates no duplicate users or
  assignments.
- Imported users are password-less accounts. **No email goes out by default.**
  Each user sets a password the first time they enter their email on the login
  page.
- The optional **send set-password emails now** checkbox sends invites in batches
  under the mailer caps. Use it only for small groups.

## Verify afterwards

- [ ] The audit log shows a `BULK_IMPORT` event whose counts match the report.
- [ ] Spot-check two imported users: their positions are right on the user detail
      page.
- [ ] The report is saved.
