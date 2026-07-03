// popup.js — Reads UsageState from storage and renders the popup UI.

const DEFAULT_STATE = {
  buckets: [],
  routineRuns: null,
  extraUsage: {
    enabled: null,
    inUse: null,
    spentUsd: null,
    limitUsd: null,
    status: null,
    disabledReason: null,
    overLimit: null,
    balanceUsd: null,
    utilization: null,
    severity: null,
    canToggle: null,
    autoReload: null,
    resetsAt: null,
  },
  subscriptionTier: null,
  tierFetchedAt: null,
  orgId: null,
  lastUpdated: null,
  lastErrorAt: null,
  lastError: null,
  errorCode: null,
};

const USAGE_URL = "https://claude.ai/settings/usage";

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
  unknown: {
    title: "Couldn't load usage",
    body:
      "Something went wrong reading your usage. To retry:<ol>" +
      "<li>Open <strong>claude.ai/settings/usage</strong></li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
};

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
  if (diff <= 0) return "Resets soon";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `Resets in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) {
    const rm = mins % 60;
    return rm > 0 ? `Resets in ${hrs}h ${rm}m` : `Resets in ${hrs}h`;
  }
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `Resets in ${days}d ${rh}h` : `Resets in ${days}d`;
}

function formatLastUpdated(ts) {
  if (!ts) return "No data yet";
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins <= 0) return "Updated just now";
  if (mins === 1) return "Updated 1m ago";
  if (mins < 60) return `Updated ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `Updated ${hrs}h ago`;
}

function formatTier(tier) {
  if (!tier) return "—";
  const map = {
    free: "Free",
    pro: "Pro",
    team: "Team",
    enterprise: "Enterprise",
    max_5x: "Max 5×",
    max_20x: "Max 20×",
  };
  return map[tier] || tier;
}

// Maps the API's severity string to a bar color, falling back to % bands.
function severityColor(severity, pct) {
  if (severity === "critical") return "var(--red)";
  if (severity === "warning") return "var(--amber)";
  if (severity === "normal") return "var(--green)";
  return barColor(pct);
}

// Builds a bar section with ARIA progressbar semantics.
function buildBarSection({ label, valueText, pct, resetsAt, inactive, overLimit, severity }) {
  const fillPct = pct != null ? Math.min(100, pct) : 0;

  const section = document.createElement("div");
  section.className = inactive ? "section inactive" : "section";
  section.innerHTML = `
    <div class="label-row">
      <span class="label"></span>
      <span class="value"></span>
    </div>
    <div class="bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100">
      <div class="bar-fill"></div>
    </div>
    <div class="reset-time"></div>
  `;
  section.querySelector(".label").textContent = label;
  const valueEl = section.querySelector(".value");
  valueEl.textContent = valueText;
  if (overLimit) valueEl.style.color = "var(--red)";

  const track = section.querySelector(".bar-track");
  track.setAttribute("aria-label", label);
  if (pct != null) {
    track.setAttribute("aria-valuenow", String(Math.round(Math.min(100, pct))));
    if (overLimit) track.setAttribute("aria-valuetext", valueText + " — over limit");
  } else {
    track.setAttribute("aria-valuetext", inactive ? "Not active" : "No data");
  }

  const fill = section.querySelector(".bar-fill");
  fill.style.width = `${fillPct}%`;
  fill.style.backgroundColor = pct != null ? severityColor(severity, pct) : "var(--surface)";
  section.querySelector(".reset-time").textContent = inactive ? "" : formatResetTime(resetsAt);

  return section;
}

// Renders one bucket (label, %, bar, reset) into the given container.
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

// Renders the Scheduled/run-budget bucket (uses used/limit rather than %).
function renderRoutineRuns(container, runs) {
  const { used, limit, resetsAt } = runs;
  let pct = null;
  if (used != null && limit != null && limit > 0) {
    pct = (used / limit) * 100;
  }
  const valueText =
    used != null && limit != null ? `${used} / ${limit}` : used != null ? `${used}` : "—";

  container.appendChild(
    buildBarSection({
      label: "Scheduled runs",
      valueText,
      pct,
      resetsAt,
      inactive: false,
      overLimit: pct != null && pct > 100,
    })
  );
}

// ─── Render ─────────────────────────────────────────────────────────────────

