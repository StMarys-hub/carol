-- ============================================================================
-- St. Mary's Syro Malabar Catholic Church — Multi-Ward Christmas Carol (W1–W5)
-- Migration 001: Extensions & Shared Trigger Helpers
-- Target: Dedicated Supabase Project `stmarys-carol` (public schema)
-- Idempotent: Safe to re-run
-- ============================================================================

-- Required for bcrypt password hashing (crypt / gen_salt) and gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Shared trigger function to keep `updated_at` current on every mutable table
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_updated_at() IS
  'Shared BEFORE UPDATE trigger function that stamps updated_at = now() on mutable Carol tables.';

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
