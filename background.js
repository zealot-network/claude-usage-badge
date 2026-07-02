// background.js — MV3 service worker
// Single source of truth for usage state; drives the badge.
//
// Design: the /usage endpoint keeps gaining new bucket types over time
// (seven_day_sonnet, seven_day_opus, Claude Design, etc.). Rather than
// hardcoding a fixed list, we discover any object with shape
// { utilization, resets_at } and surface it in the popup. That keeps the
// extension resilient when Anthropic adds another bucket.

// Set to true to re-enable verbose logging + URL tracking for debugging
// new endpoints. Off by default in production.
const DEBUG = false;
const dbg = (...args) => { if (DEBUG) console.log("[Claude Usage Badge]", ...args); };

const DEFAULT_STATE = {
  buckets: [],          // [{ key, label, utilization, resetsAt, inactive }]
  routineRuns: null,    // { used, limit, resetsAt } | null
  extraUsage: {
    enabled: null,      // null = unknown (no data yet), false = off, true = on
    inUse: null,
    spentUsd: null,
    limitUsd: null,
    balanceUsd: null,
    utilization: null,  // server-provided % when available
    resetsAt: null,
  },
  subscriptionTier: null,
  tierFetchedAt: null,  // epoch ms of last successful tier detection
  orgId: null,
  lastUpdated: null,    // epoch ms of last SUCCESSFUL usage fetch (never set on errors)
  lastErrorAt: null,    // epoch ms of last failed fetch
  lastError: null,
  errorCode: null,      // 'no_org' | 'auth' | 'network' | 'unknown'
};

// Friendly labels for known bucket keys. Anything not listed here falls
// back to a humanized version of the key (e.g. "seven_day_foo" → "Seven Day Foo").
const BUCKET_LABELS = {
  five_hour: "Session (5h)",
  seven_day: "Weekly (all models)",
  seven_day_sonnet: "Weekly Sonnet",
  seven_day_opus: "Weekly Opus",
  // Fable (Claude 5 family). Anthropic's per-model weekly buckets follow
  // the pattern `seven_day_<model>`, so we pre-label both the bare name
  // and a possible versioned variant; whichever appears in the API wins.
  seven_day_fable: "Weekly Fable",
  seven_day_fable_5: "Weekly Fable 5",
  // "omelette" is Claude Design's internal codename on the /usage endpoint.
  // Easter egg: kept the codename in quotes for fun.
  seven_day_omelette: "Weekly Claude Design \"omelette\"",
  seven_day_design: "Weekly Claude Design",
  seven_day_claude_design: "Weekly Claude Design",
  claude_design: "Claude Design",
  // "cowork" is the internal codename for Claude's Scheduled feature.
  // (Routine runs are a separate Claude Code feature, tracked elsewhere.)
  seven_day_cowork: "Weekly Scheduled \"cowork\"",
  seven_day_oauth_apps: "Weekly OAuth apps",
  omelette_promotional: "Claude Design promo",
  iguana_necktie: "\"iguana necktie\" (mystery)",
  daily: "Daily",
};

// Preferred display order — buckets not listed here sort alphabetically after these.
const BUCKET_ORDER = [
  "five_hour",
  "seven_day",
  "seven_day_sonnet",
  "seven_day_opus",
  "seven_day_fable",
  "seven_day_fable_5",
  "seven_day_omelette",
  "seven_day_design",
  "seven_day_claude_design",
  "claude_design",
  "seven_day_cowork",
  "seven_day_oauth_apps",
  "omelette_promotional",
  "iguana_necktie",
  "daily",
];

