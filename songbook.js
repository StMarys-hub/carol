/* Carol Songbook Module:
 * - Add Song panel on TOP + Full-Width Lyrics
 * - madely.us Lyrics + Audio-Only Karaoke Track detection (via Edge Function or r.jina.ai fallback)
 * - Strict Audio-Only inline HTML5 player (ZERO video UI, shown ONLY when audio track exists)
 * - Auto-pauses on song switch or modal close
 */

window.CarolSongbook = (function () {
  let activeIdx = 0;
  let fontScale = 1.08;
  let audioEl = null;

  function ensureAudio() {
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.preload = "metadata";
      audioEl.addEventListener("timeupdate", syncAudioUI);
      audioEl.addEventListener("loadedmetadata", syncAudioUI);
      audioEl.addEventListener("ended", () => {
        syncAudioUI();
      });
      audioEl.addEventListener("error", () => {
        const bar = document.getElementById("karaoke-player-bar");
        if (bar) bar.style.display = "none";
      });
    }
    return audioEl;
  }

  function stopAudio() {
    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.currentTime = 0;
      } catch (e) {}
    }
    syncAudioUI();
  }

  function fmtSec(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function syncAudioUI() {
    const playBtn = document.getElementById("karaoke-play-btn");
    const range = document.getElementById("karaoke-scrubber");
    const timeEl = document.getElementById("karaoke-time");
    if (!playBtn || !range || !timeEl || !audioEl) return;

    playBtn.textContent = audioEl.paused ? "▶ Play" : "⏸ Pause";
    const dur = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0;
    const cur = Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : 0;
    range.max = dur ? String(Math.floor(dur)) : "100";
    range.value = dur ? String(Math.floor(cur)) : "0";
    timeEl.textContent = `${fmtSec(cur)} / ${fmtSec(dur)}`;
  }

  function togglePlay() {
    const a = ensureAudio();
    if (!a.src) return;
    if (a.paused) {
      a.play().catch(() => {
        window.showToast && window.showToast("Could not play karaoke track");
      });
    } else {
      a.pause();
    }
    syncAudioUI();
  }

  function seekTo(val) {
    const a = ensureAudio();
    if (Number.isFinite(a.duration) && a.duration > 0) {
      a.currentTime = Math.min(a.duration, Math.max(0, Number(val) || 0));
      syncAudioUI();
    }
  }

  function render(songs, isAdmin) {
    const list = songs && songs.length ? songs : window.CAROL_APP_CONFIG.DEFAULT_SONGS;
    if (activeIdx >= list.length) activeIdx = 0;

    const tabsEl = document.getElementById("song-tabs");
    const boxEl = document.getElementById("song-lyrics-box");
    const delBtn = document.getElementById("btn-delete-song");
    const karaokeBar = document.getElementById("karaoke-player-bar");

    if (tabsEl) {
      tabsEl.innerHTML = list
        .map(
          (s, idx) =>
            `<button class="song-tab ${idx === activeIdx ? "active" : ""}" onclick="CarolSongbook.select(${idx})">${window.escapeHtml(s.title)}${s.karaoke_audio_url ? " 🎵" : ""}</button>`
        )
        .join("");
    }

    const current = list[activeIdx];
    if (boxEl) {
      boxEl.style.fontSize = `${fontScale}rem`;
      boxEl.textContent = current.lyrics || "";
    }

    if (delBtn) {
      const canDelete = !String(current.id || "").startsWith("builtin-") && (isAdmin || current.localOnly);
      delBtn.style.display = canDelete ? "inline-flex" : "none";
    }

    // Conditional Audio-Only Karaoke Bar (strictly hidden if no audio URL)
    const trackUrl = (current.karaoke_audio_url || "").trim();
    if (karaokeBar) {
      if (trackUrl && /^https?:\/\//i.test(trackUrl)) {
        const a = ensureAudio();
        if (a.src !== trackUrl) {
          stopAudio();
          a.src = trackUrl;
        }
        karaokeBar.style.display = "flex";
        syncAudioUI();
      } else {
        stopAudio();
        karaokeBar.style.display = "none";
      }
    }
  }

  function select(idx) {
    stopAudio();
    activeIdx = idx;
    if (window.renderCurrentSongbook) window.renderCurrentSongbook();
  }

  function adjustFont(delta) {
    fontScale = Math.min(1.65, Math.max(0.85, fontScale + delta));
    const boxEl = document.getElementById("song-lyrics-box");
    if (boxEl) boxEl.style.fontSize = `${fontScale}rem`;
  }

  function cleanExtractedMarkdown(rawMarkdown) {
    let title = "";
    const titleMatch = rawMarkdown.match(/^Title:\s*(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1]
        .replace(/\s*[-|–—]\s*MADELY.*$/i, "")
        .replace(/\s*(Malayalam\s*(&|and)\s*Manglish|Malayalam|Manglish|Christian\s+Devotional\s+Song|Song)?\s*Lyrics.*$/i, "")
        .trim();
    }

    // Detect any direct audio track URL in the markdown/links (strictly audio extensions, zero video)
    let karaoke_audio_url = "";
    const audioMatch = rawMarkdown.match(/(https?:\/\/[^\s)"'<>]+\.(?:mp3|m4a|ogg|wav)(?:\?[^\s)"'<>]*)?)/i);
    if (audioMatch) karaoke_audio_url = audioMatch[1];

    let body = rawMarkdown;
    const contentIdx = body.indexOf("Markdown Content:");
    if (contentIdx !== -1) body = body.slice(contentIdx + "Markdown Content:".length);

    const stopMarkers = [
      /\n###\s*Media\b/i,
      /\n###\s*Related\b/i,
      /\n###\s*Comments\b/i,
      /\n###\s*Leave a Reply\b/i
    ];
    for (const marker of stopMarkers) {
      const m = body.search(marker);
      if (m !== -1) body = body.slice(0, m);
    }

    body = body
      .replace(/!\[Image\s*\d*:\s*([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .replace(/\[\]\([^)]+\)/g, "")
      .replace(/^[\s|]*A\s+A\s+A\s*$/gm, "")
      .replace(/^\*\*My Notes\*\*\s*$/gim, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^\*\*([MFA])\*\*\s*/gm, "[$1] ")
      .replace(/^#{1,6}\s*(.+)$/gm, "\n--- $1 ---")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .split(/\r?\n/)
      .map((line) => line.replace(/^\|+\s*$/, "").trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return { title, lyrics: body, karaoke_audio_url };
  }

  async function fetchFromUrl(url) {
    const creds = window.getSupabaseCredentials();
    // 1. Try Supabase Edge Function first if Supabase is configured
    if (creds.url && creds.anonKey) {
      try {
        const resp = await fetch(`${creds.url}/functions/v1/madely-lyrics`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creds.anonKey}`,
            apikey: creds.anonKey
          },
          body: JSON.stringify({ url })
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.ok && data.lyrics && data.lyrics.length > 20) {
            return {
              title: data.title || "",
              lyrics: data.lyrics,
              karaoke_audio_url: data.karaoke_audio_url || ""
            };
          }
        }
      } catch (e) {}
    }

    // 2. Fallback to CORS-friendly reader proxy
    const resp = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: "text/plain" } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.text();
    const parsed = cleanExtractedMarkdown(raw);
    if (!parsed.lyrics || parsed.lyrics.length < 20) {
      throw new Error("Could not extract lyrics from that page");
    }
    return parsed;
  }

  return {
    render,
    select,
    adjustFont,
    stopAudio,
    togglePlay,
    seekTo,
    fetchFromUrl,
    getActiveIdx: () => activeIdx,
    setActiveIdx: (i) => {
      stopAudio();
      activeIdx = i;
    }
  };
})();
