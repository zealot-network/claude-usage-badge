// background.js — MV3 service worker
// Single source of truth for usage state; drives the badge.
//
// Design: the /usage endpoint keeps gaining new bucket types over time
// (seven_day_sonnet, seven_day_opus, Claude Design, etc.). Rather than
// hardcoding a fixed list, we discover any object with shape
// { utilization, resets_at } and surface it in the popup. That keeps the
// extension resilient when Anthropic adds another bucket.

const DEFAULT_STATE = {
  buckets: [],          // [{ key, label, utilization, resetsAt }]
  routineRuns: null,    // { used, limit, resetsAt } | null
  extraUsage: {
    enabled: null,
    inUse: null,
    spentUsd: null,
    limitUsd: null,
    balanceUsd: null,
    resetsAt: null,
  },
  subscriptionTier: null,
  orgId: null,
  lastUpdated: null,
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
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
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
      out.push({
        key,
        label: labelFor(key),
        utilization: null,
        resetsAt: null,
        inactive: true,
      });
      continue;
    }

    if (!val || typeof val !== "object") continue;
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

function computeBadge(state) {
  const session = state.buckets.find((b) => b.key === "five_hour");
  const sessionPct = session?.utilization ?? null;
  const extra = state.extraUsage || {};

  if (sessionPct == null) {
    return { text: "", color: "#666666", title: "Claude Usage Badge — no data yet" };
  }

  const pct = Math.min(999, Math.round(sessionPct));
  const inExtra = !!extra.inUse;
  // Always show the percentage sign. Extra-usage state is already signaled
  // by the red badge color, so we don't need a separate "$" indicator.
  const text = `${pct}%`;

  let color;
  if (inExtra)        color = "#EF4444";
  else if (pct >= 90) color = "#EF4444";
  else if (pct >= 70) color = "#F59E0B";
  else                color = "#0FA958";

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

// ─── API layer ──────────────────────────────────────────────────────────────

async function getOrgId() {
  try {
    const cookie = await chrome.cookies.get({
      name: "lastActiveOrg",
      url: "https://claude.ai",
    });
    return cookie?.value || null;
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
  return resp.json();
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

async function fetchRoutineRuns(orgId) {
  // Cowork is Claude's codename for scheduled routines. The settings page
  // fetches /cowork_settings; that's the endpoint we want.
  const candidates = [
    `/organizations/${orgId}/cowork_settings`,
    `/organizations/${orgId}/routines/run-budget`,
    `/organizations/${orgId}/code/routines/run-budget`,
    `/organizations/${orgId}/routines/budget`,
  ];
  const { ok, data, endpoint } = await tryEndpoints(candidates);
  if (!ok || !data) return null;

  console.log("[Claude Usage Badge] cowork/routines response from", endpoint, data);

  // Shape is best-effort — try several plausible key names, then fall back
  // to walking the object looking for a used/limit pair.
  const directUsed =
    data.used ?? data.consumed ?? data.runs_used ?? data.used_runs ??
    data.daily_runs_used ?? data.routines_used ?? null;
  const directLimit =
    data.limit ?? data.budget ?? data.daily_limit ?? data.runs_limit ??
    data.daily_runs_limit ?? data.routines_limit ?? null;
  const directReset = toEpoch(
    data.resets_at ?? data.reset_at ?? data.next_reset ?? data.next_reset_at
  );

  if (directUsed != null || directLimit != null) {
    return { used: directUsed, limit: directLimit, resetsAt: directReset };
  }

  // Heuristic walk for nested shapes.
  return extractRunBudget(data);
}

// Normalize a raw plan string from any endpoint into our canonical tier keys.
function normalizeTier(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.toLowerCase().replace(/[\s-]/g, "_");
  if (s.includes("max") && (s.includes("20") || s.includes("twenty"))) return "max_20x";
  if (s.includes("max") && (s.includes("5") || s.includes("five"))) return "max_5x";
  if (s.includes("max")) return "max_5x";
  if (s.includes("enterprise")) return "enterprise";
  if (s.includes("team") || s.includes("raven")) return "team";
  if (s.includes("pro")) return "pro";
  if (s.includes("free")) return "free";
  return null;
}

// Rank tiers from highest to lowest so we can pick the best candidate
// when a response lists multiple (e.g. capabilities=["claude_pro","claude_max_5x"]).
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

function collectTierStrings(obj, out = [], depth = 0) {
  if (!obj || depth > 3) return out;
  if (typeof obj === "string") {
    out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v) => collectTierStrings(v, out, depth + 1));
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      // Only walk keys that plausibly relate to plan/tier/capability
      if (/plan|tier|subscription|capability|capabilities|product/i.test(k)) {
        collectTierStrings(v, out, depth + 1);
      }
    }
  }
  return out;
}