function render(state) {
  const $ = (id) => document.getElementById(id);

  // Error banner + inline error label. The prompt shows when we have a
  // meaningful errorCode AND no fresh data to display.
  const hasErrorCode = !!state.errorCode;
  const hasAnyData = (state.buckets || []).length > 0;
  const showPrompt = hasErrorCode && !hasAnyData;

  const promptEl = $("error-prompt");
  if (showPrompt) {
    const copy = ERROR_COPY[state.errorCode] || ERROR_COPY.unknown;
    $("error-prompt-title").textContent = copy.title;
    $("error-prompt-body").innerHTML = copy.body;
    promptEl.style.display = "";
  } else {
    promptEl.style.display = "none";
  }

  const errorEl = $("error-label");
  // When the prompt is shown, suppress the small inline error to avoid redundancy.
  if (state.lastError && !showPrompt) {
    errorEl.textContent = `Last refresh failed: ${state.lastError}`;
    errorEl.style.display = "block";
  } else {
    errorEl.style.display = "none";
  }

  // Tier
  const tierEl = $("tier-pill");
  tierEl.textContent = formatTier(state.subscriptionTier);
  tierEl.title = state.subscriptionTier
    ? "Detected Claude plan"
    : "Plan not detected yet — open claude.ai and refresh";

  // Session (5h) — always first slot
  const sessionSlot = $("session-slot");
  sessionSlot.innerHTML = "";
  const session = (state.buckets || []).find((b) => b.key === "five_hour");
  if (session) {
    renderBucket(sessionSlot, session);
  } else if (!showPrompt) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No session data yet";
    sessionSlot.appendChild(empty);
  }

  // Weekly buckets — split across two slots so the Extra Usage card can sit
  // between the primary "all models" bar and the per-model bars below it.
  const weeklyHeading = $("weekly-heading");
  const weeklyPrimarySlot = $("weekly-primary-slot");
  const weeklySecondaryHeading = $("weekly-secondary-heading");
  const weeklySecondarySlot = $("weekly-secondary-slot");
  weeklyPrimarySlot.innerHTML = "";
  weeklySecondarySlot.innerHTML = "";

  // Weekly buckets that aren't per-model (Scheduled, OAuth apps) belong under
  // "Other limits", not the "By model" sub-heading.
  const NON_MODEL_WEEKLY = new Set(["seven_day_cowork", "seven_day_oauth_apps"]);

  const weeklyBuckets = (state.buckets || []).filter(
    (b) => b.key !== "five_hour" && (b.key.startsWith("seven_day") || /weekly/i.test(b.key))
  );
  const weeklyPrimary = weeklyBuckets.find((b) => b.key === "seven_day");
  const weeklyModels = weeklyBuckets.filter(
    (b) => b.key !== "seven_day" && !NON_MODEL_WEEKLY.has(b.key)
  );
  const weeklyNonModel = weeklyBuckets.filter((b) => NON_MODEL_WEEKLY.has(b.key));

  if (weeklyPrimary) renderBucket(weeklyPrimarySlot, weeklyPrimary);
  weeklyModels.forEach((b) => renderBucket(weeklySecondarySlot, b));
  weeklyHeading.style.display = weeklyBuckets.length > 0 ? "" : "none";
  weeklySecondaryHeading.style.display = weeklyModels.length > 0 ? "" : "none";

  // Other limits — Scheduled runs, non-model weekly buckets, and anything
  // that isn't session/weekly-model.
  const dailyGroup = $("daily-group");
  const dailySlot = $("daily-slot");
  dailySlot.innerHTML = "";
  const otherBuckets = (state.buckets || []).filter(
    (b) =>
      b.key !== "five_hour" &&
      !b.key.startsWith("seven_day") &&
      !/weekly/i.test(b.key)
  );
  weeklyNonModel.forEach((b) => renderBucket(dailySlot, b));
  otherBuckets.forEach((b) => renderBucket(dailySlot, b));
  if (state.routineRuns) {
    renderRoutineRuns(dailySlot, state.routineRuns);
  }
  dailyGroup.style.display = dailySlot.children.length > 0 ? "" : "none";

  // ── Usage credits — status-aware (on / paused / off / unknown) ────────────
  const extra = state.extraUsage || {};
  // status is authoritative when present; fall back to the enabled boolean.
  let status = extra.status;
  if (status == null) {
    if (extra.enabled === true) status = "on";
    else if (extra.enabled === false) status = "off";
  }
  const known = status != null;
  const active = status === "on" || status === "paused";
  const inUse = !!extra.inUse;
  const overLimit = extra.overLimit === true;

  const section = $("extra-section");
  section.classList.toggle("over-limit", overLimit);

  // Status pill
  const enabledPill = $("extra-enabled-pill");
  enabledPill.classList.remove("pill-on", "pill-off", "pill-neutral", "pill-paused");
  if (!known) {
    enabledPill.textContent = "—";
    enabledPill.classList.add("pill-neutral");
  } else if (status === "on") {
    enabledPill.textContent = "ON";
    enabledPill.classList.add("pill-on");
  } else if (status === "paused") {
    enabledPill.textContent = overLimit ? "OVER LIMIT" : "PAUSED";
    enabledPill.classList.add("pill-paused");
  } else {
    enabledPill.textContent = "OFF";
    enabledPill.classList.add("pill-off");
  }

  // "IN USE" only when actively drawing (on + a limit exhausted).
  $("extra-active-pill").style.display = status === "on" && inUse ? "inline" : "none";

  const detailEl = $("extra-detail");
  const barWrap = $("extra-bar-wrap");
  const extraBar = $("extra-bar");
  const extraBarTrack = $("extra-bar-track");
  const extraResetEl = $("extra-reset");

  if (!known) {
    detailEl.textContent = "Waiting for data…";
    barWrap.style.display = "none";
  } else if (!active) {
    detailEl.textContent = "Off — Claude pauses when you hit a limit";
    barWrap.style.display = "none";
  } else {
    const uPct = typeof extra.utilization === "number" ? Math.round(extra.utilization) : null;
    const parts = [];
    if (extra.spentUsd != null && extra.limitUsd != null && extra.limitUsd > 0) {
      const pctTag =
        uPct != null
          ? ` · <span class="${overLimit ? "over" : ""}">${uPct}%</span>`
          : "";
      parts.push(
        `<strong>$${extra.spentUsd.toFixed(2)}</strong> of $${extra.limitUsd.toFixed(2)}${pctTag}`
      );
    } else if (extra.spentUsd != null) {
      parts.push(`<strong>$${extra.spentUsd.toFixed(2)}</strong> spent`);
    }
    const line2 = [];
    if (extra.balanceUsd != null) line2.push(`$${extra.balanceUsd.toFixed(2)} balance`);
    if (extra.autoReload === true) line2.push("auto-reload on");
    else if (extra.autoReload === false) line2.push("auto-reload off");

    let html = parts.join(" · ") || "Enabled — no spend data";
    if (line2.length) html += `<div class="extra-sub">${line2.join(" · ")}</div>`;
    // Paused/over-limit gets an explicit, louder note.
    if (status === "paused") {
      const note = overLimit
        ? "Over your monthly limit — credits paused"
        : "Credits paused";
      html += `<div class="extra-note">${note}</div>`;
    }
    detailEl.innerHTML = html;

    // Progress bar — uncapped utilization, red when over limit.
    let pct = null;
    if (typeof extra.utilization === "number") pct = extra.utilization;
    else if (extra.limitUsd != null && extra.limitUsd > 0 && extra.spentUsd != null) {
      pct = (extra.spentUsd / extra.limitUsd) * 100;
    }
    if (pct != null) {
      extraBar.style.width = `${Math.min(100, pct)}%`;
      extraBar.style.backgroundColor = severityColor(extra.severity, pct);
      if (extraBarTrack) {
        extraBarTrack.setAttribute("aria-valuenow", String(Math.round(Math.min(100, pct))));
        if (overLimit) {
          extraBarTrack.setAttribute("aria-valuetext", `${Math.round(pct)}% — over limit`);
        }
      }
      extraResetEl.textContent = formatResetTime(extra.resetsAt);
      barWrap.style.display = "";
    } else {
      barWrap.style.display = "none";
    }
  }

  // Meta — reflects the last SUCCESSFUL fetch only; errors are shown separately.
  $("meta-label").textContent = formatLastUpdated(state.lastUpdated);
}

