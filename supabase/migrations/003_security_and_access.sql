-- ============================================================================
-- St. Mary's Syro Malabar Catholic Church — Multi-Ward Christmas Carol (W1–W5)
-- Migration 003: Security Tables, Audit Logs, Rate Limits & Strict RLS Lockdown
-- Idempotent: Safe to re-run
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ward_access_codes — bcrypt-hashed parishioner & admin codes (W1–W5 + MASTER)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ward_access_codes (
  ward_id text PRIMARY KEY CHECK (ward_id IN ('W1','W2','W3','W4','W5','MASTER')),
  user_code_hash text,
  user_code_version int NOT NULL DEFAULT 1,
  admin_code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ward_access_codes
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.ward_access_codes IS
  'SENSITIVE: Stores ONLY bcrypt hashes (pgcrypto) of ward parishioner codes and ward/MASTER admin codes. Zero public access.';
COMMENT ON COLUMN public.ward_access_codes.user_code_hash IS 'bcrypt hash of the seasonal ward parishioner code (NULL for MASTER).';
COMMENT ON COLUMN public.ward_access_codes.user_code_version IS 'Incremented on every reset_ward_user_code() call to auto-revoke cached client sessions.';
COMMENT ON COLUMN public.ward_access_codes.admin_code_hash IS 'bcrypt hash of the ward admin code (or church-wide MASTER override code).';

DROP TRIGGER IF EXISTS trg_ward_access_codes_updated_at ON public.ward_access_codes;
CREATE TRIGGER trg_ward_access_codes_updated_at
  BEFORE UPDATE ON public.ward_access_codes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. admin_audit_logs — Immutable trail of privileged admin operations
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id bigserial PRIMARY KEY,
  ward_id text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.admin_audit_logs IS
  'Append-only audit trail recording code resets, admin rotations, season clones, and bulk house imports.';
COMMENT ON COLUMN public.admin_audit_logs.actor_role IS 'Either WARD_ADMIN or MASTER (resolved by _assert_ward_admin).';

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_ward_time
  ON public.admin_audit_logs (ward_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 3. auth_rate_limits — Sliding-window brute-force protection
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
  id bigserial PRIMARY KEY,
  ward_id text NOT NULL,
  attempt_type text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.auth_rate_limits IS
  'Tracks failed USER and ADMIN code attempts per ward (max 12 failures per 15-minute window; auto-pruned after 1 hour).';

CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup
  ON public.auth_rate_limits (ward_id, attempt_type, attempted_at DESC);

-- ----------------------------------------------------------------------------
-- 4. Strict RLS Lockdown — ZERO Public Direct Table Reads or Writes
-- ----------------------------------------------------------------------------
ALTER TABLE public.carol_seasons     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carol_days        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ward_houses       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ward_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ward_songs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ward_access_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_rate_limits  ENABLE ROW LEVEL SECURITY;

-- Drop any legacy permissive policies (e.g. if migrating from standalone carol-w4)
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'carol_seasons','carol_days','ward_houses','ward_settings',
        'ward_songs','ward_access_codes','admin_audit_logs','auth_rate_limits'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- Explicitly revoke all direct table privileges from anon & authenticated roles.
-- All frontend reads/writes MUST flow through SECURITY DEFINER RPCs in 004_rpcs_and_triggers.sql.
REVOKE ALL ON TABLE
  public.carol_seasons,
  public.carol_days,
  public.ward_houses,
  public.ward_settings,
  public.ward_songs,
  public.ward_access_codes,
  public.admin_audit_logs,
  public.auth_rate_limits
FROM anon, authenticated;
