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
1. **Run SQL Migrations** in your Supabase SQL Editor in order:
   - `supabase/migrations/001_multi_ward_carol.sql` — Creates all tables (`carol_seasons`, `carol_days`, `ward_houses`, `ward_settings`, `ward_songs`, `ward_access_codes`, `admin_audit_logs`, `auth_rate_limits`), enables strict RLS with **zero public `SELECT` policies on PII tables**, and installs all rate-limited `SECURITY DEFINER` RPCs.
   - `supabase/migrations/002_seed_ward4_2026.sql` — Initializes Wards `W1`–`W5` and safely migrates all 25 Ward 4 2026 houses (`Day 1: Dec 12` & `Day 2: Dec 19`) into `W4`. *(Change the initial placeholder codes before running, or rotate immediately inside **🔐 Admin → Security**.)*
2. **Optional Edge Function (CORS-safe `madely.us` Lyrics + Audio-Only Karaoke Extractor)**:
   ```bash
   supabase functions deploy madely-lyrics --no-verify-jwt
   ```
3. **Connect Frontend**:
   - Paste your `SUPABASE_URL` and public `SUPABASE_ANON_KEY` into `supabase-config.js` (or configure directly in-app via **⚙️ Settings → Connect Supabase**).

## Architecture & Key Features
- **Dual-Layer Security**: Zero hardcoded codes or PII in frontend code. Parishioners enter their Ward Access Code once per season (cached per ward; auto-revoked if Admin resets the code). Independent Admin Code per ward (`W1`–`W5`) + `MASTER` override.
- **PII-Free Realtime Sync**: Broadcasts only `{ ward_id, carol_day_id, current_stop_index, actual_timestamp }` to shift ETAs across 30–50 connected devices simultaneously.
- **Admin Portal (4 Tabs)**: Multi-Day Bulk Delimited Importer (`,`, `|`, `\t`, `;`) with one-time geocoding, Constrained Nearest-Neighbor + 2-Opt Route Optimizer (`START`/`END` pinned), Multi-Year Season Manager & Clone-Last-Year, and Security Code Reset + 1-Click WhatsApp Ward Invite.
- **Field Resilience**: Midnight Evergreen Night Palette + Daytime Snow Toggle, auto Screen Wake Lock, 20-Min House Countdown Timer, Single Navigate button (Google Maps default, Apple/Waze in Settings), Chunked Multi-Stop Google Maps Launcher (>9 stops), Unplanned House Shortest-Detour Inserter, and Offline-First PWA Cache.
- **Carol Songbook**: Add Song panel on top, full-width lyrics, `A- / A+` sizing, `madely.us` importer, and strict **Audio-Only Karaoke Player** (zero video UI, shown only when an audio track exists).
