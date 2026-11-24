-- ============================================================================
-- Migration 007: Parishioner Song Submissions + Coordinator Approval Workflow
-- Idempotent: Safe to re-run
-- ============================================================================

-- 1. Add approval status & submitter columns to ward_songs
ALTER TABLE public.ward_songs
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('PENDING','APPROVED')),
  ADD COLUMN IF NOT EXISTS submitted_by text DEFAULT '';

-- 2. Ensure get_ward_carol_data returns ONLY APPROVED shared songs to parishioners
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
      WHERE sg.ward_id = v_ward AND sg.status = 'APPROVED'
    ), '[]'::jsonb)
  );
END;
$$;

-- 3. Parishioner Song Submission RPC (verified via Ward Access Code -> status = 'PENDING')
CREATE OR REPLACE FUNCTION public.submit_ward_song(
  p_ward_id text,
  p_user_code text,
  p_song jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_ward text := upper(trim(coalesce(p_ward_id, '')));
  v_code text := trim(coalesce(p_user_code, ''));
  v_hash text;
  v_id uuid;
  v_title text := trim(coalesce(p_song->>'title', ''));
  v_lyrics text := trim(coalesce(p_song->>'lyrics', ''));
BEGIN
  IF v_ward NOT IN ('W1','W2','W3','W4','W5') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_WARD');
  END IF;
  IF NOT public._check_rate_limit(v_ward, 'USER') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
  END IF;

  SELECT user_code_hash INTO v_hash FROM public.ward_access_codes WHERE ward_id = v_ward;
  IF v_hash IS NULL OR crypt(v_code, v_hash) <> v_hash THEN
    PERFORM public._log_failed_attempt(v_ward, 'USER');
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_WARD_CODE');
  END IF;

  IF v_title = '' OR v_lyrics = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TITLE_AND_LYRICS_REQUIRED');
  END IF;

  INSERT INTO public.ward_songs (ward_id, title, lang, lyrics, karaoke_audio_url, source_url, status, submitted_by)
  VALUES (
    v_ward,
    v_title,
    coalesce(nullif(trim(p_song->>'lang'), ''), 'Custom'),
    v_lyrics,
    coalesce(trim(p_song->>'karaoke_audio_url'), ''),
    coalesce(trim(p_song->>'source_url'), ''),
    'PENDING',
    coalesce(trim(p_song->>'submitted_by'), 'Ward Member')
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'song_id', v_id, 'status', 'PENDING');
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- 4. Admin Pending Songs List & Approve/Reject RPCs
CREATE OR REPLACE FUNCTION public.admin_list_pending_songs(
  p_ward_id text,
  p_admin_code text
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
  RETURN jsonb_build_object(
    'ok', true,
    'pending_songs', coalesce((
      SELECT jsonb_agg(to_jsonb(sg) ORDER BY sg.created_at DESC)
      FROM public.ward_songs sg
      WHERE sg.ward_id = v_ward AND sg.status = 'PENDING'
    ), '[]'::jsonb)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_approve_song(
  p_ward_id text,
  p_admin_code text,
  p_song_id uuid,
  p_approve boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_ward text := upper(trim(p_ward_id));
  v_title text;
BEGIN
  v_role := public._assert_ward_admin(v_ward, p_admin_code);

  IF p_approve THEN
    SELECT title INTO v_title FROM public.ward_songs WHERE id = p_song_id AND ward_id = v_ward;
    -- If this approved song is an edit of an existing shared song with the same title, remove the older copy
    IF v_title IS NOT NULL THEN
      DELETE FROM public.ward_songs
      WHERE ward_id = v_ward
        AND id <> p_song_id
        AND status = 'APPROVED'
        AND lower(trim(title)) = lower(trim(v_title));
    END IF;
    UPDATE public.ward_songs
    SET status = 'APPROVED'
    WHERE id = p_song_id AND ward_id = v_ward;
  ELSE
    DELETE FROM public.ward_songs
    WHERE id = p_song_id AND ward_id = v_ward AND status = 'PENDING';
  END IF;

  INSERT INTO public.admin_audit_logs (ward_id, actor_role, action, details)
  VALUES (v_ward, v_role, CASE WHEN p_approve THEN 'APPROVE_SONG' ELSE 'REJECT_SONG' END, jsonb_build_object('song_id', p_song_id));

  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_ward_song(text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_pending_songs(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_approve_song(text, text, uuid, boolean) TO anon, authenticated;
