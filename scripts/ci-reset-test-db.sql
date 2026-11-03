-- Empties a CI test database for the db test projects (ci.yml). Run as the
-- branch's `migration` role through TEST_DIRECT_URL, then `prisma migrate
-- deploy` (src/test/global-setup.ts) rebuilds the schema.
--
-- CI used to reset the Neon branch from its parent with NEON_API_KEY. That key
-- can reveal or reset every branch's role passwords, main's included, and on
-- pull_request the PR's own copy of ci.yml runs, so the key had to sit behind
-- an approval on every PR. This needs only the test branch's own credentials.
--
-- It drops what the current role owns in `public`: tables (with their
-- indexes, triggers and constraints), views, sequences, routines and types.
-- Dropping a table skips row triggers, so `protect_primary_admin` and the
-- append-only audit trigger cannot block it. Objects that belong to an
-- extension (citext) are kept, and so are the role's default privileges, so
-- the recreated tables grant the runtime role as before.
DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT c.oid::regclass AS name,
           CASE c.relkind
             WHEN 'v' THEN 'VIEW'
             WHEN 'm' THEN 'MATERIALIZED VIEW'
             WHEN 'S' THEN 'SEQUENCE'
             ELSE 'TABLE'
           END AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND c.relowner = current_user::regrole
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
    ORDER BY c.relkind = 'S'
  LOOP
    EXECUTE format('DROP %s IF EXISTS %s CASCADE', obj.kind, obj.name);
  END LOOP;

  FOR obj IN
    SELECT p.oid::regprocedure AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proowner = current_user::regrole
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('DROP ROUTINE IF EXISTS %s CASCADE', obj.name);
  END LOOP;

  FOR obj IN
    SELECT t.oid::regtype AS name
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typowner = current_user::regrole
      AND t.typtype IN ('e', 'd', 'c')
      AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid)
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS %s CASCADE', obj.name);
  END LOOP;
END
$$;
