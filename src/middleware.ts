import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware((context, next) => {
  if (context.url.hostname === "www.campbellk9s.com") {
    const canonicalUrl = new URL(context.url);
    canonicalUrl.hostname = "campbellk9s.com";
    return context.redirect(canonicalUrl.toString(), 301);
  }

  return next();
});
