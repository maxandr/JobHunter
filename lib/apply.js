// "Apply" helper: opens the application page in a separate window of the browser you use for the app (Brave, Chrome,
// Edge...) and fills the form fields from the resume, profile and cover letter. It never presses Submit — you check
// everything and send it yourself.
// Talks to the browser over the DevTools protocol (built-in WebSocket, Node 22+), so no extra packages are needed.
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const { runClaude } = require('./claude');
const { findBrowser, htmlToPdf } = require('./pdf');
// Same page scripts the browser extension uses.
const { collectFields, fillFields, submitForm, submitCheck } = require('../extension/form-scripts');

const port = () => store.config().applyBrowserPort || 9227;
const base = () => `http://127.0.0.1:${port()}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Tab opened for each job by "Open & fill", so its fill step works on that tab even if you switch tabs meanwhile.
const tabOf = new Map();
// Which browser the running form-filling window belongs to.
let running = null;

// Browsers that can be driven (all Chromium-based). The web page tells which one it is open in.
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LAD = process.env.LOCALAPPDATA || '';
const BROWSERS = {
  brave: { name: 'Brave', reg: /brave/i, paths: [`${PF}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${LAD}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`] },
  chrome: { name: 'Chrome', reg: /chrome\.exe/i, paths: [`${PF}\\Google\\Chrome\\Application\\chrome.exe`, `${PF86}\\Google\\Chrome\\Application\\chrome.exe`, `${LAD}\\Google\\Chrome\\Application\\chrome.exe`] },
  edge: { name: 'Edge', reg: /msedge/i, paths: [`${PF86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${PF}\\Microsoft\\Edge\\Application\\msedge.exe`] },
  opera: { name: 'Opera', reg: /opera/i, paths: [`${LAD}\\Programs\\Opera\\opera.exe`, `${LAD}\\Programs\\Opera GX\\opera.exe`] },
  yandex: { name: 'Yandex Browser', reg: /yandex/i, paths: [`${LAD}\\Yandex\\YandexBrowser\\Application\\browser.exe`] },
  vivaldi: { name: 'Vivaldi', reg: /vivaldi/i, paths: [`${LAD}\\Vivaldi\\Application\\vivaldi.exe`, `${PF}\\Vivaldi\\Application\\vivaldi.exe`] },
};

// Installed browsers as Windows lists them (Settings → Default apps), for installs in unusual folders.
function registryBrowsers() {
  const out = [];
  for (const root of ['HKCU\\SOFTWARE\\Clients\\StartMenuInternet', 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet', 'HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet']) {
    try {
      const txt = execFileSync('reg', ['query', root, '/s'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const m of txt.matchAll(/\\shell\\open\\command\s+\(\S+\)\s+REG_\w+\s+"?([^"\r\n]+\.exe)/gi)) out.push(m[1]);
    } catch (_) { /* key missing */ }
  }
  return out;
}

function browserBin(kind) {
  const own = store.config().applyBrowserBin;
  if (own) return own;
  const b = BROWSERS[kind];
  if (!b) {
    if (kind === 'firefox' || kind === 'safari') throw new Error('Form filling works only in Chromium browsers (Chrome, Brave, Edge, Opera, Yandex, Vivaldi). Open the app in one of them.');
    return findBrowser();
  }
  const found = b.paths.find(p => fs.existsSync(p)) || (process.platform === 'win32' ? registryBrowsers().find(p => b.reg.test(p) && fs.existsSync(p)) : null);
  if (!found) throw new Error(`${b.name} not found. Set "applyBrowserBin" in config.json to its .exe`);
  return found;
}

async function getJson(p, method = 'GET') {
  const r = await fetch(base() + p, { method, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Browser answered ${r.status} to ${p}`);
  return r.json();
}
async function alive() {
  try { await getJson('/json/version'); return true; } catch (_) { return false; }
}
async function pages() {
  return (await getJson('/json/list')).filter(t => t.type === 'page' && !/^(devtools|edge|chrome|brave|opera|vivaldi|browser|about):/i.test(t.url));
}

