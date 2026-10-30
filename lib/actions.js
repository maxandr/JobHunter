// The three things the app asks Claude to do: search, analyze one posting, tailor CV + cover letter.
'use strict';

const store = require('./store');
const { runClaude, perplexityStatus } = require('./claude');
const { cvPages } = require('./pdf');
const { fetchPosting } = require('./fetch-posting');
const { collectLinks } = require('./source-links');
const { collectBoard, ATS_NAMES } = require('./ats-boards');
const { collectLinkedIn, builtInSearches, jobId } = require('./linkedin');
const ats = require('./ats');

const JOB_ITEM = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    company: { type: 'string' },
    url: { type: 'string' },
    location: { type: 'string', description: 'Where the role is based / which countries can apply' },
    remote: { type: 'string', description: 'e.g. "Fully remote, worldwide", "Remote LATAM", "Hybrid". Only what the posting actually says; "Unconfirmed" if you could not read it' },
    location_evidence: { type: 'string', description: 'EXACT quote from the posting about location / remote / who can apply, copied word for word. Empty if you did not see such text.' },
    salary: { type: 'string', description: 'Pay range the posting states, converted to the candidate\'s currency (see SALARY), with period; if the posting uses another currency add the original in parentheses. Empty if the posting gives no numbers' },
    salary_estimate: {
      type: 'object',
      description: 'Only when salary is empty: what the candidate can realistically expect for this role, from salary data on the web',
      properties: {
        range: { type: 'string', description: 'Always in the candidate\'s currency (see SALARY), per year or per hour' },
        basis: { type: 'string', description: 'One short sentence: which level / role / company type / candidate-location assumptions and what data it is based on' },
        sources: { type: 'array', items: { type: 'string' }, description: 'URLs of the salary data used (max 3)' },
      },
      required: ['range', 'basis'],
    },
    posted: { type: 'string', description: 'Posting date if known (YYYY-MM-DD), else empty' },
    source: { type: 'string', description: 'Job board or site name' },
    language: { type: 'string', description: 'Team working language: en, ru, other' },
    summary: { type: 'string', description: '1-2 sentences: what the role is' },
    requirements: {
      type: 'array',
      description: 'Every concrete requirement / nice-to-have from the posting (max 15), checked against the resume and profile',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The requirement, short, in the posting\'s words' },
          importance: { type: 'string', enum: ['required', 'nice'] },
          in_resume: { type: 'boolean', description: 'true only if the resume or profile clearly shows it' },
          evidence: { type: 'string', description: 'If in_resume: which resume fact shows it (short). If not: empty' },
        },
        required: ['text', 'importance', 'in_resume'],
      },
    },
    fit_breakdown: {
      type: 'array',
      description: 'Score by the fixed rubric: exactly 5 items with keys stack(35), seniority(25), domain(15), location(15), preferences(10)',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: ['stack', 'seniority', 'domain', 'location', 'preferences'] },
          points: { type: 'number', description: 'Points given, from 0 to the max for this key' },
          note: { type: 'string', description: 'Short reason for THESE points: what matched and what was missing' },
        },
        required: ['key', 'points', 'note'],
      },
    },
    fit_score: { type: 'number', description: '0-100, equals the sum of fit_breakdown points' },
    fit_reason: { type: 'string', description: 'One short sentence why' },
  },
  required: ['title', 'company', 'url', 'summary', 'fit_breakdown', 'fit_score', 'fit_reason'],
};

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    jobs: { type: 'array', items: JOB_ITEM },
    notes: { type: 'string', description: 'Short note on what was searched / any problems' },
  },
  required: ['jobs'],
};

const TAILOR_SCHEMA = {
  type: 'object',
  properties: {
    cv_markdown: { type: 'string', description: 'Full tailored resume in Markdown' },
    cover_letter: { type: 'string', description: 'Cover letter, plain text, ready to paste' },
    keywords: { type: 'array', items: { type: 'string' }, description: 'ATS keywords from the posting now covered in the CV' },
    missing: { type: 'array', items: { type: 'string' }, description: 'Requirements the candidate does not clearly meet' },
    changes: { type: 'string', description: 'Short summary of what was changed vs the base resume' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Facts to ask the candidate that would strengthen this CV if true' },
    job_keywords: {
      type: 'object',
      description: 'Terms an ATS would search for, taken from the posting (not from the resume), written exactly as the posting writes them',
      properties: {
        role: { type: 'string', description: 'The posting\'s job title, as written' },
        required_skills: { type: 'array', items: { type: 'string' }, description: 'Must-have technologies, tools, engines, languages, methods' },
        preferred_skills: { type: 'array', items: { type: 'string' }, description: 'Nice-to-have technologies, tools, methods' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Other domain terms (genres, platforms, systems), 1-3 words each' },
      },
      required: ['role', 'required_skills', 'preferred_skills', 'keywords'],
    },
  },
  required: ['cv_markdown', 'cover_letter', 'changes', 'job_keywords'],
};

// Second Generate pass: works in posting keywords the base resume supports and fixes unsupported claims.
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    cv_markdown: { type: 'string', description: 'The full corrected resume in Markdown' },
    changes: { type: 'string', description: 'One short sentence on what this pass changed' },
  },
  required: ['cv_markdown'],
};

const PERSON = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    title: { type: 'string', description: 'Current job title at the company, as their profile shows it' },
    linkedin: { type: 'string', description: 'linkedin.com/in/... profile URL, empty if not found' },
    url: { type: 'string', description: 'Other public page where you found them (team page, X, GitHub, talk), empty if none' },
    why: { type: 'string', description: 'One short sentence: why this person (e.g. "posted this role on LinkedIn", "lead of the team this role is in")' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How sure you are they currently work there in this role' },
    location: { type: 'string', description: 'Where they work / are based (city, country) as their profile or the page shows it, empty if not seen' },
    location_match: {
      type: 'string', enum: ['job_location', 'same_country', 'other', 'unknown'],
      description: 'job_location = same city / office as the job; same_country = same country, other city; other = elsewhere; unknown = not seen',
    },
    message: { type: 'string', description: 'Ready-to-send LinkedIn connection note from the candidate, max 300 characters' },
  },
  required: ['name', 'title', 'why', 'confidence', 'location', 'location_match', 'message'],
};

