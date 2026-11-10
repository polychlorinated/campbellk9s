/**
 * Campbell K9s — email capture endpoint (Cloudflare Pages Function)
 *
 * POST /api/newsletter  { "email": "name@example.com" }
 *   → forwards to the n8n webhook and returns { "ok": true }
 *
 * The webhook URL is set via the NEWSLETTER_WEBHOOK_URL env variable
 * (Cloudflare Pages → Settings → Environment variables). The fallback
 * below is the current n8n test webhook; replace it when the form is
 * finalized.
 */

const DEFAULT_WEBHOOK_URL =
  "https://n8n.srv725961.hstgr.cloud/webhook-test/c40db083-85c6-416c-bdc4-5d01c845a45f";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  if (url.pathname !== "/api/newsletter" && url.pathname !== "/api/newsletter/") {
    return json({ error: "Not found" }, 404);
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let email;
  try {
    ({ email } = await request.json());
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  email = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: "Please enter a valid email address" }, 400);
  }

  const webhookUrl = env.NEWSLETTER_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        source: "campbellk9s.com email capture popup",
        submittedAt: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      return json({ error: "Unable to subscribe right now" }, 502);
    }
  } catch {
    return json({ error: "Unable to subscribe right now" }, 502);
  }

  return json({ ok: true });
}
