/**
 * Campbell K9s — Square storefront proxy (Cloudflare Pages Function)
 *
 * Routes (served under /api/square/):
 *   GET  /api/square/catalog   → normalized product list from Square's Catalog API
 *   POST /api/square/checkout  → creates a Square-hosted checkout link for one variation
 *
 * Runtime environment variables (Cloudflare Pages → Settings → Environment
 * variables, or a local `.dev.vars` file for `wrangler pages dev`):
 *   SQUARE_ACCESS_TOKEN      — Square personal access token (required)
 *   SQUARE_ENVIRONMENT       — "production" (default) | "sandbox"
 *   SQUARE_LOCATION_ID       — optional; auto-discovered from the first active location
 *   SQUARE_ASK_FOR_SHIPPING  — "true" to ask buyers for a shipping address at checkout
 */

const SQUARE_VERSION = "2025-09-17";
const CATALOG_TTL_SECONDS = 300;
const CHECKOUT_REDIRECT_URL = "https://campbellk9s.com/shop/?checkout=complete";

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

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function squareErrorMessage(body, status) {
  const details = body?.errors
    ?.map((e) => `${e.code ?? "UNKNOWN"}${e.detail ? `: ${e.detail}` : ""}`)
    .join("; ");
  return details || `Square API error (${status})`;
}

function squareError(body, status, fallback) {
  const err = new Error(squareErrorMessage(body, status) || fallback);
  err.status = status;
  return err;
}

let cachedLocationId = null;

async function getLocationId(env) {
  if (env.SQUARE_LOCATION_ID) return env.SQUARE_LOCATION_ID;
  if (cachedLocationId) return cachedLocationId;
  const res = await fetch(`${baseUrl(env)}/v2/locations`, {
    headers: squareHeaders(env),
  });
  const body = await res.json();
  if (!res.ok) throw squareError(body, res.status, "Square locations request failed");
  const location = body.locations?.find((loc) => loc.status === "ACTIVE");
  if (!location) throw new Error("No active Square location found");
  cachedLocationId = location.id;
  return location.id;
}

async function withCache(cacheKey, ttlSeconds, producer) {
  try {
    const cache = caches.default;
    const hit = await cache.match(new Request(cacheKey));
    if (hit) return hit;
  } catch {
    // Cache API unavailable — fall through to the network
  }
  const response = await producer();
  if (response.status === 200) {
    try {
      const cache = caches.default;
      const cached = response.clone();
      cached.headers.set("cache-control", `public, max-age=${ttlSeconds}`);
      await cache.put(new Request(cacheKey), cached);
    } catch {
      // Non-fatal: skip caching
    }
  }
  return response;
}

async function fetchCatalog(env) {
  const token = env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error("SQUARE_ACCESS_TOKEN is not configured");
  const base = baseUrl(env);
  const locationId = await getLocationId(env);

  // Pull ITEM, ITEM_VARIATION, and IMAGE objects so images and variation
  // prices can be joined without per-item round trips.
  const objects = [];
  let cursor;
  do {
    const url = new URL(`${base}/v2/catalog/list`);
    url.searchParams.set("types", "ITEM,ITEM_VARIATION,IMAGE");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: squareHeaders(env) });
    const body = await res.json();
    if (!res.ok) throw squareError(body, res.status, "Square catalog request failed");
    objects.push(...(body.objects || []));
    cursor = body.cursor;
  } while (cursor);

  const images = new Map();
  const variationsByItem = new Map();
  const itemObjects = [];
  for (const obj of objects) {
    if (obj.is_deleted) continue;
    if (obj.type === "IMAGE") {
      images.set(obj.id, obj.image_data?.url || obj.image_data?.name || null);
    } else if (obj.type === "ITEM_VARIATION") {
      const itemId = obj.item_variation_data?.item_id;
      if (!itemId) continue;
      if (!variationsByItem.has(itemId)) variationsByItem.set(itemId, []);
      variationsByItem.get(itemId).push(obj);
    } else if (obj.type === "ITEM") {
      itemObjects.push(obj);
    }
  }

  const items = [];
  for (const item of itemObjects) {
    const data = item.item_data || {};

    // Skip items that are not sold at the active location.
    const present = data.present_at_location_ids;
    const absent = data.absent_at_location_ids;
    if (present && present.length > 0 && !present.includes(locationId)) continue;
    if (absent && absent.includes(locationId)) continue;

    const variationObjects =
      (Array.isArray(data.variations) ? data.variations : []).length > 0
        ? data.variations
        : variationsByItem.get(item.id) || [];

    const variations = variationObjects
      .filter(
        (v) =>
          v.type === "ITEM_VARIATION" &&
          !v.is_deleted &&
          v.item_variation_data?.price_money
      )
      .map((v) => ({
        id: v.id,
        name: v.item_variation_data?.name || null,
        price: {
          amount: v.item_variation_data.price_money.amount,
          currency: v.item_variation_data.price_money.currency || "USD",
        },
        sellable: v.item_variation_data?.sellable !== false,
      }));

    if (variations.length === 0) continue;

    const imageIds = [
      ...(Array.isArray(data.image_ids) ? data.image_ids : []),
      data.image_id,
    ].filter(Boolean);
    const image = imageIds.map((id) => images.get(id)).find(Boolean) || null;

    items.push({
      id: item.id,
      name: data.name || "Untitled item",
      description: data.description || null,
      image,
      variations,
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return json({ locationId, items });
}

async function handleCheckout(request, env) {
  const token = env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error("SQUARE_ACCESS_TOKEN is not configured");

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON" }, 400);
  }

  const variationId = typeof body?.variationId === "string" ? body.variationId : "";
  if (!/^[A-Za-z0-9]{8,}$/.test(variationId)) {
    return json({ error: "A valid variationId is required" }, 400);
  }
  const quantity = Math.max(1, Math.min(99, Number.parseInt(body?.quantity, 10) || 1));

  const locationId = await getLocationId(env);

  const payload = {
    idempotency_key: crypto.randomUUID(),
    description: "Campbell K9s Field Store purchase",
    payment_note: "Campbell K9s Field Store",
    checkout_options: {
      ...(env.SQUARE_ASK_FOR_SHIPPING === "true"
        ? { ask_for_shipping_address: true }
        : {}),
      redirect_url: CHECKOUT_REDIRECT_URL,
    },
    order: {
      location_id: locationId,
      line_items: [
        {
          quantity: String(quantity),
          catalog_object_id: variationId,
        },
      ],
    },
  };

  const res = await fetch(`${baseUrl(env)}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: squareHeaders(env),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data?.payment_link) {
    return json({ error: squareErrorMessage(data, res.status) }, res.status >= 400 ? res.status : 502);
  }
  return json({
    url: data.payment_link.url,
    longUrl: data.payment_link.long_url,
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const segments = url.pathname
    .replace(/^\/api\/square\/?/, "")
    .split("/")
    .filter(Boolean);
  const route = segments[0] || "";

  try {
    if (route === "catalog" && request.method === "GET") {
      return await withCache(
        "https://campbellk9s.com/api/square/catalog",
        CATALOG_TTL_SECONDS,
        () => fetchCatalog(env)
      );
    }
    if (route === "checkout" && request.method === "POST") {
      return await handleCheckout(request, env);
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json(
      { error: err?.message || "Unexpected store error" },
      err?.status || 502
    );
  }
}