function labelFor(key) {
  if (BUCKET_LABELS[key]) return BUCKET_LABELS[key];
  return key
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function toEpoch(v) {
  if (!v) return null;
  // Numeric timestamps: treat values below 1e12 as epoch-seconds.
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    return Number.isFinite(ms) ? ms : null;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// A null-valued key in the /usage response is only a real "inactive bucket"
// if it looks like one. This stops unrelated null fields (e.g. a future
// "billing_migration": null) from rendering as bogus "Not active" rows.
function isPlausibleBucketKey(key) {
  return (
    Object.prototype.hasOwnProperty.call(BUCKET_LABELS, key) ||
    /^(five_hour|seven_day|daily)/.test(key)
  );
}

function extractBuckets(usage) {
  if (!usage || typeof usage !== "object") return [];
  const out = [];
  for (const [key, val] of Object.entries(usage)) {
    if (key === "extra_usage") continue;

    // Null-valued buckets represent features the user hasn't activated yet.
    // We still surface them (muted) so the UI shows the full set of limits
    // the plan exposes — they'll populate with real data on first use.
    if (val === null) {
      if (!isPlausibleBucketKey(key)) continue;
      out.push({
        key,
        label: labelFor(key),
        utilization: null,
        resetsAt: null,
        inactive: true,
      });
      continue;
    }

    if (typeof val !== "object") continue;
    const hasUtil = "utilization" in val;
    const hasReset = "resets_at" in val;
    if (!hasUtil && !hasReset) continue;
    out.push({
      key,
      label: labelFor(key),
      utilization: typeof val.utilization === "number" ? val.utilization : null,
      resetsAt: toEpoch(val.resets_at),
      inactive: false,
    });
  }
  out.sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a.key);
    const bi = BUCKET_ORDER.indexOf(b.key);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.key.localeCompare(b.key);
  });
  return out;
}

// ─── Badge rendering ────────────────────────────────────────────────────────

const COLOR_GREEN = "#22c55e"; // matches popup --green
const COLOR_AMBER = "#F59E0B";
const COLOR_RED = "#EF4444";
const COLOR_GREY = "#666666";

function computeBadge(state) {
  const session = state.buckets.find((b) => b.key === "five_hour");
  const sessionPct = session?.utilization ?? null;
  const extra = state.extraUsage || {};

  if (sessionPct == null) {
    // No data. If we have an error, surface it on the badge instead of
    // silently showing nothing.
    if (state.lastError) {
      return {
        text: "!",
        color: COLOR_GREY,
        title: `Claude Usage Badge — ${state.lastError}`,
      };
    }
    return { text: "", color: COLOR_GREY, title: "Claude Usage Badge — no data yet" };
  }

  const pct = Math.min(999, Math.round(sessionPct));
  const inExtra = !!extra.inUse;
  const text = `${pct}%`;

  // Color escalates on the WORST of session or any weekly bucket, not just
  // the session — a green badge over an exhausted weekly limit is a lie.
  // Scoped to session + weekly so a promo/daily bucket can't force red.
  let worst = sessionPct;
  for (const b of state.buckets) {
    const counts = b.key === "five_hour" || b.key.startsWith("seven_day");
    if (counts && b.utilization != null && b.utilization > worst) worst = b.utilization;
  }

  let color;
  if (inExtra)          color = COLOR_RED;
  else if (worst >= 90) color = COLOR_RED;
  else if (worst >= 70) color = COLOR_AMBER;
  else                  color = COLOR_GREEN;

  const parts = [`Session: ${pct}%`];
  for (const b of state.buckets) {
    if (b.key === "five_hour" || b.utilization == null) continue;
    parts.push(`${b.label}: ${Math.round(b.utilization)}%`);
  }
  if (extra.enabled) {
    parts.push(inExtra ? "Extra: IN USE" : "Extra: ON");
    if (extra.spentUsd != null && extra.limitUsd) {
      parts.push(`$${extra.spentUsd.toFixed(2)} / $${extra.limitUsd.toFixed(2)}`);
    } else if (extra.spentUsd != null) {
      parts.push(`~$${extra.spentUsd.toFixed(2)} spent`);
    }
  }
  if (session?.resetsAt) {
    const mins = Math.max(0, Math.round((session.resetsAt - Date.now()) / 60000));
    if (mins > 0) parts.push(`Resets in ${mins}m`);
  }
  if (state.lastError) {
    parts.push(`Last refresh failed: ${state.lastError}`);
  }

  return { text, color, title: parts.join(" · ") };
}

