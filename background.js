// background.js — MV3 service worker
// Single source of truth for usage state; drives the badge.
//
// All parsing lives in lib/core.js (pure, unit-tested). This file is the
// orchestration: which orgs to poll, when, and how results land in storage.
//
// State (see lib/core.js defaultState) is keyed per organization so a login
// that belongs to several orgs (personal plan + a Team) is tracked side by
// side instead of one org's data bleeding into another's.

import { CLAUDE_ORIGIN, CONSOLE_ORIGIN, DEBUG } from "./config.js";
import { FEATURES, isUnlocked } from "./lib/entitlements.js";
import {
  defaultState, defaultAccount, defaultConsole, migrateState, displayOrgId,
  parseUsage, finalizeExtra, applyOverageSpendLimit, detectAutoReload,
  centsOrMinorToMajor, extractRunBudget, liveRoutineRuns,
  normalizeTier, pickBestTier, explicitTierFields, summarizeOrgs,
  parseConsoleCredits, parseConsoleSpend, parseConsoleRateLimits,
  computeBadge, ShapeError, UUID_RE,
} from "./lib/core.js";

const dbg = (...args) => { if (DEBUG) console.log("[Claude Usage Badge]", ...args); };

const BADGE_TEXT = "#FFFFFF";
const MAX_TRACKED_ORGS = 4;
const ORGS_TTL_MS = 6 * 60 * 60_000;          // re-list organizations every 6h
const SECONDARY_INTERVAL_MS = 12 * 60_000;    // orgs that aren't on the badge
const CONSOLE_INTERVAL_MS = 5 * 60_000;
const TIER_HIT_TTL_MS = 12 * 60 * 60_000;
const TIER_MISS_TTL_MS = 60 * 60_000;
const PROBE_COOLDOWN_MS = 30 * 60_000;        // speculative endpoints that 404
const ORGS_RETRY_MS = 30 * 60_000;            // floor between org-list attempts
const MIN_CYCLE_GAP_MS = 20_000;              // global floor between non-forced cycles
const FULL_CYCLE_GAP_MS = 150_000;            // pokes in between only re-read /usage

// ─── State (serialized writes) ──────────────────────────────────────────────
// chrome.storage read-modify-write is not atomic. Every writer in this worker
// funnels through one promise chain so a slow writer can't clobber a fast one.

async function readState() {
  const { usageState } = await chrome.storage.local.get("usageState");
  return migrateState(usageState);
}

let writeQueue = Promise.resolve();

function updateState(mutator) {
  writeQueue = writeQueue
    .then(async () => {
      const prev = await readState();
      const next = mutator(prev) || prev;
      await chrome.storage.local.set({ usageState: next });
      await renderBadge(next);
    })
    .catch((e) => dbg("updateState error:", e));
  return writeQueue;
}

async function renderBadge(state) {
  const { text, color, title } = computeBadge(state, Date.now());
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  try {
    // Chrome 110+; without this Chrome auto-picks black on our greens.
    await chrome.action.setBadgeTextColor({ color: BADGE_TEXT });
  } catch {
    // Very old Chrome — auto text color is the graceful fallback.
  }
  await chrome.action.setTitle({ title });
}

async function refreshBadge() {
  await renderBadge(await readState());
}

// ─── API layer ──────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, endpoint) {
    super(`API ${status}: ${endpoint}`);
    this.name = "ApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

class NetworkError extends Error {
  constructor(endpoint) {
    super(`Network error: ${endpoint}`);
    this.name = "NetworkError";
  }
}

// Set when ANY claude.ai request in the current cycle is answered 429, so the
// whole extension backs off — not only when /usage itself is throttled.
let saw429 = false;

async function originFetch(origin, path, headers = {}) {
  let resp;
  try {
    resp = await fetch(`${origin}${path}`, {
      method: "GET",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...headers },
    });
  } catch {
    // Only fetch()'s own rejection is a network failure.
    throw new NetworkError(path);
  }
  if (resp.status === 429 && origin === CLAUDE_ORIGIN) saw429 = true;
  if (!resp.ok) throw new ApiError(resp.status, path);
  try {
    return await resp.json();
  } catch {
    // 200 that isn't JSON (Cloudflare challenge, login redirect HTML, …)
    throw new ApiError(0, path);
  }
}

