/* Ward 4 (Kunjachan Ward) Christmas Carol PWA — Main Application Logic */

const STORAGE_KEY = "ward4_carol_2026_pwa_v1";

// Register real Service Worker for offline-first PWA support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!sessionStorage.getItem("ward4_install_dismissed")) {
    const banner = document.getElementById("install-banner");
    if (banner) banner.classList.add("visible");
  }
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  const banner = document.getElementById("install-banner");
  if (banner) banner.classList.remove("visible");
  showToast("App installed on your Home Screen!");
});

function triggerInstallPrompt() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(() => {
      deferredInstallPrompt = null;
      document.getElementById("install-banner").classList.remove("visible");
    });
  } else {
    openInstallHelpModal();
  }
}

function dismissInstallBanner() {
  sessionStorage.setItem("ward4_install_dismissed", "1");
  document.getElementById("install-banner").classList.remove("visible");
}

function openInstallHelpModal() {
  document.getElementById("install-help-modal").classList.add("open");
}

// ---------- State Management ----------

function buildDefaultDayState(dayKey) {
  const cfg = window.CAROL_DATA.days[dayKey];
  return {
    startTime: cfg.defaultStartTime,
    defaultVisitMins: cfg.defaultVisitMins,
    lockedFinalId: cfg.lockedFinalId,
    stops: cfg.stops.map((s) => ({
      ...s,
      visited: false,
      checkedInAt: null
    }))
  };
}

function getDefaultActiveDay() {
  const now = new Date();
  // Automatically switch to Day 2 after Dec 13, 2026
  const day2Switch = new Date(2026, 11, 13);
  return now >= day2Switch ? "day2" : "day1";
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.days && parsed.days.day1 && parsed.days.day2) {
        return parsed;
      }
    }
  } catch (e) {}
  return {
    activeDay: getDefaultActiveDay(),
    primaryNavApp: "google",
    largePrint: false,
    coordName: "",
    coordPhone: "",
    songs: JSON.parse(JSON.stringify(window.CAROL_DATA.defaultSongs)),
    days: {
      day1: buildDefaultDayState("day1"),
      day2: buildDefaultDayState("day2")
    }
  };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}
}

let state = loadState();
let snapshotOpen = false;
let activeSongIdx = 0;
let songFontScale = 1.08;
let searchQuery = "";
let wakeLockSentinel = null;
let gpsWatchId = null;
let userCoords = null;

function currentDayMeta() {
  return window.CAROL_DATA.days[state.activeDay];
}

function currentDayState() {
  return state.days[state.activeDay];
}

// ---------- Day Switching ----------

function switchDay(dayKey) {
  if (!state.days[dayKey]) return;
  state.activeDay = dayKey;
  searchQuery = "";
  const searchEl = document.getElementById("search-input");
  if (searchEl) searchEl.value = "";
  document.getElementById("search-clear").classList.remove("visible");
  saveState();
  render();
  showToast(`Switched to ${window.CAROL_DATA.days[dayKey].shortLabel} (${window.CAROL_DATA.days[dayKey].dateLabel})`);
}

// ---------- UI Toggles ----------

function toggleSnapshot() {
  snapshotOpen = !snapshotOpen;
  document.getElementById("snapshot-bar").classList.toggle("expanded", snapshotOpen);
  document.getElementById("snapshot-toggle-btn").setAttribute("aria-expanded", String(snapshotOpen));
  document.getElementById("snapshot-chevron").textContent = snapshotOpen ? "Hide Map ▴" : "Show Map ▾";
}

function applyLargePrintClass() {
  document.documentElement.classList.toggle("large-print", !!state.largePrint);
  document.getElementById("btn-large-print").classList.toggle("active-toggle", !!state.largePrint);
}

function toggleLargePrint() {
  state.largePrint = !state.largePrint;
  applyLargePrintClass();
  saveState();
  showToast(state.largePrint ? "Large Print Driver Mode ON" : "Standard Print Size");
}

async function toggleWakeLock() {
  const btn = document.getElementById("btn-wakelock");
  if (!("wakeLock" in navigator)) {
    showToast("Keep-Awake not supported in this browser");
    return;
  }
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch (e) {}
    wakeLockSentinel = null;
    btn.classList.remove("active-toggle");
    showToast("Screen Keep-Awake OFF");
  } else {
    try {
      wakeLockSentinel = await navigator.wakeLock.request("screen");
      btn.classList.add("active-toggle");
      showToast("Screen will stay awake while open ☀️");
      wakeLockSentinel.addEventListener("release", () => {
        wakeLockSentinel = null;
        btn.classList.remove("active-toggle");
      });
    } catch (e) {
      showToast("Could not enable Keep-Awake");
    }
  }
}

// ---------- GPS "Near Me" Helper ----------

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toggleGpsTracking() {
  const btn = document.getElementById("btn-gps");
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
    userCoords = null;
    btn.classList.remove("gps-active");
    btn.textContent = "📍 Near Me";
    render();
    showToast("Location distance OFF");
    return;
  }
  if (!("geolocation" in navigator)) {
    showToast("GPS not available on this device");
    return;
  }
  btn.textContent = "📍 Locating...";
  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      btn.classList.add("gps-active");
      btn.textContent = "📍 GPS ON";
      render();
    },
    () => {
      gpsWatchId = null;
      userCoords = null;
      btn.classList.remove("gps-active");
      btn.textContent = "📍 Near Me";
      showToast("Location permission denied");
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 }
  );
}

// ---------- Schedule Calculation ----------

function enforceFinalHostLock(daySt) {
  const idx = daySt.stops.findIndex((s) => s.id === daySt.lockedFinalId);
  if (idx !== -1 && idx !== daySt.stops.length - 1) {
    const [locked] = daySt.stops.splice(idx, 1);
    daySt.stops.push(locked);
  } else if (idx === -1 && daySt.stops.length > 0) {
    daySt.lockedFinalId = daySt.stops[daySt.stops.length - 1].id;
  }
}

function timeStrToMinutes(hhmm) {
  const [h, m] = (hhmm || "14:00").split(":").map(Number);
  return h * 60 + (m || 0);
}

