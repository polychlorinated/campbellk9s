/**
 * Campbell K9s — digital-delivery fulfillment (Cloudflare Pages Function)
 *
 * Delivery mapping is implicit: an R2 object whose key starts with
 * "<SQUARE_CATALOG_ITEM_ID>." is the downloadable file for that Square item.
 * No item↔file configuration exists — to add a new ebook, upload a file
 * named after the catalog item ID (e.g. "AB12CD34EF.pdf") to the R2 bucket.
 *
 * Routes (served under /api/delivery/):
 *   POST /api/delivery/resolve
 *     Body: { "orderId": "..." } (from the Square payment.updated webhook)
 *       or { "paymentId" | "transactionId": "..." } (from the /shop redirect),
 *       plus optional "expirySeconds" (clamped to 30 days; default 1 day).
 *     Verifies the order/payment is COMPLETED against Square, resolves line
 *     items to catalog item IDs, lists matching R2 objects, and returns
 *     signed, expiring download URLs.
 *
 *   GET /api/delivery/file?key=<r2 key>&token=<signed>&name=<display name>
 *     Streams the file from the R2 `DOWNLOADS` binding when the token
 *     signature and expiry check out. `name` is optional and only affects
 *     the Content-Disposition filename.
 *
 * Token format: "<key>|<expSeconds>|<hex HMAC-SHA256 of <expSeconds>>"
 * signed with DOWNLOAD_SECRET. n8n never mints tokens — it consumes the
 * URLs returned by /resolve.
 *
 * Runtime env vars:
 *   SQUARE_ACCESS_TOKEN  — Square personal access token (shared with /api/square/*)
 *   SQUARE_ENVIRONMENT   — "production" (default) | "sandbox"
 *   DOWNLOAD_SECRET      — secret used to sign download tokens
 *   DOWNLOADS            — Cloudflare Pages R2 bucket binding holding the files
 */

