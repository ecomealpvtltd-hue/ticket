-- 001_init.sql — core multi-tenant schema
-- Every tenant-owned table carries tenant_id and is protected by row-level security (RLS).
-- The application runs its queries as the restricted role `support_app` (via SET LOCAL ROLE),
-- which can only see rows where tenant_id matches the transaction's `app.tenant_id` setting,
-- unless the transaction explicitly opts into system mode (`app.system = 'on'`) for
-- cross-tenant lookups such as resolving a widget key or an admin's email at sign-in.

-- ---------------------------------------------------------------------------
-- Restricted application role
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'support_app') THEN
    CREATE ROLE support_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

DO $$
BEGIN
  EXECUTE format('GRANT support_app TO %I', current_user);
EXCEPTION WHEN others THEN
  RAISE NOTICE 'Could not grant support_app to %: %', current_user, SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- Helper: the tenant bound to the current transaction (NULL if none)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.system', true), '') = 'on'
$$;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  ticket_prefix   text NOT NULL CHECK (ticket_prefix ~ '^[A-Z]{2,6}$'),
  ticket_seq      integer NOT NULL DEFAULT 0,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Publishable widget keys (NOT secrets: they identify a tenant, they do not authorize reads)
CREATE TABLE widget_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  public_key       text NOT NULL UNIQUE,
  label            text NOT NULL DEFAULT 'Default',
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  last_seen_at     timestamptz,
  last_seen_origin text
);
CREATE INDEX widget_keys_tenant_idx ON widget_keys (tenant_id);

-- ---------------------------------------------------------------------------
-- Admin users and sessions
-- ---------------------------------------------------------------------------
CREATE TABLE admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL CHECK (email = lower(email)),
  name          text,
  role          text NOT NULL DEFAULT 'agent' CHECK (role IN ('owner', 'admin', 'agent', 'viewer')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (tenant_id, email)
);
CREATE INDEX admins_email_idx ON admins (email);

CREATE TABLE admin_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  admin_id    uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);

-- ---------------------------------------------------------------------------
-- Customers and tickets
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text NOT NULL,          -- E.164, e.g. +919876543210
  email       text,
  org_name    text,                   -- "Restaurant name" for Ecomeal; label is tenant config
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);

CREATE TABLE tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  number        text NOT NULL,        -- public ticket ID, e.g. ECM-000123
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
  name          text NOT NULL,
  phone         text NOT NULL,
  email         text,
  org_name      text NOT NULL,
  category      text,
  description   text NOT NULL,
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority      text NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  source        text NOT NULL DEFAULT 'widget',
  duplicate_of  uuid REFERENCES tickets(id) ON DELETE SET NULL,
  ai_status     text NOT NULL DEFAULT 'disabled'
                CHECK (ai_status IN ('disabled', 'pending', 'done', 'failed')),
  ai_category   text,
  ai_priority   text CHECK (ai_priority IS NULL OR ai_priority IN ('low', 'medium', 'high', 'urgent')),
  ai_summary    text,
  ai_reason     text,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  closed_at     timestamptz,
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, seq)
);
CREATE INDEX tickets_tenant_created_idx ON tickets (tenant_id, created_at DESC);
CREATE INDEX tickets_tenant_status_idx  ON tickets (tenant_id, status);
CREATE INDEX tickets_customer_idx       ON tickets (tenant_id, customer_id, created_at DESC);

-- Attachments: bytes live in blob storage; the database holds metadata.
-- ticket_id is NULL between upload and ticket submission (files upload as soon as they are picked).
CREATE TABLE attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id      uuid REFERENCES tickets(id) ON DELETE CASCADE,
  file_name      text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     integer NOT NULL CHECK (size_bytes > 0),
  sha256         text NOT NULL,
  blob_key       text NOT NULL UNIQUE,
  drive_file_id  text,
  drive_url      text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_ticket_idx ON attachments (ticket_id);
CREATE INDEX attachments_orphan_idx ON attachments (created_at) WHERE ticket_id IS NULL;

-- Audit trail / timeline
CREATE TABLE ticket_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id    uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_type   text NOT NULL CHECK (actor_type IN ('customer', 'admin', 'system', 'ai')),
  actor_id     uuid,
  actor_label  text,
  type         text NOT NULL,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- clock_timestamp(), not now(): several events written in one transaction keep their order
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ticket_events_ticket_idx ON ticket_events (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- Integrations and the outbox (async jobs)
-- ---------------------------------------------------------------------------
CREATE TABLE integrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider              text NOT NULL CHECK (provider IN ('google')),
  status                text NOT NULL DEFAULT 'connected'
                        CHECK (status IN ('connected', 'error', 'disconnected')),
  account_email         text,
  encrypted_credentials text,
  settings              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error            text,
  connected_by          uuid REFERENCES admins(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE integration_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id     uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('drive_upload', 'sheet_sync', 'ai_triage')),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'done', 'failed', 'blocked')),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 8,
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX integration_jobs_due_idx ON integration_jobs (run_after) WHERE status IN ('pending', 'running');
CREATE INDEX integration_jobs_ticket_idx ON integration_jobs (ticket_id);
-- At most one queued job per ticket and kind (re-enqueueing is idempotent)
CREATE UNIQUE INDEX integration_jobs_one_queued
  ON integration_jobs (ticket_id, kind) WHERE status IN ('pending', 'blocked');

-- Fixed-window rate-limit counters (not tenant data; system-only)
CREATE TABLE rate_limits (
  bucket        text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = app_tenant_id() OR app_is_system())
  WITH CHECK (id = app_tenant_id() OR app_is_system());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['widget_keys','admins','admin_sessions','customers','tickets',
                           'attachments','ticket_events','integrations','integration_jobs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = app_tenant_id() OR app_is_system())
                      WITH CHECK (tenant_id = app_tenant_id() OR app_is_system())$p$, t);
  END LOOP;
END $$;

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON rate_limits USING (app_is_system()) WITH CHECK (app_is_system());

-- ---------------------------------------------------------------------------
-- Privileges for the restricted role
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO support_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO support_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO support_app;
GRANT EXECUTE ON FUNCTION app_tenant_id(), app_is_system() TO support_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO support_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO support_app;
