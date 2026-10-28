# Chambers user export

The format of the file that carries Chambers' users into SGAuth, how to produce
it, and how to check it before the import (#99). The file holds password hashes
and email addresses: treat it as a secret from the moment it exists.

- **Primary source:** Chambers' Neon database, which has held the live data
  since the Better Auth cutover (chambers#136).
- **Fallback source:** the Supabase `auth.users` table. Use it only if the Neon
  export is unavailable, and only while the Supabase project still exists. It
  misses users created, and passwords changed, after chambers#136.

This runbook produces no audit events: it writes nothing to SGAuth. Run the
queries read-only, outside this repository.

## Format

One JSON object. Keys are snake_case and follow the Neon column names. The
schema is strict: an unknown key is an error, so extra PII cannot slip in. The
schema lives in `src/lib/import/chambers-export.ts`; `npm run validate-export --
--print-schema` prints it as JSON Schema. A valid example is
[chambers-export.sample.json](chambers-export.sample.json).

Envelope:

| Field         | Type                                                   |
| ------------- | ------------------------------------------------------ |
| `format`      | the literal `"sgauth-chambers-export"`                 |
| `version`     | the literal `1`                                        |
| `source`      | `"chambers-neon"` (primary) or `"supabase"` (fallback) |
| `exported_at` | ISO datetime with offset                               |
| `users`       | array of users                                         |

Each user:

| Field                | Type                                       | Neon origin                                            | Supabase origin                  |
| -------------------- | ------------------------------------------ | ------------------------------------------------------ | -------------------------------- |
| `id`                 | uuid                                       | `users.id`                                             | `auth.users.id` (same id)        |
| `email`              | email                                      | `users.email`                                          | `auth.users.email`               |
| `full_name`          | non-empty string                           | `users.full_name`                                      | `public.users.full_name`         |
| `password_hash`      | bcrypt `$2a$`/`$2b$` (60 chars), or `null` | `auth_accounts.password`, `provider_id = 'credential'` | `auth.users.encrypted_password`  |
| `email_verified`     | boolean                                    | `users.email_verified`                                 | `email_confirmed_at is not null` |
| `email_confirmed_at` | ISO datetime or `null`                     | always `null`                                          | `auth.users.email_confirmed_at`  |
| `last_sign_in_at`    | ISO datetime or `null`                     | always `null`                                          | `auth.users.last_sign_in_at`     |
| `banned_until`       | ISO datetime, `"infinity"`, or `null`      | always `null` (`is_active` covers it)                  | `auth.users.banned_until`        |
| `is_active`          | boolean                                    | `users.is_active` (`null` exported as `true`)          | `public.users.is_active` (same)  |
| `admin_role`         | string or `null`, see below                | `users.admin_role`                                     | `public.users.admin_role`        |
| `iems_role`          | non-empty string or `null`                 | `users.iems_role`                                      | `public.users.iems_role`         |
| `created_at`         | ISO datetime with offset                   | `users.created_at`                                     | `auth.users.created_at`          |
| `board_memberships`  | array of `{ body_id, body_name, role }`    | `board_memberships` joined to `bodies`                 | same                             |

- `password_hash: null` means the user has no credential and imports
  password-less. `$2y$`, scrypt and truncated values are rejected.
- `role` in a membership is `"Leadership"` or `"Member"`. `body_id` is the stable
  identifier #99 uses for its `board:<id>` mapping key.
- Datetimes accept the `+00:00` offset and microseconds that Postgres writes.
- `admin_role` must be one a source's `users_admin_role_check` allows:
  - `chambers-neon`: Executive Vice President, Vice President of Operational
    Affairs, Comptroller, Digital Innovation Manager, Information Manager,
    Student Body President.
  - `supabase`: the same, without Student Body President, and with Digital
    Innovation Project Member.
  - If Chambers changes the list again, update `NEON_ADMIN_ROLES` in the same PR.

Rules across rows. A violation is an error: `id` is unique; the lower-cased,
trimmed `email` is unique; `body_id` is unique within a user's memberships; one
`body_id` has one `body_name`; any `--expect-*` count matches. Warnings do not
fail the file: an email that is not lower-case and trimmed, users with no hash,
emails outside `@northeastern.edu`, and a `supabase` source.

## Export from Neon (primary)

Run this read-only against Chambers' Neon database, in the Neon SQL editor or
`psql`. It returns the whole file as one JSON value. If a column name differs
from the one used here, fix the query, not the format.

```sql
select json_build_object(
  'format', 'sgauth-chambers-export',
  'version', 1,
  'source', 'chambers-neon',
  'exported_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'),
  'users', coalesce(json_agg(u order by u.created_at, u.id), '[]'::json)
) as export
from (
  select
    usr.id,
    usr.email,
    usr.full_name,
    acc.password as password_hash,
    usr.email_verified,
    null::text as email_confirmed_at,
    null::text as last_sign_in_at,
    null::text as banned_until,
    coalesce(usr.is_active, true) as is_active,
    usr.admin_role,
    usr.iems_role,
    usr.created_at,
    coalesce((
      select json_agg(json_build_object(
        'body_id', bm.body_id,
        'body_name', b.name,
        'role', bm.role
      ) order by b.name)
      from board_memberships bm
      join bodies b on b.id = bm.body_id
      where bm.user_id = usr.id
    ), '[]'::json) as board_memberships
  from public.users usr
  left join auth_accounts acc
    on acc.user_id = usr.id and acc.provider_id = 'credential'
) u;
```

`board_memberships` is inner-joined to `bodies` because `user_id` and `body_id`
are nullable in Chambers: orphan rows drop out. The left join keeps users with no
credential.

Count queries, run at the source. The numbers are what you pass to the
validator:

```sql
select count(*) as users from public.users;
select count(*) as hashes
  from public.users usr
  join auth_accounts acc on acc.user_id = usr.id and acc.provider_id = 'credential'
  where acc.password is not null;
select count(*) as memberships
  from board_memberships bm
  join bodies b on b.id = bm.body_id
  join public.users usr on usr.id = bm.user_id;
```

## Export from Supabase (fallback only)

Use only if the Neon export is unavailable, and only before the Supabase project
is deleted. This is a manual query run outside this repository; SGAuth has no
Supabase code, dependency or env var.

```sql
select json_build_object(
  'format', 'sgauth-chambers-export',
  'version', 1,
  'source', 'supabase',
  'exported_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'),
  'users', coalesce(json_agg(u order by u.created_at, u.id), '[]'::json)
) as export
from (
  select
    au.id,
    au.email,
    pu.full_name,
    au.encrypted_password as password_hash,
    (au.email_confirmed_at is not null) as email_verified,
    au.email_confirmed_at,
    au.last_sign_in_at,
    case
      when au.banned_until is null then null
      when au.banned_until = 'infinity' then 'infinity'
      else to_char(au.banned_until at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')
    end as banned_until,
    coalesce(pu.is_active, true) as is_active,
    pu.admin_role,
    pu.iems_role,
    au.created_at,
    coalesce((
      select json_agg(json_build_object(
        'body_id', bm.body_id,
        'body_name', b.name,
        'role', bm.role
      ) order by b.name)
      from public.board_memberships bm
      join public.bodies b on b.id = bm.body_id
      where bm.user_id = au.id
    ), '[]'::json) as board_memberships
  from auth.users au
  join public.users pu on pu.id = au.id
) u;
```

The count queries are the same as above, run against `auth.users` joined to
`public.users`.

## Validate

Save the query result as a file whose name starts with `chambers-export` (for
example `chambers-export-2026-11-02.json`). The repository ignores that pattern,
so the file cannot be committed. Then:

```bash
npm run validate-export -- chambers-export-2026-11-02.json \
  --expect-users <N> --expect-memberships <N> --expect-hashes <N>
```

It prints the source, the SHA-256 of the file's bytes, user, hash, admin-role
and membership counts, then warnings and errors, and ends with `VALID` or
`INVALID`. It never prints a password hash, and its errors name the rule and row
index, not the value. Exit codes: `0` valid, `1` invalid (including a count
mismatch), `2` a usage error, a missing file, or JSON that does not parse.

The validated file is ready for #99 when it exits `0` with the `--expect-*`
numbers taken from the source.

## Handling

- Store the file and its SHA-256 in the team secrets vault.
- Never put the file in the repository, an issue, a pull request or a chat.
- Delete every local copy after validating.
- Delete the vault copy after #99's production run.