async function launch(url, kind) {
  if (typeof WebSocket === 'undefined') throw new Error('Form filling needs Node.js 22 or newer');
  // The browser refuses remote control of your everyday profile, so the window gets its own profile
  // (one per browser): logins you make there (LinkedIn, job boards) are kept between runs.
  const profile = path.join(store.DATA, '.browser-profile-' + (kind || 'default'));
  spawn(browserBin(kind), [
    `--remote-debugging-port=${port()}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    // Keeps embedded application forms (Greenhouse, Lever iframes) in the page's process, so they can be filled too.
    '--disable-features=IsolateOrigins,site-per-process', '--new-window', url,
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await alive()) { running = kind; return; }
  }
  throw new Error('The browser did not start. Close all windows of the "Job Hunter" browser and try again.');
}

/**
 * Opens url in the form-filling browser (starting it if needed) and returns the tab id.
 * kind: the browser the app page is open in ("brave", "chrome", "edge"...); the same browser is used.
 */
async function openPage(url, jobId, kind) {
  let tab;
  let up = await alive();
  if (up && kind && running && running !== kind) {
    // You switched browsers: close the old form-filling window and start the new one.
    const { webSocketDebuggerUrl } = await getJson('/json/version');
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; ws.onerror = r; });
    try { ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch (_) { /* already gone */ }
    for (let i = 0; i < 20 && up; i++) { await sleep(250); up = await alive(); }
  }
  if (up) {
    tab = await getJson('/json/new?' + encodeURI(url), 'PUT');
    await getJson('/json/activate/' + tab.id).catch(() => {});
  } else {
    await launch(url, kind);
    for (let i = 0; i < 20 && !tab; i++) {
      tab = (await pages()).find(t => t.url !== 'about:blank') || null;
      if (!tab) await sleep(250);
    }
    if (!tab) throw new Error('The browser started but the page did not open');
  }
  if (jobId) tabOf.set(jobId, tab.id);
  return tab.id;
}

// ---------- minimal DevTools protocol client ----------
async function connect(tab) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Cannot connect to the browser tab'));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(method + ' timed out'))), 30000);
  });
  return { send, close: () => ws.close() };
}

// One isolated JS world per frame (the page's own scripts can't interfere); embedded forms live in iframes.
async function frameContexts(cdp) {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const frames = [];
  (function walk(n) { frames.push(n.frame); (n.childFrames || []).forEach(walk); })(frameTree);
  const out = [];
  for (const f of frames) {
    try {
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'job-hunter' });
      out.push({ frame: f, ctx: executionContextId });
    } catch (_) { /* frame gone or cross-process */ }
  }
  return out;
}

async function evalIn(cdp, ctx, fn, ...args) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(${fn})(...${JSON.stringify(args)})`, contextId: ctx, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error('Page script failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}


// ---------- the task ----------
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          value: { type: 'string', description: 'Text to type; for select/radio the exact option text; for several checkboxes the option texts one per line; for a single checkbox "true"; for file "resume" or "cover_letter"' },
        },
        required: ['id', 'value'],
      },
    },
    left_for_you: { type: 'array', items: { type: 'string' }, description: 'Short list of fields left empty that the candidate must fill or check' },
  },
  required: ['answers'],
};

async function waitForForm(cdp) {
  for (let i = 0; i < 40; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState + "|" + document.querySelectorAll("input,textarea,select").length', returnByValue: true }).catch(() => null);
    const [state, count] = String(r && r.result.value || '').split('|');
    if (state === 'complete' && (+count > 0 || i >= 6)) return; // the form may be in an iframe
    await sleep(500);
  }
}

// Upload files live outside data/applications, where a folder means "CV ready" in the list.
const filesDir = jobId => path.join(store.WORK, 'apply', jobId.replace(/[^a-z0-9-]/gi, ''));

function applicantName(resume) {
  return ((resume.match(/^#\s+(.+)$/m) || [, 'Resume'])[1].replace(/[*_]/g, '').trim());
}

// Resume file to upload: the tailored CV (rendered by the web page) or the original PDF from Google Drive.
async function resumeFile(jobId, cvHtml, resume, onLog) {
  const dir = filesDir(jobId);
  const file = path.join(dir, applicantName(resume).replace(/[^\p{L}\d]+/gu, '_') + '_CV.pdf');
  if (cvHtml) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, await htmlToPdf(cvHtml));
    onLog('Made PDF of the tailored CV');
    return file;
  }
  const config = store.config();
  const src = store.resumePdfFile(config) || path.join(store.WORK, 'resume-source.pdf');
  if (!fs.existsSync(src)) return null;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, file);
  onLog('Using the base resume PDF (no tailored CV yet)');
  return file;
}