async function refreshBadge() {
  const { usageState } = await chrome.storage.local.get("usageState");
  const state = usageState || DEFAULT_STATE;
  const { text, color, title } = computeBadge(state);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

// ─── State writes (serialized) ──────────────────────────────────────────────
// chrome.storage read-modify-write is not atomic. All writers in this worker
// (alarm fetch, popup refresh, sniffed payloads) funnel through one promise
// chain so a slow writer can't clobber a fast one with a stale snapshot.

let writeQueue = Promise.resolve();

function mergeState(partial) {
  writeQueue = writeQueue
    .then(async () => {
      const { usageState } = await chrome.storage.local.get("usageState");
      const prev = usageState || DEFAULT_STATE;
      const next = { ...prev, ...partial };
      await chrome.storage.local.set({ usageState: next });
      await refreshBadge();
    })
    .catch((e) => dbg("mergeState error:", e));
  return writeQueue;
}

// ─── API layer ──────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getOrgId() {
  try {
    const cookie = await chrome.cookies.get({
      name: "lastActiveOrg",
      url: "https://claude.ai",
    });
    const val = cookie?.value || null;
    // The org id is interpolated into URL paths — only accept a real UUID.
    return val && UUID_RE.test(val) ? val : null;
  } catch {
    return null;
  }
}

