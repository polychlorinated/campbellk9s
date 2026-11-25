/**
 * Creates the Clearer Dogs Club subscription plans under the configured
 * PayPal REST app (PayPal plans are scoped to the app that creates them,
 * so the plans must live under the same app as the buttons and the server).
 *
 * Creates:
 *   - Clearer Dogs Club — Monthly     $29.00 / month
 *   - Clearer Dogs Club — Annual      $290.00 / year (two months free)
 *
 * Usage:
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/create-paypal-plans.mjs
 *   (or put PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env)
 *
 * The script prints the new plan IDs at the end — paste them into
 * src/pages/clearer-dogs-club/index.astro (alongside the client ID).
 */

import process from "node:process";

const PLANS = [
  {
    name: "Clearer Dogs Club — Monthly",
    interval_unit: "MONTH",
    interval_count: 1,
    price: "29.00",
  },
  {
    name: "Clearer Dogs Club — Annual (two months free)",
    interval_unit: "MONTH",
    interval_count: 12,
    price: "290.00",
  },
];

async function main() {
  let clientId = process.env.PAYPAL_CLIENT_ID;
  let secret = process.env.PAYPAL_CLIENT_SECRET;
  let environment = process.env.PAYPAL_ENVIRONMENT || "live";
  try {
    process.loadEnvFile(".env");
    clientId ||= process.env.PAYPAL_CLIENT_ID;
    secret ||= process.env.PAYPAL_CLIENT_SECRET;
    environment = process.env.PAYPAL_ENVIRONMENT || environment;
  } catch {
    // no .env file — environment variables only
  }

  if (!clientId || !secret) {
    console.error(
      "Missing credentials. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the environment or in .env, then run again.\n" +
        "Both come from developer.paypal.com → Apps & Credentials → your new app."
    );
    process.exit(1);
  }

  const apiBase =
    environment === "sandbox"
      ? "https://api-m.sandbox.paypal.com"
      : "https://api-m.paypal.com";

  const tokenRes = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!tokenRes.ok) {
    console.error("PayPal authentication failed. Check the client ID and secret.");
    process.exit(1);
  }
  const { access_token } = await tokenRes.json();
  const authHeaders = {
    authorization: `Bearer ${access_token}`,
    "content-type": "application/json",
  };

  const productRes = await fetch(`${apiBase}/v1/catalogs/products`, {
    method: "POST",
    headers: { ...authHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      name: "Clearer Dogs Club Membership",
      description: "Private dog training community by Campbell K9s",
      type: "SERVICE",
    }),
  });
  if (!productRes.ok) {
    console.error("Could not create the catalog product:");
    console.error(await productRes.text());
    process.exit(1);
  }
  const product = await productRes.json();
  console.log(`Product created: ${product.id}`);

  console.log("");
  for (const plan of PLANS) {
    const planRes = await fetch(`${apiBase}/v1/billing/plans`, {
      method: "POST",
      headers: { ...authHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        product_id: product.id,
        name: plan.name,
        status: "ACTIVE",
        billing_cycles: [
          {
            frequency: {
              interval_unit: plan.interval_unit,
              interval_count: plan.interval_count,
            },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: { value: plan.price, currency_code: "USD" },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          payment_failure_threshold: 3,
        },
        taxes: { percentage: "0", inclusive: false },
      }),
    });
    if (!planRes.ok) {
      console.error(`Could not create plan "${plan.name}":`);
      console.error(await planRes.text());
      process.exit(1);
    }
    const created = await planRes.json();
    console.log(`${plan.name}: ${created.id}`);
  }

  console.log("");
  console.log("Paste the two plan IDs above into src/pages/clearer-dogs-club/index.astro");
  console.log(`(SDK client ID for the site: ${clientId})`);
}

main();
