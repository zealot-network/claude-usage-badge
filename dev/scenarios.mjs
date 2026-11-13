// dev/scenarios.mjs — canned responses for the mock claude.ai / API Console.
//
// Shapes come from the v0.4.x code comments (captured from a live Max account
// in mid-2026) and from public bug reports for Team / Enterprise seats and
// the Console. Team, Enterprise and Console shapes have NOT been verified
// against live accounts — treat these fixtures as the best available guess.

export const ORG = {
  personal: "11111111-1111-4111-8111-111111111111",
  team: "22222222-2222-4222-8222-222222222222",
  apiOnly: "33333333-3333-4333-8333-333333333333",
  console: "44444444-4444-4444-8444-444444444444",
};

const inMin = (m) => new Date(Date.now() + m * 60_000).toISOString();
const usd = (cents) => ({ amount_minor: cents, exponent: 2, currency: "USD" });
const status = (code) => ({ __status: code });

const personalMaxOrg = {
  uuid: ORG.personal,
  // Deliberate trap: the display name contains "max" and must not drive the tier.
  name: "max@example.com's Organization",
  capabilities: ["chat", "claude_max"],
  rate_limit_tier: "default_claude_max_5x",
  raven_type: null,
};
const apiOnlyOrg = { uuid: ORG.apiOnly, name: "API org", capabilities: ["api"], raven_type: null };

const maxUsage = () => ({
  limits: [
    { kind: "session", percent: 42, severity: "normal", resets_at: inMin(170), is_active: false },
    { kind: "weekly_all", percent: 61, severity: "normal", resets_at: inMin(4000), is_active: false },
    { kind: "weekly_scoped", percent: 88, severity: "warning", resets_at: inMin(4000), is_active: false,
      scope: { model: { display_name: "Fable" } } },
  ],
  spend: {
    enabled: true, disabled_reason: null, used: usd(1234), limit: usd(5000), percent: 25,
    severity: "normal", can_toggle: true, resets_at: inMin(20000),
  },
  // Legacy keys still present on live payloads; none may become a bogus row.
  five_hour: { utilization: 42, resets_at: inMin(170) },
  seven_day: { utilization: 61, resets_at: inMin(4000) },
  seven_day_sonnet: null,
  seven_day_opus: null,
  seven_day_cowork: null,
  seven_day_breakdown: { rows: [{ label: "Claude Code", percent: 70 }, { label: "Chats", percent: 30 }] },
  weekly_scoped_shares: { fable: 50 },
  member_dashboard_available: false,
  extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 5000, utilization: 25 },
});

