// @ts-check
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config

const projectRoot = process.cwd();
const gitMtimeCache = new Map();

/** Last git commit date for a source file, falling back to filesystem mtime. */
function gitLastmod(file) {
  if (gitMtimeCache.has(file)) return gitMtimeCache.get(file);
  let iso = "";
  try {
    iso = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", file],
      { cwd: projectRoot, encoding: "utf8" }
    ).trim();
  } catch {
    iso = "";
  }
  if (!iso) {
    try {
      iso = statSync(path.join(projectRoot, file)).mtime.toISOString();
    } catch {
      iso = undefined;
    }
  }
  gitMtimeCache.set(file, iso);
  return iso;
}

/** Map of blog slug -> ISO lastmod, written by src/pages/blog/[slug].astro at build. */
function blogLastmodMap() {
  try {
    const file = path.join(projectRoot, ".astro", "blog-lastmod.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // fall through
  }
  return {};
}

/** Route URL -> source file (or ISO date for blog posts). */
function sourceForUrl(url) {
  const pathname = new URL(url).pathname;
  if (pathname === "/") return "src/pages/index.astro";
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "blog") {
    if (parts.length === 1) return "src/pages/blog/index.astro";
    const slug = parts[1];
    return blogLastmodMap()[slug] ?? "src/pages/blog/[slug].astro";
  }
  return `src/pages/${parts.join("/")}.astro`;
}

export default defineConfig({
  site: "https://campbellk9s.com",
  output: "static",
  outDir: "./dist/client",
  trailingSlash: "always",
  integrations: [
    sitemap({
      filter: (page) =>
        !page.includes("/blog-reader/") && !page.endsWith("/404/"),
      serialize: (item) => {
        const source = sourceForUrl(item.url);
        if (!source) return item;
        const isIsoDate = /^\d{4}-\d{2}-\d{2}T/.test(source);
        const lastmod = isIsoDate ? source : gitLastmod(source);
        if (!lastmod) return item;
        return { ...item, lastmod: lastmod.slice(0, 10) };
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
