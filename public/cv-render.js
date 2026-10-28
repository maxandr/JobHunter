'use strict';
// Renders resume Markdown in the layout of the original Google Doc resume:
//   # Name                      → centered bold name
//   *Title*  / contact lines    → centered header lines (before the first ##)
//   ## Section                  → gray shaded bar
//   ### Job title | Dates       → bold underlined title, dates right-aligned
//   *Company. Remote*           → italic line
//   > Tagline / sub-project     → bold italic gray line
//   - bullet                    → round bullets
// Supports **bold**, *italic*, [text](url).

(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = t => esc(t)
    .replace(/\[([^\]]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>');

  function renderCv(src) {
    const out = [];
    let list = false;
    let inHeader = true;
    const closeList = () => { if (list) { out.push('</ul>'); list = false; } };

    for (const raw of String(src || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) { closeList(); continue; }
      let m;
      if ((m = line.match(/^#\s+(.*)/))) {
        closeList(); out.push(`<h1 class="cv-name">${inline(m[1])}</h1>`);
      } else if ((m = line.match(/^##\s+(.*)/))) {
        closeList(); inHeader = false; out.push(`<h2 class="cv-section">${inline(m[1])}</h2>`);
      } else if ((m = line.match(/^###\s+(.*)/))) {
        closeList();
        const parts = m[1].split(/\s+\|\s+/);
        const date = parts.length > 1 ? parts.pop() : '';
        out.push(`<div class="cv-job"><span class="cv-job-title">${inline(parts.join(' | '))}</span>` +
          (date ? `<span class="cv-job-date">${inline(date)}</span>` : '') + '</div>');
      } else if ((m = line.match(/^>\s*(.*)/))) {
        closeList(); out.push(`<div class="cv-tagline">${inline(m[1])}</div>`);
      } else if ((m = line.match(/^[-*•]\s+(.*)/))) {
        if (!list) { out.push('<ul class="cv-list">'); list = true; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if (inHeader) {
        closeList();
        const isTitle = /^\*[^*].*\*$/.test(line) || /^_.*_$/.test(line);
        out.push(`<p class="cv-head${isTitle ? ' cv-head-title' : ''}">${inline(line)}</p>`);
      } else if (/^\*[^*].*\*$/.test(line)) {
        closeList(); out.push(`<p class="cv-company">${inline(line)}</p>`);
      } else {
        closeList(); out.push(`<p class="cv-p">${inline(line)}</p>`);
      }
    }
    closeList();
    return `<div class="cv">${out.join('\n')}</div>`;
  }

  // Same rules for the on-screen preview and the printed PDF.
  const CV_CSS = `
.cv{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;line-height:1.38;color:#000;background:#fff}
.cv a{color:#1155cc}
.cv-name{font-size:14pt;font-weight:700;text-align:center;margin:0 0 2px}
.cv-head{text-align:center;margin:0;font-size:10pt}
.cv-head-title{font-weight:700;font-style:italic;font-size:10.5pt}
.cv-head-title em{font-style:italic}
.cv-section{background:#d9d9d9;font-size:12pt;font-weight:700;margin:22px 0 10px;padding:7px 8px;border:none}
.cv-job{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:16px 0 4px}
.cv-job-title{font-size:12pt;font-weight:700;text-decoration:underline}
.cv-job-date{font-size:10pt;font-weight:700;white-space:nowrap}
.cv-company{font-style:italic;font-size:11.5pt;margin:2px 0}
.cv-company em{font-style:italic}
.cv-tagline{font-weight:700;font-style:italic;color:#7f7f7f;margin:6px 0 4px}
.cv-list{margin:2px 0 6px;padding-left:24px;list-style-type:"●   "}
.cv-list li::marker{font-size:9pt}
.cv-list li{margin:0}
.cv-p{margin:4px 0}`;

  // Full standalone A4 page for printing and PDF. The server loads this file too (lib/pdf.js) to count pages.
  function cvPage(text) {
    const name = ((String(text || '').match(/^#\s+(.+)$/m) || [, ''])[1].replace(/[*_]/g, '').trim()) || 'My';
    const title = `${name} CV`;
    return { title, html: `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>${CV_CSS}
    body{margin:0}.cv{max-width:none}
    @page{size:A4;margin:18mm 18mm 16mm;@top-left{content:''}@top-center{content:''}@top-right{content:''}@bottom-left{content:''}@bottom-center{content:''}@bottom-right{content:''}}
    .cv-section,.cv-job{break-after:avoid}.cv-list li{break-inside:avoid}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>${renderCv(text)}</body></html>` };
  }

  window.renderCv = renderCv;
  window.CV_CSS = CV_CSS;
  window.cvPage = cvPage;
})();
