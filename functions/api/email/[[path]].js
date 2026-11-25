/**
 * Club email worker (Cloudflare Pages Function), triggered every few minutes
 * by a Supabase pg_cron job that POSTs to /api/email/run with a shared secret.
 *
 * POST /api/email/run  { "secret": "<EMAIL_CRON_SECRET>" }
 *
 * 1. Sends pending gift emails (immediate or send_on date reached) via Resend.
 * 2. Sends expiry reminders to gifted members: 14 days out, 2 days out,
 *    and a final email on expiry (which flips the member to status 'expired').
 *
 * Environment variables (Cloudflare Pages → Settings → Environment variables):
 *   EMAIL_CRON_SECRET       — shared secret with the Supabase cron job
 *   RESEND_API_KEY          — Resend API key (resend.com → API Keys)
 *   RESEND_FROM             — optional; defaults to club@campbellk9s.com
 *   SUPABASE_URL            — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key for reads/writes
 */

const SITE_URL = "https://campbellk9s.com";
const DEFAULT_FROM = "Clearer Dogs Club <club@campbellk9s.com>";
const TWO_WEEKS_MS = 14 * 86400000;
const TWO_DAYS_MS = 2 * 86400000;

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

async function resendSend(env, { to, subject, text }) {
  const key = env.RESEND_API_KEY;
  if (!key) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || DEFAULT_FROM,
      to: [to],
      subject,
      text,
    }),
  });
  return { ok: res.ok, status: res.status };
}

function giftEmailText(token, termMonths) {
  return `You've been gifted a ${termMonths}-month membership to Clearer Dogs Club by Campbell K9s!

Your gift includes:
- Live Q&As with Matt
- Video submissions with personalized replies
- Access to the private Facebook community

To start your membership, create your account here:
${SITE_URL}/clearer-dogs-club/login/?gift=${token}

Your ${termMonths}-month membership begins the day you create your account, so there's no rush — but we can't wait to meet your dog.

Clearer communication. Better behavior. A better life with your dog.`;
}

const REMINDER_EMAILS = {
  "14d": {
    subject: "Your Clearer Dogs Club gift membership ends in 2 weeks",
    text: `Your gifted membership to Clearer Dogs Club ends in two weeks.

Want to keep everything you've been working on? Continue your membership any time:
- Monthly — $29/month
- Annual — $290/year (two months free)

Subscribe at ${SITE_URL}/clearer-dogs-club/ and your access continues without interruption.

Clearer communication. Better behavior. A better life with your dog.`,
  },
  "2d": {
    subject: "Your Clearer Dogs Club gift membership ends in 2 days",
    text: `Just a heads up — your gifted membership to Clearer Dogs Club ends in two days.

If you'd like to keep your access to live Q&As, video submissions, and the private community, you can subscribe at any time:
${SITE_URL}/clearer-dogs-club/

Clearer communication. Better behavior. A better life with your dog.`,
  },
  expired: {
    subject: "Your Clearer Dogs Club gift membership has ended",
    text: `Your gifted membership to Clearer Dogs Club has come to an end. Thank you for being part of the club!

If you'd like to keep your access to live Q&As, video submissions, and the private Facebook community, you can subscribe any time:
${SITE_URL}/clearer-dogs-club/

Clearer communication. Better behavior. A better life with your dog.`,
  },
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname !== "/api/email/run" && url.pathname !== "/api/email/run/") {
    return json({ error: "Not found" }, 404);
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const secret = env.EMAIL_CRON_SECRET;
  if (!secret) {
    return json({ error: "EMAIL_CRON_SECRET not configured" }, 503);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  if (payload.secret !== secret) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!supabaseEnabled(env)) {
    return json({ error: "Supabase not configured" }, 503);
  }

  const sentGifts = [];
  const sentReminders = [];
  const errors = [];

  // 1. Pending gift emails (immediate rows have send_on = purchase time)
  const now = new Date().toISOString();
  const giftLookup = await supabaseFetch(
    env,
    `gifts?email_status=eq.pending&send_on=lte.${encodeURIComponent(now)}&select=id,gift_token,recipient_email,term_months`
  );
  const pendingGifts = Array.isArray(giftLookup?.data) ? giftLookup.data : [];
  for (const gift of pendingGifts) {
    if (!gift.gift_token || !gift.recipient_email) continue;
    const result = await resendSend(env, {
      to: gift.recipient_email,
      subject: "You've been gifted a Clearer Dogs Club membership!",
      text: giftEmailText(gift.gift_token, gift.term_months || 3),
    });
    if (result.ok) {
      sentGifts.push(gift.recipient_email);
      await supabaseFetch(env, `gifts?id=eq.${gift.id}`, {
        method: "PATCH",
        body: { email_status: "sent", sent_at: now },
        headers: { Prefer: "return=minimal" },
      });
    } else {
      errors.push(`gift ${gift.recipient_email}: ${result.error || "resend failed"}`);
    }
  }

  // 2. Expiry reminders for gifted members
  const memberLookup = await supabaseFetch(
    env,
    "members?role=eq.gifted&status=eq.active&select=id,email,gift_expires_at,reminder_stage"
  );
  const giftedMembers = Array.isArray(memberLookup?.data) ? memberLookup.data : [];
  for (const member of giftedMembers) {
    if (!member.gift_expires_at) continue;
    const msLeft = new Date(member.gift_expires_at).getTime() - Date.now();
    const stage = member.reminder_stage || "";

    let kind = null;
    if (msLeft <= 0 && stage !== "expired") kind = "expired";
    else if (msLeft <= TWO_DAYS_MS && stage !== "2d" && stage !== "expired") kind = "2d";
    else if (msLeft <= TWO_WEEKS_MS && stage !== "14d" && stage !== "2d" && stage !== "expired")
      kind = "14d";

    if (!kind) continue;

    const template = REMINDER_EMAILS[kind];
    const result = await resendSend(env, {
      to: member.email,
      subject: template.subject,
      text: template.text,
    });
    if (result.ok) {
      sentReminders.push({ email: member.email, kind });
      const patch = { reminder_stage: kind };
      if (kind === "expired") patch.status = "expired";
      await supabaseFetch(env, `members?id=eq.${member.id}`, {
        method: "PATCH",
        body: patch,
        headers: { Prefer: "return=minimal" },
      });
    } else {
      errors.push(`reminder ${member.email}: ${result.error || "resend failed"}`);
    }
  }

  return json({
    ok: true,
    sentGifts,
    sentReminders,
    errors,
    at: now,
  });
}
