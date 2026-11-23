# Supabase Architecture & Setup Guide — `stmarys-carol`

**Organization:** `StMarys-hub's Org`  
**App:** Multi-Ward Christmas Carol Static PWA (`https://stmarys-hub.github.io/carol/`)  
**Isolation Goal:** Zero risk, zero schema collision, and zero traffic impact on the live **Parish Announcements** Supabase project.

---

## 1. Isolation Strategy Inside `StMarys-hub's Org`

| Criteria | Dedicated Project: `stmarys-carol` **(Recommended)** | Shared DB: Dedicated `carol` Schema *(Fallback Only)* |
|---|---|---|
| **Risk to Parish Announcements** | **Zero** — physically separate Postgres DB, backups, and migrations | Low, but shares CPU, RAM, connection pool, and backup/restore blast radius |
| **API Keys & Security** | Independent `SUPABASE_URL` and `anon` key | Shares the same `anon` key with Parish Announcements |
| **Realtime Connections** | Independent pool (30–50 concurrent carolers never impact parish bulletin) | Shares Realtime connection limits |
| **Supabase Free Tier** | Free (orgs allow **2 active Free Tier projects**; Parish Announcements + `stmarys-carol` = 2) | Only needed if the org already has 2 active Free Tier projects |
| **Frontend Change Needed** | None — works out of the box with `public` schema | Must expose `carol` in **API Settings → Exposed Schemas** and pass `{ db: { schema: 'carol' } }` in `app.js` |

> **Recommendation:** Use a **Dedicated Project (`stmarys-carol`)**. Only use the `carol` schema fallback if `StMarys-hub's Org` already has 2 active Free Tier projects and cannot upgrade.

---

## 2. Entity-Relationship Diagram (All 8 Tables)

All tables have **RLS enabled** with **zero public policies** and `REVOKE ALL` from `anon, authenticated`. Every read/write flows through the 13 `SECURITY DEFINER` RPCs in `004_rpcs_and_triggers.sql`.

```text
+-----------------------+          +---------------------------+
|     ward_settings     |          |     ward_access_codes     |
|-----------------------|          |---------------------------|
| PK ward_id (W1..W5)   |          | PK ward_id (W1..W5,MASTER)|
|    active_year        |          |    user_code_hash (bcrypt)|
|    default_visit_mins |          |    user_code_version      |
|    drive_buffer_mins  |          |    admin_code_hash(bcrypt)|
|    meeting_point      |          |    created_at, updated_at |
|    coordinator_*      |          +---------------------------+
|    whatsapp_group_name|
|    created_at,upd_at  |          +---------------------------+
+-----------------------+          |     admin_audit_logs      |
                                   |---------------------------|
+-----------------------+          | PK id (bigserial)         |
|      ward_songs       |          |    ward_id                |
|-----------------------|          |    actor_role (WARD|MASTER|
| PK id (uuid)          |          |    action                 |
|    ward_id (W1..W5)   |          |    details (jsonb)        |
|    title, lang        |          |    created_at             |
|    lyrics             |          +---------------------------+
|    karaoke_audio_url  |
|    source_url         |          +---------------------------+
|    created_at,upd_at  |          |     auth_rate_limits      |
+-----------------------+          |---------------------------|
                                   | PK id (bigserial)         |
                                   |    ward_id                |
                                   |    attempt_type(USER|ADMIN|
                                   |    attempted_at           |
                                   +---------------------------+

+-----------------------+      1 : N (ON DELETE CASCADE)
|     carol_seasons     |--------------------------------------+
|-----------------------|                                      |
| PK id (uuid)          |                                      v
| UQ ward_id (W1..W5)   |                          +-----------------------+
| UQ year (2026,2027..) |                          |      carol_days       |
|    name               |                          |-----------------------|
|    is_active          |                          | PK id (uuid)          |
|    created_at,upd_at  |                          |    ward_id (W1..W5)   |
+-----------+-----------+                          | FK season_id          |
            |                                      | UQ day_number         |
            | 1 : N (ON DELETE CASCADE)            |    label, carol_date  |
            |                                      |    start_time         |
            |     +--------------------------------|    current_stop_index |
            |     | 1 : N (ON DELETE CASCADE)      |    last_actual_ts     |
            v     v                                |    created_at,upd_at  |
+-----------------------+                          +-----------------------+
|      ward_houses      |  <-- PII-PROTECTED (Zero direct SELECT)
|-----------------------|
| PK id (uuid)          |
|    ward_id (W1..W5)   |
| FK season_id          |
| FK carol_day_id       |
|    family_name (PII)  |
|    address (PII)      |
|    lat, lng           |
|    phone (PII)        |
|    notes              |
|    stop_role(START|END|
|    stop_order         |
|    drive_mins, visit_m|
|    visited, checked_in|
|    created_at,upd_at  |
+-----------------------+
```

