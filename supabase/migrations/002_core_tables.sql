-- ============================================================================
-- St. Mary's Syro Malabar Catholic Church — Multi-Ward Christmas Carol (W1–W5)
-- Migration 002: Core Multi-Ward Tables, Indexes, Triggers & Table Docs
-- Idempotent: Safe to re-run (including upgrades from monolithic 001)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. carol_seasons — Yearly Christmas Carol seasons scoped per ward
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.carol_seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_id text NOT NULL DEFAULT 'W4' CHECK (ward_id IN ('W1','W2','W3','W4','W5')),
  year int NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ward_id, year)
);

ALTER TABLE public.carol_seasons
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.carol_seasons IS
  'Yearly Christmas Carol seasons (2026, 2027, 2028+) isolated per ward (W1–W5).';
COMMENT ON COLUMN public.carol_seasons.ward_id IS 'Ward tenant code: W1 through W5.';
COMMENT ON COLUMN public.carol_seasons.is_active IS 'Marks the currently active season displayed to parishioners in this ward.';

DROP TRIGGER IF EXISTS trg_carol_seasons_updated_at ON public.carol_seasons;
CREATE TRIGGER trg_carol_seasons_updated_at
  BEFORE UPDATE ON public.carol_seasons
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. carol_days — Individual caroling nights/days within a ward season
-- ----------------------------------------------------------------------------
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
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, day_number)
);

ALTER TABLE public.carol_days
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.carol_days IS
  'Scheduled caroling days (Day 1, Day 2, etc.) for a given ward season, including live progress cursor.';
COMMENT ON COLUMN public.carol_days.current_stop_index IS '0-based stop_order of the next unvisited house (synced via PII-free Realtime Broadcast).';
COMMENT ON COLUMN public.carol_days.last_actual_timestamp IS 'Timestamp of the most recent house check-in used to dynamically shift downstream ETAs.';

DROP TRIGGER IF EXISTS trg_carol_days_updated_at ON public.carol_days;
CREATE TRIGGER trg_carol_days_updated_at
  BEFORE UPDATE ON public.carol_days
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. ward_houses — Family stops (CONTAINS PII — zero public SELECT allowed)
-- ----------------------------------------------------------------------------
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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ward_houses
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.ward_houses IS
  'PII-PROTECTED: Parishioner family stops, addresses, coordinates, and check-in state. Accessible ONLY via get_ward_carol_data() and admin RPCs.';
COMMENT ON COLUMN public.ward_houses.family_name IS 'PII: Family display name for caroling stop.';
COMMENT ON COLUMN public.ward_houses.address IS 'PII: Street address used for Google/Apple/Waze navigation.';
COMMENT ON COLUMN public.ward_houses.phone IS 'PII: Optional family contact number.';
COMMENT ON COLUMN public.ward_houses.stop_role IS 'Optional route-optimizer pin: START (fixed first stop), END (fixed dinner/final stop), or NULL.';

DROP TRIGGER IF EXISTS trg_ward_houses_updated_at ON public.ward_houses;
CREATE TRIGGER trg_ward_houses_updated_at
  BEFORE UPDATE ON public.ward_houses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. ward_settings — Per-ward defaults, coordinator contact & WhatsApp group
-- ----------------------------------------------------------------------------
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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ward_settings
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.ward_settings IS
  'Per-ward operational configuration, meeting point, coordinator contact, and WhatsApp group metadata.';
COMMENT ON COLUMN public.ward_settings.coordinator_phone IS 'PII: Ward coordinator phone number shown only to authenticated ward parishioners.';

DROP TRIGGER IF EXISTS trg_ward_settings_updated_at ON public.ward_settings;
CREATE TRIGGER trg_ward_settings_updated_at
  BEFORE UPDATE ON public.ward_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 5. ward_songs — Custom carol lyrics & audio-only karaoke tracks per ward
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ward_songs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_id text NOT NULL DEFAULT 'W4' CHECK (ward_id IN ('W1','W2','W3','W4','W5')),
  title text NOT NULL,
  lang text NOT NULL DEFAULT 'Malayalam',
  lyrics text NOT NULL,
  karaoke_audio_url text DEFAULT '',
  source_url text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ward_songs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.ward_songs IS
  'Ward-specific Carol Songbook entries (Malayalam, English, Manglish) with optional audio-only karaoke URLs.';
COMMENT ON COLUMN public.ward_songs.karaoke_audio_url IS 'Optional direct audio track URL for the audio-only Karaoke Player (never video).';

DROP TRIGGER IF EXISTS trg_ward_songs_updated_at ON public.ward_songs;
CREATE TRIGGER trg_ward_songs_updated_at
  BEFORE UPDATE ON public.ward_songs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 6. Performance Indexes
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_carol_days_ward_season
  ON public.carol_days (ward_id, season_id, day_number);

CREATE INDEX IF NOT EXISTS idx_ward_houses_day_order
  ON public.ward_houses (ward_id, carol_day_id, stop_order);

CREATE INDEX IF NOT EXISTS idx_ward_houses_season
  ON public.ward_houses (ward_id, season_id);

CREATE INDEX IF NOT EXISTS idx_ward_songs_ward
  ON public.ward_songs (ward_id, created_at);
