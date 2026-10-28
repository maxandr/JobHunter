// Downloads a job posting's text on this computer before Claude sees it.
// Many job sites (Workable, Lever, Greenhouse...) render with JavaScript, so a plain page fetch from Claude
// sometimes gets an empty shell. Here we try the sites' public JSON/Markdown endpoints first, then the HTML.
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX = 30000;

async function get(url, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept || '*/*' }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
  return decode(String(html || '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const enough = s => s && s.replace(/\s+/g, ' ').length > 400;

// schema.org JobPosting inside the HTML (most job boards include it for Google Jobs).
function jsonLd(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = [].concat(data['@graph'] || data);
      for (const it of items) {
        if (!it || !/JobPosting/i.test(String(it['@type']))) continue;
        const loc = [].concat(it.jobLocation || []).map(l => {
          const a = (l && l.address) || {};
          return [a.addressLocality, a.addressRegion, a.addressCountry && (a.addressCountry.name || a.addressCountry)].filter(Boolean).join(', ');
        }).filter(Boolean).join('; ');
        const req = [].concat(it.applicantLocationRequirements || []).map(r => r && (r.name || r)).filter(Boolean).join(', ');
        out.push([
          'Title: ' + (it.title || ''),
          'Company: ' + ((it.hiringOrganization && it.hiringOrganization.name) || ''),
          loc && 'Location: ' + loc,
          it.jobLocationType && 'Location type: ' + it.jobLocationType,
          req && 'Applicant location requirements: ' + req,
          it.employmentType && 'Employment type: ' + [].concat(it.employmentType).join(', '),
          it.datePosted && 'Posted: ' + it.datePosted,
          it.validThrough && 'Valid through: ' + it.validThrough,
          '',
          htmlToText(it.description || ''),
        ].filter(x => x !== false && x !== undefined && x !== null).join('\n'));
      }
    } catch (_) { /* not valid JSON */ }
  }
  return out.join('\n\n');
}

function workableText(j) {
  const loc = j.location || {};
  const locs = [].concat(j.locations || []).map(l => [l.city, l.region, l.country].filter(Boolean).join(', ')).filter(Boolean);
  return [
    'Title: ' + (j.title || ''),
    'Location: ' + ([loc.city, loc.region, loc.country].filter(Boolean).join(', ') || locs.join('; ')),
    locs.length > 1 ? 'All locations: ' + locs.join('; ') : '',
    j.workplace && 'Workplace: ' + j.workplace,
    j.remote != null && 'Remote: ' + j.remote,
    j.type && 'Employment type: ' + j.type,
    j.published && 'Published: ' + j.published,
    '',
    htmlToText(j.description || ''),
    j.requirements ? '\nRequirements:\n' + htmlToText(j.requirements) : '',
    j.benefits ? '\nBenefits:\n' + htmlToText(j.benefits) : '',
  ].filter(Boolean).join('\n');
}

async function tryWorkable(u) {
  const m = u.pathname.match(/^\/([^/]+)\/(?:j|jobs\/view)\/([A-Z0-9]+)/i);
  if (!/(^|\.)workable\.com$/i.test(u.hostname) || !m) return null;
  const [, acc, code] = m;
  const api = await get(`https://apply.workable.com/api/v2/accounts/${acc}/jobs/${code}`, 'application/json');
  if (api) {
    try { const t = workableText(JSON.parse(api)); if (enough(t)) return t; } catch (_) { /* fall through */ }
  }
  const md = await get(`https://apply.workable.com/${acc}/jobs/view/${code}.md`, 'text/markdown, text/plain');
  if (enough(md) && !/^\s*</.test(md)) return md;
  return null;
}

async function tryLever(u) {
  const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
  if (!/(^|\.)lever\.co$/i.test(u.hostname) || !m) return null;
  const api = await get(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`, 'application/json');
  if (!api) return null;
  try {
    const j = JSON.parse(api);
    const c = j.categories || {};
    return [
      'Title: ' + j.text, 'Location: ' + (c.location || ''), (c.allLocations || []).length ? 'All locations: ' + c.allLocations.join('; ') : '',
      'Workplace: ' + (j.workplaceType || ''), 'Commitment: ' + (c.commitment || ''), '',
      j.descriptionPlain || htmlToText(j.description),
      ...(j.lists || []).map(l => '\n' + l.text + '\n' + htmlToText(l.content)),
      j.additionalPlain || '',
    ].filter(Boolean).join('\n');
  } catch (_) { return null; }
}

async function tryGreenhouse(u) {
  const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (!/greenhouse\.io$/i.test(u.hostname) || !m) return null;
  const api = await get(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`, 'application/json');
  if (!api) return null;
  try {
    const j = JSON.parse(api);
    return ['Title: ' + j.title, 'Location: ' + ((j.location && j.location.name) || ''), '', htmlToText(decode(j.content || ''))].join('\n');
  } catch (_) { return null; }
}

/** Returns the posting text, or '' if nothing useful could be downloaded. */
async function fetchPosting(url) {
  let u;
  try { u = new URL(url); } catch (_) { return ''; }
  for (const fn of [tryWorkable, tryLever, tryGreenhouse]) {
    const t = await fn(u);
    if (enough(t)) return t.slice(0, MAX);
  }
  const html = await get(url, 'text/html');
  if (!html) return '';
  const ld = jsonLd(html);
  if (enough(ld)) return ld.slice(0, MAX);
  const text = htmlToText(html);
  return enough(text) ? text.slice(0, MAX) : '';
}

module.exports = { fetchPosting, htmlToText, jsonLd, decode };
