// Unit tests for lib/core.js — run with `npm test` (node --test, no deps).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../lib/core.js";
import { CLAUDE_SCENARIOS, CONSOLE_SCENARIOS, ORG } from "../dev/scenarios.mjs";

const NOW = 1_800_000_000_000;
const usageOf = (scenario, org) => {
  const v = CLAUDE_SCENARIOS[scenario][`/api/organizations/${org}/usage`];
  return typeof v === "function" ? v() : v;
};
const stateWith = (acct, extra = {}) => ({
  ...core.defaultState(),
  activeOrgId: "o1",
  accounts: { o1: { ...core.defaultAccount("o1"), lastUpdated: NOW, ...acct } },
  ...extra,
});
const keys = (buckets) => buckets.map((b) => b.key);

// ── limits[] ────────────────────────────────────────────────────────────────

test("limits[]: session, weekly-all and Fable map to stable keys", () => {
  const { buckets } = core.parseUsage(usageOf("max-fable", ORG.personal));
  assert.deepEqual(keys(buckets), ["five_hour", "seven_day", "seven_day_fable"]);
  assert.equal(buckets[2].label, "Weekly Fable");
  assert.equal(buckets[2].severity, "warning");
  assert.equal(buckets[2].scopeType, "model");
});

test("limits[]: non-limit and retired legacy keys never become rows", () => {
  const { buckets } = core.parseUsage(usageOf("max-fable", ORG.personal));
  for (const b of buckets) {
    assert.ok(!/breakdown|shares|spend|credits|sonnet|opus|cowork/.test(b.key), b.key);
  }
});

test("limits[]: a live legacy-only bucket is kept alongside limits", () => {
  const { buckets } = core.parseUsage({
    limits: [{ kind: "session", percent: 10 }],
    seven_day: { utilization: 95, resets_at: "2030-01-01T00:00:00Z" },
    seven_day_omelette: { utilization: 80, resets_at: "2030-01-01T00:00:00Z" },
    seven_day_sonnet: { utilization: 0, resets_at: null },
  });
  assert.deepEqual(keys(buckets), ["five_hour", "seven_day_omelette"]);
});

test("limits[]: versioned model names, surfaces and duplicates stay distinct", () => {
  const b = core.bucketsFromLimits([
    { kind: "weekly_scoped", percent: 1, scope: { model: { display_name: "Fable 5.2" } } },
    { kind: "weekly_scoped", percent: 2, scope: { model: { display_name: "Fable 5.2" }, surface: "claude_code" } },
    { kind: "weekly_scoped", percent: 3, scope: { surface: "claude_code" } },
    { kind: "weekly_scoped", percent: 4 },
    { kind: "weekly_scoped", percent: 5, scope: {} },
    { kind: 42, percent: 6 },
    null,
  ]);
  assert.equal(new Set(keys(b)).size, b.length, "keys are unique");
  assert.equal(b[0].label, "Weekly Fable 5.2");
  assert.equal(b[1].label, "Weekly Fable 5.2 (Claude Code)");
  assert.equal(b[2].label, "Weekly Claude Code");
  assert.equal(b[2].scopeType, "surface");
  assert.equal(b[5].key, "unknown");
});

// ── legacy payloads ─────────────────────────────────────────────────────────

test("legacy: versioned keys get readable labels; credits objects are not buckets", () => {
  const { buckets, extraUsage } = core.parseUsage(usageOf("legacy", ORG.personal));
  assert.deepEqual(keys(buckets), ["five_hour", "seven_day", "seven_day_cowork", "seven_day_opus_5_5"]);
  assert.equal(buckets.find((b) => b.key === "seven_day_opus_5_5").label, "Weekly Opus 5.5");
  assert.equal(buckets.find((b) => b.key === "seven_day_cowork").inactive, true);
  assert.equal(extraUsage.status, "off");
  assert.equal(extraUsage.inUse, false);
});

test("parseUsage rejects non-object payloads with a ShapeError", () => {
  for (const bad of [null, [], "x", 3]) {
    assert.throws(() => core.parseUsage(bad), core.ShapeError);
  }
});

// ── credits ─────────────────────────────────────────────────────────────────

