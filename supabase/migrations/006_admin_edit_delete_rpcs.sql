-- ============================================================================
-- Migration 006: Admin Edit & Delete RPCs (Seasons, Carol Days, Single Houses)
-- Idempotent: Safe to re-run
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_delete_season(
  p_ward_id text,
  p_admin_code text,
  p_season_id uuid
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
  DELETE FROM public.carol_seasons WHERE id = p_season_id AND ward_id = v_ward;

  IF NOT EXISTS (SELECT 1 FROM public.carol_seasons WHERE ward_id = v_ward AND is_active = true) THEN
    UPDATE public.carol_seasons
    SET is_active = true
    WHERE id = (SELECT id FROM public.carol_seasons WHERE ward_id = v_ward ORDER BY year DESC LIMIT 1);
  END IF;

  INSERT INTO public.admin_audit_logs (ward_id, actor_role, action, details)
  VALUES (v_ward, v_role, 'DELETE_SEASON', jsonb_build_object('season_id', p_season_id));
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_carol_day(
  p_ward_id text,
  p_admin_code text,
  p_day_id uuid
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
  DELETE FROM public.carol_days WHERE id = p_day_id AND ward_id = v_ward;

  INSERT INTO public.admin_audit_logs (ward_id, actor_role, action, details)
  VALUES (v_ward, v_role, 'DELETE_DAY', jsonb_build_object('day_id', p_day_id));
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_upsert_single_house(
  p_ward_id text,
  p_admin_code text,
  p_house jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
  v_id uuid := NULLIF(p_house->>'id', '')::uuid;
  v_season_id uuid;
  v_fam text := trim(coalesce(p_house->>'family_name', ''));
  v_addr text := trim(coalesce(p_house->>'address', ''));
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);
  SELECT season_id INTO v_season_id FROM public.ward_houses WHERE id = v_id AND ward_id = v_ward;

  IF v_season_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.ward_houses
    WHERE ward_id = v_ward
      AND season_id = v_season_id
      AND id <> v_id
      AND (
        regexp_replace(lower(family_name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(v_fam), '[^a-z0-9]', '', 'g')
        OR regexp_replace(lower(address), '[^a-z0-9]', '', 'g') = regexp_replace(lower(v_addr), '[^a-z0-9]', '', 'g')
      )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_FAMILY_OR_ADDRESS');
  END IF;

  UPDATE public.ward_houses
  SET family_name = coalesce(nullif(v_fam, ''), family_name),
      address = coalesce(nullif(v_addr, ''), address),
      phone = coalesce(p_house->>'phone', phone),
      notes = coalesce(p_house->>'notes', notes),
      stop_role = CASE WHEN upper(coalesce(p_house->>'stop_role','')) IN ('START','END') THEN upper(p_house->>'stop_role') ELSE NULL END,
      visit_mins = greatest(5, coalesce((p_house->>'visit_mins')::int, visit_mins)),
      lat = COALESCE(NULLIF(p_house->>'lat', '')::double precision, lat),
      lng = COALESCE(NULLIF(p_house->>'lng', '')::double precision, lng)
  WHERE id = v_id AND ward_id = v_ward;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_house(
  p_ward_id text,
  p_admin_code text,
  p_house_id uuid
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
  DELETE FROM public.ward_houses WHERE id = p_house_id AND ward_id = v_ward;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_delete_season(text, text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_carol_day(text, text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_single_house(text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_house(text, text, uuid) TO anon, authenticated;
