// Keeps data/resume.md in sync with your resume PDF (Google Drive link or a local file).
// Runs at app start: downloads the PDF, and only if it changed asks Claude (Sonnet, low effort)
// to turn it into the Markdown format the app uses. The old version is kept as a backup.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const { runClaude } = require('./claude');

const STATE = path.join(store.DATA, '.resume-sync.json');

async function download(id) {
  const urls = [
    // Google Doc → exported as PDF; the two below are for a PDF file stored on Drive.
    `https://docs.google.com/document/d/${id}/export?format=pdf`,
    `https://drive.google.com/uc?export=download&id=${id}`,
    `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.slice(0, 5).toString() === '%PDF-') return buf;
    } catch (_) { /* try next */ }
  }
  throw new Error('Could not download the resume from Google Drive. In Drive: Share → General access → "Anyone with the link" (Viewer). Or set a local PDF in Settings → Resume.');
}

function driveId(v) {
  const m = String(v || '').match(/\/d\/([\w-]{20,})|[?&]id=([\w-]{20,})|^([\w-]{20,})$/);
  return m ? (m[1] || m[2] || m[3]) : '';
}

const FORMAT = `Markdown conventions (the app renders them into the resume design — follow exactly):
"# Name"
then header lines, each its own paragraph: "*Title line*", then contact lines as plain text (links as [text](url))
"## Section" for each section (Summary, Skills, Shipped Titles, Work Experience, Pet Projects, Education, Languages...)
"### Job title | Dates" for each job or education entry (exactly one " | " before the dates)
"*Company. Remote*" italic line right after a job heading
"> text" for the company description line and for sub-project headings inside a job
"- " for bullets; "**Label**: text" for skill categories; [text](url) for links that exist in the PDF
Blank line between blocks. No tables, no HTML, no other heading levels.`;

async function syncResume({ force = false, onLog } = {}) {
  const config = store.config();
  const log = m => onLog && onLog(m);
  let pdf;
  if (config.resumePdfPath) {
    pdf = fs.readFileSync(store.resumePdfFile(config));
    log('Read local PDF ' + config.resumePdfPath);
  } else {
    const id = driveId(config.resumeDrive);
    if (!id) return { skipped: true, reason: 'No resume set — add a Google Doc / Drive link or a local PDF in Settings → Resume' };
    pdf = await download(id);
    log(`Downloaded resume PDF (${Math.round(pdf.length / 1024)} KB)`);
  }
  const hash = crypto.createHash('sha256').update(pdf).digest('hex');
  const state = store.readJson(STATE, {});
  if (!force && state.hash === hash && store.readText(store.FILES.resume).trim()) {
    return { skipped: true, reason: 'Resume PDF has not changed' };
  }

  fs.mkdirSync(store.WORK, { recursive: true });
  fs.writeFileSync(path.join(store.WORK, 'resume-source.pdf'), pdf);
  const example = store.readText(store.FILES.resume).split(/\r?\n/).slice(0, 40).join('\n');

  const prompt = `Read the file resume-source.pdf in the current folder with the Read tool. It is the candidate's resume.
Convert it to Markdown. Copy the text EXACTLY as written — same words, dates, numbers, order and sections.
Do not rewrite, improve, shorten, translate or fix anything (only drop PDF artifacts like stray symbols or line-break hyphens).

${FORMAT}

Example of the expected format (an older version of this resume — use it only for the format, take ALL content from the PDF):
${example}`;

  const { data } = await runClaude({
    prompt,
    schema: { type: 'object', properties: { resume_markdown: { type: 'string' } }, required: ['resume_markdown'] },
    action: 'resume',
    allowedTools: ['Read'],
    config,
    cwd: store.WORK,
    timeoutMs: 6 * 60 * 1000,
    onLog,
  });
  const md = String(data.resume_markdown || '').trim();
  if (md.length < 300 || !/^#\s/m.test(md)) throw new Error('Claude returned an unexpected resume text — kept the old one');

  const old = store.readText(store.FILES.resume);
  if (old.trim()) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    fs.mkdirSync(path.join(store.DATA, 'resume-history'), { recursive: true });
    fs.writeFileSync(path.join(store.DATA, 'resume-history', `resume-${stamp}.md`), old);
  }
  store.writeAtomic(store.FILES.resume, md + '\n');
  store.writeJson(STATE, { hash, updatedAt: new Date().toISOString() });
  if (store.readText(store.FILES.profile).trim()) return { updated: true };
  // First resume: start the empty profile from it. A failed draft does not fail the sync.
  try {
    return { updated: true, ...(await draftProfile({ onLog })) };
  } catch (e) {
    log('Could not draft the profile: ' + e.message);
    return { updated: true };
  }
}

// Writes a first "Profile & preferences" text from the resume when the profile is empty,
// and fills empty "Where you live" / "Time zone" fields if the resume shows them.
async function draftProfile({ onLog } = {}) {
  const resume = store.readText(store.FILES.resume).trim();
  if (!resume) return { skipped: true, reason: 'Resume is empty' };
  if (store.readText(store.FILES.profile).trim()) return { skipped: true, reason: 'Profile is not empty' };
  if (onLog) onLog('Drafting the profile from the resume');

  const prompt = `Below is a candidate's resume. Write a first draft of their job-search profile: plain text that a
job-search assistant reads to find and score postings for them. The candidate will edit it.

Sections, each a short paragraph starting with its label (no Markdown headings, no bold):
Target roles: the kinds of roles and levels that fit this resume (the latest titles and the main stack).
Location: where the candidate lives, if the resume says it. Work format (remote / hybrid / on-site, relocation) is
  NOT in a resume — write "Work format: (fill in: remote / hybrid / on-site, open to relocation?)".
Languages: as the resume lists them, with levels.
Strengths to look for in postings: the main skills and technologies from the resume, most important first.
Job boards worth checking: boards that fit this field and region.
Then a last line: "(Fill in: salary expectations, deal-breakers, company types you like or want to avoid.)"

Rules:
- Take facts only from the resume. Do not invent preferences, constraints or salary; leave "(fill in: ...)" instead.
- Write in English, under 250 words, lines wrapped at about 110 characters.
- lives_in: the country the candidate lives in if the resume says it, else empty. timezone: like "UTC+1" only if
  it follows clearly from that country (one time zone), else empty.

RESUME:
${resume}`;

  const config = store.config();
  const { data } = await runClaude({
    prompt,
    schema: { type: 'object', properties: { profile: { type: 'string' }, lives_in: { type: 'string' }, timezone: { type: 'string' } },
      required: ['profile', 'lives_in', 'timezone'] },
    action: 'resume',
    config,
    cwd: store.WORK,
    timeoutMs: 6 * 60 * 1000,
    onLog,
  });
  const text = String(data.profile || '').trim();
  if (text.length < 100) throw new Error('Claude returned an unexpected profile text');
  // The candidate may have typed a profile while Claude was writing.
  if (store.readText(store.FILES.profile).trim()) return { skipped: true, reason: 'Profile is not empty' };
  store.writeAtomic(store.FILES.profile, text + '\n');

  const cand = store.candidate();
  const fill = {};
  if (!cand.livesIn && data.lives_in) fill.livesIn = data.lives_in;
  if (!cand.timezone && data.timezone) fill.timezone = data.timezone;
  if (Object.keys(fill).length) {
    try { store.saveCandidate(fill); } catch (_) { /* odd text from Claude: leave the fields for the candidate */ }
  }
  return { profileDrafted: true };
}

module.exports = { syncResume, draftProfile, driveId };
