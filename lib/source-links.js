// Collects posting links from a job site added on the "Sources" tab, on this computer, before Claude runs.
// Many boards (e.g. Hitmarker) render the job list with JavaScript, so Claude's WebFetch sees an empty page.
// Their RSS feeds and sitemaps still list every posting, and the link slugs carry the job title — enough to pick candidates.
'use strict';

const zlib = require('node:zlib');
const { jsonLd } = require('./fetch-posting');
const { hasWord, postedAgeDays } = require('./store');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_SITEMAPS = 8;
const MAX_FEEDS = 3;
const MAX_LINKS = 150;
const MAX_CARDS = 60;     // pages opened here to read real dates and locations (category pages count too)
const CARD_CHARS = 1200;  // how much of each posting Claude gets up front
const JOBISH = /job|vacanc|career|position|opening|role|posting|вакан/i;

const slug = u => { try { return decodeURIComponent(new URL(u).pathname); } catch (_) { return u; } };
const isoDay = s => { const t = Date.parse(s); return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10); };
const decodeXml = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').trim();

// Like fetch-posting's get(), but also unpacks .gz files (sitemap.xml.gz).
async function getDoc(url, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept || '*/*' }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) return null;
    let buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    return buf.toString('utf8');
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function sameSite(u, host) {
  try { return new URL(u).hostname.replace(/^www\./, '') === host; } catch (_) { return false; }
}

// <url><loc>…</loc><lastmod>…</lastmod></url> or <sitemap>… entries, in document order.
function parseSitemap(xml) {
  const entries = String(xml).split(/<(?:url|sitemap)>/i).slice(1).map(b => ({
    url: decodeXml((b.match(/<loc>([^<]+)/i) || [])[1] || ''),
    date: ((b.match(/<lastmod>\s*([^<]+)/i) || [])[1] || '').trim().slice(0, 10),
  })).filter(e => e.url);
  return { isIndex: /<sitemapindex/i.test(xml), entries };
}

async function sitemapLinks(origin, host, cutoff, onLog) {
  const robots = await getDoc(origin + '/robots.txt', 'text/plain');
  const roots = [...String(robots || '').matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]);
  if (!roots.length) roots.push(origin + '/sitemap.xml');
  const queue = [...new Set(roots)];
  const out = [];
  let fetched = 0;
  while (queue.length && fetched < MAX_SITEMAPS) {
    const xml = await getDoc(queue.shift(), 'application/xml,text/xml,*/*');
    fetched++;
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
    const { isIndex, entries } = parseSitemap(xml);
    if (isIndex) {
      // Only job sitemaps when the site splits them by type; skip parts not updated since the cutoff.
      const fresh = entries.filter(e => !cutoff || !e.date || e.date >= cutoff);
      const jobs = fresh.filter(e => JOBISH.test(e.url));
      queue.push(...(jobs.length ? jobs : fresh).map(e => e.url));
    } else {
      out.push(...entries.filter(e => sameSite(e.url, host) && JOBISH.test(new URL(e.url).pathname)
        && (!cutoff || !e.date || e.date >= cutoff)));
    }
  }
  if (onLog && fetched) onLog(`${host}: read ${fetched} sitemap file(s), ${out.length} recent link(s)`);
  return out;
}