function minutesToTimeStr(totalMins) {
  const wrapped = ((Math.round(totalMins) % 1440) + 1440) % 1440;
  const h24 = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  const period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function calculateSchedule(daySt) {
  enforceFinalHostLock(daySt);
  let cursor = timeStrToMinutes(daySt.startTime);
  let totalTravelMins = 0;
  let totalCarolMins = 0;

  const computed = daySt.stops.map((stop, index) => {
    const driveFromPrev = index === 0 ? 0 : Number(stop.driveMins) || 0;
    if (index > 0) {
      cursor += driveFromPrev;
      totalTravelMins += driveFromPrev;
    }
    const arrivalMins = cursor;
    const duration = Number(stop.visitMins) || daySt.defaultVisitMins || 20;
    const departureMins = arrivalMins + duration;
    totalCarolMins += duration;
    cursor = departureMins;

    let distFromUser = null;
    if (userCoords && typeof stop.lat === "number" && typeof stop.lng === "number") {
      distFromUser = haversineMiles(userCoords.lat, userCoords.lng, stop.lat, stop.lng);
    }

    return {
      ...stop,
      index,
      isLast: index === daySt.stops.length - 1,
      driveFromPrev,
      arrivalMins,
      departureMins,
      arrivalFormatted: minutesToTimeStr(arrivalMins),
      departureFormatted: minutesToTimeStr(departureMins),
      duration,
      distFromUser
    };
  });

  return { computed, totalTravelMins, totalCarolMins };
}

function getNavUrls(address, lat, lng) {
  const encoded = encodeURIComponent(address);
  const google = `https://www.google.com/maps/dir/?api=1&destination=${encoded}&travelmode=driving`;
  const apple = `https://maps.apple.com/?daddr=${encoded}&dirflg=d`;
  const waze =
    typeof lat === "number" && typeof lng === "number"
      ? `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`
      : `https://waze.com/ul?q=${encoded}&navigate=yes`;

  if (state.primaryNavApp === "apple") {
    return { primaryUrl: apple, primaryLabel: "Apple Maps", altUrl: google, altLabel: "Google" };
  }
  if (state.primaryNavApp === "waze") {
    return { primaryUrl: waze, primaryLabel: "Waze", altUrl: google, altLabel: "Google" };
  }
  return { primaryUrl: google, primaryLabel: "Google Maps", altUrl: apple, altLabel: "Apple" };
}

function buildMultiStopGoogleMapsLinks(computed) {
  if (computed.length < 2) return "";
  // Google Maps supports up to ~9-10 stops reliably per URL; split into 2 legs
  const splitIdx = Math.min(8, Math.ceil(computed.length / 2));
  const leg1 = computed.slice(0, splitIdx + 1);
  const leg2 = computed.slice(splitIdx);

  const toUrl = (arr) =>
    "https://www.google.com/maps/dir/" +
    arr.map((s) => encodeURIComponent(s.address)).join("/");

  return `
    <a class="map-leg-btn" href="${toUrl(leg1)}" target="_blank" rel="noopener">
      🗺️ Google Maps: #1–#${leg1[leg1.length - 1].index + 1}
    </a>
    <a class="map-leg-btn" href="${toUrl(leg2)}" target="_blank" rel="noopener">
      🗺️ Google Maps: #${leg2[0].index + 1}–#${leg2[leg2.length - 1].index + 1}
    </a>
  `;
}

// ---------- Offline Interactive SVG Route Map ----------

function renderOfflineRouteSvg(computed, nextIndex) {
  const pts = computed.filter((s) => typeof s.lat === "number" && typeof s.lng === "number");
  if (pts.length < 2) {
    return `<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:0.82rem;">Custom route loaded — tap Google Maps links below for map view.</div>`;
  }

  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const cosLat = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const W = 360;
  const H = 200;
  const pad = 26;

  const spanLng = Math.max((maxLng - minLng) * cosLat, 0.005);
  const spanLat = Math.max(maxLat - minLat, 0.005);
  const scale = Math.min((W - pad * 2) / spanLng, (H - pad * 2) / spanLat);

  const usedW = spanLng * scale;
  const usedH = spanLat * scale;
  const offX = (W - usedW) / 2;
  const offY = (H - usedH) / 2;

  const project = (lat, lng) => ({
    x: offX + (lng - minLng) * cosLat * scale,
    y: H - (offY + (lat - minLat) * scale)
  });

  const projected = computed.map((s) =>
    typeof s.lat === "number" && typeof s.lng === "number" ? project(s.lat, s.lng) : null
  );

  // Light collision repulsion so walkable-cluster pins remain legible
  const validPts = projected.filter(Boolean);
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < validPts.length; i++) {
      for (let j = i + 1; j < validPts.length; j++) {
        const dx = validPts[j].x - validPts[i].x;
        const dy = validPts[j].y - validPts[i].y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const minDist = 20;
        if (dist < minDist) {
          const push = (minDist - dist) / 2;
          const ux = dx / dist;
          const uy = dy / dist;
          validPts[i].x = Math.max(14, Math.min(W - 14, validPts[i].x - ux * push));
          validPts[i].y = Math.max(14, Math.min(H - 14, validPts[i].y - uy * push));
          validPts[j].x = Math.max(14, Math.min(W - 14, validPts[j].x + ux * push));
          validPts[j].y = Math.max(14, Math.min(H - 14, validPts[j].y + uy * push));
        }
      }
    }
  }

  // Route segments
  let linesSvg = "";
  for (let i = 1; i < computed.length; i++) {
    const p1 = projected[i - 1];
    const p2 = projected[i];
    if (!p1 || !p2) continue;
    const isWalk = (computed[i].distance || "").toLowerCase().includes("walk");
    const isDone = computed[i - 1].visited && computed[i].visited;
    const stroke = isDone ? "#34d399" : isWalk ? "#c084fc" : "#475569";
    const dash = isWalk ? 'stroke-dasharray="4 3"' : "";
    linesSvg += `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${stroke}" stroke-width="${isDone ? 2.6 : 2}" ${dash} />`;
  }

  // Pins
  let pinsSvg = "";
  computed.forEach((s, idx) => {
    const p = projected[idx];
    if (!p) return;
    const isCurrent = idx === nextIndex;
    const fill = s.visited
      ? "#065f46"
      : isCurrent
      ? "#fbbf24"
      : s.isLast
      ? "#991b1b"
      : "#1b2028";
    const stroke = s.visited
      ? "#34d399"
      : isCurrent
      ? "#ffffff"
      : s.isLast
      ? "#f87171"
      : "#94a3b8";
    const textFill = isCurrent ? "#000000" : "#ffffff";
    const r = isCurrent ? 11.5 : 9.5;

    pinsSvg += `
      <g style="cursor:pointer;" onclick="jumpToStop('${s.id}')">
        ${isCurrent ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="16" fill="rgba(251,191,36,0.22)" />` : ""}
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.8" />
        <text x="${p.x.toFixed(1)}" y="${(p.y + 3.4).toFixed(1)}" text-anchor="middle" fill="${textFill}" font-size="9.5" font-weight="900" font-family="sans-serif">${idx + 1}</text>
      </g>
    `;
  });

  return `
    <svg viewBox="0 0 ${W} ${H}" style="display:block;width:100%;height:auto;max-height:220px;" role="img" aria-label="Offline route map">
      <text x="10" y="16" fill="#475569" font-size="9" font-weight="800" font-family="sans-serif">N ↑</text>
      ${linesSvg}
      ${pinsSvg}
    </svg>
  `;
}

function jumpToStop(stopId) {
  const el = document.getElementById(`card-${stopId}`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("highlight-pulse");
    void el.offsetWidth;
    el.classList.add("highlight-pulse");
  } else {
    showToast("That house is already checked in ✓");
  }
}

// ---------- Search ----------

function handleSearchInput(val) {
  searchQuery = (val || "").trim().toLowerCase();
  document.getElementById("search-clear").classList.toggle("visible", searchQuery.length > 0);
  render();
}

function clearSearch() {
  searchQuery = "";
  document.getElementById("search-input").value = "";
  document.getElementById("search-clear").classList.remove("visible");
  render();
}

// ---------- Main Render ----------

function render() {
  applyLargePrintClass();
  const meta = currentDayMeta();
  const daySt = currentDayState();
  const { computed, totalTravelMins, totalCarolMins } = calculateSchedule(daySt);

  // Update Day Switcher Tabs
  ["day1", "day2"].forEach((k) => {
    const isAct = state.activeDay === k;
    const tab = document.getElementById(`tab-${k}`);
    tab.classList.toggle("active", isAct);
    tab.setAttribute("aria-selected", String(isAct));
    const st = state.days[k];
    const doneCnt = st.stops.filter((s) => s.visited).length;
    const sub = document.getElementById(`tab-${k}-sub`);
    sub.textContent =
      doneCnt > 0
        ? `${doneCnt}/${st.stops.length} Done • ${minutesToTimeStr(timeStrToMinutes(st.startTime))}`
        : `${minutesToTimeStr(timeStrToMinutes(st.startTime))} • ${st.stops.length} Houses`;
  });

  const completedStops = computed.filter((s) => s.visited);
  const upcomingStops = computed.filter((s) => !s.visited);
  const nextStop = upcomingStops[0] || null;
  const finalStop = computed[computed.length - 1];

  // Header & Metrics
  document.getElementById("header-subtitle").textContent =
    `${meta.shortLabel} (${meta.dateLabel}) • Gather ${minutesToTimeStr(timeStrToMinutes(daySt.startTime))} • ${daySt.defaultVisitMins}m/house`;
  document.getElementById("metric-progress").textContent = `${completedStops.length} / ${computed.length}`;
  document.getElementById("metric-dinner-eta").textContent = finalStop ? finalStop.arrivalFormatted : "--:--";
  document.getElementById("metric-ratios").textContent = `${totalTravelMins}m / ${totalCarolMins}m`;

  const pct = computed.length ? (completedStops.length / computed.length) * 100 : 0;
  document.getElementById("progress-fill").style.width = `${pct}%`;

  // Snapshot Drawer
  const nextIndex = nextStop ? nextStop.index : -1;
  document.getElementById("snapshot-miles-label").textContent = `• ${meta.totalMiles} (${computed.length} stops)`;
  document.getElementById("route-svg-container").innerHTML = renderOfflineRouteSvg(computed, nextIndex);
  document.getElementById("snapshot-meta").innerHTML = `<strong>${meta.shortLabel} Route:</strong> ${escapeHtml(meta.routeSummary)}`;
  document.getElementById("snapshot-map-links").innerHTML = buildMultiStopGoogleMapsLinks(computed);

  document.getElementById("bead-chain").innerHTML = computed
    .map((s, idx) => {
      const dotClass = s.visited ? "done" : idx === nextIndex ? "current" : s.isLast ? "dinner" : "";
      const lineClass = s.visited ? "done" : "";
      return `
        <div class="bead-item">
          <div class="bead-dot ${dotClass}" onclick="jumpToStop('${s.id}')" title="#${idx + 1} ${escapeHtml(s.family)}">${s.isLast ? "🍽️" : idx + 1}</div>
          ${idx < computed.length - 1 ? `<div class="bead-line ${lineClass}"></div>` : ""}
        </div>
      `;
    })
    .join("");

  // Hero Spotlight
  const heroEl = document.getElementById("hero-spotlight");
  if (nextStop) {
    const nav = getNavUrls(nextStop.address, nextStop.lat, nextStop.lng);
    const isWalk = (nextStop.distance || "").toLowerCase().includes("walk");
    const distHtml =
      nextStop.distFromUser !== null
        ? `<div class="gps-distance-pill">📍 ${nextStop.distFromUser.toFixed(1)} mi from your location</div>`
        : "";

    heroEl.innerHTML = `
      <section class="hero-card">
        <div class="hero-eyebrow">
          <span class="hero-tag">🎯 Next Stop • #${nextStop.index + 1} of ${computed.length}</span>
          <span class="hero-eta">${nextStop.arrivalFormatted} – ${nextStop.departureFormatted}</span>
        </div>
        <div class="hero-family">${escapeHtml(nextStop.family)}</div>
        <div class="hero-address" onclick="copyAddress('${escapeJs(nextStop.address)}')" title="Tap to copy address">
          📍 ${escapeHtml(nextStop.address)}
        </div>
        ${distHtml}
        ${nextStop.notes ? `<div class="hero-notes">${escapeHtml(nextStop.notes)}</div>` : ""}
        <div class="hero-actions">
          <a class="btn-car btn-go-primary" href="${nav.primaryUrl}" target="_blank" rel="noopener">
            ${isWalk ? "🚶 Walk" : "🧭 GO"} (${nav.primaryLabel.split(" ")[0]})
          </a>
          <a class="btn-car btn-go-alt" href="${nav.altUrl}" target="_blank" rel="noopener">
            ${nav.altLabel}
          </a>
          <button class="btn-car btn-checkin-hero" onclick="toggleVisited('${nextStop.id}')">
            ✓ Arrived
          </button>
        </div>
      </section>
    `;
  } else {
    heroEl.innerHTML = `
      <section class="hero-card" style="border-color: var(--accent-mint); background: #051b14;">
        <div class="hero-family" style="color: var(--accent-mint);">🎉 Ward 4 ${meta.shortLabel} Complete!</div>
        <div class="hero-address">Merry Christmas! Enjoy dinner at ${escapeHtml(finalStop ? finalStop.family : "the host")}'s home.</div>
      </section>
    `;
  }

  // Filter by search query if active
  const matchesQuery = (s) =>
    !searchQuery ||
    s.family.toLowerCase().includes(searchQuery) ||
    s.address.toLowerCase().includes(searchQuery) ||
    (s.notes || "").toLowerCase().includes(searchQuery) ||
    `#${s.index + 1}`.includes(searchQuery);

  const filteredCompleted = completedStops.filter(matchesQuery);
  const filteredUpcoming = upcomingStops.filter(matchesQuery);

  // Completed Section
  const completedEl = document.getElementById("completed-section");
  if (filteredCompleted.length > 0) {
    completedEl.innerHTML = `
      <div class="section-heading">Completed (${filteredCompleted.length})</div>
      ${filteredCompleted
        .map(
          (s) => `
          <div class="stop-card visited-collapsed" id="card-${s.id}">
            <div class="collapsed-info">
              <span class="collapsed-check">✓</span>
              <span class="collapsed-title">#${s.index + 1} ${escapeHtml(s.family)} (${s.checkedInAt || "Done"})</span>
            </div>
            <button class="collapsed-undo" onclick="toggleVisited('${s.id}')">Undo</button>
          </div>
        `
        )
        .join("")}
    `;
  } else {
    completedEl.innerHTML = "";
  }

  // Upcoming Section
  const upcomingEl = document.getElementById("upcoming-section");
  if (filteredUpcoming.length > 0) {
    upcomingEl.innerHTML = `
      <div class="section-heading">${searchQuery ? "Matching Houses" : `Remaining ${meta.shortLabel} Schedule`} (${filteredUpcoming.length})</div>
      ${filteredUpcoming
        .map((stop) => {
          const isNext = nextStop && stop.id === nextStop.id;
          const nav = getNavUrls(stop.address, stop.lat, stop.lng);
          const canMoveUp = stop.index > 0 && !stop.isLast;
          const canMoveDown = stop.index < computed.length - 2;
          const isWalk = (stop.distance || "").toLowerCase().includes("walk");

          const connectorHtml =
            stop.index === 0 || searchQuery
              ? ""
              : `
              <div class="drive-connector ${isWalk ? "walk-leg" : ""}">
                <button class="drive-pill" onclick="openLegModal(${stop.index})">
                  ${isWalk ? "🚶" : "🚗"} <strong>${stop.driveFromPrev} min</strong>
                  ${stop.distance ? `<span>(${escapeHtml(stop.distance)})</span>` : ""}
                  <span>✎</span>
                </button>
                <span>Arrive ${stop.arrivalFormatted}</span>
              </div>
            `;

          const distBadge =
            stop.distFromUser !== null
              ? `<span class="badge-dist">${stop.distFromUser.toFixed(1)} mi</span>`
              : "";

          return `
            ${connectorHtml}
            <article class="stop-card ${isNext ? "active-next" : ""} ${stop.isLast ? "final-dinner" : ""}" id="card-${stop.id}">
              <div class="card-top">
                <div class="seq-and-time">
                  <span class="seq-badge">#${stop.index + 1}</span>
                  <span class="time-window">${stop.arrivalFormatted} – ${stop.departureFormatted}</span>
                  ${stop.isLast ? `<span class="badge-dinner">🍽️ Dinner Host</span>` : ""}
                  ${distBadge}
                </div>
                ${
                  stop.isLast || searchQuery
                    ? ""
                    : `
                    <div class="reorder-controls">
                      <button class="move-btn" onclick="moveStop(${stop.index}, -1)" ${canMoveUp ? "" : "disabled"} aria-label="Move up">▲</button>
                      <button class="move-btn" onclick="moveStop(${stop.index}, 1)" ${canMoveDown ? "" : "disabled"} aria-label="Move down">▼</button>
                    </div>
                  `
                }
              </div>
              <div class="family-name">${escapeHtml(stop.family)}</div>
              <div class="address-line" onclick="copyAddress('${escapeJs(stop.address)}')" title="Tap to copy address">
                📍 ${escapeHtml(stop.address)}
              </div>
              ${stop.notes ? `<div class="notes-line">${escapeHtml(stop.notes)}</div>` : ""}
              <div class="card-actions">
                <a class="nav-btn gmaps" href="${nav.primaryUrl}" target="_blank" rel="noopener">🧭 ${nav.primaryLabel.split(" ")[0]}</a>
                <a class="nav-btn" href="${nav.altUrl}" target="_blank" rel="noopener">${nav.altLabel}</a>
                <button class="checkin-btn" onclick="toggleVisited('${stop.id}')">✓ Check In</button>
              </div>
            </article>
          `;
        })
        .join("")}
    `;
  } else if (searchQuery && filteredCompleted.length === 0) {
    upcomingEl.innerHTML = `<div class="empty-search">No house matched "<strong>${escapeHtml(searchQuery)}</strong>" on ${meta.shortLabel}. Try switching to ${state.activeDay === "day1" ? "Day 2" : "Day 1"}!</div>`;
  } else {
    upcomingEl.innerHTML = "";
  }

  // Coordinator Footer
  const callBtn = document.getElementById("footer-call-btn");
  const smsBtn = document.getElementById("footer-sms-btn");
  if (state.coordPhone && state.coordPhone.trim()) {
    const digits = state.coordPhone.replace(/[^\d+]/g, "");
    const label = state.coordName ? state.coordName : "Coordinator";
    callBtn.href = `tel:${digits}`;
    callBtn.textContent = `📞 Call ${label}`;
    callBtn.style.display = "inline-block";
    smsBtn.href = `sms:${digits}`;
    smsBtn.textContent = `💬 Text ${label}`;
    smsBtn.style.display = "inline-block";
  } else {
    callBtn.style.display = "none";
    smsBtn.style.display = "none";
  }
}

