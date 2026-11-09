'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');

function load(file, overrides) {
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '..', file);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    require: name => overrides[name] || require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name),
    process: { platform: 'linux', env: {} }, setTimeout, clearTimeout, console,
  });
  return module.exports;
}

test('dispatch defaults to Claude and switches every action to Codex', async () => {
  const ai = load('lib/ai.js', { './claude': { runClaude: o => 'claude:' + o.action }, './codex': { runCodex: o => 'codex:' + o.action } });
  for (const action of ['search', 'analyze', 'tailor', 'people', 'apply', 'resume']) {
    assert.equal(await ai.runAgent({ action, config: {} }), 'claude:' + action);
    assert.equal(await ai.runAgent({ action, config: { aiProvider: 'codex' } }), 'codex:' + action);
  }
});

for (const scenario of ['success', 'exit error', 'bad json', 'missing output', 'spawn error', 'cancel', 'timeout']) {
  test('Codex process: ' + scenario, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'job-hunter-test-'));
    const context = new AsyncLocalStorage();
    const controller = new AbortController();
    let argsSeen, schemaSeen, promptSeen = '', outputPath, killed = false;
    const usage = [];
    const codex = load('lib/codex.js', {
      './store': { logUsage: row => usage.push(row) }, './task': { taskContext: context },
      'node:child_process': { spawn: (bin, args) => {
        argsSeen = args;
        outputPath = args[args.indexOf('--output-last-message') + 1];
        schemaSeen = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        child.kill = () => { killed = true; setImmediate(() => child.emit('close', 1)); };
        child.stdin.on('data', d => { promptSeen += d; });
        child.stdin.on('finish', () => setImmediate(() => {
          if (scenario === 'cancel') return controller.abort();
          if (scenario === 'timeout') return;
          if (scenario === 'spawn error') { child.emit('error', new Error('ENOENT')); return; }
          if (scenario !== 'missing output') fs.writeFileSync(outputPath, scenario === 'bad json' ? 'bad' : '{"answer":"ok"}');
          child.emit('close', scenario === 'exit error' ? 1 : 0);
        }));
        return child;
      } },
    });
    try {
      const result = context.run({ signal: controller.signal }, () => codex.runCodex({
        prompt: 'Test prompt', schema: { type: 'object', properties: { answer: { type: 'string' } } },
        config: { codexModels: { analyze: 'test-model' }, codexEffort: { analyze: 'high' }, models: { analyze: 'sonnet' } },
        tools: ['web'], action: 'analyze', cwd, timeoutMs: 100,
      }));
      if (scenario === 'success') assert.equal((await result).data.answer, 'ok');
      else await assert.rejects(result);
      assert.ok(argsSeen.includes('test-model'));
      assert.ok(!argsSeen.includes('sonnet'));
      assert.ok(argsSeen.includes('web_search=live'));
      assert.ok(argsSeen.includes('read-only'));
      assert.ok(argsSeen.includes('model_reasoning_effort=high'));
      assert.equal(schemaSeen.additionalProperties, false);
      assert.deepEqual(schemaSeen.required, ['answer']);
      assert.ok(promptSeen.includes('Test prompt'));
      assert.equal(fs.existsSync(path.dirname(outputPath)), false);
      assert.equal(usage.length, 1);
      assert.equal(usage[0].ok, scenario === 'success');
      if (scenario === 'cancel' || scenario === 'timeout') assert.equal(killed, true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
}

test('settings reject invalid providers and Codex command arguments before writing', () => {
  const store = require('../lib/store');
  assert.throws(() => store.saveConfig({ aiProvider: 'unknown' }), /provider/);
  assert.throws(() => store.saveConfig({ codexModels: { search: 'bad & command' } }), /model/);
  assert.throws(() => store.saveConfig({ codexEffort: { search: 'minimal' } }), /effort/);
  assert.throws(() => store.saveConfig({ codexModels: { search: ['gpt-6-sol'] } }), /model/);
  assert.throws(() => store.saveConfig({ codexModels: { search: 'gpt-6-luna' }, codexEffort: { search: 'ultra' } }), /Ultra/);
  assert.throws(() => store.saveConfig({ codexBin: 'codex & command' }), /path/);
});

test('Claude launcher cache follows the requested binary, including unsaved connection checks', () => {
  const claude = load('lib/claude.js', {});
  assert.equal(claude.resolveClaude('/installed/claude').cmd, '/installed/claude');
  assert.equal(claude.resolveClaude('/draft/claude').cmd, '/draft/claude');
  assert.equal(claude.resolveClaude('/installed/claude').cmd, '/installed/claude');
});

test('Claude rejects nonzero exit even when stdout contains a successful JSON envelope', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'job-hunter-claude-test-'));
  const usage = [];
  const claude = load('lib/claude.js', {
    './store': { logUsage: row => usage.push(row) },
    'node:child_process': { spawn: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.stdin.on('finish', () => setImmediate(() => {
        child.stdin.emit('error', new Error('EPIPE'));
        child.stdout.write(JSON.stringify({ result: '{"answer":"partial"}' }));
        child.emit('close', 1);
      }));
      return child;
    } },
  });
  try {
    await assert.rejects(claude.runClaude({ prompt: 'test', config: {}, cwd, timeoutMs: 1000 }), /exited with code 1/);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].ok, false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('agent contract translates capabilities and rejects unknown providers', async () => {
  let received;
  const ai = load('lib/ai.js', {
    './claude': { runClaude: o => { received = o; return { data: {} }; } },
    './codex': { codexStatus: async () => ({ ok: true, installed: true, loggedIn: true }) },
  });
  await ai.runAgent({ config: {}, tools: ['web', 'readFiles', 'custom_tool'] });
  assert.equal(received.allowedTools.join(','), 'WebSearch,WebFetch,Read,custom_tool');
  await assert.rejects(ai.runAgent({ config: { aiProvider: 'unknown' } }), /Unknown AI provider/);
  const status = await ai.checkAgent({ aiProvider: 'codex' });
  assert.equal(status.provider, 'codex');
  assert.equal(status.loggedIn, true);
  assert.equal(status.capabilities.perplexity, false);
});

