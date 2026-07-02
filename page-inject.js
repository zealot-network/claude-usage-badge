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
    /\/cowork/i,
    /\/usage/i,
    /\/schedule[ds]?\b/i,
    /\/scheduled[-_]?tasks?\b/i,
    /\/automations?\b/i,
  ];

  function post(type, payload) {
    try {
      // Same-window bridge only — scope to our own origin, never "*".
      window.postMessage({ __tag: TAG, type, payload }, location.origin);
    } catch {
      // ignore
    }
  }

  // fetch() accepts strings, URL objects, and Request objects.
  function urlOf(input) {
    try {
      if (typeof input === "string") return input;
      if (input instanceof Request) return input.url;
      if (input instanceof URL) return input.href;
      return input != null ? String(input) : null;
    } catch {
      return null;
    }
  }

  function handleResponse(url, response) {
    try {
      if (!url) return;

      if (url.includes("/completion") || url.includes("/retry_completion")) {
        post("COMPLETION_SENT", { url });
      }

      if (url.includes("/api/")) {
        // Log the URL (no body) for diagnostics so new endpoints can be
        // discovered by inspection if the sniff patterns miss them.
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
      handleResponse(urlOf(args[0]), response);
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
      // Non-enumerable so the marker doesn't show up in page code that
      // iterates XHR instances.
      Object.defineProperty(this, "__cub_url", {
        value: typeof url === "string" ? url : urlOf(url),
        writable: true,
        configurable: true,
        enumerable: false,
      });
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
