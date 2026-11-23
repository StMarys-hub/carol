/* Carol Songbook Module:
 * - Add Song panel on TOP + Full-Width Lyrics
 * - madely.us Lyrics + Karaoke Track detection (direct MP3/M4A OR YouTube URL)
 * - Strict Audio-Only inline Karaoke bar (ZERO visible video player/thumbnail):
 *     * Direct MP3/M4A/OGG/WAV -> HTML5 Audio
 *     * YouTube URL (youtube.com / youtu.be) -> Hidden off-screen YT.Player audio-only host
 * - Conditionally shown ONLY when a song has a valid audio/YouTube karaoke URL
 * - Auto-pauses on song switch or modal close
 */

window.CarolSongbook = (function () {
  let activeIdx = 0;
  let fontScale = 1.08;

  // HTML5 Audio state
  let audioEl = null;

  // Hidden YouTube Audio-Only state
  let mode = "none"; // "html5" | "youtube" | "none"
  let currentYtId = "";
  let currentSongTitle = "Carol Karaoke";
  let ytPlayer = null;
  let ytReady = false;
  let ytApiLoading = false;
  let ytPendingPlay = false;
  let ytPollId = null;

  function updateMediaSession(isPlaying) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentSongTitle || "Christmas Carol Karaoke",
        artist: "St. Mary's Syro Malabar Catholic Church",
        album: "Christmas Carol Songbook",
        artwork: [
          { src: "./icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "./icons/icon-512.png", sizes: "512x512", type: "image/png" }
        ]
      });
      navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
      navigator.mediaSession.setActionHandler("play", () => {
        if (mode === "html5" && audioEl) audioEl.play().catch(() => {});
        else if (mode === "youtube" && ytPlayer && ytReady) ytPlayer.playVideo();
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        if (mode === "html5" && audioEl) audioEl.pause();
        else if (mode === "youtube" && ytPlayer && ytReady) ytPlayer.pauseVideo();
      });
      navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (details && typeof details.seekTime === "number") seekTo(details.seekTime);
      });
    } catch (e) {}
  }

  function extractYouTubeId(url) {
    if (!url || typeof url !== "string") return "";
    const patterns = [
      /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/i
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m && m[1]) return m[1];
    }
    return "";
  }

  function ensureHiddenYtHost() {
    let host = document.getElementById("carol-yt-audio-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "carol-yt-audio-host";
      host.setAttribute("aria-hidden", "true");
      host.style.cssText =
        "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;";
      const inner = document.createElement("div");
      inner.id = "carol-yt-player-slot";
      host.appendChild(inner);
      document.body.appendChild(host);
    }
    return host;
  }

  function loadYouTubeApiIfNeeded(videoId) {
    ensureHiddenYtHost();
    if (window.YT && window.YT.Player) {
      initOrCueYtPlayer(videoId);
      return;
    }
    if (!ytApiLoading) {
      ytApiLoading = true;
      const prevCb = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prevCb === "function") prevCb();
        if (currentYtId) initOrCueYtPlayer(currentYtId);
      };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      document.head.appendChild(tag);
    }
  }

  function initOrCueYtPlayer(videoId) {
    if (!videoId || !(window.YT && window.YT.Player)) return;
    if (ytPlayer && ytReady) {
      try {
        ytPlayer.cueVideoById(videoId);
        if (ytPendingPlay) {
          ytPendingPlay = false;
          ytPlayer.playVideo();
        }
      } catch (e) {}
      syncAudioUI();
      return;
    }
    if (ytPlayer) return;

    ytPlayer = new window.YT.Player("carol-yt-player-slot", {
      width: "1",
      height: "1",
      videoId,
      playerVars: {
        autoplay: 0,
        controls: 0,
        rel: 0,
        playsinline: 1,
        modestbranding: 1,
        origin: window.location.origin
      },
      events: {
        onReady: () => {
          ytReady = true;
          if (ytPendingPlay) {
            ytPendingPlay = false;
            try { ytPlayer.playVideo(); } catch (e) {}
          }
          syncAudioUI();
        },
        onStateChange: (ev) => {
          if (ev.data === window.YT.PlayerState.PLAYING) {
            startYtPoll();
          } else {
            stopYtPoll();
          }
          syncAudioUI();
        },
        onError: () => {
          stopYtPoll();
          window.showToast && window.showToast("This YouTube track blocks embedded audio playback");
          syncAudioUI();
        }
      }
    });
  }

  function startYtPoll() {
    stopYtPoll();
    ytPollId = setInterval(syncAudioUI, 500);
  }
  function stopYtPoll() {
    if (ytPollId) {
      clearInterval(ytPollId);
      ytPollId = null;
    }
  }

  function ensureHtml5Audio() {
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.preload = "metadata";
      audioEl.addEventListener("timeupdate", syncAudioUI);
      audioEl.addEventListener("loadedmetadata", syncAudioUI);
      audioEl.addEventListener("ended", syncAudioUI);
      audioEl.addEventListener("error", () => {
        if (mode === "html5") {
          const bar = document.getElementById("karaoke-player-bar");
          if (bar) bar.style.display = "none";
        }
      });
    }
    return audioEl;
  }

  function stopAudio() {
    ytPendingPlay = false;
    stopYtPoll();
    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.currentTime = 0;
      } catch (e) {}
    }
    if (ytPlayer && ytReady) {
      try {
        ytPlayer.pauseVideo();
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
    if (!playBtn || !range || !timeEl) return;

    if (mode === "youtube") {
      let playing = false;
      let dur = 0;
      let cur = 0;
      if (ytPlayer && ytReady) {
        try {
          const st = ytPlayer.getPlayerState();
          playing = st === window.YT.PlayerState.PLAYING || st === window.YT.PlayerState.BUFFERING;
          dur = Number(ytPlayer.getDuration()) || 0;
          cur = Number(ytPlayer.getCurrentTime()) || 0;
        } catch (e) {}
      }
      playBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
      range.max = dur ? String(Math.floor(dur)) : "100";
      range.value = dur ? String(Math.floor(cur)) : "0";
      timeEl.textContent = `${fmtSec(cur)} / ${fmtSec(dur)}`;
      updateMediaSession(playing);
      return;
    }

    if (mode === "html5" && audioEl) {
      const playing = !audioEl.paused;
      playBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
      const dur = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0;
      const cur = Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : 0;
      range.max = dur ? String(Math.floor(dur)) : "100";
      range.value = dur ? String(Math.floor(cur)) : "0";
      timeEl.textContent = `${fmtSec(cur)} / ${fmtSec(dur)}`;
      updateMediaSession(playing);
    }
  }

  function togglePlay() {
    if (mode === "youtube") {
      if (!currentYtId) return;
      if (!ytPlayer || !ytReady) {
        ytPendingPlay = true;
        loadYouTubeApiIfNeeded(currentYtId);
        window.showToast && window.showToast("Loading karaoke audio...");
        return;
      }
      try {
        const st = ytPlayer.getPlayerState();
        if (st === window.YT.PlayerState.PLAYING) {
          ytPlayer.pauseVideo();
        } else {
          ytPlayer.playVideo();
        }
      } catch (e) {}
      syncAudioUI();
      return;
    }

    if (mode === "html5") {
      const a = ensureHtml5Audio();
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
  }

  function seekTo(val) {
    const targetSec = Math.max(0, Number(val) || 0);
    if (mode === "youtube" && ytPlayer && ytReady) {
      try {
        ytPlayer.seekTo(targetSec, true);
        syncAudioUI();
      } catch (e) {}
      return;
    }
    if (mode === "html5" && audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
      audioEl.currentTime = Math.min(audioEl.duration, targetSec);
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
    currentSongTitle = current.title || "Christmas Carol Karaoke";
    if (boxEl) {
      boxEl.style.fontSize = `${fontScale}rem`;
      boxEl.textContent = current.lyrics || "";
    }

    if (delBtn) {
      const canDelete = !String(current.id || "").startsWith("builtin-") && (isAdmin || current.localOnly);
      delBtn.style.display = canDelete ? "inline-flex" : "none";
    }

    // Conditional Audio-Only Karaoke Bar (direct audio OR YouTube audio-only; strictly hidden if none)
    const trackUrl = (current.karaoke_audio_url || "").trim();
    if (karaokeBar) {
      const ytId = extractYouTubeId(trackUrl);
      if (ytId) {
        if (mode !== "youtube" || currentYtId !== ytId) {
          stopAudio();
          mode = "youtube";
          currentYtId = ytId;
          loadYouTubeApiIfNeeded(ytId);
        }
        karaokeBar.style.display = "flex";
        syncAudioUI();
      } else if (trackUrl && /^https?:\/\//i.test(trackUrl)) {
        const a = ensureHtml5Audio();
        if (mode !== "html5" || a.src !== trackUrl) {
          stopAudio();
          mode = "html5";
          currentYtId = "";
          a.src = trackUrl;
        }
        karaokeBar.style.display = "flex";
        syncAudioUI();
      } else {
        stopAudio();
        mode = "none";
        currentYtId = "";
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

    // Detect direct audio URL OR YouTube karaoke URL anywhere in the page (including Media section)
    let karaoke_audio_url = "";
    const audioMatch = rawMarkdown.match(/(https?:\/\/[^\s)"'<>]+\.(?:mp3|m4a|ogg|wav)(?:\?[^\s)"'<>]*)?)/i);
    if (audioMatch) {
      karaoke_audio_url = audioMatch[1];
    } else {
      const ytMatch = rawMarkdown.match(/(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s)"'<>]*v=[A-Za-z0-9_-]{11}|youtu\.be\/[A-Za-z0-9_-]{11}))/i);
      if (ytMatch) karaoke_audio_url = ytMatch[1];
    }

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
