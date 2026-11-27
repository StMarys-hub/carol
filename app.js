/* St. Mary's Multi-Ward Christmas Carol PWA (W1–W5)
 * Zero frontend secrets, zero public PII, strict per-ward isolation,
 * Supabase Gatekeeper RPCs + PII-free Realtime + Offline Cache + 4-Tab Admin Portal
 */

// Register Service Worker for /carol/
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

// ---------- Cross-Platform PWA Install (Android Chrome + iPhone Safari) ----------
let deferredInstallPrompt = null;

function isAppAlreadyInstalled() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function updateInstallBarVisibility() {
  const bar = document.getElementById("bottom-install-bar");
  if (!bar) return;
  if (isAppAlreadyInstalled() || sessionStorage.getItem("carol_install_dismissed")) {
    bar.classList.add("hidden");
  } else {
    bar.classList.remove("hidden");
  }
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updateInstallBarVisibility();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  const bar = document.getElementById("bottom-install-bar");
  if (bar) bar.classList.add("hidden");
  showToast("🎉 St. Mary's Carol App installed!");
});

function dismissBottomInstallBar() {
  sessionStorage.setItem("carol_install_dismissed", "1");
  const bar = document.getElementById("bottom-install-bar");
  if (bar) bar.classList.add("hidden");
}

async function handleInstallAppClick() {
  // 1. Android / Desktop Chrome / Edge native 1-tap install prompt
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    try {
      const choice = await deferredInstallPrompt.userChoice;
      if (choice && choice.outcome === "accepted") {
        dismissBottomInstallBar();
      }
    } catch (e) {}
    deferredInstallPrompt = null;
    return;
  }

  // 2. iPhone / iPad (iOS Safari) or fallback manual steps
  const body = document.getElementById("install-guide-body");
  if (isIosDevice()) {
    body.innerHTML = `
      <p style="margin-bottom:10px;">Install on your <strong style="color:var(--accent-gold);">iPhone / iPad</strong> in 3 quick taps:</p>
      <ol style="padding-left:20px; display:flex; flex-direction:column; gap:8px;">
        <li>Open this page in <strong>Safari</strong> (if you opened it inside WhatsApp, tap the Safari compass icon first).</li>
        <li>Tap the <strong>Share</strong> button (<strong>□↑</strong>) at the bottom of Safari.</li>
        <li>Scroll down and tap <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>
      </ol>
    `;
  } else {
    body.innerHTML = `
      <p style="margin-bottom:10px;">Install on <strong style="color:var(--accent-mint);">Android (Chrome)</strong>:</p>
      <ol style="padding-left:20px; display:flex; flex-direction:column; gap:8px; margin-bottom:12px;">
        <li>Tap the <strong>⋮ Menu</strong> in the top-right corner of Chrome.</li>
        <li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
      </ol>
      <p style="margin-bottom:6px;">Install on <strong style="color:var(--accent-gold);">iPhone (Safari)</strong>:</p>
      <p>Tap <strong>Share (□↑)</strong> → <strong>Add to Home Screen</strong> → <strong>Add</strong>.</p>
    `;
  }
  document.getElementById("install-guide-modal").classList.add("open");
}

// ---------- Global App State ----------
const CFG = window.CAROL_APP_CONFIG;
let sbClient = null;
let realtimeChannel = null;

let activeWardId = resolveInitialWard();
let wardPayload = null;        // Unlocked data for activeWardId
let activeDayId = null;
let lastSyncedAt = null;
let adminSession = { unlocked: false, code: "", role: null, wardId: null };
let parsedImportRows = [];
let optimizerDraft = [];

let prefs = loadPrefs();
let snapshotOpen = false;
let searchQuery = "";
let gpsWatchId = null;
let userCoords = null;
let wakeLockSentinel = null;

// 20-Min House Countdown Timer (Wall-Clock Timestamp Based — Works When Locked/Minimized)
let houseTimer = {
  stopId: null,
  durationMins: 20,
  remainingSec: 20 * 60,
  endTimeMs: null,
  running: false,
  intervalId: null,
  warned3Min: false,
  finished: false
};

function keyHouseTimer(wardId) {
  return `carol_timer_${wardId}`;
}

function saveHouseTimerState() {
  try {
    localStorage.setItem(
      keyHouseTimer(activeWardId),
      JSON.stringify({
        stopId: houseTimer.stopId,
        durationMins: houseTimer.durationMins,
        remainingSec: houseTimer.remainingSec,
        endTimeMs: houseTimer.endTimeMs,
        running: houseTimer.running,
        warned3Min: houseTimer.warned3Min,
        finished: houseTimer.finished
      })
    );
  } catch (e) {}
}

function loadHouseTimerState(stopId, durationMins) {
  try {
    const raw = localStorage.getItem(keyHouseTimer(activeWardId));
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && saved.stopId === stopId) {
        houseTimer.stopId = saved.stopId;
        houseTimer.durationMins = saved.durationMins || durationMins || 20;
        houseTimer.endTimeMs = saved.endTimeMs || null;
        houseTimer.running = !!saved.running;
        houseTimer.warned3Min = !!saved.warned3Min;
        houseTimer.finished = !!saved.finished;
        houseTimer.remainingSec = saved.running && saved.endTimeMs
          ? Math.max(0, Math.ceil((saved.endTimeMs - Date.now()) / 1000))
          : (saved.remainingSec ?? (durationMins || 20) * 60);
        if (houseTimer.running) {
          startTimerLoop();
        }
        return true;
      }
    }
  } catch (e) {}
  return false;
}

// ---------- Ward Routing & Namespaced Storage ----------

function resolveInitialWard() {
  const params = new URLSearchParams(window.location.search);
  const qWard = (params.get("ward") || "").trim().toUpperCase();
  if (CFG.WARDS[qWard]) {
    localStorage.setItem("carol_active_ward", qWard);
    return qWard;
  }
  const saved = (localStorage.getItem("carol_active_ward") || "W4").toUpperCase();
  return CFG.WARDS[saved] ? saved : "W4";
}

function keyUserCode(wardId) {
  return `carol_user_code_${wardId}`;
}
function keyOfflineRoute(wardId) {
  return `carol_offline_route_${wardId}`;
}
function keyLocalSongs(wardId) {
  return `carol_local_songs_${wardId}`;
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem("carol_ui_prefs");
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    primaryNavApp: "google",
    largePrint: false,
    lightTheme: false,
    autoWakeLock: true
  };
}
function savePrefs() {
  try {
    localStorage.setItem("carol_ui_prefs", JSON.stringify(prefs));
  } catch (e) {}
}

function initSupabaseClient() {
  const { url, anonKey } = window.getSupabaseCredentials();
  if (url && anonKey && window.supabase && window.supabase.createClient) {
    sbClient = window.supabase.createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    return true;
  }
  sbClient = null;
  return false;
}

function switchWard(newWardId) {
  const w = (newWardId || "W4").toUpperCase();
  if (!CFG.WARDS[w]) return;
  activeWardId = w;
  localStorage.setItem("carol_active_ward", w);

  // Update URL cleanly via history.replaceState without reloading
  const url = new URL(window.location.href);
  url.searchParams.set("ward", w);
  window.history.replaceState({}, "", url.toString());

  // Reset ward-scoped runtime state & admin lock
  if (adminSession.wardId !== w) {
    adminSession = { unlocked: false, code: "", role: null, wardId: null };
  }
  wardPayload = null;
  activeDayId = null;
  searchQuery = "";
  const searchEl = document.getElementById("search-input");
  if (searchEl) searchEl.value = "";
  unsubscribeRealtime();
  bootActiveWard();
}

// ---------- Boot, Lock Screen & Offline Resilience ----------

async function bootActiveWard() {
  applyUiPrefs();
  updateWardHeaderLabels();
  initSupabaseClient();

  const cachedCode = localStorage.getItem(keyUserCode(activeWardId));
  const cachedRouteRaw = localStorage.getItem(keyOfflineRoute(activeWardId));

  if (!cachedCode) {
    showLockScreen("");
    return;
  }

  // If cached route exists, render immediately for instant field startup, then silently revalidate online
  if (cachedRouteRaw) {
    try {
      const cached = JSON.parse(cachedRouteRaw);
      if (cached && cached.ward_id === activeWardId) {
        wardPayload = cached;
        selectDefaultDay();
        showDashboard();
      }
    } catch (e) {}
  }

  await syncActiveWardOnline(true);
}

async function syncActiveWardOnline(silent = false) {
  const cachedCode = localStorage.getItem(keyUserCode(activeWardId));
  if (!cachedCode) return;

  if (!sbClient) {
    setOfflineBanner(true);
    if (!wardPayload) showLockScreen("Connect Supabase in ⚙️ Settings to unlock this ward.");
    return;
  }

  try {
    const { data, error } = await sbClient.rpc("get_ward_carol_data", {
      p_ward_id: activeWardId,
      p_user_code: cachedCode
    });

    if (error) throw error;

    if (!data || !data.ok) {
      const errCode = data ? data.error : "UNKNOWN_ERROR";
      if (errCode === "INVALID_WARD_CODE") {
        // Admin reset the Ward Access Code — instant revocation!
        localStorage.removeItem(keyUserCode(activeWardId));
        localStorage.removeItem(keyOfflineRoute(activeWardId));
        wardPayload = null;
        unsubscribeRealtime();
        showLockScreen("Your Ward Access Code was updated by the Ward Admin. Please enter the new code.");
        return;
      }
      if (errCode === "RATE_LIMITED") {
        showLockScreen("Too many attempts. Please wait 15 minutes and try again.");
        return;
      }
      throw new Error(errCode);
    }

    setOfflineBanner(false);
    lastSyncedAt = new Date();
    wardPayload = data;
    localStorage.setItem(keyOfflineRoute(activeWardId), JSON.stringify(data));
    selectDefaultDay();
    showDashboard();
    subscribeRealtime();
    ensureActiveDayRealRoadLegs();
    if (!silent) showToast(`Synced ${CFG.WARDS[activeWardId].short} live schedule`);
  } catch (err) {
    // Offline between houses: continue serving already-unlocked cached route seamlessly
    if (wardPayload) {
      setOfflineBanner(true);
      if (!silent) showToast("Offline — using saved route");
    } else {
      showLockScreen("Unable to reach server. Check internet connection or Supabase settings.");
    }
  }
}

async function handleUnlockSubmit(e) {
  e.preventDefault();
  const input = document.getElementById("ward-code-input");
  const errEl = document.getElementById("lock-error");
  const btn = document.getElementById("btn-unlock-submit");
  const code = (input.value || "").trim();

  if (!code) {
    errEl.textContent = "Please enter your Ward Access Code.";
    return;
  }
  if (!initSupabaseClient()) {
    errEl.textContent = "Please connect Supabase in ⚙️ Settings first.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Verifying...";
  errEl.textContent = "";

  try {
    const { data, error } = await sbClient.rpc("get_ward_carol_data", {
      p_ward_id: activeWardId,
      p_user_code: code
    });
    if (error) throw error;

    if (!data || !data.ok) {
      errEl.textContent =
        data && data.error === "RATE_LIMITED"
          ? "Too many invalid tries. Please wait 15 minutes."
          : "Invalid Ward Access Code. Please check with your Ward Coordinator.";
      return;
    }

    localStorage.setItem(keyUserCode(activeWardId), code);
    localStorage.setItem(keyOfflineRoute(activeWardId), JSON.stringify(data));
    input.value = "";
    wardPayload = data;
    setOfflineBanner(false);
    selectDefaultDay();
    showDashboard();
    subscribeRealtime();
    showToast(`Unlocked ${CFG.WARDS[activeWardId].full}!`);
  } catch (err) {
    errEl.textContent = "Connection error. Check Supabase URL/Key or internet.";
  } finally {
    btn.disabled = false;
    btn.textContent = "🔓 Unlock Ward Schedule";
  }
}

function lockCurrentWard() {
  localStorage.removeItem(keyUserCode(activeWardId));
  localStorage.removeItem(keyOfflineRoute(activeWardId));
  wardPayload = null;
  adminSession = { unlocked: false, code: "", role: null, wardId: null };
  unsubscribeRealtime();
  closeModal("settings-modal");
  showLockScreen("");
  showToast(`${CFG.WARDS[activeWardId].short} locked`);
}

function showLockScreen(msg) {
  document.getElementById("lock-screen-view").style.display = "block";
  document.getElementById("dashboard-view").style.display = "none";
  document.getElementById("unlocked-header-stats").style.display = "none";
  document.getElementById("ward-instructions-banner").classList.remove("visible");
  document.getElementById("lock-error").textContent = msg || "";
  setOfflineBanner(false);
  updateWardHeaderLabels();
}

function showDashboard() {
  document.getElementById("lock-screen-view").style.display = "none";
  document.getElementById("dashboard-view").style.display = "block";
  document.getElementById("unlocked-header-stats").style.display = "block";
  acquireWakeLockIfEnabled();
  render();
}

function setOfflineBanner(isOffline) {
  const el = document.getElementById("offline-banner");
  if (el) el.classList.toggle("visible", !!isOffline);
}

// ---------- PII-Free Supabase Realtime Sync ----------

function subscribeRealtime() {
  if (!sbClient) return;
  unsubscribeRealtime();
  realtimeChannel = sbClient
    .channel(`carol-live-${activeWardId}`)
    .on("broadcast", { event: "eta_shift" }, (payload) => {
      // Strictly PII-free payload: { ward_id, carol_day_id, current_stop_index, actual_timestamp }
      const p = payload && payload.payload;
      if (!p || p.ward_id !== activeWardId) return;
      syncActiveWardOnline(true);
    })
    .on("broadcast", { event: "broadcast_alert" }, (payload) => {
      const p = payload && payload.payload;
      if (!p || p.ward_id !== activeWardId || !p.message) return;
      showLiveBroadcastPopup(p.message, p.sent_at);
      if (p.pinned && wardPayload && wardPayload.ward_settings) {
        wardPayload.ward_settings.instructions_banner = p.message;
        render();
      }
    })
    .on("broadcast", { event: "songs_updated" }, async (payload) => {
      const p = payload && payload.payload;
      if (!p || p.ward_id !== activeWardId) return;
      await syncActiveWardOnline(true);
      if (document.getElementById("songbook-modal").classList.contains("open")) {
        renderCurrentSongbook();
      }
      showToast("🎵 Ward Songbook updated!");
    })
    .on("broadcast", { event: "song_submitted" }, (payload) => {
      const p = payload && payload.payload;
      if (!p || p.ward_id !== activeWardId) return;
      if (adminSession.unlocked && adminSession.wardId === activeWardId) {
        loadPendingSongs();
        showToast(`🎵 New song pending approval: "${p.title || "Song"}"`);
      }
    })
    .subscribe();
}

function unsubscribeRealtime() {
  if (realtimeChannel && sbClient) {
    try {
      sbClient.removeChannel(realtimeChannel);
    } catch (e) {}
    realtimeChannel = null;
  }
}

function broadcastPiiFreeEtaShift(carolDayId, currentStopIndex, actualTimestamp) {
  if (!realtimeChannel) return;
  realtimeChannel.send({
    type: "broadcast",
    event: "eta_shift",
    payload: {
      ward_id: activeWardId,
      carol_day_id: carolDayId,
      current_stop_index: currentStopIndex,
      actual_timestamp: actualTimestamp || new Date().toISOString()
    }
  });
}

// ---------- Screen Wake Lock ----------

async function acquireWakeLockIfEnabled() {
  if (!prefs.autoWakeLock || !("wakeLock" in navigator) || wakeLockSentinel) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    wakeLockSentinel.addEventListener("release", () => {
      wakeLockSentinel = null;
    });
  } catch (e) {}
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    releaseWakeLock();
  } else {
    if (wardPayload) acquireWakeLockIfEnabled();
    syncHouseTimerFromClock();
  }
});

window.addEventListener("focus", () => {
  syncHouseTimerFromClock();
});

// ---------- Theme & Display Preferences ----------

function applyUiPrefs() {
  document.documentElement.classList.toggle("large-print", !!prefs.largePrint);
  document.documentElement.classList.toggle("light-theme", !!prefs.lightTheme);

  const lpBtn = document.getElementById("btn-large-print");
  if (lpBtn) lpBtn.classList.toggle("active-toggle", !!prefs.largePrint);

  const themeBtn = document.getElementById("btn-theme");
  if (themeBtn) themeBtn.textContent = prefs.lightTheme ? "☀️" : "🌙";

  const isAdmin = adminSession.unlocked && adminSession.wardId === activeWardId;
  const adminBtn = document.getElementById("btn-admin-open");
  if (adminBtn) adminBtn.classList.toggle("admin-unlocked", isAdmin);

  const roleBadge = document.getElementById("role-mode-badge");
  if (roleBadge) {
    roleBadge.style.display = isAdmin ? "inline-flex" : "none";
    roleBadge.className = "sync-badge coord";
  }

  const bcBtn = document.getElementById("btn-broadcast-live");
  const fullBtn = document.getElementById("btn-copy-full-day");
  if (bcBtn && fullBtn) {
    bcBtn.style.display = isAdmin ? "flex" : "none";
    fullBtn.style.display = isAdmin ? "none" : "flex";
  }

  const syncEl = document.getElementById("sync-status-badge");
  if (syncEl) {
    const isOff = document.getElementById("offline-banner")?.classList.contains("visible");
    if (isOff) {
      syncEl.textContent = "📡 Offline (Saved Route)";
      syncEl.className = "sync-badge";
    } else if (lastSyncedAt) {
      const t = minutesToTimeStr(lastSyncedAt.getHours() * 60 + lastSyncedAt.getMinutes());
      syncEl.textContent = `🟢 Synced ${t}`;
      syncEl.className = "sync-badge live";
    } else {
      syncEl.textContent = "🟢 Live";
      syncEl.className = "sync-badge live";
    }
  }
}

function toggleLargePrint() {
  prefs.largePrint = !prefs.largePrint;
  savePrefs();
  applyUiPrefs();
  showToast(prefs.largePrint ? "Large Print Mode ON" : "Standard Print Size");
}

function toggleTheme() {
  prefs.lightTheme = !prefs.lightTheme;
  savePrefs();
  applyUiPrefs();
  if (wardPayload) render();
  showToast(prefs.lightTheme ? "Daytime Snow Theme ON ☀️" : "Midnight Evergreen Night Theme 🌙");
}

