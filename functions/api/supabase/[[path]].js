/**
 * Supabase runtime config for Clearer Dogs Club (Cloudflare Pages Function).
 *
 * GET /api/supabase/config → { configured, url, anonKey }
 *
 * The anon key is public by design — it is scoped by RLS policies.
 * Environment variables (Cloudflare Pages → Settings → Environment variables):
 *   SUPABASE_URL      — e.g. https://<project-ref>.supabase.co
 *   SUPABASE_ANON_KEY — the publishable "anon" key
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname !== "/api/supabase/config" && url.pathname !== "/api/supabase/config/") {
    return json({ error: "Not found" }, 404);
  }
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
  return json({
    configured,
    url: env.SUPABASE_URL || null,
    anonKey: env.SUPABASE_ANON_KEY || null,
  });
}
