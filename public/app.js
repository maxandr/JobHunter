'use strict';
document.head.insertAdjacentHTML('beforeend', `<style>${window.CV_CSS}</style>`);

const STATUSES = [
  ['new', 'New'], ['interested', 'Interested'], ['applied', 'Applied'], ['interview', 'Interview'],
  ['offer', 'Offer'], ['rejected', 'Rejected'], ['skip', 'Skipped'],
];
const S = { jobs: [], tasks: [], hasResume: false, sel: null, filter: 'active', sort: 'fit', docTab: 'cv', editing: false, age: '30' };
S.searchAge = '30';
try {
  const a = localStorage.getItem('ageFilter'); if (a !== null) S.age = a;
  const sa = localStorage.getItem('searchAge'); if (sa !== null && sa !== '0') S.searchAge = sa; // "Any date" was removed
} catch (_) { /* storage blocked */ }
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// ---------- tiny markdown → html (headings, bullets, bold, italics, links) ----------
function md(src) {
  const inline = t => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = []; let list = false;
  for (const raw of String(src || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^\s*[-*•]\s+(.*)/);
    if (!li && list) { out.push('</ul>'); list = false; }
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); }
    else if (/^---+$/.test(line)) out.push('<hr>');
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}

// Days since a "YYYY-MM-DD" posting date; null when unknown. Same logic as store.postedAgeDays.
function ageDays(posted) {
  const m = String(posted || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}
const ageText = d => d == null ? 'no date' : d <= 0 ? 'today' : d + 'd ago';
const tooOld = j => S.age !== '' && ageDays(j.posted) > +S.age;

const fitClass = n => n == null ? 'lo' : n >= 75 ? 'hi' : n >= 50 ? 'mid' : 'lo';
const statusLabel = s => (STATUSES.find(x => x[0] === s) || [s, s])[1];

// ---------- state ----------
async function refresh() {
  try {
    const st = await api('/api/state');
    const prevTasks = S.tasks;
    Object.assign(S, st);
    renderTasks();
    renderList();
    // re-render detail if a task for the selected job just finished
    const finished = st.tasks.find(t => t.jobId === S.sel && t.status !== 'running' && t.status !== 'queued'
      && prevTasks.some(p => p.id === t.id && (p.status === 'running' || p.status === 'queued')));
    if (finished || !$('#detail .dHead')) renderDetail();
    else updateTailorButton();
  } catch (e) {
    $('#taskBar').classList.remove('hidden');
    $('#taskBar').innerHTML = `<div class="task failed"><span class="st">Offline</span><span>Server is not running. Start it with start.bat.</span></div>`;
  }
  const busy = S.tasks.some(t => t.status === 'running' || t.status === 'queued');
  clearTimeout(refresh.t);
  refresh.t = setTimeout(refresh, busy ? 2500 : 15000);
}

function renderTasks() {
  const bar = $('#taskBar');
  const recent = S.tasks.filter(t => t.status === 'running' || t.status === 'queued'
    || (t.finishedAt && Date.now() - t.finishedAt < 60000));
  bar.classList.toggle('hidden', !recent.length);
  bar.innerHTML = recent.slice(0, 4).map(t => {
    let info = '';
    if (t.status === 'running') info = `<span class="muted">${Math.round((Date.now() - t.startedAt) / 1000)}s — searches can take several minutes</span>`;
    if (t.status === 'done' && t.kind === 'resume') info = `<span class="muted">${t.result.updated ? 'resume updated from the PDF' : esc(t.result.reason || 'no changes')}</span>`;
    if (t.status === 'done' && t.kind === 'people') info = `<span class="muted">hiring ${t.result.hiring}, referrers ${t.result.referrers}, referral program: ${esc(t.result.referral)}</span>`;
    if (t.status === 'done' && t.kind === 'refresh') info = `<span class="muted">fit now ${t.result.job.fitScore ?? '–'}</span>`;
    if (t.status === 'done' && t.kind === 'search') info = `<span class="muted">found ${t.result.found}, new ${t.result.added}${t.result.tooOld ? ', skipped ' + t.result.tooOld + ' too old' : ''}${t.result.notes ? ' — ' + esc(t.result.notes) : ''}</span>`;
    if (t.status === 'done' && t.kind === 'apply') {
      const r = { ...t.result, ...(S.fillReports[t.id] || {}) };
      info = r.filled == null ? '<span class="muted">answers ready, filling the page…</span>'
        : `<span class="muted">filled ${r.filled} of ${r.total} fields${r.uploaded ? `, attached ${r.uploaded} file(s)` : ''} — check and submit yourself${r.left.length ? '. Left for you: ' + esc(r.left.join('; ')) : ''}</span>`;
    }
    if (t.status === 'failed') info =`<span>${esc(t.error)}</span>`;
    const st = t.status === 'running' ? '<span class="spinner"></span>Working' : t.status === 'queued' ? 'Queued'
      : t.status === 'done' ? 'Done' : t.status === 'cancelled' ? 'Stopped' : 'Failed';
    const stop = t.status === 'running' || t.status === 'queued' ? `<button class="ghost taskStop" data-task="${t.id}">Stop</button>` : '';
    return `<div class="task ${t.status}"><span class="st">${st}</span><span>${esc(t.label)}</span>${info}${stop}</div>`;
  }).join('');
  $('#searchBtn').disabled = S.tasks.some(t => t.kind === 'search' && (t.status === 'running' || t.status === 'queued'));
}

function filtered() {
  let list = S.jobs.slice();
  if (S.filter === 'active') list = list.filter(j => !['rejected', 'skip'].includes(j.status));
  else if (S.filter !== 'all') list = list.filter(j => j.status === S.filter);
  list = list.filter(j => !tooOld(j));
  const by = {
    fit: (a, b) => (b.fitScore ?? -1) - (a.fitScore ?? -1),
    new: (a, b) => b.foundAt.localeCompare(a.foundAt),
    company: (a, b) => a.company.localeCompare(b.company),
  }[S.sort];
  return list.sort(by);
}

function renderFilters() {
  const counts = S.jobs.reduce((m, j) => (m[j.status] = (m[j.status] || 0) + 1, m), {});
  const opts = [['active', 'Active'], ...STATUSES.filter(([k]) => counts[k]), ['all', 'All']];
  $('#statusFilters').innerHTML = opts.map(([k, l]) =>
    `<button class="chip ${S.filter === k ? 'on' : ''}" data-f="${k}">${l}${counts[k] ? ' ' + counts[k] : ''}</button>`).join('');
}

function renderList() {
  renderFilters();
  const list = filtered();
  const el = $('#jobList');
  if (!list.length) {
    const hidden = S.jobs.filter(tooOld).length;
    el.innerHTML = `<div class="listEmpty">${S.jobs.length ? 'Nothing in this filter.' + (hidden ? ` ${hidden} older posting(s) hidden — change the “Posted” filter.` : '') :
      S.hasResume ? 'No jobs yet. Press “Find new jobs” or paste a link above.' : 'Start with the “Resume &amp; profile” tab.'}</div>`;
    return;
  }
  el.innerHTML = list.map(j => `
    <div class="jobRow ${j.id === S.sel ? 'sel' : ''}" data-id="${j.id}">
      <div class="t">${esc(j.title)}</div>
      <div class="fit ${fitClass(j.fitScore)}">${j.fitScore ?? '–'}</div>
      <div class="c">${esc(j.company)}${j.remote ? ' · ' + esc(j.remote) : ''}</div>
      <div class="badges">
        ${j.status === 'new' ? '<span class="badge new">new</span>' : `<span class="badge">${statusLabel(j.status)}</span>`}
        <span class="badge ${ageDays(j.posted) == null ? 'warn' : ''}" title="${esc(j.posted ? 'Posted ' + j.posted : 'Posting date unknown')}">${ageText(ageDays(j.posted))}</span>
        ${salaryBadge(j)}
        ${j.status === 'applied' && j.appliedAt ? `<span class="badge" title="Applied ${esc(j.appliedAt.slice(0, 10))}">applied ${ageText(ageDays(j.appliedAt))}</span>` : ''}
        ${j.hasDocs ? '<span class="badge">CV ready</span>' : ''}
        ${j.source ? `<span class="badge">${esc(j.source.length > 22 ? j.source.slice(0, 21) + "…" : j.source)}</span>` : ''}
      </div>
    </div>`).join('');
}

// ---------- salary: the posting's own range, or Claude's market estimate when the posting has no figure ----------
const statedSalary = j => /\d/.test(j.salary || '');

function salaryBadge(j) {
  const s = statedSalary(j) ? j.salary : j.salaryEstimate ? '≈ ' + j.salaryEstimate.range : '';
  if (!s) return '';
  const tip = statedSalary(j) ? 'Pay range from the posting' : 'Estimate from market data — the posting gives no figure';
  return `<span class="badge ${statedSalary(j) ? 'pay' : ''}" title="${esc(tip + ': ' + s)}">${esc(s.length > 26 ? s.slice(0, 25) + '…' : s)}</span>`;
}

function salaryHtml(j) {
  if (statedSalary(j)) {
    return `<span class="salLabel">Pay range (from the posting)</span><div class="salRange">${esc(j.salary)}</div>`;
  }
  const said = j.salary ? `<div class="muted salNote">Posting says: “${esc(j.salary)}”</div>` : '';
  const e = j.salaryEstimate;
  if (!e) {
    return `<span class="salLabel">Pay</span><div class="muted">Not stated in the posting. Press “↻ Refresh” to get a market estimate.</div>${said}`;
  }
  const src = e.sources.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(hostOf(u) || 'source ' + (i + 1))}</a>`).join(', ');
  return `<span class="salLabel">Expected pay <span class="badge warn">estimate</span></span>
    <div class="salRange">≈ ${esc(e.range)}</div>
    ${e.basis ? `<div class="muted salNote">${esc(e.basis)}</div>` : ''}
    ${src ? `<div class="muted salNote">Data: ${src}</div>` : ''}${said}`;
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

// ---------- detail ----------
function updateTailorButton() {
  const b = $('#detail .dTailor');
  if (!b) return;
  const busy = S.tasks.some(t => t.jobId === S.sel && t.kind !== 'people' && (t.status === 'running' || t.status === 'queued'));
  const job = S.jobs.find(j => j.id === S.sel);
  const pb = $('#detail .dPeople');
  if (pb) {
    const st = (S.tasks.find(t => t.jobId === S.sel && t.kind === 'people' && (t.status === 'running' || t.status === 'queued')) || {}).status;
    pb.disabled = !!st;
    pb.innerHTML = st === 'running' ? '<span class="spinner"></span>Searching…' : st === 'queued' ? 'Queued…'
      : job && job.people ? '↻ Search again' : 'Find HR &amp; referrals';
  }
  b.disabled = busy;
  b.textContent = busy ? 'Working…' : job && job.hasDocs ? 'Regenerate' : 'Generate';
  const r = $('#detail .dRefresh');
  if (r) {
    const refreshing = S.tasks.some(t => t.jobId === S.sel && t.kind === 'refresh' && (t.status === 'running' || t.status === 'queued'));
    r.disabled = busy;
    r.innerHTML = refreshing ? '<span class="spinner"></span>Refreshing…' : '↻ Refresh';
  }
  const filling = S.tasks.some(t => t.jobId === S.sel && t.kind === 'apply' && (t.status === 'running' || t.status === 'queued'));
  const auto = S.autoApply && S.autoApply.jobId === S.sel ? S.autoApply.step : '';
  const a = $('#detail .dApply'), f = $('#detail .dAutoApply');
  if (a) { a.disabled = filling || !!auto; a.innerHTML = filling && !auto ? '<span class="spinner"></span>Filling…' : 'Open &amp; fill form'; }
  if (f) { f.disabled = busy || !!auto; f.innerHTML = auto ? `<span class="spinner"></span>${auto}` : 'Try to auto apply'; }
}

// Which browser this page is open in, so the form opens in the same one (Brave hides its name from the user agent).
async function browserKind() {
  try { if (navigator.brave && await navigator.brave.isBrave()) return 'brave'; } catch (_) { /* not Brave */ }
  const ua = navigator.userAgent;
  const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map(b => b.brand).join(' ');
  if (/Edg\//.test(ua) || /Microsoft Edge/.test(brands)) return 'edge';
  if (/OPR\/|Opera/.test(ua + brands)) return 'opera';
  if (/YaBrowser|Yandex/.test(ua + brands)) return 'yandex';
  if (/Vivaldi/.test(ua + brands)) return 'vivaldi';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  return '';
}

// Starts form filling. The tailored CV is rendered here (same look as the .pdf button) and uploaded as the resume file.
async function applyJob(job, open, submit = false) {
  // Auto apply may get here after you switched to another job while the CV was being made.
  const url = S.sel === job.id ? $('#detail .dApplyUrl').value.trim() : job.applyUrl || '';
  if (url !== (job.applyUrl || '')) {
    await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { applyUrl: url } });
    job.applyUrl = url;
  }
  let html = '';
  if (job.hasDocs) {
    const d = await api(`/api/jobs/${job.id}/docs`);
    if (d.cv) html = cvPage(d.cv).html;
  }
  if (hasExtension()) return applyWithExtension(job, open, url, html, submit);
  const task = await api(`/api/jobs/${job.id}/apply`, { method: 'POST', body: { open, url, html, submit, browser: await browserKind() } });
  refresh();
  return task;
}

// "Try to auto apply": makes the tailored CV first if there is none, then opens the application page and fills it.
// Throws with the reason when any step fails.
async function autoApply(job) {
  const step = s => { S.autoApply = { jobId: job.id, step: s }; updateTailorButton(); };
  try {
    if (!job.hasDocs) {
      step('Making CV…');
      const task = await api(`/api/jobs/${job.id}/tailor`, { method: 'POST', body: { extra: $('#detail .dExtra').value, lang: $('#detail .dLang').value } });
      refresh();
      const done = await waitTask(task.id);
      if (!done || done.status === 'cancelled') return;
      if (done.status !== 'done') throw new Error('Could not make the CV: ' + (done.error || 'unknown error'));
      job.hasDocs = true;
    }
    step('Filling…');
    let report;
    if (hasExtension()) {
      report = await applyJob(job, true, true);
    } else {
      const done = await waitTask((await applyJob(job, true, true)).id);
      if (!done || done.status === 'cancelled') return;
      if (done.status !== 'done') throw new Error(done.error || 'Filling failed');
      report = done.result;
    }
    if (report && report.filled === 0) throw new Error('The page opened, but no field could be filled. Fill the form yourself.');
    const s = report && report.submit;
    if (!s) throw new Error('The form was filled, but Send was not pressed.');
    if (!s.clicked) {
      throw new Error(s.invalid && s.invalid.length ? 'Not sent — these fields are still empty or wrong: ' + s.invalid.join('; ')
        : 'Not sent — ' + (s.reason || 'could not press Send.'));
    }
    if (!s.check || !(s.check.success || !s.check.stillForm)) {
      const errs = s.check && s.check.errors.length ? ' The page says: ' + s.check.errors.join('; ') : '';
      throw new Error(`Pressed “${s.button}”, but the page did not confirm the application was sent.${errs} Check the page.`);
    }
    await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { status: 'applied' } });
    alert(`Sent: ${job.company} — ${job.title}. Status set to Applied.`);
  } finally {
    S.autoApply = null;
    updateTailorButton();
    refresh();
  }
}

// ---------- browser extension (folder "extension"): fills forms in this browser, with your own logins ----------
const hasExtension = () => !!document.documentElement.dataset.jhExtension;

function ext(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const on = e => {
      if (e.source !== window || !e.data || e.data.jh !== 'res' || e.data.id !== id) return;
      window.removeEventListener('message', on);
      if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data);
    };
    window.addEventListener('message', on);
    window.postMessage({ jh: 'req', id, cmd, args }, location.origin);
  });
}

async function waitTask(id) {
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    const t = (await api('/api/state')).tasks.find(x => x.id === id);
    if (!t || !['queued', 'running'].includes(t.status)) return t;
  }
}

async function pdfBase64(jobId, name) {
  const r = await fetch(`/api/jobs/${jobId}/file?name=${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error('Could not get ' + name);
  const bytes = new Uint8Array(await r.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

S.fillReports = {};
async function applyWithExtension(job, open, url, html, submit) {
  let tab;
  if (open) {
    const target = url || job.applyUrl || job.url;
    if (!target) throw new Error('This job has no link to open');
    tab = await ext('open', { url: target });
  } else {
    tab = await ext('lastTab');
  }
  const { fields } = await ext('collect', { tabId: tab.tabId });
  if (!fields.length) throw new Error('No form fields on this page. If the form is on another page, paste its link into “Application form link” and try again.');
  const task = await api(`/api/jobs/${job.id}/answers`, { method: 'POST', body: { fields, html, submit } });
  refresh();
  const done = await waitTask(task.id);
  if (!done || done.status === 'cancelled') return;
  if (done.status !== 'done') throw new Error(done.error || 'Filling failed');
  const r = done.result;
  const kind = new Map(fields.map(f => [f.id, f.kind]));
  const files = [];
  for (const a of r.answers) {
    if (kind.get(a.id) === 'file' && r.files[a.value]) files.push({ id: a.id, name: r.files[a.value], type: 'application/pdf', b64: await pdfBase64(job.id, r.files[a.value]) });
  }
  S.fillReports[task.id] = await ext('fill', { tabId: tab.tabId, answers: r.answers.filter(a => kind.get(a.id) !== 'file'), files });
  renderTasks();
  const report = { ...r, ...S.fillReports[task.id] };
  if (submit && report.filled) report.submit = await ext('submit', { tabId: tab.tabId });
  return report;
}

async function renderDetail() {
  const pane = $('#detail');
  const job = S.jobs.find(j => j.id === S.sel);
  if (!job) {
    pane.innerHTML = `<div class="empty">Select a job on the left.<br><span class="muted">New here? Fill in “Resume &amp; profile” first, then press “Find new jobs”.</span></div>`;
    return;
  }
  // Don't wipe what you're typing when a background task finishes.
  const keepNotesFocus = document.activeElement && ['dNotes', 'dSkipReason'].some(c => document.activeElement.classList.contains(c));
  if (keepNotesFocus) return;
  pane.innerHTML = '';
  pane.append($('#detailTpl').content.cloneNode(true));
  $('.dTitle', pane).textContent = job.title;
  $('.dCompany', pane).textContent = job.company;
  $('.fitBig', pane).innerHTML = `<span class="fit ${fitClass(job.fitScore)}">${job.fitScore ?? '–'}</span><small>fit</small>`;
  $('.dMeta', pane).innerHTML = [job.remote, job.location, job.language && 'lang: ' + job.language,
    job.posted ? `posted ${job.posted} (${ageText(ageDays(job.posted))})` : 'posting date unknown', job.source, 'found ' + job.foundAt.slice(0, 10),
    job.refreshedAt && 'refreshed ' + job.refreshedAt.slice(0, 10),
    job.appliedAt && `applied ${job.appliedAt.slice(0, 10)} (${ageText(ageDays(job.appliedAt))})`]
    .filter(Boolean).map(x => `<span class="badge">${esc(x)}</span>`).join('');
  $('.dSalary', pane).innerHTML = salaryHtml(job);
  $('.dSummary', pane).textContent = job.summary;
  $('.dReason', pane).textContent = job.fitReason;
  const ev = document.createElement('p');
  ev.className = 'dEvidence';
  ev.innerHTML = job.locationEvidence
    ? `<span class="muted">From the posting:</span> “${esc(job.locationEvidence)}”`
    : `<span class="badge warn">Location not confirmed</span> <span class="muted">Check the posting before applying.</span>`;
  $('.dReason', pane).after(ev);
  if (job.fitBreakdown) {
    const bd = document.createElement('div');
    bd.className = 'breakdown';
    bd.innerHTML = job.fitBreakdown.map(b => {
      const pct = b.max ? Math.round(b.points / b.max * 100) : 0;
      return `<div class="bdRow">
        <div class="bdHead"><span>${esc(b.label)}</span><span class="bdPts ${fitClass(pct)}">${b.points} / ${b.max}</span></div>
        <div class="bdBar"><span class="${fitClass(pct)}" style="width:${pct}%"></span></div>
        <div class="bdNote muted">${esc(b.note)}</div></div>`;
    }).join('');
    ev.after(collSection('fit', 'Fit breakdown', bd));
  }
  if (job.requirements && job.requirements.length) {
    const reqs = job.requirements;
    const have = reqs.filter(r => r.inResume);
    const miss = reqs.filter(r => !r.inResume).sort((a, b) => (a.importance === 'required' ? 0 : 1) - (b.importance === 'required' ? 0 : 1));
    const added = new Set(S.addedSkills || []);
    const rq = document.createElement('div');
    rq.className = 'reqBox';
    rq.innerHTML = `${miss.length ? `<div class="reqHead">Not in your resume</div>` : ''}
      ${miss.map(r => `<div class="req miss ${r.importance}">
          <span class="reqIcon">✕</span>
          <div><div>${esc(r.text)} <span class="badge">${r.importance === 'required' ? 'required' : 'nice to have'}</span></div>
          ${r.evidence ? `<div class="muted reqEv">${esc(r.evidence)}</div>` : ''}</div>
          ${added.has(r.text) ? '<span class="muted reqDone">added to profile ✓</span>'
            : `<button class="ghost reqAdd" data-skill="${esc(r.text)}" title="Adds it to your profile so Claude can use it in CVs and scoring">I have this</button>`}
        </div>`).join('')}
      ${have.length ? `<div class="reqHead">Covered by your resume</div>` : ''}
      ${have.map(r => `<div class="req have"><span class="reqIcon">✓</span>
          <div><div>${esc(r.text)}</div>${r.evidence ? `<div class="muted reqEv">${esc(r.evidence)}</div>` : ''}</div></div>`).join('')}`;
    (pane.querySelector('[data-coll="fit"]') || ev).after(collSection('reqs', 'Requirements vs your resume', rq,
      `<span class="reqCount bad">${miss.filter(r => r.importance === 'required').length} required missing</span>
       <span class="reqCount warn">${miss.filter(r => r.importance === 'nice').length} nice-to-have missing</span>
       <span class="reqCount ok">${have.length} covered</span>`));
  }
  const sel = $('.dStatus', pane);
  sel.innerHTML = STATUSES.map(([k, l]) => `<option value="${k}" ${k === job.status ? 'selected' : ''}>${l}</option>`).join('');
  renderSkip(pane, job);
  const link = $('.dLink', pane);
  if (job.url) link.href = job.url; else link.remove();
  $('.dNotes', pane).value = job.notes || '';
  $('.dApplyUrl', pane).value = job.applyUrl || '';
  $('.extHint', pane).textContent = hasExtension() ? 'Fills in this browser (extension connected).'
    : 'Opens a separate browser window. To fill in this browser with your own logins, install the extension from the “extension” folder (see README).';
  renderPeople(job);
  applyCollapsed(pane, job);
  updateTailorButton();
  await renderDocs(job);
}

// ---------- Skipped: ask why once; the reason goes to the profile ----------
function renderSkip(pane, job) {
  $('.skipBox', pane).classList.toggle('hidden', job.status !== 'skip' || !!job.skipReason);
  const done = $('.skipDone', pane);
  done.classList.toggle('hidden', !job.skipReason);
  done.textContent = job.skipReason ? `Skipped: ${job.skipReason} (added to your profile)` : '';
}

async function saveSkipReason(pane) {
  const input = $('.dSkipReason', pane);
  const reason = input.value.trim();
  if (!reason) return;
  const j = await api(`/api/jobs/${S.sel}`, { method: 'PATCH', body: { skipReason: reason } });
  const job = S.jobs.find(x => x.id === S.sel);
  if (job) { job.skipReason = j.skipReason; renderSkip(pane, job); }
}

// ---------- collapsible blocks in the job view; which ones are folded is remembered for every job ----------
S.collapsed = new Set();
try { S.collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]')); } catch (_) { /* storage blocked */ }

function setCollapsed(key, on) {
  if (on) S.collapsed.add(key); else S.collapsed.delete(key);
  try { localStorage.setItem('collapsed', JSON.stringify([...S.collapsed])); } catch (_) { /* storage blocked */ }
}

// Same markup as the blocks in index.html: <section data-coll> with a .cHead header, then the block itself.
// extra: HTML shown in the header after the hint (stays visible when folded).
function collSection(key, title, body, extra = '') {
  const sec = document.createElement('section');
  sec.dataset.coll = key;
  sec.innerHTML = `<div class="cHead"><span class="cArrow">▾</span>${esc(title)}<span class="cHint"></span>${extra}</div>`;
  sec.append(body);
  return sec;
}

// The hint stays visible in the header, so a folded block still shows the gist.
function collapseHint(key, job) {
  if (key === 'salary') return statedSalary(job) ? job.salary : job.salaryEstimate ? '≈ ' + job.salaryEstimate.range : '';
  if (key === 'fit') return job.fitScore != null ? job.fitScore + ' / 100' : '';
  if (key === 'notes') return (job.notes || '').replace(/\s+/g, ' ').slice(0, 80);
  if (key === 'apply') return job.applyUrl ? hostOf(job.applyUrl) : '';
  if (key === 'people' && job.people) {
    const p = job.people;
    return `${p.hiring.length} hiring · ${p.referrers.length} referrers · referral program: ${p.referralProgram.status}`;
  }
  if (key === 'docs') return job.hasDocs ? 'CV ready' : '';
  return '';
}

function applyCollapsed(pane, job) {
  pane.querySelectorAll('[data-coll]').forEach(box => {
    const key = box.dataset.coll;
    box.classList.toggle('collapsed', S.collapsed.has(key));
    const hint = box.querySelector(':scope > .cHead .cHint');
    if (hint) hint.textContent = collapseHint(key, job);
  });
}

// ---------- people: recruiter / hiring manager, referral program, 3 possible referrers ----------
const LOC_LABEL = {
  job_location: ['loc-job', 'job location', 'Works in the city / office of this job'],
  same_country: ['loc-country', 'same country', "Works in the job's country, another city"],
  other: ['loc-other', 'other location', 'Works elsewhere — may not be able to help with this opening'],
};
function locBadge(p) {
  const l = LOC_LABEL[p.locationMatch];
  return l ? `<span class="badge ${l[0]}" title="${l[2]}">${l[1]}</span>` : '';
}

function personHtml(p, i, group) {
  const links = [p.linkedin && `<a href="${esc(p.linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a>`,
    p.url && `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(hostOf(p.url) || 'page')} ↗</a>`].filter(Boolean).join(' · ');
  return `<div class="person">
    <div class="pHead"><strong>${esc(p.name)}</strong>
      <span class="badge conf-${p.confidence}" title="How sure Claude is they currently work there in this role">${p.confidence}</span>
      ${locBadge(p)}</div>
    <div class="muted pTitle">${esc(p.title)}${p.location ? ' · ' + esc(p.location) : ''}</div>
    ${p.why ? `<div class="pWhy">${esc(p.why)}</div>` : ''}
    ${links ? `<div class="pLinks">${links}</div>` : ''}
    ${p.message ? `<div class="pMsg"><div class="pMsgText">${esc(p.message)}</div>
      <button class="ghost pCopy" data-group="${group}" data-i="${i}" title="Copy the connection note">Copy message</button></div>` : ''}
  </div>`;
}

function renderPeople(job) {
  const body = $('#detail .peopleBody');
  if (!body) return;
  const p = job.people;
  if (!p) {
    body.innerHTML = `<p class="muted">Claude looks for the recruiter or hiring manager for this role (mostly on LinkedIn),
      checks whether ${esc(job.company || 'the company')} has a referral program and picks 3 employees you could ask for a referral,
      with a ready connection note for each. Takes 2–5 minutes.</p>`;
    return;
  }
  const rp = p.referralProgram;
  const rpLabel = { yes: 'Has a referral program', no: 'No referral program found', unknown: 'Referral program: unknown' }[rp.status];
  const rpSrc = rp.sources.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(hostOf(u) || 'source ' + (i + 1))}</a>`).join(', ');
  const group = (title, list, key, empty) => `<div class="reqHead">${title}</div>
    ${list.length ? `<div class="people">${list.map((x, i) => personHtml(x, i, key)).join('')}</div>` : `<p class="muted">${empty}</p>`}`;
  body.innerHTML = `
    ${group('Hiring for this role', p.hiring, 'hiring', 'Nobody found. Try the company page on LinkedIn → People → search “recruiter”.')}
    <div class="refProg ref-${rp.status}"><strong>${rpLabel}</strong>
      ${rp.details ? `<div class="muted salNote">${esc(rp.details)}</div>` : ''}
      ${rpSrc ? `<div class="muted salNote">Sources: ${rpSrc}</div>` : ''}</div>
    ${group('Could refer you', p.referrers, 'referrers', 'Nobody found.')}
    <p class="muted salNote">${p.notes ? esc(p.notes) + ' · ' : ''}Found ${esc(p.foundAt.slice(0, 10))}. Check each profile before writing — Claude can be wrong about who still works there.</p>`;
}

async function renderDocs(job) {
  const body = $('#detail .docsBody');
  if (!body) return;
  if (!job.hasDocs) {
    body.innerHTML = `<p class="muted">Press “Generate” to get a resume tailored to this posting and a cover letter. Takes 1–3 minutes.</p>`;
    return;
  }
  const d = await api(`/api/jobs/${job.id}/docs`);
  S.docs = d;
  const tab = S.docTab;
  const text = tab === 'cv' ? d.cv : d.coverLetter;
  const meta = d.meta || {};
  let content;
  if (tab === 'diff') {
    const { html, stats } = renderDiff(d.base, d.cv);
    content = `<div class="dfSummary">
        <span class="df-legend df-mod">~ rewritten ${stats.changed}</span>
        <span class="df-legend df-add">+ added ${stats.added}</span>
        <span class="df-legend df-del">− removed ${stats.removed}</span>
        <span class="df-legend df-move">↕ moved ${stats.moved}</span>
        <span class="muted">unchanged ${stats.same}</span>
        <span class="dfToggle">
          <button class="chip ${S.diffView !== 'inline' ? 'on' : ''}" data-dview="side">Side by side</button>
          <button class="chip ${S.diffView === 'inline' ? 'on' : ''}" data-dview="inline">Inline</button>
          <label><input type="checkbox" id="dfOnly" ${S.diffOnly ? 'checked' : ''}> only changes</label>
        </span>
      </div>
      ${meta.changes ? `<p class="muted dfWhy">${esc(meta.changes)}</p>` : ''}
      <div class="${S.diffOnly ? 'dfOnly' : ''}">${S.diffView === 'inline' ? html : renderSideBySide(d.base, d.cv)}</div>`;
  } else if (tab === 'info') {
    content = `<div class="metaList">
      <p><strong>What changed:</strong> ${esc(meta.changes || '—')}</p>
      <p><strong>ATS keywords covered:</strong><br>${(meta.keywords || []).map(k => `<span class="badge kw">${esc(k)}</span>`).join('') || '—'}</p>
      <p><strong>Requirements not clearly met:</strong><br>${(meta.missing || []).map(k => `<span class="badge kw">${esc(k)}</span>`).join('') || '—'}</p>
      <p><strong>Questions for you (answers go into the profile):</strong><br>${(meta.questions || []).map(k => `<span class="badge kw">${esc(k)}</span>`).join('') || '—'}</p>
      <p class="muted">Generated ${esc((meta.generatedAt || '').replace('T', ' ').slice(0, 16))}</p></div>`;
  } else if (S.editing) {
    content = `<textarea class="docEdit">${esc(text)}</textarea>`;
  } else {
    content = tab === 'cv' ? `<div class="cvPaper">${renderCv(text)}</div>` : `<div class="letter">${esc(text)}</div>`;
  }
  body.innerHTML = `
    <div class="docTabs">
      <button class="chip ${tab === 'cv' ? 'on' : ''}" data-doc="cv">CV</button>
      <button class="chip ${tab === 'letter' ? 'on' : ''}" data-doc="letter">Cover letter</button>
      <button class="chip ${tab === 'diff' ? 'on' : ''}" data-doc="diff">Changes vs base CV</button>
      <button class="chip ${tab === 'info' ? 'on' : ''}" data-doc="info">Keywords &amp; gaps</button>
      <span class="sp"></span>
      ${tab !== 'info' && tab !== 'diff' ? `
        <button data-act="edit">${S.editing ? 'Save' : 'Edit'}</button>
        <button data-act="copy">Copy</button>
        ${tab === 'cv' ? '<button data-act="pdf">.pdf</button><button data-act="download">.md</button><button data-act="print">Print</button>'
          : '<button data-act="download">.txt</button>'}` : ''}
    </div>${content}`;
}

function download(name, text) {
  const a = document.createElement('a');
  const type = name.endsWith('.txt') ? 'text/plain' : 'text/markdown';
  // BOM so Notepad/Word open non-ASCII text (e.g. Cyrillic) as UTF-8.
  a.href = URL.createObjectURL(new Blob([String.fromCharCode(0xFEFF) + text], { type: type + ';charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Full standalone CV page, used for printing and for the PDF download.
function cvPage(text) {
  const name = ((text.match(/^#\s+(.+)$/m) || [, ''])[1].replace(/[*_]/g, '').trim()) || 'My';
  const title = `${name} CV`;
  return { title, html: `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>${CV_CSS}
    body{margin:0}.cv{max-width:none}
    @page{size:A4;margin:18mm 18mm 16mm;@top-left{content:''}@top-center{content:''}@top-right{content:''}@bottom-left{content:''}@bottom-center{content:''}@bottom-right{content:''}}
    .cv-section,.cv-job{break-after:avoid}.cv-list li{break-inside:avoid}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>${renderCv(text)}</body></html>` };
}

async function downloadPdf(text, btn) {
  const { title, html } = cvPage(text);
  btn.disabled = true; btn.textContent = 'Making PDF…';
  try {
    const r = await fetch('/api/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await r.blob());
    a.download = title.replace(/[\\/:*?"<>|]+/g, '_') + '.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) { alert('PDF export failed: ' + err.message); }
  btn.disabled = false; btn.textContent = '.pdf';
}

function printCv(text) {
  const { title, html } = cvPage(text);
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
  // Chrome names the saved PDF after the page title; set it again after write() so it is never empty.
  w.document.title = title;
  w.focus();
  setTimeout(() => w.print(), 300);
}

// ---------- events ----------
document.addEventListener('click', e => {
  const mk = e.target.closest('.sx-mk');
  if (!mk) return;
  e.preventDefault();
  const row = document.getElementById('sx' + mk.dataset.row);
  const sc = mk.closest('.sx').querySelector('.sx-scroll');
  if (row && sc) sc.scrollTo({ top: row.offsetTop - sc.clientHeight / 3, behavior: 'smooth' });
});

document.addEventListener('click', e => {
  if (e.target.closest('button, a, input, textarea, select')) return;
  const head = e.target.closest('[data-coll] > .cHead');
  if (!head) return;
  const box = head.parentElement;
  setCollapsed(box.dataset.coll, box.classList.toggle('collapsed'));
});

document.addEventListener('click', async e => {
  const t = e.target.closest('button, .jobRow');
  if (!t) return;
  const job = S.jobs.find(j => j.id === S.sel);

  if (t.classList.contains('taskStop')) {
    t.disabled = true; t.textContent = 'Stopping…';
    try { await api(`/api/tasks/${t.dataset.task}/cancel`, { method: 'POST' }); } catch (err) { alert(err.message); }
    refresh();
  } else if (t.classList.contains('tab')) {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === t));
    $('#viewJobs').classList.toggle('hidden', t.dataset.view !== 'jobs');
    $('#viewResume').classList.toggle('hidden', t.dataset.view !== 'resume');
    $('#viewSources').classList.toggle('hidden', t.dataset.view !== 'sources');
    $('#viewSettings').classList.toggle('hidden', t.dataset.view !== 'settings');
    if (t.dataset.view === 'resume') loadTexts();
    if (t.dataset.view === 'sources') loadSources();
    if (t.dataset.view === 'settings') loadSettings();
  } else if (t.classList.contains('setPreset')) {
    applyPreset(t.dataset.preset);
  } else if (t.id === 'saveSettings') {
    saveSettings(collectSettings());
  } else if (t.id === 'saveRaw') {
    let obj;
    try { obj = JSON.parse($('#rawConfig').value); } catch (err) { return setMsg('Not valid JSON: ' + err.message, true); }
    saveSettings(obj);
  } else if (t.id === 'resetSettings') {
    fillSettings(SET.cfg); setMsg('');
  } else if (t.id === 'testClaude') {
    t.disabled = true; $('#testClaudeMsg').textContent = 'Starting claude…';
    try {
      const r = await api('/api/settings/test-claude', { method: 'POST' });
      $('#testClaudeMsg').textContent = r.ok ? `OK: ${r.version}` : `Failed (${r.cmd}): ${r.error}`;
      $('#testClaudeMsg').className = r.ok ? 'okText' : 'errText';
    } catch (err) { $('#testClaudeMsg').textContent = err.message; $('#testClaudeMsg').className = 'errText'; }
    t.disabled = false;
  } else if (t.id === 'saveFilter') {
    const f = await api('/api/sources/filter', { method: 'PUT',
      body: { include: $('#filterInclude').value, exclude: $('#filterExclude').value } });
    $('#filterInclude').value = f.include.join(', ');
    $('#filterExclude').value = f.exclude.join(', ');
    $('#filterMsg').textContent = 'Saved ' + new Date().toLocaleTimeString();
  } else if (t.classList.contains('srcDel')) {
    await api(`/api/sources/${t.dataset.id}`, { method: 'DELETE' }); loadSources();
  } else if (t.id === 'searchSourcesBtn') {
    if (!S.hasResume) return alert('Fill in your resume first (Resume & profile tab).');
    try { await api('/api/search', { method: 'POST', body: { maxAgeDays: +S.searchAge, sourcesOnly: true } }); }
    catch (err) { return alert(err.message); }
    refresh();
  } else if (t.classList.contains('jobRow')) {
    S.sel = t.dataset.id; S.editing = false; S.docTab = 'cv';
    renderList(); renderDetail();
  } else if (t.dataset.f) {
    S.filter = t.dataset.f; renderList();
  } else if (t.id === 'searchBtn') {
    if (!S.hasResume) return alert('Fill in your resume first (Resume & profile tab).');
    await api('/api/search', { method: 'POST', body: { maxAgeDays: +S.searchAge } }); refresh();
  } else if (t.classList.contains('dTailor')) {
    if (job.hasDocs && !confirm('Regenerate? Your edits to the current CV and letter will be replaced.')) return;
    try {
      await api(`/api/jobs/${job.id}/tailor`, { method: 'POST', body: { extra: $('#detail .dExtra').value, lang: $('#detail .dLang').value } });
      S.docTab = 'cv'; S.editing = false; refresh();
    } catch (err) { alert(err.message); }
  } else if (t.classList.contains('dApply')) {
    t.disabled = true;
    try { await applyJob(job, true); } catch (err) { alert(err.message); }
    updateTailorButton();
  } else if (t.classList.contains('dAutoApply')) {
    try { await autoApply(job); } catch (err) { alert('Auto apply failed: ' + err.message); }
  } else if (t.classList.contains('dPeople')) {
    try {
      await api(`/api/jobs/${job.id}/people`, { method: 'POST' });
      refresh();
    } catch (err) { alert(err.message); }
  } else if (t.classList.contains('pCopy')) {
    const p = job.people && job.people[t.dataset.group][+t.dataset.i];
    if (!p) return;
    await navigator.clipboard.writeText(p.message);
    t.textContent = 'Copied'; setTimeout(() => t.textContent = 'Copy message', 1200);
  } else if (t.classList.contains('dRefresh')) {
    try {
      await api(`/api/jobs/${job.id}/refresh`, { method: 'POST' });
      refresh();
    } catch (err) { alert(err.message); }
  } else if (t.classList.contains('dDelete')) {
    if (!confirm(`Delete “${job.title}” and its documents?`)) return;
    await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
    S.sel = null; refresh(); renderDetail();
  } else if (t.classList.contains('dSkipSave')) {
    await saveSkipReason($('#detail'));
  } else if (t.classList.contains('reqAdd')) {
    await api('/api/profile/skill', { method: 'POST', body: { text: t.dataset.skill } });
    (S.addedSkills = S.addedSkills || []).push(t.dataset.skill);
    t.outerHTML = '<span class="muted reqDone">added to profile ✓</span>';
  } else if (t.dataset.dview) {
    S.diffView = t.dataset.dview; renderDocs(job);
  } else if (t.dataset.doc) {
    S.docTab = t.dataset.doc; S.editing = false; renderDocs(job);
  } else if (t.dataset.act) {
    const key = S.docTab === 'cv' ? 'cv' : 'coverLetter';
    const text = S.docs[key];
    if (t.dataset.act === 'copy') {
      await navigator.clipboard.writeText(text); t.textContent = 'Copied'; setTimeout(() => t.textContent = 'Copy', 1200);
    } else if (t.dataset.act === 'download') {
      const base = `${job.company}-${job.title}`.replace(/[^\w\-]+/g, '_').slice(0, 60);
      download(S.docTab === 'cv' ? `CV_${base}.md` : `CoverLetter_${base}.txt`, text);
    } else if (t.dataset.act === 'print') {
      printCv(text);
    } else if (t.dataset.act === 'pdf') {
      await downloadPdf(text, t);
    } else if (t.dataset.act === 'edit') {
      if (S.editing) {
        const val = $('#detail .docEdit').value;
        await api(`/api/jobs/${job.id}/docs`, { method: 'PUT', body: { [key]: val } });
      }
      S.editing = !S.editing; renderDocs(job);
    }
  } else if (t.id === 'syncResume') {
    await api('/api/resume/sync', { method: 'POST' });
    refresh();
    const wait = setInterval(async () => {
      const busy = S.tasks.some(x => x.kind === 'resume' && (x.status === 'running' || x.status === 'queued'));
      if (!busy) { clearInterval(wait); loadTexts(); }
    }, 3000);
  } else if (t.id === 'restartBtn') {
    const busy = S.tasks.some(x => x.status === 'running' || x.status === 'queued');
    if (!confirm(busy ? 'A task is running or queued — restarting will stop it. Restart anyway?' : 'Restart the server?')) return;
    try { await api('/api/restart', { method: 'POST' }); } catch (err) { return alert(err.message); }
    t.disabled = true; t.textContent = 'Restarting…';
    // Wait for the old server to go down, then reload once the new one answers.
    const started = Date.now();
    setTimeout(function wait() {
      fetch('/api/state', { cache: 'no-store' }).then(r => r.ok && location.reload(), () => {})
        .finally(() => { if (Date.now() - started < 60000) setTimeout(wait, 1000); });
    }, 1500);
  } else if (t.id === 'saveTexts') {
    const candidate = { livesIn: $('#candLivesIn').value, timezone: $('#candTimezone').value, currency: $('#candCurrency').value };
    try {
      await api('/api/texts', { method: 'PUT', body: { resume: $('#resumeText').value, profile: $('#profileText').value, candidate } });
    } catch (err) { $('#saveMsg').textContent = ''; return alert(err.message); }
    $('#saveMsg').textContent = 'Saved ' + new Date().toLocaleTimeString();
    refresh();
  }
});

document.addEventListener('change', async e => {
  if (e.target.id === 'dfOnly') {
    S.diffOnly = e.target.checked;
    const box = e.target.closest('.docsBody').querySelector('.df, .sx');
    if (box) box.parentElement.classList.toggle('dfOnly', S.diffOnly);
    return;
  }
  if (e.target.classList.contains('dStatus')) {
    const j = await api(`/api/jobs/${S.sel}`, { method: 'PATCH', body: { status: e.target.value } });
    const job = S.jobs.find(x => x.id === S.sel);
    if (job) { Object.assign(job, j); renderSkip($('#detail'), job); }
    if (j.status === 'skip' && !j.skipReason) $('#detail .dSkipReason').focus();
    refresh();
  } else if (e.target.id === 'searchAge') {
    S.searchAge = e.target.value;
    try { localStorage.setItem('searchAge', S.searchAge); } catch (_) { /* storage blocked */ }
  } else if (e.target.id === 'ageSel') {
    S.age = e.target.value;
    try { localStorage.setItem('ageFilter', S.age); } catch (_) { /* storage blocked */ }
    renderList();
  } else if (e.target.id === 'sortSel') {
    S.sort = e.target.value; renderList();
  } else if (e.target.classList.contains('srcOn')) {
    await api(`/api/sources/${e.target.dataset.id}`, { method: 'PATCH', body: { enabled: e.target.checked } });
    e.target.closest('.srcRow').classList.toggle('off', !e.target.checked);
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('dSkipReason')) saveSkipReason($('#detail'));
});

document.addEventListener('focusout', async e => {
  if (e.target.classList.contains('dNotes')) {
    await api(`/api/jobs/${S.sel}`, { method: 'PATCH', body: { notes: e.target.value } });
    const j = S.jobs.find(x => x.id === S.sel); if (j) j.notes = e.target.value;
    const hint = $('#detail [data-coll="notes"] .cHint'); if (hint && j) hint.textContent = collapseHint('notes', j);
  } else if (e.target.classList.contains('srcNote')) {
    await api(`/api/sources/${e.target.dataset.id}`, { method: 'PATCH', body: { note: e.target.value } });
  } else if (e.target.classList.contains('dApplyUrl')) {
    const j = S.jobs.find(x => x.id === S.sel);
    const url = e.target.value.trim();
    if (!j || url === (j.applyUrl || '')) return;
    await api(`/api/jobs/${S.sel}`, { method: 'PATCH', body: { applyUrl: url } });
    j.applyUrl = url;
  }
});

$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#addInput').value.trim();
  if (!input) return;
  if (!S.hasResume) return alert('Fill in your resume first (Resume & profile tab).');
  try { await api('/api/jobs', { method: 'POST', body: { input } }); $('#addInput').value = ''; refresh(); }
  catch (err) { alert(err.message); }
});

$('#sourceForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#sourceInput').value.trim();
  if (!input) return;
  try {
    await api('/api/sources', { method: 'POST', body: { input, note: $('#sourceNote').value } });
    $('#sourceInput').value = ''; $('#sourceNote').value = '';
    loadSources();
  } catch (err) { alert(err.message); }
});

async function loadSources() {
  const [list, f] = await Promise.all([api('/api/sources'), api('/api/sources/filter')]);
  $('#filterInclude').value = f.include.join(', ');
  $('#filterExclude').value = f.exclude.join(', ');
  $('#filterMsg').textContent = '';
  $('#searchSourcesBtn').disabled = !list.some(s => s.enabled);
  $('#sourceList').innerHTML = list.length ? list.map(s => `
    <div class="srcRow ${s.enabled ? '' : 'off'}">
      <input type="checkbox" class="srcOn" data-id="${esc(s.id)}" ${s.enabled ? 'checked' : ''} title="Use in search">
      <span class="badge">${s.kind === 'telegram' ? 'Telegram' : 'Site'}</span>
      <a class="srcName" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.url)}">${esc(s.kind === 'telegram' ? s.name : s.url)}</a>
      <input class="srcNote" data-id="${esc(s.id)}" value="${esc(s.note)}" placeholder="Note for Claude…" autocomplete="off">
      <button class="ghost srcDel" data-id="${esc(s.id)}" title="Remove">✕</button>
    </div>`).join('') : '<div class="empty muted">No sources yet. Add a job site or a Telegram channel above.</div>';
}

// ---------- Settings tab ----------
const ACTION_INFO = {
  search: ['Find new jobs', 'Long web search — the heaviest action'],
  analyze: ['Read a job / Refresh', 'Pasted links and ↻ Refresh, with salary estimate'],
  tailor: ['CV + cover letter', 'Writing quality matters most here'],
  people: ['HR & referrals', 'LinkedIn and web lookups'],
  apply: ['Fill application forms', 'Short answers to form fields'],
  resume: ['Resume from Google Drive', 'Copies the PDF text into Markdown'],
};
const MODEL_OPTS = [['', 'CLI default'], ['haiku', 'Haiku — fast, light'], ['sonnet', 'Sonnet — balanced'], ['opus', 'Opus — smartest']];
const MODEL_EXACT = [['claude-fable-5-1', 'Fable 5.1'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']];
const EFFORT_OPTS = [['', 'CLI default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const PRESETS = {
  economy: { all: ['haiku', 'low'] },
  balanced: { all: ['sonnet', 'medium'], apply: ['sonnet', 'low'], resume: ['sonnet', 'low'] },
  quality: { all: ['opus', 'high'], analyze: ['sonnet', 'medium'], apply: ['sonnet', 'low'], resume: ['sonnet', 'low'] },
  max: { all: ['opus', 'max'], apply: ['opus', 'high'], resume: ['opus', 'high'] },
};
const LANGS = [['English', 'English'], ['Russian', 'Русский'], ['Portuguese', 'Português'], ['Spanish', 'Español'],
  ['German', 'Deutsch'], ['French', 'Français'], ['Italian', 'Italiano'], ['Polish', 'Polski'], ['Ukrainian', 'Українська'],
  ['Dutch', 'Nederlands'], ['Turkish', 'Türkçe'], ['Japanese', '日本語'], ['Korean', '한국어'], ['Chinese', '中文']];
// Fills every .langSel under root; data-default adds a first "use the settings" option (value '').
function fillLangSelects(root) {
  root.querySelectorAll('.langSel').forEach(sel => {
    sel.innerHTML = (sel.dataset.default ? `<option value="">${esc(sel.dataset.default)}</option>` : '')
      + '<option value="auto">Same as the posting</option>'
      + LANGS.map(([v, l]) => `<option value="${v}">${esc(l === v ? l : `${l} (${v})`)}</option>`).join('');
  });
}
fillLangSelects(document);
fillLangSelects($('#detailTpl').content);
const SET = { cfg: null, actions: [] };
const known = v => MODEL_OPTS.concat(MODEL_EXACT).some(([k]) => k === v);
const getPath = (o, p) => p.split('.').reduce((x, k) => x == null ? x : x[k], o);
function setPath(o, p, v) {
  const ks = p.split('.'); const last = ks.pop();
  ks.reduce((x, k) => (x[k] = x[k] || {}), o)[last] = v;
}
function setMsg(text, err) {
  $('#settingsMsg').textContent = text;
  $('#settingsMsg').className = err ? 'errText' : 'muted';
}

function renderModelTable(cfg) {
  const opts = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
  $('#modelTable').innerHTML = `<div class="mRow mHead"><span>Action</span><span>Model</span><span>Effort</span><span>Timeout, min</span></div>`
    + SET.actions.map(a => {
      const m = cfg.models[a] || ''; const custom = !known(m);
      const [label, hint] = ACTION_INFO[a] || [a, ''];
      const timeout = a === 'search'
        ? `<input type="number" min="2" max="120" data-key="searchTimeoutMinutes" value="${esc(cfg.searchTimeoutMinutes)}">`
        : `<input type="number" min="1" max="120" class="setTo" data-a="${a}" value="${esc(cfg.timeouts[a] ?? '')}">`;
      return `<div class="mRow">
        <span><b>${esc(label)}</b><small class="muted">${esc(hint)}</small></span>
        <span class="mModel"><select class="setModel" data-a="${a}">${opts(MODEL_OPTS, m)}
            <optgroup label="Exact versions">${opts(MODEL_EXACT, m)}</optgroup>
            <option value="__custom" ${custom ? 'selected' : ''}>Custom…</option></select>
          <input class="setModelCustom ${custom ? '' : 'hidden'}" data-a="${a}" value="${custom ? esc(m) : ''}" placeholder="model name" autocomplete="off"></span>
        <span><select class="setEffort" data-a="${a}">${opts(EFFORT_OPTS, cfg.effort[a] || '')}</select></span>
        <span>${timeout}</span>
      </div>`;
    }).join('');
}

function fillSettings(cfg) {
  renderModelTable(cfg);
  document.querySelectorAll('#viewSettings [data-key]').forEach(el => {
    const v = getPath(cfg, el.dataset.key);
    if (el.type === 'checkbox') el.checked = !!v;
    else {
      // A value typed into config.json by hand that the list doesn't have.
      if (el.tagName === 'SELECT' && v && ![...el.options].some(o => o.value === v)) el.add(new Option(v, v));
      el.value = Array.isArray(v) ? v.join(', ') : (v ?? '');
    }
  });
  $('#rawConfig').value = JSON.stringify(cfg, null, 2);
}

function collectSettings() {
  const out = JSON.parse(JSON.stringify(SET.cfg));
  document.querySelectorAll('#viewSettings [data-key]').forEach(el => {
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
    setPath(out, el.dataset.key, v);
  });
  for (const a of SET.actions) {
    const sel = $(`.setModel[data-a="${a}"]`).value;
    out.models[a] = sel === '__custom' ? $(`.setModelCustom[data-a="${a}"]`).value.trim() : sel;
    out.effort[a] = $(`.setEffort[data-a="${a}"]`).value;
    const to = $(`.setTo[data-a="${a}"]`);
    if (to) out.timeouts[a] = Number(to.value);
  }
  return out;
}

function applyPreset(name) {
  const p = PRESETS[name];
  for (const a of SET.actions) {
    const [m, e] = p[a] || p.all;
    $(`.setModel[data-a="${a}"]`).value = m;
    $(`.setModelCustom[data-a="${a}"]`).classList.add('hidden');
    $(`.setEffort[data-a="${a}"]`).value = e;
  }
  setMsg(`Preset “${name}” applied — press Save settings to keep it.`);
}

async function saveSettings(obj) {
  try {
    const r = await api('/api/settings', { method: 'PUT', body: obj });
    SET.cfg = r.config;
    fillSettings(r.config);
    renderAutoNext(r.nextAutoSearchAt);
    setMsg('Saved ' + new Date().toLocaleTimeString() + (r.restart ? ' — the new port works after ↻ Restart' : ''));
  } catch (err) { setMsg(err.message, true); }
}

function renderAutoNext(at) {
  if (!at) { $('#autoNext').textContent = 'Auto search is off.'; return; }
  const min = Math.round((at - Date.now()) / 60000);
  $('#autoNext').textContent = min <= 1 ? 'Next auto search: within a minute.'
    : `Next auto search in ${min >= 60 ? Math.floor(min / 60) + ' h ' : ''}${min % 60} min (${new Date(at).toLocaleString()}).`;
}

async function loadUsage() {
  const u = await api('/api/usage?days=' + $('#usageDays').value);
  const rows = u.rows.sort((a, b) => b.costUsd - a.costUsd);
  if (!rows.length) { $('#usageTable').innerHTML = '<p class="muted">No Claude runs in this period yet.</p>'; return; }
  const sum = rows.reduce((t, r) => ({ runs: t.runs + r.runs, failed: t.failed + r.failed, costUsd: t.costUsd + r.costUsd }), { runs: 0, failed: 0, costUsd: 0 });
  const money = n => '$' + n.toFixed(2);
  $('#usageTable').innerHTML = `<table class="usage"><thead><tr><th>Action</th><th>Runs</th><th>Failed</th><th>Avg time</th><th>API value</th><th>Models</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc((ACTION_INFO[r.action] || [r.action])[0])}</td><td>${r.runs}</td><td>${r.failed || ''}</td>
      <td>${r.avgSec >= 60 ? Math.floor(r.avgSec / 60) + 'm ' + (r.avgSec % 60) + 's' : r.avgSec + 's'}</td><td>${money(r.costUsd)}</td>
      <td class="muted">${Object.entries(r.models).map(([m, n]) => `${esc(m)} ×${n}`).join(', ')}</td></tr>`).join('')}
    </tbody><tfoot><tr><td>Total</td><td>${sum.runs}</td><td>${sum.failed || ''}</td><td></td><td>${money(sum.costUsd)}</td><td></td></tr></tfoot></table>`;
}

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    SET.cfg = s.config; SET.actions = s.actions;
    fillSettings(s.config);
    renderAutoNext(s.nextAutoSearchAt);
    $('#browserList').innerHTML = s.browsers.map(b =>
      `<span class="badge ${b.path ? 'okBadge' : ''}" title="${esc(b.path || 'not found')}">${esc(b.name)}${b.path ? ' ✓' : ' —'}</span>`).join('')
      + `<span class="muted small">PDF: ${esc(s.pdfBrowser || 'no Edge / Chrome found')}</span>`;
    setMsg(s.supervised ? '' : 'Tip: start the app with start.bat so “↻ Restart” works.');
  } catch (err) { setMsg(err.message, true); }
  loadUsage().catch(() => {});
}

document.addEventListener('input', e => {
  if (!e.target.closest('#viewSettings') || e.target.id === 'rawConfig') return;
  if (e.target.classList.contains('setModel')) {
    $(`.setModelCustom[data-a="${e.target.dataset.a}"]`).classList.toggle('hidden', e.target.value !== '__custom');
  }
  if (e.target.id === 'usageDays') return loadUsage();
  setMsg('Unsaved changes');
});

async function loadTexts() {
  const t = await api('/api/texts');
  $('#resumeText').value = t.resume;
  $('#profileText').value = t.profile;
  $('#candLivesIn').value = t.candidate.livesIn;
  $('#candTimezone').value = t.candidate.timezone;
  $('#candCurrency').value = t.candidate.currency;
}

$('#ageSel').value = S.age;
$('#searchAge').value = S.searchAge;
refresh();
