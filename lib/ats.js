// ATS-style checks on a resume, all plain code (no Claude): score vs a posting's keywords, buzzword cleanup,
// and a fact check for numbers / skills the base resume doesn't have. Ported from Resume Matcher
// (github.com/srbhr/Resume-Matcher, Apache-2.0: services/ats.py, services/refiner.py, prompts/refinement.py).
'use strict';

// Weights must sum to 1. A part that can't be scored (no title in the posting, < 2 dates) is left out
// and its weight is spread over the rest.
const WEIGHTS = { keyword: 0.40, skills: 0.20, title: 0.15, sections: 0.15, dates: 0.10 };

const SECTIONS = {
  summary: ['summary', 'objective', 'profile', 'about', 'о себе', 'профиль', 'резюме'],
  experience: ['experience', 'work history', 'employment', 'опыт'],
  education: ['education', 'academic', 'образование'],
  skills: ['skills', 'technologies', 'competencies', 'technical', 'навыки', 'технологии'],
};

// Words that read as AI-written, with a plain replacement. Words that are normal in engineering CVs
// (scalable, robust, stakeholder, deliverables) are left out on purpose.
const REPLACEMENTS = {
  spearheaded: 'led', spearheading: 'leading',
  orchestrated: 'coordinated', championed: 'advocated for', synergized: 'collaborated',
  leveraged: 'used', leveraging: 'using', revolutionized: 'transformed', pioneered: 'introduced',
  catalyzed: 'initiated', operationalized: 'implemented', envisioned: 'planned', effectuated: 'completed',
  endeavored: 'worked', utilized: 'used', utilizing: 'using', utilize: 'use', utilizes: 'uses',
  synergy: 'collaboration', synergies: 'collaborations', 'paradigm shift': 'change',
  'best-in-class': 'top-performing', 'world-class': 'high-quality', 'cutting-edge': 'modern',
  'bleeding-edge': 'modern', 'game-changer': 'innovation', impactful: 'effective', actionable: 'practical',
  'in order to': 'to', 'for the purpose of': 'to', 'with a view to': 'to',
  'on a daily basis': 'daily', 'on a regular basis': 'regularly', 'in a timely manner': 'promptly',
  'at this point in time': 'now', 'due to the fact that': 'because', 'in the event that': 'if',
  'in light of the fact that': 'since',
};
const WEAK_OPENERS = ['responsible for', 'helped with', 'helped to', 'helped', 'assisted with', 'assisted in',
  'assisted', 'involved in', 'participated in', 'worked on', 'tasked with', 'duties included', 'in charge of'];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = s => String(s || '')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`>]/g, '').replace(/\s+/g, ' ');

// Whole-word match that works for C++, C#, .NET, Node.js; "real-time" also matches "real time".
const kwCache = new Map();
function keywordRe(kw) {
  let re = kwCache.get(kw);
  if (!re) {
    const body = String(kw).trim().toLowerCase().split(/[\s-]+/).map(escRe).join('[\\s-]+');
    re = new RegExp(`(?<![\\p{L}\\p{N}+#])${body}(?![\\p{L}\\p{N}+#])`, 'u');
    kwCache.set(kw, re);
  }
  return re;
}
function keywordInText(kw, text) {
  return !!String(kw || '').trim() && keywordRe(kw).test(plain(text).toLowerCase());
}

