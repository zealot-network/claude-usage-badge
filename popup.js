// popup.js — Reads state from the service worker and renders the popup UI.

import { CLAUDE_ORIGIN, CONSOLE_ORIGIN } from "./config.js";
import {
  defaultState, defaultAccount, migrateState, displayOrgId,
  formatTier, formatMoney, formatDuration, liveRoutineRuns,
} from "./lib/core.js";

const USAGE_URL = `${CLAUDE_ORIGIN}/settings/usage`;
const CONSOLE_URL = `${CONSOLE_ORIGIN}/settings/billing`;
const CONSOLE_PERMISSION = { origins: [`${CONSOLE_ORIGIN}/*`] };

const ERROR_COPY = {
  no_org: {
    title: "Sign in to Claude",
    body:
      "We couldn't find a Claude session. To load your usage data:<ol>" +
      "<li>Open <strong>claude.ai/settings/usage</strong></li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  auth: {
    title: "Claude session expired",
    body:
      "Your Claude session has expired or isn't authorized. To reconnect:<ol>" +
      "<li>Open <strong>claude.ai/settings/usage</strong> and sign in if prompted</li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  network: {
    title: "Can't reach claude.ai",
    body:
      "We hit a network error fetching your usage. To retry:<ol>" +
      "<li>Open <strong>claude.ai/settings/usage</strong> to confirm you're online</li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  rate_limited: {
    title: "Claude is rate limiting us",
    body: "claude.ai asked us to slow down. Usage will refresh again automatically in a few minutes.",
  },
  shape: {
    title: "Claude changed its usage data",
    body:
      "claude.ai returned usage in a format this version doesn't understand. " +
      "Check the Chrome Web Store for an update to this extension.",
  },
  unknown: {
    title: "Couldn't load usage",
    body:
      "Something went wrong reading your usage. To retry:<ol>" +
      "<li>Open <strong>claude.ai/settings/usage</strong></li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
};

// Which account tab is showing. null = follow whatever drives the badge.
let selectedOrgId = null;
let lastState = defaultState();

const $ = (id) => document.getElementById(id);

// ─── Helpers ────────────────────────────────────────────────────────────────

function barColor(pct) {
  if (pct >= 90) return "var(--red)";
  if (pct >= 70) return "var(--amber)";
  return "var(--green)";
}

function formatPct(pct) {
  if (pct == null) return "—";
  return `${Math.round(pct)}%`;
}

function formatResetTime(ts) {
  if (!ts) return "";
  const diff = ts - Date.now();
  if (diff < 60_000) return "Resets soon";
  return `Resets in ${formatDuration(diff)}`;
}

function formatLastUpdated(ts) {
  if (!ts) return "No data yet";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins <= 0) return "Updated just now";
  if (mins < 60) return `Updated ${mins}m ago`;
  return `Updated ${Math.floor(mins / 60)}h ago`;
}