const PEOPLE_SCHEMA = {
  type: 'object',
  properties: {
    hiring: { type: 'array', items: PERSON, description: 'Recruiters / talent acquisition / hiring managers for THIS role (max 3), best first' },
    referral_program: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['yes', 'no', 'unknown'] },
        details: { type: 'string', description: 'What is known: bonus, who can refer, how it works. Empty if unknown' },
        sources: { type: 'array', items: { type: 'string' }, description: 'URLs that show it (max 3)' },
      },
      required: ['status', 'details'],
    },
    referrers: { type: 'array', items: PERSON, description: 'Exactly 3 employees who could refer the candidate, best first' },
    notes: { type: 'string', description: 'Short note: what was searched, anything to watch out for' },
  },
  required: ['hiring', 'referral_program', 'referrers'],
};

// Language rule for a prompt from the Settings tab ("languages"): "auto" keeps the given auto text.
function langRule(lang, what, autoText) {
  if (!lang || lang === 'auto') return autoText;
  return `ALWAYS write ${what} in ${lang}, even if the posting, the form or the base resume is in another language.`;
}

// Perplexity connector from the claude.ai account Claude Code is logged into — no API key needed.
const PERPLEXITY_TOOLS = ['mcp__claude_ai_Perplexity__perplexity_search', 'mcp__claude_ai_Perplexity__perplexity_ask'];

// On in Settings and not known to be missing from the account (checkPerplexity runs at start and on "Test Claude").
const usePerplexity = config => config.perplexity && perplexityStatus().found !== false;

function webTools(config) {
  return ['WebSearch', 'WebFetch', ...(usePerplexity(config) ? PERPLEXITY_TOOLS : []), ...(config.extraAllowedTools || [])];
}

// Extra prompt lines telling Claude how to use Perplexity; empty when it is turned off or missing.
function perplexityHint(config, action) {
  if (!usePerplexity(config)) return '';
  if (action === 'search') {
    return `
PERPLEXITY (use it together with WebSearch, it often finds fresh postings WebSearch misses):
- perplexity_search: run several targeted queries (different role titles, technologies, boards, "remote", queries in each
  language the candidate works in) with a recency filter of a month or less, and collect posting URLs from the results.
- perplexity_ask: quick questions like "which companies are hiring remote <target role> right now" or
  "is <posting URL> still open" — use the cited URLs as leads.
- Perplexity answers are leads, not proof: still open each posting with WebFetch before including it, and take all
  posting facts (location, dates, requirements) from the posting page itself.
- If a Perplexity tool fails or is unavailable, just continue with WebSearch/WebFetch.
`;
  }
  return `
If WebFetch cannot read the posting (blocked, empty, login wall), use perplexity_search / perplexity_ask to find the same
posting text elsewhere (other boards, company career page). Never fill in details Perplexity only guesses.
If a Perplexity tool fails or is unavailable, just continue with WebSearch/WebFetch.
`;
}