function updateWardHeaderLabels() {
  const w = CFG.WARDS[activeWardId];
  const sel = document.getElementById("ward-switcher");
  if (sel) sel.value = activeWardId;
  document.getElementById("header-ward-title").textContent = w.full;
  document.getElementById("lock-ward-badge").textContent = w.full;
  document.getElementById("footer-ward-title").textContent = `⛪ ${CFG.churchName} • ${w.full}`;
  document.title = `${w.full} • St. Mary's Carol`;
}

// ---------- Active Day Selection & Schedule Math ----------

function getDays() {
  return (wardPayload && wardPayload.carol_days) || [];
}

function getDayHouses(dayId) {
  const all = (wardPayload && wardPayload.ward_houses) || [];
  return all
    .filter((h) => h.carol_day_id === dayId)
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
}

function selectDefaultDay() {
  const days = getDays();
  if (!days.length) {
    activeDayId = null;
    return;
  }
  if (activeDayId && days.some((d) => d.id === activeDayId)) return;

  const todayIso = new Date().toISOString().slice(0, 10);
  const exactToday = days.find((d) => d.carol_date === todayIso);
  if (exactToday) {
    activeDayId = exactToday.id;
    return;
  }
  const upcoming = days.find((d) => d.carol_date && d.carol_date > todayIso);
  activeDayId = upcoming ? upcoming.id : days[0].id;
}

const refreshedDayRoadLegs = new Set();

async function ensureActiveDayRealRoadLegs() {
  if (!wardPayload || !activeDayId || refreshedDayRoadLegs.has(activeDayId)) return;
  const houses = getDayHouses(activeDayId);
  if (houses.length < 2) return;
  refreshedDayRoadLegs.add(activeDayId);
  await window.CarolOptimizer.refreshRouteLegsWithTraffic(houses, "afternoon");
  localStorage.setItem(keyOfflineRoute(activeWardId), JSON.stringify(wardPayload));
  render();
}

function switchDay(dayId) {
  activeDayId = dayId;
  searchQuery = "";
  const searchEl = document.getElementById("search-input");
  if (searchEl) searchEl.value = "";
  document.getElementById("search-clear").classList.remove("visible");
  const pinBar = document.getElementById("map-pin-bar");
  if (pinBar) pinBar.classList.remove("visible");
  render();
  ensureActiveDayRealRoadLegs();
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

function formatDriveDuration(totalMins) {
  const m = Math.max(0, Math.round(Number(totalMins) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function calculateSchedule(dayObj, houses) {
  const defaultVisit = (dayObj && dayObj.avg_visit_mins) || 20;
  let cursor = timeStrToMinutes(dayObj ? dayObj.start_time : "14:00");
  let totalTravelMins = 0;
  let totalCarolMins = 0;
  let totalMiles = 0;

  const computed = houses.map((h, index) => {
    const driveFromPrev = index === 0 ? 0 : Number(h.drive_mins) || 0;
    if (index > 0) {
      cursor += driveFromPrev;
      totalTravelMins += driveFromPrev;
      const miMatch = String(h.distance_label || "").match(/(\d+(?:\.\d+)?)\s*mi/i);
      if (miMatch) {
        totalMiles += parseFloat(miMatch[1]);
      } else {
        const prev = houses[index - 1];
        if (prev && typeof prev.lat === "number" && typeof h.lat === "number") {
          totalMiles += window.CarolOptimizer.haversineMiles(prev.lat, prev.lng, h.lat, h.lng) * 1.28;
        }
      }
    }
    const arrivalMins = cursor;
    const duration = Number(h.visit_mins) || defaultVisit;
    const departureMins = arrivalMins + duration;
    totalCarolMins += duration;
    cursor = departureMins;

    let distFromUser = null;
    if (userCoords && typeof h.lat === "number" && typeof h.lng === "number") {
      distFromUser = window.CarolOptimizer.haversineMiles(userCoords.lat, userCoords.lng, h.lat, h.lng);
    }

    return {
      ...h,
      index,
      isLast: index === houses.length - 1,
      driveFromPrev,
      arrivalFormatted: minutesToTimeStr(arrivalMins),
      departureFormatted: minutesToTimeStr(departureMins),
      duration,
      distFromUser
    };
  });

  return { computed, totalTravelMins, totalCarolMins, totalMiles };
}

function getNavUrl(address, lat, lng) {
  const encoded = encodeURIComponent(address);
  if (prefs.primaryNavApp === "apple") {
    return `https://maps.apple.com/?daddr=${encoded}&dirflg=d`;
  }
  if (prefs.primaryNavApp === "waze") {
    return typeof lat === "number" && typeof lng === "number"
      ? `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`
      : `https://waze.com/ul?q=${encoded}&navigate=yes`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${encoded}&travelmode=driving`;
}

// ---------- Offline Multi-Day SVG Route Map (Zoom + Pan + Other Days Dimmed + Active Day Bright) ----------

let mapZoom = 1;
let mapPanX = 0;
let mapPanY = 0;
let mapDrag = null;
let mapFullscreen = false;
let mapShowLabels = false;
let mapShowMiles = true;
let lastMapRenderArgs = null;

function toggleMapFullscreen() {
  mapFullscreen = !mapFullscreen;
  const wrap = document.getElementById("route-svg-wrap");
  const btn = document.getElementById("btn-map-fullscreen");
  if (wrap) wrap.classList.toggle("fullscreen", mapFullscreen);
  if (btn) {
    btn.textContent = mapFullscreen ? "✕" : "⛶";
    btn.title = mapFullscreen ? "Restore Map" : "Full Screen Map";
    btn.classList.toggle("active", mapFullscreen);
  }
  // Wait 1 frame so flexbox lays out the full-screen viewport before measuring W x H
  requestAnimationFrame(() => rerenderRouteMapOnly());
}

window.addEventListener("resize", () => {
  if (snapshotOpen || mapFullscreen) rerenderRouteMapOnly();
});

function toggleMapLabels() {
  mapShowLabels = !mapShowLabels;
  const btn = document.getElementById("btn-map-labels");
  if (btn) btn.classList.toggle("active", mapShowLabels);
  rerenderRouteMapOnly();
}

function toggleMapMiles() {
  mapShowMiles = !mapShowMiles;
  const btn = document.getElementById("btn-map-miles");
  if (btn) btn.classList.toggle("active", mapShowMiles);
  rerenderRouteMapOnly();
}

function selectMapPin(stopId) {
  if (!lastMapRenderArgs) return;
  const stop = (lastMapRenderArgs.computed || []).find((s) => s.id === stopId);
  const bar = document.getElementById("map-pin-bar");
  if (!stop || !bar) return;
  const navUrl = getNavUrl(stop.address, stop.lat, stop.lng);
  const isAdmin = adminSession.unlocked && adminSession.wardId === activeWardId;
  const days = getDays();
  const moveHtml =
    isAdmin && days.length > 1
      ? `
        <div class="map-pin-move">
          <label for="map-pin-day-select">📅 Assign Day:</label>
          <select id="map-pin-day-select" aria-label="Reassign house to another Carol Day">
            ${days
              .map(
                (d) =>
                  `<option value="${d.id}" ${d.id === stop.carol_day_id ? "selected" : ""}>${escapeHtml(d.label)}</option>`
              )
              .join("")}
          </select>
          <button id="btn-map-pin-move" class="mini-btn gold" onclick="moveMapPinHouseToDay('${stop.id}')">💾 Save Day</button>
        </div>
      `
      : "";

  bar.innerHTML = `
    <div class="map-pin-top">
      <div style="min-width:0;flex:1;">
        <div style="font-weight:900;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">#${stop.index + 1} ${escapeHtml(stop.family_name)}</div>
        <div style="font-size:0.74rem;color:var(--text-muted);">${stop.arrivalFormatted} – ${stop.departureFormatted} • ${escapeHtml(stop.distance_label || "Start")}</div>
      </div>
      <div style="display:flex;gap:5px;flex-shrink:0;">
        <a class="mini-btn mint" href="${navUrl}" target="_blank" rel="noopener" style="text-decoration:none;">🧭 Go</a>
        ${!mapFullscreen ? `<button class="mini-btn" onclick="jumpToStop('${stop.id}')">View</button>` : ""}
        <button class="mini-btn" onclick="document.getElementById('map-pin-bar').classList.remove('visible')">✕</button>
      </div>
    </div>
    ${moveHtml}
  `;
  bar.classList.add("visible");
}

async function moveMapPinHouseToDay(houseId) {
  if (!adminSession.unlocked || adminSession.wardId !== activeWardId || !sbClient || !wardPayload?.active_season) {
    return showToast("Unlock 🔐 Admin first to reassign days");
  }
  const newDayId = document.getElementById("map-pin-day-select")?.value || "";
  const existing = (wardPayload.ward_houses || []).find((x) => x.id === houseId);
  if (!existing || !newDayId) return;
  if (newDayId === existing.carol_day_id) {
    return showToast("Already assigned to this day");
  }

  const btn = document.getElementById("btn-map-pin-move");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving...";
  }

  try {
    const oldDayId = existing.carol_day_id;
    const oldDayHouses = window.CarolOptimizer.recomputeLegEstimates(
      getDayHouses(oldDayId).filter((h) => h.id !== houseId),
      "afternoon"
    );
    if (oldDayHouses.length >= 2) {
      await window.CarolOptimizer.refreshRouteLegsWithTraffic(oldDayHouses, "afternoon");
    }

    const targetDayHouses = getDayHouses(newDayId).map((h) => ({ ...h }));
    const movedHouse = {
      ...existing,
      carol_day_id: newDayId,
      visited: false,
      checked_in_at: null
    };
    const coords =
      typeof existing.lat === "number" && typeof existing.lng === "number"
        ? { lat: existing.lat, lng: existing.lng }
        : null;
    const { insertIdx } = window.CarolOptimizer.findBestInsertionSlot(targetDayHouses, coords);
    targetDayHouses.splice(insertIdx, 0, movedHouse);
    const updatedTarget = window.CarolOptimizer.recomputeLegEstimates(targetDayHouses, "afternoon");
    if (updatedTarget.length >= 2) {
      await window.CarolOptimizer.refreshRouteLegsWithTraffic(updatedTarget, "afternoon");
    }

    const { data: d1 } = await sbClient.rpc("admin_bulk_save_houses", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_season_id: wardPayload.active_season.id,
      p_carol_day_id: oldDayId,
      p_houses: oldDayHouses,
      p_replace_day: true
    });
    const { data: d2 } = await sbClient.rpc("admin_bulk_save_houses", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_season_id: wardPayload.active_season.id,
      p_carol_day_id: newDayId,
      p_houses: updatedTarget,
      p_replace_day: true
    });

    if (d1 && d1.ok && d2 && d2.ok) {
      const pinBar = document.getElementById("map-pin-bar");
      if (pinBar) pinBar.classList.remove("visible");
      refreshedDayRoadLegs.add(oldDayId);
      refreshedDayRoadLegs.add(newDayId);
      await syncActiveWardOnline(true);
      broadcastPiiFreeEtaShift(oldDayId, 0, new Date().toISOString());
      broadcastPiiFreeEtaShift(newDayId, 0, new Date().toISOString());
      populateAdminControls();
      const targetLabel = (getDays().find((d) => d.id === newDayId) || {}).label || "selected day";
      showToast(`✅ Moved ${existing.family_name} to ${targetLabel} (Stop #${insertIdx + 1}) & synced for all!`);
    } else {
      showToast("Could not move house to the selected day.");
    }
  } catch (e) {
    showToast("Save failed — check internet connection.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "💾 Save Day";
    }
  }
}

function rerenderRouteMapOnly() {
  if (!lastMapRenderArgs) return;
  const el = document.getElementById("route-svg-container");
  if (!el) return;
  if (mapZoom <= 1) {
    mapZoom = 1;
    mapPanX = 0;
    mapPanY = 0;
  }
  const vp = document.getElementById("route-svg-viewport");
  const maxPanX = (mapZoom - 1) * ((vp && vp.clientWidth) || 380) * 0.55;
  const maxPanY = (mapZoom - 1) * ((vp && vp.clientHeight) || 320) * 0.55;
  mapPanX = Math.max(-maxPanX, Math.min(maxPanX, mapPanX));
  mapPanY = Math.max(-maxPanY, Math.min(maxPanY, mapPanY));
  el.style.transform = "";
  el.innerHTML = renderOfflineRouteSvg(lastMapRenderArgs.computed, lastMapRenderArgs.nextIndex);
}

function zoomRouteMap(delta) {
  mapZoom = Math.max(1, Math.min(5, Number((mapZoom + delta).toFixed(2))));
  rerenderRouteMapOnly();
}

function resetRouteMapZoom() {
  mapZoom = 1;
  mapPanX = 0;
  mapPanY = 0;
  rerenderRouteMapOnly();
}

let mapPinch = null;
let mapRafPending = false;

function scheduleMapRerender() {
  if (mapRafPending) return;
  mapRafPending = true;
  requestAnimationFrame(() => {
    mapRafPending = false;
    rerenderRouteMapOnly();
  });
}

function initRouteMapPanHandlers() {
  const vp = document.getElementById("route-svg-viewport");
  if (!vp || vp.dataset.panBound) return;
  vp.dataset.panBound = "1";

  // Mouse / single-pointer pan
  vp.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return; // handled by touch events for clean pinch + pan
    if (mapZoom <= 1) return;
    mapDrag = { startX: e.clientX, startY: e.clientY, origX: mapPanX, origY: mapPanY };
  });

  window.addEventListener("pointermove", (e) => {
    if (!mapDrag) return;
    mapPanX = mapDrag.origX + (e.clientX - mapDrag.startX);
    mapPanY = mapDrag.origY + (e.clientY - mapDrag.startY);
    scheduleMapRerender();
  });

  window.addEventListener("pointerup", () => {
    mapDrag = null;
  });

  // Native Mobile Touch: 2-finger Pinch-to-Zoom + 1-finger Pan
  vp.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        mapDrag = null;
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        mapPinch = {
          startDist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY) || 1,
          startZoom: mapZoom,
          startMidX: (t1.clientX + t2.clientX) / 2,
          startMidY: (t1.clientY + t2.clientY) / 2,
          origPanX: mapPanX,
          origPanY: mapPanY
        };
      } else if (e.touches.length === 1 && mapZoom > 1) {
        mapPinch = null;
        const t = e.touches[0];
        mapDrag = { startX: t.clientX, startY: t.clientY, origX: mapPanX, origY: mapPanY };
      }
    },
    { passive: false }
  );

  vp.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2 && mapPinch) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY) || 1;
        const midX = (t1.clientX + t2.clientX) / 2;
        const midY = (t1.clientY + t2.clientY) / 2;
        mapZoom = Math.max(1, Math.min(5, Number((mapPinch.startZoom * (dist / mapPinch.startDist)).toFixed(2))));
        mapPanX = mapPinch.origPanX + (midX - mapPinch.startMidX);
        mapPanY = mapPinch.origPanY + (midY - mapPinch.startMidY);
        scheduleMapRerender();
      } else if (e.touches.length === 1 && mapDrag && mapZoom > 1) {
        e.preventDefault();
        const t = e.touches[0];
        mapPanX = mapDrag.origX + (t.clientX - mapDrag.startX);
        mapPanY = mapDrag.origY + (t.clientY - mapDrag.startY);
        scheduleMapRerender();
      }
    },
    { passive: false }
  );

  vp.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) mapPinch = null;
    if (e.touches.length === 0) mapDrag = null;
  });

  vp.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomRouteMap(e.deltaY < 0 ? 0.35 : -0.35);
    },
    { passive: false }
  );
}

