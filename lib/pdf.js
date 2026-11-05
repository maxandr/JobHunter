// Turns a ready HTML page into a PDF with headless Edge/Chrome (same engine as the browser's "Save as PDF").
'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
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

// Opens the page in headless Edge/Chrome with extra flags; done(err, stdout, dir) reads the result.
function headless(html, flags, done) {
  const dir = path.join(store.WORK, 'pdf-' + crypto.randomUUID().slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'cv.html');
  fs.writeFileSync(src, html);
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    // Own profile folder, so it works while your normal Edge/Chrome is open.
    `--user-data-dir=${path.join(dir, 'profile')}`,
    ...flags(dir), pathToFileURL(src).href,
  ];
  return new Promise((resolve, reject) => {
    execFile(findBrowser(), args, { timeout: 60000, windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout) => {
      try {
        resolve(done(err, stdout, dir));
      } catch (e) {
        reject(e);
      } finally {
        fs.rm(dir, { recursive: true, force: true }, () => {});
      }
    });
  });
}

function htmlToPdf(html) {
  return headless(html, dir => ['--no-pdf-header-footer', `--print-to-pdf=${path.join(dir, 'cv.pdf')}`], (err, _, dir) => {
    const out = path.join(dir, 'cv.pdf');
    if (!fs.existsSync(out)) throw new Error('PDF export failed' + (err ? ': ' + err.message : ''));
    return fs.readFileSync(out);
  });
}

// The CV page exactly as the browser builds it: runs public/cv-render.js with a stand-in "window".
let cvRender = null;
function cvPage(md) {
  if (!cvRender) {
    const window = {};
    vm.runInNewContext(store.publicFile('cv-render.js').toString('utf8'), { window });
    cvRender = window;
  }
  return cvRender.cvPage(md);
}

// How many A4 pages the CV takes in the PDF the app makes.
async function cvPages(md) {
  const pdf = (await htmlToPdf(cvPage(md).html)).toString('latin1');
  return (pdf.match(/\/Type\s*\/Page(?![a-z])/g) || []).length;
}

// How full the CV pages are, e.g. 1.6 = one full page and 60% of the second. The page is laid out on screen at the
// printed width (A4 minus the @page margins in cv-render.js) and its height divided by the printed page height.
// Page breaks add a little, so it reads slightly low; cvPages() is the hard check.
const PRINT_W_MM = 210 - 18 - 18;
const PRINT_H_MM = 297 - 18 - 16;
async function cvFill(md) {
  const probe = `<style>body{width:${PRINT_W_MM}mm}</style><script>
document.body.setAttribute('data-h', document.querySelector('.cv').getBoundingClientRect().height);
document.body.setAttribute('data-mm', document.getElementById('mm').getBoundingClientRect().height);
</script>`;
  const html = cvPage(md).html.replace('</body>', `<div id="mm" style="height:100mm"></div>${probe}</body>`);
  return headless(html, () => ['--dump-dom'], (err, stdout) => {
    const h = +(String(stdout).match(/data-h="([\d.]+)"/) || [])[1];
    const mm = +(String(stdout).match(/data-mm="([\d.]+)"/) || [])[1] / 100;
    if (!h || !mm) throw new Error('Could not measure the CV' + (err ? ': ' + err.message : ''));
    return h / mm / PRINT_H_MM;
  });
}

module.exports = { htmlToPdf, findBrowser, cvPages, cvFill };