// Prompt block for the sites and Telegram channels added on the "Sources" tab; empty when there are none.
// links: { [source id]: { links, filtered } } collected beforehand by lib/source-links.js.
function sourcesBlock(list, only, links = {}) {
  if (!list.length) return '';
  const lines = list.map(s => {
    const where = s.kind === 'telegram' ? 'Telegram ' + s.name + ' — read ' + s.url
      : s.kind === 'company' ? `${s.name} — company job board on ${ATS_NAMES[s.ats]} (every new open posting matching the candidate's words is below; do not open the board)`
        : s.kind === 'linkedin' ? `LinkedIn job search ${s.name} (the newest results are below; do not open LinkedIn — WebFetch cannot read it, use the text given; url = the given linkedin.com/jobs/view link)`
          : s.url;
    const head = `- ${where}${s.note ? ' (' + s.note + ')' : ''}`;
    const l = links[s.id];
    if (!l || (!l.links.length && !l.cards.length)) return head;
    const cards = l.cards.map(c => `  <posting url="${c.url}">\n${c.text}\n  </posting>`).join('\n');
    return `${head}${l.cards.length ? `
  Postings already downloaded from this site (start of each page, from the site's structured data — "Posted" there is
  the real publication date, trust it; "Location"/"Location type: TELECOMMUTE" are from the site too; a posting with no
  "Posted" line is the page's own text — take the date from that text if it shows one):
${cards}` : ''}${l.links.length ? `
  More posting links from this site (not downloaded; ${l.filtered ? 'matching the candidate\'s keywords' : 'newest'}):
${l.links.map(u => '    ' + u).join('\n')}` : ''}`;
  });
  return `
CANDIDATE'S OWN SOURCES (${only ? 'search ONLY these — do not use other boards or general web search' : 'check EVERY one of these first, then the rest'}):
${lines.join('\n')}
- Downloaded postings: judge them from the text given; open the URL with WebFetch only when the location / who can
  apply is unclear from that text. Take posted from the "Posted" line. The site may also show a location that is
  just the office (e.g. "Location: PL" with "Location type: TELECOMMUTE") — apply the LOCATION RULES as usual.
- Plain links: judge each by its slug (title, company), open the promising ones with WebFetch and check them like any
  posting. Skip obvious non-fits (art, QA, marketing, hardware...) without opening. If the page shows no date, set
  posted empty (do NOT drop the posting only because the date is unknown).
- Sites without collected links: open the page with WebFetch, follow links to individual postings; if the page needs
  JavaScript or search parameters, try WebSearch with "site:<domain> <role keywords>".
- Telegram channels: the t.me/s/<channel> page is the public web preview with the latest posts. Read the posts, keep
  only job postings. A post that links to a full posting (company site, board) — open that link and use it as url.
  Otherwise use the post link https://t.me/<channel>/<post number> as url and the post text as the posting.
  Use the post date as posted. source = the channel name (e.g. "@channel").
`;
}

// "Where you work from" fields from the Profile tab. An empty country falls back to what the profile text says.
function candidateFacts() {
  const c = store.candidate();
  return {
    place: c.livesIn || "the candidate's country (from the profile)",
    timezone: c.timezone,
    currency: c.currency || 'USD',
  };
}

function salaryRules({ place, currency }) {
  return `
SALARY:
- salary: only the pay range the posting itself states, with its period. Always give it in ${currency}: if the posting
  uses another currency, convert it at the current exchange rate, round to a sensible step, and keep the original in
  parentheses, e.g. "${currency} 86,000–108,000 / year (posting: XXX 80,000–100,000)". Note if the posting gives net vs
  gross. No numbers in the posting ("competitive", "negotiable", "DOE") = empty.
- salary_estimate: fill it ONLY when salary is empty. Look up current salary data for this kind of role with WebSearch
  (Glassdoor, Levels.fyi, Payscale, Built In, industry salary surveys for the candidate's field, regional salary stats
  for the company's country, other postings from the same company or similar companies that do show pay). Estimate what THIS candidate can expect:
  the role's level (do not lift a junior/mid role to senior pay), the company's size and country, and that the candidate
  works from ${place} (remote / contract terms as the profile says). Give a realistic range in ${currency} (convert from
  local-currency data at the current rate), per year for salaried roles or per hour for contract roles, a one-sentence
  basis, and the source URLs.
  Similar roles in one search may share the same lookup. Never present the estimate as the posting's own figure.
`;
}

// Scoring, requirements check, salary and location rules — the same for search and for a single posting.
function scoringRules(c) {
  return `SCORING RUBRIC (fit_breakdown; fit_score = sum of points):
- stack (max 35): how well the technologies the posting asks for (languages, engines, frameworks, tools) match the
  resume and profile. Nice-to-haves only add; missing nice-to-haves cost little.
- seniority (max 25): can the candidate do this role level, judging by the resume (years, titles, scope)? Roles AT OR
  BELOW the candidate's level get full 25 — the candidate is fine with them, never treat them as "underselling".
  Lower only if the role needs MORE than the candidate has (e.g. more years, director/principal scope, management the
  candidate never did). Never lower any other category because the role is below the candidate's level either.
- domain (max 15): is the type of work among the target roles in the profile? Any role inside those targets gets full
  15. Lower only for work outside them (another industry, or a main stack the profile does not target).
- location (max 15): 15 if working from ${c.place} is allowed OR not confirmed either way; lower only with
  location_evidence that excludes ${c.place} (then 0).
- preferences (max 10): fit with the profile (language, contract/employee, things the candidate wants or avoids).
  Use only facts stated in the posting — no guessing (e.g. do not assume an employee contract or a country from the
  office city). Unknown = no deduction. Do not deduct again for anything already scored in stack, seniority, domain
  or location (role scope, level, type of work, location).
Every note must name concrete facts from the posting and the resume, not generic phrases.

REQUIREMENTS CHECK (requirements): list every concrete skill/experience requirement and nice-to-have from the posting
(skip generic soft skills like "team player"). in_resume = true only if the resume or profile clearly shows it, with
the fact in evidence. Related-but-different experience (a similar tool or library, not the one asked for) is
in_resume = false, and say what related experience exists in evidence prefixed with "Related: ".
${salaryRules(c)}
LOCATION RULES (important):
- Only state a location restriction (e.g. "Poland only", "US residents only") if the posting text you actually read says so.
  Copy that text word for word into location_evidence.
- Never infer a restriction from the company's country, office city, the language of the title, or where the job is
  cross-posted. If the posting does not state it (or you could not open the page), set remote to "Unconfirmed",
  leave location_evidence empty, and do NOT lower fit_score for location — say "location not confirmed" in fit_reason.
- Lower fit_score for location only when location_evidence clearly excludes someone living in ${c.place}.`;
}

function context() {
  const resume = store.readText(store.FILES.resume).trim();
  const profile = store.readText(store.FILES.profile).trim();
  if (!resume) throw new Error('Resume is empty. Open the "Resume" tab and paste your CV first.');
  return { resume, profile };
}

// maxAgeDays: only postings published within this many days (0 = any age); defaults to 30.
// sourcesOnly: look only at the sites / Telegram channels from the "Sources" tab (and the built-in LinkedIn searches).
async function search({ onLog, maxAgeDays, sourcesOnly = false } = {}) {
  const config = store.config();
  const { resume, profile } = context();
  const filter = store.sourceFilter();
  const linkedInAuto = config.linkedin ? builtInSearches(store.candidate().livesIn, filter.include) : [];
  let mySources = store.sources().filter(s => s.enabled).concat(linkedInAuto);
  if (sourcesOnly && !mySources.length) throw new Error('No sources turned on. Add companies, sites or Telegram channels on the "Extra sources" tab.');
  const known = store.jobs().map(j => `${j.company} — ${j.title} — ${j.url}`).slice(-300);
  const today = new Date().toISOString().slice(0, 10);
  const maxAge = maxAgeDays != null ? maxAgeDays : 30;
  const knownUrls = new Set(store.jobs().map(j => store.normalizeUrl(j.url)));
  const links = {};
  for (const s of mySources.filter(x => x.kind === 'site')) {
    if (onLog) onLog(`Collecting posting links from ${s.name}…`);
    try {
      const r = await collectLinks(s, { maxAgeDays: maxAge, include: filter.include, exclude: filter.exclude, onLog });
      r.links = r.links.filter(u => !knownUrls.has(store.normalizeUrl(u)));
      r.cards = r.cards.filter(c => !knownUrls.has(store.normalizeUrl(c.url)));
      links[s.id] = r;
    } catch (e) { if (onLog) onLog(`${s.name}: could not collect links (${e.message})`); }
  }
  for (const s of mySources.filter(x => x.kind === 'company')) {
    if (onLog) onLog(`Reading open postings of ${s.name} (${ATS_NAMES[s.ats]})…`);
    try {
      const r = await collectBoard(s, { maxAgeDays: maxAge, include: filter.include, exclude: filter.exclude,
        known: u => knownUrls.has(store.normalizeUrl(u)), onLog });
      links[s.id] = r;
      if (r.name && r.name !== s.name) { store.updateSource(s.id, { name: r.name }); s.name = r.name; }
    } catch (e) { if (onLog) onLog(`${s.name}: could not read the board (${e.message})`); }
  }
  // LinkedIn links of the same posting differ (pl.linkedin.com/jobs/view/<slug>-<id>), so known ones are matched by id.
  // Searches overlap (a posting in your country is also a worldwide one): each takes only what the earlier ones did not.
  const knownLinkedIn = new Set(store.jobs().map(j => jobId(j.url)).filter(Boolean));
  for (const s of mySources.filter(x => x.kind === 'linkedin')) {
    if (onLog) onLog(`Reading LinkedIn search ${s.name}…`);
    try {
      const r = await collectLinkedIn(s, { maxAgeDays: maxAge, include: filter.include, exclude: filter.exclude,
        known: u => knownLinkedIn.has(jobId(u)), readable: resume + '\n' + profile, onLog });
      for (const c of r.cards) knownLinkedIn.add(jobId(c.url));
      links[s.id] = r;
    } catch (e) { if (onLog) onLog(`LinkedIn ${s.name}: could not read the search (${e.message})`); }
  }
  // Companies and LinkedIn searches with nothing new are left out of the prompt; with no other sources and nothing new,
  // Claude is not run at all.
  mySources = mySources.filter(s => (s.kind !== 'company' && s.kind !== 'linkedin') || (links[s.id] && links[s.id].cards.length));
  if (sourcesOnly && !mySources.length) {
    if (onLog) onLog('No new postings in your sources — Claude was not run');
    return { added: 0, found: 0, tooOld: 0, notes: 'nothing new in your sources', costUsd: 0, durationMs: 0 };
  }
  const cutoff = new Date(Date.now() - maxAge * 86400000).toISOString().slice(0, 10);

  const prompt = `Today is ${today}. You are a job-search assistant for one candidate.

CANDIDATE PROFILE AND PREFERENCES:
${profile || '(none given)'}

CANDIDATE RESUME:
${resume}

TASK:
${sourcesOnly ? `Find currently OPEN job postings that fit this candidate in the sources listed below.
` : `Search the web for currently OPEN job postings that fit this candidate. Cast a wide net: general web search,
remote job boards (e.g. We Work Remotely, Wellfound, Arc.dev, RemoteOK, Lemon.io), boards for the candidate's
industry and region (any the profile names, plus others you know that fit the target roles, languages and location),
company career pages (Greenhouse, Lever, Workable,
Breezy, BambooHR)${linkedInAuto.length ? '. LinkedIn is already searched (results below) — do not search it again'
    : ' and best-effort LinkedIn (e.g. search "site:linkedin.com/jobs ...")'}.
${perplexityHint(config, 'search')}`}${sourcesBlock(mySources, sourcesOnly, links)}
RULES:
- Only include postings you have good reason to believe are still open (open the posting page with WebFetch when
  possible; skip anything marked closed, archived, expired, "вакансия в архиве").
${maxAge ? `- Only include postings published within the last ${maxAge} days (on or after ${cutoff}). Skip older ones.
` : ''}- Always fill posted as YYYY-MM-DD. Convert relative dates ("3 weeks ago", "2 дня назад") using today's date.
  Leave it empty only if the posting shows no date at all.
- Respect the candidate's location constraints from the profile (do not include roles the candidate cannot legally take).
- The profile's "Not interested in" list holds the candidate's reasons for skipping earlier jobs. Skip postings
  those reasons clearly apply to.
${filter.exclude.length ? `- The candidate does NOT want roles whose title mentions any of: ${filter.exclude.join(', ')}. Skip them.
` : ''}- Skip anything already known (list below). Do not return duplicates.
- Return at most ${config.maxJobsPerSearch} best matches, sorted by fit_score descending.
- url must be the direct posting URL, not a search results page, whenever possible.
- Do not invent postings. If you find nothing new, return an empty list.

${scoringRules(candidateFacts())}

ALREADY KNOWN (skip these):
${known.length ? known.join('\n') : '(none yet)'}`;

  const { data, costUsd, durationMs } = await runClaude({
    prompt,
    schema: SEARCH_SCHEMA,
    action: 'search',
    allowedTools: webTools(config),
    config,
    cwd: store.WORK,
    timeoutMs: config.searchTimeoutMinutes * 60 * 1000,
    onLog,
  });
  const all = Array.isArray(data) ? data : (data.jobs || []);
  // Claude does not always follow the age rule — drop postings with a known date older than the limit.
  const fresh = maxAge ? all.filter(j => !(store.postedAgeDays(j && j.posted) > maxAge)) : all;
  const tooOld = all.length - fresh.length;
  if (tooOld && onLog) onLog(`Skipped ${tooOld} posting(s) older than ${maxAge} days`);
  // Same for the "hide words" filter from the Sources tab.
  const list = fresh.filter(j => !(j && store.hasWord(j.title, filter.exclude)));
  if (fresh.length > list.length && onLog) onLog(`Hid ${fresh.length - list.length} posting(s) by your filter words`);
  const added = store.addJobs(list, 'search');
  return { added: added.length, found: list.length, tooOld, notes: data.notes || '', costUsd, durationMs };
}

async function analyze(input, { onLog, refreshId, savedText = '' } = {}) {
  const config = store.config();
  const { resume, profile } = context();
  const isUrl = /^https?:\/\//i.test(input.trim());
  // Download the page here first: job sites often render with JavaScript and Claude's own fetch then sees an empty page.
  let pageText = isUrl ? await fetchPosting(input.trim()) : '';
  if (isUrl && !pageText && savedText) {
    pageText = savedText;
    if (onLog) onLog('Could not download the page again — using the posting text saved earlier');
  } else if (onLog) onLog(isUrl ? (pageText ? `Downloaded posting text (${pageText.length} chars)` : 'Could not download the page, Claude will try') : 'Using pasted text');
  const postingBlock = !isUrl
    ? 'JOB POSTING TEXT:\n' + input.trim()
    : pageText
      ? `JOB POSTING URL: ${input.trim()}\n\nPOSTING TEXT (already downloaded from that URL — use it; open the URL only if something important is missing):\n${pageText}`
      : `JOB POSTING URL (open it with WebFetch; if blocked or empty, search the web for the same posting elsewhere):\n${input.trim()}\n${perplexityHint(config, 'analyze')}`;
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today is ${today}. You help one candidate evaluate a job posting.

CANDIDATE PROFILE AND PREFERENCES:
${profile || '(none given)'}

CANDIDATE RESUME:
${resume}

${postingBlock}

Extract the posting details and rate the candidate's fit. Return a JSON object with a "jobs" array containing exactly
one item. If the posting is clearly closed, say so in fit_reason and give fit_score 0.
${scoringRules(candidateFacts())}
posted: the publication date as YYYY-MM-DD; convert relative dates ("3 weeks ago") using today's date; empty if not shown.
If you cannot read the posting at all (page blocked and not found elsewhere), return {"jobs": []} — do not guess.`;

  const runOnce = async () => {
    const { data } = await runClaude({
      prompt,
      schema: SEARCH_SCHEMA,
      action: 'analyze',
      // Web tools also for pasted text: the salary estimate needs a web lookup.
      allowedTools: webTools(config),
      config,
      cwd: store.WORK,
      timeoutMs: 6 * 60 * 1000,
      onLog,
    });
    return (Array.isArray(data) ? data : data.jobs || [])[0];
  };
  let item;
  try { item = await runOnce(); } catch (e) { if (onLog) onLog('First attempt failed: ' + e.message); }
  if (!item) {
    // Pages sometimes fail to load on the first try — one automatic retry before giving up.
    if (onLog) onLog('Retrying once…');
    item = await runOnce();
  }
  if (!item) throw new Error('Could not open this posting. Copy the posting text from the page and paste it instead of the link.');
  if (isUrl && !item.url) item.url = input.trim();
  item.posting_text = pageText || (isUrl ? '' : input.trim());
  if (refreshId) {
    const job = store.refreshJob(refreshId, item);
    if (!job) throw new Error('Job not found');
    return { refreshed: true, job };
  }
  const added = store.addJobs([item], 'manual');
  if (!added.length) throw new Error('This posting is already in your list');
  return { added: 1, job: added[0] };
}

// lang: one-off language for this CV + cover letter (from the Generate box); empty = the Settings tab values.
// ATS numbers for the docs view: base resume vs tailored CV, plus what the code checks flagged.
function atsReport(cv, resume, profile, jobKeywords) {
  if (!jobKeywords || !jobKeywords.role && !(jobKeywords.required_skills || []).length) return {};
  const source = resume + '\n\n' + profile;
  return {
    ats: { base: ats.score(resume, jobKeywords, source), cv: ats.score(cv, jobKeywords, source) },
    warnings: ats.factCheck(source, cv, jobKeywords),
    writing: ats.writingIssues(cv),
  };
}

// Writing rules for resume bullets, shared by Generate and its second pass (ats.writingIssues checks the same).
const BULLET_RULES = `Each bullet: action verb, what was built, how or with what, result. One idea, at most ~35 words.
  No "I" / "my". No em dashes or double hyphens: use a comma or a new sentence. No stock phrases ("spearheaded",
  "leveraged", "utilized", "orchestrated", "cutting-edge", "results-driven"). Never open a bullet with
  "Responsible for", "Helped with", "Worked on", "Involved in".`;

function fixPrompt(cv, resume, profile, add, bad, title, weak = []) {
  return `You are correcting a resume that was tailored to a job posting. Change as little as possible.
${title ? `
TITLE LINE: the line under the name doesn't name the role. Start it with "${title}" (add "Senior" or another level
only if the base resume shows it), then " | " and the candidate's specialization from the current line.
` : ''}
${add.length ? `KEYWORDS TO WORK IN (the posting asks for them and the base resume or profile shows the candidate has them):
${add.map(k => '- ' + k).join('\n')}
Put each one where the base resume supports it: the Skills section, and at most 2 existing bullets or the summary
where it honestly fits the work described. In a changed line keep every number, name and tool it already has and add
nothing except the keyword. Don't add new bullets.
` : ''}${bad.length ? `
UNSUPPORTED CLAIMS (not found in the base resume or profile):
${bad.map(b => `- ${b.kind === 'number' ? 'number' : 'skill'} "${b.value}" in: ${b.line}`).join('\n')}
Fix each one: use the number or wording the base resume actually has, or drop the claim. If the base resume or
profile does support it in other words, keep it.
` : ''}${weak.length ? `
WEAK BULLETS TO REWRITE (problem | text):
${weak.map(w => `- ${w.kind} | ${w.line}`).join('\n')}
Rewrite only these lines. Every number, name, product, tool and skill of the line must stay; add no new ones.
Never invent a metric: if the line has no number, state the outcome or scope it already implies.
` : ''}
Rules: never invent employers, titles, dates, projects, technologies, numbers or achievements. Keep the exact
Markdown layout, section order, header, links and language of the current CV. In every line you change:
${BULLET_RULES}

CANDIDATE PROFILE (also a source of truth):
${profile || '(none)'}

BASE RESUME (source of truth):
${resume}

CURRENT TAILORED CV (return it in full, with only the fixes above):
${cv}`;
}

// The second pass may only add keywords and reword lines: a number of the first version that it wasn't asked
// to fix must survive, and it must not leave more unsupported claims than it got.
function fixLostFacts(before, after, bad, source, jobKeywords) {
  const drop = new Set(bad.filter(b => b.kind === 'number').map(b => b.value));
  const kept = ats.numbers(after);
  const lost = [...ats.numbers(before)].filter(n => !drop.has(n) && !kept.has(n));
  return lost.length > 0 || ats.factCheck(source, after, jobKeywords).length > bad.length;
}

// "Always fit on 2 pages" (Settings): makes the real PDF, and while it has more pages asks Claude to cut.
async function fitTwoPages(cv, { resume, profile, jobKeywords, config, onLog }) {
  const log = m => onLog && onLog(m);
  for (let attempt = 1; attempt <= 3; attempt++) {
    let pages;
    try { pages = await cvPages(cv); } catch (err) { log('Could not count CV pages: ' + err.message); return cv; }
    if (pages <= 2) { log(`CV fits on ${pages} page(s)`); return cv; }
    if (attempt === 3) { log(`CV is still ${pages} pages after shortening; trim it by hand`); return cv; }
    const words = cv.split(/\s+/).filter(Boolean).length;
    const target = Math.round(words * 2 / pages * 0.92);
    log(`CV is ${pages} pages (${words} words): shortening to ~${target} words`);
    try {
      const { data } = await runClaude({
        prompt: `Shorten this tailored resume so its PDF fits on 2 A4 pages. It is ${pages} pages and ${words} words now;
bring it to about ${target} words.

How to cut, in this order: drop bullets that matter least for the job (keep the strongest 2-4 per recent job,
1-2 per old or unrelated job), merge overlapping bullets, shorten long bullets, trim the summary to 2-3 lines,
shorten skill lines, drop sections that don't help this job (e.g. a long list of shipped titles can become one line).
Keep: every employer, title and date, the header with contacts and links, these posting keywords where present
(${poolList(jobKeywords)}), and all numbers in the bullets you keep.
Change nothing else: same Markdown layout, section order, language and wording of what stays. Add nothing new.

BASE RESUME (source of truth, for reference only):
${resume}

CANDIDATE PROFILE (for reference only):
${profile || '(none)'}

RESUME TO SHORTEN (return it in full):
${cv}`,
        schema: FIX_SCHEMA,
        action: 'tailor',
        config,
        cwd: store.WORK,
        timeoutMs: 5 * 60 * 1000,
        onLog,
      });
      if (!data.cv_markdown) return cv;
      cv = ats.keepJobOrder(ats.cleanPhrases(data.cv_markdown), resume);
    } catch (err) {
      log('Shortening failed, keeping the longer CV: ' + err.message);
      return cv;
    }
  }
  return cv;
}

const atsTermList = kw => [kw.role && 'Role: ' + kw.role,
  (kw.required_skills || []).length && 'Must-have: ' + kw.required_skills.join(', '),
  (kw.preferred_skills || []).length && 'Nice-to-have: ' + kw.preferred_skills.join(', '),
  (kw.keywords || []).length && 'Other terms: ' + kw.keywords.join(', ')].filter(Boolean).join('\n');

const poolList = kw => [...(kw.required_skills || []), ...(kw.preferred_skills || []), ...(kw.keywords || [])].join(', ') || 'none';

async function tailor(jobId, { onLog, extra = '', lang = '' } = {}) {
  const config = store.config();
  const cvLang = lang || config.languages.cv;
  const letterLang = lang || config.languages.letter;
  const { resume, profile } = context();
  const cand = store.candidate();
  const job = store.jobs().find(j => j.id === jobId);
  if (!job) throw new Error('Job not found');
  let postingText = job.postingText || '';
  if (!postingText && job.url) {
    postingText = await fetchPosting(job.url);
    if (postingText) store.updateJob(jobId, { postingText });
  }
  const prevKw = (store.docs(jobId).meta || {}).jobKeywords;
  const savedKeywords = prevKw && (prevKw.role || (prevKw.required_skills || []).length) ? prevKw : null;

  const prompt = `You are an expert technical recruiter and resume writer.

CANDIDATE PROFILE AND PREFERENCES:
${profile || '(none given)'}

BASE RESUME (together with any facts the candidate states in the profile above, the only source of truth about the candidate):
${resume}

TARGET JOB:
Title: ${job.title}
Company: ${job.company}
URL: ${job.url}
Known summary: ${job.summary}
${postingText ? 'FULL POSTING TEXT:\n' + postingText : job.url ? 'Open the URL with WebFetch to read the full description (requirements, stack, responsibilities). If it fails, use the summary and a web search for the posting.' + perplexityHint(config, 'tailor') : ''}
${extra ? '\nEXTRA INSTRUCTIONS FROM THE CANDIDATE:\n' + extra + '\n' : ''}${savedKeywords ? `
ATS TERMS OF THIS POSTING (extracted before; when a term truthfully applies, spell it exactly like this):
${atsTermList(savedKeywords)}
` : ''}
TASK 1 — Tailored resume (cv_markdown):
- Facts: only what the base resume and profile say. Never invent employers, titles, dates, projects, technologies,
  numbers or achievements; you may rephrase, merge, reorder, shorten and drop. In what you keep, keep the numbers,
  the candidate's personal scope (solo developer, lead, team size) and qualifiers that limit scope (simplified,
  prototype, partial); never upgrade them to the posting's wording. The summary claims only what a bullet proves.
- Content: a 2-3 line summary aimed at this role; bullets reordered so the most relevant come first. Jobs and
  education keep the base resume's order (newest first): reorder bullets inside a job, never the jobs; bring out a
  more relevant older job in the summary. Recent or relevant jobs 3-5 bullets, old or unrelated ones 2-3; drop
  bullets that don't help this posting (e.g. admin work for an engineering role). Skills: only what helps this
  posting, ordered by relevance, at most ~7 lines.
- ${BULLET_RULES} Name the exact system or feature only when the base resume does.
- Title line under the name: start it with the role this posting hires for, in its general form: the role name
  without seniority, project, game, genre, location or contract tags (a posting called "Senior Gameplay Programmer
  - Space Shooter (Remote)" gives "Gameplay Programmer"; add "Senior" only if the base resume shows that level).
  Then " | " and the candidate's specialization. Use the posting's role name, not a synonym or the candidate's old
  title, as long as the candidate's work fits that role.
- Use the posting's technology names (frameworks, tools, methods) where they truthfully apply, so ATS finds them,
  but not its wording: no phrases lifted from it, no strings of its requirements repeated back; the summary must
  not read like its checklist. A recruiter should not recognise their own text. The same for the profile: its
  notes become natural skill entries, never requirement-style wording ("X or comparable Y", "Strong understanding of Z").
- If the posting asks for work examples or a portfolio, make the most relevant project, portfolio or product link
  easy to see (mention it in the summary or move its section higher).
- KEEP THE EXACT LAYOUT AND MARKDOWN CONVENTIONS OF THE BASE RESUME — the app renders them into the candidate's
  document design, so any other syntax breaks the look:
    "# Name", then centered header lines ("*Target title | ...*", contact lines) before the first section;
    "## Section" for sections (same section names and order as the base resume unless dropping one helps);
    "### Job title | Dates" for each job (one " | " before the dates);
    "*Company. Remote*" (italic line) right after it; "> tagline" for the company description or a sub-project heading;
    "- " bullets; **bold** for skill category labels; [text](url) links.
  Contact details, employers, job titles, dates and links stay exactly as in the base resume (only the title line
  changes). No tables, no other heading levels, no HTML. ${config.cvTwoPages
    ? 'It MUST fit on 2 A4 pages: about 550 words in total at most (a 2-page PDF of this layout holds ~600).'
    : 'At most 2 pages; shorter is better.'}
- ${langRule(cvLang, 'the resume', "Write the resume in the posting's language (English if the posting is in English or the language is unclear).")}
  When the resume is in a language other than the base resume's, translate everything (section names too) but keep
  the markdown layout, names, employers, links and numbers as they are.
- Don't echo the posting's logistics anywhere in the resume: working hours, time zones, availability, "fluent
  English", visa / contract status, location. Location stays as in the base header, spoken languages only where the
  base resume lists them.

TASK 2 — Cover letter (cover_letter):
- 150-250 words, plain text, 3-4 short paragraphs of prose, no bullet lists.
  ${langRule(letterLang, 'the cover letter', "Write it in the posting's language (English if the language is unclear).")}
  The same facts rule as the resume. No clichés or generic praise ("innovative company", "perfect candidate").
  Naming one detail of the posting in your own words is fine; quoting or restating the posting is not.
- Tone: a peer stating facts, not someone trying to please. No flattery or compliments to the company, its product
  or team ("I admire", "impressive", "inspiring", "I love what you're building", "dream job"), no eagerness or
  gratitude ("thrilled", "excited", "passionate", "honored", "thank you for considering"), no superlatives about the
  candidate. Say what the candidate did and how it fits the work; let that carry the interest.
- Plan silently first: from the posting's location, pick the sign-off conventions (US / UK:
  "Sincerely" or "Kind regards", AU / NZ: "Kind regards"; the local equivalent in other languages; neutral if the
  region is unclear). From the employer type, pick the tone: plain and direct for indie studios, startups and tech,
  measured for large corporations. Pick the 2-3 strongest matches: relevance beats impressiveness.
- Greeting: "Hello ${job.company}," (the company name as it is commonly written, without "Inc", "Ltd", "GmbH" etc.)
  or its equivalent in the letter's language. No person's names, not "Dear Hiring Manager".
- Opening (1-2 sentences): the candidate's strongest concrete match to ONE specific detail of the posting (the
  product, project, tech problem or team). Never open with "I am writing to express my interest", "I'm applying
  for..." or any excitement.