async function fetchTier(orgId) {
  const candidates = [];

  // Most authoritative source: subscription_details (discovered via sniffer).
  try {
    const sub = await apiFetch(`/organizations/${orgId}/subscription_details`);
    console.log("[Claude Usage Badge] subscription_details:", sub);
    collectTierStrings(sub, candidates);
    // Common flat fields
    for (const k of ["tier", "plan", "plan_name", "product", "subscription_tier", "name"]) {
      if (sub?.[k]) candidates.push(sub[k]);
    }
    // Max multiplier flag
    if (sub?.max_multiplier) candidates.push(`max_${sub.max_multiplier}x`);
  } catch {
    // Non-fatal — fall through to other sources
  }

  try {
    const org = await apiFetch(`/organizations/${orgId}`);
    collectTierStrings(org, candidates);
    if (Array.isArray(org?.capabilities)) candidates.push(...org.capabilities);
    if (org?.settings?.claude_max_enabled) candidates.push("claude_max");
  } catch {
    // Non-fatal
  }

  try {
    const bootstrap = await apiFetch(
      `/bootstrap/${orgId}/app_start?statsig_hashing_algorithm=djb2`
    );
    const user = bootstrap?.org_growthbook?.user;
    if (user) {
      if (user.isMax) candidates.push(user.maxTier === "20x" ? "max_20x" : "max_5x");
      if (user.isRaven) candidates.push("team");
      if (user.isEnterprise) candidates.push("enterprise");
      if (user.isPro) candidates.push("pro");
      if (user.isFree) candidates.push("free");
    }
    collectTierStrings(bootstrap?.account, candidates);
    collectTierStrings(bootstrap?.org_growthbook, candidates);
  } catch {
    // Non-fatal
  }

  const normalized = candidates.map(normalizeTier).filter(Boolean);
  return pickBestTier(normalized);
}

async function fetchUsageAndUpdate() {
  try {
    const orgId = await getOrgId();
    if (!orgId) {
      await mergeState({
        lastError: "Not signed in to Claude.",
        errorCode: "no_org",
      });
      return;
    }

    const usage = await apiFetch(`/organizations/${orgId}/usage`);
    const buckets = extractBuckets(usage);

    const session = buckets.find((b) => b.key === "five_hour");
    const sessionPct = session?.utilization ?? null;

    const ex = usage.extra_usage || {};
    const extraEnabled = ex.is_enabled ?? false;
    const extraSpentCents = ex.used_credits ?? 0;
    const extraLimitCents = ex.monthly_limit ?? 0;
    const extraResetsAt = toEpoch(ex.resets_at ?? ex.monthly_reset_at);
    const extraInUse = extraEnabled && sessionPct != null && sessionPct >= 100;

    let extraBalanceUsd = null;
    if (extraEnabled) {
      try {
        const credits = await apiFetch(`/organizations/${orgId}/prepaid/credits`);
        extraBalanceUsd = credits.amount != null ? credits.amount / 100 : null;
      } catch {
        // Non-fatal
      }
    }

    const [tier, routineRuns] = await Promise.all([
      fetchTier(orgId),
      fetchRoutineRuns(orgId),
    ]);

    await mergeState({
      buckets,
      routineRuns,
      extraUsage: {
        enabled: extraEnabled,
        inUse: extraInUse,
        spentUsd: extraSpentCents / 100,
        limitUsd: extraLimitCents / 100,
        balanceUsd: extraBalanceUsd,
        resetsAt: extraResetsAt,
      },
      subscriptionTier: tier,
      orgId,
      lastUpdated: Date.now(),
      lastError: null,
      errorCode: null,
    });
  } catch (err) {
    console.error("[Claude Usage Badge] fetch error:", err);
    let errorCode = "unknown";
    let lastError = err.message || "Failed to fetch usage";
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) {
        errorCode = "auth";
        lastError = "Claude session expired or unauthorized.";
      } else if (err.status === 404) {
        errorCode = "auth";
        lastError = "Usage endpoint not reachable.";
      } else {
        errorCode = "network";
      }
    } else if (err instanceof TypeError) {
      errorCode = "network";
      lastError = "Network error reaching claude.ai.";
    }
    await mergeState({ lastError, errorCode, lastUpdated: Date.now() });
  }
}

