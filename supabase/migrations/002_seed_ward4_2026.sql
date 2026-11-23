-- ============================================================================
-- Migration 002: Initialize All 5 Wards (W1–W5) & Migrate Ward 4 (2026) Data
-- IMPORTANT: Replace the initial placeholder access/admin codes below BEFORE
--            running in production (or rotate immediately in Admin -> Security).
-- ============================================================================

-- 1. Seed Default Ward Settings for W1–W5
INSERT INTO public.ward_settings (ward_id, active_year, default_visit_mins, drive_buffer_mins, whatsapp_group_name)
VALUES
  ('W1', 2026, 20, 5, 'Ward 1- St. Kuriakose Chavara'),
  ('W2', 2026, 20, 5, 'Ward 2- St. Alphonsa'),
  ('W3', 2026, 20, 5, 'Ward 3- St. Mother Teresa'),
  ('W4', 2026, 20, 5, 'Ward 4- Blessed Kunjachan'),
  ('W5', 2026, 20, 5, 'Ward 5- St. Michael')
ON CONFLICT (ward_id) DO NOTHING;

-- 2. Seed Hashed Access Codes (bcrypt via pgcrypto — change these before running!)
INSERT INTO public.ward_access_codes (ward_id, user_code_hash, admin_code_hash)
VALUES
  ('W1',     crypt('1001', gen_salt('bf')), crypt('W1-ADMIN-2026', gen_salt('bf'))),
  ('W2',     crypt('2002', gen_salt('bf')), crypt('W2-ADMIN-2026', gen_salt('bf'))),
  ('W3',     crypt('3003', gen_salt('bf')), crypt('W3-ADMIN-2026', gen_salt('bf'))),
  ('W4',     crypt('4004', gen_salt('bf')), crypt('W4-ADMIN-2026', gen_salt('bf'))),
  ('W5',     crypt('5005', gen_salt('bf')), crypt('W5-ADMIN-2026', gen_salt('bf'))),
  ('MASTER', NULL,                          crypt('STMARYS-MASTER-2026', gen_salt('bf')))
ON CONFLICT (ward_id) DO NOTHING;

-- 3. Create 2026 Season for All 5 Wards
INSERT INTO public.carol_seasons (ward_id, year, name, is_active)
VALUES
  ('W1', 2026, 'Christmas Carol 2026', true),
  ('W2', 2026, 'Christmas Carol 2026', true),
  ('W3', 2026, 'Christmas Carol 2026', true),
  ('W4', 2026, 'Christmas Carol 2026', true),
  ('W5', 2026, 'Christmas Carol 2026', true)
ON CONFLICT (ward_id, year) DO NOTHING;

-- 4. Migrate Official Ward 4 (carol-w4) 2026 Schedule (Day 1: 13 Houses, Day 2: 12 Houses)
DO $$
DECLARE
  v_s4 uuid;
  v_d1 uuid;
  v_d2 uuid;
