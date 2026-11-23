// Supabase Edge Function: CORS-safe madely.us Lyrics + Audio-Only Karaoke Extractor
// Deploy: supabase functions deploy madely-lyrics --no-verify-jwt

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function stripHtmlToLyrics(html: string): { title: string; lyrics: string; karaoke_audio_url: string } {
  // 1. Extract Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = titleMatch ? titleMatch[1].replace(/&amp;/g, "&").replace(/&#8211;|&ndash;/g, "-") : "";
  const title = rawTitle
    .replace(/\s*[-|–—]\s*MADELY.*$/i, "")
    .replace(/\s*(Malayalam\s*(&|and)\s*Manglish|Malayalam|Manglish|Christian\s+Devotional\s+Song|Song)?\s*Lyrics.*$/i, "")
    .trim();

  // 2. Detect Audio-Only Karaoke/Instrumental Track (strictly audio formats, zero video)
  let karaoke_audio_url = "";
  const audioPatterns = [
    /<audio[^>]*>[\s\S]*?src=["'](https?:\/\/[^"']+\.(?:mp3|m4a|ogg|wav|aac)(?:\?[^"']*)?)["']/i,
    /<source[^>]*src=["'](https?:\/\/[^"']+\.(?:mp3|m4a|ogg|wav|aac)(?:\?[^"']*)?)["']/i,
    /href=["'](https?:\/\/[^"']*(?:karaoke|track|instrumental|audio)[^"']*\.(?:mp3|m4a|ogg|wav|aac)(?:\?[^"']*)?)["']/i,
    /(https?:\/\/[^\s"'<>]+\.(?:mp3|m4a|ogg|wav)(?:\?[^\s"'<>]*)?)/i
  ];
  for (const pat of audioPatterns) {
    const m = html.match(pat);
    if (m && m[1]) {
      karaoke_audio_url = m[1];
      break;
    }
  }

  // 3. Extract main article/entry content
  let body = html;
  const contentMatch =
    html.match(/<div[^>]*class=["'][^"']*entry-content[^"']*["'][^>]*>([\s\S]*?)<\/article>/i) ||
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (contentMatch) body = contentMatch[1];

  // Remove script, style, iframe (never video), nav, form
  body = body
    .replace(/<(script|style|iframe|video|noscript|nav|form|svg)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<img[^>]*alt=["']([^"']*🎵[^"']*)["'][^>]*>/gi, "$1")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|h4|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  // Trim trailing Media/Related/Comments boilerplate
  const cutMarkers = [/\n\s*Media\s*\n/i, /\n\s*Related\s+/i, /\n\s*Leave a Reply/i];
  for (const cm of cutMarkers) {
    const idx = body.search(cm);
    if (idx > 80) body = body.slice(0, idx);
  }

  const lyrics = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, lyrics, karaoke_audio_url };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return new Response(JSON.stringify({ ok: false, error: "INVALID_URL" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; StMarysCarolBot/1.0)" }
    });
    if (!resp.ok) {
      return new Response(JSON.stringify({ ok: false, error: `UPSTREAM_${resp.status}` }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const html = await resp.text();
    const extracted = stripHtmlToLyrics(html);

    return new Response(JSON.stringify({ ok: true, ...extracted }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
});
