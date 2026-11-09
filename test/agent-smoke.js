'use strict';
// Optional live checks: public information + synthetic file; no user data.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const store = require('../lib/store');
store.logUsage = () => {};
const { runAgent } = require('../lib/ai');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'job-hunter-smoke-'));
const config = { aiProvider: 'codex', codexModels: { analyze: 'gpt-6.1-sol' }, codexEffort: { analyze: 'low' } };
(async () => {
  try {
    fs.writeFileSync(path.join(cwd, 'test-resume.txt'), 'SYNTHETIC TEST DATA\nName: Test Candidate\nExperience: 7 years\nSkill: JavaScript\n');
    const read = await runAgent({ config, cwd, action: 'analyze', tools: ['readFiles'], timeoutMs: 90000,
      prompt: 'Read test-resume.txt from the current directory using your file tools. Return the candidate name, years and skills. Do not use the web.',
      schema: { type: 'object', properties: { name: { type: 'string' }, years: { type: 'integer' }, skills: { type: 'array', items: { type: 'string' } } }, required: ['name', 'years', 'skills'] },
    });
    assert.equal(read.data.name, 'Test Candidate');
    assert.equal(read.data.years, 7);
    assert.ok(read.data.skills.includes('JavaScript'));
    console.log('PASS: Codex selected model + effort, file reading, structured output');
    const web = await runAgent({ config, cwd, action: 'analyze', tools: ['web'], timeoutMs: 90000,
      prompt: 'Use web search to find the official Node.js download page. Return its URL. Do not run shell commands.',
      schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    });
    assert.equal(new URL(web.data.url).hostname, 'nodejs.org');
    assert.match(web.data.url, /download/);
    console.log('PASS: Codex web search returned the official download URL');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
