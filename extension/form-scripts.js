// Page scripts shared by the browser extension and the app (lib/apply.js): find the form fields on a page
// and fill them. Each function runs inside the page and must be self-contained (no outside variables).
'use strict';

function collectFields(prefix) {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const shown = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && (r.width > 0 || r.height > 0);
  };
  const ownLabel = el => clean([
    ...[...(el.labels || [])].map(l => l.innerText),
    ...(el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => id && document.getElementById(id)?.innerText),
    el.getAttribute('aria-label'),
  ].filter(Boolean).join(' | '));
  // Question text around a field when it has no <label> (common in custom forms).
  const around = (el, stopAt) => {
    let p = el.parentElement;
    for (let i = 0; i < 5 && p && p !== document.body; i++, p = p.parentElement) {
      const legend = p.tagName === 'FIELDSET' && p.querySelector('legend');
      if (legend) return clean(legend.innerText);
      const t = clean(p.innerText);
      if (t && t !== stopAt) return t;
    }
    return '';
  };
  const fields = [];
  const groups = new Map();
  let n = 0;
  const els = document.querySelectorAll('input, textarea, select');
  for (const el of els) {
    const type = (el.type || '').toLowerCase();
    if (el.disabled || el.readOnly && type !== 'file' || ['hidden', 'submit', 'button', 'image', 'reset', 'password'].includes(type)) continue;
    const vis = type === 'file' || shown(el) || shown(el.labels && el.labels[0]) || shown(el.parentElement);
    if (!vis) continue;
    const required = el.required || el.getAttribute('aria-required') === 'true';
    if (type === 'radio' || type === 'checkbox') {
      const optLabel = ownLabel(el) || clean(el.nextSibling && el.nextSibling.textContent) || el.value;
      el.dataset.jhOpt = optLabel.slice(0, 200);
      const key = el.form && el.name ? el.name + '@' + type : el.name ? el.name + '#' + type : null;
      let g = key && groups.get(key);
      if (!g) {
        g = { id: prefix + '-' + (++n), kind: type === 'radio' ? 'radio' : 'checkbox', options: [], els: [], required };
        if (key) groups.set(key, g);
        fields.push(g);
      }
      g.els.push(el);
      g.options.push(el.dataset.jhOpt);
      g.required = g.required || required;
      el.dataset.jhId = g.id;
      continue;
    }
    const id = prefix + '-' + (++n);
    el.dataset.jhId = id;
    const f = { id, kind: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : type === 'file' ? 'file' : 'text',
      label: (ownLabel(el) || around(el)).slice(0, 300), name: el.name || el.id || '', required };
    if (f.kind === 'text' && type && type !== 'text') f.type = type;
    if (el.placeholder) f.placeholder = clean(el.placeholder).slice(0, 120);
    if (f.kind === 'select') f.options = [...el.options].map(o => clean(o.text)).filter(Boolean).slice(0, 80);
    if (f.kind === 'file') f.accept = el.accept || '';
    if (f.kind !== 'file' && el.value && f.kind !== 'select') f.current = String(el.value).slice(0, 200);
    fields.push(f);
  }
  return fields.map(f => {
    if (!f.els) return f;
    // A group's question: text around the whole group, or the option's own label for a lone checkbox.
    const { els, ...rest } = f;
    const label = f.kind === 'checkbox' && els.length === 1 ? f.options[0] : around(els[0], f.options[0]);
    return { ...rest, label: label.slice(0, 400), checked: els.filter(e => e.checked).map(e => e.dataset.jhOpt) };
  });
}

