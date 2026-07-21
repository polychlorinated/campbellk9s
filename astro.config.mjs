// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";
import sitemap from "@astrojs/sitemap";
import seoGraph from "@jdevalk/astro-seo-graph/integration";

// https://astro.build/config
export default defineConfig({
  site: "https://campbellk9s.com",
  output: "server",
  trailingSlash: "always",
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
  integrations: [
    sitemap(),
    seoGraph({
      validateH1: true,
      validateUniqueMetadata: true,
      validateImageAlt: true,
      validateMetadataLength: true,
      validateInternalLinks: true,
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
