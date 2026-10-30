// Tiny JSON-file storage. Everything lives in the data/ folder next to the app.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Built as job-hunter.exe (Node single executable), the app folder is the one holding the exe.
function isSea() {
  try { return require('node:sea').isSea(); } catch (_) { return false; }
}
const ROOT = isSea() ? path.dirname(process.execPath) : path.resolve(__dirname, '..');

// A file of the web page (public/): built into job-hunter.exe, or read from the folder. null if there is no such file.
function publicFile(name) {
  if (isSea()) {
    try { return Buffer.from(require('node:sea').getAsset('public/' + name)); } catch (_) { return null; }
  }
  const dir = path.join(ROOT, 'public');
  const file = path.join(dir, name);
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  return fs.readFileSync(file);
}

// job-hunter.exe carries the browser extension too: write it out as the extension\ folder next to the exe
// when the folder is missing or older. A newer folder is kept (in the source folder it is the code being edited).
function unpackExtension() {
  if (!isSea()) return;
  const sea = require('node:sea');
  const dir = path.join(ROOT, 'extension');
  const version = text => { try { return JSON.parse(text).version.split('.').map(Number); } catch (_) { return []; } };
  const have = version(readText(path.join(dir, 'manifest.json')));
  const built = version(sea.getAsset('extension/manifest.json', 'utf8'));
  const diff = built.map((n, i) => n - (have[i] || 0)).find(d => d !== 0);
  if (have.length && !(diff > 0)) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const name of JSON.parse(sea.getAsset('extension-files.json', 'utf8'))) {
    fs.writeFileSync(path.join(dir, name), Buffer.from(sea.getAsset('extension/' + name)));
  }
}
const DATA = path.join(ROOT, 'data');
const FILES = {
  jobs: path.join(DATA, 'jobs.json'),
  resume: path.join(DATA, 'resume.md'),
  profile: path.join(DATA, 'profile.md'),
  sources: path.join(DATA, 'sources.json'),
  sourceFilter: path.join(DATA, 'source-filter.json'),
  candidate: path.join(DATA, 'candidate.json'),
  config: path.join(ROOT, 'config.json'),
};
const APPS = path.join(DATA, 'applications');
const WORK = path.join(DATA, '.claude-work');

const DEFAULT_CONFIG = {
  port: 4317,
  claudeBin: '',
  model: '',
  models: { search: 'sonnet', analyze: 'sonnet', tailor: 'sonnet', resume: 'sonnet', apply: 'sonnet', people: 'sonnet' },
  effort: { search: 'medium', analyze: 'medium', tailor: 'medium', resume: 'low', apply: 'low', people: 'medium' },
  resumeDrive: '',
  resumePdfPath: '',
  perplexity: true,
  // Every search also reads LinkedIn by the "Look for" words (lib/linkedin.js).
  linkedin: true,
  mcpConfig: '',
  extraAllowedTools: [],
  maxJobsPerSearch: 15,
  searchTimeoutMinutes: 20,
  maxParallel: 2,
  // Minutes before a claude run is killed; search uses searchTimeoutMinutes.
  timeouts: { analyze: 6, tailor: 10, people: 10, apply: 5, resume: 6 },
  resumeSyncOnStart: true,
  // Shorten every tailored CV until its PDF fits on 2 A4 pages.
  cvTwoPages: false,
  // Searches by itself while the server is running.
  autoSearch: { enabled: false, everyHours: 24, maxAgeDays: 3, sourcesOnly: false },
  applyBrowserBin: '',
  applyBrowserPort: 9227,
  browserBin: '',
  // Language of generated texts: "auto" = the posting's language, otherwise a language name ("English").
  languages: { cv: 'English', letter: 'auto', messages: 'auto', forms: 'English' },
};

// Keyword filter for the "Sources" tab: include = words a posting link must have, exclude = words that hide a posting.
const DEFAULT_SOURCE_FILTER = { include: [], exclude: [] };

function ensure() {
  fs.mkdirSync(APPS, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  if (!fs.existsSync(FILES.jobs)) writeJson(FILES.jobs, []);
}

function writeAtomic(file, content) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
function writeJson(file, obj) { writeAtomic(file, JSON.stringify(obj, null, 2)); }
function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return fallback; }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function config() {
  const c = readJson(FILES.config, {});
  return { ...DEFAULT_CONFIG, ...c,
    models: { ...DEFAULT_CONFIG.models, ...(c.models || {}) },
    effort: { ...DEFAULT_CONFIG.effort, ...(c.effort || {}) },
    timeouts: { ...DEFAULT_CONFIG.timeouts, ...(c.timeouts || {}) },
    autoSearch: { ...DEFAULT_CONFIG.autoSearch, ...(c.autoSearch || {}) },
    languages: { ...DEFAULT_CONFIG.languages, ...(c.languages || {}) } };
}

