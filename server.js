// Job Hunter — local web app. Run: node server.js  →  http://localhost:4317
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./lib/store');
const actions = require('./lib/actions');
const apply = require('./lib/apply');
const { syncResume, draftProfile } = require('./lib/resume-sync');
const { taskContext, resetClaude, claudeVersion } = require('./lib/claude');
const { htmlToPdf, findBrowser } = require('./lib/pdf');
const { findBoard } = require('./lib/ats-boards');
const { isLinkedInSearch, searchName } = require('./lib/linkedin');

store.ensure();
// Read once at start for the port; everything else reads store.config() fresh, so the Settings tab applies at once.
const config = store.config();
// Version in the extension folder; the page compares it with the one the browser has loaded.
let EXTENSION_VERSION = '';
try {
  EXTENSION_VERSION = JSON.parse(fs.readFileSync(path.join(store.ROOT, 'extension', 'manifest.json'), 'utf8')).version;
} catch (e) { console.log('Cannot read extension/manifest.json: ' + e.message); }

// ---------- task queue: up to config.maxParallel claude processes at once ----------
// Short tasks go first, so a pasted link doesn't wait behind a 20-minute search.
const PRIORITY = { apply: 0, analyze: 1, refresh: 1, tailor: 1, people: 1, resume: 2, search: 3 };
// These never run twice at once: two searches would find the same jobs, two form fills would fight over one browser.
const ONE_AT_A_TIME = new Set(['search', 'apply', 'resume']);
const tasks = [];
let running = 0;

function enqueue(kind, label, fn, jobId) {
  const t = { id: crypto.randomUUID().slice(0, 8), kind, label, jobId: jobId || null, status: 'queued', log: [],
    result: null, error: null, createdAt: Date.now(), startedAt: null, finishedAt: null };
  tasks.unshift(t);
  if (tasks.length > 50) tasks.length = 50;
  t._fn = fn;
  pump();
  return t;
}

function pump() {
  const max = Math.max(1, store.config().maxParallel || 1);
  while (running < max) {
    const busy = new Set(tasks.filter(t => t.status === 'running').map(t => t.kind));
    const next = tasks.filter(t => t.status === 'queued' && !(ONE_AT_A_TIME.has(t.kind) && busy.has(t.kind)))
      .sort((a, b) => (PRIORITY[a.kind] ?? 1) - (PRIORITY[b.kind] ?? 1) || a.createdAt - b.createdAt)[0];
    if (!next) return;
    start(next);
  }
}

async function start(next) {
  running++;
  next.status = 'running';
  next.startedAt = Date.now();
  next._abort = new AbortController();
  const onLog = line => { next.log.push(line); if (next.log.length > 40) next.log.shift(); };
  try {
    next.result = await taskContext.run({ signal: next._abort.signal }, () => next._fn(onLog));
    next.status = next._abort.signal.aborted ? 'cancelled' : 'done';
  } catch (e) {
    if (next._abort.signal.aborted) {
      next.status = 'cancelled';
    } else {
      next.status = 'failed';
      next.error = e.message;
      console.error(`[${next.kind}] failed:`, e.message);
    }
  } finally {
    next.finishedAt = Date.now();
    delete next._fn;
    delete next._abort;
    running--;
    pump();
  }
}

// Queued tasks are dropped; a running task's claude process is killed.
function cancel(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return null;
  if (t.status === 'queued') {
    t.status = 'cancelled';
    t.finishedAt = Date.now();
    delete t._fn;
  } else if (t.status === 'running') {
    t._abort.abort();
  }
  return t;
}

function publicTask(t) {
  const { _fn, _abort, ...rest } = t;
  return rest;
}