// ---------- Actions ----------

function copyAddress(addr) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(addr).then(() => showToast("Address copied to clipboard!"));
  } else {
    showToast(addr);
  }
}

function shareWhatsAppStatus() {
  const meta = currentDayMeta();
  const daySt = currentDayState();
  const { computed } = calculateSchedule(daySt);
  const done = computed.filter((s) => s.visited);
  const next = computed.find((s) => !s.visited);
  const dinner = computed[computed.length - 1];

  let msg = `🎄 Carol ${meta.shortLabel} - Update\n`;
  if (done.length > 0) {
    const lastDone = done[done.length - 1];
    msg += `✅ Completed: #${lastDone.index + 1} ${lastDone.family} (${done.length}/${computed.length})\n`;
  }
  if (next) {
    msg += `🚗 Next Stop: #${next.index + 1} ${next.family} (ETA ${next.arrivalFormatted})\n`;
    msg += `📍 ${next.address}\n`;
  } else {
    msg += `🎉 All houses completed!\n`;
  }
  if (dinner) {
    msg += `🍽️ Final Stop ETA (${dinner.family}): ${dinner.arrivalFormatted}`;
  }

  // Always copy to clipboard first so user can also paste directly into 'Ward 4- Blessed Kunjachan'
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(msg).catch(() => {});
  }

  showToast(`Copied! Select "Ward 4- Blessed Kunjachan" in WhatsApp`);

  // Open WhatsApp with the message pre-filled
  const waUrl = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  window.open(waUrl, "_blank", "noopener");
}

