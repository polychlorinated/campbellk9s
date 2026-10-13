/**
 * Copies the Cloudflare Pages Functions directory into the Astro build
 * output (dist/client/functions) so `wrangler pages deploy dist/client`
 * picks up /api/square/* alongside the static site.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "functions");
const dest = resolve(root, "dist", "client", "functions");

if (!existsSync(src)) {
  console.warn("[copy-functions] functions/ not found — skipping");
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log("[copy-functions] copied functions/ → dist/client/functions");