const claudeApi = (endpoint, headers) => originFetch(CLAUDE_ORIGIN, `/api${endpoint}`, headers);
const consoleApi = (endpoint) => originFetch(CONSOLE_ORIGIN, `/api${endpoint}`);

async function getCookieOrg(origin) {
  try {
    const cookie = await chrome.cookies.get({ name: "lastActiveOrg", url: origin });
    const val = cookie?.value || null;
    // The org id is interpolated into URL paths — only accept a real UUID.
    return val && UUID_RE.test(val) ? val : null;
  } catch {
    return null;
  }
}

function describeError(err, host) {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      return { errorCode: "auth", lastError: `${host} session expired or unauthorized.` };
    }
    if (err.status === 404) {
      return { errorCode: "unknown", lastError: `${host} usage API not found — the API may have changed.` };
    }
    if (err.status === 429) {
      return { errorCode: "rate_limited", lastError: `Rate limited by ${host} — backing off.` };
    }
    if (err.status === 0) {
      return { errorCode: "unknown", lastError: `Unexpected non-JSON response from ${host}.` };
    }
    return { errorCode: "network", lastError: `${host} returned an error (${err.status}).` };
  }
  if (err instanceof NetworkError) {
    return { errorCode: "network", lastError: `Network error reaching ${host}.` };
  }
  if (err instanceof ShapeError) {
    return { errorCode: "shape", lastError: `${host} returned usage data in a new format — an extension update may be needed.` };
  }
  return { errorCode: "unknown", lastError: err?.message || "Failed to fetch usage" };
}

// ─── Throttle state (persisted) ─────────────────────────────────────────────
// MV3 kills the service worker after ~30s idle, so module-level timers reset.
// Throttle timestamps live in chrome.storage.session so they survive restarts.

async function getThrottle() {
  try {
    const { throttle } = await chrome.storage.session.get("throttle");
    return throttle || {};
  } catch {
    return {};
  }
}

async function patchThrottle(partial) {
  try {
    const prev = await getThrottle();
    await chrome.storage.session.set({ throttle: { ...prev, ...partial } });
  } catch {
    // ignore — throttling is best-effort
  }
}

// ─── Per-org fetch ──────────────────────────────────────────────────────────

// Per-org jitter (0–15 min, stable per org) so several orgs' cooldowns don't
// all expire into the same cycle.
const jitter = (orgId) => (parseInt(orgId.slice(0, 2), 16) % 16) * 60_000;
const cooled = (probes, name, now, orgId = "00") =>
  now - (probes[name] || 0) < PROBE_COOLDOWN_MS + jitter(orgId);
const definitiveMiss = (err) => err instanceof ApiError && (err.status === 404 || err.status === 403 || err.status === 401);

async function fetchRoutineRuns(orgId, probes, now) {
  if (cooled(probes, "routines", now, orgId)) return null;
  const candidates = [
    () => claudeApi(`/organizations/${orgId}/routines/run-budget`),
    () => originFetch(CLAUDE_ORIGIN, "/v1/code/routines/run-budget", { "x-organization-uuid": orgId }),
  ];
  for (const attempt of candidates) {
    try {
      const budget = extractRunBudget(await attempt(), { allowGeneric: true });
      if (budget) return { ...budget, seenAt: now };
    } catch {
      // try next
    }
  }
  probes.routines = now;
  return null;
}