class ApiError extends Error {
  constructor(status, endpoint) {
    super(`API ${status}: ${endpoint}`);
    this.name = "ApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

async function apiFetch(endpoint) {
  const resp = await fetch(`https://claude.ai/api${endpoint}`, {
    method: "GET",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!resp.ok) throw new ApiError(resp.status, endpoint);
  try {
    return await resp.json();
  } catch {
    // 200 that isn't JSON (Cloudflare challenge, login redirect HTML, etc.)
    throw new ApiError(0, endpoint);
  }
}

// Try a list of candidate endpoints and return the first successful JSON body.
async function tryEndpoints(endpoints) {
  for (const ep of endpoints) {
    try {
      return { ok: true, data: await apiFetch(ep), endpoint: ep };
    } catch {
      // try next
    }
  }
  return { ok: false };
}

// ─── Throttle state (persisted) ─────────────────────────────────────────────
// MV3 kills the service worker after ~30s idle, so module-level timers reset
// between the 3-minute alarm cycles. Throttle timestamps live in
// chrome.storage.session (in-memory, cleared when the browser closes) so the
// 429 backoff and probe cooldown actually survive worker restarts.

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

// ─── Scheduled / routine-run budget ─────────────────────────────────────────

// Don't hammer speculative endpoints that 404: after a full miss, skip
// re-probing for 30 minutes. The sniffer path (handleSniffedPayload) is the
// primary source anyway.
const ROUTINE_PROBE_COOLDOWN_MS = 30 * 60_000;

async function fetchRoutineRuns(orgId) {
  const { routineProbeMissedAt = 0 } = await getThrottle();
  if (Date.now() - routineProbeMissedAt < ROUTINE_PROBE_COOLDOWN_MS) return null;

  // Cowork is Claude's codename for the Scheduled feature. The settings page
  // fetches /cowork_settings; that's the most likely home for a run budget.
  const candidates = [
    `/organizations/${orgId}/cowork_settings`,
    `/organizations/${orgId}/routines/run-budget`,
  ];
  const { ok, data, endpoint } = await tryEndpoints(candidates);
  if (!ok || !data) {
    await patchThrottle({ routineProbeMissedAt: Date.now() });
    return null;
  }

  dbg("cowork/routines response from", endpoint, data);

  // Direct fields first — require BOTH a used and a limit, both numeric.
  const directUsed =
    data.runs_used ?? data.used_runs ?? data.daily_runs_used ?? data.routines_used ??
    data.used ?? data.consumed ?? null;
  const directLimit =
    data.runs_limit ?? data.daily_runs_limit ?? data.routines_limit ??
    data.run_budget ?? data.daily_limit ?? data.limit ?? data.budget ?? null;
  const directReset = toEpoch(
    data.resets_at ?? data.reset_at ?? data.next_reset ?? data.next_reset_at
  );

  if (typeof directUsed === "number" && typeof directLimit === "number") {
    return { used: directUsed, limit: directLimit, resetsAt: directReset };
  }

  // Heuristic walk for nested shapes.
  return extractRunBudget(data);
}

// ─── Tier detection ─────────────────────────────────────────────────────────

// Token-based tier matching. Substring matching produced false positives
// ("pro" in "product_tour_seen", "max" in "claude_max_disabled"), so we
// split into tokens and require exact token membership, plus negative
// tokens that disqualify flag-style strings.
const TIER_NEGATIVE_TOKENS = new Set([
  "disabled", "ineligible", "upsell", "banner", "seen", "dismissed",
  "eligible", "promo", "trial", "ended", "expired",
]);

function normalizeTier(raw) {
  if (!raw || typeof raw !== "string") return null;
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const has = (t) => tokens.includes(t);
  for (const t of tokens) if (TIER_NEGATIVE_TOKENS.has(t)) return null;

  if (has("max") && (has("20x") || has("20") || has("twenty"))) return "max_20x";
  if (has("max") && (has("5x") || has("5") || has("five"))) return "max_5x";
  if (has("max")) return "max_5x";
  if (has("enterprise")) return "enterprise";
  if (has("team") || has("raven")) return "team";
  if (has("pro")) return "pro";
  if (has("free")) return "free";
  return null;
}

const TIER_RANK = {
  max_20x: 6,
  max_5x: 5,
  enterprise: 4,
  team: 3,
  pro: 2,
  free: 1,
};

function pickBestTier(tiers) {
  let best = null;
  for (const t of tiers) {
    if (!t) continue;
    if (!best || TIER_RANK[t] > TIER_RANK[best]) best = t;
  }
  return best;
}

// Only read values of keys that explicitly name a plan/tier — walking every
// "capability"-ish key rank-maxed experiment flags into wrong tiers.
const TIER_FIELD_NAMES = [
  "tier", "plan", "plan_name", "plan_type", "subscription_tier",
  "product_name", "rate_limit_tier", "billing_type", "name",
];

function explicitTierFields(obj) {
  const out = [];
  if (!obj || typeof obj !== "object") return out;
  for (const k of TIER_FIELD_NAMES) {
    const v = obj[k];
    if (typeof v === "string") out.push(v);
  }
  // One nested level for common wrappers like { subscription: { tier } }.
  for (const wrap of ["subscription", "billing", "plan"]) {
    const inner = obj[wrap];
    if (inner && typeof inner === "object") {
      for (const k of TIER_FIELD_NAMES) {
        const v = inner[k];
        if (typeof v === "string") out.push(v);
      }
    }
  }
  return out;
}

// Sources are tried in order of authority. The first source that yields a
// tier wins — we do NOT rank-max across sources, so a stray "max"-flavored
// string in a weaker source can't override subscription_details.
async function fetchTier(orgId) {
  // 1. subscription_details — the billing system's own answer.
  try {
    const sub = await apiFetch(`/organizations/${orgId}/subscription_details`);
    dbg("subscription_details:", sub);
    const candidates = explicitTierFields(sub);
    const m = Number(sub?.max_multiplier);
    if (m === 20) candidates.push("max_20x");
    else if (m >= 5) candidates.push("max_5x");
    const tier = pickBestTier(candidates.map(normalizeTier));
    if (tier) return tier;
  } catch {
    // fall through
  }

  // 2. Organization record.
  try {
    const org = await apiFetch(`/organizations/${orgId}`);
    const candidates = explicitTierFields(org);
    if (Array.isArray(org?.capabilities)) {
      for (const cap of org.capabilities) {
        if (typeof cap === "string") candidates.push(cap);
      }
    }
    const tier = pickBestTier(candidates.map(normalizeTier));
    if (tier) return tier;
  } catch {
    // fall through
  }

  // 3. Bootstrap growthbook flags (older, still reliable booleans).
  try {
    const bootstrap = await apiFetch(
      `/bootstrap/${orgId}/app_start?statsig_hashing_algorithm=djb2`
    );
    const user = bootstrap?.org_growthbook?.user;
    if (user) {
      if (user.isMax) return user.maxTier === "20x" ? "max_20x" : "max_5x";
      if (user.isRaven) return "team";
      if (user.isEnterprise) return "enterprise";
      if (user.isPro) return "pro";
      if (user.isFree) return "free";
    }
    const tier = pickBestTier(explicitTierFields(bootstrap?.account).map(normalizeTier));
    if (tier) return tier;
  } catch {
    // fall through
  }
  return null;
}

// ─── Main fetch cycle ───────────────────────────────────────────────────────

const TIER_TTL_MS = 12 * 60 * 60_000; // re-detect tier every 12h
let inFlight = null;                   // dedupe concurrent fetch cycles (per worker)

function fetchUsageAndUpdate(force = false) {
  if (inFlight) return inFlight;
  inFlight = doFetchUsage(force).finally(() => { inFlight = null; });
  return inFlight;
}

async function doFetchUsage(force = false) {
  if (!force) {
    const { backoffUntil = 0 } = await getThrottle();
    if (Date.now() < backoffUntil) return;
  }
  try {
    const orgId = await getOrgId();
    if (!orgId) {
      await mergeState({
        lastError: "Not signed in to Claude.",
        errorCode: "no_org",
        lastErrorAt: Date.now(),
      });
      return;
    }

    const usage = await apiFetch(`/organizations/${orgId}/usage`);
    const buckets = extractBuckets(usage);

    const ex = usage.extra_usage || {};
    const extraEnabled = ex.is_enabled ?? false;
    const extraSpentCents = ex.used_credits ?? 0;
    const extraLimitCents = ex.monthly_limit ?? 0;
    const extraUtilization = typeof ex.utilization === "number" ? ex.utilization : null;
    const extraResetsAt = toEpoch(ex.resets_at ?? ex.monthly_reset_at);

    // Extra usage engages when ANY limit bucket is exhausted — weekly
    // exhaustion bills extra credits even while the session bucket is low.
    const anyExhausted = buckets.some(
      (b) => b.utilization != null && b.utilization >= 100
    );
    const extraInUse = extraEnabled && anyExhausted;

    let extraBalanceUsd = null;
    if (extraEnabled) {
      try {
        const credits = await apiFetch(`/organizations/${orgId}/prepaid/credits`);
        extraBalanceUsd = credits.amount != null ? credits.amount / 100 : null;
      } catch {
        // Non-fatal
      }
    }

    // Tier is stable — only re-detect when missing or stale. Saves 1-3
    // requests per cycle.
    const { usageState: prevState } = await chrome.storage.local.get("usageState");
    const prev = prevState || DEFAULT_STATE;
    const tierStale =
      !prev.subscriptionTier ||
      !prev.tierFetchedAt ||
      Date.now() - prev.tierFetchedAt > TIER_TTL_MS;

    const [tier, routineRuns] = await Promise.all([
      tierStale ? fetchTier(orgId) : Promise.resolve(null),
      fetchRoutineRuns(orgId),
    ]);

    const partial = {
      buckets,
      extraUsage: {
        enabled: extraEnabled,
        inUse: extraInUse,
        spentUsd: extraSpentCents / 100,
        limitUsd: extraLimitCents / 100,
        balanceUsd: extraBalanceUsd,
        utilization: extraUtilization,
        resetsAt: extraResetsAt,
      },
      orgId,
      lastUpdated: Date.now(),
      lastError: null,
      errorCode: null,
    };
    // Never clobber known-good values with nulls from a failed probe.
    if (tier) {
      partial.subscriptionTier = tier;
      partial.tierFetchedAt = Date.now();
    }
    if (routineRuns != null) partial.routineRuns = routineRuns;

    await patchThrottle({ backoffUntil: 0 });
    await mergeState(partial);
  } catch (err) {
    console.error("[Claude Usage Badge] fetch error:", err);
    let errorCode = "unknown";
    let lastError = err.message || "Failed to fetch usage";
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) {
        errorCode = "auth";
        lastError = "Claude session expired or unauthorized.";
      } else if (err.status === 404) {
        // A 404 means the endpoint moved, not that the user is signed out.
        errorCode = "unknown";
        lastError = "Claude usage API not found — the API may have changed.";
      } else if (err.status === 429) {
        errorCode = "network";
        lastError = "Rate limited by claude.ai — backing off.";
        await patchThrottle({ backoffUntil: Date.now() + 5 * 60_000 });
      } else if (err.status === 0) {
        errorCode = "network";
        lastError = "Unexpected non-JSON response from claude.ai.";
      } else {
        errorCode = "network";
      }
    } else if (err instanceof TypeError) {
      errorCode = "network";
      lastError = "Network error reaching claude.ai.";
    }
    // Note: lastUpdated is NOT touched here — it tracks successful data only.
    await mergeState({ lastError, errorCode, lastErrorAt: Date.now() });
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.local.set({ usageState: DEFAULT_STATE });
  } else {
    // Update: migrate stored state to the current shape without wiping it.
    const { usageState } = await chrome.storage.local.get("usageState");
    await chrome.storage.local.set({
      usageState: {
        ...DEFAULT_STATE,
        ...(usageState || {}),
        extraUsage: {
          ...DEFAULT_STATE.extraUsage,
          ...((usageState && usageState.extraUsage) || {}),
        },
      },
    });
  }
  // Drop diagnostic data from previous versions if present.
  if (!DEBUG) await chrome.storage.local.remove("seenApiPaths");
  await refreshBadge();
  fetchUsageAndUpdate();
});

