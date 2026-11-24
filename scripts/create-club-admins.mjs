/**
 * Creates (or resets) Clearer Dogs Club team accounts in Supabase Auth.
 *
 * Each account is created with a temporary password ("Password123") and the
 * user_metadata flag { requires_password_change: true }. The club login page
 * (/clearer-dogs-club/login/) detects that flag and forces a new password
 * before the member can continue.
 *
 * Usage:
 *   node scripts/create-club-admins.mjs
 *
 * Credentials are read from the environment (or the repo .env file):
 *   SUPABASE_URL               — Project Settings → API → Project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — Project Settings → API → service_role key
 *
 * Re-running the script resets the password back to the temporary one, so
 * it doubles as an account-recovery tool.
 */

import process from "node:process";

const ADMIN_EMAILS = [
  "andrew@polychlorinated.com",
  "k9campbellmatt@gmail.com",
  "campbelltrans@gmail.com",
];

const TEMP_PASSWORD = "Password123";

async function main() {
  let url = process.env.SUPABASE_URL;
  let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    process.loadEnvFile(".env");
    url ||= process.env.SUPABASE_URL;
    serviceKey ||= process.env.SUPABASE_SERVICE_ROLE_KEY;
  } catch {
    // no .env file — environment variables only
  }

  if (!url || !serviceKey) {
    console.error(
      "Missing credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment or in .env, then run again.\n" +
        "Find both under Supabase → Project Settings → API."
    );
    process.exit(1);
  }

  const headers = {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    "content-type": "application/json",
  };

  const existing = [];
  for (let page = 1; page <= 4; page++) {
    const res = await fetch(
      `${url}/auth/v1/admin/users?page=${page}&per_page=50`,
      { headers }
    );
    if (!res.ok) {
      console.error(
        `Could not list Supabase users (HTTP ${res.status}). Check the service role key.`
      );
      process.exit(1);
    }
    const json = await res.json();
    const users = json.users || [];
    existing.push(...users);
    if (users.length < 50) break;
  }

  for (const email of ADMIN_EMAILS) {
    const found = existing.find((user) => user.email === email);
    const body = {
      email,
      password: TEMP_PASSWORD,
      email_confirm: true,
      user_metadata: { requires_password_change: true },
      app_metadata: { club_admin: true },
    };
    if (found) {
      const res = await fetch(`${url}/auth/v1/admin/users/${found.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      console.log(
        res.ok ? `reset   ${email}` : `FAILED  ${email} (HTTP ${res.status})`
      );
    } else {
      const res = await fetch(`${url}/auth/v1/admin/users`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      console.log(
        res.ok ? `created ${email}` : `FAILED  ${email} (HTTP ${res.status})`
      );
    }
  }

  console.log(`\nTemporary password for all: ${TEMP_PASSWORD}`);
  console.log(
    "Each user is prompted to set a new password on first sign-in at\n" +
      "https://campbellk9s.com/clearer-dogs-club/login/"
  );
}

main();