test("credits: spend object → on, dollars, uncapped utilization", () => {
  const { extraUsage: e } = core.parseUsage(usageOf("max-fable", ORG.personal));
  assert.equal(e.status, "on");
  assert.equal(e.spentUsd, 12.34);
  assert.equal(e.limitUsd, 50);
  assert.ok(Math.abs(e.utilization - 24.68) < 0.001);
  assert.equal(e.inUse, false);
  assert.equal(e.overLimit, false);
});

test("credits: over-limit while OFF does not flag over-limit or turn the badge red", () => {
  const usd = (c) => ({ amount_minor: c, exponent: 2 });
  const { buckets, extraUsage } = core.parseUsage({
    limits: [{ kind: "session", percent: 3 }],
    spend: { enabled: false, used: usd(5100), limit: usd(5000) },
  });
  assert.equal(extraUsage.status, "off");
  assert.equal(extraUsage.overLimit, false);
  assert.equal(core.computeBadge(stateWith({ buckets, extraUsage }), NOW).color, core.COLOR_GREEN);
});

test("credits: a maxed per-model bucket alone is not 'IN USE'", () => {
  const { extraUsage } = core.parseUsage({
    limits: [
      { kind: "session", percent: 5 },
      { kind: "weekly_all", percent: 10 },
      { kind: "weekly_scoped", percent: 100, scope: { model: { display_name: "Opus" } } },
    ],
    spend: { enabled: true },
  });
  assert.equal(extraUsage.inUse, false);
});

test("credits: session exhausted with credits on is 'IN USE'", () => {
  const { extraUsage } = core.parseUsage({
    limits: [{ kind: "session", percent: 100 }],
    spend: { enabled: true },
  });
  assert.equal(extraUsage.inUse, true);
});

test("credits: non-USD currency is carried and formatted without a $", () => {
  const { extraUsage: e } = core.parseUsage({
    limits: [{ kind: "session", percent: 1 }],
    spend: { enabled: true, used: { amount_minor: 4250, exponent: 2, currency: "EUR" } },
  });
  assert.equal(e.currency, "EUR");
  assert.equal(core.formatMoney(e.spentUsd, e.currency), "42.50 EUR");
  assert.equal(core.formatMoney(1500, "USD"), "$1,500.00");
  assert.equal(core.formatMoney(1234567.5), "$1,234,567.50");
  assert.equal(core.formatMoney(999.999), "$1,000.00");
});

test("money helpers never produce NaN", () => {
  assert.equal(core.centsOrMinorToMajor({ amount_minor: 1500, exponent: 2 }), 15);
  assert.equal(core.centsOrMinorToMajor(1500), 15);
  assert.equal(core.centsOrMinorToMajor("1500"), 15);
  for (const bad of [null, undefined, {}, "abc", NaN, { amount: 3 }]) {
    assert.equal(core.centsOrMinorToMajor(bad), null);
  }
});

test("Team seat: member spend limit fills in when /usage has none", () => {
  const { buckets, extraUsage } = core.parseUsage(usageOf("multi-org", ORG.team));
  assert.equal(extraUsage.status, "off");
  const body = CLAUDE_SCENARIOS["multi-org"][`/api/organizations/${ORG.team}/overage_spend_limit`];
  const e = core.applyOverageSpendLimit(extraUsage, body, buckets);
  assert.equal(e.status, "on");
  assert.equal(e.limitUsd, 1500);
  assert.equal(e.spentUsd, 57.32);
  assert.equal(e.scope, "member");
  assert.equal(core.applyOverageSpendLimit(extraUsage, { nope: 1 }, buckets), extraUsage);
});