export const CLAUDE_SCENARIOS = {
  // Personal Max plan with a Fable weekly limit — the common case today.
  "max-fable": {
    "/api/organizations": [personalMaxOrg, apiOnlyOrg],
    [`/api/organizations/${ORG.personal}/usage`]: maxUsage,
    [`/api/organizations/${ORG.personal}/prepaid/credits`]: { amount: 2500, auto_reload_settings: { enabled: true } },
  },

  // One login, two chat orgs: verified Ultra (no 5-hour limit) + a Team seat.
  "multi-org": {
    "/api/organizations": [
      { uuid: ORG.personal, name: "Personal", capabilities: ["chat", "claude_max"], rate_limit_tier: "default_claude_ultra", raven_type: null },
      { uuid: ORG.team, name: "Max's Team", capabilities: ["chat", "raven"], rate_limit_tier: "default_raven", raven_type: "team" },
      apiOnlyOrg,
    ],
    [`/api/organizations/${ORG.personal}/usage`]: () => ({
      limits: [
        { kind: "weekly_all", percent: 35, severity: "normal", resets_at: inMin(3000) },
        { kind: "weekly_scoped", percent: 20, severity: "normal", resets_at: inMin(3000), scope: { model: { display_name: "Fable" } } },
      ],
      spend: { enabled: false, disabled_reason: null, used: usd(0), limit: null },
    }),
    [`/api/organizations/${ORG.team}/usage`]: () => ({
      limits: [
        { kind: "session", percent: 91, severity: "critical", resets_at: inMin(45), is_active: true },
        { kind: "weekly_all", percent: 40, severity: "normal", resets_at: inMin(5000) },
        { kind: "weekly_scoped", percent: 10, severity: "normal", resets_at: inMin(5000), scope: { model: { display_name: "Sonnet" } } },
      ],
      spend: { enabled: false, disabled_reason: null, used: null, limit: null, can_toggle: false },
      member_dashboard_available: true,
    }),
    // A non-owner member can't read org billing…
    [`/api/organizations/${ORG.team}/subscription_details`]: status(403),
    [`/api/organizations/${ORG.team}/prepaid/credits`]: status(403),
    // …but has a per-member spend cap.
    [`/api/organizations/${ORG.team}/overage_spend_limit`]: {
      limit_type: "member", is_enabled: true, monthly_credit_limit: 150000, used_credits: 5732,
      currency: "USD", period: "monthly",
    },
  },

  // Pre-`limits[]` payload shape + a tier only discoverable via the fallback.
  legacy: {
    "/api/organizations": [{ uuid: ORG.personal, name: "Personal", capabilities: ["chat"] }],
    [`/api/organizations/${ORG.personal}/usage`]: () => ({
      five_hour: { utilization: 10, resets_at: inMin(100) },
      seven_day: { utilization: 20, resets_at: inMin(3000) },
      seven_day_opus_5_5: { utilization: 3, resets_at: inMin(3000) },
      seven_day_cowork: null,
      usage_credits: { is_enabled: false, utilization: 100 },
    }),
    [`/api/organizations/${ORG.personal}/subscription_details`]: { max_multiplier: 20 },
  },

  // Both gating limits exhausted and credits drawing — used for store art.
  "credits-in-use": {
    "/api/organizations": [personalMaxOrg],
    [`/api/organizations/${ORG.personal}/usage`]: () => ({
      limits: [
        { kind: "session", percent: 100, severity: "critical", resets_at: inMin(42), is_active: true },
        { kind: "weekly_all", percent: 100, severity: "critical", resets_at: inMin(3060), is_active: true },
        { kind: "weekly_scoped", percent: 64, severity: "normal", resets_at: inMin(3060), scope: { model: { display_name: "Fable" } } },
      ],
      spend: { enabled: true, used: usd(4610), limit: usd(20000), percent: 23, severity: "warning", can_toggle: true, resets_at: inMin(20000) },
    }),
    [`/api/organizations/${ORG.personal}/prepaid/credits`]: { amount: 4375, auto_reload_settings: { enabled: true } },
  },

  "signed-out": { "*": status(401) },
  "shape-change": {
    "/api/organizations": [personalMaxOrg],
    [`/api/organizations/${ORG.personal}/usage`]: () => null,
  },
  "rate-limited": {
    "/api/organizations": [personalMaxOrg],
    [`/api/organizations/${ORG.personal}/usage`]: status(429),
  },
};