// Splits our resume Markdown (see public/cv-render.js) into header, sections and dates.
function parseCv(md) {
  const lines = String(md || '').split(/\r?\n/);
  const header = [];
  const sections = [];
  const dates = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^##\s/.test(line) && !/^###/.test(line)) {
      cur = { name: plain(line.replace(/^##\s+/, '')).trim(), text: '' };
      sections.push(cur);
      continue;
    }
    if (!cur) { if (!/^#\s/.test(line)) header.push(line); continue; }
    const job = line.match(/^###\s+.*\|\s*([^|]+)$/);
    if (job) dates.push(job[1].trim());
    cur.text += line + '\n';
  }
  const headerText = header.join('\n');
  return {
    header: headerText,
    sections,
    dates,
    email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(headerText),
    phone: /\+?\d[\d\s().-]{6,}\d/.test(headerText),
  };
}

function findSection(cv, kind) {
  return cv.sections.find(s => SECTIONS[kind].some(n => s.name.toLowerCase().includes(n)));
}

function poolOf(jobKw) {
  const seen = new Set();
  const out = [];
  for (const k of [...(jobKw.required_skills || []), ...(jobKw.preferred_skills || []), ...(jobKw.keywords || [])]) {
    const key = String(k || '').trim().toLowerCase();
    if (key && !seen.has(key)) { seen.add(key); out.push(String(k).trim()); }
  }
  return out;
}

const STOP = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'in', 'to', 'at', '&', '-', '/', '|']);
const titleTokens = s => new Set(plain(s).toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(t => t && !STOP.has(t)));

function titleScore(cv, role) {
  // "[EMEA] Senior Engineer (Remote)" → "Senior Engineer": tags like these are never in a CV header.
  role = String(role || '').replace(/\[[^\]]*\]|\((?:remote|hybrid|contract|full[- ]time|part[- ]time)[^)]*\)/gi, '').replace(/\s+/g, ' ').trim();
  if (!role) return null;
  // "Gameplay Programmer - Space Shooter": the part before the dash is the title, the rest is the project.
  const titles = [role, role.split(/\s+[-–—|:]\s+|,\s/)[0].trim()];
  if (titles.some(t => keywordInText(t, cv.header))) return 100;
  const summary = findSection(cv, 'summary');
  if (summary && titles.some(t => keywordInText(t, summary.text))) return 75;
  const want = titleTokens(role);
  if (!want.size) return 0;
  const have = titleTokens(cv.header);
  return Math.round([...want].filter(t => have.has(t)).length / want.size * 50);
}

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RE = new RegExp(
  '(?<iso>\\b(?:19|20)\\d{2}[-/]\\d{1,2}\\b)|(?<numeric>\\b\\d{1,2}[/.-](?:19|20)\\d{2}\\b)'
  + `|(?<name_year>\\b${MONTH}\\.?,?\\s+(?:19|20)\\d{2}\\b)|(?<name_short>\\b${MONTH}\\.?\\s+'\\d{2}\\b)`
  + '|(?<year>\\b(?:19|20)\\d{2}\\b)', 'gi');