- Body (1-2 paragraphs): the 2-3 most relevant achievements, what was built and its result, with the resume's
  numbers, described in the posting's terms where the resume truly supports them. Don't retell the whole resume.
- Why this company: at most one plain sentence linking a specific product, project or challenge named in the
  posting to the candidate's own experience or interest; a fact, not praise. Skip it if there is nothing concrete.
- Closing: one short, matter-of-fact sentence on what the candidate could take on in the team's stated work and
  that they're open to a call; no "I hope", no "would love to". Then the sign-off and the candidate's name.
- Include 1-2 links from the resume (the most relevant project or product).
- NEVER mention gaps, missing requirements, weaknesses or what the candidate hasn't done ("to be direct about
  gaps", "my experience is limited to..."). The "missing" list is for the report only.
- NEVER mention salary, rate, contract type, start date, notice period, visas, references, or promise to send
  anything. Only if the posting requires specific working hours / time-zone overlap, add one short sentence
  (e.g. "I'm based in ${cand.livesIn || '<country>'} (${cand.timezone || '<time zone>'}) and can work with your team's hours.";
  take the country and time zone from the profile if not given here), no exact hour ranges unless the profile states them.

Before answering, check: every CV summary claim is backed by a bullet; no sentence of the posting or the profile is
reused in the CV or the letter; the letter greets the company by name, opens with a detail of this posting and
has no gaps, logistics, flattery or eagerness. Fix anything that fails.

