// dev/store-assets.mjs — regenerates the Chrome Web Store graphics from the
// REAL popup (dev build + mock data), so the art can't drift from the product.
//
//   npm run store-assets                       → ../store-assets/v<version>/
//   STORE_NAME="Usage Tracker for Claude" npm run store-assets
//
// Requires a dev build made with --grant-console (the npm script does this).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { startMocks } from "./mock-server.mjs";
import { ORG } from "./scenarios.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "dist-dev");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const NAME = process.env.STORE_NAME || manifest.name;
const outDir = path.resolve(root, "..", "store-assets", `v${manifest.version}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cub-assets-"));
fs.mkdirSync(outDir, { recursive: true });
const icon = pathToFileURL(path.join(root, "icons", "icon128.png")).href;

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
  return undefined;
}

const mocks = await startMocks();
const ctx = await chromium.launchPersistentContext("", {
  executablePath: findChromium(),
  headless: false,
  args: ["--headless=new", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 300, height: 700 },
  deviceScaleFactor: 2,
});

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const refresh = async () => {
    await popup.click("#refresh-btn");
    await popup.waitForFunction(() => document.getElementById("refresh-btn").textContent === "Refresh");
  };
  const cookie = (origin, org) => ctx.addCookies([{ name: "lastActiveOrg", value: org, url: origin }]);
  // Capture the popup, optionally hiding sections that aren't the point of a shot.
  const capture = async (name, hide = []) => {
    await popup.addStyleTag({ content: "*{transition:none!important}" });
    await popup.evaluate((sels) => {
      document.querySelectorAll("[data-shot-hidden]").forEach((n) => { n.style.display = n.dataset.shotHidden; delete n.dataset.shotHidden; });
      for (const s of sels) document.querySelectorAll(s).forEach((n) => { n.dataset.shotHidden = n.style.display; n.style.display = "none"; });
    }, hide);
    const h = await popup.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    await popup.setViewportSize({ width: 300, height: h });
    const file = path.join(tmp, `${name}.png`);
    await popup.screenshot({ path: file });
    return { url: pathToFileURL(file).href, h };
  };

  await cookie(mocks.claude.origin, ORG.personal);
  mocks.claude.setScenario("max-fable");
  await refresh();
  const hero = await capture("hero");

  mocks.claude.setScenario("credits-in-use");
  await refresh();
  const credits = await capture("credits");

  mocks.claude.setScenario("multi-org");
  await refresh();
  await popup.locator("#account-tabs .tab").nth(1).click();
  const team = await capture("team");

  mocks.claude.setScenario("max-fable");
  await popup.reload();
  await refresh();
  await cookie(mocks.console.origin, ORG.console);
  await popup.click("#console-connect-btn");
  await popup.waitForFunction(() => /Credit balance/.test(document.getElementById("console-rows").textContent));
  const con = await capture("console", ["#weekly-secondary-heading", "#weekly-secondary-slot"]);

  // ── Compose the marketing frames ──────────────────────────────────────────
  const css = `
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#fff;
      background:radial-gradient(900px 620px at 28% 12%,#2a1a15 0%,rgba(42,26,21,0) 60%),
                 radial-gradient(700px 520px at 82% 92%,#11261a 0%,rgba(17,38,26,0) 62%),#0f0f0f;
      overflow:hidden;-webkit-font-smoothing:antialiased}
    .frame{position:relative;width:100vw;height:100vh;display:flex;align-items:center}
    .copy{position:absolute;left:90px;top:50%;transform:translateY(-50%);width:560px}
    .brand{display:flex;align-items:center;gap:16px;font-size:20px;font-weight:600;margin-bottom:38px}
    .brand img{width:56px;height:56px}
    h1{font-size:50px;line-height:1.14;font-weight:700;letter-spacing:-1.2px;margin-bottom:26px}
    .sub{font-size:20px;line-height:1.6;color:#a3a3a3;margin-bottom:34px}
    ul{list-style:none}
    li{font-size:19px;line-height:1;margin-bottom:18px;display:flex;align-items:center;gap:14px;color:#f5f5f5}
    li::before{content:"";width:11px;height:11px;background:#D97757;transform:rotate(45deg);flex:none;margin:0 5px}
    .shot{position:absolute;right:90px;top:50%;transform:translateY(-50%);border:1px solid #2a2a2a;border-radius:14px;
      overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.55);background:#0f0f0f}
    .shot img{display:block;width:300px}
    .center{flex-direction:column;justify-content:center;text-align:center}
    .center .brand{margin-bottom:30px}
    .grid{display:grid;grid-template-columns:440px 440px;gap:18px;margin:44px 0 44px}
    .card{display:flex;align-items:center;gap:16px;text-align:left;font-size:18px;line-height:1.3;padding:26px 22px;
      background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px}
    .tick{flex:none;width:30px;height:30px;border-radius:50%;border:1.5px solid #D97757;background:rgba(217,119,87,.15);
      color:#D97757;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px}
    .fine{font-size:15px;color:#a3a3a3;line-height:1.7}.fine b{color:#D97757;font-weight:500}
    .eyebrow{font-size:14px;letter-spacing:2.4px;font-weight:600;color:#D97757;text-transform:uppercase;margin-bottom:16px}
  `;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const brand = `<div class="brand"><img src="${icon}" alt=""><span>${esc(NAME)}</span></div>`;
  const split = ({ h1, sub, bullets, shot }) => {
    const scale = Math.min(1.22, 660 / shot.h);
    return `<div class="frame"><div class="copy">${brand}<h1>${h1}</h1><p class="sub">${sub}</p>
      <ul>${bullets.map((b) => `<li>${b}</li>`).join("")}</ul></div>
      <div class="shot" style="zoom:${scale}"><img src="${shot.url}"></div></div>`;
  };
  const frames = {
    "screenshot-1-1280x800": split({
      h1: "Never hit a limit<br>by surprise.",
      sub: "Every Claude limit — session, weekly, per-model, and usage credits — live in your toolbar.",
      bullets: ["Session &amp; weekly usage at a glance", "Fable weekly limit, tracked separately", "Plan tier &amp; reset countdowns"],
      shot: hero,
    }),
    "screenshot-2-1280x800": split({
      h1: "Know the moment<br>your credits kick in.",
      sub: "The badge turns red and flags “IN USE” the instant a limit is exhausted — so you never spend credits blind.",
      bullets: ["Monthly spend vs. limit, as a live bar", "Prepaid balance &amp; auto-reload status", "Over-limit states flagged in red"],
      shot: credits,
    }),
    "screenshot-3-1280x800": split({
      h1: "Every account.<br>One badge.",
      sub: "Personal plan and a Team seat on the same login? See both, and pin the badge to the one you care about.",
      bullets: ["Switch accounts without leaving the popup", "Team seats with per-member spend limits", "Pin the badge, or let it follow Claude"],
      shot: team,
    }),
    "screenshot-4-1280x800": split({
      h1: "API spend,<br>next to your plan.",
      sub: "Optionally connect the API Console to see your credit balance and this month's spend in the same popup.",
      bullets: ["Credit balance &amp; auto-reload", "Month-to-date spend and credit expiry", "Off until you turn it on"],
      shot: con,
    }),
    "screenshot-5-1280x800": `<div class="frame center">${brand}<h1>Private by design.</h1>
      <p class="sub" style="margin:0">Your usage data stays between you and Anthropic.</p>
      <div class="grid">
        <div class="card"><span class="tick">✓</span>No data leaves your browser</div>
        <div class="card"><span class="tick">✓</span>No third-party servers, analytics, or tracking</div>
        <div class="card"><span class="tick">✓</span>Reads only your own Claude account's usage data</div>
        <div class="card"><span class="tick">✓</span>Open source — MIT licensed on GitHub</div>
      </div>
      <p class="fine">Independent open-source project — not affiliated with, endorsed by, or sponsored by Anthropic.<br>
      <b>${esc((manifest.homepage_url || "").replace(/^https?:\/\//, ""))}</b></p></div>`,
    "promo-marquee-1400x560": `<div class="frame"><img src="${icon}" style="position:absolute;left:104px;top:50%;transform:translateY(-50%);width:292px;height:292px">
      <div style="position:absolute;left:480px;top:50%;transform:translateY(-50%);width:820px">
      <div class="eyebrow">${esc(NAME)}</div><h1 style="font-size:66px;letter-spacing:-1.8px">Never hit a limit<br>by surprise.</h1>
      <p class="sub" style="margin:0;font-size:22px">Session, weekly, per-model, and usage-credit limits — every Claude limit, live in your toolbar.</p></div></div>`,
    "promo-small-440x280": `<div class="frame"><div style="position:absolute;left:34px;top:44px;right:24px">
      <div class="brand" style="font-size:15px;gap:14px;margin-bottom:26px"><img src="${icon}" style="width:62px;height:62px"><span>${esc(NAME)}</span></div>
      <h1 style="font-size:31px;letter-spacing:-.7px;margin-bottom:16px">Never hit a limit<br>by surprise.</h1>
      <p class="sub" style="font-size:14.5px;margin:0">Your Claude usage, live in the toolbar.</p></div></div>`,
  };

  const page = await ctx.newPage();
  for (const [name, body] of Object.entries(frames)) {
    const [w, h] = name.match(/(\d+)x(\d+)$/).slice(1).map(Number);
    const file = path.join(tmp, `${name}.html`);
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>${css}</style>${body}`);
    await page.setViewportSize({ width: w, height: h });
    await page.goto(pathToFileURL(file).href);
    // 24-bit JPEG at exact store dimensions (no alpha, 1x).
    await page.screenshot({ path: path.join(outDir, `${name}.jpg`), type: "jpeg", quality: 93, scale: "css" });
  }
  console.log(`store assets (${NAME}) → ${outDir}`);
} finally {
  await ctx.close();
  await mocks.claude.close();
  await mocks.console.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
