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
 *   RESEND_API_KEY              — Resend API key for member/admin emails
 *   RESEND_FROM                 — optional; defaults to club@campbellk9s.com
 *   ADMIN_NOTIFY_EMAILS         — optional; comma-separated admin notification list
 */

const DEFAULT_CLIENT_ID =
  "BAAR5KkkPPj_ww0WaN7omC0pOswi3kpyf58KCrrxh5xv5w2nk0oNu2hqJ6tns-9ca6pIgW1HTocksKyx-c";

const MONTHLY_PRICE_USD = 29;
const GIFT_TERM_PRICE_USD = { "3": 87, "6": 174, "12": 348 };
const MULTI_GIFT_DISCOUNT = 0.2;
const MAX_GIFT_RECIPIENTS = 6;

const SITE_URL = "https://campbellk9s.com";
const FACEBOOK_GROUP_URL = "https://www.facebook.com/groups/2537830806698266";
const DEFAULT_ADMIN_EMAILS = [
  "andrew@polychlorinated.com",
  "k9campbellmatt@gmail.com",
  "campbelltrans@gmail.com",
];

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

async function resendSend(env, { to, subject, text }) {
  const key = env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY not configured" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || "Clearer Dogs Club <club@campbellk9s.com>",
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
    }),
  });
  return { ok: res.ok, status: res.status };
}