// ---------- Add Unplanned New House (Smart Best Path & Timing) ----------

function openAddHouseModal() {
  const daySt = currentDayState();
  document.getElementById("add-family").value = "";
  document.getElementById("add-address").value = "";
  document.getElementById("add-placement").value = "auto";
  document.getElementById("add-visit-mins").value = daySt.defaultVisitMins || 20;
  document.getElementById("add-notes").value = "";
  document.getElementById("add-house-status").textContent =
    "Smart mode geocodes the address and inserts it where it adds the least extra driving time (before Dinner).";
  const btn = document.getElementById("btn-add-house-submit");
  btn.disabled = false;
  btn.textContent = "Find Best Spot & Add";
  document.getElementById("add-house-modal").classList.add("open");
}

async function geocodeAddressOnline(address) {
  const query = /nc|north carolina/i.test(address) ? address : `${address}, Charlotte, NC`;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (Array.isArray(data) && data.length > 0) {
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }
  return null;
}

async function fetchLegDriveTime(fromCoords, toCoords) {
  // Fallback estimate using straight-line distance if offline/OSRM unavailable
  const straightMi = haversineMiles(fromCoords.lat, fromCoords.lng, toCoords.lat, toCoords.lng);
  if (straightMi <= 0.22) {
    const walkMins = Math.max(2, Math.round(straightMi * 20));
    return { driveMins: walkMins, distance: `${walkMins} min walk (${straightMi.toFixed(2)} mi)` };
  }
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${fromCoords.lng},${fromCoords.lat};${toCoords.lng},${toCoords.lat}?overview=false`;
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      if (data.routes && data.routes[0]) {
        const mi = data.routes[0].distance / 1609.344;
        const mins = Math.max(1, Math.round(data.routes[0].duration / 60));
        if (mi <= 0.25) {
          const walkMins = Math.max(2, Math.round(mi * 20));
          return { driveMins: walkMins, distance: `${walkMins} min walk (${mi.toFixed(2)} mi)` };
        }
        return { driveMins: mins, distance: `${mi.toFixed(1)} mi drive` };
      }
    }
  } catch (e) {}
  const estMi = straightMi * 1.3;
  const estMins = Math.max(2, Math.round(estMi * 2.4));
  return { driveMins: estMins, distance: `~${estMi.toFixed(1)} mi drive` };
}

async function submitNewHouse() {
  const family = document.getElementById("add-family").value.trim();
  const address = document.getElementById("add-address").value.trim();
  const placement = document.getElementById("add-placement").value;
  const visitMins = Math.max(5, parseInt(document.getElementById("add-visit-mins").value, 10) || 20);
  const notesInput = document.getElementById("add-notes").value.trim();
  const statusEl = document.getElementById("add-house-status");
  const btn = document.getElementById("btn-add-house-submit");

  if (!family || !address) {
    statusEl.textContent = "Please enter both Family Name and Street Address.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Calculating route...";
  statusEl.textContent = "Locating address & checking best detour...";

  const daySt = currentDayState();
  enforceFinalHostLock(daySt);

  let coords = null;
  try {
    coords = await geocodeAddressOnline(address);
  } catch (e) {
    coords = null;
  }

  // Determine valid insertion range: only among unvisited stops, never after locked Dinner Host
  const firstUnvisitedIdx = daySt.stops.findIndex((s) => !s.visited);
  const dinnerIdx = daySt.stops.length - 1; // locked final host
  const minInsertIdx = firstUnvisitedIdx === -1 ? dinnerIdx : Math.max(firstUnvisitedIdx, 0);
  const maxInsertIdx = dinnerIdx; // inserting at dinnerIdx places it right BEFORE Dinner Host

  let insertIdx = maxInsertIdx;
  let extraDetourInfo = "";

  if (placement === "next") {
    insertIdx = minInsertIdx;
  } else if (placement === "before-dinner") {
    insertIdx = maxInsertIdx;
  } else if (coords && maxInsertIdx > minInsertIdx) {
    // Smart Auto-Insert: test every valid slot [minInsertIdx .. maxInsertIdx] for minimum added distance
    let bestCost = Infinity;
    let bestSlot = maxInsertIdx;

    for (let slot = minInsertIdx; slot <= maxInsertIdx; slot++) {
      const prev = slot > 0 ? daySt.stops[slot - 1] : null;
      const next = slot < daySt.stops.length ? daySt.stops[slot] : null;

      let addedMiles = 0;
      if (prev && typeof prev.lat === "number" && next && typeof next.lat === "number") {
        const direct = haversineMiles(prev.lat, prev.lng, next.lat, next.lng);
        const viaNew =
          haversineMiles(prev.lat, prev.lng, coords.lat, coords.lng) +
          haversineMiles(coords.lat, coords.lng, next.lat, next.lng);
        addedMiles = viaNew - direct;
      } else if (prev && typeof prev.lat === "number") {
        addedMiles = haversineMiles(prev.lat, prev.lng, coords.lat, coords.lng);
      } else if (next && typeof next.lat === "number") {
        addedMiles = haversineMiles(coords.lat, coords.lng, next.lat, next.lng);
      }

      if (addedMiles < bestCost) {
        bestCost = addedMiles;
        bestSlot = slot;
      }
    }
    insertIdx = bestSlot;
    extraDetourInfo = ` (~+${Math.max(0.1, bestCost * 1.25).toFixed(1)} mi detour)`;
  }

  // Compute driving time & distance for incoming leg (prev -> new) and outgoing leg (new -> next)
  const prevStop = insertIdx > 0 ? daySt.stops[insertIdx - 1] : null;
  const nextStop = insertIdx < daySt.stops.length ? daySt.stops[insertIdx] : null;

  let incomingDriveMins = insertIdx === 0 ? 0 : 6;
  let incomingDistance = insertIdx === 0 ? "Starting House" : "Est. 6 min drive";

  if (coords && prevStop && typeof prevStop.lat === "number") {
    const legIn = await fetchLegDriveTime({ lat: prevStop.lat, lng: prevStop.lng }, coords);
    incomingDriveMins = legIn.driveMins;
    incomingDistance = legIn.distance;
  }

  if (coords && nextStop && typeof nextStop.lat === "number") {
    const legOut = await fetchLegDriveTime(coords, { lat: nextStop.lat, lng: nextStop.lng });
    nextStop.driveMins = legOut.driveMins;
    nextStop.distance = legOut.distance;
  }

  const newStop = {
    id: `added-${Date.now()}`,
    family,
    address,
    driveMins: incomingDriveMins,
    distance: incomingDistance,
    visitMins,
    notes: notesInput ? `✨ Added during carol • ${notesInput}` : "✨ Unplanned house added during carol",
    lat: coords ? coords.lat : undefined,
    lng: coords ? coords.lng : undefined,
    visited: false,
    checkedInAt: null
  };

  daySt.stops.splice(insertIdx, 0, newStop);
  saveState();
  render();
  closeModal("add-house-modal");

  const spotNum = insertIdx + 1;
  showToast(
    coords
      ? `Added ${family} at Stop #${spotNum}${extraDetourInfo}`
      : `Added ${family} at Stop #${spotNum} (offline estimate)`
  );
  setTimeout(() => jumpToStop(newStop.id), 150);
}

