# St. Mary's Multi-Ward Christmas Carol PWA (`W1`–`W5`)
**St. Mary's Syro Malabar Catholic Church**

Live Multi-Ward PWA: **https://stmarys-hub.github.io/carol/**  
*(Original standalone Ward 4 repo preserved untouched at https://github.com/StMarys-hub/carol-w4)*

## Ward Deep-Links
- **Ward 1 – St. Kuriakose Chavara**: `https://stmarys-hub.github.io/carol/?ward=W1`
- **Ward 2 – St. Alphonsa**: `https://stmarys-hub.github.io/carol/?ward=W2`
- **Ward 3 – St. Mother Teresa**: `https://stmarys-hub.github.io/carol/?ward=W3`
- **Ward 4 – Blessed Kunjachan**: `https://stmarys-hub.github.io/carol/?ward=W4`
- **Ward 5 – St. Michael**: `https://stmarys-hub.github.io/carol/?ward=W5`

## Supabase Backend Setup (5 Minutes)
See [supabase/SETUP_GUIDE.md](supabase/SETUP_GUIDE.md) for the full isolation architecture (`stmarys-carol` dedicated project vs. `carol` schema fallback), ASCII ERD, and 5-point zero-impact verification checklist.

1. **Run Modular SQL Migrations** in your `stmarys-carol` Supabase SQL Editor in order:
   - `supabase/migrations/001_extensions_and_helpers.sql` — Enables `pgcrypto` and installs the shared `set_updated_at()` trigger function.
   - `supabase/migrations/002_core_tables.sql` — Creates `carol_seasons`, `carol_days`, `ward_houses`, `ward_settings`, `ward_songs`, indexes, `updated_at` triggers, and `COMMENT ON` table documentation.
   - `supabase/migrations/003_security_and_access.sql` — Creates `ward_access_codes`, `admin_audit_logs`, `auth_rate_limits`, enables strict RLS on all 8 tables with **zero public `SELECT` policies**, and revokes direct table access from `anon`/`authenticated`.
   - `supabase/migrations/004_rpcs_and_triggers.sql` — Installs private security helpers and grants `EXECUTE` on all 13 rate-limited `SECURITY DEFINER` RPCs.
   - `supabase/migrations/005_seed_initial_wards.sql` — Initializes Wards `W1`–`W5` + `MASTER` and safely migrates all 25 Ward 4 2026 houses (`Day 1: Dec 12` & `Day 2: Dec 19`) into `W4`. *(Change the initial placeholder codes before running, or rotate immediately inside **🔐 Admin → Security**.)*
2. **Optional Edge Function (CORS-safe `madely.us` Lyrics + Audio-Only Karaoke Extractor)**:
   ```bash
   supabase functions deploy madely-lyrics --no-verify-jwt
   ```
3. **Connect Frontend**:
   - Paste your `stmarys-carol` `SUPABASE_URL` and public `SUPABASE_ANON_KEY` into `supabase-config.js` (or configure directly in-app via **⚙️ Settings → Connect Supabase**).

## Architecture & Key Features
- **Dual-Layer Security**: Zero hardcoded codes or PII in frontend code. Parishioners enter their Ward Access Code once per season (cached per ward; auto-revoked if Admin resets the code). Independent Admin Code per ward (`W1`–`W5`) + `MASTER` override.
- **PII-Free Realtime Sync**: Broadcasts only `{ ward_id, carol_day_id, current_stop_index, actual_timestamp }` to shift ETAs across 30–50 connected devices simultaneously.
- **Admin Portal (4 Tabs)**: Multi-Day Bulk Delimited Importer (`,`, `|`, `\t`, `;`) with one-time geocoding, Constrained Nearest-Neighbor + 2-Opt Route Optimizer (`START`/`END` pinned), Multi-Year Season Manager & Clone-Last-Year, and Security Code Reset + 1-Click WhatsApp Ward Invite.
- **Field Resilience**: Midnight Evergreen Night Palette + Daytime Snow Toggle, auto Screen Wake Lock, 20-Min House Countdown Timer, Single Navigate button (Google Maps default, Apple/Waze in Settings), Chunked Multi-Stop Google Maps Launcher (>9 stops), Unplanned House Shortest-Detour Inserter, and Offline-First PWA Cache.
- **Carol Songbook**: Add Song panel on top, full-width lyrics, `A- / A+` sizing, `madely.us` importer, and strict **Audio-Only Karaoke Player** (zero video UI, shown only when an audio track exists).
