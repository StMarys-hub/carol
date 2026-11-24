/* Constrained Route Optimizer (Nearest-Neighbor + 2-Opt Local Search)
 * & Smart Multi-Day Delimited Text Importer (Comma, Pipe, Tab, Semicolon)
 */

window.CarolOptimizer = (function () {
  const EARTH_RADIUS_MI = 3958.8;

  function haversineMiles(lat1, lng1, lat2, lng2) {
    if (
      typeof lat1 !== "number" ||
      typeof lng1 !== "number" ||
      typeof lat2 !== "number" ||
      typeof lng2 !== "number" ||
      Number.isNaN(lat1) ||
      Number.isNaN(lng1) ||
      Number.isNaN(lat2) ||
      Number.isNaN(lng2)
    ) {
      return 3.0; // neutral fallback when coordinates missing
    }
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
  }

  function distBetween(a, b) {
    return haversineMiles(a.lat, a.lng, b.lat, b.lng);
  }

  /**
   * Constrained Per-Day Route Optimizer:
   * - Strictly pins stop_role === 'START' to index 0 (if present)
   * - Strictly pins stop_role === 'END' to index N - 1 (if present)
   * - Runs Nearest-Neighbor + 2-Opt Local Search over the middle stops
   * - Safely handles 0, 1, or 2 houses
   */
  function hasValidCoords(h) {
    return (
      h &&
      typeof h.lat === "number" &&
      typeof h.lng === "number" &&
      !Number.isNaN(h.lat) &&
      !Number.isNaN(h.lng) &&
      Math.abs(h.lat) > 0.01 &&
      Math.abs(h.lng) > 0.01
    );
  }

  function optimizeDayHouses(houses) {
    if (!Array.isArray(houses) || houses.length <= 2) {
      const copy = (houses || []).map((h) => ({ ...h }));
      const startIdx = copy.findIndex((h) => h.stop_role === "START");
      if (startIdx > 0) {
        const [st] = copy.splice(startIdx, 1);
        copy.unshift(st);
      }
      const endIdx = copy.findIndex((h) => h.stop_role === "END");
      if (endIdx !== -1 && endIdx < copy.length - 1) {
        const [en] = copy.splice(endIdx, 1);
        copy.push(en);
      }
      return recomputeLegEstimates(copy);
    }

    const pool = houses.map((h) => ({ ...h }));
    let startHouse = null;
    let endHouse = null;

    const sIdx = pool.findIndex((h) => h.stop_role === "START");
    if (sIdx !== -1) startHouse = pool.splice(sIdx, 1)[0];

    const eIdx = pool.findIndex((h) => h.stop_role === "END");
    if (eIdx !== -1) endHouse = pool.splice(eIdx, 1)[0];

    // Keep any un-geocoded houses separate so fake fallback distances never corrupt 2-Opt
    const ungeocoded = [];
    const geocodedPool = [];
    for (const h of pool) {
      if (hasValidCoords(h)) geocodedPool.push(h);
      else ungeocoded.push(h);
    }

    const ordered = [];
    if (startHouse) {
      ordered.push(startHouse);
    } else if (geocodedPool.length > 0) {
      ordered.push(geocodedPool.shift());
    }

    // Nearest-Neighbor construction over geocoded stops
    while (geocodedPool.length > 0) {
      const curr = ordered[ordered.length - 1];
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < geocodedPool.length; i++) {
        const d = distBetween(curr, geocodedPool[i]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      ordered.push(geocodedPool.splice(bestIdx, 1)[0]);
    }

    if (endHouse) ordered.push(endHouse);

    // 2-Opt Local Search (only swaps interior geocoded indices so START & END stay strictly pinned)
    const lockStart = startHouse ? 1 : 0;
    const lockEnd = endHouse ? ordered.length - 1 : ordered.length;
    const n = ordered.length;

    let improved = true;
    let guard = 0;
    while (improved && guard < 120) {
      improved = false;
      guard++;
      for (let i = lockStart; i < lockEnd - 1; i++) {
        for (let k = i + 1; k < lockEnd; k++) {
          const prevI = i > 0 ? ordered[i - 1] : null;
          const nextK = k + 1 < n ? ordered[k + 1] : null;

          const before =
            (prevI ? distBetween(prevI, ordered[i]) : 0) +
            (nextK ? distBetween(ordered[k], nextK) : 0);
          const after =
            (prevI ? distBetween(prevI, ordered[k]) : 0) +
            (nextK ? distBetween(ordered[i], nextK) : 0);

          if (after + 0.001 < before) {
            let left = i;
            let right = k;
            while (left < right) {
              [ordered[left], ordered[right]] = [ordered[right], ordered[left]];
              left++;
              right--;
            }
            improved = true;
          }
        }
      }
    }

    // Place any un-geocoded stops right before END (never falsely jammed into #2)
    if (ungeocoded.length > 0) {
      const insertAt = endHouse ? ordered.length - 1 : ordered.length;
      ordered.splice(insertAt, 0, ...ungeocoded);
    }

    return recomputeLegEstimates(ordered);
  }

  /**
   * Realistic Charlotte suburban traffic multiplier:
   * - "afternoon" (default carol planning): 1.35x + 2 min light/parking buffer
   * - "now" (Shift to Now): dynamic based on current local time-of-day traffic
   */
  function getTrafficProfile(mode = "afternoon", nowDate = new Date()) {
    if (mode === "now") {
      const h = nowDate.getHours() + nowDate.getMinutes() / 60;
      const day = nowDate.getDay(); // 0=Sun, 6=Sat
      const isWeekend = day === 0 || day === 6;

      if ((h >= 15.5 && h < 18.75) || (!isWeekend && h >= 7 && h < 9.5)) {
        return { mult: 1.48, bufferMins: 2, label: "Peak Traffic" };
      }
      if (h >= 11.5 && h < 15.5) {
        return { mult: 1.32, bufferMins: 2, label: "Afternoon Traffic" };
      }
      if (h >= 18.75 && h < 21.5) {
        return { mult: 1.22, bufferMins: 2, label: "Evening Traffic" };
      }
      return { mult: 1.1, bufferMins: 1, label: "Light Traffic" };
    }
    // Default planning profile: realistic Saturday afternoon / holiday traffic
    return { mult: 1.35, bufferMins: 2, label: "Afternoon Traffic" };
  }

  function recomputeLegEstimates(ordered, mode = "afternoon") {
    const profile = getTrafficProfile(mode);
    return ordered.map((h, idx) => {
      if (idx === 0) {
        return { ...h, stop_order: 0, drive_mins: 0, distance_label: h.distance_label || "Start" };
      }
      const prev = ordered[idx - 1];
      const mi = distBetween(prev, h);
      if (mi <= 0.22) {
        const walkMins = Math.max(2, Math.round(mi * 20));
        return {
          ...h,
          stop_order: idx,
          drive_mins: walkMins,
          distance_label: `${walkMins} min walk (${mi.toFixed(2)} mi)`
        };
      }
      const roadMi = mi * 1.28;
      // Base suburban Charlotte road speed (~26 mph) scaled by afternoon/current traffic + parking buffer
      const baseMins = roadMi * 2.3;
      const driveMins = Math.max(3, Math.round(baseMins * profile.mult + profile.bufferMins));
      return {
        ...h,
        stop_order: idx,
        drive_mins: driveMins,
        distance_label: `${roadMi.toFixed(1)} mi drive`
      };
    });
  }

  /**
   * Find best insertion index for an unplanned house among unvisited stops
   * (never after an END-pinned house)
   */
  function findBestInsertionSlot(stops, newCoords) {
    const firstUnvisited = stops.findIndex((s) => !s.visited);
    const hasEnd = stops.length > 0 && stops[stops.length - 1].stop_role === "END";
    const minSlot = firstUnvisited === -1 ? Math.max(0, stops.length - (hasEnd ? 1 : 0)) : firstUnvisited;
    const maxSlot = hasEnd ? stops.length - 1 : stops.length;

    if (!newCoords || maxSlot <= minSlot) {
      return { insertIdx: maxSlot, addedMiles: 0 };
    }

    let bestCost = Infinity;
    let bestSlot = maxSlot;
    for (let slot = minSlot; slot <= maxSlot; slot++) {
      const prev = slot > 0 ? stops[slot - 1] : null;
      const next = slot < stops.length ? stops[slot] : null;
      let added = 0;
      if (prev && next) {
        added =
          haversineMiles(prev.lat, prev.lng, newCoords.lat, newCoords.lng) +
          haversineMiles(newCoords.lat, newCoords.lng, next.lat, next.lng) -
          haversineMiles(prev.lat, prev.lng, next.lat, next.lng);
      } else if (prev) {
        added = haversineMiles(prev.lat, prev.lng, newCoords.lat, newCoords.lng);
      } else if (next) {
        added = haversineMiles(newCoords.lat, newCoords.lng, next.lat, next.lng);
      }
      if (added < bestCost) {
        bestCost = added;
        bestSlot = slot;
      }
    }
    return { insertIdx: bestSlot, addedMiles: Math.max(0, bestCost) };
  }

  /**
   * Smart Delimited Text Parser:
   * Auto-detects Pipe (|), Tab (\t), Semicolon (;), or Comma (,)
   * Supports optional Carol Day column & Stop Role (START / END)
   */
  function detectDelimiter(lines) {
    const sampleLines = lines.slice(0, Math.min(8, lines.length));
    const sample = sampleLines.join("\n");
    const counts = {
      "|": (sample.match(/\|/g) || []).length,
      "\t": (sample.match(/\t/g) || []).length,
      ";": (sample.match(/;/g) || []).length,
      ",": (sample.match(/,/g) || []).length
    };
    const minNeeded = Math.max(1, Math.floor(sampleLines.length * 0.6));
    if (counts["|"] >= minNeeded) return "|";
    if (counts["\t"] >= minNeeded) return "\t";
    if (counts[";"] >= minNeeded) return ";";
    return ",";
  }

  function splitCsvLine(line, delim) {
    if (delim !== ",") return line.split(delim).map((p) => p.trim());
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  function normalizeDayKey(rawDay, defaultDayLabel) {
    const s = (rawDay || "").trim();
    if (!s) return defaultDayLabel || "Day 1";
    if (/^\d+$/.test(s)) return `Day ${s}`;
    const m = s.match(/^day\s*(\d+)/i);
    if (m) return `Day ${m[1]}`;
    return s;
  }

  function parseBulkDelimited(rawText, defaultDayLabel) {
    const lines = (rawText || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return { delimiter: "|", rows: [] };

    const delim = detectDelimiter(lines);
    const rows = [];

    lines.forEach((line, idx) => {
      const cols = splitCsvLine(line, delim);
      // Skip header row
      if (
        idx === 0 &&
        /family/i.test(cols[0] || "") &&
        /address/i.test(cols[1] || "")
      ) {
        return;
      }
      const family_name = (cols[0] || "").trim();
      const address = (cols[1] || "").trim();
      if (!family_name && !address) return;

      const dayRaw = cols[2] || "";
      const roleRaw = (cols[3] || "").trim().toUpperCase();
      const extra = cols.slice(4).join(" • ").trim();

      // Extract optional phone number from extra/notes
      const phoneMatch = extra.match(/(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
      const phone = phoneMatch ? phoneMatch[1].trim() : "";
      const notes = phone ? extra.replace(phoneMatch[1], "").replace(/^[\s•,-]+|[\s•,-]+$/g, "") : extra;

      rows.push({
        family_name: family_name || `Family #${rows.length + 1}`,
        address,
        day_label: normalizeDayKey(dayRaw, defaultDayLabel),
        stop_role: roleRaw === "START" || roleRaw === "END" ? roleRaw : null,
        phone,
        notes,
        lat: null,
        lng: null
      });
    });

    return { delimiter: delim, rows };
  }

  function cleanAddressForGeocode(address) {
    return String(address || "")
      .replace(/^(\d+)\s*,\s*/, "$1 ")          // "509, Alucio Ct" -> "509 Alucio Ct"
      .replace(/,\s*(united states|usa)\s*$/i, "")
      .replace(/\s*,\s*/g, ", ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  /**
   * High-accuracy browser-safe Geocoder:
   * 1. ArcGIS World Geocoder (CORS-enabled, rooftop accuracy on new subdivisions)
   * 2. OpenStreetMap Nominatim fallback
   */
  async function geocodeAddress(address) {
    if (!address) return null;
    const cleaned = cleanAddressForGeocode(address);
    const q = /nc|north carolina|\d{5}/i.test(cleaned) ? cleaned : `${cleaned}, Charlotte, NC`;

    // 1. ArcGIS World Geocoder (fast, free single-line lookup, CORS supported)
    try {
      const arcUrl = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=1&SingleLine=${encodeURIComponent(q)}`;
      const resp = await fetch(arcUrl);
      if (resp.ok) {
        const data = await resp.json();
        const best = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
        if (best && best.score >= 75 && best.location) {
          return {
            lat: Number(best.location.y.toFixed(6)),
            lng: Number(best.location.x.toFixed(6))
          };
        }
      }
    } catch (e) {}

    // 2. Nominatim fallback
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
          return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        }
      }
    } catch (e) {}

    return null;
  }

  async function fetchOsrmLeg(fromCoords, toCoords, mode = "afternoon") {
    const profile = getTrafficProfile(mode);
    const straightMi = haversineMiles(fromCoords.lat, fromCoords.lng, toCoords.lat, toCoords.lng);
    if (straightMi <= 0.22) {
      const walkMins = Math.max(2, Math.round(straightMi * 20));
      return { drive_mins: walkMins, distance_label: `${walkMins} min walk (${straightMi.toFixed(2)} mi)` };
    }
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${fromCoords.lng},${fromCoords.lat};${toCoords.lng},${toCoords.lat}?overview=false`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (data.routes && data.routes[0]) {
          const mi = data.routes[0].distance / 1609.344;
          const freeFlowMins = data.routes[0].duration / 60;
          if (mi <= 0.25) {
            const walkMins = Math.max(2, Math.round(mi * 20));
            return { drive_mins: walkMins, distance_label: `${walkMins} min walk (${mi.toFixed(2)} mi)` };
          }
          const trafficMins = Math.max(3, Math.round(freeFlowMins * profile.mult + profile.bufferMins));
          return { drive_mins: trafficMins, distance_label: `${mi.toFixed(1)} mi drive` };
        }
      }
    } catch (e) {}
    const roadMi = straightMi * 1.28;
    const estMins = Math.max(3, Math.round(roadMi * 2.3 * profile.mult + profile.bufferMins));
    return { drive_mins: estMins, distance_label: `~${roadMi.toFixed(1)} mi drive` };
  }

  /**
   * Batch-update driving legs for a sequence of stops using real OSRM road routing
   * adjusted for afternoon ("afternoon") or current time-of-day ("now") traffic.
   */
  async function refreshRouteLegsWithTraffic(stops, mode = "now") {
    const profile = getTrafficProfile(mode);
    if (!Array.isArray(stops) || stops.length < 2) {
      return { stops, profile };
    }

    const allValid = stops.every(hasValidCoords);
    if (allValid) {
      try {
        const coordsStr = stops.map((s) => `${s.lng},${s.lat}`).join(";");
        const url = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=false`;
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          const legs = data.routes && data.routes[0] && data.routes[0].legs;
          if (Array.isArray(legs) && legs.length === stops.length - 1) {
            for (let i = 1; i < stops.length; i++) {
              const leg = legs[i - 1];
              const mi = leg.distance / 1609.344;
              const freeFlowMins = leg.duration / 60;
              if (mi <= 0.25) {
                const walkMins = Math.max(2, Math.round(mi * 20));
                stops[i].drive_mins = walkMins;
                stops[i].distance_label = `${walkMins} min walk (${mi.toFixed(2)} mi)`;
              } else {
                stops[i].drive_mins = Math.max(3, Math.round(freeFlowMins * profile.mult + profile.bufferMins));
                stops[i].distance_label = `${mi.toFixed(1)} mi drive`;
              }
            }
            return { stops, profile };
          }
        }
      } catch (e) {}
    }

    // Fallback: estimate with traffic profile
    const est = recomputeLegEstimates(stops, mode);
    for (let i = 1; i < stops.length; i++) {
      stops[i].drive_mins = est[i].drive_mins;
      stops[i].distance_label = est[i].distance_label;
    }
    return { stops, profile };
  }

  /**
   * Chunked Multi-Stop Google Maps Launcher (splits > 9 stops into sequential legs)
   */
  function buildChunkedGoogleMapsLegs(stops, maxPerLeg = 9) {
    if (!Array.isArray(stops) || stops.length < 2) return [];
    const legs = [];
    let start = 0;
    let legNum = 1;
    while (start < stops.length - 1) {
      const end = Math.min(stops.length - 1, start + maxPerLeg - 1);
      const slice = stops.slice(start, end + 1);
      const url =
        "https://www.google.com/maps/dir/" +
        slice.map((s) => encodeURIComponent(s.address)).join("/");
      legs.push({
        label: `🗺️ Leg ${legNum}: Stops #${start + 1}–#${end + 1}`,
        url
      });
      start = end;
      legNum++;
    }
    return legs;
  }

  return {
    haversineMiles,
    getTrafficProfile,
    optimizeDayHouses,
    recomputeLegEstimates,
    findBestInsertionSlot,
    parseBulkDelimited,
    geocodeAddress,
    fetchOsrmLeg,
    refreshRouteLegsWithTraffic,
    buildChunkedGoogleMapsLegs
  };
})();