function datesScore(cv) {
  const counts = {};
  for (const d of cv.dates) {
    for (const m of d.matchAll(DATE_RE)) {
      const style = Object.keys(m.groups).find(k => m.groups[k]);
      counts[style] = (counts[style] || 0) + 1;
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return total < 2 ? null : Math.round(Math.max(...Object.values(counts)) / total * 100);
}

function sectionsScore(cv) {
  const found = Object.keys(SECTIONS).filter(k => findSection(cv, k)).length;
  return Math.round((found + (cv.email || cv.phone ? 1 : 0)) / (Object.keys(SECTIONS).length + 1) * 100);
}

// md: the resume; jobKw: { role, required_skills, preferred_skills, keywords } from the posting;
// source: base resume + profile, to tell which missing keywords the candidate could truthfully add.
function score(md, jobKw, source = '') {
  jobKw = jobKw || {};
  const cv = parseCv(md);
  const pool = poolOf(jobKw);
  const skills = poolOf({ required_skills: jobKw.required_skills, preferred_skills: jobKw.preferred_skills });
  const missing = pool.filter(k => !keywordInText(k, md));
  const ratio = (list, miss) => list.length ? Math.round((list.length - list.filter(k => miss.includes(k)).length) / list.length * 100) : null;
  const sub = {
    keyword: ratio(pool, missing),
    skills: ratio(skills, missing),
    title: titleScore(cv, jobKw.role),
    sections: sectionsScore(cv),
    dates: datesScore(cv),
  };
  const scored = Object.keys(sub).filter(k => sub[k] != null);
  const weight = scored.reduce((a, k) => a + WEIGHTS[k], 0);
  const overall = weight ? Math.round(scored.reduce((a, k) => a + sub[k] * WEIGHTS[k], 0) / weight) : 0;
  const injectable = source ? missing.filter(k => keywordInText(k, source)) : [];
  return {
    overall, sub,
    missing: missing.filter(k => !injectable.includes(k)).slice(0, 15),
    injectable: injectable.slice(0, 15),
    tips: tips(sub, String(jobKw.role || '').trim(), missing, injectable),
  };
}

function tips(sub, role, missing, injectable) {
  const out = [];
  if (sub.title != null && sub.title < 100) {
    out.push(`Put the exact job title "${role}" in the line under your name. Recruiters filter by title literally, so synonyms are missed.`);
  }
  const rest = missing.filter(k => !injectable.includes(k));
  if ((sub.keyword ?? 100) < 60 && rest.length) out.push(`High-priority keywords you don't show: ${rest.slice(0, 5).join(', ')}. Add them to your profile if you have them.`);
  if (injectable.length) out.push(`In your base resume or profile but not in this CV: ${injectable.slice(0, 5).join(', ')}.`);
  if (sub.skills != null && sub.skills < 60) out.push('List more of the posting\'s tools and technologies in Skills (only ones you really used).');
  if (sub.sections < 100) out.push('Make sure the CV has contact details and Summary, Experience, Education and Skills sections.');
  if (sub.dates != null && sub.dates < 100) out.push('Write every date range in one format (e.g. "Jan 2020 – Mar 2023"). Mixed formats can make an ATS miscount your years.');
  if ((sub.keyword ?? 0) >= 80 && (sub.skills ?? 0) >= 80) out.push('Strong keyword match. Numbers and concrete results in the bullets are what helps now.');
  return out;
}

// Lines whose wording may be touched: bullets, taglines and paragraphs after the first section.
// Headings, the header block and italic company lines stay as they are.
function prose(md, fn) {
  let inBody = false;
  return String(md || '').split(/\r?\n/).map(line => {
    const t = line.trim();
    if (/^##\s/.test(t)) inBody = true;
    if (!inBody || !t || /^#/.test(t) || /^\*[^*].*\*$/.test(t)) return line;
    return fn(line);
  }).join('\n');
}

const PHRASE_RE = new RegExp(`(?<![\\p{L}-])(${Object.keys(REPLACEMENTS).sort((a, b) => b.length - a.length).map(escRe).join('|')})(?![\\p{L}-])`, 'giu');
const keepCase = (from, to) => /^[A-Z]/.test(from) ? to[0].toUpperCase() + to.slice(1) : to;

// Replaces buzzwords and em dashes in plain text (e.g. a cover letter); links keep their text and URL.
function cleanText(text) {
  return String(text || '').split(/(\[[^\]]*\]\([^)]*\))/).map((part, i) => i % 2 ? part : part
    .replace(PHRASE_RE, m => keepCase(m, REPLACEMENTS[m.toLowerCase()]))
    .replace(/[ \t]*—[ \t]*/g, ', ')
    .replace(/[ \t]+--[ \t]+|(?<=\w)--(?=\w)/g, ', ')
  ).join('');
}

// Same for a resume, touching only bullets and paragraphs, not headings or the header block.
const cleanPhrases = md => prose(md, cleanText);

const numbersIn = text => new Set((plain(text).replace(/https?:\S+/g, '').match(/\d+(?:[.,]\d+)?/g) || []).map(n => n.replace(',', '.')));

// Things in the CV that the base resume + profile don't back up: new numbers and new posting keywords.
function factCheck(source, md, jobKw) {
  const known = numbersIn(source);
  const lower = String(source || '').toLowerCase();
  NUMBER_WORDS.forEach((w, i) => { if (new RegExp(`\\b${w}\\b`).test(lower)) known.add(String(i)); });
  const out = [];
  const seen = new Set();
  prose(md, line => {
    for (const n of numbersIn(line)) {
      if (!known.has(n) && !seen.has('n' + n)) { seen.add('n' + n); out.push({ kind: 'number', value: n, line: plain(line).trim() }); }
    }
    return line;
  });
  for (const k of poolOf(jobKw || {})) {
    if (keywordInText(k, md) && !keywordInText(k, source)) {
      const line = String(md).split(/\r?\n/).find(l => keywordInText(k, l)) || '';
      out.push({ kind: 'keyword', value: k, line: plain(line).trim() });
    }
  }
  return out;
}

// Style notes for the report: weak openers, first person, very long bullets.
function writingIssues(md) {
  const out = [];
  const weak = new RegExp(`^(?:${WEAK_OPENERS.map(escRe).join('|')})\\b`, 'i');
  prose(md, line => {
    const t = line.trim();
    if (!/^[-*•]\s/.test(t)) return line;
    const text = plain(t.replace(/^[-*•]\s+/, '')).trim();
    if (weak.test(text)) out.push({ kind: 'weak opener', line: text });
    else if (/\b(?:I|my|me)\b/.test(text)) out.push({ kind: 'first person', line: text });
    else if (text.split(/\s+/).length > 40) out.push({ kind: 'long bullet', line: text });
    return line;
  });
  return out;
}

module.exports = { score, cleanText, cleanPhrases, factCheck, writingIssues, keywordInText, parseCv };
