const WORDPRESS_URL = (
  import.meta.env.WORDPRESS_URL || "https://cms.campbellk9s.com"
).replace(/\/$/, "");
const WP_API = `${WORDPRESS_URL}/wp-json/wp/v2`;

export function getPostsUrl(perPage = 12): string {
  return `${WP_API}/posts?_embed&per_page=${perPage}&status=publish&orderby=date&order=desc`;
}

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

const fallbackPosts: WPPost[] = [
  {
    id: 6,
    slug: "participation-trophy-dog-training-earned-affection",
    date: "2026-07-09T18:40:53",
    title: {
      rendered: "Don&#8217;t Be a Participation Trophy: Why Your Dog Should Earn Your Affection",
    },
    excerpt: {
      rendered:
        "<p>Are you a &#8220;participation trophy&#8221; to your dog? Discover how shifting to earned affection builds real leadership, respect, and a rock-solid off-leash bond.</p>",
    },
    content: { rendered: "" },
    featured_media: 8,
    categories: [1],
    _embedded: {
      "wp:featuredmedia": [
        {
          source_url:
            "https://cms.campbellk9s.com/wp-content/uploads/2026/07/participation-trophy-blog.png",
          alt_text:
            "A woman stands on a rocky cliff next to her dog who might see her as a participation trophy",
        },
      ],
      "wp:term": [[{ id: 1, name: "Uncategorized", slug: "uncategorized" }]],
    },
  },
];

export async function getPosts(perPage = 12): Promise<WPPost[]> {
  const url = getPostsUrl(perPage);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`WordPress returned ${res.status}`);

      const posts: unknown = await res.json();
      if (!Array.isArray(posts)) throw new Error("WordPress returned invalid post data");
      return posts as WPPost[];
    } catch (error) {
      console.error(`[wordpress] Post list attempt ${attempt} failed`, error);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  console.warn("[wordpress] Using the last known post index");
  return fallbackPosts;
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

export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