// Captured from a real Team organization (owner seat) on 2026-11-13, with ids
// replaced and personal fields removed. Usage credits are switched off at the
// organization level (limit set to zero). This is the one LIVE-VERIFIED shape.
CLAUDE_SCENARIOS["team-live"] = {
  "/api/organizations": [{
    uuid: ORG.team, name: "Example", capabilities: ["raven", "chat", "customer_terms:standard"],
    rate_limit_tier: "default_raven", raven_type: "team", billing_type: "stripe_subscription",
    analytics_subscription_plan: "claude_team", plan_display_name: null, plan_display_label: null,
  }],
  [`/api/organizations/${ORG.team}/usage`]: () => ({
    five_hour: { utilization: 2, resets_at: inMin(240), limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day: { utilization: 0, resets_at: inMin(6000), limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day_oauth_apps: null, seven_day_opus: null, seven_day_sonnet: null, seven_day_cowork: null,
    seven_day_omelette: null, tangelo: null, iguana_necktie: null, omelette_promotional: null,
    nimbus_quill: null, cinder_cove: null, copper_kite: null, brass_thimble: null, harbor_lantern: null,
    wattle_ember: null, promo_credits: null, amber_ladder: null, granite_teacup: null, amber_cistern: null,
    amber_cistern_offer: null, juniper_tide: null, cedar_ember: null, starry_waterfall: null,
    amber_gauge: null, pace: null, indicator: null,
    extra_usage: {
      is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: "USD",
      decimal_places: 2, disabled_reason: "org_level_disabled_until", user_disabled: false,
      spend_limit_reached: false, credits_ever_enabled: true, daily: null, weekly: null,
    },
    limits: [
      { kind: "session", group: "session", percent: 2, severity: "normal", resets_at: inMin(240), scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 0, severity: "normal", resets_at: inMin(6000), scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: inMin(6000),
        scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ],
    spend: {
      used: { amount_minor: 0, currency: "USD", exponent: 2 }, limit: null, percent: 0, severity: "normal",
      enabled: false, disabled_reason: "org_level_disabled_until", cap: null, balance: null, auto_reload: null,
      can_purchase_credits: true, can_toggle: false,
    },
    member_dashboard_available: false,
    seven_day_breakdown: null,
    weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 0, allowance_percent_of_weekly: 50 }],
  }),
  [`/api/organizations/${ORG.team}/prepaid/credits`]: {
    amount: 20000, currency: "USD", balance: { money: null, credits: { amount_minor: 20000, exponent: 2 } },
    balance_credits: 200, auto_reload_settings: { enabled: true, threshold_in_minor_units: 500, reload_to_in_minor_units: 20000 },
  },
  [`/api/organizations/${ORG.team}/overage_spend_limit`]: {
    limit_type: "organization", seat_tier: null, is_enabled: true, monthly_credit_limit: 0,
    pooled_limit_enabled: false, period: "monthly", currency: "USD", used_credits: 0,
    used_credits_basis: "post_discount", disabled_reason: "org_limit_set_to_zero",
    disabled_until: "9999-12-31T23:59:59Z", out_of_credits: false,
    cap: { money: null, credits: { amount_minor: 0, exponent: 2 } },
  },
  [`/api/organizations/${ORG.team}/routines/run-budget`]: status(404),
};

// Captured from a real login with a Max 20× org and a Team org on 2026-11-13
// (ids replaced). Notable: the Max org reports NO session limit, credits are
// paused for `out_of_credits`, and the Team org's /overage_spend_limit is a
// 200 with a JSON `null` body.
CLAUDE_SCENARIOS["work-live"] = {
  "/api/organizations": [
    { uuid: ORG.personal, name: "Personal", capabilities: ["chat", "claude_max"], raven_type: null, rate_limit_tier: "default_claude_max_20x" },
    { uuid: ORG.team, name: "Example Team", capabilities: ["chat", "raven", "customer_terms:standard"], raven_type: "team", rate_limit_tier: "default_raven" },
    { uuid: ORG.apiOnly, name: "API", capabilities: ["api", "customer_terms:standard"], raven_type: null, rate_limit_tier: "auto_trust_tier_b" },
  ],
  [`/api/organizations/${ORG.personal}/usage`]: () => ({
    five_hour: null,
    seven_day: { utilization: 13, resets_at: inMin(6500) },
    limits: [
      { kind: "weekly_all", group: "weekly", percent: 13, severity: "normal", resets_at: inMin(6500), scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 14, severity: "normal", resets_at: inMin(6500),
        scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
    ],
    spend: {
      used: { amount_minor: 0, currency: "USD", exponent: 2 }, limit: { amount_minor: 20000, currency: "USD", exponent: 2 },
      percent: 0, severity: "normal", enabled: false, disabled_reason: "out_of_credits",
      cap: { money: null, credits: { amount_minor: 20000, exponent: 2 } }, balance: null, auto_reload: null,
      can_purchase_credits: true, can_toggle: true,
    },
    extra_usage: { is_enabled: false, disabled_reason: "out_of_credits", currency: "USD" },
    member_dashboard_available: false,
    seven_day_breakdown: { rows: [{ key: "claude_code", display_name: "Claude Code", percent: 100 }, { key: "chat", display_name: "Chats", percent: 0 }] },
    weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 7, allowance_percent_of_weekly: 50 }],
  }),
  [`/api/organizations/${ORG.personal}/prepaid/credits`]: { amount: 0, currency: "USD", auto_reload_settings: null },
  [`/api/organizations/${ORG.team}/usage`]: () => ({
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 0, resets_at: inMin(5500) },
    limits: [
      { kind: "session", group: "session", percent: 0, severity: "normal", resets_at: null, scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 0, severity: "normal", resets_at: inMin(5500), scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: inMin(5500),
        scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ],
    spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 }, limit: null, percent: 0, severity: "normal",
      enabled: false, disabled_reason: null, cap: null, balance: null, auto_reload: null,
      can_purchase_credits: false, can_toggle: false },
    extra_usage: { is_enabled: false, disabled_reason: null, currency: "USD" },
    weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 0, allowance_percent_of_weekly: 50 }],
  }),
  [`/api/organizations/${ORG.team}/prepaid/credits`]: { amount: 0, currency: "USD", auto_reload_settings: null },
  [`/api/organizations/${ORG.team}/overage_spend_limit`]: () => null,
};

