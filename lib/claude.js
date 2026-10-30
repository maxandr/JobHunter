// Runs `claude -p` (Claude Code in print mode) and returns parsed JSON.
// The prompt goes through stdin, so no shell quoting problems with long text.
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const store = require('./store');

// The server runs each task inside taskContext.run({ signal }, ...) so a "Stop" press can kill the claude process.
const taskContext = new AsyncLocalStorage();

// child.kill() on Windows only kills the cmd.exe wrapper when shell:true, so kill the whole tree.
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); return; } catch (_) { /* fall back */ }
  }
  child.kill();
}

let resolved = null;

// Find how to launch Claude Code on this machine.
// On Windows a native claude.exe can be spawned directly (structured output via --json-schema works).
// An npm-installed claude.cmd needs a shell, and JSON arguments don't survive cmd.exe quoting,
// so in that case we skip --json-schema and parse JSON out of the text answer instead.
function resolveClaude(configBin) {
  if (resolved) return resolved;
  const bin = configBin || 'claude';
  if (process.platform !== 'win32') {
    resolved = { cmd: bin, shell: false };
    return resolved;
  }
  // A path in Settings: take it as is, with or without .exe / .cmd at the end.
  if (/[\\/]/.test(bin)) {
    const found = [bin, bin + '.exe', bin + '.cmd'].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    if (found) {
      resolved = /\.exe$/i.test(found) ? { cmd: found, shell: false } : { cmd: `"${found}"`, shell: true };
      return resolved;
    }
  }
  try {
    const out = execFileSync('where', [bin.replace(/\.(cmd|exe)$/i, '')], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const exe = lines.find(l => /\.exe$/i.test(l));
    if (exe) {
      resolved = { cmd: exe, shell: false };
      return resolved;
    }
    if (lines.length) {
      resolved = { cmd: `"${lines[0]}"`, shell: true };
      return resolved;
    }
  } catch (_) { /* fall through */ }
  // Not in this process's PATH: the installer adds its folder to PATH only for programs started after it,
  // so an app started earlier (or from an old Explorer window) can't see it. Look in the PATH as Windows
  // has it saved now, and in the usual install folders.
  if (/^claude(\.(exe|cmd))?$/i.test(path.basename(bin))) {
    const env = process.env;
    const dirs = [
      ...savedPath(),
      path.join(env.USERPROFILE || '', '.local', 'bin'),                          // native installer
      path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),           // winget
      path.join(env.LOCALAPPDATA || '', 'Programs', 'claude'),
      path.join(env.APPDATA || '', 'npm'),                                         // npm -g
    ];
    for (const name of ['claude.exe', 'claude.cmd']) {
      for (const d of dirs) {
        const p = path.join(d, name);
        if (d && path.isAbsolute(d) && fs.existsSync(p)) {
          resolved = name.endsWith('.exe') ? { cmd: p, shell: false } : { cmd: `"${p}"`, shell: true };
          return resolved;
        }
      }
    }
  }
  // Not found: don't cache, so a later run finds it once it is installed.
  return { cmd: bin, shell: true };
}

// Folders of the user and system PATH as saved in the registry (newer than this process's PATH).
function savedPath() {
  const keys = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'];
  const dirs = [];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true });
      const m = out.match(/\sPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
      if (!m) continue;
      for (const d of m[1].trim().split(';')) {
        dirs.push(d.replace(/%([^%]+)%/g, (all, v) => process.env[v] ?? all).trim());
      }
    } catch (_) { /* no such value */ }
  }
  return dirs.filter(Boolean);
}