const SQUARE_VERSION = "2025-09-17";
const MAX_EXPIRY_SECONDS = 60 * 60 * 24 * 30; // 30 days
const DEFAULT_EXPIRY_SECONDS = 60 * 60 * 24; // 1 day
const RESOLVE_CACHE_MS = 10 * 60 * 1000;
const ALLOWED_EXTENSIONS = ["pdf", "epub"];

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function baseUrl(env) {
  return env.SQUARE_ENVIRONMENT === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

function squareHeaders(env) {
  return {
    Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
    "Square-Version": SQUARE_VERSION,
    "Content-Type": "application/json",
  };
}

function squareError(body, status, fallback) {
  const details = body?.errors
    ?.map((e) => `${e.code ?? "UNKNOWN"}${e.detail ? `: ${e.detail}` : ""}`)
    .join("; ");
  const err = new Error(details || `${fallback} (${status})`);
  err.status = status;
  return err;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signToken(env, key, expirySeconds) {
  const exp = String(Math.floor(Date.now() / 1000) + expirySeconds);
  const sig = await hmacHex(env.DOWNLOAD_SECRET, exp);
  return `${key}|${exp}|${sig}`;
}

async function verifyToken(env, key, token) {
  const [tokenKey, expRaw, sigRaw] = String(token || "").split("|");
  if (!tokenKey || !expRaw || !sigRaw) return false;
  if (tokenKey !== key) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(env.DOWNLOAD_SECRET, expRaw);
  return expected === sigRaw;
}

function extensionOf(key) {
  const match = /\.([a-z0-9]+)$/i.exec(key);
  return match ? match[1].toLowerCase() : "";
}

// PDF first so the email attachment prefers it over companion formats.
function pdfFirst(a, b) {
  const aPdf = extensionOf(a) === "pdf" ? 0 : 1;
  const bPdf = extensionOf(b) === "pdf" ? 0 : 1;
  return aPdf - bPdf || a.localeCompare(b);
}

// Claims are stateless (the order is re-verified), but a short memory cache
// avoids hammering Square on every page reload.
const resolveCache = new Map();

function cacheGet(id) {
  const entry = resolveCache.get(id);
  if (entry && entry.exp > Date.now()) return entry.result;
  return undefined;
}

function cacheSet(id, result) {
  resolveCache.set(id, { result, exp: Date.now() + RESOLVE_CACHE_MS });
}

async function resolveOrderId(env, orderId, expirySeconds) {
  const cached = cacheGet(orderId);
  if (cached) return cached;
  const result = await resolveOrderIdUncached(env, orderId, expirySeconds);
  cacheSet(orderId, result);
  return result;
}

async function resolveOrderIdUncached(env, orderId, expirySeconds) {
  const token = env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error("SQUARE_ACCESS_TOKEN is not configured");
  const secret = env.DOWNLOAD_SECRET;
  if (!secret) throw new Error("DOWNLOAD_SECRET is not configured");
  if (!env.DOWNLOADS || typeof env.DOWNLOADS.list !== "function") {
    throw new Error("Downloads storage is not configured");
  }
  const base = baseUrl(env);

  // 1. Fetch the order and confirm it is paid in full.
  const orderRes = await fetch(
    `${base}/v2/orders/${encodeURIComponent(orderId)}`,
    { headers: squareHeaders(env) }
  );
  const orderBody = await orderRes.json();
  if (!orderRes.ok) throw squareError(orderBody, orderRes.status, "Order lookup failed");
  const order = orderBody.order;
  if (!order || order.state !== "COMPLETED") {
    return { files: [], reason: "order not completed" };
  }

  // 2. Map line items (variation ids + names) to catalog item ids.
  const lineItems = (order.line_items || []).filter(
    (li) => typeof li.catalog_object_id === "string"
  );
  if (lineItems.length === 0) return { files: [], reason: "no catalog line items" };

  const batchRes = await fetch(`${base}/v2/catalog/batch-retrieve-catalog-objects`, {
    method: "POST",
    headers: squareHeaders(env),
    body: JSON.stringify({
      object_ids: lineItems.map((li) => li.catalog_object_id),
    }),
  });
  const batchBody = await batchRes.json();
  if (!batchRes.ok)
    throw squareError(batchBody, batchRes.status, "Catalog resolution failed");

  const variationItemIds = new Map();
  for (const obj of batchBody.objects || []) {
    if (obj.type === "ITEM_VARIATION" && obj.item_variation_data?.item_id) {
      variationItemIds.set(obj.id, obj.item_variation_data.item_id);
    }
  }

  // 3. Group purchased variations by catalog item id, keeping the line-item
  //    display name for friendly download labels.
  const items = new Map(); // itemId -> { name }
  for (const li of lineItems) {
    const itemId = variationItemIds.get(li.catalog_object_id);
    if (!itemId || items.has(itemId)) continue;
    items.set(itemId, { name: li.name || "Download" });
  }

  // 4. Any R2 objects keyed "<itemId>.<ext>" are that item's deliverables.
  const files = [];
  for (const [itemId, meta] of items) {
    const listed = await env.DOWNLOADS.list({ prefix: `${itemId}.` });
    for (const object of listed.objects || []) {
      const ext = extensionOf(object.key);
      if (!ALLOWED_EXTENSIONS.includes(ext)) continue;
      files.push({
        key: object.key,
        name: `${meta.name} (${ext.toUpperCase()})`,
        url: `/api/delivery/file?key=${encodeURIComponent(
          object.key
        )}&token=${encodeURIComponent(
          await signToken(env, object.key, expirySeconds)
        )}&name=${encodeURIComponent(`${meta.name} (${ext.toUpperCase()})`)}`,
      });
    }
  }
  files.sort((a, b) => pdfFirst(a.key, b.key));
  return { files };
}

async function handleResolve(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON" }, 400);
  }

  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  const paymentId =
    typeof body?.paymentId === "string"
      ? body.paymentId
      : typeof body?.transactionId === "string"
        ? body.transactionId
        : "";

  const requestedExpiry = Number(body?.expirySeconds) || 0;
  const expirySeconds = Math.max(
    0,
    Math.min(requestedExpiry || DEFAULT_EXPIRY_SECONDS, MAX_EXPIRY_SECONDS)
  );

  try {
    let targetOrderId = orderId;

    // The /shop redirect only knows the payment id — resolve it to an order.
    if (!targetOrderId) {
      if (!/^[A-Za-z0-9_-]{4,}$/.test(paymentId)) {
        return json({ error: "An orderId or paymentId is required" }, 400);
      }
      const token = env.SQUARE_ACCESS_TOKEN;
      if (!token) throw new Error("SQUARE_ACCESS_TOKEN is not configured");
      const cached = cacheGet(paymentId);
      if (cached) return cached;
      const payRes = await fetch(
        `${baseUrl(env)}/v2/payments/${encodeURIComponent(paymentId)}`,
        { headers: squareHeaders(env) }
      );
      const payBody = await payRes.json();
      if (!payRes.ok) throw squareError(payBody, payRes.status, "Payment lookup failed");
      const payment = payBody.payment;
      if (!payment || payment.status !== "COMPLETED") {
        const result = { files: [], reason: "payment not completed" };
        cacheSet(paymentId, result);
        return result;
      }
      targetOrderId = payment.order_id;
      if (!targetOrderId) {
        const result = { files: [], reason: "no order attached" };
        cacheSet(paymentId, result);
        return result;
      }
      const result = await resolveOrderId(env, targetOrderId, expirySeconds);
      cacheSet(paymentId, result);
      return result;
    }

    if (!/^[A-Za-z0-9_-]{4,}$/.test(targetOrderId)) {
      return json({ error: "A valid orderId is required" }, 400);
    }
    return json(await resolveOrderId(env, targetOrderId, expirySeconds));
  } catch (err) {
    return json({ error: err?.message || "Resolve failed" }, err?.status || 502);
  }
}

async function handleFile(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  const token = url.searchParams.get("token") || "";
  const name = url.searchParams.get("name") || "";

  if (!env.DOWNLOADS || typeof env.DOWNLOADS.get !== "function") {
    return json({ error: "Downloads storage is not configured" }, 503);
  }
  if (!env.DOWNLOAD_SECRET) {
    return json({ error: "Download delivery is not configured" }, 503);
  }
  if (!/^[A-Za-z0-9_-]{4,}\.[a-z0-9]{1,8}$/i.test(key)) {
    return json({ error: "Invalid file key" }, 400);
  }
  if (!ALLOWED_EXTENSIONS.includes(extensionOf(key))) {
    return json({ error: "Unknown file type" }, 404);
  }
  if (!(await verifyToken(env, key, token))) {
    return json({ error: "Invalid or expired download link" }, 403);
  }

  const object = await env.DOWNLOADS.get(key);
  if (!object) return json({ error: "File not found" }, 404);

  const safeName = /^[A-Za-z0-9 _(),&.-]{1,120}$/.test(name) ? name : key;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-disposition", `attachment; filename="${safeName}"`);
  headers.set("cache-control", "private, no-store");
  return new Response(object.body, { headers });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const segments = url.pathname
    .replace(/^\/api\/delivery\/?/, "")
    .split("/")
    .filter(Boolean);
  const route = segments[0] || "";

  try {
    if (route === "resolve" && request.method === "POST") {
      return await handleResolve(request, env);
    }
    if (route === "file" && request.method === "GET") {
      return await handleFile(request, env);
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json(
      { error: err?.message || "Unexpected delivery error" },
      err?.status || 502
    );
  }
}