// Maps the API's severity string to a bar color, falling back to % bands.
function severityColor(severity, pct) {
  if (severity === "critical") return "var(--red)";
  if (severity === "warning") return "var(--amber)";
  if (severity === "normal") return "var(--green)";
  return barColor(pct);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Builds a bar section with ARIA progressbar semantics.
function buildBarSection({ label, valueText, pct, resetsAt, inactive, overLimit, severity }) {
  const fillPct = pct != null ? Math.max(0, Math.min(100, pct)) : 0;

  const section = el("div", inactive ? "section inactive" : "section");
  const row = el("div", "label-row");
  row.appendChild(el("span", "label", label));
  const valueEl = el("span", "value", valueText);
  if (overLimit) valueEl.style.color = "var(--red)";
  row.appendChild(valueEl);

  const track = el("div", "bar-track");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-label", label);
  if (pct != null) {
    track.setAttribute("aria-valuenow", String(Math.round(fillPct)));
    if (overLimit) track.setAttribute("aria-valuetext", valueText + " — over limit");
  } else {
    track.setAttribute("aria-valuetext", inactive ? "Not active" : "No data");
  }
  const fill = el("div", "bar-fill");
  fill.style.width = `${fillPct}%`;
  fill.style.backgroundColor = pct != null ? severityColor(severity, pct) : "var(--surface)";
  track.appendChild(fill);

  section.append(row, track, el("div", "reset-time", inactive ? "" : formatResetTime(resetsAt)));
  return section;
}

function renderBucket(container, bucket) {
  const inactive = !!bucket.inactive;
  const pct = bucket.utilization;
  container.appendChild(
    buildBarSection({
      label: bucket.label,
      valueText: inactive ? "Not active" : formatPct(pct),
      pct,
      resetsAt: bucket.resetsAt,
      inactive,
      overLimit: pct != null && pct > 100,
      severity: bucket.severity,
    })
  );
}

function renderRoutineRuns(container, runs) {
  const { used, limit, resetsAt } = runs;
  const pct = used != null && limit > 0 ? (used / limit) * 100 : null;
  container.appendChild(
    buildBarSection({
      label: "Scheduled runs",
      valueText: used != null && limit != null ? `${used} / ${limit}` : used != null ? `${used}` : "—",
      pct,
      resetsAt,
      inactive: false,
      overLimit: pct != null && pct > 100,
    })
  );
}

// Is this weekly bucket a per-model limit (vs. a product surface)?
function isModelBucket(b) {
  if (b.scopeType) return b.scopeType === "model";
  // Buckets stored by older versions carry no scopeType.
  return !["seven_day_cowork", "seven_day_oauth_apps"].includes(b.key);
}

function orgLabel(org, acct, index) {
  if (org?.name) return org.name;
  if (acct?.name) return acct.name;
  const kind = org?.kind || acct?.kind;
  if (kind === "team") return "Team";
  if (kind === "enterprise") return "Enterprise";
  return `Account ${index + 1}`;
}

// ─── Render ─────────────────────────────────────────────────────────────────

function renderAccountSwitcher(state, shownOrgId) {
  const tabs = $("account-tabs");
  const pinRow = $("pin-row");
  // Rebuilding the buttons must not throw keyboard focus back to <body>.
  const focusedOrg = tabs.contains(document.activeElement)
    ? document.activeElement.dataset.org
    : null;
  tabs.textContent = "";
  const orgs = state.orgs || [];
  if (orgs.length < 2) {
    tabs.style.display = "none";
    pinRow.style.display = "none";
    return;
  }
  tabs.style.display = "";
  orgs.forEach((org, i) => {
    const acct = state.accounts[org.id];
    const btn = el("button", "tab");
    btn.type = "button";
    btn.dataset.org = org.id;
    btn.setAttribute("aria-pressed", String(org.id === shownOrgId));
    const name = orgLabel(org, acct, i);
    const tier = formatTier(acct?.subscriptionTier || org.tier || org.tierGuess);
    const isActive = org.id === state.activeOrgId;
    const isPinned = org.id === state.pinnedOrgId;
    const full = [name, tier !== "—" ? tier : null, isActive ? "open in Claude" : null,
      isPinned ? "badge pinned here" : null].filter(Boolean).join(" — ");
    btn.title = full;
    btn.setAttribute("aria-label", full);
    const top = el("span", "tab-top");
    if (isActive) top.appendChild(el("span", "tab-dot"));
    top.appendChild(el("span", "tab-name", name));
    if (isPinned) top.appendChild(el("span", "tab-pin", "★"));
    btn.appendChild(top);
    btn.appendChild(el("span", "tab-meta", tier));
    btn.addEventListener("click", () => {
      selectedOrgId = org.id;
      render(lastState);
    });
    tabs.appendChild(btn);
    if (org.id === focusedOrg) btn.focus();
  });

  // Pin control: which account the toolbar badge follows.
  pinRow.style.display = "";
  const pinned = state.pinnedOrgId;
  const badgeOrg = displayOrgId(state);
  const label = $("pin-label");
  const btn = $("pin-btn");
  if (pinned && pinned === shownOrgId) {
    label.textContent = "★ Badge is pinned to this account";
    btn.textContent = "Follow active account";
    btn.dataset.pin = "";
  } else if (badgeOrg === shownOrgId) {
    label.textContent = "● Open in Claude — the badge follows it";
    btn.textContent = "Pin to this account";
    btn.dataset.pin = shownOrgId;
  } else {
    label.textContent = "Badge is showing another account";
    btn.textContent = "Pin to this account";
    btn.dataset.pin = shownOrgId;
  }
}

function renderCredits(extra, isSeat) {
  let status = extra.status;
  if (status == null) {
    if (extra.enabled === true) status = "on";
    else if (extra.enabled === false) status = "off";
  }
  const known = status != null;
  const active = status === "on" || status === "paused";
  const inUse = !!extra.inUse;
  const overLimit = extra.overLimit === true && active;
  const cur = extra.currency || "USD";

  $("extra-section").classList.toggle("over-limit", overLimit);

  const pill = $("extra-enabled-pill");
  pill.classList.remove("pill-on", "pill-off", "pill-neutral", "pill-paused");
  if (!known) {
    pill.textContent = "—";
    pill.classList.add("pill-neutral");
  } else if (status === "on") {
    pill.textContent = "ON";
    pill.classList.add("pill-on");
  } else if (status === "paused") {
    pill.textContent = overLimit ? "OVER LIMIT" : "PAUSED";
    pill.classList.add("pill-paused");
  } else {
    pill.textContent = "OFF";
    pill.classList.add("pill-off");
  }
  $("extra-active-pill").style.display = status === "on" && inUse ? "inline" : "none";

  const detailEl = $("extra-detail");
  const barWrap = $("extra-bar-wrap");
  detailEl.textContent = "";

  if (!known) {
    detailEl.textContent = "Waiting for data…";
    barWrap.style.display = "none";
    return;
  }
  if (!active) {
    detailEl.textContent = extra.byOrg
      ? "Turned off for this organization — Claude pauses when you hit a limit"
      : isSeat
        ? "Off for your seat — ask an owner to enable usage credits"
        : "Off — Claude pauses when you hit a limit";
    barWrap.style.display = "none";
    return;
  }

  const uPct = typeof extra.utilization === "number" ? Math.round(extra.utilization) : null;
  const line1 = el("div");
  if (extra.spentUsd != null && extra.limitUsd != null && extra.limitUsd > 0) {
    line1.appendChild(el("strong", null, formatMoney(extra.spentUsd, cur)));
    line1.appendChild(document.createTextNode(` of ${formatMoney(extra.limitUsd, cur)}`));
    if (uPct != null) {
      line1.appendChild(document.createTextNode(" · "));
      line1.appendChild(el("span", overLimit ? "over" : "", `${uPct}%`));
    }
  } else if (extra.spentUsd != null) {
    line1.appendChild(el("strong", null, formatMoney(extra.spentUsd, cur)));
    line1.appendChild(document.createTextNode(" spent"));
  } else {
    line1.textContent = "Enabled — no spend data";
  }
  detailEl.appendChild(line1);

  const line2 = [];
  if (extra.scope === "member") line2.push("your seat's monthly limit");
  else if (extra.scope === "organization") line2.push("organization monthly limit");
  if (extra.balanceUsd != null) line2.push(`${formatMoney(extra.balanceUsd, cur)} balance`);
  if (extra.autoReload === true) line2.push("auto-reload on");
  else if (extra.autoReload === false) line2.push("auto-reload off");
  if (line2.length) detailEl.appendChild(el("div", "extra-sub", line2.join(" · ")));
  if (status === "paused") {
    const why = /out_of_credits/.test(extra.disabledReason || "")
      ? "Out of credits — add credits to resume"
      : /spend_limit/.test(extra.disabledReason || "")
        ? "Monthly spend limit reached — credits paused"
        : overLimit ? "Over your monthly limit — credits paused" : "Credits paused";
    detailEl.appendChild(el("div", "extra-note", why));
  }

  let pct = null;
  if (typeof extra.utilization === "number") pct = extra.utilization;
  else if (extra.limitUsd > 0 && extra.spentUsd != null) pct = (extra.spentUsd / extra.limitUsd) * 100;
  if (pct == null) {
    barWrap.style.display = "none";
    return;
  }
  $("extra-bar").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $("extra-bar").style.backgroundColor = overLimit ? "var(--red)" : severityColor(extra.severity, pct);
  const track = $("extra-bar-track");
  track.setAttribute("aria-valuenow", String(Math.round(Math.max(0, Math.min(100, pct)))));
  if (overLimit) track.setAttribute("aria-valuetext", `${Math.round(pct)}% — over limit`);
  else track.removeAttribute("aria-valuetext");
  $("extra-reset").textContent = formatResetTime(extra.resetsAt);
  barWrap.style.display = "";
}

function renderConsole(con) {
  const title = $("console-title");
  const btn = $("console-toggle-btn");
  const detail = $("console-detail");
  const rows = $("console-rows");
  const barWrap = $("console-bar-wrap");
  rows.textContent = "";
  barWrap.style.display = "none";

  // Not connected: one quiet line, no card.
  $("console-block").style.display = con?.enabled ? "" : "none";
  $("console-cta").style.display = con?.enabled ? "none" : "";
  if (!con?.enabled) return;

  title.textContent = con.orgName || "API usage";
  btn.textContent = "Disconnect";

  const cur = con.currency || "USD";
  const addRow = (k, v) => {
    const row = el("div", "console-row");
    row.append(el("span", "k", k), el("span", "v", v));
    rows.appendChild(row);
  };
  if (con.balanceUsd != null) {
    addRow("Credit balance", formatMoney(con.balanceUsd, cur));
  }
  if (con.spendUsd != null) {
    addRow(
      "Spend this month",
      con.spendLimitUsd != null
        ? `${formatMoney(con.spendUsd, cur)} of ${formatMoney(con.spendLimitUsd, cur)}`
        : formatMoney(con.spendUsd, cur)
    );
  }
  if (con.autoReload != null) addRow("Auto-reload", con.autoReload ? "On" : "Off");
  if (con.expiresAt && con.balanceUsd > 0 && con.expiresAt > Date.now()) {
    addRow("Credits expire", `in ${formatDuration(con.expiresAt - Date.now())}`);
  }
  if (con.tier) addRow("Usage tier", con.tier);

  if (con.lastError) {
    detail.style.display = "";
    detail.textContent = "";
    detail.appendChild(el("span", "over", con.lastError));
    if (con.errorCode === "auth") {
      detail.appendChild(document.createTextNode(" "));
      const open = el("button", "link-btn", "Open the Console");
      open.type = "button";
      open.addEventListener("click", () => chrome.tabs.create({ url: CONSOLE_URL }));
      detail.appendChild(open);
    }
  } else if (!rows.children.length) {
    detail.style.display = "";
    detail.textContent = "Loading…";
  } else {
    detail.style.display = "none";
  }

  if (con.spendUsd != null && con.spendLimitUsd > 0) {
    const pct = (con.spendUsd / con.spendLimitUsd) * 100;
    $("console-bar").style.width = `${Math.max(0, Math.min(100, pct))}%`;
    $("console-bar").style.backgroundColor = barColor(pct);
    $("console-bar-track").setAttribute("aria-valuenow", String(Math.round(Math.min(100, pct))));
    $("console-reset").textContent = formatResetTime(con.resetsAt);
    barWrap.style.display = "";
  }
}

function render(rawState) {
  const state = migrateState(rawState);
  lastState = state;

  // Which account is on screen: the user's tab choice if it still exists,
  // otherwise whatever the badge shows.
  const known = (id) => !!id && (state.orgs.some((o) => o.id === id) || !!state.accounts[id]);
  if (!known(selectedOrgId)) selectedOrgId = null;
  const shownOrgId = selectedOrgId || displayOrgId(state);
  const acct = (shownOrgId && state.accounts[shownOrgId]) || defaultAccount(shownOrgId);
  const org = state.orgs.find((o) => o.id === shownOrgId) || null;
  const buckets = acct.buckets || [];
  const hasAnyData = buckets.length > 0;

  // Login-level problems (signed out / session expired) always show the
  // guided prompt, even when older numbers are cached. Per-account problems
  // show it only when there is nothing to display.
  const loginError = state.errorCode === "no_org" || state.errorCode === "auth";
  const errorCode = loginError ? state.errorCode : acct.errorCode;
  const showPrompt = loginError || (!!errorCode && !hasAnyData);

  const promptEl = $("error-prompt");
  if (showPrompt) {
    const copy = ERROR_COPY[errorCode] || ERROR_COPY.unknown;
    $("error-prompt-title").textContent = copy.title;
    $("error-prompt-body").innerHTML = copy.body; // static copy from this file only
    promptEl.style.display = "";
  } else {
    promptEl.style.display = "none";
  }

  renderAccountSwitcher(state, shownOrgId);

  // Stale numbers from before sign-out must not look live.
  document.body.classList.toggle("stale", loginError && hasAnyData);
  const acctErr = $("account-error");
  if (loginError && hasAnyData) {
    acctErr.textContent = "Showing the last numbers from before you were signed out.";
    acctErr.style.display = "";
  } else {
    acctErr.style.display = "none";
  }

  const errorEl = $("error-label");
  if (acct.lastError && !showPrompt) {
    errorEl.textContent = `Last refresh failed: ${acct.lastError}`;
    errorEl.style.display = "block";
  } else {
    errorEl.style.display = "none";
  }

  // Tier
  const tier = acct.subscriptionTier || org?.tier || null;
  const tierEl = $("tier-pill");
  tierEl.textContent = formatTier(tier);
  tierEl.title = tier ? "Detected Claude plan" : "Plan not detected yet — open claude.ai and refresh";

  // Session (5h). Some plans (verified Ultra) have no session limit at all.
  const sessionSlot = $("session-slot");
  sessionSlot.textContent = "";
  const session = buckets.find((b) => b.key === "five_hour");
  if (session) {
    renderBucket(sessionSlot, session);
  } else if (!showPrompt) {
    sessionSlot.appendChild(
      el("div", "empty",
        hasAnyData ? "No session limit on this plan"
          : acct.lastUpdated ? "No session or weekly limits on this plan"
          : "No usage data yet")
    );
  }

  // Weekly buckets — split so the credits card sits between the primary
  // "all models" bar and the per-model bars below it.
  const weeklyPrimarySlot = $("weekly-primary-slot");
  const weeklySecondarySlot = $("weekly-secondary-slot");
  weeklyPrimarySlot.textContent = "";
  weeklySecondarySlot.textContent = "";

  const isWeekly = (b) => b.key.startsWith("seven_day") || /weekly/i.test(b.key);
  const weeklyBuckets = buckets.filter((b) => b.key !== "five_hour" && isWeekly(b));
  const weeklyPrimary = weeklyBuckets.find((b) => b.key === "seven_day");
  const weeklyModels = weeklyBuckets.filter((b) => b.key !== "seven_day" && isModelBucket(b));
  const weeklySurfaces = weeklyBuckets.filter((b) => b.key !== "seven_day" && !isModelBucket(b));

  if (weeklyPrimary) renderBucket(weeklyPrimarySlot, weeklyPrimary);
  weeklyModels.forEach((b) => renderBucket(weeklySecondarySlot, b));
  $("weekly-heading").style.display = weeklyBuckets.length > 0 ? "" : "none";
  $("weekly-secondary-heading").style.display = weeklyModels.length > 0 ? "" : "none";

  // Other limits — product surfaces, scheduled runs, anything unrecognised.
  const dailySlot = $("daily-slot");
  dailySlot.textContent = "";
  weeklySurfaces.forEach((b) => renderBucket(dailySlot, b));
  buckets
    .filter((b) => b.key !== "five_hour" && !isWeekly(b))
    .forEach((b) => renderBucket(dailySlot, b));
  const runs = liveRoutineRuns(acct.routineRuns);
  if (runs) renderRoutineRuns(dailySlot, runs);
  $("daily-group").style.display = dailySlot.children.length > 0 ? "" : "none";

  const isSeat = (acct.kind || org?.kind) === "team" || (acct.kind || org?.kind) === "enterprise";
  renderCredits(acct.extraUsage || {}, isSeat);
  renderConsole(state.console);

  // Meta — reflects the last SUCCESSFUL fetch only; errors are shown separately.
  $("meta-label").textContent = formatLastUpdated(acct.lastUpdated);
}

// ─── Init ───────────────────────────────────────────────────────────────────

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    } catch {
      resolve(undefined);
    }
  });
}