test("LIVE Team payload (captured 2026-11-13): limits, codename nulls, org-level credits off", () => {
  const { buckets, extraUsage } = core.parseUsage(usageOf("team-live", ORG.team));
  assert.deepEqual(keys(buckets), ["five_hour", "seven_day", "seven_day_fable"]);
  assert.equal(buckets[2].label, "Weekly Fable");
  assert.equal(extraUsage.status, "off", "disabled by the org is OFF, not PAUSED");
  assert.equal(extraUsage.byOrg, true);
  const body = CLAUDE_SCENARIOS["team-live"][`/api/organizations/${ORG.team}/overage_spend_limit`];
  const e = core.applyOverageSpendLimit(extraUsage, body, buckets);
  assert.equal(e.status, "off", "is_enabled:true with a zero org limit must not read as ON");
  assert.equal(e.limitUsd, null);
  assert.equal(e.scope, "organization");
  assert.equal(e.overLimit, false);
  const b = core.computeBadge(stateWith({ buckets, extraUsage: e }), NOW);
  assert.equal(b.text, "2%");
  assert.equal(b.color, core.COLOR_GREEN);
  const [org] = core.summarizeOrgs(CLAUDE_SCENARIOS["team-live"]["/api/organizations"]);
  assert.deepEqual([org.kind, org.tier], ["team", "team"]);
});

test("LIVE Max 20× + Team login (captured 2026-11-13)", () => {
  const orgs = core.summarizeOrgs(CLAUDE_SCENARIOS["work-live"]["/api/organizations"]);
  assert.deepEqual(orgs.map((o) => [o.kind, o.tier]), [["personal", "max_20x"], ["team", "team"]]);
  const max = core.parseUsage(usageOf("work-live", ORG.personal));
  assert.deepEqual(keys(max.buckets), ["seven_day", "seven_day_fable"], "no session limit on this plan");
  assert.equal(max.extraUsage.status, "paused");
  assert.equal(max.extraUsage.disabledReason, "out_of_credits");
  assert.equal(max.extraUsage.limitUsd, 200);
  assert.equal(max.extraUsage.inUse, false);
  assert.equal(core.computeBadge(stateWith(max), NOW).text, "13%");
  const team = core.parseUsage(usageOf("work-live", ORG.team));
  assert.equal(team.extraUsage.status, "off");
  assert.equal(core.applyOverageSpendLimit(team.extraUsage, null, team.buckets), team.extraUsage, "200 with a null body");
  assert.equal(core.computeBadge(stateWith(team), NOW).text, "0%");
});

// ── badge ───────────────────────────────────────────────────────────────────

test("badge: no session limit (verified Ultra) falls back to weekly-all", () => {
  const { buckets, extraUsage } = core.parseUsage(usageOf("multi-org", ORG.personal));
  const b = core.computeBadge(stateWith({ buckets, extraUsage }), NOW);
  assert.equal(b.text, "35%");
  assert.equal(b.color, core.COLOR_GREEN);
});

test("badge: weekly at 100% is not hidden by a missing session value", () => {
  const { buckets } = core.parseUsage({ five_hour: null, seven_day: { utilization: 100 } });
  assert.equal(core.computeBadge(stateWith({ buckets }), NOW).text, "100%");
});

test("badge: session severity from the API drives the colour", () => {
  const mk = (pct, severity) =>
    core.computeBadge(
      stateWith({ buckets: core.bucketsFromLimits([{ kind: "session", percent: pct, severity }, { kind: "weekly_all", percent: 10, severity: "normal" }]) }),
      NOW
    ).color;
  assert.equal(mk(80, "critical"), core.COLOR_RED);
  assert.equal(mk(92, "normal"), core.COLOR_GREEN);
});

test("badge: a maxed per-model limit does not hijack the headline", () => {
  const { buckets, extraUsage } = core.parseUsage({
    limits: [
      { kind: "session", percent: 12 },
      { kind: "weekly_all", percent: 30 },
      { kind: "weekly_scoped", percent: 100, scope: { model: { display_name: "Fable" } } },
    ],
  });
  const b = core.computeBadge(stateWith({ buckets, extraUsage }), NOW);
  assert.equal(b.text, "30%");
  assert.match(b.title, /Weekly Fable: 100%/);
});

test("badge: signed out shows '!' even with cached numbers", () => {
  const { buckets } = core.parseUsage(usageOf("max-fable", ORG.personal));
  const b = core.computeBadge(stateWith({ buckets }, { errorCode: "no_org", lastError: "Not signed in to Claude." }), NOW);
  assert.equal(b.text, "!");
  assert.equal(b.color, core.COLOR_GREY);
});