function toggleVisited(stopId) {
  const daySt = currentDayState();
  const stop = daySt.stops.find((s) => s.id === stopId);
  if (!stop) return;
  stop.visited = !stop.visited;
  if (stop.visited) {
    const now = new Date();
    stop.checkedInAt = minutesToTimeStr(now.getHours() * 60 + now.getMinutes());
    showToast(`✓ Checked in: ${stop.family}`);
  } else {
    stop.checkedInAt = null;
  }
  saveState();
  render();
}

function shiftScheduleToNow() {
  const daySt = currentDayState();
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const nextIdx = daySt.stops.findIndex((s) => !s.visited);
  if (nextIdx === -1) return showToast("All stops completed!");

  let elapsedBeforeNext = 0;
  for (let i = 0; i < nextIdx; i++) {
    if (i > 0) elapsedBeforeNext += Number(daySt.stops[i].driveMins) || 0;
    elapsedBeforeNext += Number(daySt.stops[i].visitMins) || daySt.defaultVisitMins || 20;
  }
  if (nextIdx > 0) elapsedBeforeNext += Number(daySt.stops[nextIdx].driveMins) || 0;

  const adjustedStart = (((nowMins - elapsedBeforeNext) % 1440) + 1440) % 1440;
  daySt.startTime = `${String(Math.floor(adjustedStart / 60)).padStart(2, "0")}:${String(adjustedStart % 60).padStart(2, "0")}`;
  saveState();
  render();
  showToast(`Shifted live schedule to ${minutesToTimeStr(nowMins)}`);
}

