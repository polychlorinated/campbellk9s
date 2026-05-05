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

  // TODO: forward to GoHighLevel webhook + send transactional email via Resend.
  //   await fetch(import.meta.env.GHL_WEBHOOK_URL, {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify(cleaned),
  //   });
  //   await sendResendEmail(cleaned);
  console.info("[contact] new lead", cleaned);

  return json({ ok: true });
};

export const GET: APIRoute = () =>
  json({ ok: false, error: "Method not allowed." }, 405);