async function loadAndRender() {
  try {
    let state = await send({ type: "GET_USAGE_STATE" });
    if (!state) {
      const { usageState } = await chrome.storage.local.get("usageState");
      state = usageState;
    }
    render(state);
  } catch (e) {
    $("error-label").textContent = "Failed to load state.";
    $("error-label").style.display = "block";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadAndRender();

  // Live updates: re-render whenever the background writes new state, and
  // tick the relative timestamps while the popup stays open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.usageState) render(changes.usageState.newValue);
  });
  setInterval(() => render(lastState), 30_000);

  const btn = $("refresh-btn");
  btn.addEventListener("click", async () => {
    btn.textContent = "…";
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    // The background responds when the fetch actually finishes; the timeout
    // covers the worker dying mid-request.
    await Promise.race([
      send({ type: "FORCE_REFRESH" }),
      new Promise((r) => setTimeout(r, 15_000)),
    ]);
    await loadAndRender();
    btn.textContent = "Refresh";
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  });

  $("open-usage-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: USAGE_URL });
  });

  $("pin-btn").addEventListener("click", async () => {
    await send({ type: "SET_PINNED_ORG", orgId: $("pin-btn").dataset.pin || null });
    await loadAndRender();
  });

  $("console-toggle-btn").addEventListener("click", async () => {
    await send({ type: "CONSOLE_DISABLE" });
    try {
      await chrome.permissions.remove(CONSOLE_PERMISSION);
    } catch {
      // Not removable (e.g. granted at install in a dev build) — fine.
    }
    await loadAndRender();
  });

  $("console-connect-btn").addEventListener("click", async () => {
    // Must be the first thing in the click handler (user gesture).
    let granted = false;
    try {
      granted = await chrome.permissions.request(CONSOLE_PERMISSION);
    } catch {
      granted = false;
    }
    if (!granted) {
      $("console-cta-text").textContent = "Permission wasn't granted";
      return;
    }
    await send({ type: "CONSOLE_ENABLE" });
    await loadAndRender();
  });
});
