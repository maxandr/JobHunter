// LinkedIn job searches, read on this computer before Claude runs: the built-in ones (the "Look for" words in the
// candidate's country and worldwide) and search links added on the "Extra sources" tab.
// linkedin.com pages need a login, but LinkedIn's public "guest" endpoints (the ones its logged-out job pages use)
// return the search results and the full postings as plain HTML. They are unofficial and rate-limited:
// a few dozen requests per run, with pauses, is fine; many runs in a row can get "429 Too Many Requests" for a while.
'use strict';

const { htmlToText, decode } = require('./fetch-posting');
const { hasWord, postedAgeDays } = require('./store');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const GUEST = 'https://www.linkedin.com/jobs-guest/jobs/api';
const MAX_PAGES = 8;      // result pages read per search (10-25 postings each)
const MAX_CARDS = 25;     // postings opened and sent to Claude (searches added by the user)
const BUILT_IN_CARDS = 12; // the same for each built-in search (they are broader, so fewer, to save tokens)
const CARD_CHARS = 1500;  // how much of each posting Claude gets
const PAUSE_MS = 1200;    // between requests, so LinkedIn does not block them
// LinkedIn refuses with 429, or with its own 999 when it takes the requests for a bot.
const isBlocked = status => status === 429 || status === 999;
// Search-page parameters that only track the click or the scroll position.
const DROP = /^(currentJobId|origin|refresh|position|pageNum|start|trk|trackingId|refId|originalSubdomain|lipi|f_TPR)$/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// A job search link copied from the address bar: linkedin.com/jobs/search/?keywords=...&location=...
function isLinkedInSearch(input) {
  return /^(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/jobs(?:\/search|\/collections)?\/?(?:[?#]|$)/i.test(String(input || '').trim());
}

// "unreal developer · Remote, Poland" for the sources list.
function searchName(url) {
  try {
    const q = new URL(url).searchParams;
    return [q.get('keywords') && `"${q.get('keywords')}"`, q.get('location')].filter(Boolean).join(' · ') || 'LinkedIn jobs';
  } catch (_) { return 'LinkedIn jobs'; }
}

// The posting id from any LinkedIn job link (jobs/view/<slug>-<id>, currentJobId=<id>, urn:li:jobPosting:<id>).
function jobId(u) {
  const s = String(u || '');
  if (!/linkedin\.com/i.test(s)) return '';
  return (s.match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/i) || s.match(/currentJobId=(\d{6,})/i) || [])[1] || '';
}

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, signal: ctrl.signal });
    return { status: r.status, html: r.ok ? await r.text() : '' };
  } catch (_) {
    return { status: 0, html: '' };
  } finally {
    clearTimeout(t);
  }
}

// One <li> per posting: id, title, company, location, list date.
function parseResults(html) {
  return String(html || '').split(/<li[\s>]/i).slice(1).map(b => ({
    id: (b.match(/urn:li:jobPosting:(\d+)/) || [])[1] || jobId((b.match(/href="([^"]*\/jobs\/view\/[^"]+)"/) || [])[1]),
    title: clean((b.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/) || [])[1]),
    company: clean((b.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/) || [])[1]),
    location: clean((b.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/) || [])[1]),
    posted: (b.match(/<time[^>]+datetime="(\d{4}-\d{2}-\d{2})/) || [])[1] || '',
  })).filter(p => p.id && p.title);
}

// The posting page: description text and the "Seniority level / Employment type / ..." list.
function parsePosting(html) {
  const desc = (String(html).match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>\s*(?:<button|<\/section)/) || [])[1] || '';
  const criteria = [...String(html).matchAll(/job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/g)]
    .map(m => `${clean(m[1])}: ${clean(m[2])}`);
  return { body: htmlToText(desc), criteria };
}

// Search parameters for the guest endpoint: the user's own filters, newest first, only the last maxAgeDays.
// A link without keywords searches the "Look for" words.
function searchParams(url, maxAgeDays, include) {
  const q = new URL(url).searchParams;
  for (const k of [...q.keys()]) if (DROP.test(k)) q.delete(k);
  if (!q.get('keywords') && include.length) q.set('keywords', include.map(w => /\s/.test(w) ? `"${w}"` : w).join(' OR '));
  if (maxAgeDays) q.set('f_TPR', 'r' + maxAgeDays * 86400);
  q.set('sortBy', 'DD');
  return q;
}

// The built-in searches, run by "Find new jobs" without any link: the "Look for" words in the candidate's country
// and worldwide. The guest pages ignore LinkedIn's "Remote" filter (f_WT), so the worldwide search asks for postings
// that mention "remote" instead (most others are on-site abroad); whether the candidate can apply is left to Claude.
function builtInSearches(livesIn, include) {
  if (!include.length) return [];
  const search = (id, location, name, remote) => ({ id, kind: 'linkedin', builtIn: true, name, enabled: true, note: '', remote,
    url: 'https://www.linkedin.com/jobs/search/?location=' + encodeURIComponent(location) });
  return [
    ...(livesIn ? [search('linkedin-home', livesIn, 'your "Look for" words · ' + livesIn)] : []),
    search('linkedin-world', 'Worldwide', 'your "Look for" words · Worldwide, remote', true),
  ];
}