Also list ATS keywords now covered (keywords), important requirements not clearly met (missing), a short summary
of the changes (changes), and questions for the candidate (questions): facts not in the resume or profile that
would strengthen this CV if true (e.g. "Did project X also include Y the posting asks for?").
Finally list the posting's ATS terms (job_keywords), taken from the posting, not from the resume: the job title
as written but without location / region / contract tags ("[LATAM]", "(Remote)", "- Contract"), and the terms a
recruiter would type into an ATS search: technologies, engines, languages, tools, platforms, genres, named
systems and methods (e.g. "C++", "React", "AWS", "multiplayer", "code review"). Each 1-3 words, spelled as in the
posting. No soft skills, no qualities or phrases ("teamwork", "attention to detail", "fast-paced"), no years of
experience.`;

  const { data } = await runClaude({
    prompt,
    schema: TAILOR_SCHEMA,
    action: 'tailor',
    allowedTools: job.url && !postingText ? webTools(config) : [],
    config,
    cwd: store.WORK,
    timeoutMs: 10 * 60 * 1000,
    onLog,
  });
  if (!data.cv_markdown) throw new Error('Claude returned no resume');

  // Code checks (no Claude): buzzwords out, then look for posting keywords the CV skipped although the
  // base resume / profile has them, and for numbers or skills the base doesn't back up.
  // The posting's term list is kept from the first Generate, so scores of later re-generations compare.
  const jobKeywords = savedKeywords || data.job_keywords || {};
  const source = resume + '\n\n' + profile;
  let cv = ats.keepJobOrder(ats.cleanPhrases(data.cv_markdown), resume);
  let changes = data.changes || '';
  let passes = 1;
  const pre = ats.score(cv, jobKeywords, source);
  const add = pre.injectable;
  const bad = ats.factCheck(source, cv, jobKeywords);
  const title = pre.sub.title != null && pre.sub.title < 100 ? ats.coreTitle(jobKeywords.role) : '';
  const weak = ats.writingIssues(cv);
  if (add.length || bad.length || title || weak.length) {
    onLog && onLog(`Second pass: adding ${add.length} keyword(s), fixing ${bad.length} unsupported claim(s)${title ? ', putting the role in the title line' : ''}, rewriting ${weak.length} weak bullet(s)`);
    try {
      const fixed = await runClaude({
        prompt: fixPrompt(cv, resume, profile, add, bad, title, weak),
        schema: FIX_SCHEMA,
        action: 'tailor',
        config,
        cwd: store.WORK,
        timeoutMs: 5 * 60 * 1000,
        onLog,
      });
      const next = fixed.data.cv_markdown && ats.keepJobOrder(ats.cleanPhrases(fixed.data.cv_markdown), resume);
      if (next && fixLostFacts(cv, next, bad, source, jobKeywords)) {
        onLog && onLog('Second pass lost a number or added an unsupported claim, keeping the first version');
      } else if (next) {
        cv = next;
        passes = 2;
        if (fixed.data.changes) changes = (changes + ' ' + fixed.data.changes).trim();
      }
    } catch (err) {
      onLog && onLog('Second pass failed, keeping the first version: ' + err.message);
    }
  }
  if (config.cvTwoPages) cv = await fitTwoPages(cv, { resume, profile, jobKeywords, config, onLog });

  store.saveDocs(jobId, {
    base: resume,
    cv,
    coverLetter: ats.cleanText(data.cover_letter || ''),
    meta: {
      keywords: data.keywords || [],
      missing: data.missing || [],
      changes,
      questions: data.questions || [],
      jobKeywords,
      ...atsReport(cv, resume, profile, jobKeywords),
      passes,
      generatedAt: new Date().toISOString(),
    },
  });
  if (job.status === 'new') store.updateJob(jobId, { status: 'interested' });
  return { ok: true };
}

// Re-read the posting and re-score it against the current resume/profile. Keeps status, notes and CVs.
async function refreshJob(jobId, { onLog } = {}) {
  const job = store.jobs().find(j => j.id === jobId);
  if (!job) throw new Error('Job not found');
  const input = job.url || job.postingText;
  if (!input) throw new Error('This job has no link or saved posting text to refresh from');
  return analyze(input, { onLog, refreshId: jobId, savedText: job.postingText || '' });
}

// Who to write to about this job: the recruiter / hiring manager, the company's referral program,
// and 3 employees who could refer the candidate. Public professional info only.
async function findPeople(jobId, { onLog } = {}) {
  const config = store.config();
  const { resume, profile } = context();
  const cand = store.candidate();
  const job = store.jobs().find(j => j.id === jobId);
  if (!job) throw new Error('Job not found');
  const today = new Date().toISOString().slice(0, 10);
  const posting = (job.postingText || '').slice(0, 6000);

  const prompt = `Today is ${today}. You help one candidate get noticed for a job: find the people to contact.