BEGIN
  SELECT id INTO v_s4 FROM public.carol_seasons WHERE ward_id = 'W4' AND year = 2026;

  INSERT INTO public.carol_days (ward_id, season_id, day_number, label, carol_date, start_time, avg_visit_mins, drive_buffer_mins)
  VALUES ('W4', v_s4, 1, 'Day 1 • Dec 12', '2026-12-12', '14:00', 20, 5)
  ON CONFLICT (season_id, day_number) DO UPDATE SET label = EXCLUDED.label
  RETURNING id INTO v_d1;

  INSERT INTO public.carol_days (ward_id, season_id, day_number, label, carol_date, start_time, avg_visit_mins, drive_buffer_mins)
  VALUES ('W4', v_s4, 2, 'Day 2 • Dec 19', '2026-12-19', '14:30', 20, 5)
  ON CONFLICT (season_id, day_number) DO UPDATE SET label = EXCLUDED.label
  RETURNING id INTO v_d2;

  IF NOT EXISTS (SELECT 1 FROM public.ward_houses WHERE carol_day_id = v_d1) THEN
    INSERT INTO public.ward_houses
      (ward_id, season_id, carol_day_id, family_name, address, lat, lng, notes, stop_role, stop_order, drive_mins, distance_label, visit_mins)
    VALUES
      ('W4', v_s4, v_d1, 'Jojan & Smitha', '10142 Blakeney Preserve Dr, Charlotte, NC 28277', 35.03166, -80.81104, 'Day 1 Starting House • Blakeney Preserve', 'START', 0, 0, 'Gather 2:00 PM', 20),
      ('W4', v_s4, v_d1, 'Anumodh and Cynthia', '7220 Ashton Gate Dr, Charlotte, NC 28270', 35.14275, -80.77227, 'Heading north along Providence Rd', NULL, 1, 20, '10.3 mi drive', 20),
      ('W4', v_s4, v_d1, 'Jaison & Radhika', '8016 Providence Court Ln, Apt 202, Charlotte, NC 28270', 35.10922, -80.76496, 'Apt 202 • Near Arboretum', NULL, 2, 9, '3.4 mi drive', 20),
      ('W4', v_s4, v_d1, 'Seran & Siji', '2509 Houston Branch Rd, Charlotte, NC 28270', 35.08798, -80.74582, 'Heading southeast via Providence / High Ridge Rd', NULL, 3, 11, '3.8 mi drive', 20),
      ('W4', v_s4, v_d1, 'Giorgio and Nitya', '1008 Minden Dr, Matthews, NC 28104', 35.06633, -80.70631, 'Park once for walkable cluster: Stops #5, #6 & #7', NULL, 4, 10, '4.2 mi drive', 20),
      ('W4', v_s4, v_d1, 'Togin and Sweety', '1001 Harrogate Ln, Matthews, NC 28104', 35.06566, -80.70509, '🚶 Walkable next door in same neighborhood', NULL, 5, 2, '2 min walk (0.1 mi)', 20),
      ('W4', v_s4, v_d1, 'Joseph and Anu', '4006 Ainsdale Dr, Matthews, NC 28104', 35.06447, -80.70812, '🚶 Walkable in same neighborhood • Return to cars after', NULL, 6, 4, '4 min walk (0.3 mi)', 20),
      ('W4', v_s4, v_d1, 'Thomas & Mariamma', '5507 Fulton Ridge Dr, Indian Trail, NC 28079', 35.03408, -80.65954, 'Heading southeast into Indian Trail', NULL, 7, 13, '6.3 mi drive', 20),
      ('W4', v_s4, v_d1, 'Jinson and Telma', '1011 Coulwood Ln, Indian Trail, NC 28079', 35.03153, -80.66605, 'Nearby neighborhood in Indian Trail', NULL, 8, 4, '1.4 mi drive', 20),
      ('W4', v_s4, v_d1, 'Sijo and Leslie', '205 Candella Dr, Matthews, NC 28104', 35.01652, -80.68859, 'Continuing southwest along Wesley Chapel Rd', NULL, 9, 9, '3.1 mi drive', 20),
      ('W4', v_s4, v_d1, 'Joseph and Shainy', '4821 Antioch Church Rd, Weddington, NC 28104', 35.01406, -80.70938, 'Continuing west across Beulah Church Rd', NULL, 10, 7, '2.3 mi drive', 20),
      ('W4', v_s4, v_d1, 'Paul and Tess', '1008 James Madison Dr, Weddington, NC 28104', 35.03221, -80.73729, 'Heading northwest up Antioch Church Rd', NULL, 11, 8, '2.5 mi drive', 20),
      ('W4', v_s4, v_d1, 'Binoy & Sunitha', '3029 Twin Lakes Dr, Matthews, NC 28104', 35.01428, -80.73504, '🍽️ Day 1 Final Stop & Dinner Host', 'END', 12, 6, '2.2 mi drive', 60);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ward_houses WHERE carol_day_id = v_d2) THEN
    INSERT INTO public.ward_houses
      (ward_id, season_id, carol_day_id, family_name, address, lat, lng, notes, stop_role, stop_order, drive_mins, distance_label, visit_mins)
    VALUES
      ('W4', v_s4, v_d2, 'Jossy and Saumya', '2218 Winthorp Ridge Rd, Charlotte, NC 28270', 35.07589, -80.73318, 'Day 2 Starting House • South Charlotte', 'START', 0, 0, 'Gather 2:30 PM', 20),
      ('W4', v_s4, v_d2, 'Binoy and Sonia', '3523 Deborah Dr, Charlotte, NC 28270', 35.07366, -80.74418, 'Short hop west in 28270', NULL, 1, 4, '1.1 mi drive', 20),
      ('W4', v_s4, v_d2, 'Jimmy & Linet', '11139 Sandstone Rd, Charlotte, NC 28277', 35.05939, -80.77702, 'Heading southwest into 28277', NULL, 2, 9, '3.4 mi drive', 20),
      ('W4', v_s4, v_d2, 'Chris and Seema', '6647 Coral Rose Rd, Charlotte, NC 28277', 35.05267, -80.79537, 'Continuing west near Rea Rd', NULL, 3, 5, '1.5 mi drive', 20),
      ('W4', v_s4, v_d2, 'Charmis and Rosmi', '12137 Humboldt Dr, Charlotte, NC 28277', 35.04356, -80.79564, 'Heading south along Rea Rd corridor', NULL, 4, 3, '1.0 mi drive', 20),
      ('W4', v_s4, v_d2, 'Sijo and Reshma', '10417 Mahonia St, Unit 103, Charlotte, NC 28277', 35.02961, -80.80730, 'Unit 103 • Blakeney area', NULL, 5, 5, '1.8 mi drive', 20),
      ('W4', v_s4, v_d2, 'Jose & Vinny', '9908 Fallon Trace Ave, Charlotte, NC 28277', 35.03234, -80.81286, 'Blakeney Preserve neighborhood', NULL, 6, 3, '0.9 mi drive', 20),
      ('W4', v_s4, v_d2, 'Jins and Lincy', '8412 Cotton Press Rd, Charlotte, NC 28277', 35.02541, -80.81653, 'Continuing southwest toward Ardrey Kell', NULL, 7, 4, '1.3 mi drive', 20),
      ('W4', v_s4, v_d2, 'Rethesh and Annie', '11502 Ashbourne Hall Rd, Charlotte, NC 28277', 35.01739, -80.82968, 'Park once for walkable cluster: Stops #9 & #10', NULL, 8, 4, '1.1 mi drive', 20),
      ('W4', v_s4, v_d2, 'Sudeep and Gina', '9619 Woburn Rd, Charlotte, NC 28277', 35.01890, -80.82921, '🚶 Walkable in same neighborhood • Return to cars after', NULL, 9, 3, '3 min walk (0.15 mi)', 20),
      ('W4', v_s4, v_d2, 'Jacob and Jessy', '11013 Travis Gulch Dr, Charlotte, NC 28277', 35.02704, -80.83054, 'Heading north along Ballantyne / Community House', NULL, 10, 3, '0.7 mi drive', 20),
      ('W4', v_s4, v_d2, 'Thomas and Usha (Menachery)', '10617 Moss Mill Ln, Charlotte, NC 28277', 35.04769, -80.83033, '🍽️ Day 2 Final Stop & Dinner Host', 'END', 11, 5, '2.2 mi drive', 60);
  END IF;
END $$;
