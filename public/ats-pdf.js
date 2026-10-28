'use strict';
// "ATS check": reads a PDF the way an applicant tracking system does (plain text layer, top to bottom) and runs
// parseability checks on it. Ported from Resume Matcher's services/ats_parse/checks.py
// (github.com/srbhr/Resume-Matcher, Apache-2.0). pdf.js is loaded from cdnjs on first use.

(function () {
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let lib = null;

  async function pdfjs() {
    if (!lib) {
      try {
        lib = await import(PDFJS + 'pdf.min.mjs');
      } catch (_) {
        throw new Error('Could not load the PDF reader (pdf.js from cdnjs). Check the internet connection.');
      }
      lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
    }
    return lib;
  }

  // Text runs on one line that sit close together become one box, so a gap between words never looks like a gutter.
  function lineBoxes(items, height) {
    const runs = items.filter(i => i.str.trim()).map(i => {
      const size = Math.hypot(i.transform[2], i.transform[3]) || i.height || 10;
      const x = i.transform[4];
      const y = height - i.transform[5];
      return { x0: x, x1: x + i.width, y0: y - size, y1: y, size, text: i.str };
    }).sort((a, b) => a.y1 - b.y1 || a.x0 - b.x0);
    const lines = [];
    for (const r of runs) {
      const line = lines.find(l => Math.abs(l.y1 - r.y1) < r.size * 0.5);
      if (line) line.runs.push(r); else lines.push({ y1: r.y1, runs: [r] });
    }
    const boxes = [];
    const textLines = [];
    for (const l of lines) {
      l.runs.sort((a, b) => a.x0 - b.x0);
      let box = null;
      for (const r of l.runs) {
        if (box && r.x0 - box.x1 < r.size * 2) {
          box.text += (r.x0 - box.x1 > r.size * 0.15 && !/\s$/.test(box.text) ? ' ' : '') + r.text;
          box.x1 = Math.max(box.x1, r.x1); box.y0 = Math.min(box.y0, r.y0); box.y1 = Math.max(box.y1, r.y1);
        } else {
          box = { ...r };
          boxes.push(box);
        }
      }
      textLines.push(l.runs.map(r => r.text).join(' ').replace(/\s+/g, ' ').trim());
    }
    return { boxes, text: textLines.join('\n') };
  }

  const unionLength = iv => {
    let total = 0, end = -Infinity;
    for (const [lo, hi] of iv.sort((a, b) => a[0] - b[0])) {
      if (hi > end) { total += hi - Math.max(lo, end); end = hi; }
    }
    return total;
  };

  // A vertical gutter with at least 3 text boxes on each side over 5% of the page = two columns.
  // Right-aligned dates beside job titles (narrow boxes flush to one edge) don't count.
  function hasColumns(boxes, width, height) {
    if (boxes.length < 4) return false;
    for (let step = 25; step <= 75; step += 2) {
      const gutter = width * step / 100;
      const blocked = boxes.filter(b => b.x0 < gutter && gutter < b.x1).map(b => [b.y0, b.y1]).sort((a, b) => a[0] - b[0]);
      const bands = [];
      let cursor = 0;
      for (const [lo, hi] of blocked) { if (lo > cursor) bands.push([cursor, lo]); cursor = Math.max(cursor, hi); }
      if (cursor < height) bands.push([cursor, height]);
      for (const [lo, hi] of bands) {
        const left = boxes.filter(b => b.x1 <= gutter && b.y1 > lo && b.y0 < hi);
        const right = boxes.filter(b => b.x0 >= gutter && b.y1 > lo && b.y0 < hi);
        if (Math.min(left.length, right.length) < 3) continue;
        const edge = Math.max(...right.map(b => b.x1));
        const flush = right.filter(b => edge - b.x1 <= 2).length;
        if (flush >= 0.8 * right.length && Math.max(...right.map(b => b.x1 - b.x0)) < 0.3 * width) continue;
        const cover = Math.min(unionLength(left.map(b => [Math.max(b.y0, lo), Math.min(b.y1, hi)])),
          unionLength(right.map(b => [Math.max(b.y0, lo), Math.min(b.y1, hi)]))) / height;
        if (cover >= 0.05) return true;
      }
    }
    return false;
  }

  const EMAIL_RE = /[\w.+-]{1,64}@[\w-]+(?:\.[\w-]+)+/;
  function hasPhone(text) {
    for (const m of text.matchAll(/\+?\d[\d\s().-]{5,}\d/g)) {
      const groups = m[0].match(/\d+/g);
      if (groups.join('').length >= 7 && !groups.every(g => /^(?:(?:19|20)\d{2}|0?[1-9]|1[0-2])$/.test(g))) return true;
    }
    return false;
  }

  const HEADINGS = {
    experience: ['experience', 'work experience', 'work history', 'employment', 'professional experience', 'опыт работы', 'опыт'],
    education: ['education', 'academic background', 'образование'],
    skills: ['skills', 'technical skills', 'core competencies', 'technologies', 'навыки', 'ключевые навыки'],
  };
  function findSections(text) {
    const lines = text.toLowerCase().split('\n').map(l => l.replace(/^[\s:•|]+|[\s:•|]+$/g, ''))
      .filter(l => l && l.split(/\s+/).length <= 6 && l.length <= 60);
    return Object.keys(HEADINGS).filter(kind => lines.some(l => HEADINGS[kind].some(n =>
      l.startsWith(n) && (l.length === n.length || /^\s*(?:[^\p{L}\p{N}\s]|and\s|и\s)/u.test(l.slice(n.length))))));
  }

  // Same whole-word match as lib/ats.js keywordInText.
  function keywordIn(kw, text) {
    const body = String(kw).trim().toLowerCase().split(/[\s-]+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]+');
    return !!body && new RegExp(`(?<![\\p{L}\\p{N}+#])${body}(?![\\p{L}\\p{N}+#])`, 'u').test(text.toLowerCase().replace(/\s+/g, ' '));
  }

  const PENALTY = { high: 30, medium: 12, low: 4 };

  // data: PDF bytes. opts.keywords: posting keywords; opts.markdown: the CV source, to spot keywords lost in the PDF.
  async function check(data, opts = {}) {
    const pdf = await (await pdfjs()).getDocument({ data }).promise;
    const { OPS } = await pdfjs();
    const pages = [];
    for (let n = 1; n <= Math.min(pdf.numPages, 10); n++) {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const { items } = await page.getTextContent();
      const { boxes, text } = lineBoxes(items, vp.height);
      const ops = await page.getOperatorList();
      const images = ops.fnArray.filter(f => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject).length;
      pages.push({ boxes, text, images, columns: hasColumns(boxes, vp.width, vp.height) });
    }
    const text = pages.map(p => p.text).join('\n\n');
    const chars = text.replace(/\s/g, '').length;
    const checks = [];
    const add = (sev, status, title, note) => checks.push({ sev, status, title, note });

    add('high', chars >= 50 ? 'pass' : 'fail', 'Text can be selected',
      chars >= 50 ? `${chars} characters of text` : 'Almost no text: the PDF is probably a scanned image. An ATS reads nothing from it.');
    const garbled = (text.match(/�|\(cid:\d+\)|[-]/g) || []).length;
    const gr = garbled / Math.max(1, chars);
    add('high', gr > 0.05 ? 'fail' : gr > 0.005 ? 'warn' : 'pass', 'No broken characters',
      garbled ? `${garbled} characters come out as junk (font without a text map)` : 'All characters read correctly');
    const sparse = pages.map((p, i) => p.images && p.text.replace(/\s/g, '').length < 200 ? i + 1 : 0).filter(Boolean);
    add('medium', !sparse.length ? 'pass' : sparse.length === pages.length ? 'fail' : 'warn', 'Text is not inside pictures',
      sparse.length ? `Page ${sparse.join(', ')}: mostly a picture, little text` : 'Text is real text, not images');
    const cols = pages.map((p, i) => p.columns ? i + 1 : 0).filter(Boolean);
    add('medium', cols.length ? 'fail' : 'pass', 'Single column',
      cols.length ? `Two columns on page ${cols.join(', ')}: many ATS read across both columns and mix the lines` : 'One column, reads top to bottom');
    const imgs = pages.reduce((a, p) => a + p.images, 0);
    add('low', imgs ? 'warn' : 'pass', 'No images', imgs ? `${imgs} image(s): an ATS skips them, keep no text in them` : 'No images');
    add('low', pdf.numPages > 2 ? 'warn' : 'pass', 'At most 2 pages', `${pdf.numPages} page(s)`);
    const email = text.match(EMAIL_RE);
    const phone = hasPhone(text);
    const pos = email ? email.index / Math.max(1, text.length) : null;
    add('high', !email ? 'fail' : !phone || pos > 0.25 ? 'warn' : 'pass', 'Contact details found',
      !email ? 'No email address found in the text'
        : [`email ${pos > 0.25 ? 'found, but not near the top' : 'at the top'}`, phone ? 'phone found' : 'no phone number found'].join(', '));
    const found = findSections(text);
    const missing = Object.keys(HEADINGS).filter(k => !found.includes(k));
    add('medium', !missing.length ? 'pass' : missing.includes('experience') || missing.length > 1 ? 'fail' : 'warn', 'Standard section headings',
      missing.length ? `Not found: ${missing.join(', ')}. Use plain headings like "Experience", "Education", "Skills".` : 'Experience, Education and Skills found');
    add('low', /\b(?:19|20)\d{2}\b/.test(text) ? 'pass' : 'warn', 'Dates present', /\b(?:19|20)\d{2}\b/.test(text) ? 'Years found' : 'No years found in the text');
    if (opts.keywords?.length && opts.markdown) {
      const lost = opts.keywords.filter(k => keywordIn(k, opts.markdown) && !keywordIn(k, text));
      add('medium', lost.length ? 'fail' : 'pass', 'Keywords survive in the PDF',
        lost.length ? `In the CV but unreadable in the PDF: ${lost.join(', ')}` : 'Every posting keyword in the CV is readable');
    }

    let score = 100;
    for (const c of checks) if (c.status !== 'pass') score -= c.status === 'fail' ? PENALTY[c.sev] : PENALTY[c.sev] / 2;
    return { score: Math.max(0, Math.round(score)), checks, text, pages: pdf.numPages };
  }

  function render(r, name) {
    const icon = { pass: '✓', warn: '!', fail: '✗' };
    const tone = r.score >= 75 ? 'good' : r.score >= 50 ? 'mid' : 'low';
    return `<div class="atsBox atsPdf">
      <div class="atsHead"><span class="atsBig ${tone}">${r.score}</span>
        <span>How an ATS reads ${esc(name || 'this PDF')}<br><span class="muted small">${r.pages} page(s) · checks only the file, not the match with the posting</span></span>
        <span class="sp"></span><button class="ghost" data-act="atsclose">Close</button></div>
      <ul class="atsChecks">${r.checks.map(c => `<li class="st-${c.status}"><b>${icon[c.status]}</b> <strong>${esc(c.title)}</strong> <span class="muted">${esc(c.note)}</span></li>`).join('')}</ul>
      <details><summary>What the ATS reads</summary><pre class="atsText">${esc(r.text)}</pre></details>
      <label class="small muted atsOther">Check another PDF… <input type="file" accept="application/pdf" data-act="atsfile"></label>
    </div>`;
  }

  window.atsPdf = { check, render };
})();