// Same login as multi-org, but the personal org's usage can't be read.
CLAUDE_SCENARIOS["one-org-forbidden"] = {
  ...CLAUDE_SCENARIOS["multi-org"],
  [`/api/organizations/${ORG.personal}/usage`]: status(403),
};

export const CONSOLE_SCENARIOS = {
  // Shapes captured from a real Console session on 2026-11-13 (values changed).
  // The Console lists the login's chat orgs too; only "api" orgs have billing.
  ok: {
    "/api/organizations": [
      { uuid: ORG.personal, name: "Personal", capabilities: ["chat", "claude_max"], rate_limit_tier: "default_claude_max_20x" },
      { uuid: ORG.console, name: "Acme API", capabilities: ["api"], rate_limit_tier: "auto_trust_tier_a", billing_type: "prepaid" },
    ],
    [`/api/organizations/${ORG.personal}/prepaid/credits`]: status(403),
    [`/api/organizations/${ORG.personal}/current_spend`]: status(403),
    [`/api/organizations/${ORG.personal}/rate_limits`]: status(403),
    [`/api/organizations/${ORG.console}/prepaid/credits`]: () => ({
      amount: 4321, currency: "USD", balance: { money: null, credits: { amount_minor: 4321, exponent: 2 } },
      balance_credits: 43.21, auto_reload_settings: null, tranches: [], next_expires_at: inMin(20160),
    }),
    [`/api/organizations/${ORG.console}/current_spend`]: () => ({ amount: 1875, resets_at: inMin(25000) }),
    [`/api/organizations/${ORG.console}/rate_limits`]: {
      rate_limit_tier: "auto_trust_tier_a", tier_model_rate_limiters: [], spend_threshold: 50000,
    },
  },
  "signed-out": { "*": status(403) },
  // Endpoints answer, but with field names the parsers don't know.
  unknown: {
    "/api/organizations": [{ uuid: ORG.console, name: "Acme API", capabilities: ["api"] }],
    [`/api/organizations/${ORG.console}/prepaid/credits`]: { foo: 1 },
    [`/api/organizations/${ORG.console}/current_spend`]: { bar: 2 },
    [`/api/organizations/${ORG.console}/rate_limits`]: {},
  },
};