// A language name for prompts: "auto" or letters only ("English", "Português (Brasil)"), so it can't smuggle instructions in.
const LANG_RE = /^[\p{L} ()-]{2,30}$/u;
function cleanLang(v, name) {
  const s = String(v ?? '').trim() || 'auto';
  if (!LANG_RE.test(s)) throw new Error(`${name}: a language name, e.g. English`);
  return s;
}

// ---------- Settings tab: validated write of config.json ----------
const ACTIONS = ['search', 'analyze', 'tailor', 'people', 'apply', 'resume'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
// These values end up on the claude command line, which may go through cmd.exe — keep shell characters out.
const MODEL_RE = /^[A-Za-z0-9._\-[\]]{0,80}$/;
const TOOL_RE = /^[A-Za-z0-9_.:*()-]{1,120}$/;
const BAD_PATH = /["&|<>^%\r\n]/;

function clampInt(v, min, max, name) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}: enter a number from ${min} to ${max}`);
  return n;
}
function cleanPath(v, name) {
  const s = String(v ?? '').trim();
  if (BAD_PATH.test(s)) throw new Error(`${name}: the path must not contain quotes or & | < > ^ %`);
  return s;
}
// Full path of the local resume PDF from settings; "C:\...\resume" also finds "resume.pdf".
function resumePdfFile(cfg) {
  if (!cfg.resumePdfPath) return '';
  const p = path.resolve(ROOT, cfg.resumePdfPath);
  if (!fs.existsSync(p) && !/\.pdf$/i.test(p) && fs.existsSync(p + '.pdf')) return p + '.pdf';
  return p;
}

// Takes the settings object from the page; keys it doesn't know are kept as they are.
// Returns { config, restart } — restart is true when a change applies only after a server restart.
function saveConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be a JSON object');
  const cur = config();
  const out = { ...readJson(FILES.config, {}), ...input, models: {}, effort: {}, timeouts: {} };
  for (const a of ACTIONS) {
    const m = String((input.models || cur.models)[a] ?? '').trim();
    if (!MODEL_RE.test(m)) throw new Error(`Model for "${a}": letters, digits, dots, dashes and [] only`);
    out.models[a] = m;
    const e = String((input.effort || cur.effort)[a] ?? '').trim();
    if (!EFFORTS.includes(e)) throw new Error(`Effort for "${a}" must be one of: ${EFFORTS.filter(Boolean).join(', ')}`);
    out.effort[a] = e;
    if (a !== 'search') out.timeouts[a] = clampInt((input.timeouts || cur.timeouts)[a], 1, 120, `Timeout for "${a}"`);
  }
  out.port = clampInt(out.port ?? cur.port, 1024, 65535, 'Port');
  out.maxParallel = clampInt(out.maxParallel ?? cur.maxParallel, 1, 6, 'Parallel runs');
  out.maxJobsPerSearch = clampInt(out.maxJobsPerSearch ?? cur.maxJobsPerSearch, 1, 60, 'Jobs per search');
  out.searchTimeoutMinutes = clampInt(out.searchTimeoutMinutes ?? cur.searchTimeoutMinutes, 2, 120, 'Search timeout');
  out.applyBrowserPort = clampInt(out.applyBrowserPort ?? cur.applyBrowserPort, 1024, 65535, 'Form browser port');
  out.perplexity = !!(out.perplexity ?? cur.perplexity);
  out.linkedin = !!(out.linkedin ?? cur.linkedin);
  out.resumeSyncOnStart = !!(out.resumeSyncOnStart ?? cur.resumeSyncOnStart);
  out.cvTwoPages = !!(out.cvTwoPages ?? cur.cvTwoPages);
  for (const k of ['claudeBin', 'mcpConfig', 'applyBrowserBin', 'browserBin', 'resumePdfPath']) out[k] = cleanPath(out[k], k);
  out.resumeDrive = String(out.resumeDrive ?? '').trim();
  if (out.resumeDrive && !/^https:\/\/(docs|drive)\.google\.com\//.test(out.resumeDrive)) {
    throw new Error('Resume link must start with https://docs.google.com/ or https://drive.google.com/');
  }
  const tools = Array.isArray(out.extraAllowedTools) ? out.extraAllowedTools : String(out.extraAllowedTools || '').split(/[,\s]+/);
  out.extraAllowedTools = tools.map(t => String(t).trim()).filter(Boolean);
  const badTool = out.extraAllowedTools.find(t => !TOOL_RE.test(t));
  if (badTool) throw new Error(`Tool name "${badTool}": no spaces or quotes`);
  const as = { ...cur.autoSearch, ...(input.autoSearch || {}) };
  out.autoSearch = { enabled: !!as.enabled, everyHours: clampInt(as.everyHours, 1, 168, 'Auto search interval'),
    maxAgeDays: clampInt(as.maxAgeDays, 0, 365, 'Auto search period'), sourcesOnly: !!as.sourcesOnly };
  const langs = { ...cur.languages, ...(input.languages || {}) };
  out.languages = {};
  for (const [k, name] of [['cv', 'Resume language'], ['letter', 'Cover letter language'], ['messages', 'LinkedIn notes language'], ['forms', 'Form answers language']]) {
    out.languages[k] = cleanLang(langs[k], name);
  }
  writeJson(FILES.config, out);
  return { config: config(), restart: out.port !== cur.port };
}

// ---------- "Where you work from" fields on the Profile tab: used in scoring, salary and cover letters ----------
const DEFAULT_CANDIDATE = { livesIn: '', timezone: '', currency: 'USD' };
// Short plain text only — these go into prompts.
const PLACE_RE = /^[\p{L}\p{N} .,()'+-]{0,60}$/u;

function candidate() {
  const c = readJson(FILES.candidate, {});
  return { ...DEFAULT_CANDIDATE, ...c };
}

function saveCandidate(input) {
  const c = { ...candidate(), ...(input || {}) };
  const out = {};
  for (const [k, name] of [['livesIn', 'Where you live'], ['timezone', 'Time zone']]) {
    out[k] = String(c[k] ?? '').trim();
    if (!PLACE_RE.test(out[k])) throw new Error(`${name}: letters, digits and . , ( ) ' + - only, up to 60 characters`);
  }
  out.currency = String(c.currency ?? '').trim().toUpperCase() || 'USD';
  if (!/^[A-Z]{3}$/.test(out.currency)) throw new Error('Salary currency: a 3-letter code, e.g. USD, EUR, BRL');
  writeJson(FILES.candidate, out);
  return out;
}

