import type { ToolRegistry } from '../tools/index.js';

type RssItem = { title?: string; link?: string };
type RssPayload = { type?: string; items?: RssItem[] };

const FILLER_PHRASES = [
  /\b(and\s+)?deliver\s+to\s+me\b/ig,
  /\bsend\s+it\s+to\s+me\b/ig,
  /\bmake\s+me\b/ig,
  /\bget\s+me\b/ig,
  /\bgive\s+me\b/ig,
  /\ba\s+round\s*up\s+of\b/ig,
  /\bround\s*up\s+of\b/ig,
  /\bplease\b/ig,
];

function normalizeNewsSeed(seed: string): string {
  let cleaned = seed;
  for (const pattern of FILLER_PHRASES) {
    cleaned = cleaned.replace(pattern, ' ');
  }

  cleaned = cleaned
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[,\s.-]+|[,\s.-]+$/g, '');

  return cleaned || 'latest technology news today';
}

function toRssUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

function extractRssItems(output: unknown): RssItem[] {
  const data = (output as { data?: RssPayload } | undefined)?.data;
  if (!data || data.type !== 'rss' || !Array.isArray(data.items)) return [];
  return data.items;
}

function formatHeadline(item: RssItem, idx: number): string | null {
  const title = item.title?.trim();
  const link = item.link?.trim();
  if (!title) return null;
  return `${idx + 1}. ${title}${link ? `\n${link}` : ''}`;
}

export async function generateNewsRoundup(
  toolRegistry: ToolRegistry,
  seed: string,
  maxItems: number = 8,
): Promise<string | null> {
  const normalized = normalizeNewsSeed(seed);

  const words = normalized.split(/\s+/).filter(Boolean);
  const narrowed = words.slice(0, 5).join(' ');

  const candidateQueries = [
    normalized,
    `${normalized} latest`,
    narrowed,
  ].filter((q, i, arr) => q.length > 0 && arr.indexOf(q) === i);

  const collected: Array<{ title: string; link?: string }> = [];
  const seenTitles = new Set<string>();

  for (const query of candidateQueries) {
    const fetched = await toolRegistry.execute('web_fetch', { url: toRssUrl(query), method: 'GET' });
    if (!fetched.success) continue;

    const items = extractRssItems(fetched.output);
    for (const item of items) {
      const title = item.title?.trim();
      if (!title) continue;
      const dedupe = title.toLowerCase();
      if (seenTitles.has(dedupe)) continue;
      seenTitles.add(dedupe);
      collected.push({ title, link: item.link?.trim() || undefined });
      if (collected.length >= maxItems) break;
    }

    if (collected.length >= maxItems) break;
  }

  if (collected.length === 0) {
    return null;
  }

  const lines = collected
    .map((item, idx) => formatHeadline(item, idx))
    .filter((line): line is string => line !== null);

  return `📰 Latest news roundup\n\n${lines.join('\n\n')}`;
}
