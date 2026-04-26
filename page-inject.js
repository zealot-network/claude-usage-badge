// page-inject.js — Runs in the PAGE'S main world on claude.ai/*.
// Content scripts normally run in an isolated world, so patching window.fetch
// there wouldn't intercept the SPA's real network calls. This file runs in the
// main world (manifest "world": "MAIN") and posts payloads back out via
// window.postMessage, which the isolated content-script.js bridges to the
// background service worker via chrome.runtime.sendMessage.

(function () {
  "use strict";

  const TAG = "__CLAUDE_USAGE_BADGE__";

  // Patterns whose response bodies are worth forwarding in full.
  const SNIFF_PATTERNS = [
    /\/routines?\b/i,
    /\/run[-_]?budget/i,
    /\/agent[s]?\b.*budget/i,
    /\/budget/i,
    /\/usage/i,
    /\/schedule[ds]?\b/i,
    /\/scheduled[-_]?tasks?\b/i,
    /\/automations?\b/i,
    /\/cron/i,
    /\/task[s]?\b.*budget/i,
  ];

  function post(type, payload) {
    try {
      window.postMessage({ __tag: TAG, type, payload }, "*");
    } catch {
      // ignore
    }
  }

  function handleResponse(url, response) {
    try {
      if (!url) return;

      if (url.includes("/completion") || url.includes("/retry_completion")) {
        post("COMPLETION_SENT", { url });
      }

      if (url.includes("/api/")) {
        // Always log the URL (no body) for diagnostics so we can find the
        // routine-runs endpoint by inspection if heuristics miss it.
        post("API_URL_SEEN", { url });

        if (SNIFF_PATTERNS.some((p) => p.test(url))) {
          response
            .clone()
            .json()
            .then((body) => post("SNIFFED_PAYLOAD", { url, body }))
            .catch(() => {});
        }
      }
    } catch {
      // Never break page traffic
    }
  }

  // ── Patch fetch ─────────────────────────────────────────────────────────
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      handleResponse(url, response);
      return response;
    };
  }

  // ── Patch XMLHttpRequest ────────────────────────────────────────────────
  // Some SPAs mix fetch + XHR, so intercept both to be safe.
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      this.__cub_url = url;
      return origOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function (...sendArgs) {
      this.addEventListener("load", function () {
        try {
          const url = this.__cub_url;
          if (!url || !url.includes("/api/")) return;
          post("API_URL_SEEN", { url });
          if (SNIFF_PATTERNS.some((p) => p.test(url))) {
            try {
              const body = JSON.parse(this.responseText);
              post("SNIFFED_PAYLOAD", { url, body });
            } catch {
              // not JSON, skip
            }
          }
        } catch {}
      });
      return origSend.apply(this, sendArgs);
    };
  }
})();