// Fallback tier detection for orgs whose /organizations record didn't say.
// Sources are tried in order of authority; the first that yields a tier wins.
async function fetchTierFallback(orgId) {
  try {
    const sub = await claudeApi(`/organizations/${orgId}/subscription_details`);
    const candidates = explicitTierFields(sub);
    const m = Number(sub?.max_multiplier);
    if (m === 20) candidates.push("max_20x");
    else if (m >= 5) candidates.push("max_5x");
    const tier = pickBestTier(candidates.map(normalizeTier));
    if (tier) return tier;
  } catch {
    // fall through
  }
  try {
    const bootstrap = await claudeApi(
      `/bootstrap/${orgId}/app_start?statsig_hashing_algorithm=djb2`
    );
    const user = bootstrap?.org_growthbook?.user;
    if (user) {
      if (user.isRaven) return "team";
      if (user.isEnterprise) return "enterprise";
      if (user.isMax) return user.maxTier === "20x" ? "max_20x" : "max_5x";
      if (user.isPro) return "pro";
      if (user.isFree) return "free";
    }
  } catch {
    // fall through
  }
  return null;
}

// Returns the next Account record for this org. Never throws.
async function fetchAccount(org, prevAccount, now, flags) {
  const prev = prevAccount || defaultAccount(org.id);
  const base = { ...prev, orgId: org.id, name: org.name ?? prev.name, kind: org.kind ?? prev.kind };
  const probes = { ...(prev.probes || {}) };

  let parsed;
  try {
    parsed = parseUsage(await claudeApi(`/organizations/${org.id}/usage`));
  } catch (err) {
    if (!(err instanceof ApiError) && !(err instanceof NetworkError) && !(err instanceof ShapeError)) {
      console.error("[Claude Usage Badge] fetch error:", err);
    }
    const d = describeError(err, "Claude");
    const out = { ...base, ...d, lastErrorAt: now };
    // An org we're not allowed to read must not keep showing old numbers.
    if (d.errorCode === "auth") {
      out.lastError = "No access to this organization's usage.";
      out.buckets = [];
      out.extraUsage = defaultAccount().extraUsage;
      out.routineRuns = null;
      out.lastUpdated = null;
    }
    return out;
  }

  const { buckets } = parsed;
  let extra = parsed.extraUsage;
  const prevExtra = prev.extraUsage || {};
  const light = !!flags.light;   // poke-triggered: /usage only, reuse the rest
  const creditsLive = extra.status === "on" || extra.status === "paused";

  // Values /usage doesn't carry are reused from the last full cycle unless
  // re-fetched below.
  const carryBalance = () => {
    if (!creditsLive) return;
    if (extra.balanceUsd == null) extra.balanceUsd = prevExtra.balanceUsd ?? null;
    if (extra.autoReload == null) extra.autoReload = prevExtra.autoReload ?? null;
  };
  const carryMemberLimit = () => {
    if (prevExtra.scope && prevExtra.limitUsd != null && extra.limitUsd == null) {
      extra = finalizeExtra(
        { ...extra, enabled: prevExtra.enabled, limitUsd: prevExtra.limitUsd,
          spentUsd: prevExtra.spentUsd, currency: prevExtra.currency, scope: prevExtra.scope },
        buckets
      );
    }
  };

  // Prepaid balance + auto-reload aren't always in /usage.
  const needCredits = creditsLive && (extra.balanceUsd == null || extra.autoReload == null);
  if (needCredits && !light && (flags.force || !cooled(probes, "credits", now, org.id))) {
    try {
      const credits = await claudeApi(`/organizations/${org.id}/prepaid/credits`);
      if (extra.balanceUsd == null) extra.balanceUsd = centsOrMinorToMajor(credits?.amount);
      if (extra.autoReload == null) extra.autoReload = detectAutoReload(credits);
    } catch (err) {
      // Members of a Team org are typically not allowed to read this — don't
      // ask again every cycle.
      if (definitiveMiss(err)) probes.credits = now;
      else carryBalance();
    }
  } else {
    carryBalance();
  }

  // Team / Enterprise seats: the member's own spend cap lives elsewhere.
  const isSeat = base.kind === "team" || base.kind === "enterprise";
  if (isSeat && flags.team && extra.limitUsd == null) {
    if (!light && (flags.force || !cooled(probes, "overage", now, org.id))) {
      try {
        const body = await claudeApi(`/organizations/${org.id}/overage_spend_limit`);
        extra = applyOverageSpendLimit(extra, body, buckets);
        // No positive cap came back (unusable answer, or credits are off for
        // the org) — that won't change minute to minute, so don't re-ask
        // every cycle.
        if (extra.limitUsd == null) probes.overage = now;
      } catch (err) {
        // Only a definitive "not there / not allowed" starts the cooldown; a
        // blip keeps the last known cap instead of hiding it.
        if (definitiveMiss(err)) probes.overage = now;
        else carryMemberLimit();
      }
    } else {
      // Not asked this cycle (poke, or cooling down): keep what we knew.
      carryMemberLimit();
      if (extra.limitUsd == null && prevExtra.scope) {
        extra = finalizeExtra(
          { ...extra, scope: prevExtra.scope, disabledReason: extra.disabledReason || prevExtra.disabledReason },
          buckets
        );
      }
    }
  }

  // Tier: an explicit answer in the org list is free; otherwise ask
  // subscription_details (cached), and only then fall back to a guess.
  let tier = org.tier || null;
  let tierCheckedAt = prev.tierCheckedAt;
  if (!tier) {
    const ttl = prev.subscriptionTier ? TIER_HIT_TTL_MS : TIER_MISS_TTL_MS;
    let probed = null;
    if (!light && (!prev.tierCheckedAt || now - prev.tierCheckedAt > ttl)) {
      probed = await fetchTierFallback(org.id);
      tierCheckedAt = now;       // recorded on a miss too — no per-cycle re-probing
    }
    tier = probed || prev.subscriptionTier || org.tierGuess || null;
  }

  const fresh = light ? null : await fetchRoutineRuns(org.id, probes, now);
  const routineRuns = liveRoutineRuns(fresh || prev.routineRuns, now);

  return {
    ...base,
    buckets,
    extraUsage: finalizeExtra(extra, buckets),
    routineRuns,
    subscriptionTier: tier,
    tierCheckedAt,
    probes,
    lastUpdated: now,
    lastError: null,
    errorCode: null,
  };
}

