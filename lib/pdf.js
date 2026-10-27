// Turns a ready HTML page into a PDF with headless Edge/Chrome (same engine as the browser's "Save as PDF").
'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const store = require('./store');

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
];

function findBrowser() {
  const own = store.config().browserBin;
  if (own) return own;
  const found = CANDIDATES.find(p => fs.existsSync(p));
  if (!found) throw new Error('No Edge or Chrome found. Set "browserBin" in config.json to the browser .exe');
  return found;
}

function htmlToPdf(html) {
  const dir = path.join(store.WORK, 'pdf-' + crypto.randomUUID().slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'cv.html');
  const out = path.join(dir, 'cv.pdf');
  fs.writeFileSync(src, html);
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    // Own profile folder, so it works while your normal Edge/Chrome is open.
    `--user-data-dir=${path.join(dir, 'profile')}`,
    '--no-pdf-header-footer', `--print-to-pdf=${out}`, pathToFileURL(src).href,
  ];
  return new Promise((resolve, reject) => {
    execFile(findBrowser(), args, { timeout: 60000, windowsHide: true }, err => {
      try {
        if (!fs.existsSync(out)) return reject(new Error('PDF export failed' + (err ? ': ' + err.message : '')));
        resolve(fs.readFileSync(out));
      } finally {
        fs.rm(dir, { recursive: true, force: true }, () => {});
      }
    });
  });
}

module.exports = { htmlToPdf, findBrowser };
