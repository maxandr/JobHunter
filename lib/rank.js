// Orders postings by how close they are to the candidate's resume, before the limits cut the list for Claude.
// Plain BM25 over words (no embeddings, nothing to download): a posting scores higher the more of the resume's words it
// has, rare words (Unreal, replication) counting more than common ones. The title weighs more than the text.
// Also decides which postings pass the "Look for" words: a word in the title, or at least BODY_HITS of them in the text
// and a resume score as good as a typical title match.
'use strict';

const { hasWordStart, wordHits } = require('./store');

const BODY_HITS = 2;   // "Look for" entries the text needs when the title has none ("Software Engineer" + Unreal, C++)
const TITLE_SHARE = 0.65;  // of the score; the rest is the posting text
const K1 = 1.2, B = 0.75;

const STOP = new Set(('a an and are as at be by for from has have in is it its of on or our that the this to was were will with you your we us '
  + 'they their them he she his her i me my not but all any can do if so up out more most other some such than then there these '
  + 'what when where which who how also into over under about after before while per via etc year years experience work working '
  + 'com www http https org net io gmail github linkedin '
  + 'и в во на с со по к ко у о об от до за из для не но а или как что это то же мы вы он она они я мой при так все').split(' '));

function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-zа-яё0-9+#]+/i)
    .filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
}

// The resume and profile, without the profile's "Not interested in" list: those are words the candidate avoids.
function resumeQuery(resume, profile, include = []) {
  const kept = String(profile || '').replace(/^Not interested in[^\n]*\n(?:[ \t]*-[^\n]*\n?)*/gim, '');
  const weights = new Map();
  for (const w of tokens(resume + '\n' + kept)) weights.set(w, (weights.get(w) || 0) + 1);
  for (const [w, n] of weights) weights.set(w, 1 + Math.log(n));
  // The "Look for" words are what the candidate is after: they weigh like a word repeated many times in the resume.
  for (const w of include.flatMap(tokens)) weights.set(w, (weights.get(w) || 0) + 3);
  return weights;
}

// items: [{ title, body }]; returns the scores in the same order.
// BM25 of one field (the titles, or the texts) of all items against the query, scaled so the best item has 1.
function bm25(texts, query) {
  const docs = texts.map(t => {
    const words = tokens(t);
    const tf = new Map();
    for (const w of words) if (query.has(w)) tf.set(w, (tf.get(w) || 0) + 1);
    return { tf, len: words.length || 1 };
  });
  const n = docs.length;
  const avg = docs.reduce((s, d) => s + d.len, 0) / (n || 1);
  const df = new Map();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  const raw = docs.map(d => {
    let s = 0;
    for (const [w, f] of d.tf) {
      const idf = Math.log(1 + (n - df.get(w) + 0.5) / (df.get(w) + 0.5));
      s += query.get(w) * idf * f * (K1 + 1) / (f + K1 * (1 - B + B * d.len / avg));
    }
    return s;
  });
  const top = Math.max(...raw, 0);
  return raw.map(s => (top ? s / top : 0));
}

// items: [{ title, body }] → a score per item, 0..1. Scored apart and then added, so the title (it names the role)
// weighs more than the long text, where the company's own blurb is the same in every posting.
function scoreByResume(items, query) {
  if (!query || !query.size || !items.length) return items.map(() => 0);
  const title = bm25(items.map(p => p.title), query);
  const body = bm25(items.map(p => p.body), query);
  return items.map((_, i) => TITLE_SHARE * title[i] + (1 - TITLE_SHARE) * body[i]);
}

// Sorts in place, best first; ties keep their order (newest first, as the readers list them).
function rankByResume(items, query) {
  if (items.length < 2) return items;
  const scores = scoreByResume(items, query);
  const order = items.map((p, i) => ({ p, s: scores[i], i })).sort((a, b) => b.s - a.s || a.i - b.i);
  order.forEach((x, i) => { items[i] = x.p; });
  return items;
}

// A posting without a "Look for" word in the title: it needs BODY_HITS of them in the text.
const textHasWords = (body, include) => include.length > 0 && wordHits(body, include) >= Math.min(BODY_HITS, include.length);

// 'title' — a "Look for" word in the title; 'text' — none there, but enough of them in the posting; '' — neither.
function lookForMatch(title, body, include) {
  if (!include.length || hasWordStart(title, include)) return 'title';
  return textHasWords(body, include) ? 'text' : '';
}

// Of the postings matched by their text (others), the ones at least as close to the resume as a typical posting
// matched by its title (byTitle, the median one). Words like "engineers" or "gameplay" turn up in every posting of a
// game studio, a producer's or an artist's too — this keeps those out. Scored together, so the scores compare.
function closeEnough(byTitle, others, query) {
  if (!others.length || !byTitle.length || !query || !query.size) return others;
  const scores = scoreByResume(byTitle.concat(others), query);
  const bar = scores.slice(0, byTitle.length).sort((a, b) => a - b)[Math.floor((byTitle.length - 1) / 2)];
  return others.filter((_, i) => scores[byTitle.length + i] >= bar);
}

module.exports = { resumeQuery, rankByResume, lookForMatch, closeEnough, BODY_HITS };
