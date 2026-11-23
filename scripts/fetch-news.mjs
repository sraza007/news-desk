// Pulls every RSS feed listed in feeds.json and writes data/news.json.
// Runs inside the GitHub Action every 30 minutes. You can also run it locally:
//   npm install && npm run fetch
import Parser from 'rss-parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MAX_PER_SOURCE = 15;
export const MAX_PER_TAB = 60;

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
  },
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

/** Map one rss2json item onto the rss-parser shape so normalizeItem can handle it. */
export function fromRss2Json(it) {
  const enc = it.enclosure || {};
  const encIsImage = /image/.test(enc.type || '') || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(enc.link || '');
  const image = it.thumbnail || (encIsImage ? enc.link : null);
  return {
    title: it.title,
    link: it.link,
    // rss2json gives "2026-11-23 14:11:37" in UTC
    isoDate: it.pubDate ? it.pubDate.replace(' ', 'T') + 'Z' : undefined,
    content: it.description || it.content,
    enclosure: image ? { url: image, type: 'image' } : undefined,
  };
}

// Some sites (CBC, ESPN) block GitHub's servers. For those, go through rss2json instead.
async function fetchViaRss2Json(source) {
  const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(source.url)}`, {
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || 'rss2json error');
  return data.items.map((it) => normalizeItem(fromRss2Json(it), source));
}

async function fetchSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const items = feed.items.slice(0, MAX_PER_SOURCE).map((it) => normalizeItem(it, source)).filter(Boolean);
    if (items.length) return items;
    throw new Error('feed had no items');
  } catch (direct) {
    try {
      return await fetchViaRss2Json(source);
    } catch (relay) {
      throw new Error(`direct: ${direct.message}; relay: ${relay.message}`);
    }
  }
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

// Exit explicitly: feeds that time out can leave sockets open, which would keep Node running forever.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => { console.error(err); process.exit(1); },
  );
}
