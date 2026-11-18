'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ats = require('../lib/ats');

const base = '## Skills\n\n- **Tools**: Git, Jira\n- **Methodologies**: Scrum, Kanban.\n';

test('trimMethodologies drops practices added to Methodologies', () => {
  const cv = '## Skills\n\n- **Tools**: Git, Jira\n- **Methodologies**: Scrum, Kanban, Code review, Prototyping.\n';
  const { md, removed } = ats.trimMethodologies(cv, base);
  assert.equal(md, base);
  assert.deepEqual(removed, ['Code review', 'Prototyping']);
});

test('trimMethodologies keeps real methodologies and the base line as is', () => {
  const cv = '- **Methodologies**: Agile (Scrum, Kanban), TDD\n';
  assert.deepEqual(ats.trimMethodologies(cv, base), { md: cv, removed: [] });
  assert.deepEqual(ats.trimMethodologies(base, base), { md: base, removed: [] });
});

test('trimMethodologies keeps an item the base resume already lists there', () => {
  const own = '- **Methodologies**: Scrum, Code review\n';
  assert.deepEqual(ats.trimMethodologies(own, own).removed, []);
});

test('trimMethodologies leaves other Skills lines alone', () => {
  const cv = '- **Tools & Methodologies**: Perforce, code review, Scrum\n';
  assert.deepEqual(ats.trimMethodologies(cv, base), { md: cv, removed: [] });
});
