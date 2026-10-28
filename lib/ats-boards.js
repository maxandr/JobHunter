// Company job boards on hiring platforms (Greenhouse, Lever, Ashby, Workable), read on this computer before Claude runs.
// These platforms publish every open posting of a company as public JSON, so the whole list costs no Claude tokens:
// the code filters it by your words and age, and Claude only scores what is left.
'use strict';

const { htmlToText, decode } = require('./fetch-posting');
const { hasWord, postedAgeDays } = require('./store');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_CARDS = 30;     // postings per company sent to Claude (big companies list hundreds)
const CARD_CHARS = 1500;  // how much of each posting Claude gets

const ATS_NAMES = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable' };

// Big boards are slow: Lever takes ~1 minute to send 300 postings.
async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function getHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: ctrl.signal });
    return r.ok ? await r.text() : '';
  } catch (_) {
    return '';
  } finally {
    clearTimeout(t);
  }
}

// Board links as they appear in the address bar or embedded in a company's careers page.
const BOARD_RES = [
  [/(?:boards|job-boards)(\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([a-z0-9_-]+)/i, 'greenhouse'],
  [/boards-api(\.eu)?\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i, 'greenhouse'],
  [/jobs(\.eu)?\.lever\.co\/([a-z0-9_.-]+)/i, 'lever'],
  [/api(\.eu)?\.lever\.co\/v0\/postings\/([a-z0-9_.-]+)/i, 'lever'],
  [/jobs\.ashbyhq\.com\/()([a-z0-9_.%-]+)/i, 'ashby'],
  [/apply\.workable\.com\/()([a-z0-9_-]+)/i, 'workable'],
];
const NOT_SLUGS = /^(embed|api|v0|v1|jobs|j|search|static|assets|careers)$/i;

function boardsIn(text) {
  const out = new Map();
  for (const [re, ats] of BOARD_RES) {
    for (const m of String(text || '').matchAll(new RegExp(re.source, 'gi'))) {
      let slug;
      try { slug = decodeURIComponent(m[2]).replace(/\.$/, ''); } catch (_) { continue; }
      if (slug && !NOT_SLUGS.test(slug)) out.set(`${ats}:${slug.toLowerCase()}`, { ats, slug, eu: !!m[1] });
    }
  }
  return [...out.values()];
}

// A board from the link itself, or else from the careers page it opens (many companies embed one of these boards).
// A page that links several boards is a job aggregator, not one company's careers page — then it stays a plain site.
async function findBoard(url) {
  const direct = boardsIn(url);
  if (direct.length) return direct[0];
  const found = boardsIn(await getHtml(url));
  return found.length === 1 ? found[0] : null;
}

const day = s => { const t = typeof s === 'number' ? s : Date.parse(s); return Number.isNaN(t) || !t ? '' : new Date(t).toISOString().slice(0, 10); };

// Every board comes back as { name, postings: [{ url, title, location, posted, text }] }, or null if it could not be read.
async function greenhouse({ slug, eu }) {
  const base = `https://boards-api${eu ? '.eu' : ''}.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`;
  const j = await getJson(base + '/jobs?content=true');
  if (!j || !Array.isArray(j.jobs)) return null;
  return {
    name: (j.jobs[0] && j.jobs[0].company_name) || '',
    postings: j.jobs.map(p => ({
      url: p.absolute_url,
      title: p.title || '',
      location: (p.location && p.location.name) || '',
      posted: day(p.first_published || p.updated_at),
      body: htmlToText(decode(p.content || '')),
    })),
  };
}

async function lever({ slug, eu }) {
  const list = await getJson(`https://api${eu ? '.eu' : ''}.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  if (!Array.isArray(list)) return null;
  return {
    name: '',
    postings: list.map(p => {
      const c = p.categories || {};
      return {
        url: p.hostedUrl,
        title: p.text || '',
        location: [c.location, ...(c.allLocations || []).filter(l => l !== c.location)].filter(Boolean).join('; '),
        posted: day(p.createdAt),
        extra: [p.workplaceType && 'Workplace: ' + p.workplaceType, c.commitment && 'Commitment: ' + c.commitment],
        body: [p.descriptionPlain || htmlToText(p.description), ...(p.lists || []).map(l => l.text + '\n' + htmlToText(l.content))].join('\n'),
      };
    }),
  };
}

async function ashby({ slug }) {
  const j = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`);
  if (!j || !Array.isArray(j.jobs)) return null;
  return {
    name: '',
    postings: j.jobs.filter(p => p.isListed !== false).map(p => ({
      url: p.jobUrl,
      title: p.title || '',
      location: [p.location, ...(p.secondaryLocations || []).map(l => l.location)].filter(Boolean).join('; '),
      posted: day(p.publishedAt),
      extra: [
        p.workplaceType && 'Workplace: ' + p.workplaceType,
        p.isRemote && 'Remote: yes',
        p.employmentType && 'Employment type: ' + p.employmentType,
        p.compensation && p.compensation.compensationTierSummary && 'Compensation: ' + p.compensation.compensationTierSummary,
      ],
      body: p.descriptionPlain || htmlToText(p.descriptionHtml),
    })),
  };
}

async function workable({ slug }) {
  const j = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`);
  if (!j || !Array.isArray(j.jobs)) return null;
  return {
    name: j.name || '',
    postings: j.jobs.map(p => ({
      url: p.url || p.shortlink,
      title: p.title || '',
      location: ((p.locations || []).filter(l => !l.hidden).map(l => [l.city, l.region, l.country].filter(Boolean).join(', '))
        .filter(Boolean).join('; ')) || [p.city, p.state, p.country].filter(Boolean).join(', '),
      posted: day(p.published_on || p.created_at),
      extra: [p.telecommuting && 'Remote: yes', p.employment_type && 'Employment type: ' + p.employment_type],
      body: htmlToText(p.description || ''),
    })),
  };
}

const READERS = { greenhouse, lever, ashby, workable };

function card(p, company) {
  const text = [
    'Title: ' + p.title,
    company && 'Company: ' + company,
    p.location && 'Location: ' + p.location,
    ...(p.extra || []),
    p.posted && 'Posted: ' + p.posted,
    '',
    String(p.body || '').trim(),
  ].filter(x => x || x === '').join('\n');
  return { url: p.url, posted: p.posted, text: text.length > CARD_CHARS ? text.slice(0, CARD_CHARS) + '…' : text };
}

// Same result shape as source-links' collectLinks: cards = downloaded postings, links = none (the board lists them all).
// Titles must have a "look for" word (when there are any) and no "hide" word; known: normalized URLs to skip.
async function collectBoard(source, { maxAgeDays, include = [], exclude = [], known = () => false, onLog } = {}) {
  const read = READERS[source.ats];
  const board = read && await read({ slug: source.slug, eu: source.eu });
  const label = source.name || source.slug;
  if (!board) {
    if (onLog) onLog(`${label}: could not read the ${ATS_NAMES[source.ats] || source.ats} board — check the link on the Extra sources tab`);
    return { links: [], cards: [], filtered: false, failed: true };
  }
  const all = board.postings.filter(p => p.url && p.title);
  let tooOld = 0, hidden = 0, seen = 0;
  const kept = [];
  for (const p of all) {
    if (known(p.url)) { seen++; continue; }
    if (maxAgeDays && postedAgeDays(p.posted) > maxAgeDays) { tooOld++; continue; }
    if (hasWord(p.title, exclude) || (include.length && !hasWord(p.title, include))) { hidden++; continue; }
    kept.push(p);
  }
  kept.sort((a, b) => (b.posted || '').localeCompare(a.posted || ''));
  const cards = kept.slice(0, MAX_CARDS).map(p => card(p, board.name || label));
  if (onLog) onLog(`${label}: ${all.length} open posting(s), ${cards.length} new for Claude`
    + `${hidden ? `, ${hidden} not matching your filter words` : ''}${tooOld ? `, ${tooOld} older than ${maxAgeDays} days` : ''}`
    + `${seen ? `, ${seen} already in your list` : ''}${kept.length > cards.length ? `, ${kept.length - cards.length} more left out (limit ${MAX_CARDS})` : ''}`);
  return { links: [], cards, filtered: include.length > 0, name: board.name };
}

module.exports = { findBoard, collectBoard, ATS_NAMES };
