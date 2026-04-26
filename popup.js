// popup.js — Reads UsageState from storage and renders the popup UI.

const DEFAULT_STATE = {
  buckets: [],
  routineRuns: null,
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
  return `Updated ${mins}m ago`;
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

// Renders one bucket (label, %, bar, reset) into the given container.
function renderBucket(container, bucket) {
  const inactive = !!bucket.inactive;
  const pct = bucket.utilization;
  const fillPct = pct != null ? Math.min(100, pct) : 0;

  const section = document.createElement("div");
  section.className = inactive ? "section inactive" : "section";
  section.innerHTML = `
    <div class="label-row">
      <span class="label"></span>
      <span class="value"></span>
    </div>
    <div class="bar-track"><div class="bar-fill"></div></div>
    <div class="reset-time"></div>
  `;
  section.querySelector(".label").textContent = bucket.label;
  section.querySelector(".value").textContent = inactive ? "Not active" : formatPct(pct);
  const fill = section.querySelector(".bar-fill");
  fill.style.width = `${fillPct}%`;
  fill.style.backgroundColor = pct != null ? barColor(pct) : "var(--surface)";
  section.querySelector(".reset-time").textContent = inactive
    ? ""
    : formatResetTime(bucket.resetsAt);

  container.appendChild(section);
}

// Renders the routine-runs bucket (uses used/limit rather than %).
function renderRoutineRuns(container, runs) {
  const { used, limit, resetsAt } = runs;
  let pct = null;
  if (used != null && limit != null && limit > 0) {
    pct = (used / limit) * 100;
  }
  const fillPct = pct != null ? Math.min(100, pct) : 0;
  const valueText =
    used != null && limit != null
      ? `${used} / ${limit}`
      : used != null
      ? `${used}`
      : "—";

  const section = document.createElement("div");
  section.className = "section";
  section.innerHTML = `
    <div class="label-row">
      <span class="label">Routine runs</span>
      <span class="value"></span>
    </div>
    <div class="bar-track"><div class="bar-fill"></div></div>
    <div class="reset-time"></div>
  `;
  section.querySelector(".value").textContent = valueText;
  const fill = section.querySelector(".bar-fill");
  fill.style.width = `${fillPct}%`;
  fill.style.backgroundColor = pct != null ? barColor(pct) : "var(--surface)";
  section.querySelector(".reset-time").textContent = formatResetTime(resetsAt);

  container.appendChild(section);
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
    errorEl.textContent = state.lastError;
    errorEl.style.display = "block";
  } else {
    errorEl.style.display = "none";
  }

  // Tier
  $("tier-pill").textContent = formatTier(state.subscriptionTier);

  // Session (5h) — always first slot
  const sessionSlot = $("session-slot");
  sessionSlot.innerHTML = "";
  const session = (state.buckets || []).find((b) => b.key === "five_hour");
  if (session) {
    renderBucket(sessionSlot, session);
  } else {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No session data yet";
    sessionSlot.appendChild(empty);
  }

  // Weekly group — any bucket starting with "seven_day" or containing "weekly"
  const weeklyGroup = $("weekly-group");
  const weeklySlot = $("weekly-slot");
  weeklySlot.innerHTML = "";
  const weeklyBuckets = (state.buckets || []).filter(
    (b) => b.key !== "five_hour" && (b.key.startsWith("seven_day") || /weekly/i.test(b.key))
  );
  if (weeklyBuckets.length > 0) {
    weeklyBuckets.forEach((b) => renderBucket(weeklySlot, b));
    weeklyGroup.style.display = "";
  } else {
    weeklyGroup.style.display = "none";
  }

  // Daily group — routine runs + any remaining buckets
  const dailyGroup = $("daily-group");
  const dailySlot = $("daily-slot");
  dailySlot.innerHTML = "";
  const otherBuckets = (state.buckets || []).filter(
    (b) =>
      b.key !== "five_hour" &&
      !b.key.startsWith("seven_day") &&
      !/weekly/i.test(b.key)
  );
  otherBuckets.forEach((b) => renderBucket(dailySlot, b));
  if (state.routineRuns) {
    renderRoutineRuns(dailySlot, state.routineRuns);
  }
  dailyGroup.style.display = dailySlot.children.length > 0 ? "" : "none";

  // Extra usage
  const extra = state.extraUsage || {};
  const enabled = !!extra.enabled;
  const inUse = !!extra.inUse;

  const enabledPill = $("extra-enabled-pill");
  enabledPill.textContent = enabled ? "ON" : "OFF";
  enabledPill.classList.remove("pill-on", "pill-off");
  enabledPill.classList.add(enabled ? "pill-on" : "pill-off");

  $("extra-active-pill").style.display = enabled && inUse ? "inline" : "none";

  const detailEl = $("extra-detail");
  const barWrap = $("extra-bar-wrap");
  const extraBar = $("extra-bar");
  const extraResetEl = $("extra-reset");

  if (!enabled) {
    detailEl.innerHTML = "Not enabled on this plan";
    barWrap.style.display = "none";
  } else {
    const parts = [];
    if (extra.spentUsd != null && extra.limitUsd != null && extra.limitUsd > 0) {
      parts.push(
        `<strong>$${extra.spentUsd.toFixed(2)}</strong> of $${extra.limitUsd.toFixed(2)} monthly`
      );
    } else if (extra.spentUsd != null) {
      parts.push(`<strong>$${extra.spentUsd.toFixed(2)}</strong> spent`);
    }
    if (extra.balanceUsd != null) {
      parts.push(`$${extra.balanceUsd.toFixed(2)} balance`);
    }
    detailEl.innerHTML = parts.length > 0 ? parts.join(" · ") : "Enabled — no spend data";

    // Monthly limit progress bar
    if (extra.limitUsd != null && extra.limitUsd > 0 && extra.spentUsd != null) {
      const pct = (extra.spentUsd / extra.limitUsd) * 100;
      const fillPct = Math.min(100, pct);
      extraBar.style.width = `${fillPct}%`;
      extraBar.style.backgroundColor = barColor(pct);
      extraResetEl.textContent = formatResetTime(extra.resetsAt);
      barWrap.style.display = "";
    } else {
      barWrap.style.display = "none";
    }
  }

  // Meta
  $("meta-label").textContent = formatLastUpdated(state.lastUpdated);
}

// ─── Init ───────────────────────────────────────────────────────────────────

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
    render({ ...DEFAULT_STATE, ...state, extraUsage: { ...DEFAULT_STATE.extraUsage, ...(state.extraUsage || {}) } });
  } catch {
    document.getElementById("error-label").textContent = "Failed to load state.";
    document.getElementById("error-label").style.display = "block";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadAndRender();

  document.getElementById("refresh-btn").addEventListener("click", () => {
    const btn = document.getElementById("refresh-btn");
    btn.textContent = "…";
    btn.disabled = true;

    chrome.runtime.sendMessage({ type: "FORCE_REFRESH" }, () => {
      setTimeout(() => {
        loadAndRender();
        btn.textContent = "Refresh";
        btn.disabled = false;
      }, 1500);
    });
  });

  document.getElementById("open-usage-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: USAGE_URL });
  });
});