test("badge: follows the pinned org, then the active org", () => {
  const a = { ...core.defaultAccount("a"), buckets: core.bucketsFromLimits([{ kind: "session", percent: 11 }]), lastUpdated: NOW };
  const b = { ...core.defaultAccount("b"), buckets: core.bucketsFromLimits([{ kind: "session", percent: 77 }]), lastUpdated: NOW };
  const s = { ...core.defaultState(), accounts: { a, b }, orgs: [{ id: "a" }, { id: "b" }], activeOrgId: "a" };
  assert.equal(core.computeBadge(s, NOW).text, "11%");
  assert.equal(core.computeBadge({ ...s, pinnedOrgId: "b" }, NOW).text, "77%");
  assert.equal(core.computeBadge({ ...s, pinnedOrgId: "gone" }, NOW).text, "11%");
});

test("badge: spend-only seat shows credit utilization", () => {
  const extraUsage = core.finalizeExtra({ ...core.defaultExtra(), enabled: true, spentUsd: 75, limitUsd: 100 }, []);
  const b = core.computeBadge(stateWith({ buckets: [], extraUsage }), NOW);
  assert.equal(b.text, "75%");
  assert.equal(b.color, core.COLOR_AMBER);
});

test("badge: tooltip reset uses hours, not raw minutes", () => {
  const buckets = core.bucketsFromLimits([{ kind: "session", percent: 5, resets_at: NOW + 4 * 3600_000 }]);
  assert.match(core.computeBadge(stateWith({ buckets }), NOW).title, /Resets in 4h/);
});

test("formatDuration", () => {
  assert.equal(core.formatDuration(20_000), "<1m");
  assert.equal(core.formatDuration(59 * 60_000), "59m");
  assert.equal(core.formatDuration(4 * 3600_000), "4h");
  assert.equal(core.formatDuration(50 * 3600_000), "2d 2h");
});

// ── tiers / orgs ────────────────────────────────────────────────────────────

test("tier: org display names are never read as a plan", () => {
  for (const name of ["max@gmail.com's Organization", "Pro Painting LLC", "Team Rocket", "Free Spirit"]) {
    assert.equal(core.tierFromOrg({ name, capabilities: ["chat", "claude_pro"] }), "pro", name);
    assert.deepEqual(core.explicitTierFields({ name }), []);
  }
});

test("tier: org list records", () => {
  const orgs = core.summarizeOrgs(CLAUDE_SCENARIOS["multi-org"]["/api/organizations"]);
  assert.deepEqual(orgs.map((o) => [o.kind, o.tier]), [["personal", "ultra"], ["team", "team"]]);
  assert.equal(orgs[1].name, "Max's Team");
  const [max] = core.summarizeOrgs(CLAUDE_SCENARIOS["max-fable"]["/api/organizations"]);
  assert.equal(max.tier, "max_5x");
  assert.deepEqual(core.summarizeOrgs({ not: "a list" }), []);
});

test("tier: bare claude_max does not guess 5× over the authoritative lookup", () => {
  const [o] = core.summarizeOrgs([{ uuid: ORG.personal, capabilities: ["chat", "claude_max"], rate_limit_tier: "default_claude_ai" }]);
  assert.equal(o.tier, null);
  assert.equal(o.tierGuess, "max_5x");
});

test("parseUsage: an object with nothing recognizable is a shape change", () => {
  for (const odd of [{}, { foo: 1 }, { quotas: [1] }, { limits: [] }]) {
    assert.throws(() => core.parseUsage(odd), core.ShapeError);
  }
  assert.deepEqual(core.parseUsage({ spend: { enabled: false } }).buckets, []);
});

test("tier: normalizeTier", () => {
  assert.equal(core.normalizeTier("default_claude_max_20x"), "max_20x");
  assert.equal(core.normalizeTier("claude_ultra"), "ultra");
  assert.equal(core.normalizeTier("team_premium_max"), "team");
  assert.equal(core.normalizeTier("claude_max_disabled"), null);
  assert.equal(core.normalizeTier("product_tour_seen"), null);
  assert.equal(core.formatTier("ultra"), "Ultra");
});

