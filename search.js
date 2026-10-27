// Headless search for Windows Task Scheduler / cron: node search.js
// New jobs land in data/jobs.json and show up in the web app next time you open it.
'use strict';

const store = require('./lib/store');
const actions = require('./lib/actions');
const fs = require('node:fs');
const path = require('node:path');

store.ensure();
const logFile = path.join(store.DATA, 'search.log');
const log = line => fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);

actions.search({ onLog: () => {} })
  .then(r => {
    const msg = `found ${r.found}, new ${r.added}${r.notes ? ' — ' + r.notes : ''}`;
    log(msg);
    console.log(msg);
  })
  .catch(e => {
    log('FAILED: ' + e.message);
    console.error(e.message);
    process.exitCode = 1;
  });