async function letterFile(jobId, letter, resume) {
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:11pt/1.5 Arial,sans-serif;margin:0}
    @page{size:A4;margin:22mm}p{margin:0 0 10pt}</style></head><body>${letter.split(/\n\s*\n/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</body></html>`;
  fs.mkdirSync(filesDir(jobId), { recursive: true });
  const file = path.join(filesDir(jobId), applicantName(resume).replace(/[^\p{L}\d]+/gu, '_') + '_Cover_Letter.pdf');
  fs.writeFileSync(file, await htmlToPdf(html));
  return file;
}


/**
 * Asks Claude what to put into the form fields (as collected by collectFields) and prepares the files to attach.
 * Returns { answers, left, total, files: { resume?: path, cover_letter?: path } }.
 */
async function answerFields(jobId, fields, { onLog = () => {}, cvHtml = '', submit = false } = {}) {
  const config = store.config();
  const job = store.jobs().find(j => j.id === jobId);
  if (!job) throw new Error('Job not found');
  if (!fields.length) {
    throw new Error('No form fields on this page. If the form is on another page, paste its link into "Application form link" and try again.');
  }
  onLog(`Found ${fields.length} fields, asking Claude what to put in them`);

  const resume = store.readText(store.FILES.resume).trim();
  const profile = store.readText(store.FILES.profile).trim();
  const letter = store.docs(jobId).coverLetter.trim();
  const prompt = `${submit ? "You fill in a job application form for one candidate. It is sent right after you fill it." : "You fill in a job application form for one candidate. The candidate will review it and press Submit."}

CANDIDATE RESUME:
${resume}

CANDIDATE PROFILE AND PREFERENCES:
${profile || '(none)'}

${letter ? 'COVER LETTER WRITTEN FOR THIS JOB:\n' + letter : '(No cover letter written for this job yet.)'}

JOB: ${job.title} at ${job.company}${job.url ? ' — ' + job.url : ''}
${(job.postingText || job.summary || '').slice(0, 6000)}

FORM FIELDS (JSON; "current" = already filled, "checked" = already ticked):
${JSON.stringify(fields)}

RULES:
- Answer each field you can, by its "id". Skip fields you have no truthful answer for (do not return them).
- Facts (name, email, phone, links, location, dates, employers, years of experience) only from the resume and profile.
  Split the name into first/last name fields when asked. Phone in international format.
- Never invent facts: salary expectations, notice period, start date, visa/work authorization, references —
  answer only if the profile states it; otherwise leave the field empty and mention it in left_for_you.
- Open questions ("Why do you want to join...", "Tell us about...") — write a short, specific, honest answer
  using real experience from the resume. ${!config.languages.forms || config.languages.forms === 'auto'
    ? 'Write answers in the language of the form.'
    : `Write answers in ${config.languages.forms}, even if the posting or form is in another language.`} "Cover letter" text fields get the cover letter above
  (or, if none, a short 120-180 word letter by the same rules).
- select / radio: value must be exactly one of the listed options. Checkbox groups: matching options one per line.
${submit ? '- Tick the consent boxes needed to apply: processing of personal data, privacy policy, terms, "I confirm the information is correct" (single checkbox: "true"). Do NOT tick marketing, newsletter or "keep me in your talent pool" boxes.'
  : '- Do NOT tick consent, privacy policy, terms, "I confirm/certify" or marketing checkboxes — the candidate does that.'}
- Demographic / EEO questions (gender, race, veteran, disability): pick the "decline to answer"-style option if there
  is one, otherwise skip.
- File fields: "resume" for a resume/CV upload${cvHtml ? '' : ' (base resume PDF)'}, "cover_letter" for a cover letter upload${letter ? '' : ' only if a cover letter exists — none does, so skip it'}.
- Do not fill fields that already have a "current" value, search boxes, or newsletter sign-ups.
- left_for_you: short notes on what the candidate must still fill or check.`;

  const { data } = await runClaude({ prompt, schema: ANSWER_SCHEMA, action: 'apply', allowedTools: [], config, cwd: store.WORK, timeoutMs: 5 * 60 * 1000, onLog });
  const kinds = new Map(fields.map(f => [f.id, f.kind]));
  const answers = (data.answers || []).filter(a => a && a.id && kinds.has(a.id));
  const wantFiles = new Set(answers.filter(a => kinds.get(a.id) === 'file').map(a => a.value));
  const files = {};
  if (wantFiles.has('resume')) files.resume = await resumeFile(jobId, cvHtml, resume, onLog);
  if (letter && wantFiles.has('cover_letter')) files.cover_letter = await letterFile(jobId, letter, resume);
  for (const k of Object.keys(files)) if (!files[k]) delete files[k];
  return { answers, left: data.left_for_you || [], total: fields.length, files };
}

/** A prepared upload file (from answerFields) by its file name, or null. */
function preparedFile(jobId, name) {
  const file = path.join(filesDir(jobId), path.basename(String(name)));
  return /\.pdf$/i.test(file) && fs.existsSync(file) ? file : null;
}

/**
 * Fills the application form in the separate form-filling browser window (used when the extension is not installed).
 * Uses the tab opened for this job by openPage; with useJobTab=false (or no such tab) — the tab you looked at last.
 */
async function fillForm(jobId, { onLog = () => {}, cvHtml = '', useJobTab = true, submit = false } = {}) {
  if (!(await alive())) throw new Error('The form-filling browser is not open. Press "Open & fill" first.');
  const list = await pages();
  const tab = (useJobTab && list.find(t => t.id === tabOf.get(jobId))) || list[0];
  if (!tab) throw new Error('No open page in the form-filling browser');
  onLog('Page: ' + tab.url);

  const cdp = await connect(tab);
  try {
    await waitForForm(cdp);
    const contexts = await frameContexts(cdp);
    const fields = [];
    const ctxOf = new Map();
    for (const [i, c] of contexts.entries()) {
      try {
        for (const f of await evalIn(cdp, c.ctx, collectFields, 'f' + i)) { fields.push(f); ctxOf.set(f.id, c.ctx); }
      } catch (_) { /* skip frame */ }
    }
    const { answers, left, files } = await answerFields(jobId, fields, { onLog, cvHtml, submit });

    // Files go through the DevTools protocol here (the extension attaches them from the page instead).
    let uploaded = 0;
    for (const a of answers) {
      if (ctxOf.has(a.id) && fields.find(f => f.id === a.id).kind === 'file' && files[a.value]) {
        const r = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('[data-jh-id="${a.id}"]')`, contextId: ctxOf.get(a.id) });
        if (!r.result.objectId) continue;
        await cdp.send('DOM.setFileInputFiles', { files: [files[a.value]], objectId: r.result.objectId });
        uploaded++;
      }
    }

    let filled = 0;
    for (const [i, c] of contexts.entries()) {
      const mine = answers.filter(a => ctxOf.get(a.id) === c.ctx);
      if (!mine.length && i > 0) continue;
      try { filled += (await evalIn(cdp, c.ctx, fillFields, mine, i === 0)).filled; } catch (_) { /* frame navigated away */ }
    }
    await cdp.send('Page.bringToFront').catch(() => {});
    onLog(`Filled ${filled} fields, attached ${uploaded} file(s)`);
    const out = { filled, uploaded, total: fields.length, left };
    if (submit && filled) out.submit = await pressSend(cdp, contexts, onLog);
    return out;
  } finally {
    cdp.close();
  }
}

