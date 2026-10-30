// Entry point of job-hunter.exe (see build.bat): "job-hunter.exe search" runs a headless search, anything else starts the server.
'use strict';

if (process.argv.includes('search')) {
  require('./search');
} else {
  const store = require('./lib/store');
  if (store.isSea()) {
    // Double-clicked job-hunter.exe: write out the extension, open the browser, and restart by itself (there is no start.bat).
    store.unpackExtension();
    process.env.JOB_HUNTER_SUPERVISED = '1';
    if (!process.env.JOB_HUNTER_RESTARTED) process.argv.push('--open');
  }
  require('./server');
}
