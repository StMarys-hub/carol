-- ============================================================================
-- St. Mary's Syro Malabar Catholic Church — Multi-Ward Christmas Carol (W1–W5)
-- Migration 001: Multi-Tenant Schema, Strict RLS Lockdown & Gatekeeper RPCs
-- Idempotent: Safe to re-run
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Core Tables
CREATE TABLE IF NOT EXISTS public.carol_seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_id text NOT NULL DEFAULT 'W4' CHECK (ward_id IN ('W1','W2','W3','W4','W5')),
  year int NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ward_id, year)
);

CREATE TABLE IF NOT EXISTS public.carol_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_id text NOT NULL DEFAULT 'W4' CHECK (ward_id IN ('W1','W2','W3','W4','W5')),
  season_id uuid NOT NULL REFERENCES public.carol_seasons(id) ON DELETE CASCADE,
  day_number int NOT NULL DEFAULT 1,
  label text NOT NULL,
  carol_date date,
  start_time text NOT NULL DEFAULT '14:00',
  avg_visit_mins int NOT NULL DEFAULT 20,
  drive_buffer_mins int NOT NULL DEFAULT 5,
  current_stop_index int NOT NULL DEFAULT 0,
  last_actual_timestamp timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, day_number)
);

CREATE TABLE IF NOT EXISTS public.ward_houses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_id text NOT NULL DEFAULT 'W4' CHECK (ward_id IN ('W1','W2','W3','W4','W5')),
  season_id uuid NOT NULL REFERENCES public.carol_seasons(id) ON DELETE CASCADE,
  carol_day_id uuid NOT NULL REFERENCES public.carol_days(id) ON DELETE CASCADE,
  family_name text NOT NULL,
  address text NOT NULL,
  lat double precision,
  lng double precision,
  phone text DEFAULT '',
  notes text DEFAULT '',
  stop_role text CHECK (stop_role IN ('START','END') OR stop_role IS NULL),
  stop_order int NOT NULL DEFAULT 0,
  drive_mins int NOT NULL DEFAULT 5,
  distance_label text DEFAULT '',
  visit_mins int NOT NULL DEFAULT 20,
  visited boolean NOT NULL DEFAULT false,
  checked_in_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ward_settings (
  ward_id text PRIMARY KEY CHECK (ward_id IN ('W1','W2','W3','W4','W5')),
  active_year int NOT NULL DEFAULT 2026,
  default_visit_mins int NOT NULL DEFAULT 20,
  drive_buffer_mins int NOT NULL DEFAULT 5,
  meeting_point text DEFAULT '',
  instructions_banner text DEFAULT '',
  coordinator_name text DEFAULT '',
  coordinator_phone text DEFAULT '',
  whatsapp_group_name text DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ward_songs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_id text NOT NULL DEFAULT 'W4' CHECK (ward_id IN ('W1','W2','W3','W4','W5')),
  title text NOT NULL,
  lang text NOT NULL DEFAULT 'Malayalam',
  lyrics text NOT NULL,
  karaoke_audio_url text DEFAULT '',
  source_url text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Private Access Codes Table (Zero public policies)
CREATE TABLE IF NOT EXISTS public.ward_access_codes (
  ward_id text PRIMARY KEY CHECK (ward_id IN ('W1','W2','W3','W4','W5','MASTER')),
  user_code_hash text,
  user_code_version int NOT NULL DEFAULT 1,
  admin_code_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id bigserial PRIMARY KEY,
  ward_id text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
  id bigserial PRIMARY KEY,
  ward_id text NOT NULL,
  attempt_type text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for fast per-ward queries
CREATE INDEX IF NOT EXISTS idx_carol_days_ward_season ON public.carol_days (ward_id, season_id, day_number);
CREATE INDEX IF NOT EXISTS idx_ward_houses_day_order ON public.ward_houses (ward_id, carol_day_id, stop_order);
CREATE INDEX IF NOT EXISTS idx_ward_songs_ward ON public.ward_songs (ward_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup ON public.auth_rate_limits (ward_id, attempt_type, attempted_at DESC);

-- 2. Strict RLS Lockdown — ZERO Public Direct Table Reads/Writes
ALTER TABLE public.carol_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carol_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ward_houses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ward_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ward_songs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ward_access_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;

-- Drop any legacy permissive policies if migrating from carol-w4
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

-- 3. Internal Security Helpers (Not granted to anon/authenticated)
CREATE OR REPLACE FUNCTION public._check_rate_limit(p_ward_id text, p_attempt_type text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM public.auth_rate_limits WHERE attempted_at < now() - interval '1 hour';
  SELECT count(*) INTO v_count
  FROM public.auth_rate_limits
  WHERE ward_id = p_ward_id
    AND attempt_type = p_attempt_type
    AND attempted_at > now() - interval '15 minutes';
  RETURN v_count < 12;
END;
$$;

CREATE OR REPLACE FUNCTION public._log_failed_attempt(p_ward_id text, p_attempt_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  INSERT INTO public.auth_rate_limits (ward_id, attempt_type) VALUES (p_ward_id, p_attempt_type);
END;
$$;

CREATE OR REPLACE FUNCTION public._assert_ward_admin(p_ward_id text, p_admin_code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_ward text := upper(trim(coalesce(p_ward_id, '')));
  v_code text := trim(coalesce(p_admin_code, ''));
  v_ward_hash text;
  v_master_hash text;
BEGIN
  IF v_ward NOT IN ('W1','W2','W3','W4','W5') THEN
    RAISE EXCEPTION 'INVALID_WARD';
  END IF;
  IF NOT public._check_rate_limit(v_ward, 'ADMIN') THEN
    RAISE EXCEPTION 'RATE_LIMITED';
  END IF;

  SELECT admin_code_hash INTO v_ward_hash FROM public.ward_access_codes WHERE ward_id = v_ward;
  SELECT admin_code_hash INTO v_master_hash FROM public.ward_access_codes WHERE ward_id = 'MASTER';

  IF v_ward_hash IS NOT NULL AND crypt(v_code, v_ward_hash) = v_ward_hash THEN
    RETURN 'WARD_ADMIN';
  END IF;
  IF v_master_hash IS NOT NULL AND crypt(v_code, v_master_hash) = v_master_hash THEN
    RETURN 'MASTER';
  END IF;

  PERFORM public._log_failed_attempt(v_ward, 'ADMIN');
  RAISE EXCEPTION 'INVALID_ADMIN_CODE';
END;
$$;

REVOKE ALL ON FUNCTION public._check_rate_limit(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._log_failed_attempt(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._assert_ward_admin(text, text) FROM PUBLIC;

-- 4. Public Gatekeeper RPC: Parishioner Read Access
CREATE OR REPLACE FUNCTION public.get_ward_carol_data(p_ward_id text, p_user_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_ward text := upper(trim(coalesce(p_ward_id, '')));
  v_code text := trim(coalesce(p_user_code, ''));
  v_rec record;
  v_season record;
BEGIN
  IF v_ward NOT IN ('W1','W2','W3','W4','W5') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_WARD');
  END IF;

  IF NOT public._check_rate_limit(v_ward, 'USER') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
  END IF;

  SELECT user_code_hash, user_code_version INTO v_rec
  FROM public.ward_access_codes
  WHERE ward_id = v_ward;

  IF v_rec.user_code_hash IS NULL OR crypt(v_code, v_rec.user_code_hash) <> v_rec.user_code_hash THEN
    PERFORM public._log_failed_attempt(v_ward, 'USER');
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_WARD_CODE');
  END IF;

  SELECT * INTO v_season
  FROM public.carol_seasons
  WHERE ward_id = v_ward
  ORDER BY is_active DESC, year DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'ok', true,
    'ward_id', v_ward,
    'user_code_version', v_rec.user_code_version,
    'active_season', to_jsonb(v_season),
    'seasons', coalesce((
      SELECT jsonb_agg(to_jsonb(s) ORDER BY s.year DESC)
      FROM public.carol_seasons s
      WHERE s.ward_id = v_ward
    ), '[]'::jsonb),
    'carol_days', coalesce((
      SELECT jsonb_agg(to_jsonb(d) ORDER BY d.day_number ASC)
      FROM public.carol_days d
      WHERE d.ward_id = v_ward AND d.season_id = v_season.id
    ), '[]'::jsonb),
    'ward_houses', coalesce((
      SELECT jsonb_agg(to_jsonb(h) ORDER BY h.stop_order ASC)
      FROM public.ward_houses h
      WHERE h.ward_id = v_ward AND h.season_id = v_season.id
    ), '[]'::jsonb),
    'ward_settings', (
      SELECT to_jsonb(ws) FROM public.ward_settings ws WHERE ws.ward_id = v_ward
    ),
    'ward_songs', coalesce((
      SELECT jsonb_agg(to_jsonb(sg) ORDER BY sg.created_at ASC)
      FROM public.ward_songs sg
      WHERE sg.ward_id = v_ward
    ), '[]'::jsonb)
  );
END;
$$;

-- 5. Admin Verification & Security RPCs
CREATE OR REPLACE FUNCTION public.verify_ward_admin_code(p_ward_id text, p_admin_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := public._assert_ward_admin(p_ward_id, p_admin_code);
  RETURN jsonb_build_object(
    'ok', true,
    'role', v_role,
    'scoped_ward_id', upper(trim(p_ward_id))
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_ward_user_code(p_ward_id text, p_admin_code text, p_new_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
  v_new_ver int;
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);
  IF length(trim(coalesce(p_new_code, ''))) < 4 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CODE_TOO_SHORT');
  END IF;

  UPDATE public.ward_access_codes
  SET user_code_hash = crypt(trim(p_new_code), gen_salt('bf')),
      user_code_version = user_code_version + 1,
      updated_at = now()
  WHERE ward_id = v_ward
  RETURNING user_code_version INTO v_new_ver;

  INSERT INTO public.admin_audit_logs (ward_id, actor_role, action, details)
  VALUES (v_ward, v_role, 'RESET_USER_CODE', jsonb_build_object('new_version', v_new_ver));

  RETURN jsonb_build_object('ok', true, 'user_code_version', v_new_ver);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.rotate_ward_admin_code(p_ward_id text, p_admin_code text, p_new_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);
  IF length(trim(coalesce(p_new_code, ''))) < 6 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ADMIN_CODE_MIN_6_CHARS');
  END IF;

  UPDATE public.ward_access_codes
  SET admin_code_hash = crypt(trim(p_new_code), gen_salt('bf')),
      updated_at = now()
  WHERE ward_id = v_ward;

  INSERT INTO public.admin_audit_logs (ward_id, actor_role, action, details)
  VALUES (v_ward, v_role, 'ROTATE_ADMIN_CODE', '{}'::jsonb);

  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- 6. Admin Write RPCs (Strictly Scoped to p_ward_id)
CREATE OR REPLACE FUNCTION public.admin_upsert_season(
  p_ward_id text,
  p_admin_code text,
  p_year int,
  p_name text,
  p_activate boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
  v_season_id uuid;
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);

  IF p_activate THEN
    UPDATE public.carol_seasons SET is_active = false WHERE ward_id = v_ward;
  END IF;

  INSERT INTO public.carol_seasons (ward_id, year, name, is_active)
  VALUES (v_ward, p_year, coalesce(nullif(trim(p_name), ''), 'Christmas Carol ' || p_year), p_activate)
  ON CONFLICT (ward_id, year) DO UPDATE
    SET name = EXCLUDED.name,
        is_active = CASE WHEN p_activate THEN true ELSE public.carol_seasons.is_active END
  RETURNING id INTO v_season_id;

  IF p_activate THEN
    UPDATE public.ward_settings SET active_year = p_year, updated_at = now() WHERE ward_id = v_ward;
  END IF;

  INSERT INTO public.admin_audit_logs (ward_id, actor_role, action, details)
  VALUES (v_ward, v_role, 'UPSERT_SEASON', jsonb_build_object('year', p_year, 'activate', p_activate));

  RETURN jsonb_build_object('ok', true, 'season_id', v_season_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_clone_previous_season(
  p_ward_id text,
  p_admin_code text,
  p_from_year int,
  p_to_year int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
  v_from_id uuid;
  v_to_id uuid;
  v_day record;
  v_new_day_id uuid;
  v_copied int := 0;
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);

  SELECT id INTO v_from_id FROM public.carol_seasons WHERE ward_id = v_ward AND year = p_from_year;
  IF v_from_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SOURCE_SEASON_NOT_FOUND');
  END IF;

  UPDATE public.carol_seasons SET is_active = false WHERE ward_id = v_ward;

  INSERT INTO public.carol_seasons (ward_id, year, name, is_active)
  VALUES (v_ward, p_to_year, 'Christmas Carol ' || p_to_year, true)
  ON CONFLICT (ward_id, year) DO UPDATE SET is_active = true
  RETURNING id INTO v_to_id;

  FOR v_day IN
    SELECT * FROM public.carol_days WHERE ward_id = v_ward AND season_id = v_from_id ORDER BY day_number
  LOOP
    INSERT INTO public.carol_days (ward_id, season_id, day_number, label, carol_date, start_time, avg_visit_mins, drive_buffer_mins)
    VALUES (
      v_ward, v_to_id, v_day.day_number, v_day.label,
      CASE WHEN v_day.carol_date IS NOT NULL THEN (v_day.carol_date + ((p_to_year - p_from_year) || ' years')::interval)::date ELSE NULL END,
      v_day.start_time, v_day.avg_visit_mins, v_day.drive_buffer_mins
    )
    ON CONFLICT (season_id, day_number) DO UPDATE SET label = EXCLUDED.label
    RETURNING id INTO v_new_day_id;

    INSERT INTO public.ward_houses (
      ward_id, season_id, carol_day_id, family_name, address, lat, lng,
      phone, notes, stop_role, stop_order, drive_mins, distance_label, visit_mins, visited
    )
    SELECT
      v_ward, v_to_id, v_new_day_id, family_name, address, lat, lng,
      phone, notes, stop_role, stop_order, drive_mins, distance_label, visit_mins, false
    FROM public.ward_houses
    WHERE ward_id = v_ward AND carol_day_id = v_day.id
    ORDER BY stop_order;

    v_copied := v_copied + (SELECT count(*) FROM public.ward_houses WHERE carol_day_id = v_day.id);
  END LOOP;

  UPDATE public.ward_settings SET active_year = p_to_year, updated_at = now() WHERE ward_id = v_ward;

  INSERT INTO public.admin_audit_logs (ward_id, actor_role, action, details)
  VALUES (v_ward, v_role, 'CLONE_SEASON', jsonb_build_object('from', p_from_year, 'to', p_to_year, 'houses', v_copied));

  RETURN jsonb_build_object('ok', true, 'season_id', v_to_id, 'copied_houses', v_copied);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_upsert_carol_day(
  p_ward_id text,
  p_admin_code text,
  p_season_id uuid,
  p_day_id uuid,
  p_day_number int,
  p_label text,
  p_carol_date date,
  p_start_time text,
  p_avg_visit_mins int,
  p_drive_buffer_mins int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
  v_id uuid;
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);

  IF p_day_id IS NOT NULL THEN
    UPDATE public.carol_days
    SET label = p_label,
        carol_date = p_carol_date,
        start_time = coalesce(p_start_time, '14:00'),
        avg_visit_mins = greatest(5, coalesce(p_avg_visit_mins, 20)),
        drive_buffer_mins = greatest(0, coalesce(p_drive_buffer_mins, 5))
    WHERE id = p_day_id AND ward_id = v_ward
    RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.carol_days (ward_id, season_id, day_number, label, carol_date, start_time, avg_visit_mins, drive_buffer_mins)
    VALUES (
      v_ward, p_season_id, p_day_number, p_label, p_carol_date,
      coalesce(p_start_time, '14:00'),
      greatest(5, coalesce(p_avg_visit_mins, 20)),
      greatest(0, coalesce(p_drive_buffer_mins, 5))
    )
    ON CONFLICT (season_id, day_number) DO UPDATE
      SET label = EXCLUDED.label,
          carol_date = EXCLUDED.carol_date,
          start_time = EXCLUDED.start_time,
          avg_visit_mins = EXCLUDED.avg_visit_mins,
          drive_buffer_mins = EXCLUDED.drive_buffer_mins
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'day_id', v_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_bulk_save_houses(
  p_ward_id text,
  p_admin_code text,
  p_season_id uuid,
  p_carol_day_id uuid,
  p_houses jsonb,
  p_replace_day boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
  v_item jsonb;
  v_base_order int := 0;
  v_idx int := 0;
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);

  IF p_replace_day THEN
    DELETE FROM public.ward_houses WHERE ward_id = v_ward AND carol_day_id = p_carol_day_id;
  ELSE
    SELECT coalesce(max(stop_order) + 1, 0) INTO v_base_order
    FROM public.ward_houses WHERE ward_id = v_ward AND carol_day_id = p_carol_day_id;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_houses)
  LOOP
    INSERT INTO public.ward_houses (
      ward_id, season_id, carol_day_id, family_name, address, lat, lng,
      phone, notes, stop_role, stop_order, drive_mins, distance_label, visit_mins
    ) VALUES (
      v_ward, p_season_id, p_carol_day_id,
      coalesce(v_item->>'family_name', 'Family'),
      coalesce(v_item->>'address', ''),
      NULLIF(v_item->>'lat', '')::double precision,
      NULLIF(v_item->>'lng', '')::double precision,
      coalesce(v_item->>'phone', ''),
      coalesce(v_item->>'notes', ''),
      CASE WHEN upper(coalesce(v_item->>'stop_role','')) IN ('START','END') THEN upper(v_item->>'stop_role') ELSE NULL END,
      v_base_order + v_idx,
      coalesce((v_item->>'drive_mins')::int, 5),
      coalesce(v_item->>'distance_label', ''),
      coalesce((v_item->>'visit_mins')::int, 20)
    );
    v_idx := v_idx + 1;
  END LOOP;

  INSERT INTO public.admin_audit_logs (ward_id, actor_role, action, details)
  VALUES (v_ward, v_role, 'BULK_SAVE_HOUSES', jsonb_build_object('day_id', p_carol_day_id, 'count', v_idx, 'replace', p_replace_day));

  RETURN jsonb_build_object('ok', true, 'inserted', v_idx);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_save_house_order(
  p_ward_id text,
  p_admin_code text,
  p_carol_day_id uuid,
  p_ordered_houses jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
  v_item jsonb;
  v_idx int := 0;
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_ordered_houses)
  LOOP
    UPDATE public.ward_houses
    SET stop_order = v_idx,
        drive_mins = coalesce((v_item->>'drive_mins')::int, drive_mins),
        distance_label = coalesce(v_item->>'distance_label', distance_label),
        visit_mins = coalesce((v_item->>'visit_mins')::int, visit_mins),
        stop_role = CASE WHEN upper(coalesce(v_item->>'stop_role','')) IN ('START','END') THEN upper(v_item->>'stop_role') ELSE NULL END
    WHERE id = (v_item->>'id')::uuid AND ward_id = v_ward AND carol_day_id = p_carol_day_id;
    v_idx := v_idx + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'updated', v_idx);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_checkin_house(
  p_ward_id text,
  p_admin_code text,
  p_house_id uuid,
  p_visited boolean,
  p_actual_timestamp timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
  v_day_id uuid;
  v_next_idx int;
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);

  UPDATE public.ward_houses
  SET visited = p_visited,
      checked_in_at = CASE WHEN p_visited THEN coalesce(p_actual_timestamp, now()) ELSE NULL END
  WHERE id = p_house_id AND ward_id = v_ward
  RETURNING carol_day_id INTO v_day_id;

  IF v_day_id IS NOT NULL THEN
    SELECT coalesce(min(stop_order), 0) INTO v_next_idx
    FROM public.ward_houses
    WHERE ward_id = v_ward AND carol_day_id = v_day_id AND visited = false;

    UPDATE public.carol_days
    SET current_stop_index = v_next_idx,
        last_actual_timestamp = coalesce(p_actual_timestamp, now())
    WHERE id = v_day_id AND ward_id = v_ward;
  END IF;

  RETURN jsonb_build_object('ok', true, 'carol_day_id', v_day_id, 'current_stop_index', v_next_idx);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_save_ward_settings(
  p_ward_id text,
  p_admin_code text,
  p_settings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);

  INSERT INTO public.ward_settings (
    ward_id, default_visit_mins, drive_buffer_mins, meeting_point,
    instructions_banner, coordinator_name, coordinator_phone, whatsapp_group_name, updated_at
  ) VALUES (
    v_ward,
    greatest(5, coalesce((p_settings->>'default_visit_mins')::int, 20)),
    greatest(0, coalesce((p_settings->>'drive_buffer_mins')::int, 5)),
    coalesce(p_settings->>'meeting_point', ''),
    coalesce(p_settings->>'instructions_banner', ''),
    coalesce(p_settings->>'coordinator_name', ''),
    coalesce(p_settings->>'coordinator_phone', ''),
    coalesce(p_settings->>'whatsapp_group_name', ''),
    now()
  )
  ON CONFLICT (ward_id) DO UPDATE SET
    default_visit_mins = EXCLUDED.default_visit_mins,
    drive_buffer_mins = EXCLUDED.drive_buffer_mins,
    meeting_point = EXCLUDED.meeting_point,
    instructions_banner = EXCLUDED.instructions_banner,
    coordinator_name = EXCLUDED.coordinator_name,
    coordinator_phone = EXCLUDED.coordinator_phone,
    whatsapp_group_name = EXCLUDED.whatsapp_group_name,
    updated_at = now();

  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_save_song(
  p_ward_id text,
  p_admin_code text,
  p_song jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
  v_id uuid;
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);

  INSERT INTO public.ward_songs (ward_id, title, lang, lyrics, karaoke_audio_url, source_url)
  VALUES (
    v_ward,
    trim(coalesce(p_song->>'title', 'Untitled Carol')),
    coalesce(p_song->>'lang', 'Custom'),
    coalesce(p_song->>'lyrics', ''),
    coalesce(p_song->>'karaoke_audio_url', ''),
    coalesce(p_song->>'source_url', '')
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'song_id', v_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_song(
  p_ward_id text,
  p_admin_code text,
  p_song_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);
  DELETE FROM public.ward_songs WHERE id = p_song_id AND ward_id = v_ward;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- 7. Grant Execute ONLY on Gatekeeper RPCs
GRANT EXECUTE ON FUNCTION public.get_ward_carol_data(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_ward_admin_code(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_ward_user_code(text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_ward_admin_code(text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_season(text, text, int, text, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clone_previous_season(text, text, int, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_carol_day(text, text, uuid, uuid, int, text, date, text, int, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_bulk_save_houses(text, text, uuid, uuid, jsonb, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_house_order(text, text, uuid, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_checkin_house(text, text, uuid, boolean, timestamptz) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_ward_settings(text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_song(text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_song(text, text, uuid) TO anon, authenticated;
