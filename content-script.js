// content-script.js — Runs on claude.ai/* in the ISOLATED world.
// Bridges messages from the main-world fetch sniffer (page-inject.js) to the
// background service worker, and also handles SPA-nav pokes.

(function () {
  "use strict";

  const TAG = "__CLAUDE_USAGE_BADGE__";

  let lastPoke = 0;
  const POKE_COOLDOWN_MS = 10_000;

  // Safe wrapper: after the extension is reloaded the content script's
  // `chrome` reference is stale and sendMessage throws SYNCHRONOUSLY with
  // "Extension context invalidated." .catch() doesn't rescue a sync throw,
  // so we wrap in try/catch. Once we see that error, stop trying.
  let contextAlive = true;
  function safeSend(payload) {
    if (!contextAlive) return;
    try {
      const p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      if (String(e?.message || e).includes("Extension context invalidated")) {
        contextAlive = false;
      }
    }
  }

  function pokeBackground() {
    const now = Date.now();
    if (now - lastPoke < POKE_COOLDOWN_MS) return;
    lastPoke = now;
    safeSend({ type: "CLAUDE_USAGE_UPDATE" });
  }

  function forwardSniffed(url, body) {
    safeSend({ type: "SNIFFED_PAYLOAD", url, body });
  }

  // Dedupe URLs locally so we don't flood the service worker with the same
  // path on every fetch. Capped so a long-lived SPA tab can't grow the set
  // without bound.
  const sentUrls = new Set();
  function forwardSeenUrl(url) {
    if (!url || sentUrls.has(url)) return;
    if (sentUrls.size >= 500) sentUrls.clear();
    sentUrls.add(url);
    safeSend({ type: "API_URL_SEEN", url });
  }

  // Bridge: listen for main-world posts from page-inject.js.
  // Only accept messages posted by THIS window at our own origin — an
  // embedded iframe or other frame could otherwise forge extension messages.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    if (ev.origin !== location.origin) return;
    const msg = ev.data;
    if (!msg || msg.__tag !== TAG) return;
    if (msg.type === "COMPLETION_SENT") {
      // Wait a beat for the backend to settle usage counters
      setTimeout(pokeBackground, 2500);
    } else if (msg.type === "SNIFFED_PAYLOAD") {
      const { url, body } = msg.payload || {};
      if (url && body) forwardSniffed(url, body);
    } else if (msg.type === "API_URL_SEEN") {
      forwardSeenUrl(msg.payload?.url);
    }
  });

  // SPA navigation detection. A MutationObserver on document.body fired on
  // every DOM mutation just to poll location.href — a cheap interval plus
  // popstate covers the same ground without the churn.
  let lastUrl = location.href;
  function checkUrlChanged() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(pokeBackground, 500);
    }
  }
  setInterval(checkUrlChanged, 2000);
  window.addEventListener("popstate", checkUrlChanged);

  // Initial poke on load
  setTimeout(pokeBackground, 1500);
})();
