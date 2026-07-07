import type { APIRoute } from "astro";

// Opt this route into on-demand rendering — every other page stays static.
export const prerender = false;

interface ContactPayload {
  name?: unknown;
  phone?: unknown;
  dog?: unknown;
  goal?: unknown;
}

const REQUIRED_FIELDS = ["name", "phone", "dog", "goal"] as const;

const N8N_WEBHOOK_URL =
  import.meta.env.N8N_WEBHOOK_URL ??
  "https://n8n.srv725961.hstgr.cloud/webhook/ec01ad68-6e29-4130-b016-76452eded072";

const json = (
  body: Record<string, unknown>,
  status = 200
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

const sanitize = (value: unknown): string =>
  typeof value === "string" ? value.trim().slice(0, 500) : "";

export const POST: APIRoute = async ({ request }) => {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ ok: false, error: "Expected application/json." }, 415);
  }

  let payload: ContactPayload;
  try {
    payload = (await request.json()) as ContactPayload;
  } catch {
    return json({ ok: false, error: "Invalid JSON payload." }, 400);
  }

  const cleaned = {
    name: sanitize(payload.name),
    phone: sanitize(payload.phone),
    dog: sanitize(payload.dog),
    goal: sanitize(payload.goal),
  };

  const missing = REQUIRED_FIELDS.filter((f) => !cleaned[f]);
  if (missing.length > 0) {
    return json(
      { ok: false, error: `Missing required field(s): ${missing.join(", ")}.` },
      400
    );
  }

  try {
    const n8nRes = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleaned),
    });

    if (!n8nRes.ok) {
      console.error("[contact] n8n webhook failed", n8nRes.status, await n8nRes.text().catch(() => ""));
      return json(
        { ok: false, error: "We couldn't send your inquiry. Please try again or email us directly." },
        502
      );
    }

    return json({ ok: true });
  } catch (err) {
    console.error("[contact] n8n webhook error", err);
    return json(
      { ok: false, error: "We couldn't reach our intake system. Please try again or email us directly." },
      502
    );
  }
};

export const GET: APIRoute = () =>
  json({ ok: false, error: "Method not allowed." }, 405);