// ─── API Console ────────────────────────────────────────────────────────────

async function consolePermitted() {
  try {
    return await chrome.permissions.contains({ origins: [`${CONSOLE_ORIGIN}/*`] });
  } catch {
    return false;
  }
}

async function fetchConsole(prev, now) {
  const base = { ...defaultConsole(), ...prev, enabled: true };
  const fail = (lastError, errorCode) => ({ ...base, lastError, errorCode, lastErrorAt: now });

  if (!(await consolePermitted())) {
    return fail("Permission for platform.claude.com was removed.", "permission");
  }

  let orgId = await getCookieOrg(CONSOLE_ORIGIN);
  let orgName = base.orgId === orgId ? base.orgName : null;
  try {
    if (!orgId || !orgName) {
      const list = await consoleApi("/organizations");
      // The Console lists every org on the login, chat plans included, and
      // answers 403 for those — only API organizations have Console billing.
      const orgs = (Array.isArray(list) ? list : []).filter(
        (o) => o && UUID_RE.test(o.uuid || o.id || "") &&
          (!Array.isArray(o.capabilities) || o.capabilities.includes("api"))
      );
      const match = orgs.find((o) => (o.uuid || o.id) === orgId) || orgs[0];
      if (match) {
        orgId = match.uuid || match.id;
        orgName = typeof match.name === "string" ? match.name : null;
      }
    }
  } catch (err) {
    if (!orgId) {
      const d = describeError(err, "The API Console");
      return fail(d.errorCode === "auth" ? "Sign in to the API Console." : d.lastError, d.errorCode);
    }
  }
  if (!orgId) return fail("Sign in to the API Console.", "auth");

  const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
  const [credits, spend, limits] = await Promise.all([
    settle(consoleApi(`/organizations/${orgId}/prepaid/credits`)),
    settle(consoleApi(`/organizations/${orgId}/current_spend`)),
    settle(consoleApi(`/organizations/${orgId}/rate_limits`)),
  ]);

  if (!credits.ok && !spend.ok) {
    const d = describeError(credits.e, "The API Console");
    return {
      ...fail(d.errorCode === "auth" ? "Sign in to the API Console." : d.lastError, d.errorCode),
      orgId, orgName,
    };
  }

  const c = credits.ok ? parseConsoleCredits(credits.v) : {};
  const s = spend.ok ? parseConsoleSpend(spend.v) : {};
  const r = limits.ok ? parseConsoleRateLimits(limits.v) : {};
  const parsedAny = c.balanceUsd != null || s.spendUsd != null;
  return {
    ...defaultConsole(),
    enabled: true,
    orgId,
    orgName,
    balanceUsd: c.balanceUsd ?? null,
    autoReload: c.autoReload ?? null,
    currency: c.currency || "USD",
    spendUsd: s.spendUsd ?? null,
    spendLimitUsd: s.spendLimitUsd ?? r.spendLimitUsd ?? null,
    resetsAt: s.resetsAt ?? null,
    expiresAt: c.expiresAt ?? null,
    tier: r.tier ?? null,
    lastUpdated: parsedAny ? now : base.lastUpdated,
    lastError: parsedAny ? null : "The API Console returned data in a format this version doesn't understand.",
    errorCode: parsedAny ? null : "shape",
    lastErrorAt: parsedAny ? null : now,
  };
}

