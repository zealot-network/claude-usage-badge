// lib/core.js — pure, chrome-free logic shared by background.js, popup.js and
// the Node tests in tests/. Nothing in here may touch chrome.* or the network.

export const SCHEMA_VERSION = 2;

// ─── State shapes ───────────────────────────────────────────────────────────

export function defaultExtra() {
  return {
    enabled: null,       // null = unknown, false = off, true = on
    status: null,        // "on" | "paused" | "off" | null
    disabledReason: null,
    inUse: null,
    overLimit: null,
    spentUsd: null,      // amount in `currency` (name kept for back-compat)
    limitUsd: null,
    balanceUsd: null,
    currency: "USD",
    utilization: null,   // uncapped % (can exceed 100)
    severity: null,
    canToggle: null,
    autoReload: null,
    resetsAt: null,
    scope: null,         // "member" | "organization" for Team/Enterprise seat caps
    byOrg: false,        // credits switched off at the organization level
  };
}

// One tracked claude.ai organization (personal plan, Team seat, …).
export function defaultAccount(orgId = null) {
  return {
    orgId,
    name: null,
    kind: null,           // "personal" | "team" | "enterprise" | null
    buckets: [],          // [{ key, label, utilization, resetsAt, severity, active, inactive, scopeType }]
    routineRuns: null,    // { used, limit, resetsAt, seenAt } | null
    extraUsage: defaultExtra(),
    subscriptionTier: null,
    tierCheckedAt: null,  // last tier probe (hit or miss)
    probes: {},           // per-org cooldown timestamps for speculative endpoints
    lastUpdated: null,    // last SUCCESSFUL usage fetch
    lastErrorAt: null,
    lastError: null,
    errorCode: null,      // 'auth' | 'network' | 'shape' | 'unknown'
  };
}

export function defaultConsole() {
  return {
    enabled: false,
    orgId: null,
    orgName: null,
    balanceUsd: null,
    autoReload: null,
    spendUsd: null,
    spendLimitUsd: null,
    resetsAt: null,
    tier: null,
    expiresAt: null,     // when the soonest-expiring credits lapse
    currency: "USD",
    lastUpdated: null,
    lastErrorAt: null,
    lastError: null,
    errorCode: null,
  };
}

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    accounts: {},         // { [orgId]: Account }
    orgs: [],             // [{ id, name, kind, tier, tierGuess }] — every chat org on this login
    orgsFetchedAt: null,  // last successful list
    orgsTriedAt: null,    // last list attempt (success or not)
    activeOrgId: null,    // claude.ai's lastActiveOrg cookie
    pinnedOrgId: null,    // user's choice for the badge; null = follow active org
    console: defaultConsole(),
    // Global (login-level) error. Per-org errors live on the account.
    lastError: null,
    errorCode: null,      // 'no_org' | 'auth' | 'network' | 'unknown'
    lastErrorAt: null,
  };
}

function normalizeAccount(a, orgId) {
  const base = defaultAccount(orgId);
  const src = a && typeof a === "object" ? a : {};
  return {
    ...base,
    ...src,
    orgId: src.orgId || orgId,
    buckets: Array.isArray(src.buckets) ? src.buckets : [],
    extraUsage: { ...base.extraUsage, ...(src.extraUsage || {}) },
    probes: { ...(src.probes || {}) },
  };
}

// Accepts anything that was ever written to storage (v1 flat shape, v2, junk)
// and returns a complete v2 state. Never throws.
export function migrateState(stored) {
  const base = defaultState();
  if (!stored || typeof stored !== "object") return base;

  if (stored.schemaVersion === SCHEMA_VERSION && stored.accounts) {
    const accounts = {};
    for (const [id, a] of Object.entries(stored.accounts || {})) {
      accounts[id] = normalizeAccount(a, id);
    }
    return {
      ...base,
      ...stored,
      accounts,
      orgs: Array.isArray(stored.orgs) ? stored.orgs : [],
      console: { ...base.console, ...(stored.console || {}) },
    };
  }

  // v1: one flat record for a single org.
  const out = { ...base };
  if (stored.orgId && Array.isArray(stored.buckets)) {
    out.accounts[stored.orgId] = normalizeAccount(
      {
        buckets: stored.buckets,
        // v1 records carry no seenAt; stamp one so the 24h expiry applies.
        routineRuns: stored.routineRuns
          ? { ...stored.routineRuns, seenAt: stored.lastUpdated || 0 }
          : null,
        extraUsage: stored.extraUsage,
        subscriptionTier: stored.subscriptionTier || null,
        tierCheckedAt: stored.tierFetchedAt || null,
        lastUpdated: stored.lastUpdated || null,
      },
      stored.orgId
    );
    out.activeOrgId = stored.orgId;
  }
  out.lastError = stored.lastError || null;
  out.errorCode = stored.errorCode || null;
  out.lastErrorAt = stored.lastErrorAt || null;
  return out;
}