async function mergeState(partial) {
  const { usageState } = await chrome.storage.local.get("usageState");
  const prev = usageState || DEFAULT_STATE;
  const next = { ...prev, ...partial };
  await chrome.storage.local.set({ usageState: next });
  await refreshBadge();
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ usageState: DEFAULT_STATE });
  await refreshBadge();
  fetchUsageAndUpdate();
});

chrome.storage.local.get("usageState").then(() => refreshBadge());

chrome.alarms.create("refreshUsage", { periodInMinutes: 3 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshUsage") fetchUsageAndUpdate();
});

// ─── Message handlers ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CLAUDE_USAGE_UPDATE") {
    fetchUsageAndUpdate().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "GET_USAGE_STATE") {
    chrome.storage.local.get("usageState").then(({ usageState }) => {
      sendResponse(usageState || DEFAULT_STATE);
    });
    return true;
  }
  if (msg?.type === "FORCE_REFRESH") {
    fetchUsageAndUpdate().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "SNIFFED_PAYLOAD") {
    handleSniffedPayload(msg.url, msg.body);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "API_URL_SEEN") {
    recordSeenUrl(msg.url);
    sendResponse({ ok: true });
    return false;
  }
});

// ─── Diagnostic URL log ────────────────────────────────────────────────────
// Keeps the last 100 unique /api/ paths the page has hit (with the orgId
// redacted so logs are sharable). Accessible via chrome.storage.local for
// debugging which endpoint serves routine-run data.
async function recordSeenUrl(url) {
  if (!url) return;
  try {
    const u = new URL(url, "https://claude.ai");
    // Redact orgId-shaped UUIDs from the path for cleaner diagnostics
    const pathRedacted = u.pathname.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "{orgId}"
    );
    const { seenApiPaths = [] } = await chrome.storage.local.get("seenApiPaths");
    if (!seenApiPaths.includes(pathRedacted)) {
      const next = [...seenApiPaths, pathRedacted].slice(-100);
      await chrome.storage.local.set({ seenApiPaths: next });
      console.log("[Claude Usage Badge] new API path seen:", pathRedacted);
    }
  } catch {
    // ignore
  }
}

// ─── Sniffed-payload handling ──────────────────────────────────────────────
// When the settings/usage page loads, the Claude app itself fetches endpoints
// we don't directly poll. The content script forwards those responses here so
// we can extract routine-run budgets without hardcoding endpoint paths.

// Heuristic: given any JSON body, find something shaped like a run budget.
// Looks for used/limit-ish numeric pairs and an optional reset timestamp.
function extractRunBudget(body) {
  if (!body || typeof body !== "object") return null;

  const usedKeys = ["used", "consumed", "runs_used", "used_runs", "current"];
  const limitKeys = ["limit", "budget", "daily_limit", "runs_limit", "total", "max"];
  const resetKeys = ["resets_at", "reset_at", "next_reset", "next_reset_at", "resets"];

  // Walk up to 3 levels deep looking for a node that has both used+limit numerics.
  function walk(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 3) return null;

    const keys = Object.keys(node);
    const used = keys.find((k) => usedKeys.includes(k.toLowerCase()));
    const limit = keys.find((k) => limitKeys.includes(k.toLowerCase()));
    if (used != null && limit != null) {
      const u = node[used];
      const l = node[limit];
      if (typeof u === "number" && typeof l === "number") {
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
  console.log("[Claude Usage Badge] sniffed:", url, body);
  if (!url || !body) return;

  // Only treat this as routine data if the URL path suggests it.
  const isRoutineLike =
    /routine|agent|budget|run[-_]?budget/i.test(url) && !/\/usage(\?|$)/i.test(url);
  if (!isRoutineLike) return;

  const budget = extractRunBudget(body);
  if (budget) {
    await mergeState({ routineRuns: budget });
  }
}