function renderOfflineRouteSvg(computed, nextIndex) {
  lastMapRenderArgs = { computed, nextIndex };
  const days = getDays();
  const otherDayGroups = days
    .filter((d) => d.id !== activeDayId)
    .map((d) => ({
      day: d,
      houses: getDayHouses(d.id).filter(
        (h) => typeof h.lat === "number" && typeof h.lng === "number" && !Number.isNaN(h.lat) && !Number.isNaN(h.lng)
      )
    }))
    .filter((g) => g.houses.length > 0);

  const activePts = computed.filter(
    (s) => typeof s.lat === "number" && typeof s.lng === "number" && !Number.isNaN(s.lat) && !Number.isNaN(s.lng)
  );
  const allPts = [...activePts, ...otherDayGroups.flatMap((g) => g.houses)];

  if (allPts.length < 2) {
    return `<div style="padding:14px;text-align:center;color:var(--text-muted);font-size:0.8rem;">Add geocoded coordinates in Admin to preview the offline map.</div>`;
  }

  const lats = allPts.map((p) => p.lat);
  const lngs = allPts.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const cosLat = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));

  // Measure real viewport dimensions so Full Screen & mobile use 100% of canvas with ZERO aspect-ratio distortion
  const vpEl = document.getElementById("route-svg-viewport");
  const measuredW = vpEl && vpEl.clientWidth > 120 ? vpEl.clientWidth : 380;
  const measuredH = mapFullscreen
    ? Math.max(320, (vpEl && vpEl.clientHeight > 180 ? vpEl.clientHeight : window.innerHeight - 110))
    : Math.max(230, Math.min(300, Math.round(measuredW * 0.62)));
  const W = measuredW;
  const H = measuredH;
  const pad = 28;

  const spanLng = Math.max((maxLng - minLng) * cosLat, 0.005);
  const spanLat = Math.max(maxLat - minLat, 0.005);
  // Uniform scale preserves exact geographic aspect ratio on both portrait & landscape screens
  const baseScale = Math.min((W - pad * 2) / spanLng, (H - pad * 2) / spanLat);
  const offX = (W - spanLng * baseScale) / 2;
  const offY = (H - spanLat * baseScale) / 2;

  // Semantic Zoom: expands leg distances around center while keeping pin circles & labels constant size
  const project = (lat, lng) => {
    const bx = offX + (lng - minLng) * cosLat * baseScale;
    const by = H - (offY + (lat - minLat) * baseScale);
    return {
      x: W / 2 + (bx - W / 2) * mapZoom + mapPanX,
      y: H / 2 + (by - H / 2) * mapZoom + mapPanY
    };
  };

  // 1. Render OTHER (inactive) carol days underneath — clearly visible muted style (theme-aware)
  const isLight = !!prefs.lightTheme;
  let otherDaysSvg = "";
  const otherColors = isLight ? ["#64748B", "#475569", "#78716C"] : ["#94A3B8", "#7DD3FC", "#A78BFA"];
  const otherFill = isLight ? "#E2E8F0" : "#1E293B";
  const otherText = isLight ? "#1E293B" : "#E2E8F0";

  otherDayGroups.forEach((group, gIdx) => {
    const col = otherColors[gIdx % otherColors.length];
    const pts = group.houses.map((h) => project(h.lat, h.lng));
    // Light de-overlap on other-day pins too
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[j].x - pts[i].x;
          const dy = pts[j].y - pts[i].y;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d < 15) {
            const push = (15 - d) / 2;
            pts[i].x -= (dx / d) * push;
            pts[i].y -= (dy / d) * push;
            pts[j].x += (dx / d) * push;
            pts[j].y += (dy / d) * push;
            if (mapZoom === 1) {
              pts[i].x = Math.max(12, Math.min(W - 12, pts[i].x));
              pts[i].y = Math.max(12, Math.min(H - 12, pts[i].y));
              pts[j].x = Math.max(12, Math.min(W - 12, pts[j].x));
              pts[j].y = Math.max(12, Math.min(H - 12, pts[j].y));
            }
          }
        }
      }
    }
    let segs = "";
    for (let i = 1; i < pts.length; i++) {
      segs += `<line x1="${pts[i - 1].x.toFixed(1)}" y1="${pts[i - 1].y.toFixed(1)}" x2="${pts[i].x.toFixed(1)}" y2="${pts[i].y.toFixed(1)}" stroke="${col}" stroke-width="1.7" stroke-dasharray="4 3" opacity="0.72" />`;
    }
    let dots = "";
    pts.forEach((p, idx) => {
      const h = group.houses[idx];
      dots += `
        <g style="cursor:pointer;" opacity="0.76" onclick="switchDay('${group.day.id}')">
          <title>${escapeHtml(group.day.label)} • #${idx + 1} ${escapeHtml(h.family_name)} (Tap to switch day)</title>
          <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7.2" fill="${otherFill}" stroke="${col}" stroke-width="1.5" />
          <text x="${p.x.toFixed(1)}" y="${(p.y + 2.6).toFixed(1)}" text-anchor="middle" fill="${otherText}" font-size="7.5" font-weight="800" font-family="sans-serif">${idx + 1}</text>
        </g>
      `;
    });
    otherDaysSvg += `<g data-day="${group.day.id}">${segs}${dots}</g>`;
  });

  // 2. Project & gently de-overlap ACTIVE (selected) day pins so every stop is crisp and bright
  const projected = computed.map((s) =>
    typeof s.lat === "number" && typeof s.lng === "number" && !Number.isNaN(s.lat) && !Number.isNaN(s.lng)
      ? project(s.lat, s.lng)
      : null
  );

  const valid = projected.filter(Boolean);
  for (let pass = 0; pass < 10; pass++) {
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const dx = valid[j].x - valid[i].x;
        const dy = valid[j].y - valid[i].y;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d < 21) {
          const push = (21 - d) / 2;
          valid[i].x -= (dx / d) * push;
          valid[i].y -= (dy / d) * push;
          valid[j].x += (dx / d) * push;
          valid[j].y += (dy / d) * push;
          if (mapZoom === 1) {
            valid[i].x = Math.max(15, Math.min(W - 15, valid[i].x));
            valid[i].y = Math.max(15, Math.min(H - 15, valid[i].y));
            valid[j].x = Math.max(15, Math.min(W - 15, valid[j].x));
            valid[j].y = Math.max(15, Math.min(H - 15, valid[j].y));
          }
        }
      }
    }
  }

  let activeLinesSvg = "";
  let legBadgesSvg = "";
  const placedBoxes = []; // Track placed label & distance pill boxes for collision avoidance

  function boxesOverlap(a, b) {
    return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  }

  for (let i = 1; i < computed.length; i++) {
    const p1 = projected[i - 1];
    const p2 = projected[i];
    if (!p1 || !p2) continue;
    const stop = computed[i];
    const prevStop = computed[i - 1];
    const isWalk = (stop.distance_label || "").toLowerCase().includes("walk");
    const isDone = prevStop.visited && stop.visited;

    // Extract clean driving miles for this leg (distance_label first, Haversine*1.28 fallback)
    let legMiles = null;
    const miMatch = String(stop.distance_label || "").match(/(\d+(?:\.\d+)?)\s*mi/i);
    if (miMatch) {
      legMiles = parseFloat(miMatch[1]);
    } else if (typeof prevStop.lat === "number" && typeof stop.lat === "number") {
      legMiles = window.CarolOptimizer.haversineMiles(prevStop.lat, prevStop.lng, stop.lat, stop.lng) * 1.28;
    }
    const isLongLeg = !isWalk && typeof legMiles === "number" && legMiles >= 3.0;

    const stroke = isDone
      ? (isLight ? "#059669" : "#34D399")
      : isWalk
      ? (isLight ? "#9333EA" : "#C084FC")
      : isLongLeg
      ? (isLight ? "#D97706" : "#FBBF24")
      : (isLight ? "#0284C7" : "#38BDF8");
    activeLinesSvg += `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${stroke}" stroke-width="${isLongLeg ? "2.9" : "2.6"}" ${isWalk ? 'stroke-dasharray="4 3"' : ""} />`;

    // Smart collision-safe per-leg distance pill on segments long enough (>= 42px)
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (mapShowMiles && segLen >= 42 && (isWalk || typeof legMiles === "number")) {
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      if (mx > 24 && mx < W - 46 && my > 34 && my < H - 14) {
        const badgeText = isWalk ? "🚶" : `${legMiles < 10 ? legMiles.toFixed(1) : Math.round(legMiles)} mi`;
        const bw = isWalk ? 18 : Math.max(30, badgeText.length * 4.8 + 9);
        const bh = 13;
        const box = { x1: mx - bw / 2, y1: my - bh / 2, x2: mx + bw / 2, y2: my + bh / 2 };

        let collides = false;
        for (const op of valid) {
          if (boxesOverlap(box, { x1: op.x - 12, y1: op.y - 12, x2: op.x + 12, y2: op.y + 12 })) {
            collides = true;
            break;
          }
        }
        if (!collides) {
          for (const pb of placedBoxes) {
            if (boxesOverlap(box, pb)) {
              collides = true;
              break;
            }
          }
        }

        if (!collides) {
          placedBoxes.push(box);
          const bgFill = isLight
            ? (isLongLeg ? "rgba(254,243,199,0.95)" : "rgba(255,255,255,0.92)")
            : (isLongLeg ? "rgba(69,26,3,0.9)" : "rgba(4,14,11,0.86)");
          const txtFill = isLight
            ? (isLongLeg ? "#92400E" : "#0F172A")
            : (isLongLeg ? "#FDE68A" : "#E2E8F0");
          legBadgesSvg += `
            <g style="pointer-events:none;">
              <rect x="${box.x1.toFixed(1)}" y="${box.y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh}" rx="6.5" fill="${bgFill}" stroke="${stroke}" stroke-width="1" />
              <text x="${mx.toFixed(1)}" y="${(my + 2.7).toFixed(1)}" text-anchor="middle" fill="${txtFill}" font-size="7.6" font-weight="800" font-family="sans-serif">${badgeText}</text>
            </g>
          `;
        }
      }
    }
  }

  let activePinsSvg = "";
  let labelsSvg = "";

  computed.forEach((s, idx) => {
    const p = projected[idx];
    if (!p) return;
    const isCur = idx === nextIndex;
    const fill = s.visited
      ? "#059669"
      : isCur
      ? "#F59E0B"
      : s.isLast
      ? "#DC2626"
      : (isLight ? "#0284C7" : "#0B251D");
    const stroke = s.visited
      ? (isLight ? "#047857" : "#6EE7B7")
      : isCur
      ? (isLight ? "#B45309" : "#FFFFFF")
      : s.isLast
      ? (isLight ? "#991B1B" : "#FCA5A5")
      : (isLight ? "#0369A1" : "#38BDF8");
    activePinsSvg += `
      <g style="cursor:pointer;" onclick="selectMapPin('${s.id}')">
        <title>#${idx + 1} ${escapeHtml(s.family_name)} — ${escapeHtml(s.address)}</title>
        ${isCur ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="15.5" fill="rgba(245,158,11,0.3)" />` : ""}
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isCur ? 11.2 : 9.6}" fill="${fill}" stroke="${stroke}" stroke-width="2" />
        <text x="${p.x.toFixed(1)}" y="${(p.y + 3.4).toFixed(1)}" text-anchor="middle" fill="${isCur ? "#000" : "#FFF"}" font-size="9.5" font-weight="900" font-family="sans-serif">${idx + 1}</text>
      </g>
    `;

    // Smart 8-Position Collision-Avoiding Label Placement
    if (mapShowLabels && p.x > -30 && p.x < W + 30 && p.y > -20 && p.y < H + 20) {
      const shortLabel = (s.family_name || "").replace(/\s+and\s+/i, " & ").trim();
      const lw = Math.min(130, Math.max(36, shortLabel.length * 5.2 + 8));
      const lh = 14;
      const rOff = 14;

      const candidates = [
        { tx: p.x + rOff, ty: p.y + 3, anchor: "start", x1: p.x + rOff - 2, y1: p.y - 7 },            // Right
        { tx: p.x - rOff, ty: p.y + 3, anchor: "end", x1: p.x - rOff - lw + 2, y1: p.y - 7 },         // Left
        { tx: p.x, ty: p.y - rOff - 2, anchor: "middle", x1: p.x - lw / 2, y1: p.y - rOff - lh },     // Top
        { tx: p.x, ty: p.y + rOff + 9, anchor: "middle", x1: p.x - lw / 2, y1: p.y + rOff - 1 },      // Bottom
        { tx: p.x + rOff, ty: p.y - 11, anchor: "start", x1: p.x + rOff - 2, y1: p.y - 21 },          // Top-Right
        { tx: p.x + rOff, ty: p.y + 17, anchor: "start", x1: p.x + rOff - 2, y1: p.y + 7 },           // Bottom-Right
        { tx: p.x - rOff, ty: p.y - 11, anchor: "end", x1: p.x - rOff - lw + 2, y1: p.y - 21 },       // Top-Left
        { tx: p.x - rOff, ty: p.y + 17, anchor: "end", x1: p.x - rOff - lw + 2, y1: p.y + 7 }         // Bottom-Left
      ];

      let bestCand = candidates[0];
      let bestScore = Infinity;

      for (const c of candidates) {
        const box = { x1: c.x1, y1: c.y1, x2: c.x1 + lw, y2: c.y1 + lh };
        let score = 0;

        // Penalize going off-canvas
        if (box.x1 < 4) score += 40;
        if (box.x2 > W - 44) score += 40; // avoid right zoom toolbar
        if (box.y1 < 4 || box.y2 > H - 4) score += 40;

        // Heavy penalty for overlapping any already-placed label
        for (const pb of placedBoxes) {
          if (boxesOverlap(box, pb)) score += 100;
        }
        // Heavy penalty for overlapping any active pin circle
        for (const op of valid) {
          const pinBox = { x1: op.x - 11, y1: op.y - 11, x2: op.x + 11, y2: op.y + 11 };
          if (boxesOverlap(box, pinBox)) score += 80;
        }

        if (score < bestScore) {
          bestScore = score;
          bestCand = { ...c, box };
        }
      }

      placedBoxes.push(bestCand.box);
      const pillBg = isLight ? "rgba(248,250,252,0.88)" : "rgba(4,14,11,0.84)";
      const pillBorder = isLight ? "rgba(100,116,139,0.45)" : "rgba(56,189,248,0.4)";
      const txtCol = isLight ? "#0F172A" : "#F8FAFC";
      labelsSvg += `
        <g style="pointer-events:none;">
          <rect x="${bestCand.box.x1.toFixed(1)}" y="${bestCand.box.y1.toFixed(1)}" width="${lw.toFixed(1)}" height="${lh}" rx="4" fill="${pillBg}" stroke="${pillBorder}" stroke-width="0.8" />
          <text x="${bestCand.tx.toFixed(1)}" y="${bestCand.ty.toFixed(1)}" text-anchor="${bestCand.anchor}" fill="${txtCol}" font-size="8.4" font-weight="800" font-family="sans-serif">${escapeHtml(shortLabel)}</text>
        </g>
      `;
    }
  });

  // Live "You Are Here" blue pulsing GPS dot when Near Me is active
  let userDotSvg = "";
  if (userCoords && typeof userCoords.lat === "number" && typeof userCoords.lng === "number") {
    const up = project(userCoords.lat, userCoords.lng);
    userDotSvg = `
      <g>
        <title>Your Current Location</title>
        <circle cx="${up.x.toFixed(1)}" cy="${up.y.toFixed(1)}" r="11" fill="rgba(56,189,248,0.28)" />
        <circle cx="${up.x.toFixed(1)}" cy="${up.y.toFixed(1)}" r="5" fill="#38BDF8" stroke="#FFFFFF" stroke-width="2" />
      </g>
    `;
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block;width:100%;height:${mapFullscreen ? "100%" : "auto"};" role="img" aria-label="Multi-day offline route map">${otherDaysSvg}${activeLinesSvg}${legBadgesSvg}${activePinsSvg}${labelsSvg}${userDotSvg}</svg>`;
}

// ---------- 20-Min House Countdown Timer ----------

function playSoftChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.14, ctx.currentTime + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.16 + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.16);
      osc.stop(ctx.currentTime + i * 0.16 + 0.36);
    });
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate([180, 90, 180]);
}

function resetHouseTimer(stopId, durationMins) {
  if (houseTimer.intervalId) clearInterval(houseTimer.intervalId);
  houseTimer = {
    stopId,
    durationMins: durationMins || 20,
    remainingSec: (durationMins || 20) * 60,
    endTimeMs: null,
    running: false,
    intervalId: null,
    warned3Min: false,
    finished: false
  };
  saveHouseTimerState();
}

function updateTimerButtonUI(durationMins) {
  const btn = document.getElementById("hero-timer-btn");
  if (!btn) return;
  const dur = durationMins || houseTimer.durationMins || 20;
  btn.classList.remove("running", "done");
  const mm = String(Math.floor(houseTimer.remainingSec / 60)).padStart(2, "0");
  const ss = String(houseTimer.remainingSec % 60).padStart(2, "0");
  if (houseTimer.finished) {
    btn.classList.add("done");
    btn.textContent = "🔔 00:00";
  } else if (houseTimer.running) {
    btn.classList.add("running");
    btn.textContent = `⏱️ ${mm}:${ss}`;
  } else if (houseTimer.remainingSec < dur * 60) {
    btn.textContent = `▶ ${mm}:${ss}`;
  } else {
    btn.textContent = `⏱️ ${dur}m Timer`;
  }
}

function triggerTimerFinished() {
  houseTimer.remainingSec = 0;
  houseTimer.running = false;
  houseTimer.finished = true;
  houseTimer.endTimeMs = null;
  if (houseTimer.intervalId) {
    clearInterval(houseTimer.intervalId);
    houseTimer.intervalId = null;
  }
  saveHouseTimerState();
  updateTimerButtonUI(houseTimer.durationMins);

  const houses = getDayHouses(activeDayId);
  const curIdx = houses.findIndex((h) => h.id === houseTimer.stopId);
  const nextHouse = curIdx !== -1 ? houses.slice(curIdx + 1).find((h) => !h.visited) : null;
  const nextNum = nextHouse ? houses.indexOf(nextHouse) + 1 : null;
  const alertMsg = nextHouse
    ? `🔔 Time's up! Please head to the next house: #${nextNum} ${nextHouse.family_name} 🚗`
    : `🎉 Time's up at our final stop! Merry Christmas everyone! 🎄`;
  const sentAt = new Date().toISOString();

  if (realtimeChannel) {
    realtimeChannel.send({
      type: "broadcast",
      event: "broadcast_alert",
      payload: {
        ward_id: activeWardId,
        message: alertMsg,
        pinned: false,
        sent_at: sentAt
      }
    });
  }

  // Also show OS notification if permission was granted (alerts even if minimized)
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification("St. Mary's Christmas Carol", { body: alertMsg, icon: "./icons/icon-192.png" });
    } catch (e) {}
  }

  showLiveBroadcastPopup(alertMsg, sentAt);
  showToast(alertMsg);
}

function syncHouseTimerFromClock() {
  if (!houseTimer.running || !houseTimer.endTimeMs) return;
  const left = Math.max(0, Math.ceil((houseTimer.endTimeMs - Date.now()) / 1000));
  houseTimer.remainingSec = left;

  if (left <= 180 && left > 0 && !houseTimer.warned3Min) {
    houseTimer.warned3Min = true;
    saveHouseTimerState();
    showToast("⏳ 3 mins left — wrap up & group photo!");
    if (navigator.vibrate) navigator.vibrate(140);
  }

  if (left <= 0) {
    triggerTimerFinished();
    return;
  }

  updateTimerButtonUI(houseTimer.durationMins);
}

function startTimerLoop() {
  if (houseTimer.intervalId) clearInterval(houseTimer.intervalId);
  syncHouseTimerFromClock();
  if (houseTimer.running) {
    houseTimer.intervalId = setInterval(syncHouseTimerFromClock, 1000);
  }
}

function toggleHouseTimer(stopId, durationMins) {
  if (houseTimer.stopId !== stopId || houseTimer.finished) {
    resetHouseTimer(stopId, durationMins);
  }
  if (houseTimer.running) {
    syncHouseTimerFromClock();
    if (houseTimer.intervalId) clearInterval(houseTimer.intervalId);
    houseTimer.intervalId = null;
    houseTimer.running = false;
    houseTimer.endTimeMs = null;
    saveHouseTimerState();
    updateTimerButtonUI(durationMins);
    showToast("Timer paused");
    return;
  }

  // Request non-blocking notification permission so minimized tabs can alert
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }

  houseTimer.durationMins = durationMins || houseTimer.durationMins || 20;
  houseTimer.running = true;
  houseTimer.endTimeMs = Date.now() + houseTimer.remainingSec * 1000;
  saveHouseTimerState();
  startTimerLoop();
  showToast(`⏱️ Started ${houseTimer.durationMins}-min carol timer`);
}

