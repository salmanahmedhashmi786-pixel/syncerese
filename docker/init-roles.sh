#!/bin/bash
# ---------------------------------------------------------------------------
# Syncrese — database roles.
#
# Runs once, on an empty data directory, before anything else touches the
# database. The Postgres image executes files in this directory as the
# superuser; this is the only point at which that is true, and it is why role
# creation lives here rather than in a migration.
#
# THREE roles, and the separation is the whole point:
#
#   postgres         the superuser. Nothing in the application ever uses it.
#   syncrese_owner   owns the schema. Used ONLY by the migration job.
#   syncrese_app     what the application connects as. No BYPASSRLS, owns
#                    nothing, cannot alter a policy.
#
# Collapsing these into one role is the single most consequential shortcut
# available here: it silently disables tenant isolation, and every test would
# still pass because the tests connect correctly.
#
# The equivalent for a managed provider (Neon, Supabase, RDS) is
# scripts/provision-db.sql — same roles, run by hand.
# ---------------------------------------------------------------------------
set -euo pipefail

: "${SYNCRESE_OWNER_PASSWORD:?SYNCRESE_OWNER_PASSWORD must be set}"
: "${SYNCRESE_APP_PASSWORD:?SYNCRESE_APP_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE syncrese_owner LOGIN PASSWORD '${SYNCRESE_OWNER_PASSWORD}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

  -- Created here with LOGIN so the application can authenticate. Migration
  -- 0001 also creates it (NOLOGIN) for installations where the DBA made the
  -- role first; CREATE ROLE there is guarded by IF NOT EXISTS, so this wins.
  CREATE ROLE syncrese_app LOGIN PASSWORD '${SYNCRESE_APP_PASSWORD}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

  -- Owns the SECURITY DEFINER functions. NOLOGIN: nothing connects as it.
  -- Without it every pre-tenant lookup (sign-in, API keys, invitations,
  -- webhooks) reads nothing, because a definer function runs as its owner and
  -- FORCE ROW LEVEL SECURITY subjects the table owner to the policies.
  CREATE ROLE syncrese_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  -- The owner needs membership to hand the functions over in migration 0019.
  GRANT syncrese_definer TO syncrese_owner;

  -- The owner owns the schema, so migrations can create tables in it.
  ALTER SCHEMA public OWNER TO syncrese_owner;

  -- Postgres 15+ already revokes this, but older data directories and restored
  -- dumps do not. Without it the app role could create a table that shadows one
  -- a SECURITY DEFINER function trusts.
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  REVOKE ALL ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO syncrese_app, syncrese_owner;
EOSQL

echo "syncrese: roles created (owner: syncrese_owner, application: syncrese_app)"
