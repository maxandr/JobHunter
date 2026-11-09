'use strict';
// Real DOM regression checks with mocked HTTP: no real settings or AI calls.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { findBrowser } = require('../lib/pdf');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-hunter-ui-'));
const config = {
  aiProvider: 'claude', models: { search: 'sonnet' }, effort: { search: 'medium' },
  codexModels: {}, codexEffort: {}, timeouts: {}, searchTimeoutMinutes: 20,
};
const mock = `
window.testWrites = 0;
window.testChecks = 0;
window.fetch = async (url, opts = {}) => {
  let data = {};
  if (url === '/api/settings') {
    if (opts.method === 'PUT') window.testWrites++;
    data = {config: ${JSON.stringify(config)}, actions: ['search'], browsers: []};
  } else if (url === '/api/setup') data = {done: true};
  else if (url === '/api/state') data = {jobs: [], tasks: [], hasResume: true};
  else if (url.startsWith('/api/usage')) data = {rows: []};
  else if (url === '/api/settings/test-ai') {
    window.testChecks++;
    data = {ok: true, version: 'test-cli'};
  }
  return {ok: true, json: async () => data};
};`;
const checks = `
(async () => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const change = (selector, value) => {
    const el = document.querySelector(selector); el.value = value;
    el.dispatchEvent(new Event('input', {bubbles: true}));
  };
  try {
    await loadSettings();
    change('.setModel[data-a="search"]', 'opus');
    change('#aiProvider', 'codex');
    assert(document.querySelector('.setModel').options.length >= 10, 'Codex models missing');
    change('.setModel', 'gpt-6.1-sol');
    change('.setEffort', 'ultra');
    change('#aiProvider', 'claude');
    assert(document.querySelector('.setModel').value === 'opus', 'Claude draft lost');
    change('#aiProvider', 'codex');
    assert(document.querySelector('.setModel').value === 'gpt-6.1-sol', 'Codex draft lost');
    assert(document.querySelector('.setEffort').value === 'ultra', 'Codex effort lost');
    change('.setModel', 'gpt-6-luna');
    assert(document.querySelector('.setEffort').value === 'max', 'Unsupported Luna Ultra not corrected');
    assert(![...document.querySelector('.setEffort').options].some(o => o.value === 'ultra'), 'Luna offers Ultra');
    change('.setModel', '__custom');
    change('.setModelCustom', 'custom-model');
    assert(collectSettings().codexModels.search === 'custom-model', 'Custom model lost');
    assert(collectSettings().models.search === 'opus', 'Provider settings mixed');
    document.querySelector('#testClaude').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert(window.testChecks === 1, 'Test AI was not called');
    assert(window.testWrites === 0, 'Test AI saved settings');
    document.querySelector('#resetSettings').click();
    assert(document.querySelector('#aiProvider').value === 'claude', 'Undo did not restore provider');
    assert(document.querySelector('.setModel').value === 'sonnet', 'Undo did not restore model');
    S.tasks = [{id: 'test', status: 'running', kind: 'tailor', label: 'Tailoring', startedAt: Date.now(), log: [],
      agent: {name: 'OpenAI Codex', model: 'gpt-6.1-sol'}}];
    renderTasks();
    assert(document.querySelector('.task .st').nextElementSibling.textContent === 'gpt-6.1-sol', 'Model missing beside Working');
    S.tasks[0].agent.model = '';
    renderTasks();
    assert(document.querySelector('.taskModel').textContent === 'OpenAI Codex · CLI default', 'Default model label misleading');
    S.tasks[0].agent = null;
    renderTasks();
    assert(!document.querySelector('.taskModel'), 'Stale model shown after agent finishes');
    document.body.innerHTML = '<pre>SETTINGS_BROWSER_PASS</pre>';
  } catch (e) { document.body.innerHTML = '<pre>SETTINGS_BROWSER_FAIL: ' + e.message + '</pre>'; }
})();`;
try {
  let html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  html = html.replace('<head>', '<head><script>' + mock + '</script>');
  html = html.replace(/<link[^>]+>/g, '');
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, name) =>
    '<script>' + fs.readFileSync(path.join(__dirname, '../public', name), 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>');
  html = html.replace('</body>', '<script>' + checks + '</script></body>');
  const file = path.join(dir, 'test.html');
  fs.writeFileSync(file, html);
  const out = execFileSync(findBrowser(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + path.join(dir, 'profile'), '--dump-dom', '--virtual-time-budget=3000', pathToFileURL(file).href],
  { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!out.includes('<pre>SETTINGS_BROWSER_PASS</pre>')) throw new Error(out.match(/SETTINGS_BROWSER_FAIL:[^<]+/)?.[0] || 'UI tests did not finish');
  console.log('PASS: real browser — provider switching, model list, separate drafts, effort compatibility, Custom, Test AI, Undo');
} finally { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); }
