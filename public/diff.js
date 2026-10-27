'use strict';
// Shows how the tailored CV differs from the base resume: line diff (LCS), plus word-level highlights
// for lines that were rewritten. Moved lines show up as removed in one place and added in another.

(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Markdown → readable plain line, remembering what kind of line it was.
  function clean(line) {
    let kind = 'p';
    let t = line.trim();
    if (/^#\s/.test(t)) { kind = 'h1'; t = t.replace(/^#\s+/, ''); }
    else if (/^##\s/.test(t)) { kind = 'h2'; t = t.replace(/^##\s+/, ''); }
    else if (/^###\s/.test(t)) { kind = 'h3'; t = t.replace(/^###\s+/, '').replace(/\s+\|\s+/, '   ·   '); }
    else if (/^>\s?/.test(t)) { kind = 'tag'; t = t.replace(/^>\s?/, ''); }
    else if (/^[-*•]\s/.test(t)) { kind = 'li'; t = t.replace(/^[-*•]\s+/, ''); }
    t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '').replace(/(^|[\s(])\*(?=\S)|(?<=\S)\*(?=$|[\s).,;:])/g, '$1');
    return { kind, text: t.trim() };
  }

  function lcs(a, b, eq) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (eq(a[i], b[j])) { ops.push(['=', a[i], b[j]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++]]);
      else ops.push(['+', b[j++]]);
    }
    while (i < n) ops.push(['-', a[i++]]);
    while (j < m) ops.push(['+', b[j++]]);
    return ops;
  }

  const words = s => s.match(/\S+|\s+/g) || [];
  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  function similarity(a, b) {
    const A = new Set(norm(a).split(' ')), B = new Set(norm(b).split(' '));
    let common = 0;
    A.forEach(w => { if (B.has(w)) common++; });
    return common / Math.max(1, Math.max(A.size, B.size));
  }

  function wordDiff(a, b) {
    return lcs(words(a), words(b), (x, y) => x === y).map(([op, x, y]) =>
      op === '=' ? esc(x) : op === '-' ? `<del>${esc(x)}</del>` : `<ins>${esc(x)}</ins>`).join('');
  }

  function row(kind, cls, html, mark) {
    return `<div class="df-row df-${cls} df-k-${kind}"><span class="df-mark">${mark}</span><span class="df-text">${html}</span></div>`;
  }

  function renderDiff(base, tailored) {
    const A = String(base || '').split(/\r?\n/).filter(l => l.trim()).map(clean);
    const B = String(tailored || '').split(/\r?\n/).filter(l => l.trim()).map(clean);
    const ops = lcs(A, B, (x, y) => norm(x.text) === norm(y.text));
    const out = [];
    const stats = { same: 0, changed: 0, added: 0, removed: 0, moved: 0 };
    // Lines that exist in both versions but in a different place = moved, not removed + added.
    const removedSet = new Set(ops.filter(o => o[0] === '-').map(o => norm(o[1].text)));
    const addedSet = new Set(ops.filter(o => o[0] === '+').map(o => norm(o[1].text)));
    const movedFrom = new Set([...addedSet].filter(x => removedSet.has(x)));
    const movedTo = movedFrom;
    for (let k = 0; k < ops.length;) {
      if (ops[k][0] === '=') {
        out.push(row(ops[k][2].kind, 'same', esc(ops[k][2].text), ''));
        stats.same++; k++; continue;
      }
      // collect a block of removals/additions and pair rewritten lines by similarity
      const del = [], add = [];
      while (k < ops.length && ops[k][0] !== '=') { (ops[k][0] === '-' ? del : add).push(ops[k][1]); k++; }
      const used = new Set();
      const pairs = del.map(d => {
        let best = -1, score = 0.35;
        add.forEach((a, i) => { if (!used.has(i)) { const s = similarity(d.text, a.text); if (s > score) { score = s; best = i; } } });
        if (best >= 0) used.add(best);
        return best;
      });
      del.forEach((d, i) => {
        if (pairs[i] >= 0) return;
        if (movedTo.has(norm(d.text))) return; // shown where it moved to
        out.push(row(d.kind, 'del', esc(d.text), '−')); stats.removed++;
      });
      add.forEach((a, i) => {
        const di = pairs.indexOf(i);
        if (di >= 0) {
          const before = del[di].text;
          if (similarity(before, a.text) >= 0.6) out.push(row(a.kind, 'mod', wordDiff(before, a.text), '~'));
          else out.push(row(a.kind, 'mod', `<span class="df-was">${esc(before)}</span>${esc(a.text)}`, '~'));
          stats.changed++;
        } else if (movedFrom.has(norm(a.text))) {
          out.push(row(a.kind, 'move', esc(a.text) + ' <span class="df-tag">moved</span>', '↕')); stats.moved++;
        } else { out.push(row(a.kind, 'add', esc(a.text), '+')); stats.added++; }
      });
    }
    return {
      html: `<div class="df">${out.join('')}</div>`,
      stats,
    };
  }

  // Word diff split into two sides: removed words highlighted on the left, added on the right.
  function wordDiffSides(a, b) {
    let L = '', R = '';
    for (const [op, x, y] of lcs(words(a), words(b), (p, q) => p === q)) {
      if (op === '=') { L += esc(x); R += esc(y); }
      else if (op === '-') L += `<del>${esc(x)}</del>`;
      else R += `<ins>${esc(x)}</ins>`;
    }
    return [L, R];
  }

  // Side-by-side view like TortoiseGit / WinMerge: left = base resume, right = tailored, rows aligned,
  // empty filler cells where one side has no line, plus an overview strip of all changes.
  function renderSideBySide(base, tailored) {
    const A = String(base || '').split(/\r?\n/).filter(l => l.trim()).map(clean);
    const B = String(tailored || '').split(/\r?\n/).filter(l => l.trim()).map(clean);
    const ops = lcs(A, B, (x, y) => norm(x.text) === norm(y.text));
    const removedSet = new Set(ops.filter(o => o[0] === '-').map(o => norm(o[1].text)));
    const addedSet = new Set(ops.filter(o => o[0] === '+').map(o => norm(o[1].text)));
    const moved = new Set([...addedSet].filter(x => removedSet.has(x)));
    const rows = []; // {cls, l, r, ln, rn, lk, rk}
    let ln = 0, rn = 0;
    for (let k = 0; k < ops.length;) {
      if (ops[k][0] === '=') {
        const a = ops[k][1], b = ops[k][2];
        rows.push({ cls: 'same', l: esc(a.text), r: esc(b.text), ln: ++ln, rn: ++rn, lk: a.kind, rk: b.kind });
        k++; continue;
      }
      const del = [], add = [];
      while (k < ops.length && ops[k][0] !== '=') { (ops[k][0] === '-' ? del : add).push(ops[k][1]); k++; }
      // pair rewritten lines by similarity, keeping their order
      const pairs = [];
      let j0 = 0;
      del.forEach((d, i) => {
        let best = -1, score = 0.35;
        for (let j = j0; j < add.length; j++) {
          const s = similarity(d.text, add[j].text);
          if (s > score && !moved.has(norm(d.text))) { score = s; best = j; }
        }
        if (best >= 0) { pairs.push([i, best]); j0 = best + 1; }
      });
      let di = 0, ai = 0;
      const pushDel = d => rows.push({ cls: moved.has(norm(d.text)) ? 'move' : 'del', l: esc(d.text), r: '', ln: ++ln, rn: '', lk: d.kind });
      const pushAdd = a => rows.push({ cls: moved.has(norm(a.text)) ? 'move' : 'add', l: '', r: esc(a.text), ln: '', rn: ++rn, rk: a.kind });
      for (const [i, j] of pairs) {
        while (di < i) pushDel(del[di++]);
        while (ai < j) pushAdd(add[ai++]);
        const [L, R] = wordDiffSides(del[i].text, add[j].text);
        rows.push({ cls: 'mod', l: L, r: R, ln: ++ln, rn: ++rn, lk: del[i].kind, rk: add[j].kind });
        di = i + 1; ai = j + 1;
      }
      while (di < del.length) pushDel(del[di++]);
      while (ai < add.length) pushAdd(add[ai++]);
    }

    const tag = r => r.cls === 'move' ? ' <span class="df-tag">moved</span>' : '';
    const cell = (html, n, kind, side, r) => html === '' && n === ''
      ? `<td class="sx-n"></td><td class="sx-c sx-empty"></td>`
      : `<td class="sx-n">${n}</td><td class="sx-c sx-${side} df-k-${kind || 'p'}">${html}${tag(r)}</td>`;
    const body = rows.map((r, i) =>
      `<tr id="sx${i}" class="sx-${r.cls}">${cell(r.l, r.ln, r.lk, 'l', r)}${cell(r.r, r.rn, r.rk, 'r', r)}</tr>`).join('');
    const strip = rows.map((r, i) => r.cls === 'same' ? '' :
      `<a class="sx-mk sx-mk-${r.cls}" style="top:${(i / rows.length * 100).toFixed(2)}%" href="#sx${i}" data-row="${i}"></a>`).join('');
    return `<div class="sx">
      <div class="sx-scroll"><table class="sx-t">
        <colgroup><col class="sx-ncol"><col><col class="sx-ncol"><col></colgroup>
        <thead><tr><th></th><th>Your base CV</th><th></th><th>Tailored for this job</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      <div class="sx-strip" title="Changes overview — click to jump">${strip}</div></div>`;
  }

  window.renderDiff = renderDiff;
  window.renderSideBySide = renderSideBySide;
})();