// Re-render the badge from stored state whenever the worker wakes.
refreshBadge().catch(() => {});

// Recreating an alarm resets its timer — with frequent SW wakes, a
// re-created 3-minute alarm might never actually fire. Only create it
// if it doesn't already exist.
chrome.alarms.get("refreshUsage").then((existing) => {
  if (!existing) chrome.alarms.create("refreshUsage", { periodInMinutes: 3 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshUsage") fetchUsageAndUpdate();
});

// ─── Message handlers ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CLAUDE_USAGE_UPDATE") {
    fetchUsageAndUpdate()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === "GET_USAGE_STATE") {
    chrome.storage.local
      .get("usageState")
      .then(({ usageState }) => sendResponse(usageState || DEFAULT_STATE))
      .catch(() => sendResponse(DEFAULT_STATE));
    return true;
  }
  if (msg?.type === "FORCE_REFRESH") {
    fetchUsageAndUpdate(true)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === "SNIFFED_PAYLOAD") {
    handleSniffedPayload(msg.url, msg.body);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "API_URL_SEEN") {
    if (DEBUG) recordSeenUrl(msg.url);
    sendResponse({ ok: true });
    return false;
  }
});

// ─── Diagnostic URL log (DEBUG-only) ───────────────────────────────────────
// Keeps the last 100 unique /api/ paths the page has hit (with the orgId
// redacted). Only runs when DEBUG=true above. Helpful when discovering new
// endpoints; otherwise idle.
async function recordSeenUrl(url) {
  if (!url) return;
  try {
    const u = new URL(url, "https://claude.ai");
    const pathRedacted = u.pathname.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "{orgId}"
    );
    const { seenApiPaths = [] } = await chrome.storage.local.get("seenApiPaths");
    if (!seenApiPaths.includes(pathRedacted)) {
      const next = [...seenApiPaths, pathRedacted].slice(-100);
      await chrome.storage.local.set({ seenApiPaths: next });
      dbg("new API path seen:", pathRedacted);
    }
  } catch {
    // ignore
  }
}