// ---------- usage log: one entry per claude run, shown on the Settings tab ----------
const USAGE = path.join(DATA, 'usage.json');
function logUsage(entry) {
  const list = readJson(USAGE, []);
  list.push({ at: new Date().toISOString(), ...entry });
  writeJson(USAGE, list.slice(-3000));
}
function usage(days) {
  const since = Date.now() - days * 86400000;
  return readJson(USAGE, []).filter(u => Date.parse(u.at) >= since);
}

// Days since a "YYYY-MM-DD" posting date; null when the date is missing or not parseable.
function postedAgeDays(posted) {
  const m = String(posted || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function normalizeUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(String(u).trim());
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|source|trk|gh_src)/i.test(k)) url.searchParams.delete(k);
    }
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch (_) {
    return String(u).trim().toLowerCase();
  }
}

const RUBRIC = [
  ['stack', 'Tech stack', 35], ['seniority', 'Seniority & role', 25], ['domain', 'Domain & type of work', 15],
  ['location', 'Location', 15], ['preferences', 'Your preferences', 10],
];
function normalizeBreakdown(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return RUBRIC.map(([key, label, max]) => {
    const it = list.find(x => x && x.key === key) || {};
    const pts = Number.isFinite(+it.points) ? Math.max(0, Math.min(max, Math.round(+it.points))) : 0;
    return { key, label, max, points: pts, note: it.note || '' };
  });
}
// The total is always the sum of the parts, so the breakdown and the number never disagree.
function scoreFrom(raw) {
  const b = normalizeBreakdown(raw.fit_breakdown);
  if (b) return b.reduce((a, x) => a + x.points, 0);
  return Number.isFinite(+raw.fit_score) ? Math.max(0, Math.min(100, Math.round(+raw.fit_score))) : null;
}

