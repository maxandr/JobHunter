// Job Hunter form filler: opens the application page in your browser, reads its form fields and fills in the
// answers the app got from Claude. Presses Submit only for "Try to auto apply".
'use strict';

const SCRIPTS = ['form-scripts.js'];

// Tabs you looked at, newest first — filling without opening a page uses the last one that is not the app itself.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { recent = [] } = await chrome.storage.session.get('recent');
  await chrome.storage.session.set({ recent: [tabId, ...recent.filter(t => t !== tabId)].slice(0, 20) });
});

async function lastFormTab(appTab) {
  const { recent = [] } = await chrome.storage.session.get('recent');
  const appOrigin = new URL(appTab.url).origin;
  for (const id of recent) {
    if (id === appTab.id) continue;
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab && /^https?:/.test(tab.url || '') && new URL(tab.url).origin !== appOrigin) return tab;
  }
  throw new Error('No page to fill. Open the application form in a tab first.');
}

function waitLoaded(tabId, ms = 30000) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(timer); resolve(); };
    const on = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then(t => t.status === 'complete' && done(), done);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Field ids get a random prefix per frame, so fields in embedded forms (iframes) never clash.
async function collect(tabId) {
  let fields = [];
  for (let i = 0; i < 12; i++) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: SCRIPTS });
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => collectFields('f' + Math.random().toString(36).slice(2, 7)),
    });
    fields = res.flatMap(r => r.result || []);
    if (fields.length) break;
    await sleep(500); // single-page sites render the form a moment after loading
  }
  return fields;
}

async function fill(tabId, answers, files) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: SCRIPTS });
  const res = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (answers, files) => fillFields(answers, window === window.top,
      files.filter(f => document.querySelector(`[data-jh-id="${f.id}"]`))),
    args: [answers, files],
  });
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return res.reduce((s, r) => ({ filled: s.filled + (r.result?.filled || 0), uploaded: s.uploaded + (r.result?.uploaded || 0) }),
    { filled: 0, uploaded: 0 });
}

const handlers = {
  ping: async () => ({ version: chrome.runtime.getManifest().version }),
  open: async ({ url }, sender) => {
    const tab = await chrome.tabs.create({ url, openerTabId: sender.tab.id, index: sender.tab.index + 1 });
    await waitLoaded(tab.id);
    return { tabId: tab.id };
  },
  lastTab: async (_, sender) => {
    const tab = await lastFormTab(sender.tab);
    return { tabId: tab.id, url: tab.url };
  },
  collect: async ({ tabId }) => ({ fields: await collect(tabId) }),
  fill: async ({ tabId, answers, files }) => fill(tabId, answers, files || []),
  submit: async ({ tabId }) => submit(tabId),
};

// Presses Send in the frame that holds the filled form, then checks the page a few seconds later.
async function submit(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: SCRIPTS });
  const clicks = (await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => submitForm() }))
    .map(r => r.result).filter(r => r && !r.skip);
  const hit = clicks.find(r => r.clicked);
  if (!hit) {
    return { clicked: false, invalid: clicks.flatMap(r => r.invalid || []),
      reason: (clicks.find(r => r.reason) || {}).reason || (clicks.length ? '' : 'The filled form is gone from the page.') };
  }
  await sleep(4000);
  await waitLoaded(tabId, 15000);
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: SCRIPTS }).catch(() => {});
  const checks = (await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => submitCheck() }).catch(() => []))
    .map(r => r.result).filter(Boolean);
  return { ...hit, check: { success: checks.some(c => c.success), stillForm: checks.some(c => c.stillForm), errors: checks.flatMap(c => c.errors) } };
}

// Content scripts reach only pages loaded after the extension started, so an app tab that was already open
// (browser restored it at startup, or you pressed ↻ on the extension) gets the bridge here.
async function injectBridge() {
  const tabs = await chrome.tabs.query({ url: ['http://localhost/*', 'http://127.0.0.1/*'] });
  for (const t of tabs) chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['bridge.js'] }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(injectBridge);
chrome.runtime.onStartup.addListener(injectBridge);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const h = handlers[msg && msg.cmd];
  if (!h || !sender.tab) return false;
  h(msg.args || {}, sender).then(reply, e => reply({ error: e.message || String(e) }));
  return true; // answer comes later
});