// ---------- search (from the button and from the auto search timer) ----------
const AUTO_STATE = path.join(store.DATA, '.auto-search.json');
function startSearch({ maxAgeDays, sourcesOnly, auto }) {
  const label = (auto ? 'Auto search: ' : '') + (sourcesOnly ? 'Searching your sources' : 'Searching for new jobs')
    + (maxAgeDays ? ` (posted ≤ ${maxAgeDays} days)` : maxAgeDays === 0 ? ' (any date)' : '');
  store.writeJson(AUTO_STATE, { lastSearchAt: Date.now() });
  return enqueue('search', label, log => actions.search({ onLog: log, maxAgeDays, sourcesOnly }));
}
// Any search (manual or auto) resets the interval, so a manual search doesn't get repeated right after.
function autoSearchTick() {
  const a = store.config().autoSearch;
  if (!a || !a.enabled || !store.readText(store.FILES.resume).trim()) return;
  if (tasks.some(t => t.kind === 'search' && (t.status === 'queued' || t.status === 'running'))) return;
  const last = store.readJson(AUTO_STATE, {}).lastSearchAt || 0;
  if (Date.now() - last < a.everyHours * 3600000) return;
  startSearch({ maxAgeDays: a.maxAgeDays, sourcesOnly: !!a.sourcesOnly, auto: true });
}
function nextAutoSearchAt() {
  const a = store.config().autoSearch;
  if (!a || !a.enabled) return null;
  return (store.readJson(AUTO_STATE, {}).lastSearchAt || 0) + a.everyHours * 3600000;
}

// Runs per action for the Settings tab. costUsd is what the same tokens would cost on the API —
// with a subscription you don't pay it, but it shows which actions eat the most of your limits.
function usageSummary(days) {
  const rows = {};
  for (const u of store.usage(days)) {
    const r = rows[u.action] || (rows[u.action] = { action: u.action, runs: 0, failed: 0, costUsd: 0, durationMs: 0, models: {} });
    r.runs++;
    if (!u.ok) r.failed++;
    r.costUsd += u.costUsd || 0;
    r.durationMs += u.durationMs || 0;
    const m = u.model || 'default';
    r.models[m] = (r.models[m] || 0) + 1;
  }
  return Object.values(rows).map(r => ({ ...r, avgSec: Math.round(r.durationMs / r.runs / 1000) }));
}

