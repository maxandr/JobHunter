// Runs on the Job Hunter web page (localhost) and passes its requests to the extension's background script.
'use strict';

// Only the app's own page (it has <meta name="job-hunter">) may use the extension, not other local sites.
if (document.querySelector('meta[name="job-hunter"]')) {
  document.documentElement.dataset.jhExtension = chrome.runtime.getManifest().version;
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.jh !== 'req') return;
    const { id, cmd, args } = e.data;
    chrome.runtime.sendMessage({ cmd, args }, res => {
      const err = chrome.runtime.lastError;
      window.postMessage({ ...(err ? { error: err.message } : res), jh: 'res', id }, location.origin);
    });
  });
}
