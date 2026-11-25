/**
 * Club member endpoints (Cloudflare Pages Function).
 *
 * POST /api/club/claim-gift  { "token": "<gift_token>", "email": "...", "userId": "..." }
 *   Redeems a gifted membership: marks the gift row redeemed and creates or
 *   updates the member row with role 'gifted', status 'active', and a
 *   gift_expires_at of now + the gift term. The term only starts when the
 *   recipient creates their account, so expiry reminders stay accurate.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const TOKEN_RE = /^[0-9a-fA-F-]{36}$/;
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

function supabaseEnabled(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

async function supabaseFetch(env, tablePath, { method = "GET", body, headers = {} } = {}) {
  if (!supabaseEnabled(env)) return null;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${tablePath}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, data };
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result.toISOString();
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname !== "/api/club/claim-gift" && url.pathname !== "/api/club/claim-gift/") {
    return json({ error: "Not found" }, 404);
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!supabaseEnabled(env)) {
    return json({ error: "Supabase not configured" }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const userId = typeof payload.userId === "string" ? payload.userId.trim() : "";

  if (!TOKEN_RE.test(token)) {
    return json({ error: "Invalid gift token" }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return json({ error: "Invalid email address" }, 400);
  }

  const lookup = await supabaseFetch(
    env,
    `gifts?gift_token=eq.${token}&select=id,gift_token,recipient_email,term_months,redeemed_at`
  );
  const rows = Array.isArray(lookup?.data) ? lookup.data : [];
  const gift = rows[0];
  if (!gift) {
    return json({ error: "Gift not found" }, 404);
  }
  if (gift.redeemed_at) {
    return json({ error: "This gift has already been redeemed" }, 409);
  }
  if (
    gift.recipient_email &&
    gift.recipient_email.toLowerCase() !== email
  ) {
    return json({ error: "This gift belongs to a different email address" }, 403);
  }

  const termMonths = Number(gift.term_months) || 3;
  const giftExpiresAt = addMonths(new Date(), termMonths);
  const now = new Date().toISOString();

  await supabaseFetch(env, `gifts?id=eq.${gift.id}`, {
    method: "PATCH",
    body: { redeemed_at: now, email_status: "redeemed" },
    headers: { Prefer: "return=minimal" },
  });

  const memberLookup = await supabaseFetch(
    env,
    `members?email=eq.${encodeURIComponent(email)}&select=id`
  );
  const memberRows = Array.isArray(memberLookup?.data) ? memberLookup.data : [];
  const fields = {
    email,
    supabase_user_id: userId || null,
    role: "gifted",
    status: "active",
    gift_token: gift.gift_token,
    gift_expires_at: giftExpiresAt,
    reminder_stage: null,
    updated_at: now,
  };
  let stored = false;
  if (memberRows.length > 0) {
    const res = await supabaseFetch(env, `members?email=eq.${encodeURIComponent(email)}`, {
      method: "PATCH",
      body: fields,
      headers: { Prefer: "return=minimal" },
    });
    stored = Boolean(res && res.status < 300);
  } else {
    const res = await supabaseFetch(env, "members", {
      method: "POST",
      body: fields,
      headers: { Prefer: "return=minimal" },
    });
    stored = Boolean(res && res.status < 300);
  }

  return json({ ok: true, stored, termMonths, giftExpiresAt });
}