// Which org drives the badge: the pin if it still exists, else the active org.
export function displayOrgId(state) {
  const known = (id) =>
    !!id && (!!state.accounts?.[id] || (state.orgs || []).some((o) => o.id === id));
  if (known(state.pinnedOrgId)) return state.pinnedOrgId;
  if (state.activeOrgId) return state.activeOrgId;
  const ids = Object.keys(state.accounts || {});
  return ids.length ? ids[0] : null;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// "claude_code" → "Claude Code"; "opus_5_5" → "Opus 5.5"
export function humanize(s) {
  const tokens = String(s).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (/^\d+$/.test(t) && prev && /\d$/.test(prev)) out[out.length - 1] = prev + "." + t;
    else out.push(/^\d/.test(t) ? t : t[0].toUpperCase() + t.slice(1));
  }
  return out.join(" ");
}

export function toEpoch(v) {
  if (!v) return null;
  // Numeric timestamps: treat values below 1e12 as epoch-seconds.
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    return Number.isFinite(ms) ? ms : null;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// { amount_minor, exponent } → major units. The /usage `spend` object and its
// nested caps/balances all use this minor-unit shape.
export function minorToMajor(m) {
  if (!m || typeof m !== "object" || num(m.amount_minor) == null) return null;
  const exp = num(m.exponent) ?? 2;
  return m.amount_minor / Math.pow(10, exp);
}

// A money value that may be a plain number of cents, a numeric string of
// cents, or a { amount_minor, exponent } object. Never returns NaN.
export function centsOrMinorToMajor(v) {
  if (v == null) return null;
  if (typeof v === "object") return minorToMajor(v);
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return num(n) != null ? n / 100 : null;
}

export function currencyOf(...objs) {
  for (const o of objs) {
    const c = o && typeof o === "object" ? str(o.currency) : null;
    if (c && /^[A-Za-z]{3}$/.test(c)) return c.toUpperCase();
  }
  return "USD";
}

export function formatMoney(amount, currency = "USD") {
  if (num(amount) == null) return "—";
  // Fixed en-US grouping so output doesn't vary with the browser locale.
  const fixed = amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return !currency || currency === "USD" ? `$${fixed}` : `${fixed} ${currency}`;
}

// ─── Bucket labels ──────────────────────────────────────────────────────────

// Friendly labels for known bucket keys (legacy top-level /usage keys).
export const BUCKET_LABELS = {
  five_hour: "Session (5h)",
  seven_day: "Weekly (all models)",
  seven_day_sonnet: "Weekly Sonnet",
  seven_day_opus: "Weekly Opus",
  seven_day_fable: "Weekly Fable",
  seven_day_mythos: "Weekly Mythos",
  seven_day_haiku: "Weekly Haiku",
  // "omelette" is Claude Design's internal codename on the /usage endpoint.
  seven_day_omelette: "Weekly Claude Design",
  seven_day_design: "Weekly Claude Design",
  seven_day_claude_design: "Weekly Claude Design",
  claude_design: "Claude Design",
  // "cowork" is the internal codename for Cowork / Scheduled tasks.
  seven_day_cowork: "Weekly Cowork",
  seven_day_oauth_apps: "Weekly OAuth apps",
  omelette_promotional: "Claude Design promo",
  daily: "Daily",
};

const BUCKET_ORDER = [
  "five_hour", "seven_day", "seven_day_fable", "seven_day_mythos", "seven_day_opus",
  "seven_day_sonnet", "seven_day_haiku", "seven_day_omelette", "seven_day_design",
  "seven_day_claude_design", "claude_design", "seven_day_cowork",
  "seven_day_oauth_apps", "omelette_promotional", "daily",
];

// Weekly buckets that are product surfaces, not models.
const SURFACE_KEYS = new Set([
  "seven_day_cowork", "seven_day_oauth_apps", "seven_day_omelette",
  "seven_day_design", "seven_day_claude_design",
]);

export function labelFor(key) {
  const k = String(key);
  if (Object.prototype.hasOwnProperty.call(BUCKET_LABELS, k)) return BUCKET_LABELS[k];
  const m = /^seven_day_(.+)$/.exec(k);
  if (m) return "Weekly " + humanize(m[1]);
  return humanize(k);
}

// Top-level /usage keys that are never limit buckets, even though some of
// them carry `utilization` / `resets_at`.
const NON_BUCKET_KEYS = new Set([
  "limits", "spend", "extra_usage", "usage_credits", "seven_day_breakdown",
  "weekly_scoped_shares", "member_dashboard_available",
]);

function isPlausibleBucketKey(key) {
  return (
    Object.prototype.hasOwnProperty.call(BUCKET_LABELS, key) ||
    /^(five_hour|seven_day|daily)/.test(key)
  );
}

// ─── /usage → buckets ───────────────────────────────────────────────────────

function scopeName(v) {
  if (typeof v === "string") return str(v);
  if (v && typeof v === "object") return str(v.display_name) || str(v.name) || str(v.id);
  return null;
}

// Preferred source: the structured `limits` array. Each entry is
// { kind, percent, severity, resets_at, scope, is_active }. weekly_scoped
// entries carry scope.model.display_name ("Fable") and/or scope.surface.
export function bucketsFromLimits(limits) {
  const out = [];
  const seen = new Map();
  for (const l of limits) {
    if (!l || typeof l !== "object") continue;
    const kind = typeof l.kind === "string" && l.kind ? l.kind : "unknown";
    let key, label, scopeType = null;
    if (kind === "session") {
      key = "five_hour";
      label = BUCKET_LABELS.five_hour;
    } else if (kind === "weekly_all") {
      key = "seven_day";
      label = BUCKET_LABELS.seven_day;
    } else if (kind === "weekly_scoped") {
      const model = scopeName(l.scope?.model);
      const surface = scopeName(l.scope?.surface);
      if (model) {
        key = "seven_day_" + slugify(model) + (surface ? "_" + slugify(surface) : "");
        label = "Weekly " + model + (surface ? ` (${humanize(surface)})` : "");
        scopeType = "model";
      } else if (surface) {
        key = "seven_day_" + slugify(surface);
        label = "Weekly " + humanize(surface);
        scopeType = "surface";
      } else {
        key = "seven_day_scoped";
        label = "Weekly (scoped)";
        scopeType = "model";
      }
    } else {
      // Unknown kind — surface it rather than drop it.
      key = slugify(kind) || "unknown";
      label = labelFor(key);
      scopeType = "other";
    }
    // Two limits must never share a key (rows would be indistinguishable).
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    if (n > 0) {
      key = `${key}_${n + 1}`;
      label = `${label} #${n + 1}`;
    }
    out.push({
      key,
      label,
      utilization: num(l.percent),
      resetsAt: toEpoch(l.resets_at),
      severity: str(l.severity),
      active: l.is_active === true,
      inactive: false,
      scopeType,
    });
  }
  const rank = (k) => (k === "five_hour" ? 0 : k === "seven_day" ? 1 : 2);
  out.sort((a, b) => rank(a.key) - rank(b.key));
  return out;
}

// Legacy source: top-level keys shaped { utilization, resets_at }.
export function extractBuckets(usage) {
  if (!usage || typeof usage !== "object") return [];
  const out = [];
  for (const [key, val] of Object.entries(usage)) {
    if (NON_BUCKET_KEYS.has(key)) continue;
    const scopeType =
      key === "five_hour" || key === "seven_day"
        ? null
        : SURFACE_KEYS.has(key)
          ? "surface"
          : key.startsWith("seven_day_")
            ? "model"
            : "other";

    // Null-valued buckets are limits the plan exposes but the user hasn't
    // touched yet — shown muted.
    if (val === null) {
      if (!isPlausibleBucketKey(key)) continue;
      out.push({
        key, label: labelFor(key), utilization: null, resetsAt: null,
        severity: null, active: false, inactive: true, scopeType,
      });
      continue;
    }
    if (typeof val !== "object" || Array.isArray(val)) continue;
    if (!("utilization" in val) && !("resets_at" in val)) continue;
    out.push({
      key, label: labelFor(key), utilization: num(val.utilization),
      resetsAt: toEpoch(val.resets_at), severity: null, active: false,
      inactive: false, scopeType,
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

export class ShapeError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ShapeError";
  }
}

// limits[] is authoritative when present. Legacy top-level buckets are only
// appended when they are clearly live (a number AND a reset time) and are not
// already covered — so a limit Anthropic still reports only as a legacy key
// isn't silently dropped, while retired keys lingering at null/0 are.
export function bucketsFromUsage(usage) {
  if (!Array.isArray(usage.limits) || usage.limits.length === 0) {
    return extractBuckets(usage);
  }
  const buckets = bucketsFromLimits(usage.limits);
  const have = new Set(buckets.map((b) => b.key));
  for (const b of extractBuckets(usage)) {
    if (b.key === "five_hour" || b.key === "seven_day") continue;
    if (have.has(b.key)) continue;
    if (b.utilization == null || b.resetsAt == null) continue;
    buckets.push(b);
  }
  return buckets;
}

// ─── /usage → usage credits ─────────────────────────────────────────────────

export function detectAutoReload(o) {
  if (!o || typeof o !== "object") return null;
  const candidates = [
    o.auto_reload, o.auto_reload_enabled, o.is_auto_reload_enabled,
    o.auto_reload?.enabled, o.auto_reload?.is_enabled,
    o.auto_reload_settings?.enabled,
  ];
  for (const c of candidates) if (typeof c === "boolean") return c;
  return null;
}

// Derives status / over-limit / in-use from raw numbers. Shared by the /usage
// parse and by later enrichment (prepaid balance, member spend limit).
export function finalizeExtra(extra, buckets) {
  const e = { ...extra };
  // "Disabled by the organization" (e.g. org limit set to zero) is a settled
  // OFF, not a temporary pause — observed live as `org_level_disabled_until`
  // and `org_limit_set_to_zero`.
  e.byOrg = e.enabled === false && isOrgLevelReason(e.disabledReason);
  if (e.enabled === true) e.status = "on";
  else if (e.byOrg) e.status = "off";
  else if (e.enabled === false && e.disabledReason) e.status = "paused";
  else if (e.enabled === false) e.status = "off";
  else e.status = null;

  // TRUE utilization (uncapped) so 107%-over-limit shows honestly.
  if (e.spentUsd != null && e.limitUsd > 0) {
    e.utilization = (e.spentUsd / e.limitUsd) * 100;
  }
  // Over-limit only means something while credits are (or were just) on.
  e.overLimit =
    (e.status === "on" || e.status === "paused") &&
    e.spentUsd != null && e.limitUsd != null && e.spentUsd > e.limitUsd;

  // "IN USE" = credits on AND a limit that actually gates usage is exhausted:
  // session, weekly-all, or a scoped limit the API marks as the active one.
  const gating = (b) =>
    b.utilization != null && b.utilization >= 100 &&
    (b.key === "five_hour" || b.key === "seven_day" || b.active === true);
  e.inUse = e.enabled === true && (buckets || []).some(gating);
  return e;
}

export function isOrgLevelReason(reason) {
  return typeof reason === "string" && /^org_|_org_|org_level|org_limit/i.test(reason);
}

export function parseUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new ShapeError("Unexpected /usage response shape");
  }
  const buckets = bucketsFromUsage(usage);
  // An object with none of the things we know how to read means the payload
  // was restructured — say so instead of showing a silent blank badge.
  const hasCredits = ["spend", "extra_usage", "usage_credits"].some(
    (k) => usage[k] && typeof usage[k] === "object"
  );
  if (buckets.length === 0 && !hasCredits) {
    throw new ShapeError("No recognizable limits in /usage response");
  }

  // `spend` is authoritative; `extra_usage` / `usage_credits` are legacy.
  const spend = usage.spend && typeof usage.spend === "object" ? usage.spend : null;
  const legacy =
    (usage.extra_usage && typeof usage.extra_usage === "object" && usage.extra_usage) ||
    (usage.usage_credits && typeof usage.usage_credits === "object" && usage.usage_credits) ||
    {};

  const extra = defaultExtra();
  if (spend) {
    extra.spentUsd = minorToMajor(spend.used);
    extra.limitUsd =
      minorToMajor(spend.limit) ??
      minorToMajor(spend.cap?.credits) ??
      minorToMajor(spend.cap?.money);
    extra.enabled = typeof spend.enabled === "boolean" ? spend.enabled : null;
    extra.disabledReason = str(spend.disabled_reason);
    extra.utilization = num(spend.percent);
    extra.severity = str(spend.severity);
    extra.canToggle = typeof spend.can_toggle === "boolean" ? spend.can_toggle : null;
    extra.autoReload = typeof spend.auto_reload === "boolean" ? spend.auto_reload : null;
    extra.balanceUsd = minorToMajor(spend.balance);
    extra.resetsAt = toEpoch(spend.resets_at ?? spend.reset_at);
    extra.currency = currencyOf(spend.used, spend.limit, spend.balance, spend);
  } else {
    extra.enabled = typeof legacy.is_enabled === "boolean" ? legacy.is_enabled : null;
    extra.spentUsd = num(legacy.used_credits) != null ? legacy.used_credits / 100 : null;
    extra.limitUsd = num(legacy.monthly_limit) != null ? legacy.monthly_limit / 100 : null;
    extra.utilization = num(legacy.utilization);
    extra.disabledReason = str(legacy.disabled_reason);
    extra.resetsAt = toEpoch(legacy.resets_at ?? legacy.monthly_reset_at);
    extra.currency = currencyOf(legacy);
  }
  return { buckets, extraUsage: finalizeExtra(extra, buckets) };
}

// Team / Enterprise seats: the cap that applies to this seat isn't in /usage
// `spend`; it comes from /overage_spend_limit as
// { limit_type: "organization" | "member" | …, is_enabled, monthly_credit_limit
//   (cents), used_credits (cents), currency, disabled_reason }.
// Verified live for a Team org with limit_type "organization"; the "member"
// variant is from public bug reports only.
export function applyOverageSpendLimit(extra, body, buckets) {
  if (!body || typeof body !== "object") return extra;
  const limit = centsOrMinorToMajor(body.monthly_credit_limit);
  const used = centsOrMinorToMajor(body.used_credits);
  if (limit == null && used == null) return extra;
  const e = { ...extra };
  if (used != null) e.spentUsd = used;
  if (str(body.currency)) e.currency = currencyOf(body);
  if (str(body.limit_type)) e.scope = body.limit_type;
  const reason = str(body.disabled_reason);
  if (reason || !(limit > 0)) {
    // `is_enabled: true` with a zero limit / a disabled_reason means credits
    // are effectively off for this seat — never report that as ON.
    if (reason) e.disabledReason = reason;
    if (e.enabled == null || (limit === 0 && body.is_enabled !== false)) e.enabled = false;
    if (limit === 0 && !e.disabledReason) e.disabledReason = "org_limit_set_to_zero";
  } else {
    e.limitUsd = limit;
    if (typeof body.is_enabled === "boolean") e.enabled = body.is_enabled;
  }
  return finalizeExtra(e, buckets);
}

// ─── Scheduled / routine-run budget ─────────────────────────────────────────

const RUN_USED_KEYS = ["runs_used", "used_runs", "daily_runs_used", "routines_used"];
const RUN_LIMIT_KEYS = ["runs_limit", "daily_runs_limit", "routines_limit", "run_budget", "daily_limit"];
const RUN_RESET_KEYS = ["resets_at", "reset_at", "next_reset", "next_reset_at"];

// `allowGeneric` additionally accepts bare used/limit at the TOP level only —
// for responses from an endpoint whose whole purpose is the run budget.
export function extractRunBudget(body, { allowGeneric = false } = {}) {
  if (!body || typeof body !== "object") return null;

  function read(node, usedKeys, limitKeys) {
    const keys = Object.keys(node);
    const used = keys.find((k) => usedKeys.includes(k.toLowerCase()));
    const limit = keys.find((k) => limitKeys.includes(k.toLowerCase()));
    if (used == null || limit == null) return null;
    const u = num(node[used]);
    const l = num(node[limit]);
    if (u == null || l == null || u < 0 || l <= 0 || l > 100000) return null;
    const resetKey = keys.find((k) => RUN_RESET_KEYS.includes(k.toLowerCase()));
    return { used: u, limit: l, resetsAt: resetKey ? toEpoch(node[resetKey]) : null };
  }

  function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 3) return null;
    if (!Array.isArray(node)) {
      const hit = read(node, RUN_USED_KEYS, RUN_LIMIT_KEYS);
      if (hit) return hit;
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") {
        const found = walk(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  const specific = walk(body, 0);
  if (specific) return specific;
  if (allowGeneric && !Array.isArray(body)) {
    return read(body, [...RUN_USED_KEYS, "used"], [...RUN_LIMIT_KEYS, "limit"]);
  }
  return null;
}

// A stored run budget stops being true once its window has reset.
export function liveRoutineRuns(runs, now = Date.now()) {
  if (!runs || typeof runs !== "object") return null;
  if (runs.resetsAt && runs.resetsAt <= now) return null;
  // No reset time: trust it for a day from when it was seen (never, if unknown).
  if (!runs.resetsAt && now - (runs.seenAt || 0) > 24 * 60 * 60_000) return null;
  return runs;
}

// ─── Tier detection ─────────────────────────────────────────────────────────

// Tokens that mark a flag-style string ("claude_max_disabled", "pro_upsell_seen").
const TIER_NEGATIVE_TOKENS = new Set([
  "disabled", "ineligible", "upsell", "banner", "seen", "dismissed",
  "eligible", "promo", "trial", "ended", "expired",
]);

export function normalizeTier(raw) {
  if (!raw || typeof raw !== "string") return null;
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const has = (t) => tokens.includes(t);
  for (const t of tokens) if (TIER_NEGATIVE_TOKENS.has(t)) return null;

  if (has("ultra")) return "ultra";
  // Org-type tokens beat "max": a Team premium seat is still a Team seat.
  if (has("enterprise")) return "enterprise";
  if (has("team") || has("raven")) return "team";
  if (has("max") && (has("20x") || has("20") || has("twenty"))) return "max_20x";
  if (has("max")) return "max_5x";
  if (has("pro")) return "pro";
  if (has("free")) return "free";
  return null;
}

export const TIER_RANK = {
  ultra: 7, max_20x: 6, max_5x: 5, enterprise: 4, team: 3, pro: 2, free: 1,
};

export function pickBestTier(tiers) {
  let best = null;
  for (const t of tiers) {
    if (!t || !TIER_RANK[t]) continue;
    if (!best || TIER_RANK[t] > TIER_RANK[best]) best = t;
  }
  return best;
}

// Only keys that explicitly name a plan. NOT `name`: on org/account records
// that is a display name ("Max's Team", "Pro Painting LLC").
const TIER_FIELD_NAMES = [
  "tier", "plan", "plan_name", "plan_type", "subscription_tier",
  "product_name", "rate_limit_tier", "billing_type", "analytics_subscription_plan",
];

export function explicitTierFields(obj) {
  const out = [];
  if (!obj || typeof obj !== "object") return out;
  for (const k of TIER_FIELD_NAMES) if (typeof obj[k] === "string") out.push(obj[k]);
  for (const wrap of ["subscription", "billing", "plan"]) {
    const inner = obj[wrap];
    if (inner && typeof inner === "object") {
      for (const k of TIER_FIELD_NAMES) if (typeof inner[k] === "string") out.push(inner[k]);
    }
  }
  return out;
}

function capsOf(org) {
  return Array.isArray(org?.capabilities)
    ? org.capabilities.filter((c) => typeof c === "string").map((c) => c.toLowerCase())
    : [];
}

export function orgKind(org) {
  const caps = capsOf(org);
  const rt = str(org?.raven_type);
  if (rt) return /enterprise/i.test(rt) ? "enterprise" : "team";
  if (caps.includes("raven")) return "team";
  if (caps.length && !caps.includes("chat")) return "api";
  return "personal";
}

// Tier straight from an /api/organizations record — no extra requests.
export function tierFromOrg(org) {
  if (!org || typeof org !== "object") return null;
  const kind = orgKind(org);
  if (kind === "enterprise" || kind === "team") return kind;
  const caps = capsOf(org);
  const fromFields = pickBestTier(explicitTierFields(org).map(normalizeTier));
  if (caps.some((c) => c.includes("ultra"))) return "ultra";
  if (caps.some((c) => c.includes("claude_max"))) {
    // "Max" alone doesn't say 5× or 20×. Only answer when a field settles it;
    // otherwise return null so the caller asks subscription_details.
    return ["ultra", "max_20x", "max_5x"].includes(fromFields) &&
      /ultra|20|5/.test(explicitTierFields(org).join(" "))
      ? fromFields
      : null;
  }
  if (fromFields) return fromFields;
  if (caps.some((c) => c.includes("claude_pro"))) return "pro";
  return null;
}

// Last-resort label when nothing authoritative answered.
export function tierGuessFromOrg(org) {
  return capsOf(org).some((c) => c.includes("claude_max")) ? "max_5x" : null;
}

// /api/organizations → the orgs worth tracking (anything that can chat).
export function summarizeOrgs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const id = str(o.uuid) || str(o.id);
    if (!id || !UUID_RE.test(id)) continue;
    const kind = orgKind(o);
    if (kind === "api") continue;
    out.push({ id, name: str(o.name), kind, tier: tierFromOrg(o), tierGuess: tierGuessFromOrg(o) });
  }
  return out;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatTier(tier) {
  const map = {
    free: "Free", pro: "Pro", team: "Team", enterprise: "Enterprise",
    max_5x: "Max 5×", max_20x: "Max 20×", ultra: "Ultra",
  };
  return tier ? map[tier] || tier : "—";
}

// ─── API Console (platform.claude.com) ──────────────────────────────────────
// Private, undocumented endpoints. Shapes verified against a live Console
// session on 2026-11-13:
//   prepaid/credits → { amount (cents), auto_reload_settings: null | {enabled}, next_expires_at }
//   current_spend   → { amount (cents), resets_at }
//   rate_limits     → { rate_limit_tier: "auto_trust_tier_a", spend_threshold, … }
// The parsers stay tolerant and return nulls for anything they don't know.

function firstMoney(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    if (k in obj) {
      const v = centsOrMinorToMajor(obj[k]);
      if (v != null) return v;
    }
  }
  return null;
}