test('saving and switching providers preserves both sets of models', () => {
  let configText = JSON.stringify({ models: { search: 'sonnet' }, effort: { search: 'medium' } });
  let pending;
  const store = load('lib/store.js', { 'node:fs': {
    ...fs,
    readFileSync: filename => { assert.ok(filename.endsWith('config.json')); return configText; },
    writeFileSync: (filename, content) => { assert.ok(filename.includes('config.json.')); pending = content; },
    renameSync: (from, to) => { assert.ok(to.endsWith('config.json')); configText = pending; },
  } });
  assert.equal(store.config().aiProvider, 'claude');
  store.validateConfig({ aiProvider: 'codex', codexEffort: { search: 'ultra' } });
  assert.equal(store.config().aiProvider, 'claude', 'checking a draft must not save it');
  store.saveConfig({ aiProvider: 'codex', codexModels: { search: 'test-model' }, codexEffort: { search: 'high' } });
  assert.equal(store.config().models.search, 'sonnet');
  store.saveConfig({ aiProvider: 'claude' });
  assert.equal(store.config().codexModels.search, 'test-model');
  assert.equal(store.config().codexEffort.search, 'high');
  assert.equal(store.config().models.search, 'sonnet');
});

test('running task reports its model snapshot and clears it after failure', async () => {
  const context = new AsyncLocalStorage();
  let finish;
  const ai = load('lib/ai.js', {
    './task': { taskContext: context },
    './claude': {}, './codex': { runCodex: () => new Promise((resolve, reject) => { finish = reject; }) },
  });
  const updates = [];
  const config = { aiProvider: 'codex', codexModels: { tailor: 'gpt-6.1-sol' } };
  const running = context.run({ onAgent: a => updates.push(a) }, () => ai.runAgent({ config, action: 'tailor' }));
  config.codexModels.tailor = 'gpt-6-luna';
  assert.equal(updates[0].model, 'gpt-6.1-sol');
  assert.equal(updates[0].provider, 'codex');
  finish(new Error('test failure'));
  await assert.rejects(running, /test failure/);
  assert.equal(updates[1], null);
});
