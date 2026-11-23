// Pulls every RSS feed listed in feeds.json and writes data/news.json.
// Runs inside the GitHub Action every 30 minutes. You can also run it locally:
//   npm install && npm run fetch
import Parser from 'rss-parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MAX_PER_SOURCE = 15;
export const MAX_PER_TAB = 60;

const parser = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsDesk/1.0; +https://github.com)' },
  customFields: {
    item: [
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['media:content', 'mediaContent', { keepArray: true }],
    ],
  },
});

export function stripHtml(html = '') {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(text, max = 220) {
  if (text.length <= max) return text;
  return text.slice(0, text.lastIndexOf(' ', max) > 0 ? text.lastIndexOf(' ', max) : max) + '…';
}

function pickImage(item) {
  // Feeds often list several sizes; take the widest image.
  const fromMedia = (list) =>
    (list || [])
      .map((m) => m?.$ || {})
      .filter((a) => a.url && (!(a.type || a.medium) || /image/.test(a.type || a.medium)))
      .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0]?.url || null;
  if (item.enclosure?.url && /image/.test(item.enclosure.type || 'image')) return item.enclosure.url;
  return fromMedia(item.mediaThumbnail) || fromMedia(item.mediaContent) || null;
}

/** Turn one rss-parser item into the shape the page expects. Returns null if unusable. */
export function normalizeItem(item, source) {
  const link = item.link || item.guid;
  const title = stripHtml(item.title);
  if (!title || !/^https?:\/\//.test(link || '')) return null;
  const parsed = new Date(item.isoDate || item.pubDate || '');
  return {
    title,
    link,
    source: source.name,
    tag: source.tag || null,
    feed: source.url,
    date: isNaN(parsed) ? null : parsed.toISOString(),
    summary: truncate(stripHtml(item.contentSnippet || item.summary || item.content || '')),
    image: pickImage(item),
  };
}

/** Newest first, dedupe by link and by title, cap the count. */
export function mergeItems(items, max = MAX_PER_TAB) {
  const seen = new Set();
  return items
    .filter(Boolean)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .filter((it) => {
      const keys = [it.link, it.title.toLowerCase()];
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    })
    .slice(0, max);
}

async function fetchSource(source) {
  const feed = await parser.parseURL(source.url);
  return feed.items.slice(0, MAX_PER_SOURCE).map((it) => normalizeItem(it, source));
}

async function loadPrevious(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Build news.json. `fetcher(source)` returns normalized items or throws.
 * When a source fails, its items from the previous run are kept so a tab never empties out.
 */
export async function buildNews(config, fetcher, previous = null) {
  const out = { generatedAt: new Date().toISOString(), tabs: {}, failed: [] };
  for (const tab of config.tabs) {
    const results = await Promise.all(
      tab.sources.map(async (source) => {
        try {
          const items = await fetcher(source);
          if (!items.filter(Boolean).length) throw new Error('feed had no items');
          return items;
        } catch (err) {
          out.failed.push({ tab: tab.id, source: source.name, url: source.url, error: String(err.message || err) });
          const old = previous?.tabs?.[tab.id]?.items || [];
          return old.filter((it) => it.feed === source.url);
        }
      }),
    );
    out.tabs[tab.id] = { items: mergeItems(results.flat()) };
  }
  return out;
}

async function main() {
  const config = JSON.parse(await readFile('feeds.json', 'utf8'));
  const previous = await loadPrevious(process.env.PREVIOUS_NEWS_URL);
  const news = await buildNews(config, fetchSource, previous);
  await mkdir('data', { recursive: true });
  await writeFile('data/news.json', JSON.stringify(news, null, 1));
  for (const [id, tab] of Object.entries(news.tabs)) console.log(`${id}: ${tab.items.length} stories`);
  for (const f of news.failed) console.warn(`could not fetch ${f.source} (${f.tab}): ${f.error}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
