import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem, mergeItems, buildNews, stripHtml } from './fetch-news.mjs';

const src = { name: 'Dawn', url: 'https://dawn.example/feed', tag: 'Cricket' };

test('normalizeItem pulls title, link, date, summary and image', () => {
  const it = normalizeItem(
    {
      title: 'Pakistan &amp; India <b>draw</b>',
      link: 'https://dawn.example/a',
      isoDate: '2026-11-23T10:00:00.000Z',
      contentSnippet: 'Short blurb',
      mediaThumbnail: [{ $: { url: 'https://img.example/1.jpg' } }],
    },
    src,
  );
  assert.equal(it.title, 'Pakistan & India draw');
  assert.equal(it.date, '2026-11-23T10:00:00.000Z');
  assert.equal(it.image, 'https://img.example/1.jpg');
  assert.equal(it.tag, 'Cricket');
  assert.equal(it.feed, src.url);
});

test('normalizeItem rejects items without a usable link or title', () => {
  assert.equal(normalizeItem({ title: 'x', link: 'javascript:alert(1)' }, src), null);
  assert.equal(normalizeItem({ title: '', link: 'https://a.example' }, src), null);
});

test('normalizeItem tolerates a bad date', () => {
  assert.equal(normalizeItem({ title: 't', link: 'https://a.example', pubDate: 'nonsense' }, src).date, null);
});

test('mergeItems sorts newest first, dedupes by link and title, and caps', () => {
  const mk = (title, link, date) => ({ title, link, date });
  const out = mergeItems(
    [mk('Old', 'https://a/1', '2026-11-20T00:00:00Z'), mk('New', 'https://a/2', '2026-11-23T00:00:00Z'),
     mk('new', 'https://b/2', '2026-11-22T00:00:00Z'), mk('Dup link', 'https://a/1', '2026-11-21T00:00:00Z'),
     mk('No date', 'https://a/3', null)],
    10,
  );
  // 'new' repeats a title, 'Old' repeats a link of a newer item; undated goes last.
  assert.deepEqual(out.map((i) => i.title), ['New', 'Dup link', 'No date']);
  assert.equal(mergeItems(out, 2).length, 2);
});

test('buildNews keeps the previous items for a source that fails', async () => {
  const config = { tabs: [{ id: 'pk', sources: [src, { name: 'Geo', url: 'https://geo.example/feed' }] }] };
  const previous = { tabs: { pk: { items: [{ title: 'Old Dawn story', link: 'https://dawn.example/old', feed: src.url, date: '2026-11-22T00:00:00Z' }] } } };
  const fetcher = async (s) => {
    if (s.url === src.url) throw new Error('403');
    return [{ title: 'Fresh Geo story', link: 'https://geo.example/new', feed: s.url, date: '2026-11-23T00:00:00Z' }];
  };
  const news = await buildNews(config, fetcher, previous);
  assert.deepEqual(news.tabs.pk.items.map((i) => i.title), ['Fresh Geo story', 'Old Dawn story']);
  assert.equal(news.failed.length, 1);
  assert.equal(news.failed[0].source, 'Dawn');
});

test('stripHtml decodes common entities', () => {
  assert.equal(stripHtml('<p>It&#39;s&nbsp;here</p>'), "It's here");
});