export function parseConsoleCredits(body) {
  return {
    balanceUsd: firstMoney(body, ["amount", "balance", "remaining", "available", "credit_balance"]),
    // `auto_reload_settings: null` means auto-reload isn't set up.
    autoReload:
      detectAutoReload(body) ??
      (body && typeof body === "object" && body.auto_reload_settings === null ? false : null),
    expiresAt: toEpoch(body?.next_expires_at),
    currency: currencyOf(body, body?.amount),
  };
}

export function parseConsoleSpend(body) {
  if (!body || typeof body !== "object") {
    return { spendUsd: null, spendLimitUsd: null, resetsAt: null };
  }
  return {
    spendUsd: firstMoney(body, ["amount", "current_spend", "spend", "used", "total", "usage"]),
    spendLimitUsd: firstMoney(body, ["limit", "spend_limit", "monthly_limit", "cap"]),
    resetsAt: toEpoch(
      body.resets_at ?? body.reset_at ?? body.period_end ?? body.next_reset ?? body.ends_at
    ),
  };
}

export function parseConsoleRateLimits(body) {
  if (!body || typeof body !== "object") return { tier: null, spendLimitUsd: null };
  // `rate_limit_tier` is an internal id ("auto_trust_tier_a") whose mapping
  // to the Console's displayed tier isn't known — only a plain `tier` is shown.
  const t = body.tier ?? body.usage_tier;
  return {
    tier: typeof t === "string" || typeof t === "number" ? String(t) : null,
    spendLimitUsd: firstMoney(body, ["monthly_limit", "monthly_spend_limit", "spend_limit", "cap"]),
  };
}

