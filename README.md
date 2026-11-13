# Claude Usage Badge

A Chrome extension that puts your Claude usage in your browser toolbar.

> **Unofficial.** This is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic, PBC, used here only to describe what the extension does.

The badge shows the limit you're closest to hitting — your 5-hour session or your weekly all-models limit — at a glance. Click it for the full breakdown: every limit your plan exposes, usage-credits status, and reset times.

## Features

**Session & weekly limits**
- Session (5-hour) bar with reset countdown
- Weekly (7-day) bar across all models
- Per-model weekly limits (e.g. Weekly Fable) using the model names Claude itself reports — new models show up without an extension update
- Plans without a 5-hour limit (verified Ultra) are handled: the badge follows the weekly limit instead of going blank
- Badge colour escalates on your worst *gating* limit (session or weekly-all). A maxed per-model limit is shown in the popup but doesn't hijack the headline number.

**Usage credits (extra usage)**
- ON / PAUSED / OFF status, with IN USE and over-limit indicators
- Monthly spend vs. limit with progress bar — shows true % even when over 100
- Remaining prepaid balance and auto-reload status
- Understands the "paused because you hit the cap" state, not just on/off

**Multiple organizations on one login**
- If your login belongs to more than one Claude organization (say a personal plan and a Team seat), the popup shows a tab per organization
- The badge follows whichever organization is open in Claude, or you can pin it to one
- Separate logins still need separate Chrome profiles — the extension never stores or swaps session cookies

**Team & Enterprise seats**
- Seat limits are tracked per organization, with the plan shown as Team / Enterprise
- Shows your seat's own monthly spend limit when your organization sets one

**API Console (optional)**
- Click **Connect** in the popup to also show your API credit balance and this month's API spend from platform.claude.com
- Off by default. Chrome asks for access to platform.claude.com only when you turn it on; Disconnect removes it again

**Subscription tier**
- Plan pill: Free, Pro, Team, Enterprise, Max 5×, Max 20×, Ultra

**Error handling**
- If you're signed out or your session expired, the badge shows `!` and the popup walks you back in — old numbers are never shown as if they were live
- If Claude's usage data comes back in a form the extension can't read at all, the popup says so instead of blaming your network

> **Heads-up on accuracy.** Everything here reads undocumented endpoints that Anthropic can change at any time. Max, Team and API Console responses were checked against real accounts in November 2026; per-member Team spend limits and Enterprise seats are built from publicly reported response shapes only — if a figure looks wrong, please open an issue.

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

- `background.js` — service worker and single source of truth. Lists the organizations on your login (`/api/organizations`), polls `/api/organizations/{orgId}/usage` for the one on the badge every 3 minutes (others every ~12 minutes), and stores one record per organization. While you're chatting, a claude.ai tab can prompt a lighter usage-only refresh, at most once every 20 seconds.
- `lib/core.js` — all parsing and badge logic as pure functions (no `chrome.*`), so it can be unit-tested.
- `lib/entitlements.js` — single switch for optional features. Everything is unlocked.
- `config.js` — the only place origins are defined.
- `page-inject.js` / `content-script.js` — run on claude.ai to notice when you send a message (so the badge refreshes promptly) and to pick up the scheduled-run budget when Claude's own page loads it. No page content or conversation data is read.
- `popup.html` / `popup.js` — the UI.

## Permissions

- `storage` — persists usage state between browser restarts
- `cookies` — reads the `lastActiveOrg` cookie to know which organization is open in Claude
- `alarms` — periodic background refresh every 3 minutes
- `host_permissions: ["https://claude.ai/*"]` — required to call Claude's usage API on your behalf
- `optional_host_permissions: ["https://platform.claude.com/*"]` — requested **only** if you click Connect on the API Console card

**No data leaves your browser.** Requests go only to claude.ai (and platform.claude.com if you connect it). No third-party servers. No analytics. No tracking.

## Development

There's no build step for the extension itself. Edit the files in place and reload at `chrome://extensions`. For changes to `content-script.js` or `page-inject.js`, also reload any open `claude.ai` tabs.

Dev tooling (Node 20+, only needed for tests):

```bash
npm install
npm test              # unit tests for lib/core.js
npm run test:e2e      # loads a dev build in Chromium against local mock servers
npm run mock          # run the mock claude.ai / API Console servers by hand
npm run build:dev     # write dist-dev/, a build that talks to the mocks — load it unpacked
npm run store-assets  # regenerate Chrome Web Store graphics from the real popup
npm run package       # build the Chrome Web Store zip (shipped files only)
```

`dev/scenarios.mjs` holds the canned API responses (personal Max, multi-org with a Team seat, legacy payloads, signed-out, rate-limited, …). Add a scenario there when Anthropic changes a payload, then cover it in `tests/`.

## License

MIT — see [LICENSE](LICENSE).