// Market estimate Claude gives when the posting states no pay. Ignored when the posting has a figure.
function salaryEstimate(raw) {
  const e = raw.salary_estimate;
  if (/\d/.test(raw.salary || '') || !e || !String(e.range || '').trim()) return null;
  return {
    range: String(e.range).trim(),
    basis: String(e.basis || ''),
    sources: Array.isArray(e.sources) ? e.sources.filter(s => /^https?:\/\//i.test(s)).slice(0, 3) : [],
  };
}

function jobs() { return readJson(FILES.jobs, []); }
function saveJobs(list) { writeJson(FILES.jobs, list); }

// Adds jobs that aren't known yet (by URL, or by company+title). Returns the ones actually added.
function addJobs(found, origin) {
  const list = jobs();
  const seenUrls = new Set(list.map(j => normalizeUrl(j.url)));
  const seenKeys = new Set(list.map(j => (j.company + '|' + j.title).toLowerCase()));
  const added = [];
  for (const raw of found || []) {
    if (!raw || !raw.title) continue;
    const key = ((raw.company || '') + '|' + raw.title).toLowerCase();
    const nu = normalizeUrl(raw.url);
    // Search results are also matched by company+title (the same job is often cross-posted under other links).
    // A link you paste yourself is only a duplicate if the link is already in the list.
    if ((nu && seenUrls.has(nu)) || (origin !== 'manual' && seenKeys.has(key)) || (origin === 'manual' && !nu && seenKeys.has(key))) continue;
    const job = {
      id: crypto.randomUUID().slice(0, 8),
      title: String(raw.title).trim(),
      company: String(raw.company || '').trim(),
      url: raw.url || '',
      location: raw.location || '',
      remote: raw.remote || '',
      locationEvidence: raw.location_evidence || '',
      postingText: raw.posting_text || '',
      salary: raw.salary || '',
      salaryEstimate: salaryEstimate(raw),
      posted: raw.posted || '',
      source: raw.source || '',
      language: raw.language || '',
      summary: raw.summary || '',
      fitBreakdown: normalizeBreakdown(raw.fit_breakdown),
      requirements: Array.isArray(raw.requirements) ? raw.requirements.filter(r => r && r.text).slice(0, 20).map(r => ({
        text: String(r.text), importance: r.importance === 'nice' ? 'nice' : 'required',
        inResume: !!r.in_resume, evidence: r.evidence || '',
      })) : null,
      fitScore: scoreFrom(raw),
      fitReason: raw.fit_reason || '',
      status: 'new',
      notes: '',
      origin,
      foundAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    list.push(job);
    added.push(job);
    if (nu) seenUrls.add(nu);
    seenKeys.add(key);
  }
  saveJobs(list);
  return added;
}

// Refresh: replace the analysis of an existing job (score, requirements, details) but keep
// your own data — status, notes, when it was found, and the CV/letter already made for it.
function refreshJob(id, raw) {
  const list = jobs();
  const j = list.find(x => x.id === id);
  if (!j) return null;
  const pick = (v, old) => (v != null && v !== '' ? v : old);
  Object.assign(j, {
    title: pick(String(raw.title || '').trim(), j.title),
    company: pick(String(raw.company || '').trim(), j.company),
    url: pick(raw.url, j.url),
    location: raw.location || '',
    remote: raw.remote || '',
    locationEvidence: raw.location_evidence || '',
    postingText: pick(raw.posting_text, j.postingText),
    salary: raw.salary || '',
    salaryEstimate: salaryEstimate(raw),
    posted: pick(raw.posted, j.posted),
    language: raw.language || '',
    summary: raw.summary || '',
    fitBreakdown: normalizeBreakdown(raw.fit_breakdown),
    requirements: Array.isArray(raw.requirements) ? raw.requirements.filter(r => r && r.text).slice(0, 20).map(r => ({
      text: String(r.text), importance: r.importance === 'nice' ? 'nice' : 'required',
      inResume: !!r.in_resume, evidence: r.evidence || '',
    })) : null,
    fitScore: scoreFrom(raw),
    fitReason: raw.fit_reason || '',
    refreshedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveJobs(list);
  return j;
}

function updateJob(id, patch) {
  const list = jobs();
  const j = list.find(x => x.id === id);
  if (!j) return null;
  const allowed = ['postingText', 'status', 'notes', 'title', 'company', 'url', 'fitScore', 'fitReason', 'summary', 'salary', 'location', 'remote', 'applyUrl', 'starred'];
  for (const k of allowed) if (k in patch) j[k] = patch[k];
  // Set once, the first time the job becomes Applied; moving on to Interview / Offer keeps it.
  if (patch.status === 'applied' && !j.appliedAt) j.appliedAt = new Date().toISOString();
  // Why you skipped it goes to the profile, so later searches and scoring avoid such roles.
  const reason = String(patch.skipReason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (reason) {
    j.skipReason = reason;
    addProfileLine('Not interested in (reasons I skipped jobs):', `${reason} (e.g. ${j.company} — ${j.title})`);
  }
  j.updatedAt = new Date().toISOString();
  saveJobs(list);
  return j;
}

// "Find people" result: who hires for the job, the referral program, employees who could refer you.
const LOCATION_RANK = { job_location: 0, same_country: 1, unknown: 2, other: 3 };

function setPeople(id, raw) {
  const list = jobs();
  const j = list.find(x => x.id === id);
  if (!j) return null;
  const url = u => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '');
  const person = p => ({
    name: String(p.name || '').trim(), title: String(p.title || '').trim(),
    linkedin: url(p.linkedin), url: url(p.url), why: String(p.why || ''),
    confidence: ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'low',
    location: String(p.location || '').trim(),
    locationMatch: LOCATION_RANK[p.location_match] != null ? p.location_match : 'unknown',
    message: String(p.message || '').trim(),
  });
  // People in the job's city / country first; the sort is stable, so Claude's order holds within a group.
  const people = arr => (Array.isArray(arr) ? arr : []).filter(p => p && p.name).map(person)
    .sort((a, b) => LOCATION_RANK[a.locationMatch] - LOCATION_RANK[b.locationMatch]);
  const rp = raw.referral_program || {};
  j.people = {
    hiring: people(raw.hiring).slice(0, 3),
    referrers: people(raw.referrers).slice(0, 3),
    referralProgram: {
      status: ['yes', 'no'].includes(rp.status) ? rp.status : 'unknown',
      details: String(rp.details || ''),
      sources: (Array.isArray(rp.sources) ? rp.sources : []).map(url).filter(Boolean).slice(0, 3),
    },
    notes: String(raw.notes || ''),
    foundAt: new Date().toISOString(),
  };
  j.updatedAt = new Date().toISOString();
  saveJobs(list);
  return j.people;
}

function deleteJob(id) {
  const list = jobs();
  const i = list.findIndex(x => x.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  saveJobs(list);
  fs.rmSync(path.join(APPS, id), { recursive: true, force: true });
  return true;
}

function appDir(id) { return path.join(APPS, id.replace(/[^a-z0-9-]/gi, '')); }

function docs(id) {
  const dir = appDir(id);
  return {
    cv: readText(path.join(dir, 'cv.md')),
    coverLetter: readText(path.join(dir, 'cover-letter.md')),
    meta: readJson(path.join(dir, 'meta.json'), null),
    base: readText(path.join(dir, 'base-resume.md')) || readText(FILES.resume),
  };
}

function saveDocs(id, { cv, coverLetter, meta, base }) {
  const dir = appDir(id);
  fs.mkdirSync(dir, { recursive: true });
  if (cv != null) writeAtomic(path.join(dir, 'cv.md'), cv);
  if (coverLetter != null) writeAtomic(path.join(dir, 'cover-letter.md'), coverLetter);
  if (meta != null) writeJson(path.join(dir, 'meta.json'), meta);
  if (base != null) writeAtomic(path.join(dir, 'base-resume.md'), base); // resume as it was when this CV was made
}

// "I have this" from the requirements check: remember the skill in the profile so Claude may use it.
function addProfileSkill(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!t) return false;
  addProfileLine('Also have (not written in the resume yet):', t);
  return true;
}

// Adds "- t" to the list under head in profile.md (creates the list at the end if needed; skips exact repeats).
function addProfileLine(head, t) {
  let prof = readText(FILES.profile);
  if (!prof.includes(head)) prof = prof.replace(/\s*$/, '') + '\n\n' + head + '\n';
  if (prof.toLowerCase().includes('- ' + t.toLowerCase() + '\n')) return;
  const idx = prof.indexOf(head) + head.length;
  const rest = prof.slice(idx);
  const m = rest.match(/^(\n- [^\n]*)*/);
  const end = idx + (m ? m[0].length : 0);
  prof = prof.slice(0, end) + '\n- ' + t + prof.slice(end);
  writeAtomic(FILES.profile, prof.replace(/\s*$/, '') + '\n');
}

// ---------- custom sources: job sites and Telegram channels the search must check ----------
// Accepts "@channel", "t.me/channel", "https://t.me/s/channel", a full URL or a bare domain.
function parseSource(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const tg = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([a-z0-9_]{4,})\/?$/i) || s.match(/^@([a-z0-9_]{4,})$/i);
  if (tg) return { kind: 'telegram', name: '@' + tg[1], url: 'https://t.me/s/' + tg[1] };
  const withProto = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  try {
    const u = new URL(withProto);
    if (!u.hostname.includes('.')) return null;
    return { kind: 'site', name: u.hostname.replace(/^www\./, ''), url: u.toString() };
  } catch (_) { return null; }
}

function sources() { return readJson(FILES.sources, []); }

// board: { ats, slug, eu } when the link is a company board on a hiring platform (lib/ats-boards.js found it).
// linkedin: { name } when the link is a LinkedIn job search (lib/linkedin.js).
function addSource(input, note, board, linkedin) {
  let src = parseSource(input);
  if (!src) return null;
  if (board && src.kind === 'site') src = { kind: 'company', name: board.slug, url: src.url, ats: board.ats, slug: board.slug, eu: !!board.eu };
  if (linkedin && src.kind === 'site') src = { kind: 'linkedin', name: linkedin.name, url: src.url };
  const list = sources();
  if (list.some(x => normalizeUrl(x.url) === normalizeUrl(src.url)
    || (board && x.kind === 'company' && x.ats === board.ats && x.slug.toLowerCase() === board.slug.toLowerCase()))) return { duplicate: true };
  const item = { id: crypto.randomUUID().slice(0, 8), ...src, note: String(note || '').trim(), enabled: true,
    addedAt: new Date().toISOString() };
  list.push(item);
  writeJson(FILES.sources, list);
  return item;
}

function updateSource(id, patch) {
  const list = sources();
  const x = list.find(s => s.id === id);
  if (!x) return null;
  if ('enabled' in patch) x.enabled = !!patch.enabled;
  if ('note' in patch) x.note = String(patch.note || '').trim();
  if (patch.name && x.kind === 'company') x.name = String(patch.name).trim().slice(0, 80);
  writeJson(FILES.sources, list);
  return x;
}

function deleteSource(id) {
  const list = sources();
  const i = list.findIndex(s => s.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  writeJson(FILES.sources, list);
  return true;
}

const cleanWords = list => [...new Set((Array.isArray(list) ? list : String(list || '').split(','))
  .map(w => String(w).trim().toLowerCase()).filter(Boolean))].slice(0, 100);

function sourceFilter() {
  const f = readJson(FILES.sourceFilter, null);
  return f ? { include: cleanWords(f.include), exclude: cleanWords(f.exclude) } : { ...DEFAULT_SOURCE_FILTER };
}

function saveSourceFilter({ include, exclude }) {
  const f = { include: cleanWords(include), exclude: cleanWords(exclude) };
  writeJson(FILES.sourceFilter, f);
  return f;
}

// Whole-word match: "engine" does not hit "engineer"; multi-word entries ("technical artist") match as a phrase.
function hasWord(text, list) {
  const t = ' ' + String(text || '').toLowerCase().split(/[^a-zа-яё0-9+#]+/i).filter(Boolean).join(' ') + ' ';
  return list.some(w => {
    const p = w.split(/[^a-zа-яё0-9+#]+/i).filter(Boolean).join(' ');
    return p && t.includes(' ' + p + ' ');
  });
}

module.exports = {
  addProfileSkill, candidate, saveCandidate,
  sources, addSource, updateSource, deleteSource, sourceFilter, saveSourceFilter, hasWord,
  ROOT, DATA, FILES, APPS, WORK, isSea, publicFile, unpackExtension,
  ensure, config, saveConfig, resumePdfFile, cleanLang, ACTIONS, logUsage, usage, readText, writeAtomic, readJson, writeJson,
  jobs, saveJobs, addJobs, refreshJob, updateJob, setPeople, deleteJob, docs, saveDocs, appDir, normalizeUrl, postedAgeDays,
};