// "Try to auto apply": presses Send in the frame with the filled form, then checks the page a few seconds later.
async function pressSend(cdp, contexts, onLog) {
  const clicks = [];
  for (const c of contexts) {
    const r = await evalIn(cdp, c.ctx, submitForm).catch(() => null);
    if (r && !r.skip) clicks.push(r);
    if (r && r.clicked) break;
  }
  const hit = clicks.find(r => r.clicked);
  if (!hit) {
    return { clicked: false, invalid: clicks.flatMap(r => r.invalid || []),
      reason: (clicks.find(r => r.reason) || {}).reason || (clicks.length ? '' : 'The filled form is gone from the page.') };
  }
  onLog(`Pressed "${hit.button}"`);
  await sleep(4000);
  await waitForForm(cdp);
  const checks = [];
  for (const c of await frameContexts(cdp).catch(() => [])) {
    const r = await evalIn(cdp, c.ctx, submitCheck).catch(() => null);
    if (r) checks.push(r);
  }
  return { ...hit, check: { success: checks.some(c => c.success), stillForm: checks.some(c => c.stillForm), errors: checks.flatMap(c => c.errors) } };
}

// For the Settings tab: which form-filling browsers are installed and where.
function detectBrowsers() {
  const reg = process.platform === 'win32' ? registryBrowsers() : [];
  return Object.entries(BROWSERS).map(([kind, b]) => ({ kind, name: b.name,
    path: b.paths.find(p => fs.existsSync(p)) || reg.find(p => b.reg.test(p) && fs.existsSync(p)) || '' }));
}

module.exports = { openPage, fillForm, answerFields, preparedFile, detectBrowsers };
