// The running task's "Stop" signal. The server runs each task inside taskContext.run({ signal }, ...),
// so code anywhere below it can see a Stop press: claude processes get killed, downloads get dropped.
'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const taskContext = new AsyncLocalStorage();

const taskSignal = () => taskContext.getStore() && taskContext.getStore().signal;

// Throws once Stop was pressed, so loops over many sites and pages end right away.
function checkCancelled() {
  const s = taskSignal();
  if (s && s.aborted) throw new Error('Cancelled');
}

// A fetch signal that fires on its own timeout or on Stop, whichever comes first.
function withStop(signal) {
  const s = taskSignal();
  return s ? AbortSignal.any([signal, s]) : signal;
}

module.exports = { taskContext, taskSignal, checkCancelled, withStop };