// ---------- Main Dashboard Render ----------

function render() {
  applyUiPrefs();
  updateWardHeaderLabels();
  if (!wardPayload) return;

  const settings = wardPayload.ward_settings || {};
  const bannerEl = document.getElementById("ward-instructions-banner");
  if (settings.instructions_banner && settings.instructions_banner.trim()) {
    document.getElementById("ward-instructions-text").textContent = `📌 ${settings.instructions_banner}`;
    bannerEl.classList.add("visible");
  } else {
    bannerEl.classList.remove("visible");
  }

  const days = getDays();
  const switcherEl = document.getElementById("day-switcher");
  if (days.length <= 1) {
    switcherEl.classList.add("hidden");
  } else {
    switcherEl.classList.remove("hidden");
    switcherEl.innerHTML = days
      .map((d) => {
        const dHouses = getDayHouses(d.id);
        const doneCnt = dHouses.filter((h) => h.visited).length;
        const sub = doneCnt > 0 ? `${doneCnt}/${dHouses.length} Done` : `${minutesToTimeStr(timeStrToMinutes(d.start_time))} • ${dHouses.length}`;
        return `
          <button class="day-tab ${d.id === activeDayId ? "active" : ""}" onclick="switchDay('${d.id}')">
            <span class="day-tab-title">🎄 ${escapeHtml(d.label)}</span>
            <span class="day-tab-sub">${sub}</span>
          </button>
        `;
      })
      .join("");
  }

  const activeDay = days.find((d) => d.id === activeDayId) || days[0] || null;
  const houses = activeDay ? getDayHouses(activeDay.id) : [];
  const { computed, totalTravelMins, totalCarolMins, totalMiles } = calculateSchedule(activeDay, houses);

  const seasonName = wardPayload.active_season ? wardPayload.active_season.name : "Christmas Carol";
  document.getElementById("header-subtitle").textContent = activeDay
    ? `${seasonName} • ${activeDay.label} • Gather ${minutesToTimeStr(timeStrToMinutes(activeDay.start_time))}`
    : `${seasonName} • No carol days configured yet`;

  const completedStops = computed.filter((s) => s.visited);
  const upcomingStops = computed.filter((s) => !s.visited);
  const currentStop = upcomingStops[0] || null;
  const upNextStop = upcomingStops[1] || null;
  const finalStop = computed[computed.length - 1] || null;

  document.getElementById("metric-progress").textContent = `${completedStops.length} / ${computed.length}`;
  document.getElementById("metric-dinner-eta").textContent = finalStop ? finalStop.arrivalFormatted : "--:--";
  document.getElementById("metric-ratios").textContent = `${totalTravelMins}m (${totalMiles.toFixed(1)} mi)`;
  document.getElementById("progress-fill").style.width = `${computed.length ? (completedStops.length / computed.length) * 100 : 0}%`;

  // Snapshot Map + In-Map Day Switcher (2-line cards) + Fallback Single-Day HUD + Chunked Multi-Stop Google Maps Legs
  const mapDaySwitcher = document.getElementById("map-day-switcher");
  if (mapDaySwitcher) {
    if (days.length <= 1) {
      mapDaySwitcher.classList.add("hidden");
      mapDaySwitcher.innerHTML = "";
    } else {
      mapDaySwitcher.classList.remove("hidden");
      mapDaySwitcher.innerHTML = days
        .map((d) => {
          const dHouses = getDayHouses(d.id);
          const dSched = calculateSchedule(d, dHouses);
          const stopWord = dHouses.length === 1 ? "stop" : "stops";
          return `
            <button class="map-day-pill ${d.id === activeDayId ? "active" : ""}" onclick="switchDay('${d.id}')">
              <span class="map-day-pill-top">
                <span class="map-day-title">🎄 ${escapeHtml(d.label)}</span>
                <span class="map-day-stops">${dHouses.length} ${stopWord}</span>
              </span>
              <span class="map-day-pill-meta">🚗 ${dSched.totalMiles.toFixed(1)} mi · ${formatDriveDuration(dSched.totalTravelMins)}</span>
            </button>
          `;
        })
        .join("");
    }
  }
  const mapStatsHud = document.getElementById("map-stats-hud");
  if (mapStatsHud) {
    // Only show floating HUD when single-day (multi-day stats already live cleanly in the day cards above)
    if (!computed.length || days.length > 1) {
      mapStatsHud.classList.add("hidden");
      mapStatsHud.textContent = "";
    } else {
      mapStatsHud.classList.remove("hidden");
      mapStatsHud.textContent = `🚗 ${totalMiles.toFixed(1)} mi · ${formatDriveDuration(totalTravelMins)}`;
    }
  }
  document.getElementById("snapshot-miles-label").textContent = `• ${totalMiles.toFixed(1)} mi • ${computed.length} stops`;
  document.getElementById("route-svg-container").innerHTML = renderOfflineRouteSvg(computed, currentStop ? currentStop.index : -1);
  initRouteMapPanHandlers();
  const mapLegs = window.CarolOptimizer.buildChunkedGoogleMapsLegs(computed, 9);
  document.getElementById("snapshot-map-links").innerHTML = mapLegs
    .map((l) => `<a class="map-leg-btn" href="${l.url}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`)
    .join("");

  // Hero Spotlight: Current & Up-Next
  const heroEl = document.getElementById("hero-spotlight");
  if (!computed.length) {
    heroEl.innerHTML = `
      <section class="hero-card">
        <div class="hero-family">No houses scheduled yet</div>
        <div class="hero-address">Ward Admins can tap 🔐 to import houses or clone last year's season.</div>
      </section>
    `;
  } else if (currentStop) {
    if (houseTimer.stopId !== currentStop.id) {
      if (!loadHouseTimerState(currentStop.id, currentStop.duration)) {
        resetHouseTimer(currentStop.id, currentStop.duration);
      }
    }
    const navUrl = getNavUrl(currentStop.address, currentStop.lat, currentStop.lng);
    const isWalk = (currentStop.distance_label || "").toLowerCase().includes("walk");
    const isAdminNow = adminSession.unlocked && adminSession.wardId === activeWardId;
    const callHtml = currentStop.phone
      ? `<a class="footer-chip" href="tel:${escapeHtml(currentStop.phone.replace(/[^\d+]/g, ""))}">📞 Call Host</a>`
      : "";
    const skipHtml =
      isAdminNow && !currentStop.isLast && currentStop.stop_role !== "END"
        ? `<button class="footer-chip" onclick="skipHouseForLater('${currentStop.id}')">⏭️ Skip / Revisit Later</button>`
        : "";
    const upNextHtml = upNextStop
      ? `<div class="up-next-strip"><span>⏭️ <strong>Up Next (#${upNextStop.index + 1}):</strong> ${escapeHtml(upNextStop.family_name)}</span><span>ETA ${upNextStop.arrivalFormatted}</span></div>`
      : "";

    heroEl.innerHTML = `
      <section class="hero-card">
        <div class="hero-eyebrow">
          <span class="hero-tag">🔴 LIVE • Stop #${currentStop.index + 1} of ${computed.length}</span>
          <span class="hero-eta">${currentStop.arrivalFormatted} – ${currentStop.departureFormatted}</span>
        </div>
        <div class="hero-family">${escapeHtml(currentStop.family_name)}</div>
        <div class="hero-address" onclick="copyText('${escapeJs(currentStop.address)}', 'Address copied!')">📍 ${escapeHtml(currentStop.address)}</div>
        ${currentStop.notes ? `<div class="hero-notes">${escapeHtml(currentStop.notes)}</div>` : ""}
        ${callHtml || skipHtml ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px;">${callHtml}${skipHtml}</div>` : ""}
        <div class="hero-actions">
          <a class="btn-car btn-go-primary" href="${navUrl}" target="_blank" rel="noopener">${isWalk ? "🚶 Walk" : "🧭 Navigate"}</a>
          <button id="hero-timer-btn" class="btn-car btn-timer-hero" onclick="toggleHouseTimer('${currentStop.id}', ${currentStop.duration})">⏱️ ${currentStop.duration}m Timer</button>
          <button class="btn-car btn-checkin-hero" onclick="toggleVisited('${currentStop.id}')">✓ Arrived</button>
        </div>
        ${upNextHtml}
      </section>
    `;
    updateTimerButtonUI(currentStop.duration);
  } else {
    heroEl.innerHTML = `
      <section class="hero-card" style="border-color: var(--accent-mint);">
        <div class="hero-family" style="color: var(--accent-mint);">🎉 ${escapeHtml(activeDay.label)} Complete!</div>
        <div class="hero-address">Merry Christmas to everyone in ${escapeHtml(CFG.WARDS[activeWardId].full)}!</div>
      </section>
    `;
  }

  // Search filter
  const matches = (s) =>
    !searchQuery ||
    s.family_name.toLowerCase().includes(searchQuery) ||
    s.address.toLowerCase().includes(searchQuery) ||
    (s.notes || "").toLowerCase().includes(searchQuery);

  const fCompleted = completedStops.filter(matches);
  const fUpcoming = upcomingStops.filter(matches);

  document.getElementById("completed-section").innerHTML = fCompleted.length
    ? `<div class="section-heading">Completed (${fCompleted.length})</div>` +
      fCompleted
        .map(
          (s) => `
          <div class="stop-card visited-collapsed" id="card-${s.id}">
            <div class="collapsed-info">
              <span class="collapsed-check">✓</span>
              <span class="collapsed-title">#${s.index + 1} ${escapeHtml(s.family_name)}</span>
            </div>
            <button class="collapsed-undo" onclick="toggleVisited('${s.id}')">Undo</button>
          </div>
        `
        )
        .join("")
    : "";

  const isAdmin = adminSession.unlocked && adminSession.wardId === activeWardId;
  document.getElementById("upcoming-section").innerHTML = fUpcoming.length
    ? `<div class="section-heading">${searchQuery ? "Matching Houses" : "Remaining Stops"} (${fUpcoming.length})</div>` +
      fUpcoming
        .map((s) => {
          const isCur = currentStop && s.id === currentStop.id;
          const navUrl = getNavUrl(s.address, s.lat, s.lng);
          const isWalk = (s.distance_label || "").toLowerCase().includes("walk");
          const connector =
            s.index === 0 || searchQuery
              ? ""
              : `<div class="drive-connector ${isWalk ? "walk-leg" : ""}">
                  <span class="drive-pill">${isWalk ? "🚶" : "🚗"} ${s.driveFromPrev} min ${s.distance_label ? `(${escapeHtml(s.distance_label)})` : ""}</span>
                  <span>Arrive ${s.arrivalFormatted}</span>
                </div>`;
          const roleBadge =
            s.stop_role === "START"
              ? `<span class="role-badge start">START</span>`
              : s.stop_role === "END"
              ? `<span class="role-badge end">🍽️ END</span>`
              : "";
          const distBadge = s.distFromUser !== null ? `<span class="role-badge start">${s.distFromUser.toFixed(1)} mi</span>` : "";

          return `
            ${connector}
            <article class="stop-card ${isCur ? "active-next" : ""} ${s.stop_role === "END" ? "final-dinner" : ""}" id="card-${s.id}">
              <div class="card-top">
                <div class="seq-and-time">
                  <span class="seq-badge">#${s.index + 1}</span>
                  <span class="time-window">${s.arrivalFormatted} – ${s.departureFormatted}</span>
                  ${roleBadge}
                  ${distBadge}
                </div>
                ${
                  isAdmin && !searchQuery && s.stop_role !== "START" && s.stop_role !== "END"
                    ? `<div class="reorder-controls">
                        <button class="move-btn" onclick="moveHouseInActiveDay(${s.index}, -1)">▲</button>
                        <button class="move-btn" onclick="moveHouseInActiveDay(${s.index}, 1)">▼</button>
                      </div>`
                    : ""
                }
              </div>
              <div class="family-name">${escapeHtml(s.family_name)}</div>
              <div class="address-line" onclick="copyText('${escapeJs(s.address)}', 'Address copied!')">📍 ${escapeHtml(s.address)}</div>
              ${s.notes ? `<div class="notes-line">${escapeHtml(s.notes)}</div>` : ""}
              <div class="card-actions">
                <a class="nav-btn gmaps" href="${navUrl}" target="_blank" rel="noopener">${isWalk ? "🚶 Walk" : "🧭 Navigate"}</a>
                <button class="nav-btn headsup" onclick="sendHostHeadsUp('${escapeJs(s.family_name)}', '${escapeJs(s.arrivalFormatted)}')">📲 Heads-Up</button>
                <button class="checkin-btn" onclick="toggleVisited('${s.id}')">✓ Check In</button>
              </div>
            </article>
          `;
        })
        .join("")
    : "";

  // Coordinator Footer
  const callBtn = document.getElementById("footer-call-btn");
  const smsBtn = document.getElementById("footer-sms-btn");
  if (settings.coordinator_phone) {
    const digits = settings.coordinator_phone.replace(/[^\d+]/g, "");
    callBtn.href = `tel:${digits}`;
    callBtn.textContent = `📞 Call ${settings.coordinator_name || "Coordinator"}`;
    callBtn.style.display = "inline-block";
    smsBtn.href = `sms:${digits}`;
    smsBtn.textContent = `💬 Text ${settings.coordinator_name || "Coordinator"}`;
    smsBtn.style.display = "inline-block";
  } else {
    callBtn.style.display = "none";
    smsBtn.style.display = "none";
  }
}

// ---------- Live Actions (Check-In, Shift to Now, WhatsApp ETA, Unplanned House) ----------

async function toggleVisited(houseId) {
  if (!wardPayload) return;
  const house = wardPayload.ward_houses.find((h) => h.id === houseId);
  if (!house) return;
  const nextVisited = !house.visited;
  const nowIso = new Date().toISOString();

  // Optimistic local update
  house.visited = nextVisited;
  house.checked_in_at = nextVisited ? nowIso : null;
  localStorage.setItem(keyOfflineRoute(activeWardId), JSON.stringify(wardPayload));
  render();
  showToast(nextVisited ? `✓ Checked in: ${house.family_name}` : `Undid: ${house.family_name}`);

  // If Ward Admin is unlocked & online, persist to Supabase & broadcast PII-free Realtime update
  if (adminSession.unlocked && adminSession.wardId === activeWardId && sbClient) {
    const { data } = await sbClient.rpc("admin_checkin_house", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_house_id: houseId,
      p_visited: nextVisited,
      p_actual_timestamp: nowIso
    });
    if (data && data.ok) {
      broadcastPiiFreeEtaShift(data.carol_day_id, data.current_stop_index, nowIso);
    }
  }
}

async function shiftScheduleToNow() {
  const days = getDays();
  const activeDay = days.find((d) => d.id === activeDayId);
  if (!activeDay) return;
  const houses = getDayHouses(activeDay.id);
  const nextIdx = houses.findIndex((h) => !h.visited);
  if (nextIdx === -1) return showToast("All stops completed!");

  showToast("⏱️ Calculating remaining drive times for current traffic...");

  // Recalculate remaining legs from the current stop onward using current time-of-day traffic
  const remainingSlice = houses.slice(Math.max(0, nextIdx));
  const { profile } = await window.CarolOptimizer.refreshRouteLegsWithTraffic(remainingSlice, "now");

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  let elapsed = 0;
  for (let i = 0; i < nextIdx; i++) {
    if (i > 0) elapsed += Number(houses[i].drive_mins) || 0;
    elapsed += Number(houses[i].visit_mins) || activeDay.avg_visit_mins || 20;
  }
  if (nextIdx > 0) elapsed += Number(houses[nextIdx].drive_mins) || 0;

  const adjusted = (((nowMins - elapsed) % 1440) + 1440) % 1440;
  activeDay.start_time = `${String(Math.floor(adjusted / 60)).padStart(2, "0")}:${String(adjusted % 60).padStart(2, "0")}`;
  localStorage.setItem(keyOfflineRoute(activeWardId), JSON.stringify(wardPayload));

  // If Coordinator/Admin is unlocked, persist shifted time & legs to Supabase and broadcast to all connected phones
  if (adminSession.unlocked && adminSession.wardId === activeWardId && sbClient) {
    await sbClient.rpc("admin_upsert_carol_day", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_season_id: activeDay.season_id,
      p_day_id: activeDay.id,
      p_day_number: activeDay.day_number,
      p_label: activeDay.label,
      p_carol_date: activeDay.carol_date || null,
      p_start_time: activeDay.start_time,
      p_avg_visit_mins: activeDay.avg_visit_mins || 20,
      p_drive_buffer_mins: activeDay.drive_buffer_mins || 5
    });
    await sbClient.rpc("admin_save_house_order", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_carol_day_id: activeDay.id,
      p_ordered_houses: houses
    });
    broadcastPiiFreeEtaShift(activeDay.id, nextIdx, now.toISOString());
    render();
    showToast(`⏱️ Synced live schedule to ${minutesToTimeStr(nowMins)} (${profile.label})`);
  } else {
    render();
    showToast(`⏱️ Local preview shifted to ${minutesToTimeStr(nowMins)} (${profile.label})`);
  }
}

async function skipHouseForLater(houseId) {
  if (!adminSession.unlocked || adminSession.wardId !== activeWardId || !sbClient) return;
  const houses = getDayHouses(activeDayId);
  const idx = houses.findIndex((h) => h.id === houseId);
  if (idx === -1) return;
  const h = houses[idx];
  if (!window.confirm(`Skip "${h.family_name}" for now and move before the Final Stop to revisit later?`)) return;

  const [moved] = houses.splice(idx, 1);
  moved.notes = moved.notes && !moved.notes.includes("Revisit")
    ? `⏭️ Revisit Later • ${moved.notes}`
    : (moved.notes || "⏭️ Revisit Later (Not home earlier)");
  const endIdx = houses.findIndex((x) => x.stop_role === "END");
  const insertPos = endIdx !== -1 ? endIdx : houses.length;
  houses.splice(insertPos, 0, moved);

  const updated = window.CarolOptimizer.recomputeLegEstimates(houses, "afternoon");
  await window.CarolOptimizer.refreshRouteLegsWithTraffic(updated, "afternoon");

  if (wardPayload && wardPayload.active_season) {
    const { data } = await sbClient.rpc("admin_bulk_save_houses", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_season_id: wardPayload.active_season.id,
      p_carol_day_id: activeDayId,
      p_houses: updated,
      p_replace_day: true
    });
    if (data && data.ok) {
      await syncActiveWardOnline(true);
      broadcastPiiFreeEtaShift(activeDayId, idx, new Date().toISOString());
      showToast(`⏭️ Moved ${moved.family_name} to #${insertPos + 1} (Revisit Later)`);
    }
  }
}