async function consoleCycle(force) {
  const state = await readState();
  if (!state.console?.enabled) return;
  if (!(await isUnlocked(FEATURES.CONSOLE))) return;
  const now = Date.now();
  const last = Math.max(state.console.lastUpdated || 0, state.console.lastErrorAt || 0);
  if (!force && now - last < CONSOLE_INTERVAL_MS) return;
  const next = await fetchConsole(state.console, now);
  // Respect a disable that happened while we were fetching.
  await updateState((s) => (s.console?.enabled ? { ...s, console: next } : s));
}

// ─── Main cycle ─────────────────────────────────────────────────────────────

let inFlight = null;   // dedupe concurrent cycles (per worker)
let queuedForce = false;

function runCycle(force = false, full = force) {
  if (inFlight) {
    // A forced refresh that arrives mid-cycle must not be swallowed by a
    // non-forced one — run again once the current cycle ends.
    if (force) queuedForce = true;
    return inFlight;
  }
  inFlight = (async () => {
    await doCycle(force, full);
    while (queuedForce) {
      queuedForce = false;
      await doCycle(true);
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

async function doCycle(force, full = force) {
  try {
    await claudeCycle(force, full);
  } catch (e) {
    console.error("[Claude Usage Badge] cycle error:", e);
  }
  try {
    await consoleCycle(force);
  } catch (e) {
    console.error("[Claude Usage Badge] console cycle error:", e);
  }
}

// `full` cycles (alarm, Refresh) fetch everything. Pokes from a claude.ai tab
// that land between full cycles only re-read /usage for the badge.
async function claudeCycle(force, full = force) {
  const now = Date.now();
  const throttle = await getThrottle();
  if (!force) {
    if (now < (throttle.backoffUntil || 0)) return;
    if (now - (throttle.lastCycleAt || 0) < MIN_CYCLE_GAP_MS) return;
  }
  const light = !full && now - (throttle.lastFullAt || 0) < FULL_CYCLE_GAP_MS;
  await patchThrottle(light ? { lastCycleAt: now } : { lastCycleAt: now, lastFullAt: now });
  saw429 = false;

  const activeOrgId = await getCookieOrg(CLAUDE_ORIGIN);
  if (!activeOrgId) {
    await updateState((s) => ({
      ...s,
      activeOrgId: null,
      lastError: "Not signed in to Claude.",
      errorCode: "no_org",
      lastErrorAt: now,
    }));
    return;
  }

  const state = await readState();
  const flags = {
    multiOrg: await isUnlocked(FEATURES.MULTI_ORG),
    team: await isUnlocked(FEATURES.TEAM),
    force,
    light,
  };

  // 1. Which organizations does this login belong to?
  let orgs = state.orgs;
  let orgsFetchedAt = state.orgsFetchedAt;
  let orgsTriedAt = state.orgsTriedAt;
  const listStale =
    !orgsFetchedAt || now - orgsFetchedAt > ORGS_TTL_MS ||
    !orgs.some((o) => o.id === activeOrgId);
  // A failing list (or one that never contains the active org) is retried on
  // a cooldown, not every cycle.
  const mayRetry = !orgsTriedAt || now - orgsTriedAt > ORGS_RETRY_MS;
  if (force || (listStale && mayRetry && !light)) {
    orgsTriedAt = now;
    try {
      const listed = summarizeOrgs(await claudeApi("/organizations"));
      if (listed.length) {
        orgs = listed;
        orgsFetchedAt = now;
      }
    } catch (err) {
      dbg("org list failed:", err);
      // Keep the previous list; the active org is still tracked below.
    }
  }
  if (!orgs.some((o) => o.id === activeOrgId)) {
    orgs = [{ id: activeOrgId, name: null, kind: null, tier: null }, ...orgs];
  }

  // 2. Pick what to poll this cycle. The org on the badge and the active org
  //    every cycle; the rest on a slower cadence.
  const display =
    state.pinnedOrgId && orgs.some((o) => o.id === state.pinnedOrgId)
      ? state.pinnedOrgId
      : activeOrgId;
  const priority = (o) => (o.id === display ? 0 : o.id === activeOrgId ? 1 : 2);
  const tracked = [...orgs].sort((a, b) => priority(a) - priority(b)).slice(0, MAX_TRACKED_ORGS);
  const targets = tracked.filter((o) => {
    if (o.id === display || o.id === activeOrgId) return true;
    if (!flags.multiOrg || light) return false;
    const a = state.accounts[o.id];
    const last = a ? Math.max(a.lastUpdated || 0, a.lastErrorAt || 0) : 0;
    return force || now - last > SECONDARY_INTERVAL_MS;
  });

  // 3. Fetch sequentially — gentle on claude.ai, and a 429 stops the round.
  const results = {};
  for (const org of targets) {
    if (saw429) break;
    results[org.id] = await fetchAccount(org, state.accounts[org.id], now, flags);
  }
  await patchThrottle({ backoffUntil: saw429 ? now + 5 * 60_000 : 0 });

  // An org we can no longer read has probably left this login: re-list on the
  // next full cycle so it (and any pin on it) is dropped.
  const polled = Object.values(results);
  if (polled.some((a) => a.errorCode === "auth")) {
    orgsFetchedAt = null;
    orgsTriedAt = null;
  }
  // The login itself is only declared dead when nothing we asked for worked —
  // one unreadable org must not blank a healthy pinned one.
  const authLost = polled.length > 0 && polled.every((a) => a.errorCode === "auth");

  // 4. Commit. Re-read inside the queue so a concurrent pin/console change
  //    isn't overwritten by this cycle's snapshot.
  await updateState((s) => {
    const keep = new Set(tracked.map((o) => o.id));
    const accounts = {};
    for (const id of keep) {
      let a = results[id] || s.accounts[id];
      if (!a) continue;
      // A run budget sniffed from the page while this cycle was in flight is
      // newer than anything in our snapshot — keep it.
      const stored = s.accounts[id]?.routineRuns;
      if (results[id] && stored?.seenAt > now && !(a.routineRuns?.seenAt >= stored.seenAt)) {
        a = { ...a, routineRuns: stored };
      }
      accounts[id] = a;
    }
    return {
      ...s,
      accounts,
      orgs: tracked.length < orgs.length ? orgs.filter((o) => keep.has(o.id)) : orgs,
      orgsFetchedAt,
      orgsTriedAt,
      activeOrgId,
      pinnedOrgId: s.pinnedOrgId && keep.has(s.pinnedOrgId) ? s.pinnedOrgId : null,
      lastError: authLost ? "Claude session expired or unauthorized." : null,
      errorCode: authLost ? "auth" : null,
      lastErrorAt: authLost ? now : s.lastErrorAt,
    };
  });
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

function ensureAlarm() {
  // Recreating an alarm resets its timer — only create it if missing.
  return chrome.alarms.get("refreshUsage").then((existing) => {
    if (!existing) chrome.alarms.create("refreshUsage", { periodInMinutes: 3 });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  // Migrate whatever is stored to the current shape (inside the write queue).
  await updateState((s) => s);
  await chrome.storage.local.remove("seenApiPaths"); // diagnostic data from old versions
  await ensureAlarm();
  runCycle(false, true);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await refreshBadge().catch(() => {});
  runCycle(false, true);
});

// Re-render the badge from stored state whenever the worker wakes.
refreshBadge().catch(() => {});
ensureAlarm().catch(() => {});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshUsage") runCycle(false, true);
});

// Granting the Console permission is what turns the feature on. Handled here
// (not only in the popup) because Chrome can close the popup while its
// permission prompt is showing, before the popup gets to send a message.
chrome.permissions.onAdded.addListener((p) => {
  if (!(p.origins || []).some((o) => o.startsWith(CONSOLE_ORIGIN))) return;
  updateState((s) => (s.console?.enabled ? s : { ...s, console: { ...defaultConsole(), enabled: true } }))
    .then(() => consoleCycle(true));
});

// The user revoked the Console permission from chrome://extensions.
chrome.permissions.onRemoved.addListener(() => {
  consolePermitted().then((ok) => {
    if (!ok) updateState((s) => ({ ...s, console: defaultConsole() }));
  });
});

// ─── Message handlers ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => {
    p.then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  };
  // Settings-changing messages are only accepted from our own pages (popup),
  // never from a content script running inside a web page.
  const fromExtensionPage =
    sender.id === chrome.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith(chrome.runtime.getURL(""));

  switch (msg?.type) {
    case "CLAUDE_USAGE_UPDATE":
      return reply(runCycle());
    case "FORCE_REFRESH":
      // Bypasses backoff — only our own pages may ask for it.
      return reply(runCycle(fromExtensionPage));
    case "GET_USAGE_STATE":
      readState()
        .then((s) => sendResponse(s))
        .catch(() => sendResponse(defaultState()));
      return true;
    case "SET_PINNED_ORG": {
      if (!fromExtensionPage) break;
      const id = msg.orgId && UUID_RE.test(msg.orgId) ? msg.orgId : null;
      return reply(updateState((s) => ({ ...s, pinnedOrgId: id })).then(() => runCycle(true)));
    }
    case "CONSOLE_ENABLE":
      if (!fromExtensionPage) break;
      return reply(
        updateState((s) => ({ ...s, console: { ...defaultConsole(), enabled: true } }))
          .then(() => consoleCycle(true))
      );
    case "CONSOLE_DISABLE":
      if (!fromExtensionPage) break;
      return reply(updateState((s) => ({ ...s, console: defaultConsole() })));
    case "SNIFFED_PAYLOAD":
      handleSniffedPayload(msg.url, msg.body);
      break;
    default:
      break;
  }
  sendResponse({ ok: false });
  return false;
});

// ─── Sniffed-payload handling ──────────────────────────────────────────────
// When claude.ai itself loads a run-budget endpoint we don't poll, the content
// script forwards that response so the budget can be shown without guessing
// endpoint paths.

async function handleSniffedPayload(url, body) {
  dbg("sniffed:", url);
  if (typeof url !== "string" || !body || typeof body !== "object") return;
  // Only responses from claude.ai's own API count.
  let parsedUrl;
  try {
    parsedUrl = new URL(url, CLAUDE_ORIGIN);
  } catch {
    return;
  }
  if (parsedUrl.origin !== CLAUDE_ORIGIN || !/^\/(api|v1)\//.test(parsedUrl.pathname)) return;
  if (!/\broutines?\b|run[-_]?budget/i.test(parsedUrl.pathname)) return;

  const budget = extractRunBudget(body);
  if (!budget) return;
  const now = Date.now();
  // Attribute to the org named in the URL when there is one.
  const inUrl = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || null;
  await updateState((s) => {
    const orgId = inUrl && s.accounts[inUrl] ? inUrl : s.activeOrgId;
    const acct = orgId ? s.accounts[orgId] : null;
    if (!acct) return s;
    return {
      ...s,
      accounts: { ...s.accounts, [orgId]: { ...acct, routineRuns: { ...budget, seenAt: now } } },
    };
  });
}