CANDIDATE PROFILE AND PREFERENCES:
${profile || '(none given)'}

CANDIDATE RESUME:
${resume}

TARGET JOB:
Title: ${job.title}
Company: ${job.company}
URL: ${job.url || '(none)'}
Location: ${[job.remote, job.location].filter(Boolean).join('; ') || 'unknown'}
Summary: ${job.summary}
${posting ? 'POSTING TEXT:\n' + posting : ''}

LOCATION — HIGH PRIORITY for both hiring and referrers:
- The job's location is: ${[job.location, job.remote].filter(Boolean).join('; ') || 'unknown'}. Work out the city / office / country
  the posting is tied to (for a "remote" posting listed in one city, that city's office is the hiring hub).
- Prefer people who work in that city / office, then in that country. For each person, find where they work
  (LinkedIn snippet location, profile, team page) and fill location and location_match. Add the location to the
  searches, e.g. "site:linkedin.com/in ${job.company} <city>" / "<country>".
- Big companies have many offices: an engineer in another country's office usually cannot help with this opening.
  Include people from elsewhere only if you found nobody in the job's city / country, and say so in why.
- Rank: job_location first, then same_country, then unknown, then other.

TASK 1 — hiring: who is hiring for THIS role (max 3, best first).
- First look in the posting itself: a named recruiter, hiring manager or "contact" person.
- Then LinkedIn, mainly through WebSearch: "site:linkedin.com/in ${job.company} recruiter", "... talent acquisition",
  "... technical recruiter", "site:linkedin.com/posts ${job.company} hiring <role keywords>" (a person who posted this
  opening is the best match), and the hiring manager (e.g. lead / head of the team the role is in,
  department director). LinkedIn pages often refuse WebFetch — take name and title from the search result snippets.
- Also usable: the company's team / about page, company blog, X/Twitter, conference talks, Glassdoor.
${usePerplexity(config) ? '- perplexity_search / perplexity_ask help find recruiters and leads of this company; use cited URLs.\n' : ''}- Prefer recruiters who cover the candidate's field and region; for a small company the founder,
  CTO or tech lead often hires directly — that counts.

TASK 2 — referral_program: does ${job.company} have an employee referral program? Search for it (careers page,
"${job.company} referral program", "${job.company} employee referral bonus", Glassdoor/Blind/Reddit mentions).
status "yes" only with a source that says so; big companies almost always have one internally, but without a
source say "unknown" and mention that in details. Give what is known about how it works.

TASK 3 — referrers: exactly 3 current employees the candidate could ask for a referral, best first. Pick people
who would understand the candidate's work and would plausibly refer them: people doing the same kind of work as the candidate (by the
resume and target roles), ideally with something in common with the candidate (same former employer, same
country or language as the candidate${cand.livesIn ? ' (' + cand.livesIn + ')' : ''}, same technologies, same product). Not recruiters (those go to hiring), not
C-level of a big company. Say in why what they have in common with the candidate. If you really cannot find 3, return fewer.