async function resetDayCheckIns() {
  const dayId = document.getElementById("opt-day-select")?.value || activeDayId;
  if (!dayId || !adminSession.unlocked || adminSession.wardId !== activeWardId || !sbClient) return;
  if (!window.confirm("Reset all check-ins on this carol day back to 0 visited?")) return;

  const houses = getDayHouses(dayId);
  if (!houses.length || !wardPayload?.active_season) return;
  const cleared = houses.map((h) => ({ ...h, visited: false, checked_in_at: null }));
  const { data } = await sbClient.rpc("admin_bulk_save_houses", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_season_id: wardPayload.active_season.id,
    p_carol_day_id: dayId,
    p_houses: cleared,
    p_replace_day: true
  });
  if (data && data.ok) {
    await syncActiveWardOnline(true);
    broadcastPiiFreeEtaShift(dayId, 0, new Date().toISOString());
    populateAdminControls();
    showToast("🔄 All check-ins reset to 0!");
  }
}

function copyFullDaySchedule() {
  const activeDay = getDays().find((d) => d.id === activeDayId);
  if (!activeDay) return;
  const { computed, totalTravelMins, totalMiles } = calculateSchedule(activeDay, getDayHouses(activeDay.id));
  if (!computed.length) return showToast("No stops to copy");

  const w = CFG.WARDS[activeWardId];
  let txt = `🎄 *St. Mary's Christmas Carol — ${w.full}*\n📅 ${activeDay.label} (${computed.length} houses • ${totalMiles.toFixed(1)} mi • ~${totalTravelMins}m drive)\n\n`;
  computed.forEach((s) => {
    txt += `${s.index + 1}. *${s.family_name}* (${s.arrivalFormatted} – ${s.departureFormatted})${s.stop_role === "END" ? " 🍽️" : ""}\n   📍 ${s.address}\n`;
  });
  copyText(txt, "📋 Full day schedule copied to clipboard!");
}

function openQuickHelpModal() {
  const isAdmin = adminSession.unlocked && adminSession.wardId === activeWardId;
  const titleEl = document.getElementById("quick-help-title");
  const bodyEl = document.getElementById("quick-help-body");
  if (!titleEl || !bodyEl) return;

  if (isAdmin) {
    titleEl.textContent = `🔐 Coordinator / Admin Guide (${CFG.WARDS[activeWardId].short})`;
    bodyEl.innerHTML = `
      <div><strong style="color: var(--accent-gold);">1. Live Check-Ins &amp; Shift to Now:</strong> Tap <strong>✓ Arrived</strong> or <strong>⏱️ Shift to Now</strong> to save live progress &amp; current-traffic ETAs to Supabase—every connected caroler's phone automatically snaps into sync.</div>
      <div><strong style="color: var(--accent-sky);">2. Absent Family or Unplanned House:</strong> Tap <strong>⏭️ Skip / Revisit Later</strong> on the top card to move an absent family before Dinner, or <strong>➕ Add House</strong> to auto-insert an unplanned stop at the shortest detour.</div>
      <div><strong style="color: var(--accent-mint);">3. Bulk Edit &amp; Auto-Sort Route:</strong> Open <strong>🔐 Admin → Houses &amp; Route</strong>. The selected day is pre-filled in <strong>Paste / Bulk Edit Houses</strong> for quick edits; tap <strong>⚡ Auto-Sort Best Route → 💾 Save Order</strong> to optimize with START/END pinned, or <strong>🔄 Reset Check-Ins</strong> after dry-run testing.</div>
      <div><strong style="color: var(--accent-purple);">4. Songbook Approvals &amp; Karaoke:</strong> Open <strong>🎵 Songbook</strong> to review <strong>🔔 Pending Song Approvals</strong> (Preview / Approve / Reject), or tap <strong>✏️ Edit</strong> on any song to attach a YouTube or MP3 karaoke track.</div>
      <div><strong style="color: var(--accent-crimson-soft);">5. Broadcast &amp; Ward Code Invite:</strong> Tap <strong>📢 Broadcast</strong> to pop up a live announcement on all phones, or go to <strong>🔐 Admin → Code &amp; Broadcast</strong> to reset the Ward PIN and share the 1-tap WhatsApp Invite.</div>
    `;
  } else {
    titleEl.textContent = "❓ How to Use St. Mary's Carol App";
    bodyEl.innerHTML = `
      <div><strong style="color: var(--accent-sky);">1. Navigate House-to-House:</strong> Tap <strong>🧭 Navigate</strong> on the top card to open Google Maps (you can switch to Apple Maps or Waze in <strong>⚙️ Settings</strong>).</div>
      <div><strong style="color: var(--accent-gold);">2. Find Your House ETA:</strong> Type your family name or street in the <strong>🔍 Search</strong> bar to see when the carol group will arrive at your home.</div>
      <div><strong style="color: var(--accent-mint);">3. Route Map &amp; Zoom:</strong> Expand <strong>🗺️ Route Map</strong> to view all carol days together, pinch-to-zoom or tap <strong>⛶</strong> Full Screen, and tap <strong>Aa</strong> to see family names.</div>
      <div><strong style="color: var(--accent-purple);">4. Carol Songbook &amp; Karaoke:</strong> Tap <strong>🎵</strong> in the header for Malayalam &amp; English lyrics, <code>A-/A+</code> sizing, audio-only karaoke playback, and <strong>+ Add / ✏️ Edit</strong> songs (kept for your session and sent for Coordinator approval).</div>
      <div><strong style="color: var(--text-primary);">5. Offline Install &amp; Live Sync:</strong> Tap <strong>Install App</strong> at the bottom for offline carol-night reliability. ETAs update automatically whenever your Ward Coordinator checks in.</div>
    `;
  }
  document.getElementById("quick-help-modal").classList.add("open");
}

function shareWhatsAppStatus() {
  const days = getDays();
  const activeDay = days.find((d) => d.id === activeDayId);
  if (!activeDay) return;
  const { computed } = calculateSchedule(activeDay, getDayHouses(activeDay.id));
  const done = computed.filter((s) => s.visited);
  const next = computed.find((s) => !s.visited);
  const finalStop = computed[computed.length - 1];
  const dayShort = `Day ${activeDay.day_number || 1}`;

  let msg = `🎄 Carol ${dayShort} - Update\n`;
  if (done.length > 0) {
    const lastDone = done[done.length - 1];
    msg += `✅ Completed: #${lastDone.index + 1} ${lastDone.family_name} (${done.length}/${computed.length})\n`;
  }
  if (next) {
    msg += `🚗 Next Stop: #${next.index + 1} ${next.family_name} (ETA ${next.arrivalFormatted})\n`;
    msg += `📍 ${next.address}\n`;
  } else {
    msg += `🎉 All houses completed!\n`;
  }
  if (finalStop) {
    msg += `🍽️ Final Stop ETA (${finalStop.family_name}): ${finalStop.arrivalFormatted}`;
  }

  copyText(msg, `Copied! Select "${(wardPayload.ward_settings && wardPayload.ward_settings.whatsapp_group_name) || CFG.WARDS[activeWardId].defaultWaGroup}" in WhatsApp`);
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
}

function sendHostHeadsUp(family, etaStr) {
  const msg = `🎄 Hi ${family}! Christmas Carol is on the way — our current ETA to your home is ${etaStr}. See you soon! 🎶`;
  copyText(msg, `Heads-up copied for ${family}!`);
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
}

// ---------- Duplicate Family Name / Address Guard ----------

function normalizeDupKey(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function findDuplicateHouse(familyName, address, excludeHouseId = null, excludedDayIds = []) {
  const fKey = normalizeDupKey(familyName);
  const aKey = normalizeDupKey(address);
  const all = (wardPayload && wardPayload.ward_houses) || [];
  for (const h of all) {
    if (excludeHouseId && h.id === excludeHouseId) continue;
    if (excludedDayIds && excludedDayIds.includes(h.carol_day_id)) continue;
    if (fKey && normalizeDupKey(h.family_name) === fKey) {
      return { field: "Family Name", existing: h };
    }
    if (aKey && normalizeDupKey(h.address) === aKey) {
      return { field: "Address", existing: h };
    }
  }
  return null;
}

// ---------- Add Unplanned New House (Shortest Detour + Optional Supabase Sync) ----------

function openAddHouseModal() {
  document.getElementById("add-family").value = "";
  document.getElementById("add-address").value = "";
  document.getElementById("add-phone").value = "";
  document.getElementById("add-notes").value = "";
  document.getElementById("add-placement").value = "auto";
  document.getElementById("add-house-status").textContent = "Smart mode finds the shortest detour among remaining unvisited houses.";
  document.getElementById("add-house-modal").classList.add("open");
}

async function submitNewHouse() {
  const family_name = document.getElementById("add-family").value.trim();
  const address = document.getElementById("add-address").value.trim();
  const phone = document.getElementById("add-phone").value.trim();
  const notes = document.getElementById("add-notes").value.trim();
  const placement = document.getElementById("add-placement").value;
  const visit_mins = Math.max(5, parseInt(document.getElementById("add-visit-mins").value, 10) || 20);
  const statusEl = document.getElementById("add-house-status");
  const btn = document.getElementById("btn-add-house-submit");

  if (!family_name || !address) {
    statusEl.textContent = "Enter both Family Name and Street Address.";
    return;
  }

  const dup = findDuplicateHouse(family_name, address);
  if (dup) {
    statusEl.style.color = "var(--accent-crimson-soft)";
    statusEl.textContent = `Duplicate ${dup.field}: "${dup.existing.family_name}" is already in this ward's schedule.`;
    return;
  }
  statusEl.style.color = "var(--accent-sky)";

  btn.disabled = true;
  btn.textContent = "Calculating...";
  statusEl.textContent = "Geocoding address & finding shortest detour...";

  const dayHouses = getDayHouses(activeDayId);
  const coords = await window.CarolOptimizer.geocodeAddress(address);

  let insertIdx = dayHouses.length;
  let detourInfo = "";
  const firstUnvisited = dayHouses.findIndex((h) => !h.visited);
  const hasEnd = dayHouses.length > 0 && dayHouses[dayHouses.length - 1].stop_role === "END";
  const maxSlot = hasEnd ? dayHouses.length - 1 : dayHouses.length;

  if (placement === "next") {
    insertIdx = firstUnvisited === -1 ? maxSlot : firstUnvisited;
  } else if (placement === "before-end") {
    insertIdx = maxSlot;
  } else {
    const res = window.CarolOptimizer.findBestInsertionSlot(dayHouses, coords);
    insertIdx = res.insertIdx;
    if (coords) detourInfo = ` (~+${Math.max(0.1, res.addedMiles * 1.25).toFixed(1)} mi detour)`;
  }

  let drive_mins = insertIdx === 0 ? 0 : 6;
  let distance_label = insertIdx === 0 ? "Start" : "Est. 6 min drive";
  const prev = insertIdx > 0 ? dayHouses[insertIdx - 1] : null;
  const next = insertIdx < dayHouses.length ? dayHouses[insertIdx] : null;

  if (coords && prev && typeof prev.lat === "number") {
    const legIn = await window.CarolOptimizer.fetchOsrmLeg({ lat: prev.lat, lng: prev.lng }, coords);
    drive_mins = legIn.drive_mins;
    distance_label = legIn.distance_label;
  }
  if (coords && next && typeof next.lat === "number") {
    const legOut = await window.CarolOptimizer.fetchOsrmLeg(coords, { lat: next.lat, lng: next.lng });
    next.drive_mins = legOut.drive_mins;
    next.distance_label = legOut.distance_label;
  }

  const newHouse = {
    id: `local-${Date.now()}`,
    ward_id: activeWardId,
    season_id: wardPayload.active_season ? wardPayload.active_season.id : null,
    carol_day_id: activeDayId,
    family_name,
    address,
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
    phone,
    notes: notes ? `✨ Added live • ${notes}` : "✨ Unplanned house added during carol",
    stop_role: null,
    stop_order: insertIdx,
    drive_mins,
    distance_label,
    visit_mins,
    visited: false,
    checked_in_at: null
  };

  dayHouses.splice(insertIdx, 0, newHouse);
  dayHouses.forEach((h, i) => (h.stop_order = i));

  // Merge back into wardPayload
  wardPayload.ward_houses = wardPayload.ward_houses
    .filter((h) => h.carol_day_id !== activeDayId)
    .concat(dayHouses);
  localStorage.setItem(keyOfflineRoute(activeWardId), JSON.stringify(wardPayload));

  // Sync to Supabase if Admin is unlocked
  if (adminSession.unlocked && adminSession.wardId === activeWardId && sbClient && wardPayload.active_season) {
    await sbClient.rpc("admin_bulk_save_houses", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_season_id: wardPayload.active_season.id,
      p_carol_day_id: activeDayId,
      p_houses: dayHouses,
      p_replace_day: true
    });
    broadcastPiiFreeEtaShift(activeDayId, insertIdx, new Date().toISOString());
    await syncActiveWardOnline(true);
  }

  btn.disabled = false;
  btn.textContent = "Find Best Spot & Add";
  closeModal("add-house-modal");
  render();
  showToast(`Added ${family_name} at Stop #${insertIdx + 1}${detourInfo}`);
}

// ---------- Songbook Integration ----------

function keyHiddenBuiltins(wardId) {
  return `carol_hidden_songs_${wardId}`;
}

function keySessionSongs(wardId) {
  return `carol_session_songs_${wardId}`;
}

function getSessionSongs() {
  try {
    return JSON.parse(sessionStorage.getItem(keySessionSongs(activeWardId)) || "[]");
  } catch (e) {
    return [];
  }
}

function saveSessionSong(songObj) {
  const list = getSessionSongs();
  const key = (songObj.title || "").trim().toLowerCase();
  const idx = list.findIndex((s) => (s.title || "").trim().toLowerCase() === key || (songObj.replacesId && s.replacesId === songObj.replacesId));
  if (idx !== -1) list[idx] = songObj;
  else list.push(songObj);
  try {
    sessionStorage.setItem(keySessionSongs(activeWardId), JSON.stringify(list));
  } catch (e) {}
}

function getCombinedSongs() {
  const dbSongs = (wardPayload && wardPayload.ward_songs) || [];
  const sessionSongs = getSessionSongs();
  let localSongs = [];
  let hiddenIds = [];
  try {
    localSongs = JSON.parse(localStorage.getItem(keyLocalSongs(activeWardId)) || "[]");
    hiddenIds = JSON.parse(localStorage.getItem(keyHiddenBuiltins(activeWardId)) || "[]");
  } catch (e) {}

  // Drop session songs that have already been approved into dbSongs
  const dbTitles = new Set(dbSongs.map((s) => (s.title || "").trim().toLowerCase()));
  const activeSession = sessionSongs.filter((s) => !dbTitles.has((s.title || "").trim().toLowerCase()) || s.sessionEdited);
  const sessionTitles = new Set(activeSession.map((s) => (s.title || "").trim().toLowerCase()));
  const sessionReplaces = new Set(activeSession.map((s) => s.replacesId).filter(Boolean));

  const builtins = CFG.DEFAULT_SONGS.filter(
    (s) =>
      !hiddenIds.includes(s.id) &&
      !dbTitles.has((s.title || "").trim().toLowerCase()) &&
      !sessionTitles.has((s.title || "").trim().toLowerCase()) &&
      !sessionReplaces.has(s.id)
  );
  const filteredDb = dbSongs.filter(
    (s) => !sessionTitles.has((s.title || "").trim().toLowerCase()) && !sessionReplaces.has(s.id)
  );
  return [...builtins, ...filteredDb, ...localSongs, ...activeSession];
}

function renderCurrentSongbook() {
  const isAdmin = adminSession.unlocked && adminSession.wardId === activeWardId;
  window.CarolSongbook.render(getCombinedSongs(), isAdmin);
}

function openSongbookModal() {
  acquireWakeLockIfEnabled();
  renderCurrentSongbook();
  loadPendingSongs();
  document.getElementById("songbook-modal").classList.add("open");
}

function closeSongbookModal() {
  window.CarolSongbook.stopAudio();
  closeModal("songbook-modal");
}

function toggleAddSongPanel() {
  const panel = document.getElementById("add-song-panel");
  const opening = !panel.classList.contains("open");
  panel.classList.toggle("open");
  if (opening) {
    // Reset to fresh "Add New Song" mode
    document.getElementById("edit-song-id").value = "";
    document.getElementById("new-song-url").value = "";
    document.getElementById("new-song-title").value = "";
    document.getElementById("new-song-audio").value = "";
    document.getElementById("new-song-lyrics").value = "";
  }
  const isAdmin = adminSession.unlocked && adminSession.wardId === activeWardId;
  const noteEl = document.getElementById("song-submit-note");
  const btnEl = document.getElementById("btn-save-song");
  if (noteEl && btnEl) {
    if (isAdmin) {
      noteEl.textContent = "Admin mode: Song & Karaoke Audio/YouTube URL will sync immediately to all ward members.";
      btnEl.textContent = "💾 Save & Sync to Ward";
    } else {
      noteEl.textContent = "Submitted songs are sent to your Ward Coordinator for quick approval before syncing to everyone.";
      btnEl.textContent = "📤 Submit for Coordinator Approval";
    }
  }
}

