# Claude Usage Badge

A Chrome extension that puts your Claude usage in your browser toolbar.

The badge shows your current 5-hour session percentage at a glance. Click it for the full breakdown — every limit your plan exposes, plus extra usage status and reset times.

## Features

**Session & weekly limits**
- Session (5-hour) bar with reset countdown
- Weekly (7-day) bar across all models
- Separate bars for Weekly Sonnet, Weekly Opus, and Weekly Claude Design
- Scheduled (cowork) and OAuth apps buckets, shown muted until first use
- Auto-discovers any new bucket Claude adds to its `/usage` endpoint — no extension update required

**Extra usage**
- ON/OFF and IN USE indicators
- Monthly spend vs. limit with progress bar
- Remaining prepaid balance
- Reset date

**Subscription tier**
- Accurate plan pill: Free, Pro, Team, Enterprise, Max 5×, Max 20×

**Error handling**
- If your Claude session has expired or you aren't signed in, the popup guides you to claude.ai/settings/usage and back with a one-click Refresh

## Install

### From the Chrome Web Store

**[Install Claude Usage Badge](https://chromewebstore.google.com/detail/claude-usage-badge/bdbeebogoncglnhmcmieifebjbkkfepg)**

### From source (developer mode)

1. Clone this repo
2. Visit `chrome://extensions`
3. Toggle **Developer mode** on (top right)
4. Click **Load unpacked** → select this folder
5. Sign in to claude.ai. The badge populates within a few seconds.

## How it works

The extension reads Claude's own usage API — the same data Claude's frontend uses — to show your real utilization numbers.

- `background.js` — service worker, single source of truth. Polls `/api/organizations/{orgId}/usage` every 3 minutes plus on-demand. Dynamically extracts any object shaped `{ utilization, resets_at }` so new buckets surface automatically.
- `page-inject.js` — runs in the page's main world (manifest `"world": "MAIN"`) to patch `window.fetch`/`XMLHttpRequest` and observe the SPA's own API traffic. Lets us discover endpoints Anthropic adds without code changes.
- `content-script.js` — runs in the isolated world, bridges main-world events to the service worker via `chrome.runtime.sendMessage`.
- `popup.html` / `popup.js` — the UI. Renders bars dynamically from whatever buckets the background found.

## Permissions

- `storage` — persists usage state between browser restarts
- `cookies` — reads the `lastActiveOrg` cookie on `claude.ai` to construct the usage API URL
- `alarms` — periodic background refresh every 3 minutes
- `host_permissions: ["https://claude.ai/*"]` — required to call Claude's API on your behalf

**No data leaves your browser.** No third-party servers. No analytics. No tracking.

## Development

There's no build step. Edit the files in place and reload the extension at `chrome://extensions` (↻ icon on the extension card). For changes to `content-script.js` or `page-inject.js`, also reload any open `claude.ai` tabs.

To package for the Chrome Web Store:

```bash
zip -r ../claude-usage-badge.zip . -x "*.DS_Store" -x "__MACOSX/*" -x ".git/*"
```

## License

MIT — see [LICENSE](LICENSE).
