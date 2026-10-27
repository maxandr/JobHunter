// The three things the app asks Claude to do: search, analyze one posting, tailor CV + cover letter.
'use strict';

const store = require('./store');
const { runClaude } = require('./claude');
const { fetchPosting } = require('./fetch-posting');
const { collectLinks } = require('./source-links');

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
  },
  required: ['cv_markdown', 'cover_letter', 'changes'],
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

function webTools(config) {
  return ['WebSearch', 'WebFetch', ...(config.perplexity ? PERPLEXITY_TOOLS : []), ...(config.extraAllowedTools || [])];
}

// Extra prompt lines telling Claude how to use Perplexity; empty when it is turned off.
function perplexityHint(config, action) {
  if (!config.perplexity) return '';
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
`;
}

// Prompt block for the sites and Telegram channels added on the "Sources" tab; empty when there are none.
// links: { [source id]: { links, filtered } } collected beforehand by lib/source-links.js.
function sourcesBlock(list, only, links = {}) {
  if (!list.length) return '';
  const lines = list.map(s => {
    const head = `- ${s.kind === 'telegram' ? 'Telegram ' + s.name + ' — read ' + s.url : s.url}${s.note ? ' (' + s.note + ')' : ''}`;
    const l = links[s.id];
    if (!l || (!l.links.length && !l.cards.length)) return head;
    const cards = l.cards.map(c => `  <posting url="${c.url}">\n${c.text}\n  </posting>`).join('\n');
    return `${head}${l.cards.length ? `
  Postings already downloaded from this site (start of each page, from the site's structured data — "Posted" there is
  the real publication date, trust it; "Location"/"Location type: TELECOMMUTE" are from the site too):
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
// sourcesOnly: look only at the sites / Telegram channels from the "Sources" tab.
async function search({ onLog, maxAgeDays, sourcesOnly = false } = {}) {
  const config = store.config();
  const { resume, profile } = context();
  const mySources = store.sources().filter(s => s.enabled);
  if (sourcesOnly && !mySources.length) throw new Error('No sources turned on. Add sites or Telegram channels on the "Sources" tab.');
  const known = store.jobs().map(j => `${j.company} — ${j.title} — ${j.url}`).slice(-300);
  const today = new Date().toISOString().slice(0, 10);
  const maxAge = maxAgeDays != null ? maxAgeDays : 30;
  const filter = store.sourceFilter();
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
Breezy, BambooHR) and best-effort LinkedIn (e.g. search "site:linkedin.com/jobs ...").
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
${extra ? '\nEXTRA INSTRUCTIONS FROM THE CANDIDATE:\n' + extra + '\n' : ''}
TASK 1 — Tailored resume (cv_markdown):
- Rewrite the base resume for this job: target job title at the top, a 2-3 line summary aimed at this role,
  reorder and rephrase bullets so the most relevant experience comes first. Use the posting's technology names
  (frameworks, tools, methods) where they truthfully apply, so ATS finds them.
- DO NOT COPY THE POSTING'S WORDING. No phrases or sentences lifted from it, no lists of its requirements
  (a string of the posting's feature or skill names) repeated back. The summary must not
  read like the posting's checklist: say what the candidate did, in the candidate's own words, with concrete
  results. A recruiter should not recognise their own text in the CV.
- The same goes for the profile: its "also have" lines are notes, not resume text. Turn them into natural
  skill entries (e.g. "X-based and custom Y"), never paste requirement-style wording
  like "X or comparable Y frameworks" or "Strong understanding of Z".
- Don't stuff every term from the profile into Skills; add only what helps for this posting.
  Order skill lines by relevance to the posting, at most ~7 lines.
- Each bullet: action verb + what the candidate built + how / with what + result. Keep every number from the
  base resume. Keep the candidate's personal scope where the base resume gives it (sole programmer, lead,
  team of 3). Be specific (name the exact system or feature) only when the base resume supports it.
- NO OVERCLAIMING: the summary may claim only what a bullet below proves. Keep qualifiers that limit scope
  ("custom simplified", "prototype", "partial") — never upgrade them to the posting's wording.
- Cut what doesn't serve this role: recent / relevant jobs 3-5 bullets, old or unrelated ones 2-3; drop
  bullets that don't help this posting (e.g. compliance or admin work for a pure engineering role).
- If the posting asks for work examples or a portfolio, keep the project, portfolio and product links and make
  the most relevant one easy to see (mention it in the summary or move its section higher).
- NEVER invent employers, titles, dates, projects, technologies, numbers or achievements that are not in the base resume.
  You may rephrase, merge, reorder, shorten and drop items.
- KEEP THE EXACT LAYOUT AND MARKDOWN CONVENTIONS OF THE BASE RESUME — the app renders them into the candidate's
  document design, so any other syntax breaks the look:
    "# Name", then centered header lines ("*Target title | ...*", contact lines) before the first section;
    "## Section" for sections (same section names and order as the base resume unless dropping one helps);
    "### Job title | Dates" for each job (one " | " before the dates);
    "*Company. Remote*" (italic line) right after it; "> tagline" for the company description or a sub-project heading;
    "- " bullets; **bold** for skill category labels; [text](url) links kept as they are.
  No tables, no other heading levels, no HTML. At most 2 pages; shorter is better.
- Keep the same contact details, employers, job titles, dates and links exactly as in the base resume.
  You may change the target title line under the name to match the posting.
- ${langRule(cvLang, 'the resume', "Write the resume in the posting's language (English if the posting is in English or the language is unclear).")}
  When the resume is in a language other than the base resume's, translate everything (section names too) but keep
  the markdown layout, names, employers, links and numbers as they are.
- Do NOT answer the posting's logistics in the resume: no working hours, time zones, availability windows,
  "fluent English", visa/contract status or location statements echoed from the posting — in the summary,
  header or anywhere else. Location stays only as in the base header; languages stay only in the Languages section.
  Only working hours / time-zone overlap (if the posting asks for it) goes into the cover letter, one short sentence.

TASK 2 — Cover letter (cover_letter):
- 150-250 words, plain text, 3-4 short paragraphs.
  ${langRule(letterLang, 'the cover letter', "Write it in the posting's language (English if the language is unclear).")}
  No clichés, no flattery, no invented facts, no underselling or overclaiming.
  Don't restate the posting back to them; describe the candidate's work in your own words.
- Structure:
    Opening (1-2 sentences): the role and the candidate's single strongest, concrete match for it — not a
    generic "I'm applying for..." line.
    Body (1-2 paragraphs of prose, NO bullet lists): the 2-3 most relevant achievements from the resume, told
    with what was built and its result, keeping the resume's numbers. Don't retell the whole resume.
    Why this company / product: one sentence, only if real facts from the resume or profile support it; else skip.
    Closing: one sentence that the candidate would be glad to discuss the role, then the candidate's name.
- Include 1-2 links from the resume (the most relevant project or product).
- NEVER mention gaps, missing requirements, weaknesses or what the candidate hasn't done ("to be direct about
  gaps", "I haven't shipped...", "my experience is limited to..."). The "missing" list is for the report only.
- NEVER mention salary, rate, compensation expectations, contract type, start date, notice period, visas,
  references, or promise to send / email anything.
- Location: only if the posting requires specific working hours / time-zone overlap, add one short factual
  sentence (e.g. "I'm based in ${cand.livesIn || '<country>'} (${cand.timezone || '<time zone>'}) and can work with your team's hours."
  — take the country and time zone from the profile if not given here) — no exact hour ranges
  unless the candidate's profile states them. Otherwise don't mention location or contractor status.

Before answering, check the CV: every summary claim is backed by a bullet; no sentence from the posting or the
profile is reproduced; nothing reads like a list of the posting's requirements. Check the cover letter: no
gaps or weaknesses, no salary or logistics, body written as prose. Fix anything that fails.

Also list ATS keywords now covered (keywords), important requirements not clearly met (missing), a short summary
of the changes (changes), and questions for the candidate (questions): facts not in the resume or profile that
would strengthen this CV if true (e.g. "Did project X also include Y the posting asks for?").`;

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
  store.saveDocs(jobId, {
    base: resume,
    cv: data.cv_markdown,
    coverLetter: data.cover_letter || '',
    meta: {
      keywords: data.keywords || [],
      missing: data.missing || [],
      changes: data.changes || '',
      questions: data.questions || [],
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
${config.perplexity ? '- perplexity_search / perplexity_ask help find recruiters and leads of this company; use cited URLs.\n' : ''}- Prefer recruiters who cover the candidate's field and region; for a small company the founder,
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

module.exports = { search, analyze, tailor, refreshJob, findPeople };
