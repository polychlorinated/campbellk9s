/**
 * PayPal helpers for Clearer Dogs Club (Cloudflare Pages Function).
 *
 * Routes:
 *   GET  /api/paypal/config              — public client ID + pricing
 *   POST /api/paypal/create-gift-order   — gift checkout order (20% off gifts
 *                                          purchased alongside own membership)
 *   POST /api/paypal/capture-gift-order  — capture after approval, store gift
 *   POST /api/paypal/claim-subscription  — verify subscription, link member record
 *   POST /api/paypal/cancel-subscription — cancel a monthly/annual subscription
 *   POST /api/paypal/webhook             — BILLING.SUBSCRIPTION.CANCELLED events
 *
 * Environment variables (Cloudflare Pages → Settings → Environment variables):
 *   PAYPAL_CLIENT_ID            — REST app client ID (defaults to button-factory ID)
 *   PAYPAL_CLIENT_SECRET        — REST app secret (required for server calls)
 *   PAYPAL_ENVIRONMENT          — "live" (default) or "sandbox"
 *   PAYPAL_WEBHOOK_ID           — optional; enables webhook signature verification
 *   SUPABASE_URL                — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY   — service role key for member/gift records
 */

const DEFAULT_CLIENT_ID =
  "BAAR5KkkPPj_ww0WaN7omC0pOswi3kpyf58KCrrxh5xv5w2nk0oNu2hqJ6tns-9ca6pIgW1HTocksKyx-c";

const MONTHLY_PRICE_USD = 29;
const GIFT_TERM_PRICE_USD = { "3": 87, "6": 174, "12": 348 };
const MULTI_GIFT_DISCOUNT = 0.2;
const MAX_GIFT_RECIPIENTS = 6;

const PLAN_LABELS = {
  "P-49X93781TM5637923NMDPZZY": "monthly",
  "P-2AB676142G348520JNMDPZZY": "annual",
};

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

function apiBase(env) {
  return (env.PAYPAL_ENVIRONMENT || "live").toLowerCase() === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";
}

function clientId(env) {
  return env.PAYPAL_CLIENT_ID || DEFAULT_CLIENT_ID;
}