function moveStop(index, delta) {
  const daySt = currentDayState();
  const target = index + delta;
  if (target < 0 || target >= daySt.stops.length - 1) return;
  [daySt.stops[index], daySt.stops[target]] = [daySt.stops[target], daySt.stops[index]];
  saveState();
  render();
}

// ---------- Songbook ----------

function openSongbookModal() {
  renderSongbook();
  document.getElementById("songbook-modal").classList.add("open");
}

function renderSongbook() {
  const songs = state.songs && state.songs.length ? state.songs : window.CAROL_DATA.defaultSongs;
  if (activeSongIdx >= songs.length) activeSongIdx = 0;
  document.getElementById("song-tabs").innerHTML = songs
    .map(
      (s, idx) =>
        `<button class="song-tab ${idx === activeSongIdx ? "active" : ""}" onclick="selectSong(${idx})">${escapeHtml(s.title)}</button>`
    )
    .join("");
  const current = songs[activeSongIdx];
  const box = document.getElementById("song-lyrics-box");
  box.style.fontSize = `${songFontScale}rem`;
  box.textContent = current.lyrics;

  const delBtn = document.getElementById("btn-delete-song");
  if (delBtn) {
    delBtn.style.display = current.lang === "Custom" ? "inline-flex" : "none";
  }
}

function selectSong(idx) {
  activeSongIdx = idx;
  renderSongbook();
}

function adjustSongFont(delta) {
  songFontScale = Math.min(1.65, Math.max(0.85, songFontScale + delta));
  document.getElementById("song-lyrics-box").style.fontSize = `${songFontScale}rem`;
}