// RSS / Atom feeds linked from the page. Their dates are publication dates, unlike sitemap "lastmod".
async function feedLinks(html, base, host, cutoff, onLog) {
  const urls = new Set();
  for (const m of String(html || '').matchAll(/<link[^>]+>/gi)) {
    if (!/application\/(rss|atom)\+xml/i.test(m[0])) continue;
    const href = (m[0].match(/href\s*=\s*["']([^"']+)/i) || [])[1];
    if (href) urls.add(new URL(href, base).href);
  }
  for (const m of String(html || '').matchAll(/href\s*=\s*["']([^"'#]+\.(?:rss|atom)|[^"'#]*\/(?:feed|rss)(?:\.xml)?\/?)["']/gi)) {
    try { urls.add(new URL(m[1], base).href); } catch (_) { /* bad link */ }
  }
  const out = [];
  let read = 0;
  for (const u of [...urls].filter(x => sameSite(x, host)).slice(0, MAX_FEEDS)) {
    const xml = await getDoc(u, 'application/rss+xml,application/atom+xml,application/xml,*/*');
    if (!xml || !/<(rss|feed|rdf)/i.test(xml)) continue;
    read++;
    for (const b of xml.split(/<(?:item|entry)[\s>]/i).slice(1)) {
      const link = decodeXml((b.match(/<link>([^<]+)<\/link>/i) || [])[1] || (b.match(/<link[^>]+href\s*=\s*["']([^"']+)/i) || [])[1] || '');
      const date = isoDay(decodeXml((b.match(/<(?:pubDate|published|dc:date|updated)>([^<]+)/i) || [])[1] || ''));
      if (link && sameSite(link, host) && (!cutoff || !date || date >= cutoff)) out.push({ url: link.replace(/\/$/, ''), date });
    }
  }
  if (onLog && read) onLog(`${host}: read ${read} RSS feed(s), ${out.length} recent posting(s)`);
  return out;
}

function pageLinks(html, base, host) {
  const out = [];
  for (const m of String(html || '').matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    let u;
    try { u = new URL(m[1], base); } catch (_) { continue; }
    if (!sameSite(u.href, host) || u.pathname.length < 8) continue;
    // A posting (or a category list) link: a jobs-like path with an id or a long slug.
    if (JOBISH.test(u.pathname) && /\d{3,}|[a-z]+-[a-z]+-[a-z]+/i.test(u.pathname)) out.push({ url: u.href.replace(/\/$/, ''), date: '' });
  }
  return out;
}

// Opens a page and reads its schema.org JobPosting (title, location, real publication date) — WebFetch drops
// that block, and sitemap dates are "last modified", not "posted". card is null when the page has no such data
// (then it is a category list or a site without structured data, and html is kept to look for posting links).
async function readPage(url) {
  const html = await getDoc(url, 'text/html') || '';
  const ld = jsonLd(html);
  if (!ld) return { url, html, card: null };
  const posted = (ld.match(/^Posted: (\d{4}-\d{2}-\d{2})/m) || [])[1] || '';
  return { url, html: '', card: { url, posted, text: ld.length > CARD_CHARS ? ld.slice(0, CARD_CHARS) + '…' : ld } };
}

async function readPages(urls) {
  const out = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      try { out[i] = await readPage(urls[i]); } catch (_) { out[i] = { url: urls[i], html: '', card: null }; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

// Returns posting cards (downloaded, newest first) and plain links (not downloaded), filtered by words in the link:
// links with an exclude word are dropped; of the rest, those with an include word are kept.
// When no link has an include word (e.g. links are just ids), the newest links are used.
async function collectLinks(source, { maxAgeDays, include = [], exclude = [], onLog } = {}) {
  let start;
  try { start = new URL(source.url); } catch (_) { return { links: [], cards: [], filtered: false }; }
  const host = start.hostname.replace(/^www\./, '');
  const cutoff = maxAgeDays ? new Date(Date.now() - maxAgeDays * 86400000).toISOString().slice(0, 10) : '';
  const html = await getDoc(start.href, 'text/html');
  const all = [
    ...await feedLinks(html, start.href, host, cutoff, onLog),
    ...pageLinks(html, start.href, host),
    ...await sitemapLinks(start.origin, host, cutoff, onLog),
  ];
  const seen = new Set();
  const uniq = all.filter(e => !seen.has(e.url) && seen.add(e.url));
  uniq.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const allowed = uniq.filter(e => !hasWord(slug(e.url), exclude));
  const hits = include.length ? allowed.filter(e => hasWord(slug(e.url), include)) : [];
  const filtered = hits.length > 0;
  const picked = (filtered ? hits : allowed).slice(0, MAX_LINKS).map(e => e.url);
  if (onLog) onLog(`${host}: ${uniq.length} link(s) found, ${uniq.length - allowed.length} hidden by your filter, `
    + `${filtered ? hits.length + ' match your keywords' : 'no keyword matches'}`);

  // Read the first pages here: real date (drop the old ones), title and location for Claude.
  if (onLog) onLog(`${host}: reading ${Math.min(picked.length, MAX_CARDS)} page(s)…`);
  let pages = await readPages(picked.slice(0, MAX_CARDS));
  // Pages without posting data may be category lists (e.g. ".../remote-game-jobs/unreal"): read the postings they
  // link to — they already belong to a category matching your words, so only the "hide" words apply to them.
  const more = [];
  const taken = new Set(picked);
  for (const p of pages) {
    if (p.card) continue;
    for (const e of pageLinks(p.html, p.url, host)) {
      if (!taken.has(e.url) && !hasWord(slug(e.url), exclude)) { taken.add(e.url); more.push(e.url); }
    }
  }
  const budget = Math.max(0, MAX_CARDS - pages.length);
  if (more.length && budget) {
    if (onLog) onLog(`${host}: reading ${Math.min(more.length, budget)} posting(s) from category pages…`);
    pages = pages.concat(await readPages(more.slice(0, budget)));
  }

  const cards = [];
  const fromLists = new Set(more);
  let tooOld = 0, hidden = 0;
  for (const p of pages) {
    const c = p.card;
    if (!c) continue;
    const title = (c.text.match(/^Title: (.*)$/m) || [])[1];
    if (maxAgeDays && postedAgeDays(c.posted) > maxAgeDays) { tooOld++; continue; }
    if (hasWord(title, exclude)) { hidden++; continue; }
    // Category pages often also link every recent posting (sidebars, "latest jobs"): keep only titles with your words.
    if (fromLists.has(c.url) && include.length && !hasWord(title + ' ' + slug(c.url), include)) { hidden++; continue; }
    cards.push(c);
  }
  // Plain links: pages not read here, or read but without posting data and without posting links of their own.
  // Links from category pages are left out: those lists carry no dates and often reach back years.
  const readUrls = new Set(pages.map(p => p.url));
  const lists = new Set(pages.filter(p => !p.card && pageLinks(p.html, p.url, host).length).map(p => p.url));
  const links = picked.filter(u => !lists.has(u) && !(readUrls.has(u) && pages.find(p => p.url === u).card));
  cards.sort((a, b) => b.posted.localeCompare(a.posted));
  if (onLog) onLog(`${host}: ${cards.length} posting(s) with details for Claude${tooOld ? `, ${tooOld} older than ${maxAgeDays} days skipped` : ''}`
    + `${hidden ? `, ${hidden} hidden by your filter` : ''}${links.length ? `, ${links.length} more as plain links` : ''}`);
  return { links: links.slice(0, MAX_LINKS), cards, filtered };
}

module.exports = { collectLinks };