// files: [{ id, name, type, b64 }] — attached from the page itself (used by the extension).
function fillFields(answers, showBanner, files = []) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const mark = el => { el.style.outline = '2px solid #e0a020'; el.style.outlineOffset = '1px'; };
  const fire = el => ['input', 'change'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
  let filled = 0, uploaded = 0;
  for (const f of files) {
    const el = document.querySelector(`[data-jh-id="${f.id}"]`);
    if (!el) continue;
    const bytes = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], f.name, { type: f.type || 'application/pdf' }));
    el.files = dt.files;
    fire(el);
    mark(el.labels && el.labels[0] || el.parentElement || el);
    uploaded++;
  }
  for (const { id, value } of answers) {
    const els = [...document.querySelectorAll(`[data-jh-id="${id}"]`)];
    const el = els[0];
    if (!el || value == null || value === '') continue;
    const type = (el.type || '').toLowerCase();
    if (el.tagName === 'SELECT') {
      const opts = [...el.options];
      const o = opts.find(x => norm(x.text) === norm(value)) || opts.find(x => norm(x.value) === norm(value))
        || opts.find(x => norm(x.text).includes(norm(value)) && norm(value).length > 1);
      if (!o) continue;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, o.value);
      fire(el); mark(el); filled++;
    } else if (type === 'radio' || type === 'checkbox') {
      const wanted = String(value).split('\n').map(norm).filter(Boolean);
      const single = type === 'checkbox' && els.length === 1;
      let hit = false;
      for (const e of els) {
        const on = single ? ['true', 'yes'].includes(wanted[0]) : wanted.includes(norm(e.dataset.jhOpt));
        if (on && !e.checked) { e.click(); hit = true; }
        if (on) { mark(e.labels && e.labels[0] || e); hit = true; }
      }
      if (hit) filled++;
    } else if (type !== 'file') {
      if (el.value) continue; // never overwrite what is already there
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      el.focus();
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
      fire(el);
      el.dispatchEvent(new Event('blur'));
      mark(el); filled++;
    }
  }
  if (showBanner && !document.getElementById('jh-banner')) {
    const b = document.createElement('div');
    b.id = 'jh-banner';
    b.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;padding:12px 14px;background:#1d1c1a;'
      + 'color:#fff;font:14px/1.4 system-ui,sans-serif;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.3);cursor:pointer';
    b.textContent = 'Job Hunter filled the fields outlined in yellow. Check everything, fill what is left and press Submit yourself. (click to hide)';
    b.onclick = () => b.remove();
    document.body.appendChild(b);
  }
  return { filled, uploaded };
}

// "Try to auto apply": presses the form's Send/Submit button in this frame, unless required fields are still empty.
// Returns { skip } when this frame has no filled form, { clicked, button } or { clicked: false, invalid, reason }.
function submitForm() {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const shown = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const first = document.querySelector('[data-jh-id]');
  if (!first) return { skip: true };
  const root = first.closest('form') || document;
  const name = el => clean([...(el.labels || [])].map(l => l.innerText).join(' ') || el.getAttribute('aria-label')
    || el.placeholder || el.dataset.jhOpt || el.name || el.id).slice(0, 80);
  const invalid = [...new Set([...root.querySelectorAll('input, textarea, select')]
    .filter(el => el.type !== 'hidden' && !el.disabled && (el.willValidate && !el.checkValidity()
      || el.getAttribute('aria-required') === 'true' && !el.value && shown(el)))
    .map(name))];
  if (invalid.length) return { clicked: false, invalid };
  const text = el => clean(el.innerText || el.value || el.getAttribute('aria-label'));
  const bad = /cancel|back|draft|linkedin|indeed|upload|attach|sign in|log in|отмен|назад|загруз/i;
  const good = /submit|send|apply|отправ|откликн|подать/i;
  const btns = [...root.querySelectorAll('button, input[type=submit], [role=button]')]
    .filter(b => !b.disabled && shown(b) && !bad.test(text(b)));
  const btn = btns.find(b => b.type === 'submit' && good.test(text(b))) || btns.find(b => good.test(text(b)))
    || btns.find(b => b.type === 'submit' && b.closest('form'));
  if (!btn) return { clicked: false, invalid: [], reason: 'Could not find the Send / Submit button on the page.' };
  document.getElementById('jh-banner')?.remove();
  btn.click();
  return { clicked: true, button: text(btn).slice(0, 60) };
}

// Runs a few seconds after submitForm: did the page confirm the application was sent?
function submitCheck() {
  const body = document.body ? document.body.innerText : '';
  const success = /thank(s| you) for (applying|your (application|interest))|application (has been |was )?(received|submitted|sent)|successfully (submitted|applied|sent)|we('ve| have) received your|спасибо за (отклик|заявку)|(отклик|заявка|резюме) (успешно )?(отправлен|принят)/i.test(body);
  const errors = [...document.querySelectorAll('[role=alert], [aria-invalid=true]')]
    .map(el => String(el.innerText || el.getAttribute('aria-label') || el.name || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean).slice(0, 5);
  return { success, stillForm: !!document.querySelector('[data-jh-id]'), errors };
}

if (typeof module === 'object' && module.exports) module.exports = { collectFields, fillFields, submitForm, submitCheck };