// Pull the first JSON object/array out of a text answer (handles ```json fences and chatter).
function extractJson(text) {
  if (!text) throw new Error('Empty answer from Claude');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(text);
  for (const c of candidates) {
    const t = c.trim();
    try { return JSON.parse(t); } catch (_) { /* try slicing */ }
    const start = t.search(/[[{]/);
    if (start < 0) continue;
    const open = t[start];
    const close = open === '{' ? '}' : ']';
    const end = t.lastIndexOf(close);
    if (end > start) {
      try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { /* next */ }
    }
  }
  throw new Error('Could not find JSON in Claude answer: ' + text.slice(0, 300));
}

/**
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {object} [opts.schema]        JSON schema for structured output
 * @param {string[]} [opts.allowedTools]
 * @param {object} opts.config          app config (claudeBin, model, mcpConfig)
 * @param {string} opts.cwd             working dir for the claude process
 * @param {number} [opts.timeoutMs]
 * @param {(line:string)=>void} [opts.onLog]
 */
function runClaude({ prompt, schema, allowedTools = [], config, cwd, timeoutMs = 15 * 60 * 1000, onLog, action }) {
  const launcher = resolveClaude(config.claudeBin);
  const args = ['-p', '--output-format', 'json'];
  // Per-action model/effort from config.json ("models"/"effort"), falling back to the global "model".
  const model = (config.models && config.models[action]) || config.model;
  const effort = config.effort && config.effort[action];
  // Per-action timeout from the Settings tab ("timeouts"), in minutes.
  const ownTimeout = config.timeouts && +config.timeouts[action];
  if (ownTimeout > 0) timeoutMs = ownTimeout * 60 * 1000;
  const startedAt = Date.now();
  const usage = (ok, envelope) => {
    try {
      store.logUsage({ action, model: model || '', effort: effort || '', ok,
        costUsd: envelope && envelope.total_cost_usd || 0, durationMs: Date.now() - startedAt });
    } catch (_) { /* stats are optional */ }
  };
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  // Never let these runs touch your files or run commands — they only read the web and answer.
  const blocked = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep'].filter(t => !allowedTools.includes(t));
  args.push('--disallowedTools', blocked.join(','));
  if (config.mcpConfig) {
    const p = path.resolve(config.mcpConfig);
    args.push('--mcp-config', launcher.shell ? `"${p}"` : p);
  }
  const useSchema = schema && !launcher.shell;
  if (useSchema) args.push('--json-schema', JSON.stringify(schema));

  const fullPrompt = useSchema
    ? prompt
    : prompt + '\n\nIMPORTANT: Reply with ONLY one JSON value matching this schema, no other text:\n' + JSON.stringify(schema);

  fs.mkdirSync(cwd, { recursive: true });
  const signal = taskContext.getStore() && taskContext.getStore().signal;
  if (signal && signal.aborted) return Promise.reject(new Error('Cancelled'));

  return new Promise((resolve, reject) => {
    const child = spawn(launcher.cmd, args, {
      cwd,
      shell: launcher.shell,
      windowsHide: true,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error(`claude -p timed out after ${Math.round(timeoutMs / 60000)} min`));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      killTree(child);
      reject(new Error('Cancelled'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => {
      stderr += d;
      if (onLog) String(d).split(/\r?\n/).filter(Boolean).forEach(onLog);
    });
    child.on('error', err => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error(`Cannot start Claude Code (${launcher.cmd}): ${err.message}. Is it installed and in PATH?`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch (_) {
        usage(false);
        return reject(new Error(`claude exited with code ${code}. ${(stderr || stdout).slice(0, 800)}`));
      }
      if (envelope.is_error) {
        usage(false, envelope);
        return reject(new Error('Claude returned an error: ' + String(envelope.result || envelope.subtype).slice(0, 800)));
      }
      try {
        const data = envelope.structured_output != null ? envelope.structured_output : extractJson(envelope.result);
        usage(true, envelope);
        resolve({ data, costUsd: envelope.total_cost_usd, durationMs: envelope.duration_ms });
      } catch (e) {
        usage(false, envelope);
        reject(e);
      }
    });

    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

// For the Settings tab: forget the cached launcher (claudeBin changed) and check that claude starts.
function resetClaude() { resolved = null; }
// Runs a short claude command (no prompt) and returns { ok, out, cmd } or { ok: false, error, cmd }.
function claudeCommand(configBin, args, timeoutMs = 20000) {
  const launcher = resolveClaude(configBin);
  return new Promise(resolve => {
    const child = spawn(launcher.cmd, args, { shell: launcher.shell, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { killTree(child); resolve({ ok: false, error: `No answer in ${timeoutMs / 1000} s`, cmd: launcher.cmd }); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message, cmd: launcher.cmd }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, out: out.trim(), cmd: launcher.cmd } : { ok: false, error: out.trim() || `exit code ${code}`, cmd: launcher.cmd });
    });
  });
}
async function claudeVersion(configBin) {
  const r = await claudeCommand(configBin, ['--version']);
  return r.ok ? { ok: true, version: r.out, cmd: r.cmd } : r;
}
// Whether Claude Code is logged in: { loggedIn, email, subscriptionType } from `claude auth status`.
async function claudeAuth(configBin) {
  const r = await claudeCommand(configBin, ['auth', 'status']);
  try {
    const s = JSON.parse(r.out || r.error);
    return { loggedIn: !!s.loggedIn, email: s.email || '', subscriptionType: s.subscriptionType || '' };
  } catch (_) {
    return { loggedIn: false, error: r.error || r.out };
  }
}

// Whether the claude.ai account has a working Perplexity connector: true / false, or null while unknown
// (not checked yet, or `claude mcp list` failed — then Perplexity stays on and Claude copes if it is missing).
let perplexityFound = null;
async function checkPerplexity(configBin) {
  // `mcp list` pings every server, which can take a while.
  const r = await claudeCommand(configBin, ['mcp', 'list'], 90000);
  if (!r.ok) return { found: perplexityFound, error: r.error };
  const line = r.out.split(/\r?\n/).map(s => s.trim()).find(l => /^claude\.ai Perplexity:/i.test(l)) || '';
  perplexityFound = /\bConnected\s*$/i.test(line);
  return { found: perplexityFound };
}
const perplexityStatus = () => ({ found: perplexityFound });

module.exports = { runClaude, extractJson, resolveClaude, resetClaude, claudeVersion, claudeAuth, checkPerplexity, perplexityStatus, taskContext };