---

## 3. Modular Migration Execution Order

Run these 5 idempotent scripts **in exact order** inside the `stmarys-carol` Supabase SQL Editor:

1. `supabase/migrations/001_extensions_and_helpers.sql` — Enables `pgcrypto` and installs the shared `set_updated_at()` trigger function.
2. `supabase/migrations/002_core_tables.sql` — Creates `carol_seasons`, `carol_days`, `ward_houses`, `ward_settings`, `ward_songs`, indexes, `updated_at` triggers, and Table Editor `COMMENT ON` docs.
3. `supabase/migrations/003_security_and_access.sql` — Creates `ward_access_codes`, `admin_audit_logs`, `auth_rate_limits`, enables RLS on all 8 tables, drops any legacy policies, and revokes all direct table access from `anon`/`authenticated`.
4. `supabase/migrations/004_rpcs_and_triggers.sql` — Installs private security helpers and grants `EXECUTE` on the 13 gatekeeper/admin RPCs called by `app.js`.
5. `supabase/migrations/005_seed_initial_wards.sql` — Initializes `W1`–`W5` + `MASTER` and seeds the 25-house Ward 4 (2026) schedule. *(Change placeholder codes before running, or rotate immediately inside **🔐 Admin → Security**.)*

---

## 4. GitHub Pages + Supabase Connection Guide

Because `carol` is a **zero-build static PWA** hosted directly from GitHub Pages (no Vite or `.env.local` build step):

1. In the `stmarys-carol` Supabase Dashboard, go to **Project Settings → API** and copy:
   - **Project URL** (`https://<carol-project-ref>.supabase.co`)
   - **`anon` / `public` key** *(never copy the `service_role` key into frontend code!)*
2. Open `supabase-config.js` in this repo and paste them into `window.CAROL_APP_CONFIG`:
   ```js
   SUPABASE_URL: "https://<carol-project-ref>.supabase.co",
   SUPABASE_ANON_KEY: "<stmarys-carol-anon-key>",
   ```
   *(Double-check the project URL slug so you never accidentally paste the Parish Announcements project's URL or key.)*
3. In `stmarys-carol` Dashboard → **Authentication → URL Configuration**:
   - **Site URL:** `https://stmarys-hub.github.io/carol/`
   - **Redirect URLs:** `https://stmarys-hub.github.io/carol/**`
4. **Realtime (PII-Free Broadcast Only):**
   - Do **not** add `ward_houses` or any other table to the `supabase_realtime` publication. Live ETA sync uses Supabase Realtime Broadcast channels (`{ ward_id, carol_day_id, current_stop_index, actual_timestamp }`).
5. **Optional Edge Function (`madely-lyrics`):**
   ```bash
   supabase link --project-ref <carol-project-ref>
   supabase functions deploy madely-lyrics --no-verify-jwt
   ```

---

## 5. Five-Point Verification Checklist (Confirming Zero Impact on Parish Announcements)

Run these 5 checks after setup:

1. **Zero Public PII Leak Test:** In your browser or terminal, run:
   ```bash
   curl -s "https://<carol-project-ref>.supabase.co/rest/v1/ward_houses?select=*" \
     -H "apikey: <stmarys-carol-anon-key>" \
     -H "Authorization: Bearer <stmarys-carol-anon-key>"
   ```
   **Expected:** `401` / `403` permission denied (or empty error object) — **never** family rows.
2. **Gatekeeper RPC Test:** Open `https://stmarys-hub.github.io/carol/?ward=W4`, enter the Ward 4 user code, and confirm all 25 houses load cleanly across Day 1 (13) and Day 2 (12).
3. **Admin Rotation & Revocation Test:** Open **🔐 Admin → Security**, rotate the Ward 4 user code and admin code (replacing the seed placeholders), and verify the old user code is immediately rejected.
4. **Cross-Project Credential Check:** Compare `SUPABASE_URL` in `supabase-config.js` against the Parish Announcements repo — confirm the `<project-ref>` subdomains are completely different.
5. **Parish Announcements Health Check:** Open the live Parish Announcements app and its Supabase Dashboard → verify its tables, row counts, and Realtime traffic are 100% untouched.

---

## 6. Multi-Year Season Rollover (`2027`, `2028+`)

No SQL is required to start a new Christmas season:
1. Open the ward link (`?ward=W1` .. `?ward=W5`) and unlock **🔐 Admin → Seasons**.
2. Click **Clone Previous Season** (calls `admin_clone_previous_season(ward_id, admin_code, 2026, 2027)`), which copies all days and houses with `visited = false` and activates the new year.
3. Open **🔐 Admin → Security** and reset the seasonal Ward Access Code to distribute a fresh code in the ward WhatsApp group.
