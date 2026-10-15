/**
 * Campbell K9s — live-status endpoint (Cloudflare Pages Function)
 *
 * GET /api/live → { "live": true, "channel": "Facebook", "url": "..." }
 *               or { "live": false }
 *
 * The homepage banner swaps to "Join us Live on {channel} now" while any
 * channel is live. Detection order:
 *   1. Manual override (covers Instagram & TikTok, whose APIs don't expose
 *      live status to third parties):
 *        LIVE_CHANNEL = e.g. "Instagram" or "TikTok"
 *        LIVE_URL     = the live/link URL to send viewers to
 *      Set both when a stream starts, clear them when it ends.
 *   2. Facebook: automatic check of the page's live videos when
 *      FACEBOOK_PAGE_ID and FACEBOOK_PAGE_TOKEN (a long-lived page token
 *      with live_videos read access) are configured.
 *
 * Results are cached in memory for 60 seconds per isolate.
 */

const CACHE_MS = 60_000;
let cached = { at: 0, value: null };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30",
    },
  });
}

async function facebookLive(pageId, pageToken) {
  const url =
    "https://graph.facebook.com/v21.0/" +
    encodeURIComponent(pageId) +
    "/live_videos?broadcast_status%5B%5D=LIVE&access_token=" +
    encodeURIComponent(pageToken);
  const res = await fetch(url);
  const body = await res.json();
  if (res.ok && Array.isArray(body.data) && body.data.length > 0) {
    return {
      live: true,
      channel: "Facebook",
      url: `https://www.facebook.com/${encodeURIComponent(pageId)}/live`,
    };
  }
  return null;
}

async function detectLive(env) {
  // 1. Manual override — highest priority.
  if (env.LIVE_CHANNEL && env.LIVE_URL) {
    return { live: true, channel: env.LIVE_CHANNEL, url: env.LIVE_URL };
  }

  // 2. Facebook live videos.
  if (env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_TOKEN) {
    try {
      const live = await facebookLive(env.FACEBOOK_PAGE_ID, env.FACEBOOK_PAGE_TOKEN);
      if (live) return live;
    } catch {
      // Fall through to "not live" — never block the banner on an API hiccup.
    }
  }

  return { live: false };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.pathname !== "/api/live" && url.pathname !== "/api/live/") {
    return json({ error: "Not found" }, 404);
  }
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (cached.at > Date.now() - CACHE_MS) return json(cached.value);

  const result = await detectLive(env);
  cached = { at: Date.now(), value: result };
  return json(result);
}