function toggleAddSongPanel() {
  document.getElementById("add-song-panel").classList.toggle("open");
}

function deleteCurrentSong() {
  if (!Array.isArray(state.songs) || !state.songs[activeSongIdx]) return;
  const song = state.songs[activeSongIdx];
  if (song.lang !== "Custom") return;
  state.songs.splice(activeSongIdx, 1);
  activeSongIdx = Math.max(0, activeSongIdx - 1);
  saveState();
  renderSongbook();
  showToast(`Removed "${song.title}"`);
}

function cleanExtractedLyrics(rawMarkdown) {
  let title = "";
  const titleMatch = rawMarkdown.match(/^Title:\s*(.+)$/m);
  if (titleMatch) {
    title = titleMatch[1]
      .replace(/\s*[-|–—]\s*MADELY.*$/i, "")
      .replace(/\s*(Malayalam\s*(&|and)\s*Manglish|Malayalam|Manglish|Christian\s+Devotional\s+Song|Song)?\s*Lyrics.*$/i, "")
      .trim();
  }

  // Extract body after "Markdown Content:"
  let body = rawMarkdown;
  const contentIdx = body.indexOf("Markdown Content:");
  if (contentIdx !== -1) {
    body = body.slice(contentIdx + "Markdown Content:".length);
  }

  // Trim trailing boilerplate sections (Media, Related, Comments, Share, etc.)
  const stopMarkers = [
    /\n###\s*Media\b/i,
    /\n###\s*Related\b/i,
    /\n###\s*Comments\b/i,
    /\n###\s*Leave a Reply\b/i,
    /\n###\s*Share\b/i
  ];
  for (const marker of stopMarkers) {
    const m = body.search(marker);
    if (m !== -1) body = body.slice(0, m);
  }

  // Convert emoji images like ![Image 1: 🎵](...) back to their emoji, drop other images
  body = body.replace(/!\[Image\s*\d*:\s*([^\]]+)\]\([^)]+\)/g, "$1");
  body = body.replace(/!\[[^\]]*\]\([^)]+\)/g, "");

  // Remove empty links / toolbar lines like [](https://...)|[](...)|A A A
  body = body.replace(/\[\]\([^)]+\)/g, "");
  body = body.replace(/^[\s|]*A\s+A\s+A\s*$/gm, "");
  body = body.replace(/^\*\*My Notes\*\*\s*$/gim, "");

  // Convert standard markdown links [text](url) -> text
  body = body.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Clean role prefixes like **M**, **F**, **A** at start of lines
  body = body.replace(/^\*\*([MFA])\*\*\s*/gm, "[$1] ");

  // Clean headings and bold/italic markers
  body = body.replace(/^#{1,6}\s*(.+)$/gm, "\n--- $1 ---");
  body = body.replace(/\*\*(.+?)\*\*/g, "$1");
  body = body.replace(/__([^_]+)__/g, "$1");

  // Clean stray pipes, trailing spaces, and excessive blank lines
  body = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\|+\s*$/, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, lyrics: body };
}

async function fetchLyricsFromUrl() {
  const urlInput = document.getElementById("new-song-url");
  const statusEl = document.getElementById("fetch-lyrics-status");
  const btn = document.getElementById("btn-fetch-lyrics");
  let url = (urlInput.value || "").trim();

  if (!url) {
    statusEl.textContent = "Please paste a lyrics webpage URL first.";
    statusEl.style.color = "var(--accent-crimson)";
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
    urlInput.value = url;
  }

  btn.disabled = true;
  btn.textContent = "Fetching...";
  statusEl.style.color = "var(--accent-sky)";
  statusEl.textContent = "Extracting song title & lyrics from webpage...";

  try {
    const resp = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/plain" }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.text();
    const { title, lyrics } = cleanExtractedLyrics(raw);

    if (!lyrics || lyrics.length < 20) {
      throw new Error("Could not detect lyrics text on that page");
    }

    if (title && !document.getElementById("new-song-title").value.trim()) {
      document.getElementById("new-song-title").value = title;
    }
    document.getElementById("new-song-lyrics").value = lyrics;
    statusEl.style.color = "var(--accent-mint)";
    statusEl.textContent = "✓ Lyrics imported! Review below and tap Save to Songbook.";
  } catch (err) {
    statusEl.style.color = "var(--accent-crimson)";
    statusEl.textContent = "Could not fetch that URL automatically (check internet or copy-paste lyrics below).";
  } finally {
    btn.disabled = false;
    btn.textContent = "Fetch";
  }
}

function saveNewSong() {
  const title = document.getElementById("new-song-title").value.trim();
  const lyrics = document.getElementById("new-song-lyrics").value.trim();
  if (!title || !lyrics) {
    showToast("Please enter both title and lyrics");
    return;
  }
  if (!Array.isArray(state.songs)) state.songs = JSON.parse(JSON.stringify(window.CAROL_DATA.defaultSongs));
  state.songs.push({ title, lang: "Custom", lyrics });
  activeSongIdx = state.songs.length - 1;
  saveState();
  document.getElementById("new-song-url").value = "";
  document.getElementById("new-song-title").value = "";
  document.getElementById("new-song-lyrics").value = "";
  document.getElementById("fetch-lyrics-status").textContent =
    "Paste a lyrics webpage link (e.g., madely.us) and tap Fetch to auto-fill Title & Lyrics.";
  document.getElementById("fetch-lyrics-status").style.color = "";
  document.getElementById("add-song-panel").classList.remove("open");
  renderSongbook();
  showToast(`Added "${title}" to Songbook!`);
}

// ---------- Settings Modal ----------

function openSettingsModal() {
  const meta = currentDayMeta();
  const daySt = currentDayState();
  document.getElementById("settings-modal-title").textContent = `⚙️ ${meta.shortLabel} (${meta.dateLabel}) Settings`;
  document.getElementById("cfg-start-time").value = daySt.startTime;
  document.getElementById("cfg-visit-mins").value = daySt.defaultVisitMins;
  document.getElementById("cfg-nav-app").value = state.primaryNavApp || "google";
  document.getElementById("cfg-coord-name").value = state.coordName || "";
  document.getElementById("cfg-coord-phone").value = state.coordPhone || "";
  document.getElementById("cfg-dinner-host").innerHTML = daySt.stops
    .map(
      (s) =>
        `<option value="${s.id}" ${s.id === daySt.lockedFinalId ? "selected" : ""}>${escapeHtml(s.family)}</option>`
    )
    .join("");
  document.getElementById("settings-modal").classList.add("open");
}