function openEditCurrentSong() {
  const songs = getCombinedSongs();
  const cur = songs[window.CarolSongbook.getActiveIdx()];
  if (!cur) return;

  document.getElementById("edit-song-id").value = cur.id || "";
  document.getElementById("new-song-url").value = cur.source_url || "";
  document.getElementById("new-song-title").value = cur.title || "";
  document.getElementById("new-song-audio").value = cur.karaoke_audio_url || "";
  document.getElementById("new-song-lyrics").value = cur.lyrics || "";

  const isAdmin = adminSession.unlocked && adminSession.wardId === activeWardId;
  const noteEl = document.getElementById("song-submit-note");
  const btnEl = document.getElementById("btn-save-song");
  if (isAdmin) {
    if (noteEl) noteEl.textContent = `Admin editing "${cur.title}" — updates will sync immediately to all ward members.`;
    if (btnEl) btnEl.textContent = "💾 Update & Sync Song";
  } else {
    if (noteEl) noteEl.textContent = `Editing "${cur.title}" — your edit stays active for your session and is sent to the Coordinator for everyone.`;
    if (btnEl) btnEl.textContent = "📤 Keep for Session & Send for Approval";
  }

  document.getElementById("add-song-panel").classList.add("open");
  const sheet = document.querySelector("#songbook-modal .modal-sheet");
  if (sheet) sheet.scrollTop = 0;
}

async function fetchLyricsFromUrl() {
  const urlInput = document.getElementById("new-song-url");
  const statusEl = document.getElementById("fetch-lyrics-status");
  const btn = document.getElementById("btn-fetch-lyrics");
  let url = (urlInput.value || "").trim();
  if (!url) {
    statusEl.textContent = "Please paste a lyrics webpage URL first.";
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
    urlInput.value = url;
  }

  btn.disabled = true;
  btn.textContent = "Fetching...";
  statusEl.textContent = "Extracting title, lyrics & checking for karaoke audio track...";

  try {
    const res = await window.CarolSongbook.fetchFromUrl(url);
    if (res.title) document.getElementById("new-song-title").value = res.title;
    if (res.karaoke_audio_url) document.getElementById("new-song-audio").value = res.karaoke_audio_url;
    document.getElementById("new-song-lyrics").value = res.lyrics;
    statusEl.textContent = res.karaoke_audio_url
      ? "✓ Lyrics + Karaoke Audio Track detected! Review & tap Save."
      : "✓ Lyrics imported! Review & tap Save to Songbook.";
  } catch (e) {
    statusEl.textContent = "Could not fetch URL automatically — paste lyrics directly below.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Fetch";
  }
}

async function saveNewSong() {
  const editId = (document.getElementById("edit-song-id")?.value || "").trim();
  const title = document.getElementById("new-song-title").value.trim();
  const lyrics = document.getElementById("new-song-lyrics").value.trim();
  const karaoke_audio_url = document.getElementById("new-song-audio").value.trim();
  const source_url = document.getElementById("new-song-url").value.trim();
  const submitted_by = (document.getElementById("new-song-submitter")?.value || "").trim() || "Ward Member";
  if (!title || !lyrics) return showToast("Enter both title and lyrics");

  const isAdmin = adminSession.unlocked && adminSession.wardId === activeWardId;
  const cachedUserCode = localStorage.getItem(keyUserCode(activeWardId));

  if (isAdmin && sbClient) {
    const { data } = await sbClient.rpc("admin_save_song", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_song: { title, lang: "Custom", lyrics, karaoke_audio_url, source_url }
    });
    if (data && data.ok) {
      // If editing an existing Supabase song, remove the old version cleanly
      if (editId && !editId.startsWith("builtin-") && !editId.startsWith("local-")) {
        await sbClient.rpc("admin_delete_song", {
          p_ward_id: activeWardId,
          p_admin_code: adminSession.code,
          p_song_id: editId
        });
      }
      await syncActiveWardOnline(true);
      if (realtimeChannel) {
        realtimeChannel.send({ type: "broadcast", event: "songs_updated", payload: { ward_id: activeWardId } });
      }
      const all = getCombinedSongs();
      const newIdx = all.findIndex((s) => s.title === title);
      window.CarolSongbook.setActiveIdx(newIdx !== -1 ? newIdx : all.length - 1);
      renderCurrentSongbook();
      renderAdminWardSongs();
      showToast(editId ? `Updated "${title}" & synced to ward!` : `Published "${title}" to all ward members!`);
    } else {
      return showToast(`Save failed: ${(data && data.error) || "Error"}`);
    }
  } else {
    // Regular ward member: ALWAYS keep the added/edited song for this user's session immediately
    saveSessionSong({
      id: `session-song-${Date.now()}`,
      replacesId: editId || null,
      title,
      lang: "Custom",
      lyrics,
      karaoke_audio_url,
      source_url,
      sessionPending: true,
      sessionEdited: !!editId
    });

    const all = getCombinedSongs();
    const selIdx = all.findIndex((s) => s.title === title);
    window.CarolSongbook.setActiveIdx(selIdx !== -1 ? selIdx : all.length - 1);
    renderCurrentSongbook();

    // Also send to Supabase for Coordinator approval so everyone gets it once approved
    if (sbClient && cachedUserCode) {
      const { data, error } = await sbClient.rpc("submit_ward_song", {
        p_ward_id: activeWardId,
        p_user_code: cachedUserCode,
        p_song: { title, lang: "Custom", lyrics, karaoke_audio_url, source_url, submitted_by }
      });
      if (!error && data && data.ok) {
        if (realtimeChannel) {
          realtimeChannel.send({ type: "broadcast", event: "song_submitted", payload: { ward_id: activeWardId, title } });
        }
        showToast(`✓ Kept for your session & sent "${title}" for Coordinator approval!`);
      } else {
        showToast(`Kept "${title}" for your session (Coordinator approval needs migration 007 in Supabase)`);
      }
    } else {
      showToast(`Kept "${title}" for your session`);
    }
  }

  document.getElementById("edit-song-id").value = "";
  document.getElementById("new-song-url").value = "";
  document.getElementById("new-song-title").value = "";
  document.getElementById("new-song-audio").value = "";
  document.getElementById("new-song-lyrics").value = "";
  if (document.getElementById("new-song-submitter")) document.getElementById("new-song-submitter").value = "";
  document.getElementById("add-song-panel").classList.remove("open");
}

async function deleteCurrentSong() {
  const songs = getCombinedSongs();
  const cur = songs[window.CarolSongbook.getActiveIdx()];
  if (!cur) return;
  if (!window.confirm(`Delete "${cur.title}" from the Songbook?`)) return;

  if (cur.sessionPending) {
    const remaining = getSessionSongs().filter((s) => s.id !== cur.id);
    sessionStorage.setItem(keySessionSongs(activeWardId), JSON.stringify(remaining));
  } else if (String(cur.id).startsWith("builtin-")) {
    let hiddenIds = [];
    try { hiddenIds = JSON.parse(localStorage.getItem(keyHiddenBuiltins(activeWardId)) || "[]"); } catch (e) {}
    if (!hiddenIds.includes(cur.id)) hiddenIds.push(cur.id);
    localStorage.setItem(keyHiddenBuiltins(activeWardId), JSON.stringify(hiddenIds));
  } else if (cur.localOnly) {
    const localSongs = JSON.parse(localStorage.getItem(keyLocalSongs(activeWardId)) || "[]").filter((s) => s.id !== cur.id);
    localStorage.setItem(keyLocalSongs(activeWardId), JSON.stringify(localSongs));
  } else if (adminSession.unlocked && adminSession.wardId === activeWardId && sbClient) {
    await sbClient.rpc("admin_delete_song", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_song_id: cur.id
    });
    await syncActiveWardOnline(true);
    if (realtimeChannel) {
      realtimeChannel.send({ type: "broadcast", event: "songs_updated", payload: { ward_id: activeWardId } });
    }
  }
  window.CarolSongbook.setActiveIdx(0);
  renderCurrentSongbook();
  renderAdminWardSongs();
  showToast(`Deleted "${cur.title}"`);
}

function renderAdminWardSongs() {
  const el = document.getElementById("admin-ward-songs-list");
  if (!el) return;
  const dbSongs = (wardPayload && wardPayload.ward_songs) || [];
  if (!dbSongs.length) {
    el.innerHTML = `<p class="helper-text">No custom shared songs added for this ward yet.</p>`;
    return;
  }
  el.innerHTML = dbSongs
    .map(
      (s) => `
      <div class="admin-item-row">
        <div class="admin-item-main">
          <div class="admin-item-name">🎵 ${escapeHtml(s.title)}</div>
          <div class="admin-item-sub">${s.karaoke_audio_url ? "Has Karaoke Track • " : ""}${escapeHtml((s.lyrics || "").slice(0, 60))}...</div>
        </div>
        <div class="admin-item-btns">
          <button class="mini-btn danger" onclick="adminDeleteSongById('${s.id}', '${escapeJs(s.title)}')">🗑️ Delete</button>
        </div>
      </div>
    `
    )
    .join("");
}

async function adminDeleteSongById(songId, title) {
  if (!window.confirm(`Delete shared song "${title}" for all ward members?`)) return;
  const { data } = await sbClient.rpc("admin_delete_song", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_song_id: songId
  });
  if (data && data.ok) {
    await syncActiveWardOnline(true);
    renderAdminWardSongs();
    if (realtimeChannel) {
      realtimeChannel.send({ type: "broadcast", event: "songs_updated", payload: { ward_id: activeWardId } });
    }
    showToast(`Deleted "${title}" for all ward members`);
  }
}

let cachedPendingSongs = [];

async function loadPendingSongs() {
  const panel = document.getElementById("songbook-pending-panel");
  const listEl = document.getElementById("songbook-pending-list");
  const titleEl = document.getElementById("songbook-pending-title");
  if (!panel || !listEl) return;

  if (!adminSession.unlocked || adminSession.wardId !== activeWardId || !sbClient) {
    panel.style.display = "none";
    cachedPendingSongs = [];
    return;
  }

  const { data, error } = await sbClient.rpc("admin_list_pending_songs", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code
  });
  if (error || !data || !data.ok) {
    panel.style.display = "none";
    return;
  }

  const list = data.pending_songs || [];
  cachedPendingSongs = list;
  if (!list.length) {
    panel.style.display = "none";
    return;
  }

  if (titleEl) titleEl.textContent = `🔔 Pending Song Approvals (${list.length})`;
  panel.style.display = "block";
  listEl.innerHTML = list
    .map(
      (s, idx) => `
      <div class="admin-item-row">
        <div class="admin-item-main">
          <div class="admin-item-name">🎵 ${escapeHtml(s.title)} ${s.karaoke_audio_url ? "🎧" : ""}</div>
          <div class="admin-item-sub">By ${escapeHtml(s.submitted_by || "Ward Member")} • ${escapeHtml((s.lyrics || "").slice(0, 75))}...</div>
        </div>
        <div class="admin-item-btns">
          <button class="mini-btn" onclick="previewPendingSong(${idx})">👁️ Preview</button>
          <button class="mini-btn mint" onclick="approveOrRejectSong('${s.id}', true, '${escapeJs(s.title)}')">✅ Approve</button>
          <button class="mini-btn danger" onclick="approveOrRejectSong('${s.id}', false, '${escapeJs(s.title)}')">❌ Reject</button>
        </div>
      </div>
    `
    )
    .join("");
}

function previewPendingSong(idx) {
  const s = cachedPendingSongs[idx];
  if (!s) return;
  const box = document.getElementById("song-lyrics-box");
  if (box) {
    box.textContent = `[PENDING PREVIEW: ${s.title}]\nSubmitted by: ${s.submitted_by || "Ward Member"}${s.karaoke_audio_url ? `\nKaraoke URL: ${s.karaoke_audio_url}` : ""}\n\n${s.lyrics || ""}`;
  }
  showToast(`Previewing "${s.title}" below`);
}

async function approveOrRejectSong(songId, approve, title) {
  const { data } = await sbClient.rpc("admin_approve_song", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_song_id: songId,
    p_approve: approve
  });
  if (data && data.ok) {
    await syncActiveWardOnline(true);
    await loadPendingSongs();
    renderCurrentSongbook();
    if (approve && realtimeChannel) {
      realtimeChannel.send({ type: "broadcast", event: "songs_updated", payload: { ward_id: activeWardId } });
    }
    showToast(approve ? `✅ Approved "${title}" — synced to all ward members!` : `Rejected "${title}"`);
  }
}

// ---------- Ward Admin Portal (4 Tabs) ----------

function openAdminModal() {
  document.getElementById("admin-gate-ward-name").textContent = CFG.WARDS[activeWardId].full;
  document.getElementById("admin-modal-title").textContent = `🔐 Admin • ${CFG.WARDS[activeWardId].short}`;
  const isUnlocked = adminSession.unlocked && adminSession.wardId === activeWardId;
  document.getElementById("admin-login-gate").style.display = isUnlocked ? "none" : "block";
  document.getElementById("admin-portal-body").style.display = isUnlocked ? "block" : "none";
  document.getElementById("admin-login-error").textContent = "";
  if (isUnlocked) populateAdminControls();
  document.getElementById("admin-modal").classList.add("open");
}

async function handleAdminVerify() {
  const code = document.getElementById("admin-code-input").value.trim();
  const errEl = document.getElementById("admin-login-error");
  if (!code) return (errEl.textContent = "Enter Admin Code.");
  if (!initSupabaseClient()) return (errEl.textContent = "Connect Supabase in ⚙️ Settings first.");

  const { data, error } = await sbClient.rpc("verify_ward_admin_code", {
    p_ward_id: activeWardId,
    p_admin_code: code
  });
  if (error || !data || !data.ok) {
    errEl.textContent = data && data.error === "RATE_LIMITED" ? "Rate limited. Wait 15 mins." : "Invalid Admin Code for this ward.";
    return;
  }

  adminSession = { unlocked: true, code, role: data.role, wardId: activeWardId };
  document.getElementById("admin-code-input").value = "";
  document.getElementById("admin-login-gate").style.display = "none";
  document.getElementById("admin-portal-body").style.display = "block";
  applyUiPrefs();
  populateAdminControls();
  render();
  showToast(`Admin unlocked (${data.role}) for ${CFG.WARDS[activeWardId].short}`);
}

function switchAdminTab(tabName, btnEl) {
  document.querySelectorAll(".admin-tab").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".admin-pane").forEach((p) => p.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  const pane = document.getElementById(`admin-pane-${tabName}`);
  if (pane) pane.classList.add("active");
  if (tabName === "houses") renderOptimizerList();
  if (tabName === "seasons") renderAdminSeasonsAndDays();
}

function populateAdminControls() {
  const days = getDays();
  const dayOpts = days.length
    ? days.map((d) => `<option value="${escapeHtml(d.label)}" data-id="${d.id}">${escapeHtml(d.label)}</option>`).join("")
    : `<option value="Day 1">Day 1</option>`;
  document.getElementById("imp-default-day").innerHTML = dayOpts;
  document.getElementById("opt-day-select").innerHTML = days.length
    ? days.map((d) => `<option value="${d.id}" ${d.id === activeDayId ? "selected" : ""}>${escapeHtml(d.label)}</option>`).join("")
    : `<option value="">No days yet — add a day in Years &amp; Days</option>`;

  const s = (wardPayload && wardPayload.ward_settings) || {};
  document.getElementById("adm-visit-mins").value = s.default_visit_mins || 20;
  document.getElementById("adm-coord-name").value = s.coordinator_name || "";
  document.getElementById("adm-coord-phone").value = s.coordinator_phone || "";
  document.getElementById("adm-banner").value = s.instructions_banner || "";

  renderOptimizerList();
  renderAdminSeasonsAndDays();
  loadPendingSongs();
  renderAdminWardSongs();
}

function renderAdminSeasonsAndDays() {
  const seasonsEl = document.getElementById("admin-seasons-list");
  const daysEl = document.getElementById("admin-days-list");
  const seasons = (wardPayload && wardPayload.seasons) || [];
  const days = getDays();

  if (seasonsEl) {
    seasonsEl.innerHTML = seasons.length
      ? seasons
          .map(
            (s) => `
        <div class="admin-item-row">
          <div class="admin-item-main">
            <div class="admin-item-name">${s.year} — ${escapeHtml(s.name)} ${s.is_active ? `<span class="role-badge start">ACTIVE</span>` : ""}</div>
          </div>
          <div class="admin-item-btns">
            ${!s.is_active ? `<button class="mini-btn mint" onclick="activateSeason(${s.year}, '${escapeJs(s.name)}')">✓ Activate</button>` : ""}
            <button class="mini-btn" onclick="renameSeason(${s.year}, '${escapeJs(s.name)}')">✏️ Edit</button>
            <button class="mini-btn gold" onclick="cloneYearToNext(${s.year})">📋 Copy → ${s.year + 1}</button>
            ${seasons.length > 1 ? `<button class="mini-btn danger" onclick="deleteSeason('${s.id}', ${s.year})">🗑️</button>` : ""}
          </div>
        </div>
      `
          )
          .join("")
      : `<p class="helper-text">No season years yet. Add a year above.</p>`;
  }

  if (daysEl) {
    daysEl.innerHTML = days.length
      ? days
          .map(
            (d) => `
        <div class="admin-item-row">
          <div class="admin-item-main">
            <div class="admin-item-name">${escapeHtml(d.label)}</div>
            <div class="admin-item-sub">${d.carol_date || "No date"} • Start ${minutesToTimeStr(timeStrToMinutes(d.start_time))} • ${d.avg_visit_mins || 20}m/house</div>
          </div>
          <div class="admin-item-btns">
            <button class="mini-btn" onclick="editCarolDay('${d.id}')">✏️ Edit</button>
            <button class="mini-btn danger" onclick="deleteCarolDay('${d.id}', '${escapeJs(d.label)}')">🗑️</button>
          </div>
        </div>
      `
          )
          .join("")
      : `<p class="helper-text">No carol days yet. Tap + Add Day above.</p>`;
  }
}

async function activateSeason(year, name) {
  const { data } = await sbClient.rpc("admin_upsert_season", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_year: year,
    p_name: name,
    p_activate: true
  });
  if (data && data.ok) {
    activeDayId = null;
    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast(`Switched active season to ${year}`);
  }
}

async function renameSeason(year, currentName) {
  const nextName = window.prompt(`Rename ${year} season:`, currentName);
  if (!nextName || !nextName.trim()) return;
  const { data } = await sbClient.rpc("admin_upsert_season", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_year: year,
    p_name: nextName.trim(),
    p_activate: false
  });
  if (data && data.ok) {
    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast("Season updated!");
  }
}

async function deleteSeason(seasonId, year) {
  if (!window.confirm(`Delete season ${year} and all its days & houses? This cannot be undone.`)) return;
  const { data } = await sbClient.rpc("admin_delete_season", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_season_id: seasonId
  });
  if (data && data.ok) {
    activeDayId = null;
    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast(`Deleted season ${year}`);
  } else {
    showToast(`Delete failed: ${data ? data.error : "Run migration 006 in Supabase"}`);
  }
}