// Writing systems a title can be in. A posting titled in one the candidate's resume and profile never use
// (e.g. Chinese for a candidate writing in English and Russian) is in a language they do not work in.
const SCRIPTS = [/\p{Script=Han}/u, /[\p{Script=Hiragana}\p{Script=Katakana}]/u, /\p{Script=Hangul}/u, /\p{Script=Arabic}/u,
  /\p{Script=Hebrew}/u, /\p{Script=Thai}/u, /\p{Script=Devanagari}/u, /\p{Script=Greek}/u, /\p{Script=Georgian}/u, /\p{Script=Armenian}/u];
const foreignScript = (title, readable) => SCRIPTS.some(re => re.test(title) && !re.test(readable));

function card(p) {
  const text = [
    'Title: ' + p.title,
    p.company && 'Company: ' + p.company,
    p.location && 'Location: ' + p.location,
    ...p.criteria,
    p.posted && 'Posted: ' + p.posted,
    '',
    String(p.body || '').trim(),
  ].filter(x => x || x === '').join('\n');
  return { url: p.url, posted: p.posted, text: text.length > CARD_CHARS ? text.slice(0, CARD_CHARS) + '…' : text };
}

// Same result shape as ats-boards' collectBoard. known: function(url) → true for postings already in the list;
// readable: the candidate's resume and profile text (titles in other writing systems are skipped).
async function collectLinkedIn(source, { maxAgeDays, include = [], exclude = [], known = () => false, readable = '', onLog } = {}) {
  const label = 'LinkedIn ' + source.name;
  const fail = msg => { if (onLog) onLog(`${label}: ${msg}`); return { links: [], cards: [], filtered: false, failed: true }; };
  let q;
  try { q = searchParams(source.url, maxAgeDays, include); } catch (_) { return fail('bad search link'); }
  if (!q.get('keywords') && !q.get('f_C')) {
    return fail('no search words — search on LinkedIn first and paste that link, or add "Look for" words in the filter on the Extra sources tab');
  }
  if (source.remote) q.set('keywords', `remote AND (${q.get('keywords')})`);
  // LinkedIn matches the words anywhere in the posting; when they are the "Look for" words, the title must have one,
  // like on company boards.
  const byWords = !new URL(source.url).searchParams.get('keywords');

  // Result pages, until one brings nothing new.
  const found = new Map();
  let blocked = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    q.set('start', String(found.size));
    const r = await get(`${GUEST}/seeMoreJobPostings/search?${q}`);
    if (isBlocked(r.status)) { blocked = true; break; }
    const before = found.size;
    for (const p of parseResults(r.html)) if (!found.has(p.id)) found.set(p.id, p);
    if (found.size === before) break;
    await sleep(PAUSE_MS);
  }
  if (!found.size) return blocked ? fail('LinkedIn is limiting requests right now (429) — try again in an hour') : fail('no postings found for this search');

  let tooOld = 0, hidden = 0, seen = 0;
  const kept = [];
  for (const p of found.values()) {
    p.url = 'https://www.linkedin.com/jobs/view/' + p.id;
    if (known(p.url)) { seen++; continue; }
    if (maxAgeDays && postedAgeDays(p.posted) > maxAgeDays) { tooOld++; continue; }
    if (hasWord(p.title, exclude) || (byWords && !hasWord(p.title, include)) || foreignScript(p.title, readable)) { hidden++; continue; }
    kept.push(p);
  }
  kept.sort((a, b) => (b.posted || '').localeCompare(a.posted || ''));
  const limit = source.builtIn ? BUILT_IN_CARDS : MAX_CARDS;
  const picked = kept.slice(0, limit);
  if (onLog) onLog(`${label}: ${found.size} posting(s) found, reading ${picked.length}…`);

  // The postings themselves. When LinkedIn starts refusing, the rest go to Claude with what the result list showed.
  let unread = 0;
  for (const p of picked) {
    const r = blocked ? { status: 429, html: '' } : await get(`${GUEST}/jobPosting/${p.id}`);
    if (isBlocked(r.status)) blocked = true;
    Object.assign(p, r.html ? parsePosting(r.html) : { body: '', criteria: [] });
    if (!p.body) unread++;
    if (!blocked) await sleep(PAUSE_MS);
  }
  const cards = picked.map(card);
  if (onLog) onLog(`${label}: ${cards.length} new for Claude${unread ? ` (${unread} without the full text${blocked ? ' — LinkedIn limited requests' : ''})` : ''}`
    + `${hidden ? `, ${hidden} not matching your filter` : ''}${tooOld ? `, ${tooOld} older than ${maxAgeDays} days` : ''}`
    + `${seen ? `, ${seen} already in your list` : ''}${kept.length > cards.length ? `, ${kept.length - cards.length} more left out (limit ${limit})` : ''}`);
  return { links: [], cards, filtered: byWords };
}

module.exports = { isLinkedInSearch, searchName, jobId, builtInSearches, collectLinkedIn };
