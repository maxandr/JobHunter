// Runs on the Job Hunter web page (localhost) and passes its requests to the extension's background script.
// The background script also injects it into app tabs that were open before the extension started or was reloaded.
'use strict';

(() => {
  // Only the app's own page (it has <meta name="job-hunter">) may use the extension, not other local sites.
  if (!document.querySelector('meta[name="job-hunter"]')) return;
  // A bridge left from before a reload can no longer reach the extension; this one replaces it.
  if (window.__jhBridge) window.__jhBridge.stop();
  const onMessage = e => {
    if (e.source !== window || !e.data || e.data.jh !== 'req') return;
    // The extension was reloaded and this copy is orphaned: leave the request to the new bridge.
    if (!chrome.runtime || !chrome.runtime.id) return stop();
    const { id, cmd, args } = e.data;
    chrome.runtime.sendMessage({ cmd, args }, res => {
      const err = chrome.runtime.lastError;
      window.postMessage({ ...(err ? { error: err.message } : res), jh: 'res', id }, location.origin);
    });
  };
  const stop = () => window.removeEventListener('message', onMessage);
  window.__jhBridge = { stop };
  window.addEventListener('message', onMessage);
  document.documentElement.dataset.jhExtension = chrome.runtime.getManifest().version;
  // Tells an already open page that the extension is here now.
  window.dispatchEvent(new Event('jh-extension'));
})();
