const WP_API = `${import.meta.env.WORDPRESS_URL}/wp-json/wp/v2`;

export interface WPPost {
  id: number;
  slug: string;
  date: string;
  title: { rendered: string };
  excerpt: { rendered: string };
  content: { rendered: string };
  featured_media: number;
  categories: number[];
  _embedded?: {
    "wp:featuredmedia"?: Array<{
      source_url: string;
      alt_text: string;
    }>;
    "wp:term"?: Array<Array<{ id: number; name: string; slug: string }>>;
  };
}

export async function getPosts(perPage = 12): Promise<WPPost[]> {
  try {
    const url = `${WP_API}/posts?_embed&per_page=${perPage}&status=publish&orderby=date&order=desc`;
    console.log('[wordpress] Fetching:', url);
    const res = await fetch(url);
    console.log('[wordpress] Response status:', res.status);
    if (!res.ok) {
      const text = await res.text();
      console.error('[wordpress] Error body:', text);
      return [];
    }
    const data = await res.json();
    console.log('[wordpress] Got posts:', data.length);
    return data;
  } catch (err) {
    console.error('[wordpress] Fetch failed:', err);
    return [];
  }
}

export async function getPostBySlug(slug: string): Promise<WPPost | null> {
  try {
    const url = `${WP_API}/posts?_embed&slug=${slug}&status=publish`;
    console.log('[wordpress] Fetching post by slug:', url);
    const res = await fetch(url);
    console.log('[wordpress] Response status:', res.status);
    if (!res.ok) return null;
    const data = await res.json();
    return data[0] ?? null;
  } catch (err) {
    console.error('[wordpress] Fetch post failed:', err);
    return null;
  }
}

export function featuredImage(post: WPPost): string | null {
  return post._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? null;
}

export function featuredImageAlt(post: WPPost): string {
  return post._embedded?.["wp:featuredmedia"]?.[0]?.alt_text ?? "";
}

export function postCategories(
  post: WPPost
): Array<{ id: number; name: string; slug: string }> {
  return post._embedded?.["wp:term"]?.[0] ?? [];
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
