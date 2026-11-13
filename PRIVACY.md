# Privacy Policy — Claude Usage Badge

_Applies to version 0.5.0 and later. Last updated: 13 November 2026._

Claude Usage Badge is an unofficial, open-source Chrome extension that shows your Claude usage in your browser toolbar. It is not affiliated with Anthropic.

**In short: everything the extension reads stays in your browser. Nothing is sent to the developer or to any third party. There are no analytics and no tracking in the extension.**

## What the extension reads

The extension makes requests to Anthropic's own websites using the session you are already signed in with. It never sees or stores your password or your session cookie's value.

From **claude.ai** (always):

- The list of Claude organizations on your login: each one's id, name, plan type and capabilities. A personal organization's name can contain your email address.
- For each organization that can chat: your usage limits (session, weekly, per-model), reset times, and usage-credit status — whether credits are on, month-to-date spend, your spend limit, prepaid balance and auto-reload setting.
- Your plan (for example Pro, Max, Team). To work this out for some accounts, the extension requests Claude's subscription and app start-up data and keeps only the plan name.
- One cookie, `lastActiveOrg`, which holds the id of the organization currently open in Claude. No other cookie is read.

From **platform.claude.com** (only if you click **Connect API Console**):

- The `lastActiveOrg` cookie on that site, and the list of organizations on your Console login (id, name, capabilities).
- For your API organization: prepaid credit balance, auto-reload setting, credit expiry date, month-to-date API spend and its reset date.

Chrome asks for your permission before the extension can access platform.claude.com. Clicking **Disconnect** removes that permission and deletes the stored Console figures.

## What runs on claude.ai pages

Two small scripts run on claude.ai:

- One runs in the page itself and wraps the page's network functions (`fetch` and `XMLHttpRequest`). It does two things: it notices when you send a message, so the badge can refresh promptly, and it reads the response of claude.ai's own scheduled-run budget endpoint when the page loads it. It does not read your conversations, prompts, files, or any other response.
- The other passes those two signals to the extension's background worker.

## What is stored, and where

The figures listed above are saved in Chrome's local extension storage (`chrome.storage.local`) on your device so the badge survives a browser restart. Short-lived timing data used to avoid over-requesting is kept in session storage and cleared when the browser closes.

Nothing is stored anywhere else. The extension has no server.

## What is shared

Nothing. The extension sends requests only to claude.ai and, if you connect it, platform.claude.com — the same sites the data comes from. No data is transmitted to the developer, to advertisers, or to any other third party, and none is sold.

## Limited Use

Claude Usage Badge's use of information received from Anthropic's websites adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements:

- **Allowed use.** The data is used only to provide the extension's single purpose: showing you your own Claude usage and spend.
- **Allowed transfer.** The data is not transferred to anyone. It never leaves your browser.
- **No advertising.** The data is not used for personalized, retargeted or interest-based advertising, or for any advertising at all.
- **No human reading.** No person, including the developer, can read your data, because it is never transmitted off your device.

## Removing your data

Uninstalling the extension deletes everything it stored. Clicking **Disconnect** on the API Console card deletes the stored Console figures on its own.

## The Chrome Web Store listing

The developer may enable Google Analytics on the extension's Chrome Web Store listing page to count visits to that page. That is a feature of the store, covered by Google's privacy policy, and is separate from the extension: the extension itself contains no analytics and reports nothing about how you use it.

## Changes

Material changes to this policy will be recorded in this file's history in the public repository.

## Contact

Questions or concerns: open an issue at <https://github.com/zealot-network/claude-usage-badge/issues>.