async function cloneYearToNext(fromYr) {
  const toYr = fromYr + 1;
  if (!window.confirm(`Copy all houses & days from ${fromYr} into ${toYr} and activate ${toYr}?`)) return;
  const { data } = await sbClient.rpc("admin_clone_previous_season", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_from_year: fromYr,
    p_to_year: toYr
  });
  if (data && data.ok) {
    activeDayId = null;
    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast(`Copied ${data.copied_houses} families into ${toYr}!`);
  } else {
    showToast(`Copy failed: ${data ? data.error : "Error"}`);
  }
}

async function editCarolDay(dayId) {
  const d = getDays().find((x) => x.id === dayId);
  if (!d) return;
  const label = window.prompt("Day Label:", d.label);
  if (!label) return;
  const carolDate = window.prompt("Carol Date (YYYY-MM-DD, optional):", d.carol_date || "") || null;
  const startTime = window.prompt("Start Time (HH:MM 24h, e.g. 14:00):", d.start_time || "14:00") || "14:00";
  const avgMins = parseInt(window.prompt("Minutes per House:", String(d.avg_visit_mins || 20)), 10) || 20;

  const { data } = await sbClient.rpc("admin_upsert_carol_day", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_season_id: d.season_id,
    p_day_id: d.id,
    p_day_number: d.day_number,
    p_label: label.trim(),
    p_carol_date: carolDate,
    p_start_time: startTime.trim(),
    p_avg_visit_mins: avgMins,
    p_drive_buffer_mins: d.drive_buffer_mins || 5
  });
  if (data && data.ok) {
    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast(`Updated ${label}`);
  }
}

async function deleteCarolDay(dayId, label) {
  if (!window.confirm(`Delete "${label}" and all its houses?`)) return;
  const { data } = await sbClient.rpc("admin_delete_carol_day", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_day_id: dayId
  });
  if (data && data.ok) {
    activeDayId = null;
    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast(`Deleted ${label}`);
  } else {
    showToast(`Delete failed: ${data ? data.error : "Run migration 006 in Supabase"}`);
  }
}

async function promptAddNewDay() {
  const days = getDays();
  const nextNum = days.length + 1;
  const label = window.prompt(`Label for Day ${nextNum}:`, `Day ${nextNum}`);
  if (!label) return;
  const dateStr = window.prompt("Carol Date (YYYY-MM-DD, optional):", "") || null;
  const startTime = window.prompt("Start Time (HH:MM 24h):", "14:00") || "14:00";

  if (!wardPayload || !wardPayload.active_season) return showToast("Create an active season first");
  const { data } = await sbClient.rpc("admin_upsert_carol_day", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_season_id: wardPayload.active_season.id,
    p_day_id: null,
    p_day_number: nextNum,
    p_label: label,
    p_carol_date: dateStr,
    p_start_time: startTime,
    p_avg_visit_mins: 20,
    p_drive_buffer_mins: 5
  });
  if (data && data.ok) {
    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast(`Added ${label}`);
  }
}

function previewBulkImport() {
  const raw = document.getElementById("imp-textarea").value;
  const defaultDay = document.getElementById("imp-default-day").value || "Day 1";
  const replaceDay = document.getElementById("imp-replace-day").checked;
  const parsed = window.CarolOptimizer.parseBulkDelimited(raw, defaultDay);

  // Deduplicate within paste AND against existing houses (unless those days are being replaced)
  const existingDays = getDays();
  const replacedDayIds = replaceDay
    ? existingDays
        .filter((d) =>
          parsed.rows.some((r) => d.label.toLowerCase().startsWith(r.day_label.toLowerCase()))
        )
        .map((d) => d.id)
    : [];

  const seenFam = new Set();
  const seenAddr = new Set();
  const uniqueRows = [];
  let skippedDupes = 0;

  for (const r of parsed.rows) {
    const fKey = normalizeDupKey(r.family_name);
    const aKey = normalizeDupKey(r.address);
    const inPasteDup = (fKey && seenFam.has(fKey)) || (aKey && seenAddr.has(aKey));
    const inDbDup = findDuplicateHouse(r.family_name, r.address, null, replacedDayIds);
    if (inPasteDup || inDbDup) {
      skippedDupes++;
      continue;
    }
    if (fKey) seenFam.add(fKey);
    if (aKey) seenAddr.add(aKey);
    uniqueRows.push(r);
  }

  parsedImportRows = uniqueRows;
  const wrap = document.getElementById("imp-preview-wrap");
  const status = document.getElementById("imp-status");
  const saveBtn = document.getElementById("btn-geocode-save-import");

  if (!parsedImportRows.length) {
    wrap.style.display = "none";
    saveBtn.disabled = true;
    status.textContent = skippedDupes
      ? `All ${skippedDupes} row(s) were duplicates of existing families/addresses. Check "Replace existing houses" if re-importing.`
      : "No valid rows found. Tap ? Sample Format for help.";
    return;
  }

  status.textContent =
    `Detected "${parsed.delimiter === "\t" ? "TAB" : parsed.delimiter}" • ${parsedImportRows.length} unique families ready` +
    (skippedDupes ? ` (skipped ${skippedDupes} duplicate family/address)` : "") +
    ".";
  saveBtn.disabled = false;
  wrap.style.display = "block";
  wrap.innerHTML = `
    <table class="preview-table">
      <thead><tr><th>Day</th><th>Family</th><th>Address</th><th>Role</th><th>Notes</th><th></th></tr></thead>
      <tbody>
        ${parsedImportRows
          .map(
            (r, i) => `
          <tr>
            <td><input value="${escapeHtml(r.day_label)}" onchange="parsedImportRows[${i}].day_label=this.value" style="min-width:74px;" /></td>
            <td><input value="${escapeHtml(r.family_name)}" onchange="parsedImportRows[${i}].family_name=this.value" style="min-width:120px;" /></td>
            <td><input value="${escapeHtml(r.address)}" onchange="parsedImportRows[${i}].address=this.value" style="min-width:170px;" /></td>
            <td>
              <select onchange="parsedImportRows[${i}].stop_role=this.value||null">
                <option value="" ${!r.stop_role ? "selected" : ""}>—</option>
                <option value="START" ${r.stop_role === "START" ? "selected" : ""}>START</option>
                <option value="END" ${r.stop_role === "END" ? "selected" : ""}>END</option>
              </select>
            </td>
            <td><input value="${escapeHtml(r.notes)}" onchange="parsedImportRows[${i}].notes=this.value" style="min-width:110px;" /></td>
            <td><button class="mini-btn danger" onclick="removeImportPreviewRow(${i})" title="Remove row">✕</button></td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function removeImportPreviewRow(idx) {
  parsedImportRows.splice(idx, 1);
  if (!parsedImportRows.length) {
    document.getElementById("imp-preview-wrap").style.display = "none";
    document.getElementById("btn-geocode-save-import").disabled = true;
    document.getElementById("imp-status").textContent = "All rows removed.";
    return;
  }
  const wrap = document.getElementById("imp-preview-wrap");
  document.getElementById("imp-status").textContent = `${parsedImportRows.length} families ready to save.`;
  wrap.querySelectorAll("tbody tr")[idx]?.remove();
}

async function geocodeAndSaveImport() {
  if (!parsedImportRows.length || !wardPayload || !wardPayload.active_season) return;
  const status = document.getElementById("imp-status");
  const btn = document.getElementById("btn-geocode-save-import");
  const replaceDay = document.getElementById("imp-replace-day").checked;
  btn.disabled = true;

  // Group rows by day_label
  const byDay = {};
  for (let i = 0; i < parsedImportRows.length; i++) {
    const r = parsedImportRows[i];
    status.textContent = `Geocoding ${i + 1} / ${parsedImportRows.length}: ${r.family_name}...`;
    if (r.lat === null || r.lng === null) {
      const c = await window.CarolOptimizer.geocodeAddress(r.address);
      if (c) {
        r.lat = c.lat;
        r.lng = c.lng;
      }
      await new Promise((res) => setTimeout(res, 1050)); // polite Nominatim throttle
    }
    if (!byDay[r.day_label]) byDay[r.day_label] = [];
    byDay[r.day_label].push(r);
  }

  // Ensure each day exists in carol_days and save houses
  let existingDays = getDays();
  for (const [dayLabel, rows] of Object.entries(byDay)) {
    let dayObj = existingDays.find((d) => d.label.toLowerCase().startsWith(dayLabel.toLowerCase()));
    if (!dayObj) {
      const dayNum = parseInt((dayLabel.match(/\d+/) || [existingDays.length + 1])[0], 10);
      const { data: dRes } = await sbClient.rpc("admin_upsert_carol_day", {
        p_ward_id: activeWardId,
        p_admin_code: adminSession.code,
        p_season_id: wardPayload.active_season.id,
        p_day_id: null,
        p_day_number: dayNum,
        p_label: dayLabel,
        p_carol_date: null,
        p_start_time: "14:00",
        p_avg_visit_mins: 20,
        p_drive_buffer_mins: 5
      });
      dayObj = { id: dRes.day_id, label: dayLabel };
      existingDays.push(dayObj);
    }

    const withLegs = window.CarolOptimizer.recomputeLegEstimates(rows);
    await sbClient.rpc("admin_bulk_save_houses", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_season_id: wardPayload.active_season.id,
      p_carol_day_id: dayObj.id,
      p_houses: withLegs,
      p_replace_day: replaceDay
    });
  }

  await syncActiveWardOnline(true);
  btn.disabled = false;
  status.textContent = `✓ Saved ${parsedImportRows.length} families across ${Object.keys(byDay).length} carol day(s)!`;
  showToast("Bulk import & geocoding complete!");
}

function renderOptimizerList() {
  const dayId = document.getElementById("opt-day-select").value;
  optimizerDraft = getDayHouses(dayId).map((h) => ({ ...h }));
  drawOptimizerDraft();
  backfillSelectedDayIntoImporter(false);
}

function backfillSelectedDayIntoImporter(showNotice = false, useImporterDropdown = false) {
  const defaultDaySel = document.getElementById("imp-default-day");
  const optDaySel = document.getElementById("opt-day-select");
  const ta = document.getElementById("imp-textarea");
  const replaceCb = document.getElementById("imp-replace-day");
  if (!ta) return;

  let dayId = "";
  if (useImporterDropdown && defaultDaySel && defaultDaySel.selectedOptions && defaultDaySel.selectedOptions[0]) {
    dayId = defaultDaySel.selectedOptions[0].dataset.id || "";
    if (!dayId) {
      const byLabel = getDays().find((d) => d.label === defaultDaySel.value);
      if (byLabel) dayId = byLabel.id;
    }
  } else {
    dayId = (optDaySel && optDaySel.value) || activeDayId || "";
  }
  if (!dayId) return;

  const dayObj = getDays().find((d) => d.id === dayId);
  const dayShort = dayObj ? `Day ${dayObj.day_number || 1}` : "Day 1";
  const houses = getDayHouses(dayId);

  if (defaultDaySel && dayObj && !useImporterDropdown) {
    defaultDaySel.value = dayObj.label;
  }

  if (!houses.length) {
    ta.value = "";
    if (replaceCb) replaceCb.checked = false;
    document.getElementById("imp-status").textContent = `No houses yet in ${dayObj ? dayObj.label : dayShort}.`;
    if (showNotice) showToast(`No houses yet in ${dayObj ? dayObj.label : dayShort}`);
    return;
  }

  const header = "Family Name | Full Address | Carol Day | Stop Role | Phone / Notes";
  const lines = houses.map((h) => {
    const extra = [h.phone, h.notes].filter(Boolean).join(" • ");
    return `${h.family_name} | ${h.address} | ${dayShort} | ${h.stop_role || ""} | ${extra}`;
  });
  ta.value = [header, ...lines].join("\n");
  if (replaceCb) replaceCb.checked = true;
  document.getElementById("imp-preview-wrap").style.display = "none";
  document.getElementById("btn-geocode-save-import").disabled = true;
  document.getElementById("imp-status").textContent = `Loaded ${houses.length} houses from ${dayObj ? dayObj.label : dayShort} for bulk edit.`;
  if (showNotice) showToast(`Loaded ${houses.length} houses from ${dayObj ? dayObj.label : dayShort}`);
}

function clearBulkImporter() {
  const ta = document.getElementById("imp-textarea");
  const replaceCb = document.getElementById("imp-replace-day");
  if (ta) ta.value = "";
  if (replaceCb) replaceCb.checked = false;
  document.getElementById("imp-preview-wrap").style.display = "none";
  document.getElementById("btn-geocode-save-import").disabled = true;
  document.getElementById("imp-status").textContent = "Cleared — paste a new list from Excel, Sheets, or WhatsApp.";
}

function drawOptimizerDraft() {
  const el = document.getElementById("opt-list");
  if (!optimizerDraft.length) {
    el.innerHTML = `<p class="helper-text">No houses in this day yet. Paste a list below to import!</p>`;
    return;
  }
  el.innerHTML = optimizerDraft
    .map(
      (h, i) => `
      <div class="admin-item-row">
        <div class="admin-item-main">
          <div class="admin-item-name">#${i + 1} ${escapeHtml(h.family_name)} ${h.stop_role ? `<span class="role-badge ${h.stop_role === "START" ? "start" : "end"}">${h.stop_role}</span>` : ""}</div>
          <div class="admin-item-sub">${escapeHtml(h.address)}</div>
        </div>
        <div class="admin-item-btns">
          <button class="mini-btn" onclick="openEditHouseModal('${h.id}')" title="Edit">✏️</button>
          <button class="mini-btn" onclick="moveOptDraft(${i}, -1)" ${i === 0 ? "disabled" : ""} title="Move Up">▲</button>
          <button class="mini-btn" onclick="moveOptDraft(${i}, 1)" ${i === optimizerDraft.length - 1 ? "disabled" : ""} title="Move Down">▼</button>
          <button class="mini-btn danger" onclick="deleteSingleHouse('${h.id}', '${escapeJs(h.family_name)}')" title="Delete">🗑️</button>
        </div>
      </div>
    `
    )
    .join("");
}

function openEditHouseModal(houseId) {
  const h = (wardPayload && wardPayload.ward_houses || []).find((x) => x.id === houseId);
  if (!h) return;
  document.getElementById("edit-house-id").value = h.id;
  document.getElementById("edit-house-family").value = h.family_name || "";
  document.getElementById("edit-house-address").value = h.address || "";
  const daySel = document.getElementById("edit-house-day");
  if (daySel) {
    daySel.innerHTML = getDays()
      .map((d) => `<option value="${d.id}" ${d.id === h.carol_day_id ? "selected" : ""}>${escapeHtml(d.label)}</option>`)
      .join("");
  }
  document.getElementById("edit-house-role").value = h.stop_role || "";
  document.getElementById("edit-house-mins").value = h.visit_mins || 20;
  document.getElementById("edit-house-phone").value = h.phone || "";
  document.getElementById("edit-house-notes").value = h.notes || "";
  document.getElementById("edit-house-modal").classList.add("open");
}

async function saveEditedHouse() {
  const id = document.getElementById("edit-house-id").value;
  const family_name = document.getElementById("edit-house-family").value.trim();
  const address = document.getElementById("edit-house-address").value.trim();
  const newDayId = document.getElementById("edit-house-day")?.value || "";
  const stop_role = document.getElementById("edit-house-role").value || null;
  const visit_mins = Math.max(5, parseInt(document.getElementById("edit-house-mins").value, 10) || 20);
  const phone = document.getElementById("edit-house-phone").value.trim();
  const notes = document.getElementById("edit-house-notes").value.trim();

  if (!family_name || !address) return showToast("Family name & address required");

  const dup = findDuplicateHouse(family_name, address, id);
  if (dup) {
    return showToast(`Duplicate ${dup.field}: already used by ${dup.existing.family_name}`);
  }

  const existing = (wardPayload.ward_houses || []).find((x) => x.id === id);
  let lat = existing ? existing.lat : null;
  let lng = existing ? existing.lng : null;
  if (existing && (existing.address !== address || typeof lat !== "number" || typeof lng !== "number")) {
    const c = await window.CarolOptimizer.geocodeAddress(address);
    if (c) {
      lat = c.lat;
      lng = c.lng;
    }
  }

  // If Admin moved this house to a different Carol Day, move it cleanly & place at best route spot on the new day
  if (existing && newDayId && newDayId !== existing.carol_day_id && wardPayload.active_season) {
    const oldDayHouses = window.CarolOptimizer.recomputeLegEstimates(
      getDayHouses(existing.carol_day_id).filter((h) => h.id !== id)
    );
    const targetDayHouses = getDayHouses(newDayId).map((h) => ({ ...h }));
    const movedHouse = {
      ...existing,
      carol_day_id: newDayId,
      family_name,
      address,
      stop_role,
      visit_mins,
      phone,
      notes,
      lat,
      lng,
      visited: false,
      checked_in_at: null
    };

    const coords = typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
    const { insertIdx } = window.CarolOptimizer.findBestInsertionSlot(targetDayHouses, coords);
    targetDayHouses.splice(insertIdx, 0, movedHouse);
    const updatedTarget = window.CarolOptimizer.recomputeLegEstimates(targetDayHouses);

    const { data: d1 } = await sbClient.rpc("admin_bulk_save_houses", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_season_id: wardPayload.active_season.id,
      p_carol_day_id: existing.carol_day_id,
      p_houses: oldDayHouses,
      p_replace_day: true
    });
    const { data: d2 } = await sbClient.rpc("admin_bulk_save_houses", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_season_id: wardPayload.active_season.id,
      p_carol_day_id: newDayId,
      p_houses: updatedTarget,
      p_replace_day: true
    });

    if (d1 && d1.ok && d2 && d2.ok) {
      closeModal("edit-house-modal");
      await syncActiveWardOnline(true);
      broadcastPiiFreeEtaShift(newDayId, 0, new Date().toISOString());
      populateAdminControls();
      const targetLabel = (getDays().find((d) => d.id === newDayId) || {}).label || "new day";
      showToast(`Moved ${family_name} to ${targetLabel} (Stop #${insertIdx + 1})!`);
      return;
    }
    return showToast("Could not move house to the selected day.");
  }

  const { data, error } = await sbClient.rpc("admin_upsert_single_house", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_house: { id, family_name, address, stop_role, visit_mins, phone, notes, lat, lng }
  });

  if (!error && data && data.ok) {
    closeModal("edit-house-modal");
    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast(`Saved ${family_name}`);
    return;
  }

  // Automatic fallback using already-deployed admin_bulk_save_houses (replace day)
  if (existing && wardPayload.active_season) {
    const updatedDayHouses = getDayHouses(existing.carol_day_id).map((h) =>
      h.id === id ? { ...h, family_name, address, stop_role, visit_mins, phone, notes, lat, lng } : h
    );
    const { data: fbData, error: fbErr } = await sbClient.rpc("admin_bulk_save_houses", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_season_id: wardPayload.active_season.id,
      p_carol_day_id: existing.carol_day_id,
      p_houses: updatedDayHouses,
      p_replace_day: true
    });
    if (!fbErr && fbData && fbData.ok) {
      closeModal("edit-house-modal");
      await syncActiveWardOnline(true);
      populateAdminControls();
      showToast(`Saved ${family_name}`);
      return;
    }
  }

  showToast(`Save failed: ${(data && data.error) || (error && error.message) || "Error"}`);
}