RULES:
- Only real people you actually found in search results or pages, currently at ${job.company} (or the company
  that owns this posting). Never invent names, titles or URLs. If a profile says they left, skip them.
- linkedin: the exact linkedin.com/in/... URL from the results. Empty if you did not see one.
- Public professional info only: name, title, profile links. No personal emails, phone numbers or home addresses.
- confidence: high = seen on their own profile / company page with current title; medium = search snippet;
  low = older or indirect mention.
- message: a short LinkedIn connection note in the candidate's voice (max 300 characters).
  ${langRule(config.languages.messages, 'every message', "Write it in the posting's language (English if unclear).")} Hiring people: the role, one strongest concrete fact from the resume, ask to connect /
  where to send the CV. Referrers: mention what you have in common, the role, ask if they'd be open to a short chat
  or a referral. No flattery, no salary, no invented facts. Sign with the candidate's first name.`;

  const { data } = await runClaude({
    prompt,
    schema: PEOPLE_SCHEMA,
    action: 'people',
    allowedTools: webTools(config),
    config,
    cwd: store.WORK,
    timeoutMs: 10 * 60 * 1000,
    onLog,
  });
  const people = store.setPeople(jobId, data);
  if (!people) throw new Error('Job not found');
  return { hiring: people.hiring.length, referrers: people.referrers.length, referral: people.referralProgram.status };
}

module.exports = { search, analyze, tailor, refreshJob, findPeople, atsReport };