// ---------- http helpers ----------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  // Other sites open in the browser can reach localhost too. Host blocks DNS rebinding (a foreign domain pointed
  // at 127.0.0.1 reading your data); Origin + JSON content type block forms and fetches from other pages
  // (a JSON body can't be sent cross-site without a CORS preflight, which this server never allows).
  const hosts = [`localhost:${config.port}`, `127.0.0.1:${config.port}`];
  if (!hosts.includes(String(req.headers.host).toLowerCase())) return send(res, 403, { error: 'Forbidden host' });
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !hosts.some(h => origin === 'http://' + h)) return send(res, 403, { error: 'Forbidden origin' });
    if (!String(req.headers['content-type']).includes('application/json')) return send(res, 415, { error: 'JSON only' });
  }

  if (!p.startsWith('/api/')) {
    const name = p === '/' ? 'index.html' : p.slice(1);
    const body = store.publicFile(name);
    if (!body) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, body, MIME[path.extname(name)] || 'application/octet-stream');
  }

  if (p === '/api/state' && m === 'GET') {
    const jobs = store.jobs();
    const withDocs = new Set(fs.existsSync(store.APPS) ? fs.readdirSync(store.APPS) : []);
    return send(res, 200, {
      jobs: jobs.map(({ postingText, ...j }) => ({ ...j, hasDocs: withDocs.has(j.id) })),
      tasks: tasks.map(publicTask),
      hasResume: !!store.readText(store.FILES.resume).trim(),
      extensionVersion: EXTENSION_VERSION,
    });
  }

  const cm = p.match(/^\/api\/tasks\/([a-z0-9-]+)\/cancel$/i);
  if (cm && m === 'POST') {
    const t = cancel(cm[1]);
    return t ? send(res, 200, publicTask(t)) : send(res, 404, { error: 'Not found' });
  }

  if (p === '/api/restart' && m === 'POST') {
    // Only start.bat brings the server back up; started any other way, a restart would just stop it.
    if (!process.env.JOB_HUNTER_SUPERVISED) return send(res, 409, { error: 'Restart works only when the server is started with start.bat' });
    console.log('Restarting (requested from the web page)…');
    send(res, 202, { ok: true });
    return shutdown(RESTART_CODE);
  }

  if (p === '/api/pdf' && m === 'POST') {
    const b = await readBody(req);
    if (typeof b.html !== 'string' || !b.html) return send(res, 400, { error: 'No HTML' });
    return send(res, 200, await htmlToPdf(b.html), 'application/pdf');
  }

  if (p === '/api/texts' && m === 'GET') {
    return send(res, 200, { resume: store.readText(store.FILES.resume), profile: store.readText(store.FILES.profile),
      candidate: store.candidate() });
  }
  if (p === '/api/resume/sync' && m === 'POST') {
    const t = enqueue('resume', 'Updating resume from the PDF', log => syncResume({ force: true, onLog: log }));
    return send(res, 202, publicTask(t));
  }
  if (p === '/api/profile/skill' && m === 'POST') {
    const b = await readBody(req);
    return store.addProfileSkill(b.text) ? send(res, 200, { ok: true }) : send(res, 400, { error: 'Empty' });
  }
  if (p === '/api/texts' && m === 'PUT') {
    const b = await readBody(req);
    // Checked first, so a bad field doesn't leave the texts half saved.
    if (b.candidate) {
      try { store.saveCandidate(b.candidate); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    const firstResume = !store.readText(store.FILES.resume).trim();
    if (typeof b.resume === 'string') store.writeAtomic(store.FILES.resume, b.resume);
    if (typeof b.profile === 'string') store.writeAtomic(store.FILES.profile, b.profile);
    // Resume pasted for the first time and no profile yet: draft one from the resume.
    if (firstResume && store.readText(store.FILES.resume).trim() && !store.readText(store.FILES.profile).trim()) {
      enqueue('resume', 'Drafting the profile from the resume', log => draftProfile({ onLog: log }));
      return send(res, 200, { ok: true, profileDraft: true });
    }
    return send(res, 200, { ok: true });
  }

  if (p === '/api/search' && m === 'POST') {
    const b = await readBody(req);
    const n = Number(b.maxAgeDays);
    const maxAgeDays = Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
    const t = startSearch({ maxAgeDays, sourcesOnly: !!b.sourcesOnly });
    return send(res, 202, publicTask(t));
  }

  if (p === '/api/settings' && m === 'GET') {
    let pdfBrowser = '';
    try { pdfBrowser = findBrowser(); } catch (_) { /* none found */ }
    return send(res, 200, { config: store.config(), actions: store.ACTIONS, browsers: apply.detectBrowsers(), pdfBrowser,
      runningPort: config.port, supervised: !!process.env.JOB_HUNTER_SUPERVISED, nextAutoSearchAt: nextAutoSearchAt() });
  }
  if (p === '/api/settings' && m === 'PUT') {
    const before = store.config();
    let r;
    try { r = store.saveConfig(await readBody(req)); } catch (e) { return send(res, 400, { error: e.message }); }
    if (r.config.claudeBin !== before.claudeBin) resetClaude();
    pump(); // maxParallel may have gone up
    return send(res, 200, { ...r, restart: r.config.port !== config.port, nextAutoSearchAt: nextAutoSearchAt() });
  }
  if (p === '/api/settings/test-claude' && m === 'POST') {
    resetClaude();
    return send(res, 200, await claudeVersion(store.config().claudeBin));
  }
  if (p === '/api/usage' && m === 'GET') {
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
    return send(res, 200, { days, rows: usageSummary(days) });
  }

  if (p === '/api/sources/filter' && m === 'GET') return send(res, 200, store.sourceFilter());
  if (p === '/api/sources/filter' && m === 'PUT') return send(res, 200, store.saveSourceFilter(await readBody(req)));
  if (p === '/api/sources' && m === 'GET') return send(res, 200, store.sources());
  if (p === '/api/sources' && m === 'POST') {
    const b = await readBody(req);
    // A company board (Greenhouse, Lever...) — the link itself or the careers page it is embedded in.
    // A LinkedIn job search link is read through LinkedIn's guest pages instead (lib/linkedin.js).
    const raw = String(b.input || '').trim();
    const full = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    const linkedin = isLinkedInSearch(raw) ? { name: searchName(full) } : null;
    const board = linkedin || /^@|t\.me\/|telegram\.me\//i.test(raw) ? null : await findBoard(full);
    const s = store.addSource(b.input, b.note, board, linkedin);
    if (!s) return send(res, 400, { error: 'Enter a site link (e.g. example.com/jobs), a company job board link (job-boards.greenhouse.io/discord), a LinkedIn job search link or a Telegram channel (@channel or t.me/channel)' });
    if (s.duplicate) return send(res, 409, { error: 'This source is already in the list' });
    return send(res, 200, s);
  }
  const sm = p.match(/^\/api\/sources\/([a-z0-9-]+)$/i);
  if (sm && m === 'PATCH') {
    const s = store.updateSource(sm[1], await readBody(req));
    return s ? send(res, 200, s) : send(res, 404, { error: 'Not found' });
  }
  if (sm && m === 'DELETE') {
    return store.deleteSource(sm[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Not found' });
  }

  if (p === '/api/jobs' && m === 'POST') {
    const b = await readBody(req);
    const input = String(b.input || '').trim();
    if (!input) return send(res, 400, { error: 'Paste a job URL or the posting text' });
    const label = /^https?:/i.test(input) ? 'Reading ' + input.slice(0, 60) : 'Reading pasted posting';
    const t = enqueue('analyze', label, log => actions.analyze(input, { onLog: log }));
    return send(res, 202, publicTask(t));
  }

  const jm = p.match(/^\/api\/jobs\/([a-z0-9-]+)(\/docs|\/tailor|\/refresh|\/apply|\/answers|\/file|\/people)?$/i);
  if (jm) {
    const [, id, sub] = jm;
    if (!sub && m === 'PATCH') {
      const j = store.updateJob(id, await readBody(req));
      return j ? send(res, 200, j) : send(res, 404, { error: 'Not found' });
    }
    if (!sub && m === 'DELETE') {
      return store.deleteJob(id) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Not found' });
    }
    if (sub === '/docs' && m === 'GET') return send(res, 200, store.docs(id));
    if (sub === '/docs' && m === 'PUT') {
      const b = await readBody(req);
      const d = store.docs(id);
      // An edited CV gets its ATS score and checks recomputed against the same posting keywords.
      const meta = b.cv != null && d.meta && d.meta.jobKeywords
        ? { ...d.meta, ...actions.atsReport(b.cv, d.base, store.readText(store.FILES.profile), d.meta.jobKeywords) }
        : null;
      store.saveDocs(id, { cv: b.cv, coverLetter: b.coverLetter, meta });
      return send(res, 200, { ok: true });
    }
    if (sub === '/refresh' && m === 'POST') {
      const job = store.jobs().find(j => j.id === id);
      if (!job) return send(res, 404, { error: 'Not found' });
      if (tasks.some(t => t.jobId === id && t.kind !== 'people' && (t.status === 'queued' || t.status === 'running'))) {
        return send(res, 409, { error: 'Already working on this job' });
      }
      const t = enqueue('refresh', `Refreshing: ${job.company} — ${job.title}`,
        log => actions.refreshJob(id, { onLog: log }), id);
      return send(res, 202, publicTask(t));
    }
    if (sub === '/people' && m === 'POST') {
      const job = store.jobs().find(j => j.id === id);
      if (!job) return send(res, 404, { error: 'Not found' });
      if (tasks.some(t => t.jobId === id && t.kind === 'people' && (t.status === 'queued' || t.status === 'running'))) {
        return send(res, 409, { error: 'Already looking for people for this job' });
      }
      const t = enqueue('people', `Finding HR & referrals: ${job.company} — ${job.title}`,
        log => actions.findPeople(id, { onLog: log }), id);
      return send(res, 202, publicTask(t));
    }
    // open: true — open the application page (custom apply link or the posting) and fill it;
    // open: false — fill whatever page is open in the form-filling browser (e.g. after you pressed "Apply" on the site).
    if (sub === '/apply' && m === 'POST') {
      const b = await readBody(req);
      const job = store.jobs().find(j => j.id === id);
      if (!job) return send(res, 404, { error: 'Not found' });
      if (tasks.some(t => t.jobId === id && t.kind === 'apply' && (t.status === 'queued' || t.status === 'running'))) {
        return send(res, 409, { error: 'Already filling this form' });
      }
      if (b.open) {
        const target = String(b.url || job.applyUrl || job.url || '').trim();
        if (!/^https?:\/\//i.test(target)) return send(res, 400, { error: 'This job has no link to open' });
        await apply.openPage(target, id, String(b.browser || ''));
      }
      const t = enqueue('apply', `Filling the form: ${job.company} — ${job.title}`,
        log => apply.fillForm(id, { onLog: log, cvHtml: typeof b.html === 'string' ? b.html : '', useJobTab: !!b.open, submit: !!b.submit }), id);
      return send(res, 202, publicTask(t));
    }
    // Browser extension mode: the extension collects the fields in your own browser, Claude answers here,
    // then the web page hands the answers and files back to the extension to fill in.
    if (sub === '/answers' && m === 'POST') {
      const b = await readBody(req);
      const job = store.jobs().find(j => j.id === id);
      if (!job) return send(res, 404, { error: 'Not found' });
      if (!Array.isArray(b.fields)) return send(res, 400, { error: 'No fields' });
      if (tasks.some(t => t.jobId === id && t.kind === 'apply' && (t.status === 'queued' || t.status === 'running'))) {
        return send(res, 409, { error: 'Already filling this form' });
      }
      const t = enqueue('apply', `Filling the form: ${job.company} — ${job.title}`, async log => {
        const r = await apply.answerFields(id, b.fields, { onLog: log, cvHtml: typeof b.html === 'string' ? b.html : '', submit: !!b.submit });
        const files = Object.fromEntries(Object.entries(r.files).map(([k, f]) => [k, path.basename(f)]));
        return { ...r, files, filled: null, uploaded: 0 };
      }, id);
      return send(res, 202, publicTask(t));
    }
    if (sub === '/file' && m === 'GET') {
      const file = apply.preparedFile(id, url.searchParams.get('name') || '');
      return file ? send(res, 200, fs.readFileSync(file), 'application/pdf') : send(res, 404, { error: 'Not found' });
    }
    if (sub === '/tailor' && m === 'POST') {
      const b = await readBody(req);
      const job = store.jobs().find(j => j.id === id);
      if (!job) return send(res, 404, { error: 'Not found' });
      if (tasks.some(t => t.jobId === id && t.kind !== 'people' && (t.status === 'queued' || t.status === 'running'))) {
        return send(res, 409, { error: 'Already working on this job' });
      }
      let lang = '';
      try { if (b.lang) lang = store.cleanLang(b.lang, 'Language'); } catch (e) { return send(res, 400, { error: e.message }); }
      const t = enqueue('tailor', `CV + cover letter${lang ? ' (' + lang + ')' : ''}: ${job.company} — ${job.title}`,
        log => actions.tailor(id, { onLog: log, extra: String(b.extra || ''), lang }), id);
      return send(res, 202, publicTask(t));
    }
  }

  return send(res, 404, { error: 'Unknown endpoint' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => send(res, 500, { error: e.message }));
});

function openBrowser() {
  const { exec } = require('node:child_process');
  const u = `http://localhost:${config.port}`;
  exec(process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open ${u}` : `xdg-open ${u}`);
}

let listenTries = 0;
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  // A restarted job-hunter.exe may start before the old one has let the port go: wait a little.
  if (process.env.JOB_HUNTER_RESTARTED && ++listenTries < 20) return setTimeout(listen, 500);
  // Started a second time: the app is already running, just show it.
  console.log(`Job Hunter is already running on port ${config.port}, opening it in the browser.`);
  if (process.argv.includes('--open')) openBrowser();
  setTimeout(() => process.exit(0), 1500);
});

// Listen only on this computer — the app uses your Claude subscription, it must not be reachable from outside.
const listen = () => server.listen(config.port, '127.0.0.1');
listen();
server.on('listening', () => {
  console.log(`Job Hunter is running: http://localhost:${config.port}  (type "restart" or "exit" here)`);
  // Pull the latest resume PDF on every start (Claude runs only if the PDF changed).
  if (config.resumeSyncOnStart && (config.resumeDrive || config.resumePdfPath)) {
    enqueue('resume', 'Checking the resume PDF for changes', log => syncResume({ onLog: log }));
  }
  setInterval(autoSearchTick, 60000);
  setTimeout(autoSearchTick, 15000);
  if (process.argv.includes('--open')) openBrowser();
});

// ---------- console commands (type in the server window) ----------
// start.bat starts the server again when it exits with code 75.
const RESTART_CODE = 75;
function shutdown(code) {
  for (const t of tasks) if (t.status === 'running' && t._abort) t._abort.abort();
  server.close();
  setTimeout(() => {
    // job-hunter.exe runs without start.bat, so it starts its replacement itself, in a new window.
    if (code === RESTART_CODE && store.isSea()) {
      require('node:child_process').exec(`start "Job Hunter" "${process.execPath}"`,
        { env: { ...process.env, JOB_HUNTER_RESTARTED: '1' } }).on('exit', () => process.exit(0));
      return;
    }
    process.exit(code);
  }, 300);
}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const cmd = line.trim().toLowerCase();
  if (['restart', 'r', 'рестарт'].includes(cmd)) {
    console.log('Restarting…');
    shutdown(RESTART_CODE);
  } else if (['exit', 'quit', 'q', 'stop'].includes(cmd)) {
    console.log('Stopping…');
    shutdown(0);
  } else if (cmd) {
    console.log('Commands: restart (r), exit (q)');
  }
});