function supabaseEnabled(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

async function paypalFetch(env, path, { method = "GET", body } = {}) {
  const secret = env.PAYPAL_CLIENT_SECRET;
  if (!secret) {
    return json(
      {
        error:
          "PayPal API credentials are not configured. Set PAYPAL_CLIENT_SECRET in Cloudflare Pages environment variables.",
      },
      503
    );
  }
  const tokenRes = await fetch(`${apiBase(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${clientId(env)}:${secret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!tokenRes.ok) {
    return json({ error: "PayPal authentication failed. Check the API credentials." }, 502);
  }
  const tokenData = await tokenRes.json();

  const res = await fetch(`${apiBase(env)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokenData.access_token}`,
      "content-type": "application/json",
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

function crc32(str) {
  let crc = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, "") || "/";

  const paths = {
    "/api/paypal": () => json({ ok: true }),
    "/api/paypal/config": () =>
      json({
        clientId: clientId(env),
        environment: (env.PAYPAL_ENVIRONMENT || "live").toLowerCase(),
        monthlyPriceUsd: MONTHLY_PRICE_USD,
        giftTermsUsd: GIFT_TERM_PRICE_USD,
        multiGiftDiscount: MULTI_GIFT_DISCOUNT,
      }),
  };

  if (paths[route] && request.method === "GET") {
    return paths[route]();
  }
  if (route === "/api/paypal/config" && request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (route === "/api/paypal/plans") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const result = await paypalFetch(env, "/v1/billing/plans?page_size=20");
    if (result.status && result.status >= 400) {
      return json(
        { error: "Could not list PayPal plans. Check PAYPAL_CLIENT_SECRET." },
        502
      );
    }
    const plans = (result.data?.plans || []).map((plan) => ({
      id: plan.id,
      name: plan.name,
      status: plan.status,
    }));
    return json({ app: clientId(env), plans });
  }

  if (route === "/api/paypal/create-gift-order") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }

    const term = Number(payload.term);
    const ownTerm = payload.ownTerm ? Number(payload.ownTerm) : null;
    const recipients = Array.isArray(payload.recipients)
      ? payload.recipients
          .map((email) => (typeof email === "string" ? email.trim().toLowerCase() : ""))
          .filter(Boolean)
      : [];

    if (!GIFT_TERM_PRICE_USD[term]) {
      return json({ error: "Choose a gift term of 3, 6, or 12 months" }, 400);
    }
    if (ownTerm && !GIFT_TERM_PRICE_USD[ownTerm]) {
      return json(
        { error: "Choose an own-membership term of 3 or 6 months" },
        400
      );
    }
    if (
      recipients.length < 1 ||
      recipients.length > MAX_GIFT_RECIPIENTS ||
      recipients.some((email) => !EMAIL_RE.test(email) || email.length > 254)
    ) {
      return json(
        {
          error: `Enter a valid email for each gift recipient (1–${MAX_GIFT_RECIPIENTS} recipients)`,
        },
        400
      );
    }

    const giftsBase = GIFT_TERM_PRICE_USD[term] * recipients.length;
    const ownPrice = ownTerm ? GIFT_TERM_PRICE_USD[ownTerm] : 0;
    const giftDiscount = ownTerm
      ? Math.round(giftsBase * MULTI_GIFT_DISCOUNT * 100) / 100
      : 0;
    const total = Math.round((ownPrice + giftsBase - giftDiscount) * 100) / 100;

    const description = ownTerm
      ? `Clearer Dogs Club — own membership (${ownTerm} months) + ${term}-month gift × ${recipients.length} (gifts 20% off)`
      : `Clearer Dogs Club gift membership — ${term} months × ${recipients.length}`;

    const result = await paypalFetch(env, "/v2/checkout/orders", {
      method: "POST",
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            description,
            amount: { currency_code: "USD", value: total.toFixed(2) },
          },
        ],
        application_context: {
          brand_name: "Campbell K9s",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
        },
      },
    });
    if (result.status && result.status >= 400) {
      const message =
        result.data && (result.data.message || result.data.details?.[0]?.issue)
          ? "PayPal: " + (result.data.message || result.data.details[0].issue)
          : "Could not create the PayPal order";
      return json({ error: message }, 502);
    }
    return json({ id: result.data.id, total: total.toFixed(2) });
  }

  if (route === "/api/paypal/capture-gift-order") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }
    const orderId = typeof payload.orderId === "string" ? payload.orderId.trim() : "";
    if (!orderId) return json({ error: "Missing order ID" }, 400);

    const result = await paypalFetch(env, `/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      body: {},
    });
    if (result.status && result.status >= 400) {
      const message =
        result.data && result.data.message
          ? "PayPal: " + result.data.message
          : "Could not capture the PayPal payment";
      return json({ error: message }, 502);
    }

    const capture = result.data?.purchase_units?.[0]?.payments?.captures?.[0];
    const payerEmail = result.data?.payer?.email_address || "";
    if (capture && supabaseEnabled(env)) {
      const giftTerm = Number(payload.term);
      const ownTerm = payload.ownTerm ? Number(payload.ownTerm) : null;
      const recipients = Array.isArray(payload.recipients)
        ? payload.recipients
            .map((email) =>
              typeof email === "string" ? email.trim().toLowerCase() : ""
            )
            .filter((email) => EMAIL_RE.test(email))
        : [];
      const giftUnitPrice = GIFT_TERM_PRICE_USD[giftTerm]
        ? Math.round(
            (GIFT_TERM_PRICE_USD[giftTerm] * (ownTerm ? 0.8 : 1)) * 100
          ) / 100
        : null;

      if (giftTerm && recipients.length > 0) {
        for (const recipientEmail of recipients) {
          await supabaseFetch(env, "gifts", {
            method: "POST",
            body: {
              paypal_order_id: orderId,
              paypal_capture_id: capture.id,
              payer_email: payerEmail.toLowerCase(),
              recipient_email: recipientEmail,
              term_months: giftTerm,
              amount: giftUnitPrice,
              currency: capture.amount?.currency_code || "USD",
              status: capture.status === "COMPLETED" ? "paid" : "pending",
              created_at: new Date().toISOString(),
            },
            headers: { Prefer: "return=minimal" },
          });
        }
      }

      if (ownTerm && payerEmail) {
        await supabaseFetch(env, "members?on_conflict=email", {
          method: "POST",
          body: {
            email: payerEmail.toLowerCase(),
            supabase_user_id: null,
            paypal_subscription_id: null,
            plan: `term_${ownTerm}m`,
            status: "active",
            updated_at: new Date().toISOString(),
          },
          headers: { Prefer: "return=minimal" },
        });
      }
    }
    return json({ ok: true, status: capture?.status || "COMPLETED" });
  }

  if (route === "/api/paypal/claim-subscription") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }
    const subId = typeof payload.subId === "string" ? payload.subId.trim() : "";
    const email =
      typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const userId = typeof payload.userId === "string" ? payload.userId.trim() : "";
    if (!subId || !EMAIL_RE.test(email)) {
      return json({ error: "Missing subscription ID or email address" }, 400);
    }

    const result = await paypalFetch(env, `/v1/billing/subscriptions/${subId}`);
    if (result.status && result.status >= 400) {
      return json({ error: "Could not verify the subscription with PayPal" }, 502);
    }
    const sub = result.data;
    const status = sub?.status || "";
    const payerEmail = (sub?.subscriber?.email_address || "").toLowerCase();
    if (status !== "ACTIVE") {
      return json({ error: `The subscription is not active (status: ${status})` }, 409);
    }
    if (payerEmail && payerEmail !== email) {
      return json(
        { error: "This subscription belongs to a different email address" },
        403
      );
    }

    let stored = false;
    if (supabaseEnabled(env)) {
      const record = {
        email,
        supabase_user_id: userId || null,
        paypal_subscription_id: subId,
        plan: PLAN_LABELS[sub.plan_id] || sub.plan_id,
        status: "active",
        updated_at: new Date().toISOString(),
      };
      const upsert = await supabaseFetch(env, "members?on_conflict=email", {
        method: "POST",
        body: record,
        headers: { Prefer: "return=minimal" },
      });
      stored = Boolean(upsert && upsert.status < 300);
    }
    return json({ ok: true, stored, plan: PLAN_LABELS[sub.plan_id] || sub.plan_id });
  }

  if (route === "/api/paypal/cancel-subscription") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }
    const subId = typeof payload.subId === "string" ? payload.subId.trim() : "";
    if (!subId) return json({ error: "Enter your subscription ID" }, 400);

    const lookup = await paypalFetch(env, `/v1/billing/subscriptions/${subId}`);
    if (lookup.status && lookup.status >= 400) {
      return json({ error: "Could not find that subscription with PayPal" }, 502);
    }
    const status = lookup.data?.status || "";
    if (status === "CANCELLED" || status === "EXPIRED") {
      return json({ error: `The subscription is already ${status.toLowerCase()}` }, 409);
    }

    const cancel = await paypalFetch(env, `/v1/billing/subscriptions/${subId}/cancel`, {
      method: "POST",
      body: { reason: "Member requested cancellation from Clearer Dogs Club" },
    });
    if (cancel.status && cancel.status >= 400) {
      const message =
        cancel.data && cancel.data.message
          ? "PayPal: " + cancel.data.message
          : "PayPal could not cancel the subscription";
      return json({ error: message }, 502);
    }

    if (supabaseEnabled(env)) {
      await supabaseFetch(env, `members?paypal_subscription_id=eq.${subId}`, {
        method: "PATCH",
        body: { status: "canceled", updated_at: new Date().toISOString() },
        headers: { Prefer: "return=minimal" },
      });
    }
    return json({ ok: true });
  }

  if (route === "/api/paypal/webhook") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const rawBody = await request.text();

    const webhookId = env.PAYPAL_WEBHOOK_ID;
    if (webhookId) {
      const transmissionId = request.headers.get("paypal-transmission-id") || "";
      const transmissionTime = request.headers.get("paypal-transmission-time") || "";
      const signature = request.headers.get("paypal-transmission-sig") || "";
      const expected = crc32(
        `${transmissionId}|${transmissionTime}|${webhookId}|${rawBody}`
      )
        .toString(16)
        .padStart(8, "0");
      if (signature.toLowerCase() !== expected) {
        return json({ error: "Invalid webhook signature" }, 401);
      }
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return json({ error: "Invalid webhook payload" }, 400);
    }

    if (event.event_type === "BILLING.SUBSCRIPTION.CANCELLED") {
      const subId = event.resource?.id;
      if (subId && supabaseEnabled(env)) {
        await supabaseFetch(env, `members?paypal_subscription_id=eq.${subId}`, {
          method: "PATCH",
          body: { status: "canceled", updated_at: new Date().toISOString() },
          headers: { Prefer: "return=minimal" },
        });
      }
    }

    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}
