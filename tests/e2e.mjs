// End-to-end check: loads dist-dev/ in Chromium against the mock servers and
// drives the real service worker + popup. Run with `npm run test:e2e`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startMocks } from "../dev/mock-server.mjs";
import { ORG } from "../dev/scenarios.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "dist-dev");
const shots = path.join(root, "tests", "artifacts");
fs.mkdirSync(shots, { recursive: true });

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
  for (const d of dirs.reverse()) {
    for (const arch of ["chrome-mac-arm64", "chrome-mac", "chrome-mac-x64"]) {
      const p = path.join(cache, d, arch, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined; // let Playwright look for its own
}

const mocks = await startMocks();
const ctx = await chromium.launchPersistentContext("", {
  executablePath: findChromium(),
  headless: false,
  args: ["--headless=new", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 340, height: 900 },
});

let failures = 0;
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`  ✔ ${name}`);
  } catch (e) {
    failures++;
    results.push(`  ✖ ${name}\n      ${String(e.message).split("\n").slice(0, 6).join("\n      ")}`);
  }
}

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);

  const setCookie = (origin, org) =>
    ctx.addCookies([{ name: "lastActiveOrg", value: org, url: origin }]);
  const clearCookies = () => ctx.clearCookies();
  const refresh = async () => {
    await popup.click("#refresh-btn");
    await popup.waitForFunction(() => document.getElementById("refresh-btn").textContent === "Refresh");
  };
  const badge = () =>
    popup.evaluate(async () => ({
      text: await chrome.action.getBadgeText({}),
      color: (await chrome.action.getBadgeBackgroundColor({})).slice(0, 3).join(","),
      title: await chrome.action.getTitle({}),
    }));
  const text = (sel) => popup.locator(sel).innerText();
  const visible = (sel) => popup.locator(sel).isVisible();
  const shot = (name) => popup.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
  const RED = "185,28,28", GREEN = "21,128,61", GREY = "82,82,91";

  // ── 1. Personal Max plan with a Fable weekly limit ────────────────────────
  mocks.claude.setScenario("max-fable");
  await setCookie(mocks.claude.origin, ORG.personal);
  await refresh();
  await step("Max + Fable: badge shows the worst gating limit (weekly 61%)", async () => {
    const b = await badge();
    assert.equal(b.text, "61%");
    assert.equal(b.color, GREEN);
    assert.match(b.title, /Session: 42%.*Weekly Fable: 88%/);
  });
  await step("Max + Fable: popup rows, tier, credits; no account tabs for one org", async () => {
    assert.equal(await text("#tier-pill"), "MAX 5×");
    assert.match(await text("#session-slot"), /SESSION \(5H\)\s*42%/);
    assert.match(await text("#weekly-secondary-slot"), /WEEKLY FABLE\s*88%/);
    assert.doesNotMatch(await text("body"), /Sonnet|Opus|Breakdown|Shares|NaN|undefined/i);
    assert.match(await text("#extra-detail"), /\$12\.34 of \$50\.00 · 25%/);
    assert.match(await text("#extra-detail"), /\$25\.00 balance · auto-reload on/);
    assert.equal(await visible("#account-tabs"), false);
    assert.equal(await visible("#error-prompt"), false);
  });
  await step("API-only org on the login is never polled for chat usage", async () => {
    assert.ok(!mocks.claude.getLog().some((p) => p.includes(ORG.apiOnly)));
  });
  await shot("1-max-fable");

  // ── 2. One login, two orgs: verified Ultra + Team seat ────────────────────
  mocks.claude.setScenario("multi-org");
  await refresh();
  await step("Multi-org: both orgs are fetched without switching the active org", async () => {
    const log = mocks.claude.getLog();
    assert.ok(log.includes(`/api/organizations/${ORG.personal}/usage`));
    assert.ok(log.includes(`/api/organizations/${ORG.team}/usage`));
    const cookies = await ctx.cookies(mocks.claude.origin);
    assert.equal(cookies.find((c) => c.name === "lastActiveOrg").value, ORG.personal);
  });
  await step("Ultra (no 5-hour limit): badge falls back to weekly-all", async () => {
    const b = await badge();
    assert.equal(b.text, "35%");
    assert.equal(await text("#tier-pill"), "ULTRA");
    assert.match(await text("#session-slot"), /No session limit on this plan/);
  });
  await step("Account tabs list both orgs with the right plans", async () => {
    const tabs = await popup.locator("#account-tabs .tab").allInnerTexts();
    assert.equal(tabs.length, 2);
    assert.match(tabs[0], /Personal\s*ULTRA/i);
    assert.match(tabs[1], /Max's Team\s*TEAM/i);
    const labels = await popup.locator("#account-tabs .tab").evaluateAll((n) => n.map((b) => b.getAttribute("aria-label")));
    assert.match(labels[0], /open in Claude/);
    assert.equal(await popup.locator("#account-tabs .tab .tab-dot").count(), 1);
  });
  await shot("2a-multi-org-ultra");
  await popup.locator("#account-tabs .tab").nth(1).click();
  await step("Team seat: plan is Team (not Max, despite the org name), member spend limit shown", async () => {
    assert.equal(await text("#tier-pill"), "TEAM");
    assert.match(await text("#session-slot"), /91%/);
    assert.match(await text("#weekly-secondary-slot"), /WEEKLY SONNET\s*10%/);
    assert.match(await text("#extra-detail"), /\$57\.32 of \$1,500\.00/);
    assert.match(await text("#extra-detail"), /your seat's monthly limit/);
    assert.equal(await text("#extra-enabled-pill"), "ON");
  });
  await shot("2b-multi-org-team");
  await step("Pinning the badge to the Team org", async () => {
    await popup.click("#pin-btn");
    await popup.waitForFunction(() => /pinned to this account/.test(document.getElementById("pin-label").textContent));
    assert.equal(await popup.locator("#account-tabs .tab .tab-pin").count(), 1);
    assert.equal(await popup.evaluate(() => document.activeElement?.id), "pin-btn", "focus stays put across re-render");
    const b = await badge();
    assert.equal(b.text, "91%");
    assert.equal(b.color, RED);
    assert.match(b.title, /^Max's Team/);
  });
  await step("One unreadable org doesn't blank a healthy pinned org or sign the user out", async () => {
    mocks.claude.setScenario("one-org-forbidden");
    await refresh();
    const b = await badge();
    assert.equal(b.text, "91%");
    assert.equal(await visible("#error-prompt"), false);
    await popup.locator("#account-tabs .tab").nth(0).click();
    assert.match(await text("#error-prompt-body"), /isn't authorized|sign in/i);
    await popup.locator("#account-tabs .tab").nth(1).click();
    mocks.claude.setScenario("multi-org");
    await refresh();
  });
  await step("A steady background cycle makes few requests", async () => {
    mocks.claude.setScenario("multi-org");
    await refresh();                       // forced: everything
    mocks.claude.setScenario("multi-org"); // clears the request log
    await refresh();
    const n = mocks.claude.getLog().length;
    assert.ok(n <= 12, `forced refresh for 2 orgs made ${n} requests`);
  });
  await step("Unpinning returns the badge to the active org", async () => {
    await popup.click("#pin-btn");
    await popup.waitForFunction(() => /showing another account/.test(document.getElementById("pin-label").textContent));
    assert.equal((await badge()).text, "35%");
  });
  await step("Switching the active org in Claude moves the badge (no stale plan)", async () => {
    await setCookie(mocks.claude.origin, ORG.team);
    await popup.reload();
    await refresh();
    assert.equal((await badge()).text, "91%");
    assert.equal(await text("#tier-pill"), "TEAM");
    await setCookie(mocks.claude.origin, ORG.personal);
    await refresh();
  });

  // ── 2c. The shape captured from a real Team organization ─────────────────
  await step("Live-captured Team payload renders correctly", async () => {
    mocks.claude.setScenario("team-live");
    await setCookie(mocks.claude.origin, ORG.team);
    await popup.reload();
    await refresh();
    assert.equal((await badge()).text, "2%");
    assert.equal(await text("#tier-pill"), "TEAM");
    assert.match(await text("#weekly-secondary-slot"), /WEEKLY FABLE\s*0%/);
    assert.equal(await text("#extra-enabled-pill"), "OFF");
    assert.match(await text("#extra-detail"), /Turned off for this organization/);
    assert.equal(await visible("#daily-group"), false, "codename nulls must not become rows");
    assert.doesNotMatch(await text("body"), /tangelo|iguana|nimbus|NaN|undefined/i);
    await shot("2c-team-live");
    await setCookie(mocks.claude.origin, ORG.personal);
    mocks.claude.setScenario("multi-org");
    await popup.reload();
    await refresh();
  });

  await step("Live-captured Max 20× + Team login renders correctly", async () => {
    mocks.claude.setScenario("work-live");
    await popup.reload();
    await refresh();
    assert.equal((await badge()).text, "13%");
    assert.equal(await text("#tier-pill"), "MAX 20×");
    assert.match(await text("#session-slot"), /No session limit on this plan/);
    assert.equal(await text("#extra-enabled-pill"), "PAUSED");
    assert.match(await text("#extra-detail"), /\$0\.00 of \$200\.00/);
    assert.match(await text("#extra-detail"), /Out of credits/);
    await shot("2d-work-live-max");
    await popup.locator("#account-tabs .tab").nth(1).click();
    assert.equal(await text("#tier-pill"), "TEAM");
    assert.match(await text("#session-slot"), /0%/);
    assert.equal(await text("#extra-enabled-pill"), "OFF");
    mocks.claude.setScenario("multi-org");
    await popup.reload();
    await refresh();
  });

  // ── 3. Content script: a claude.ai tab triggers a refresh on its own ──────
  await step("Opening a Claude tab pokes the service worker", async () => {
    mocks.claude.setScenario("max-fable");
    await new Promise((r) => setTimeout(r, 21000)); // past the global cycle floor
    const tab = await ctx.newPage();
    await tab.goto(mocks.claude.origin + "/");
    await popup.waitForFunction(async () => (await chrome.action.getBadgeText({})) === "61%", null, { timeout: 15000 });
    await tab.close();
  });

  // ── 4. Legacy payload + fallback tier detection ───────────────────────────
  mocks.claude.setScenario("legacy");
  await popup.reload();
  await refresh();
  await step("Legacy payload: buckets, readable versioned label, fallback tier", async () => {
    assert.equal((await badge()).text, "20%");
    assert.equal(await text("#tier-pill"), "MAX 20×");
    assert.match(await text("#weekly-secondary-slot"), /WEEKLY OPUS 5\.5\s*3%/);
    assert.match(await text("#daily-slot"), /WEEKLY COWORK\s*Not active/i);
    assert.doesNotMatch(await text("body"), /Usage Credits\s*100%/i);
    assert.equal(await text("#extra-enabled-pill"), "OFF");
  });
  await shot("4-legacy");

  // ── 5. Failure modes ──────────────────────────────────────────────────────
  mocks.claude.setScenario("rate-limited");
  await refresh();
  await step("429: keeps last numbers, says so, and backs off background polling", async () => {
    assert.equal((await badge()).text, "20%");
    assert.match(await text("#error-label"), /Rate limited/);
    mocks.claude.setScenario("legacy");
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "CLAUDE_USAGE_UPDATE" }));
    assert.equal(mocks.claude.getLog().length, 0, "non-forced refresh must respect the backoff");
  });

  mocks.claude.setScenario("shape-change");
  await refresh();
  await step("Unrecognised /usage shape is reported as an API change, not a network error", async () => {
    assert.match(await text("#error-label"), /new format/);
    assert.doesNotMatch(await text("#error-label"), /Network error/);
  });

  mocks.claude.setScenario("signed-out");
  await refresh();
  await step("Session expired (401): badge '!' and the sign-in prompt show despite cached data", async () => {
    const b = await badge();
    assert.equal(b.text, "!");
    assert.equal(b.color, GREY);
    assert.equal(await visible("#error-prompt"), true);
    assert.match(await text("#error-prompt-title"), /SESSION EXPIRED/i);
  });
  await clearCookies();
  await refresh();
  await step("Signed out (no cookie): 'Sign in to Claude' prompt", async () => {
    assert.equal((await badge()).text, "!");
    assert.match(await text("#error-prompt-title"), /SIGN IN TO CLAUDE/i);
  });
  await shot("5-signed-out");

  mocks.claude.setScenario("max-fable");
  await setCookie(mocks.claude.origin, ORG.personal);
  await refresh();
  await step("Signing back in recovers cleanly", async () => {
    assert.equal((await badge()).text, "61%");
    assert.equal(await visible("#error-prompt"), false);
    assert.equal(await text("#tier-pill"), "MAX 5×");
  });

  // ── 6. API Console ────────────────────────────────────────────────────────
  await step("Console is off by default and nothing is requested from it", async () => {
    assert.equal(await visible("#console-block"), false);
    assert.equal(await visible("#console-connect-btn"), true);
    assert.equal(mocks.console.getLog().length, 0);
  });
  await setCookie(mocks.console.origin, ORG.console);
  await popup.click("#console-connect-btn");
  await popup.waitForFunction(() => /Credit balance/.test(document.getElementById("console-rows").textContent), null, { timeout: 15000 });
  await step("Console connected: balance, month spend vs limit, auto-reload, tier", async () => {
    const rows = await text("#console-rows");
    assert.match(rows, /Credit balance\s*\$43\.21/);
    assert.match(rows, /Spend this month\s*\$18\.75/);
    assert.match(rows, /Auto-reload\s*Off/);
    assert.match(rows, /Credits expire\s*in 1[34]d/);
    assert.ok(!mocks.console.getLog().some((p) => p.includes(ORG.personal)), "chat orgs are never asked for Console billing");
    assert.equal(await text("#console-title"), "ACME API");
    assert.match((await badge()).title, /API balance: \$43\.21/);
  });
  await shot("6-console");
  mocks.console.setScenario("unknown");
  await refresh();
  await step("Console with unrecognised fields fails soft with a clear message", async () => {
    assert.match(await text("#console-detail"), /format this version doesn't understand/);
    assert.doesNotMatch(await text("#console-section"), /NaN|undefined|null/);
  });
  mocks.console.setScenario("signed-out");
  await refresh();
  await step("Console signed out: prompts to sign in; Claude data unaffected", async () => {
    assert.match(await text("#console-detail"), /Sign in to the API Console/);
    assert.equal((await badge()).text, "61%");
  });
  await popup.click("#console-toggle-btn");
  await popup.waitForFunction(() => document.getElementById("console-block").style.display === "none");
  await step("Disconnect stops Console polling", async () => {
    mocks.console.setScenario("ok");
    await refresh();
    assert.equal(mocks.console.getLog().length, 0);
  });

  // ── 7. Upgrade path from the published v0.4.1 state ───────────────────────
  await step("Stored v0.4.1 state is migrated, not wiped", async () => {
    await popup.evaluate(async () => {
      await chrome.storage.local.set({
        usageState: {
          buckets: [{ key: "five_hour", label: "Session (5h)", utilization: 55, resetsAt: Date.now() + 3600_000, inactive: false }],
          routineRuns: null,
          extraUsage: { enabled: false, status: "off" },
          subscriptionTier: "pro", tierFetchedAt: Date.now(),
          orgId: "99999999-9999-4999-8999-999999999999",
          lastUpdated: Date.now(), lastError: null, errorCode: null,
        },
      });
    });
    await popup.reload();
    await popup.waitForFunction(() => /55%/.test(document.getElementById("session-slot").textContent));
    assert.equal(await text("#tier-pill"), "PRO");
  });

} catch (e) {
  failures++;
  results.push(`  ✖ harness error: ${e.message}`);
} finally {
  await ctx.close();
  await mocks.claude.close();
  await mocks.console.close();
}

console.log(results.join("\n"));
console.log(failures ? `\n${failures} FAILED` : `\nall ${results.length} e2e checks passed — screenshots in tests/artifacts/`);
process.exit(failures ? 1 : 0);