function saveSettings() {
  const daySt = currentDayState();
  daySt.startTime = document.getElementById("cfg-start-time").value || currentDayMeta().defaultStartTime;
  const newDefault = Math.max(5, parseInt(document.getElementById("cfg-visit-mins").value, 10) || 20);
  daySt.stops.forEach((s, idx) => {
    if (idx < daySt.stops.length - 1 && s.visitMins === daySt.defaultVisitMins) {
      s.visitMins = newDefault;
    }
  });
  daySt.defaultVisitMins = newDefault;
  daySt.lockedFinalId = document.getElementById("cfg-dinner-host").value;
  state.primaryNavApp = document.getElementById("cfg-nav-app").value;
  state.coordName = document.getElementById("cfg-coord-name").value.trim();
  state.coordPhone = document.getElementById("cfg-coord-phone").value.trim();
  enforceFinalHostLock(daySt);
  saveState();
  render();
  closeModal("settings-modal");
  showToast("Settings saved");
}

function resetProgress() {
  const daySt = currentDayState();
  daySt.stops.forEach((s) => {
    s.visited = false;
    s.checkedInAt = null;
  });
  saveState();
  render();
  closeModal("settings-modal");
  showToast(`${currentDayMeta().shortLabel} check-ins reset`);
}

function restoreDefaultDay() {
  state.days[state.activeDay] = buildDefaultDayState(state.activeDay);
  saveState();
  render();
  closeModal("settings-modal");
  showToast(`${currentDayMeta().shortLabel} official route restored`);
}

// ---------- Import / Edit Stops Modal ----------

function openImportModal() {
  const meta = currentDayMeta();
  const daySt = currentDayState();
  document.getElementById("import-modal-title").textContent = `✏️ Edit ${meta.shortLabel} Stops`;
  document.getElementById("import-textarea").value = daySt.stops
    .map((s) => `${s.family} | ${s.address} | ${s.driveMins} | ${s.distance || ""} | ${s.notes || ""}`)
    .join("\n");
  document.getElementById("import-modal").classList.add("open");
}

function exportToCSV() {
  navigator.clipboard?.writeText(document.getElementById("import-textarea").value);
  showToast("Copied stops list to clipboard");
}

function applyImportedStops() {
  const daySt = currentDayState();
  const raw = document.getElementById("import-textarea").value.trim();
  if (!raw) return;
  try {
    let parsedStops = [];
    if (raw.startsWith("[")) {
      const arr = JSON.parse(raw);
      parsedStops = arr.map((item, i) => ({
        id: `custom-${Date.now()}-${i}`,
        family: item.family || item.familyName || `Family #${i + 1}`,
        address: item.address || "",
        driveMins: Number(item.driveMins ?? (i === 0 ? 0 : 5)),
        distance: item.distance || "",
        visitMins: Number(item.visitMins || (i === arr.length - 1 ? 60 : daySt.defaultVisitMins)),
        notes: item.notes || "",
        lat: item.lat,
        lng: item.lng,
        visited: false,
        checkedInAt: null
      }));
    } else {
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      parsedStops = lines.map((line, i) => {
        const parts = line.split(line.includes("|") ? "|" : ",").map((p) => p.trim());
        const existing = daySt.stops.find((s) => s.family.toLowerCase() === (parts[0] || "").toLowerCase());
        return {
          id: existing ? existing.id : `custom-${Date.now()}-${i}`,
          family: parts[0] || `Family #${i + 1}`,
          address: parts[1] || "",
          driveMins: i === 0 ? 0 : parseInt(parts[2], 10) || 5,
          distance: parts[3] || "",
          visitMins: i === lines.length - 1 ? 60 : daySt.defaultVisitMins,
          notes: parts.slice(4).join(", "),
          lat: existing ? existing.lat : undefined,
          lng: existing ? existing.lng : undefined,
          visited: false,
          checkedInAt: null
        };
      });
    }
    if (!parsedStops.length) throw new Error();
    daySt.stops = parsedStops;
    daySt.lockedFinalId = parsedStops[parsedStops.length - 1].id;
    saveState();
    render();
    closeModal("import-modal");
    showToast(`Loaded ${parsedStops.length} stops!`);
  } catch (e) {
    alert("Format error. Use: Family Name | Address | TravelMins | Distance | Notes");
  }
}

// ---------- Travel Leg Editor ----------

function openLegModal(idx) {
  const daySt = currentDayState();
  const stop = daySt.stops[idx];
  if (!stop) return;
  document.getElementById("leg-stop-index").value = idx;
  document.getElementById("leg-modal-title").textContent = `🚗 Travel to ${stop.family}`;
  document.getElementById("leg-drive-mins").value = stop.driveMins;
  document.getElementById("leg-distance").value = stop.distance || "";
  document.getElementById("leg-visit-mins").value = stop.visitMins || daySt.defaultVisitMins;
  document.getElementById("leg-modal").classList.add("open");
}

function saveLegEdit() {
  const daySt = currentDayState();
  const idx = parseInt(document.getElementById("leg-stop-index").value, 10);
  const stop = daySt.stops[idx];
  if (!stop) return;
  stop.driveMins = Math.max(0, parseInt(document.getElementById("leg-drive-mins").value, 10) || 0);
  stop.distance = document.getElementById("leg-distance").value.trim();
  stop.visitMins = Math.max(5, parseInt(document.getElementById("leg-visit-mins").value, 10) || daySt.defaultVisitMins);
  saveState();
  render();
  closeModal("leg-modal");
  showToast("Stop updated");
}

// ---------- Helpers ----------

function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}
function closeOnBackdrop(e, id) {
  if (e.target.id === id) closeModal(id);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeJs(str) {
  return String(str || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(window._tt);
  window._tt = setTimeout(() => t.classList.remove("show"), 2600);
}

// Initial Render
render();
