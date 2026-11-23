// News Desk: shows the saved headlines (data/news.json, rebuilt by a GitHub Action)
// and can pull the latest straight from the feeds when you press Refresh.

// Free relays that let a browser read RSS feeds. Tried in order; if both fail for a
// source, that source's saved stories are shown instead.
const RELAYS = [
  { name: 'rss2json', url: (u) => `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(u)}`, parse: parseRss2Json },
  { name: 'cors.lol', url: (u) => `https://api.cors.lol/?url=${encodeURIComponent(u)}`, parse: parseXml },
];
const RELAY_TIMEOUT_MS = 12000;
const AUTO_LIVE_AFTER_MIN = 90; // saved copy older than this? fetch live on first view
const MAX_PER_TAB = 60;

const state = {
  config: null,
  saved: null,        // contents of data/news.json
  live: {},           // tabId -> { items, at, failed: [names] }
  tab: null,
  filter: 'All',
  autoTried: new Set(),
  busy: false,
};

const $ = (id) => document.getElementById(id);

/* ---------- helpers ---------- */

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

function plainText(html = '') {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max = 220) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return text.slice(0, cut > 0 ? cut : max) + '…';
}

const isHttp = (u) => /^https?:\/\//i.test(u || '');

function timeAgo(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function makeItem(source, { title, link, date, summary, image }) {
  title = plainText(title);
  if (!title || !isHttp(link)) return null;
  const d = new Date(date || '');
  return {
    title,
    link,
    source: source.name,
    tag: source.tag || null,
    feed: source.url,
    date: isNaN(d) ? null : d.toISOString(),
    summary: truncate(plainText(summary)),
    image: isHttp(image) ? image : null,
  };
}

function mergeItems(items, max = MAX_PER_TAB) {
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

/* ---------- live fetching ---------- */

function parseRss2Json(text, source) {
  const data = JSON.parse(text);
  if (data.status !== 'ok') throw new Error(data.message || 'rss2json error');
  return data.items.map((it) => {
    const enc = it.enclosure || {};
    const encImage = /image/.test(enc.type || '') || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(enc.link || '') ? enc.link : null;
    return makeItem(source, {
      title: it.title,
      link: it.link,
      // rss2json gives "2026-11-23 14:11:37" in UTC
      date: it.pubDate ? it.pubDate.replace(' ', 'T') + 'Z' : null,
      summary: it.description || it.content,
      image: it.thumbnail || encImage,
    });
  });
}

function parseXml(text, source) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('not a feed');
  const first = (node, ...names) => {
    for (const n of names) {
      const found = node.getElementsByTagName(n)[0];
      if (found) return found;
    }
    return null;
  };
  const widest = (nodes) =>
    [...nodes]
      .filter((n) => n.getAttribute('url') && /image|^$/.test(n.getAttribute('type') || n.getAttribute('medium') || ''))
      .sort((a, b) => (+b.getAttribute('width') || 0) - (+a.getAttribute('width') || 0))[0]?.getAttribute('url');
  return [...doc.querySelectorAll('item, entry')].map((node) => {
    const linkEl = first(node, 'link');
    const enclosure = first(node, 'enclosure');
    return makeItem(source, {
      title: first(node, 'title')?.textContent,
      link: linkEl?.getAttribute('href') || linkEl?.textContent?.trim(),
      date: first(node, 'pubDate', 'published', 'updated', 'dc:date')?.textContent,
      summary: first(node, 'description', 'summary', 'content')?.textContent,
      image:
        widest(node.getElementsByTagName('media:thumbnail')) ||
        widest(node.getElementsByTagName('media:content')) ||
        (/image/.test(enclosure?.getAttribute('type') || '') ? enclosure.getAttribute('url') : null),
    });
  });
}

async function fetchLive(source) {
  for (const relay of RELAYS) {
    try {
      const res = await fetch(relay.url(source.url), { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS), cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = relay.parse(await res.text(), source).filter(Boolean);
      if (items.length) return items;
    } catch (err) {
      console.warn(`[news] ${relay.name} failed for ${source.name}:`, err.message);
    }
  }
  throw new Error('all relays failed');
}

async function refreshTab(tab) {
  if (state.busy) return;
  state.busy = true;
  state.liveError = null;
  const btn = $('refresh');
  btn.disabled = true;
  $('status').textContent = 'Fetching the latest headlines…';
  const cached = currentItems(tab.id);
  const failed = [];
  const results = await Promise.all(
    tab.sources.map(async (source) => {
      try {
        return await fetchLive(source);
      } catch {
        failed.push(source.name + (source.tag ? ` ${source.tag}` : ''));
        return cached.filter((it) => it.feed === source.url);
      }
    }),
  );
  if (failed.length < tab.sources.length) {
    state.live[tab.id] = { items: mergeItems(results.flat()), at: new Date().toISOString(), failed };
  } else {
    state.liveError = tab.id; // nothing came back; keep what we had
  }
  state.busy = false;
  btn.disabled = false;
  if (state.tab === tab.id) render();
}

/* ---------- rendering ---------- */

function currentTab() {
  return state.config.tabs.find((t) => t.id === state.tab);
}

function currentItems(tabId) {
  return state.live[tabId]?.items || state.saved?.tabs?.[tabId]?.items || [];
}

function renderTabs() {
  const nav = $('tabs');
  nav.replaceChildren(
    ...state.config.tabs.map((t) =>
      el('button', {
        class: 'tab', role: 'tab', type: 'button', id: `tab-${t.id}`,
        'aria-selected': String(t.id === state.tab), 'aria-controls': 'stories',
        onclick: () => { location.hash = t.id; },
      }, t.label),
    ),
  );
  nav.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderFilters(tab) {
  const tags = [...new Set(tab.sources.map((s) => s.tag).filter(Boolean))];
  const box = $('filters');
  if (tags.length < 2) return box.replaceChildren();
  box.replaceChildren(
    ...['All', ...tags].map((tag) =>
      el('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(state.filter === tag),
        onclick: () => { state.filter = tag; render(); },
      }, tag),
    ),
  );
}

function renderStatus(tab) {
  const live = state.live[tab.id];
  const status = $('status');
  if (live) {
    const parts = [el('span', { class: 'dot live' }), `Live · fetched ${timeAgo(live.at)}`];
    if (live.failed.length) parts.push(el('span', { class: 'warn' }, ` · couldn't reach ${live.failed.join(', ')} (showing saved stories)`));
    status.replaceChildren(...parts);
  } else if (state.saved?.generatedAt) {
    const parts = [el('span', { class: 'dot' }), `Saved copy · updated ${timeAgo(state.saved.generatedAt)}`];
    if (state.liveError === tab.id) parts.push(el('span', { class: 'warn' }, ' · live refresh failed, try again shortly'));
    status.replaceChildren(...parts);
  } else {
    status.textContent = state.liveError === tab.id ? "Couldn't load headlines. Try Refresh in a minute." : '';
  }
}

function storyCard(it, lead) {
  const img = it.image
    ? el('img', { src: it.image, alt: '', loading: lead ? 'eager' : 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })
    : null;
  return el('article', { class: lead && it.image ? 'story lead' : 'story' },
    img,
    el('div', { class: 'story-body' },
      el('div', { class: 'meta' },
        el('span', { class: 'source' }, it.source),
        it.tag ? el('span', { class: 'tag' }, it.tag) : null,
        it.date ? el('time', { class: 'time', datetime: it.date, title: new Date(it.date).toLocaleString() }, timeAgo(it.date)) : null,
      ),
      el('h3', {}, el('a', { href: it.link, target: '_blank', rel: 'noopener noreferrer' }, it.title)),
      it.summary ? el('p', {}, it.summary) : null,
    ),
  );
}

function render() {
  const tab = currentTab();
  renderTabs();
  $('section-title').textContent = tab.title;
  document.title = `${tab.label} · News Desk`;
  renderFilters(tab);
  renderStatus(tab);

  const grid = $('stories');
  let items = currentItems(tab.id);
  if (state.filter !== 'All') items = items.filter((it) => it.tag === state.filter);

  if (!items.length && state.busy) {
    grid.replaceChildren(...Array.from({ length: 6 }, () => el('div', { class: 'skeleton' })));
  } else if (!items.length) {
    grid.replaceChildren(el('p', { class: 'empty' }, 'No stories here yet. Press Refresh to pull the latest.'));
  } else {
    grid.replaceChildren(...items.map((it, i) => storyCard(it, i === 0)));
  }
}

function selectTab() {
  const wanted = location.hash.slice(1);
  const tab = state.config.tabs.find((t) => t.id === wanted) || state.config.tabs[0];
  if (state.tab !== tab.id) state.filter = 'All';
  state.tab = tab.id;
  render();
  window.scrollTo({ top: 0 });

  // Pull live automatically the first time a tab is opened if the saved copy is empty or stale.
  const ageMin = state.saved?.generatedAt ? (Date.now() - new Date(state.saved.generatedAt)) / 60000 : Infinity;
  if (!state.autoTried.has(tab.id) && (!currentItems(tab.id).length || ageMin > AUTO_LIVE_AFTER_MIN)) {
    state.autoTried.add(tab.id);
    refreshTab(tab).then(render);
    render(); // show skeletons while busy
  }
}

async function start() {
  $('today').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  state.config = await fetch('feeds.json', { cache: 'no-store' }).then((r) => r.json());
  state.saved = await fetch('data/news.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  $('refresh').addEventListener('click', () => refreshTab(currentTab()));
  window.addEventListener('hashchange', selectTab);
  setInterval(() => state.tab && render(), 60000); // keep "x min ago" current
  selectTab();
}

start().catch((err) => {
  console.error(err);
  $('stories').replaceChildren(el('p', { class: 'empty' }, "Couldn't start. If you opened index.html straight from your computer, use the GitHub Pages link instead."));
});