async function deleteSingleHouse(houseId, familyName) {
  if (!window.confirm(`Delete "${familyName}" from this carol day?`)) return;
  const existing = (wardPayload.ward_houses || []).find((x) => x.id === houseId);

  const { data, error } = await sbClient.rpc("admin_delete_house", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_house_id: houseId
  });

  if (!error && data && data.ok) {
    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast(`Deleted ${familyName}`);
    return;
  }

  // Automatic fallback using already-deployed admin_bulk_save_houses (replace day)
  if (existing && wardPayload.active_season) {
    const remaining = window.CarolOptimizer.recomputeLegEstimates(
      getDayHouses(existing.carol_day_id).filter((h) => h.id !== houseId)
    );
    const { data: fbData, error: fbErr } = await sbClient.rpc("admin_bulk_save_houses", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_season_id: wardPayload.active_season.id,
      p_carol_day_id: existing.carol_day_id,
      p_houses: remaining,
      p_replace_day: true
    });
    if (!fbErr && fbData && fbData.ok) {
      await syncActiveWardOnline(true);
      populateAdminControls();
      showToast(`Deleted ${familyName}`);
      return;
    }
  }

  showToast(`Delete failed: ${(data && data.error) || (error && error.message) || "Error"}`);
}

async function clearAllHousesInSelectedDay() {
  const dayId = document.getElementById("opt-day-select")?.value || activeDayId;
  if (!dayId || !wardPayload || !wardPayload.active_season) {
    return showToast("Select a carol day first");
  }
  const dayObj = getDays().find((d) => d.id === dayId);
  const dayLabel = dayObj ? dayObj.label : "selected day";
  const houses = getDayHouses(dayId);
  if (!houses.length) {
    return showToast(`No houses to clear in ${dayLabel}`);
  }
  if (!window.confirm(`Delete ALL ${houses.length} house(s) in "${dayLabel}"? This cannot be undone.`)) {
    return;
  }

  const { data, error } = await sbClient.rpc("admin_bulk_save_houses", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_season_id: wardPayload.active_season.id,
    p_carol_day_id: dayId,
    p_houses: [],
    p_replace_day: true
  });

  if (!error && data && data.ok) {
    if (dayId === activeDayId && typeof stopHouseTimer === "function") {
      stopHouseTimer(true);
    }
    await syncActiveWardOnline(true);
    broadcastPiiFreeEtaShift(dayId, 0, new Date().toISOString());
    populateAdminControls();
    showToast(`🗑️ Cleared all ${houses.length} house(s) from ${dayLabel}`);
  } else {
    showToast(`Clear failed: ${(data && data.error) || (error && error.message) || "Error"}`);
  }
}

function moveOptDraft(idx, delta) {
  const target = idx + delta;
  if (target < 0 || target >= optimizerDraft.length) return;
  [optimizerDraft[idx], optimizerDraft[target]] = [optimizerDraft[target], optimizerDraft[idx]];
  optimizerDraft = window.CarolOptimizer.recomputeLegEstimates(optimizerDraft);
  drawOptimizerDraft();
}

let optimizerHadGeocodeUpdates = false;

async function runConstrainedOptimizer() {
  optimizerHadGeocodeUpdates = false;
  // Auto-geocode any house missing lat/lng (e.g., previously added unplanned stops) before 2-Opt
  const missing = optimizerDraft.filter((h) => typeof h.lat !== "number" || typeof h.lng !== "number" || Number.isNaN(h.lat) || Number.isNaN(h.lng));
  if (missing.length > 0) {
    showToast(`Locating ${missing.length} address(es) before sorting...`);
    for (const h of missing) {
      const c = await window.CarolOptimizer.geocodeAddress(h.address);
      if (c) {
        h.lat = c.lat;
        h.lng = c.lng;
        optimizerHadGeocodeUpdates = true;
      }
    }
  }
  optimizerDraft = window.CarolOptimizer.optimizeDayHouses(optimizerDraft);
  await window.CarolOptimizer.refreshRouteLegsWithTraffic(optimizerDraft, "afternoon");
  drawOptimizerDraft();
  showToast("Optimized with Afternoon Traffic! Tap Save Order.");
}

async function saveOptimizedOrder() {
  const dayId = document.getElementById("opt-day-select").value;
  if (!dayId || !optimizerDraft.length) return;

  // If any missing coordinates were resolved, persist full rows (including lat/lng) via admin_bulk_save_houses
  if (optimizerHadGeocodeUpdates && wardPayload && wardPayload.active_season) {
    const { data } = await sbClient.rpc("admin_bulk_save_houses", {
      p_ward_id: activeWardId,
      p_admin_code: adminSession.code,
      p_season_id: wardPayload.active_season.id,
      p_carol_day_id: dayId,
      p_houses: optimizerDraft,
      p_replace_day: true
    });
    if (data && data.ok) {
      optimizerHadGeocodeUpdates = false;
      await syncActiveWardOnline(true);
      broadcastPiiFreeEtaShift(dayId, 0, new Date().toISOString());
      populateAdminControls();
      showToast("Saved optimized route & map coordinates!");
    }
    return;
  }

  const { data } = await sbClient.rpc("admin_save_house_order", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_carol_day_id: dayId,
    p_ordered_houses: optimizerDraft
  });
  if (data && data.ok) {
    await syncActiveWardOnline(true);
    broadcastPiiFreeEtaShift(dayId, 0, new Date().toISOString());
    showToast("Saved locked route sequence!");
  }
}

async function moveHouseInActiveDay(index, delta) {
  const houses = getDayHouses(activeDayId);
  const target = index + delta;
  if (target < 0 || target >= houses.length) return;
  if (houses[target].stop_role === "START" || houses[target].stop_role === "END") return;
  [houses[index], houses[target]] = [houses[target], houses[index]];
  const updated = window.CarolOptimizer.recomputeLegEstimates(houses);
  await sbClient.rpc("admin_save_house_order", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_carol_day_id: activeDayId,
    p_ordered_houses: updated
  });
  await syncActiveWardOnline(true);
}

// ---------- Seasons, Settings & Security RPCs ----------

async function createNewSeason() {
  const yr = parseInt(document.getElementById("adm-new-year").value, 10);
  if (!yr) return;
  const { data } = await sbClient.rpc("admin_upsert_season", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_year: yr,
    p_name: `Christmas Carol ${yr}`,
    p_activate: true
  });
  if (data && data.ok) {
    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast(`Activated ${yr} season!`);
  }
}

async function clonePreviousYear() {
  const fromYr = wardPayload && wardPayload.active_season ? wardPayload.active_season.year : 2026;
  const toYr = parseInt(document.getElementById("adm-new-year").value, 10) || fromYr + 1;
  if (toYr === fromYr) return showToast("Pick a different target year (e.g., 2027)");

  const { data } = await sbClient.rpc("admin_clone_previous_season", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_from_year: fromYr,
    p_to_year: toYr
  });
  if (data && data.ok) {
    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast(`Cloned ${data.copied_houses} families into ${toYr}!`);
  } else {
    showToast(`Clone failed: ${data ? data.error : "Error"}`);
  }
}

async function saveAdminWardSettings() {
  const prev = (wardPayload && wardPayload.ward_settings) || {};
  const newVisitMins = Math.max(1, parseInt(document.getElementById("adm-visit-mins").value, 10) || 20);
  const oldVisitMins = Number(prev.default_visit_mins) || 20;

  const { data } = await sbClient.rpc("admin_save_ward_settings", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_settings: {
      default_visit_mins: newVisitMins,
      drive_buffer_mins: prev.drive_buffer_mins || 5,
      coordinator_name: document.getElementById("adm-coord-name").value.trim(),
      coordinator_phone: document.getElementById("adm-coord-phone").value.trim(),
      meeting_point: prev.meeting_point || "",
      instructions_banner: document.getElementById("adm-banner").value.trim()
    }
  });

  if (data && data.ok) {
    // Sync new Mins / House across all active season days & non-END houses so ETAs & Route Timer match immediately
    if (newVisitMins !== oldVisitMins && wardPayload && wardPayload.active_season) {
      const days = getDays();
      for (const d of days) {
        await sbClient.rpc("admin_upsert_carol_day", {
          p_ward_id: activeWardId,
          p_admin_code: adminSession.code,
          p_season_id: d.season_id,
          p_day_id: d.id,
          p_day_number: d.day_number,
          p_label: d.label,
          p_carol_date: d.carol_date || null,
          p_start_time: d.start_time || "14:00",
          p_avg_visit_mins: newVisitMins,
          p_drive_buffer_mins: d.drive_buffer_mins || 5
        });

        const dayHouses = getDayHouses(d.id);
        if (dayHouses.length > 0) {
          const updatedHouses = dayHouses.map((h) => ({
            ...h,
            visit_mins: h.stop_role === "END" ? h.visit_mins : newVisitMins
          }));
          await sbClient.rpc("admin_save_house_order", {
            p_ward_id: activeWardId,
            p_admin_code: adminSession.code,
            p_carol_day_id: d.id,
            p_ordered_houses: updatedHouses
          });
        }
      }

      // Reset idle timer so Hero button immediately reflects the new Mins / House
      if (!houseTimer.running) {
        localStorage.removeItem(keyHouseTimer(activeWardId));
        houseTimer.stopId = null;
      }
      broadcastPiiFreeEtaShift(activeDayId, 0, new Date().toISOString());
    }

    await syncActiveWardOnline(true);
    populateAdminControls();
    showToast(`Ward info saved (${newVisitMins}m/house synced)!`);
  }
}

// ---------- Live Message Broadcast Popup ----------

function openBroadcastModal() {
  if (!adminSession.unlocked || adminSession.wardId !== activeWardId) {
    showToast("🔐 Unlock Ward Admin first to broadcast announcements");
    openAdminModal();
    return;
  }
  document.getElementById("broadcast-text-input").value = "";
  document.getElementById("broadcast-pin-banner").checked = true;
  document.getElementById("broadcast-modal").classList.add("open");
}

function setBroadcastPreset(text) {
  document.getElementById("broadcast-text-input").value = text;
}

function showLiveBroadcastPopup(message, sentAtIso) {
  document.getElementById("live-broadcast-text").textContent = message;
  const dt = sentAtIso ? new Date(sentAtIso) : new Date();
  document.getElementById("live-broadcast-time").textContent =
    `${CFG.WARDS[activeWardId].full} • ${minutesToTimeStr(dt.getHours() * 60 + dt.getMinutes())}`;
  document.getElementById("live-broadcast-popup").classList.add("open");
  playSoftChime();
}

async function sendBroadcastMessage() {
  const message = document.getElementById("broadcast-text-input").value.trim();
  const pinBanner = document.getElementById("broadcast-pin-banner").checked;
  if (!message) return showToast("Type a message first");

  const sentAt = new Date().toISOString();

  // Broadcast live via Supabase Realtime to all connected carolers in this ward
  if (realtimeChannel) {
    realtimeChannel.send({
      type: "broadcast",
      event: "broadcast_alert",
      payload: {
        ward_id: activeWardId,
        message,
        pinned: pinBanner,
        sent_at: sentAt
      }
    });
  }

  // If Admin is unlocked & pin checked, persist banner in ward_settings
  if (pinBanner && wardPayload) {
    if (!wardPayload.ward_settings) wardPayload.ward_settings = {};
    wardPayload.ward_settings.instructions_banner = message;
    localStorage.setItem(keyOfflineRoute(activeWardId), JSON.stringify(wardPayload));
    if (adminSession.unlocked && adminSession.wardId === activeWardId && sbClient) {
      await sbClient.rpc("admin_save_ward_settings", {
        p_ward_id: activeWardId,
        p_admin_code: adminSession.code,
        p_settings: { ...wardPayload.ward_settings, instructions_banner: message }
      });
    }
    render();
  }

  closeModal("broadcast-modal");
  showLiveBroadcastPopup(message, sentAt);
  showToast("📢 Broadcast sent to all connected devices!");
}

function generateRandomPin() {
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  document.getElementById("sec-new-user-code").value = pin;
}

async function resetWardUserCode() {
  const newCode = document.getElementById("sec-new-user-code").value.trim();
  if (newCode.length < 4) return showToast("Code must be at least 4 characters");
  const { data } = await sbClient.rpc("reset_ward_user_code", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_new_code: newCode
  });
  if (data && data.ok) {
    localStorage.setItem(keyUserCode(activeWardId), newCode);
    showToast(`Ward User Code reset (v${data.user_code_version})! Old devices revoked.`);
  } else {
    showToast(`Reset failed: ${data ? data.error : "Error"}`);
  }
}

function copyWhatsAppWardInvite() {
  const code = document.getElementById("sec-new-user-code").value.trim() || localStorage.getItem(keyUserCode(activeWardId)) || "[CODE]";
  const w = CFG.WARDS[activeWardId];
  const groupName = (wardPayload && wardPayload.ward_settings && wardPayload.ward_settings.whatsapp_group_name) || w.defaultWaGroup;
  const link = `${CFG.publicBaseUrl}?ward=${activeWardId}`;
  const msg = `🎄 *St. Mary's Christmas Carol - Schedule and route*\n${w.full}\n\n📲 Open App: ${link}\n🔑 Ward Access Code: *${code}*\n\n(Enter once on your phone & tap Add to Home Screen for live ETAs, Navigation & Songbook!)`;
  copyText(msg, `Copied! Select "${groupName}" in WhatsApp`);
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
}

async function rotateWardAdminCode() {
  const newCode = document.getElementById("sec-new-admin-code").value.trim();
  if (newCode.length < 6) return showToast("Admin code must be at least 6 characters");
  const { data } = await sbClient.rpc("rotate_ward_admin_code", {
    p_ward_id: activeWardId,
    p_admin_code: adminSession.code,
    p_new_code: newCode
  });
  if (data && data.ok) {
    adminSession.code = newCode;
    document.getElementById("sec-new-admin-code").value = "";
    showToast("Ward Admin Code rotated securely!");
  } else {
    showToast(`Failed: ${data ? data.error : "Error"}`);
  }
}

// ---------- User Settings & Utilities ----------

function openSettingsModal() {
  document.getElementById("cfg-nav-app").value = prefs.primaryNavApp || "google";
  document.getElementById("cfg-wakelock").value = prefs.autoWakeLock ? "on" : "off";
  document.getElementById("settings-modal").classList.add("open");
}

function saveUserSettings() {
  prefs.primaryNavApp = document.getElementById("cfg-nav-app").value;
  prefs.autoWakeLock = document.getElementById("cfg-wakelock").value === "on";
  savePrefs();

  if (prefs.autoWakeLock) acquireWakeLockIfEnabled();
  else releaseWakeLock();

  closeModal("settings-modal");
  render();
  showToast("Settings saved");
}

// Close ANY open modal/popup or Full Screen Map with Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (mapFullscreen) {
      toggleMapFullscreen();
      return;
    }
    document.querySelectorAll(".modal-backdrop.open").forEach((m) => {
      if (m.id === "songbook-modal") closeSongbookModal();
      else m.classList.remove("open");
    });
  }
});

function openFormatHelpModal() {
  document.getElementById("format-help-modal").classList.add("open");
}

function copySampleImportFormat() {
  const sample = document.getElementById("sample-format-box").value;
  document.getElementById("imp-textarea").value = sample;
  copyText(sample, "Sample pasted into importer!");
  closeModal("format-help-modal");
}

function togglePasswordVisibility(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  if (btnEl) btnEl.textContent = showing ? "👁️" : "🙈";
}

function toggleSnapshot() {
  snapshotOpen = !snapshotOpen;
  document.getElementById("snapshot-bar").classList.toggle("expanded", snapshotOpen);
  document.getElementById("snapshot-chevron").textContent = snapshotOpen ? "Hide Map ▴" : "Show Map ▾";
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
    return;
  }
  if (!("geolocation" in navigator)) return showToast("GPS not available");
  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      btn.classList.add("gps-active");
      btn.textContent = "📍 GPS ON";
      render();
    },
    () => showToast("Location permission denied"),
    { enableHighAccuracy: true, maximumAge: 15000 }
  );
}

function handleSearchInput(v) {
  searchQuery = (v || "").trim().toLowerCase();
  document.getElementById("search-clear").classList.toggle("visible", searchQuery.length > 0);
  render();
}
function clearSearch() {
  searchQuery = "";
  document.getElementById("search-input").value = "";
  document.getElementById("search-clear").classList.remove("visible");
  render();
}
function jumpToStop(id) {
  const el = document.getElementById(`card-${id}`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}
function copyText(text, toastMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  if (toastMsg) showToast(toastMsg);
}
function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}
function closeOnBackdrop(e, id) {
  if (e.target.id === id) {
    if (id === "songbook-modal") closeSongbookModal();
    else closeModal(id);
  }
}
window.escapeHtml = function (str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
};
function escapeJs(str) {
  return String(str || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
window.showToast = function (msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(window._tt);
  window._tt = setTimeout(() => t.classList.remove("show"), 2600);
};

// Boot App
updateInstallBarVisibility();
bootActiveWard();