function adminEmails(env) {
  if (env.ADMIN_NOTIFY_EMAILS) {
    const list = env.ADMIN_NOTIFY_EMAILS.split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return DEFAULT_ADMIN_EMAILS;
}

async function notifyAdmins(env, subject, text) {
  const to = adminEmails(env);
  if (to.length === 0) return { ok: true, skipped: true };
  return resendSend(env, { to, subject, text });
}

const WELCOME_EMAIL = {
  subject: "Welcome to Clearer Dogs Club!",
  text: `Welcome to Clearer Dogs Club — your membership is active!

You're all set. Here's how to get started:
1. Join the private Facebook group: ${FACEBOOK_GROUP_URL}
2. Introduce yourself — tell us your dog's name, breed, age, and one thing you'd love to improve.
3. Bring your questions to the live Q&As and send in videos any time.

Member home: ${SITE_URL}/clearer-dogs-club/home/

Clearer communication. Better behavior. A better life with your dog.`,
};

const CANCELLATION_EMAIL = {
  subject: "Your Clearer Dogs Club subscription has been canceled",
  text: `Your Clearer Dogs Club subscription has been canceled.

You'll keep full access to the club and the private Facebook group until the end of your current billing period. No further payments will be taken.

If you change your mind, you're welcome back any time:
${SITE_URL}/clearer-dogs-club/

Clearer communication. Better behavior. A better life with your dog.`,
};

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
    const withOwnMembership = payload.withOwnMembership === true;
    const recipients = Array.isArray(payload.recipients)
      ? payload.recipients
          .map((email) => (typeof email === "string" ? email.trim().toLowerCase() : ""))
          .filter(Boolean)
      : [];

    if (!GIFT_TERM_PRICE_USD[term]) {
      return json({ error: "Choose a gift term of 3, 6, or 12 months" }, 400);
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
    const giftDiscount = withOwnMembership
      ? Math.round(giftsBase * MULTI_GIFT_DISCOUNT * 100) / 100
      : 0;
    const total = Math.round((giftsBase - giftDiscount) * 100) / 100;

    const description = withOwnMembership
      ? `Clearer Dogs Club gift membership — ${term} months × ${recipients.length} (20% off, combined with own membership)`
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
    const createdGifts = [];
    if (capture && supabaseEnabled(env)) {
      const giftTerm = Number(payload.term);
      const recipients = Array.isArray(payload.recipients)
        ? payload.recipients
            .map((email) =>
              typeof email === "string" ? email.trim().toLowerCase() : ""
            )
            .filter((email) => EMAIL_RE.test(email))
        : [];
      const giftUnitPrice = GIFT_TERM_PRICE_USD[giftTerm] || null;
      const emailMode = payload.emailMode === "scheduled" ? "scheduled" : "immediate";
      const sendOn =
        emailMode === "scheduled" && payload.sendOn
          ? `${String(payload.sendOn).slice(0, 10)}T09:00:00`
          : new Date().toISOString();

      if (giftTerm && recipients.length > 0) {
        for (const recipientEmail of recipients) {
          const created = await supabaseFetch(env, "gifts", {
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
              email_mode: emailMode,
              send_on: sendOn,
              email_status: "pending",
              created_at: new Date().toISOString(),
            },
            headers: { Prefer: "return=representation" },
          });
          const rows = Array.isArray(created?.data) ? created.data : [];
          const row = rows[0];
          createdGifts.push({
            recipient_email: recipientEmail,
            gift_token: row?.gift_token || null,
          });
        }
      }
    }
    return json({
      ok: true,
      status: capture?.status || "COMPLETED",
      gifts: createdGifts,
    });
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
    let existingRole = null;
    if (supabaseEnabled(env)) {
      const fields = {
        supabase_user_id: userId || null,
        paypal_subscription_id: subId,
        plan: PLAN_LABELS[sub.plan_id] || sub.plan_id,
        role: "member",
        status: "active",
        updated_at: new Date().toISOString(),
      };
      const lookup = await supabaseFetch(
        env,
        `members?email=eq.${encodeURIComponent(email)}&select=id,role`
      );
      const rows = Array.isArray(lookup?.data) ? lookup.data : [];
      if (rows.length > 0) {
        existingRole = rows[0].role || null;
        const res = await supabaseFetch(env, `members?email=eq.${encodeURIComponent(email)}`, {
          method: "PATCH",
          body: fields,
          headers: { Prefer: "return=minimal" },
        });
        stored = Boolean(res && res.status < 300);
      } else {
        const res = await supabaseFetch(env, "members", {
          method: "POST",
          body: { email, ...fields },
          headers: { Prefer: "return=minimal" },
        });
        stored = Boolean(res && res.status < 300);
      }

      const isNewMember = existingRole === null;
      const isUpgrade = existingRole === "gifted";

      const giftLookup = await supabaseFetch(
        env,
        `gifts?payer_email=eq.${encodeURIComponent(email)}&select=recipient_email,term_months`
      );
      const gifts = Array.isArray(giftLookup?.data) ? giftLookup.data : [];
      const giftsLine =
        gifts.length > 0
          ? gifts
              .map(
                (gift) =>
                  `  - ${gift.term_months || "?"}-month gift for ${gift.recipient_email}`
              )
              .join("\n")
          : "  - No gift purchases";

      if (isNewMember) {
        await resendSend(env, { to: email, ...WELCOME_EMAIL });
        await notifyAdmins(
          env,
          `New Clearer Dogs Club member: ${email}`,
          `A new member just joined.\n\nEmail: ${email}\nPlan: ${PLAN_LABELS[sub.plan_id] || sub.plan_id}\n\nGift subscriptions purchased:\n${giftsLine}`
        );
      } else if (isUpgrade) {
        await notifyAdmins(
          env,
          `Gifted member upgraded to paying: ${email}`,
          `A gifted member just subscribed on their own.\n\nEmail: ${email}\nPlan: ${PLAN_LABELS[sub.plan_id] || sub.plan_id}\n\nGift subscriptions purchased:\n${giftsLine}`
        );
      }
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

    const subscriberEmail = (lookup.data?.subscriber?.email_address || "").toLowerCase();
    if (subscriberEmail) {
      await resendSend(env, { to: subscriberEmail, ...CANCELLATION_EMAIL });
      await notifyAdmins(
        env,
        `Member canceled subscription: ${subscriberEmail}`,
        `A member just canceled their subscription.\n\nEmail: ${subscriberEmail}\nSubscription: ${subId}`
      );
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
