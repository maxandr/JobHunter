'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('./store');
const { taskContext } = require('./task');

function resolveCodex(bin = '') {
  bin = bin || 'codex';
  if (process.platform !== 'win32') return { cmd: bin, shell: false };
  let candidates = [];
  if (/[\\/]/.test(bin)) candidates = [bin, bin + '.exe', bin + '.cmd'];
  else {
    try { candidates = execFileSync('where.exe', [bin], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/); } catch (_) { /* try npm */ }
    if (bin === 'codex') candidates.push(path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'));
  }
  const found = candidates.find(p => /\.exe$/i.test(p) && fs.existsSync(p))
    || candidates.find(p => /\.cmd$/i.test(p) && fs.existsSync(p));
  return found ? { cmd: /\.cmd$/i.test(found) ? `"${found}"` : found, shell: /\.cmd$/i.test(found) }
    : { cmd: bin, shell: true };
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; } catch (_) { /* exited */ }
  }
  child.kill();
}

function command(bin, args, { cwd, prompt, signal, timeoutMs = 20000, onLog } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('Cancelled'));
  const launcher = resolveCodex(bin);
  return new Promise((resolve, reject) => {
    const child = spawn(launcher.cmd, args, { cwd, shell: launcher.shell, windowsHide: true });
    let out = '', error = '', failure;
    const stop = message => { failure = new Error(message); killTree(child); };
    const timer = setTimeout(() => stop('Codex timed out'), timeoutMs);
    const abort = () => stop('Cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', d => { out = (out + d).slice(-64000); });
    child.stderr.on('data', d => { error = (error + d).slice(-8000); if (onLog) onLog(String(d).trim()); });
    child.on('error', e => { cleanup(); reject(new Error(`Cannot start Codex: ${e.message}. Install Codex CLI and run codex login.`)); });
    child.on('close', code => {
      cleanup();
      if (failure || code !== 0) reject(failure || new Error(`Codex exited with code ${code}: ${(error || out).slice(-2000)}`));
      else resolve({ out: out.trim(), cmd: launcher.cmd });
    });
    child.stdin.on('error', () => {}); // process may fail before consuming stdin
    child.stdin.end(prompt || '');
  });
}

async function codexStatus(bin) {
  try {
    const version = await command(bin, ['--version']);
    try {
      await command(bin, ['login', 'status']);
      return { ok: true, installed: true, version: version.out, cmd: version.cmd, loggedIn: true };
    } catch (e) { return { ok: false, installed: true, version: version.out, cmd: version.cmd, loggedIn: false, error: e.message }; }
  } catch (e) { return { ok: false, installed: false, error: e.message, cmd: bin || 'codex', loggedIn: false }; }
}

// Structured outputs require every property to be required and objects to be closed.
function strictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, strictSchema(v)]));
  if (out.type === 'object' || out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties || {});
  }
  return out;
}

async function runCodex({ prompt, schema, tools = [], config, cwd, timeoutMs = 15 * 60000, onLog, action }) {
  const signal = taskContext.getStore()?.signal;
  if (signal?.aborted) throw new Error('Cancelled');
  const started = Date.now();
  const model = config.codexModels?.[action] || config.codexModel || '';
  const effort = config.codexEffort?.[action] || '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-hunter-codex-'));
  const output = path.join(dir, 'answer.json');
  const schemaPath = path.join(dir, 'schema.json');
  const quote = p => process.platform === 'win32' && resolveCodex(config.codexBin).shell ? `"${p}"` : p;
  let ok = false;
  try {
    fs.mkdirSync(cwd, { recursive: true });
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never',
      '-c', 'approval_policy=never', '-c', `web_search=${tools.includes('web') ? 'live' : 'disabled'}`,
      '--output-last-message', quote(output)];
    if (schema) {
      fs.writeFileSync(schemaPath, JSON.stringify(strictSchema(schema)));
      args.push('--output-schema', quote(schemaPath));
    }
    if (model) args.push('--model', model);
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    args.push('-');
    await command(config.codexBin, args, { cwd, signal, onLog,
      timeoutMs: config.timeouts?.[action] > 0 ? config.timeouts[action] * 60000 : timeoutMs,
      prompt: 'Answer the task without modifying files. References to WebFetch/WebSearch mean your web search tools. References to Read mean read the specified file with available read-only tools. Never invent missing PDF content.\n\n' + prompt });
    let data;
    try { data = JSON.parse(fs.readFileSync(output, 'utf8')); }
    catch (e) { throw new Error(`Codex did not return valid JSON: ${e.message}`); }
    ok = true;
    return { data, costUsd: 0, durationMs: Date.now() - started };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* cleanup must not hide the task result */ }
    try { store.logUsage({ action, provider: 'codex', model: model || 'codex default', effort, ok, costUsd: 0, durationMs: Date.now() - started }); } catch (_) { /* optional stats */ }
  }
}

module.exports = { runCodex, codexStatus, strictSchema, resolveCodex };