// ── scheduled runs ──────────────────────────────────────────────────────────

test("run budget: only run-specific keys match in nested data", () => {
  assert.equal(core.extractRunBudget({ storage: { used: 1234567, limit: 5000000000 } }), null);
  assert.deepEqual(core.extractRunBudget({ data: { runs_used: 3, runs_limit: 5 } }), { used: 3, limit: 5, resetsAt: null });
  assert.deepEqual(core.extractRunBudget({ used: 2, limit: 15 }, { allowGeneric: true }), { used: 2, limit: 15, resetsAt: null });
  assert.equal(core.extractRunBudget({ used: 2, limit: 15 }), null);
});

test("run budget: expires after its reset", () => {
  assert.equal(core.liveRoutineRuns({ used: 3, limit: 5, resetsAt: NOW - 1 }, NOW), null);
  assert.ok(core.liveRoutineRuns({ used: 3, limit: 5, resetsAt: NOW + 1 }, NOW));
  assert.equal(core.liveRoutineRuns({ used: 3, limit: 5, resetsAt: null, seenAt: NOW - 25 * 3600_000 }, NOW), null);
  assert.equal(core.liveRoutineRuns({ used: 3, limit: 5, resetsAt: null }, NOW), null, "no timestamps at all");
  const migrated = core.migrateState({ orgId: "o1", buckets: [], lastUpdated: NOW, routineRuns: { used: 3, limit: 10, resetsAt: null } });
  assert.ok(core.liveRoutineRuns(migrated.accounts.o1.routineRuns, NOW + 3600_000));
  assert.equal(core.liveRoutineRuns(migrated.accounts.o1.routineRuns, NOW + 90 * 86400_000), null);
});

// ── state ───────────────────────────────────────────────────────────────────

test("migration: v0.4 flat state becomes one account, nothing lost", () => {
  const v1 = {
    buckets: [{ key: "five_hour", label: "Session (5h)", utilization: 42, resetsAt: 1 }],
    extraUsage: { enabled: true, status: "on", spentUsd: 1, limitUsd: 2 },
    subscriptionTier: "max_20x", tierFetchedAt: 5, orgId: "o1", lastUpdated: NOW,
    routineRuns: null, lastError: null, errorCode: null,
  };
  const s = core.migrateState(v1);
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.activeOrgId, "o1");
  assert.equal(s.accounts.o1.subscriptionTier, "max_20x");
  assert.equal(s.accounts.o1.extraUsage.currency, "USD");
  assert.equal(core.computeBadge(s, NOW).text, "42%");
  assert.deepEqual(core.migrateState(core.migrateState(v1)), s, "idempotent");
});

test("migration: junk in storage yields a usable default state", () => {
  for (const junk of [null, undefined, 7, "x", {}, { schemaVersion: 2 }, { accounts: 3 }]) {
    const s = core.migrateState(junk);
    assert.equal(core.computeBadge(s, NOW).text, "");
    assert.equal(s.console.enabled, false);
  }
});

// ── console ─────────────────────────────────────────────────────────────────

test("console: known shapes parse; unknown shapes yield nulls, not NaN", () => {
  const ok = CONSOLE_SCENARIOS.ok;
  const base = `/api/organizations/${ORG.console}`;
  const credits = core.parseConsoleCredits(ok[`${base}/prepaid/credits`]());
  assert.equal(credits.balanceUsd, 43.21);
  assert.equal(credits.autoReload, false, "auto_reload_settings: null means off");
  assert.ok(credits.expiresAt > Date.now());
  assert.equal(core.parseConsoleSpend(ok[`${base}/current_spend`]()).spendUsd, 18.75);
  // The internal tier id is not shown as if it were the Console's tier name.
  assert.deepEqual(core.parseConsoleRateLimits(ok[`${base}/rate_limits`]), { tier: null, spendLimitUsd: null });
  assert.equal(core.parseConsoleCredits({ foo: 1 }).balanceUsd, null);
  assert.equal(core.parseConsoleSpend(null).spendUsd, null);
  assert.equal(core.parseConsoleSpend({ amount: { amount_minor: 990, exponent: 2 } }).spendUsd, 9.9);
});
