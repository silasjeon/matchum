// Shared helper for extension pages (popup, recipe pages): ask the daemon a
// question through the service worker. Loaded before popup.js / page.js.
function matchumDaemonRequest(method, params) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "daemon.req", method, params }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || "no response"));
      resolve(res.result);
    });
  });
}