// ─── Badge ──────────────────────────────────────────────────────────────────

// Deeper tones than the popup's on purpose — badge text is forced white and
// needs a darker background to stay readable at ~9px.
export const COLOR_GREEN = "#15803D";
export const COLOR_AMBER = "#B45309";
export const COLOR_RED = "#B91C1C";
export const COLOR_GREY = "#52525B";

const APP = "Claude Usage Badge";
const STALE_AFTER_MS = 20 * 60_000;

export function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 48) return rm ? `${hrs}h ${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh ? `${days}d ${rh}h` : `${days}d`;
}

export function computeBadge(state, now = Date.now()) {
  // Signed out / session expired: never keep showing the last percentages as
  // if they were live.
  if (state.errorCode === "no_org" || state.errorCode === "auth") {
    return { text: "!", color: COLOR_GREY, title: `${APP} — ${state.lastError || "Sign in to Claude"}` };
  }

  const orgId = displayOrgId(state);
  const acct = orgId ? state.accounts?.[orgId] : null;
  const buckets = acct?.buckets || [];
  const session = buckets.find((b) => b.key === "five_hour");
  const weeklyAll = buckets.find((b) => b.key === "seven_day");

  // The badge escalates on session vs. weekly-ALL-MODELS only — the limits
  // that gate ALL Claude usage. A maxed per-model bucket doesn't block Claude,
  // so it must not hijack the headline number. Plans with no session limit
  // (verified Ultra) fall back to weekly-all.
  const gating = [session, weeklyAll].filter((b) => b && b.utilization != null);

  const err = acct?.lastError || state.lastError || null;
  if (gating.length === 0) {
    if (err) return { text: "!", color: COLOR_GREY, title: `${APP} — ${err}` };
    const extra = acct?.extraUsage;
    // Spend-only seats (usage-based Enterprise): show credit utilization.
    if (extra && extra.utilization != null && (extra.status === "on" || extra.status === "paused")) {
      const p = Math.min(999, Math.round(extra.utilization));
      const color = p >= 90 ? COLOR_RED : p >= 70 ? COLOR_AMBER : COLOR_GREEN;
      return {
        text: `${p}%`, color,
        title: `Usage credits: ${formatMoney(extra.spentUsd, extra.currency)} / ${formatMoney(extra.limitUsd, extra.currency)}`,
      };
    }
    return { text: "", color: COLOR_GREY, title: `${APP} — no data yet` };
  }

  let worst = gating[0];
  for (const b of gating) if (b.utilization > worst.utilization) worst = b;
  const extra = acct.extraUsage || {};
  const inExtra = !!extra.inUse;
  const pct = Math.min(999, Math.round(worst.utilization));

  // Prefer the API's own severity for the worst limit; fall back to % bands.
  let color;
  const stale = acct.lastUpdated != null && now - acct.lastUpdated > STALE_AFTER_MS && !!err;
  if (stale) color = COLOR_GREY;
  else if (inExtra || extra.overLimit) color = COLOR_RED;
  else if (worst.severity === "critical") color = COLOR_RED;
  else if (worst.severity === "warning") color = COLOR_AMBER;
  else if (worst.severity === "normal") color = COLOR_GREEN;
  else if (worst.utilization >= 90) color = COLOR_RED;
  else if (worst.utilization >= 70) color = COLOR_AMBER;
  else color = COLOR_GREEN;

  const parts = [];
  if ((state.orgs || []).length > 1 && acct.name) parts.push(acct.name);
  for (const b of buckets) {
    if (b.utilization == null) continue;
    parts.push(`${b.key === "five_hour" ? "Session" : b.label}: ${Math.round(b.utilization)}%`);
  }
  if (extra.status === "on" || extra.status === "paused") {
    parts.push(
      extra.status === "paused"
        ? (extra.overLimit ? "Credits: OVER LIMIT" : "Credits: PAUSED")
        : (inExtra ? "Credits: IN USE" : "Credits: ON")
    );
    if (extra.spentUsd != null && extra.limitUsd) {
      const upct = extra.utilization != null ? ` (${Math.round(extra.utilization)}%)` : "";
      parts.push(`${formatMoney(extra.spentUsd, extra.currency)} / ${formatMoney(extra.limitUsd, extra.currency)}${upct}`);
    } else if (extra.spentUsd != null) {
      parts.push(`${formatMoney(extra.spentUsd, extra.currency)} spent`);
    }
  }
  const nextReset = (session || weeklyAll)?.resetsAt;
  if (nextReset && nextReset > now) parts.push(`Resets in ${formatDuration(nextReset - now)}`);
  const con = state.console;
  if (con?.enabled && con.balanceUsd != null) {
    parts.push(`API balance: ${formatMoney(con.balanceUsd, con.currency)}`);
  }
  if (err) parts.push(`Last refresh failed: ${err}`);

  return { text: `${pct}%`, color, title: parts.join(" · ") };
}