// ─── Init ───────────────────────────────────────────────────────────────────

function normalizeState(state) {
  return {
    ...DEFAULT_STATE,
    ...(state || {}),
    extraUsage: { ...DEFAULT_STATE.extraUsage, ...((state && state.extraUsage) || {}) },
  };
}

async function loadAndRender() {
  try {
    const state = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_USAGE_STATE" }, (resp) => {
        if (chrome.runtime.lastError) {
          chrome.storage.local.get("usageState", ({ usageState }) => {
            resolve(usageState || DEFAULT_STATE);
          });
        } else {
          resolve(resp || DEFAULT_STATE);
        }
      });
    });
    render(normalizeState(state));
  } catch {
    document.getElementById("error-label").textContent = "Failed to load state.";
    document.getElementById("error-label").style.display = "block";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadAndRender();

  // Live updates: re-render whenever the background writes new state, and
  // tick the relative timestamps while the popup stays open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.usageState) {
      render(normalizeState(changes.usageState.newValue));
    }
  });
  setInterval(loadAndRender, 30_000);

  const btn = document.getElementById("refresh-btn");
  btn.addEventListener("click", () => {
    btn.textContent = "…";
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");

    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      loadAndRender();
      btn.textContent = "Refresh";
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    };
    // The background responds when the fetch actually finishes — re-render
    // then, with a safety timeout in case the worker dies mid-request.
    const safety = setTimeout(done, 10_000);
    chrome.runtime.sendMessage({ type: "FORCE_REFRESH" }, () => {
      void chrome.runtime.lastError; // swallow; state read still works
      clearTimeout(safety);
      done();
    });
  });

  document.getElementById("open-usage-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: USAGE_URL });
  });
});