// ─── Sniffed-payload handling ──────────────────────────────────────────────
// When the settings/usage page loads, the Claude app itself fetches endpoints
// we don't directly poll. The content script forwards those responses here so
// we can extract run budgets without hardcoding endpoint paths.

// Heuristic: given a JSON body from a run-budget-ish URL, find something
// shaped like a run budget. Keys are deliberately specific — generic pairs
// like current/total or used/max match pagination and quota objects that
// have nothing to do with runs.
function extractRunBudget(body) {
  if (!body || typeof body !== "object") return null;

  const usedKeys = ["runs_used", "used_runs", "daily_runs_used", "routines_used", "used", "consumed"];
  const limitKeys = ["runs_limit", "daily_runs_limit", "routines_limit", "run_budget", "daily_limit", "limit", "budget"];
  const resetKeys = ["resets_at", "reset_at", "next_reset", "next_reset_at"];

  function walk(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 3) return null;

    const keys = Object.keys(node);
    const used = keys.find((k) => usedKeys.includes(k.toLowerCase()));
    const limit = keys.find((k) => limitKeys.includes(k.toLowerCase()));
    if (used != null && limit != null) {
      const u = node[used];
      const l = node[limit];
      if (typeof u === "number" && typeof l === "number" && u >= 0 && l >= 0) {
        const resetKey = keys.find((k) => resetKeys.includes(k.toLowerCase()));
        return {
          used: u,
          limit: l,
          resetsAt: resetKey ? toEpoch(node[resetKey]) : null,
        };
      }
    }

    for (const v of Object.values(node)) {
      if (v && typeof v === "object") {
        const found = walk(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  return walk(body);
}

async function handleSniffedPayload(url, body) {
  dbg("sniffed:", url, body);
  if (!url || !body) return;

  // Only treat this as run-budget data when the URL clearly says so.
  // Bare "agent"/"budget" matched far too many unrelated endpoints.
  const isRoutineLike =
    /\broutines?\b|run[-_]?budget|cowork/i.test(url) && !/\/usage(\?|$)/i.test(url);
  if (!isRoutineLike) return;

  const budget = extractRunBudget(body);
  if (budget) {
    await mergeState({ routineRuns: budget });
  }
}
