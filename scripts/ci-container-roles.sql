-- CI only. Run by ci.yml as the container superuser (`postgres`) against the
-- empty `sgauth_test` database of a postgres:17 service container, before the
-- db test projects start.
--
-- It reproduces the Neon test branch role split that
-- primary-admin-runtime-role.db.test.ts, audit-schema.db.test.ts and the
-- down.sql tests depend on. A container role created by POSTGRES_USER is a
-- superuser, which bypasses every grant those tests check, so the tests connect
-- as these two roles and never as `postgres`:
--
--   migration  owns the database and, through pg_database_owner, the `public`
--              schema and every table migrations create there. TEST_DIRECT_URL.
--   runtime    DML only on those tables, and not a member of the schema owner.
--              TEST_DATABASE_URL.
CREATE ROLE migration LOGIN PASSWORD 'migration' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- On PostgreSQL 15 and later `public` is owned by pg_database_owner, so owning
-- the database makes `migration` the schema owner. `migration` can then run
-- CREATE EXTENSION citext, which is a trusted extension.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO migration', current_database());
END
$$;

-- Tables and sequences that `migration` creates grant the runtime role DML
-- only. No TRUNCATE: the audit and runtime-role tests expect it to be refused.
ALTER DEFAULT PRIVILEGES FOR ROLE migration IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE migration IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO runtime;
