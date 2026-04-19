import { getUsageStats, projectPerModel, clearUsageLog } from "../lib/usage.js";
import { MODELS, DEFAULT_MODEL } from "../lib/pricing.js";

const $ = (id) => document.getElementById(id);

// Chrome MV3 service workers can be cold on first message burst — retry once on undefined.
async function send(type, extra = {}) {
  const msg = { type, ...extra };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      if (res !== undefined) return res;
    } catch (e) {
      if (attempt === 1) console.warn(`[focus-closer] send(${type})`, e);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return {};
}

function linesToArray(text) {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

function formatDuration(seconds) {
  if (!seconds || seconds < 60) return `${Math.round(seconds || 0)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function dayLabel(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

// Attention score: log-scale on recent weekly closes, weighted by seconds saved.
// Returns 0-100 integer, meant to trend.
function computeAttentionScore(stats) {
  const closes = stats.closedLast7 || 0;
  const seconds = stats.secondsSavedLast7 || 0;
  if (closes === 0 && seconds === 0) return null;
  const closeComponent = Math.min(50, Math.log(closes + 1) * 15);
  const timeComponent = Math.min(50, Math.log((seconds / 60) + 1) * 9);
  return Math.round(closeComponent + timeComponent);
}

async function renderCostCard() {
  const [settings, stats] = await Promise.all([
    chrome.storage.sync.get(["classifierModel", "monthlyBudgetUsd"]),
    getUsageStats()
  ]);

  const budget = Number(settings.monthlyBudgetUsd) || 0;
  const spent = stats.monthSpentUsd;

  // SVG donut: circumference = 2π × 50 ≈ 314.16
  const C = 314.16;
  const fill = document.querySelector(".cost-donut-fill");
  const pctText = document.querySelector(".cost-donut-pct");
  if (fill && pctText) {
    if (budget > 0) {
      const ratio = Math.min(spent / budget, 1);
      fill.setAttribute("stroke-dasharray", `${(ratio * C).toFixed(2)} ${C}`);
      fill.classList.toggle("over-budget", spent > budget);
      pctText.textContent = `${Math.round((spent / budget) * 100)}%`;
    } else {
      fill.setAttribute("stroke-dasharray", `0 ${C}`);
      fill.classList.remove("over-budget");
      pctText.textContent = "—";
    }
  }

  $("costSpent").textContent = `$${spent.toFixed(2)}`;
  $("costBudget").textContent = budget > 0 ? `of $${budget.toFixed(2)} budget` : "no budget set";

  const modelId = settings.classifierModel || DEFAULT_MODEL;
  const modelLabel = MODELS[modelId]?.label || "Haiku 4.5";
  const projText = stats.dataDays === 0
    ? "Not enough data yet — check back after a few classifications."
    : `Projected: $${stats.projectedMonthlyUsd.toFixed(2)}/mo · ${stats.callsThisMonth} calls · ${modelLabel}`;
  $("costProjection").textContent = projText;
}

async function renderModelCostTable() {
  const tbody = document.querySelector("#modelCostTable tbody");
  if (!tbody) return;

  const [settings, projections, stats] = await Promise.all([
    chrome.storage.sync.get(["classifierModel"]),
    projectPerModel(),
    getUsageStats()
  ]);
  const currentId = settings.classifierModel || DEFAULT_MODEL;

  if (stats.dataDays === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">Classify a few videos to see projections.</td></tr>`;
    return;
  }

  const speedLabel = { fastest: "Fastest", medium: "Medium", slow: "Slow" };
  tbody.innerHTML = projections.map((p) => {
    const isCurrent = p.id === currentId;
    const action = isCurrent
      ? `<span class="current-badge">current</span>`
      : `<button class="btn-switch" data-model-id="${p.id}">Switch →</button>`;
    return `
      <tr>
        <td>${p.label}</td>
        <td>$${p.cost.toFixed(2)}/mo</td>
        <td class="speed-${p.speed}">${speedLabel[p.speed] || p.speed}</td>
        <td>${action}</td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll(".btn-switch").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.modelId;
      await chrome.storage.sync.set({ classifierModel: id });
      await renderModelCostTable();
      await renderCostCard();
      const sel = $("classifierModel");
      if (sel) sel.value = id;
    });
  });
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
    tab.classList.add("active");
    document.querySelector(`.panel[data-panel="${tab.dataset.tab}"]`).classList.remove("hidden");
    if (tab.dataset.tab === "dashboard") refreshDashboard();
    if (tab.dataset.tab === "log") refreshLog();
    if (tab.dataset.tab === "sessions") refreshStatusBar();
  });
});

let currentLog = [];

async function refreshStatusBar() {
  const data = await send("get_dashboard");
  if (!data || !data.stats) return;
  const session = data.session || { active: false };
  $("statusText").textContent = session.active ? "Focus Session" : "Active";

  const banner = $("sessionBanner");
  if (session.active) {
    banner.classList.remove("hidden");
    const minLeft = Math.max(1, Math.round((session.endsAt - Date.now()) / 60000));
    $("sessionSub").textContent = `${session.task} · ${minLeft}m left · ${session.closesDuringSession || 0} blocked`;
  } else {
    banner.classList.add("hidden");
  }
}

// Policy card is a CALL TO ACTION, not a permanent display. Show only when
// there's something for the user to do (5+ feedback signals to distill). Hide
// when the policy is up-to-date and nothing new has accumulated. The actual
// policy can be inspected via the System Prompt editor on the Rules tab.
const POLICY_CTA_THRESHOLD = 5;

// Set to a timestamp when a distillation just succeeded; the card stays visible
// for ~2 seconds afterwards showing "0 new pieces — up to date" so the user
// gets a clear before/after, then auto-hides on the next refresh.
let _justDistilledAt = 0;

function renderPolicy(policy, feedbackCounts) {
  const card = $("policyCard");
  const meta = $("policyMeta");
  const summary = $("policySummary");
  const rulesEl = $("policyRules");
  const reflectBtn = $("reflectBtn");
  rulesEl.innerHTML = "";
  summary.textContent = "";

  const flags = feedbackCounts?.flags || 0;
  const allows = feedbackCounts?.allows || 0;
  const total = flags + allows;
  const unreflected = feedbackCounts?.unreflected || 0;
  const hasPolicy = !!(policy && Array.isArray(policy.rules) && policy.rules.length > 0);
  const justDistilled = Date.now() - _justDistilledAt < 2000;

  // Update the button text + enabled state to reflect what would happen if clicked.
  if (reflectBtn) {
    if (unreflected === 0) {
      reflectBtn.textContent = hasPolicy ? "No new feedback to distill" : "Re-distill from feedback";
      reflectBtn.disabled = true;
    } else {
      reflectBtn.textContent = `Re-distill (${unreflected} new piece${unreflected === 1 ? "" : "s"})`;
      reflectBtn.disabled = false;
    }
  }

  // Decide whether to show the card at all.
  // - No policy + <5 feedback → hide (nothing actionable).
  // - No policy + ≥5 feedback → show (CTA to distill first policy).
  // - Policy exists + 0–4 unreflected → hide (no new work needed).
  // - Policy exists + ≥5 unreflected → show (CTA to re-distill).
  // Special case: just distilled → keep the card visible briefly for the
  // confirmation message, even though normal logic says hide.
  const shouldShow = justDistilled || (hasPolicy
    ? (unreflected >= POLICY_CTA_THRESHOLD)
    : (total >= POLICY_CTA_THRESHOLD));

  if (!shouldShow) {
    if (card) card.classList.add("hidden");
    return;
  }
  if (card) card.classList.remove("hidden");

  if (justDistilled && hasPolicy && unreflected === 0) {
    const n = policy.rules.length;
    meta.textContent = `Distilled ${n} rule${n === 1 ? "" : "s"} ✓ — 0 new pieces of feedback remaining. Up to date.`;
    if (policy.summary) summary.textContent = policy.summary;
    for (const rule of policy.rules) {
      const li = document.createElement("li");
      li.textContent = rule;
      rulesEl.appendChild(li);
    }
    return;
  }

  if (!hasPolicy) {
    meta.textContent = `${total} pieces of feedback ready to distill — click "Re-distill" to generate your first policy.`;
    return;
  }

  const ago = formatRelativeTime(policy.updatedAt || policy.generatedAt);
  meta.textContent = `${unreflected} new feedback signal${unreflected === 1 ? "" : "s"} since last distillation (${ago}). Re-distill to incorporate them.`;

  if (policy.summary) summary.textContent = policy.summary;
  for (const rule of policy.rules) {
    const li = document.createElement("li");
    li.textContent = rule;
    rulesEl.appendChild(li);
  }
}

function renderHeatmap(grid) {
  const host = $("heatmap");
  host.innerHTML = "";
  if (!grid || grid.length === 0) return;
  const max = Math.max(1, ...grid.flat());
  // Header row
  const spacer = document.createElement("div");
  spacer.className = "h-col-label";
  host.appendChild(spacer);
  for (let h = 0; h < 24; h++) {
    const lab = document.createElement("div");
    lab.className = "h-col-label";
    lab.textContent = h % 6 === 0 ? `${h % 12 || 12}${h < 12 ? "a" : "p"}` : "";
    host.appendChild(lab);
  }
  // Day rows
  for (let d = 0; d < grid.length; d++) {
    const dt = new Date();
    dt.setDate(dt.getDate() - (grid.length - 1 - d));
    const lbl = document.createElement("div");
    lbl.className = "h-label";
    lbl.textContent = dt.toLocaleDateString(undefined, { weekday: "short" });
    host.appendChild(lbl);
    for (let h = 0; h < 24; h++) {
      const cell = document.createElement("div");
      cell.className = "h-cell";
      const n = grid[d][h];
      if (n > 0) {
        const t = n / max;
        cell.style.background = `rgba(255, 107, 74, ${0.2 + 0.8 * t})`;
      }
      cell.title = `${dt.toLocaleDateString(undefined, { weekday: "short" })} ${h}:00 — ${n} close${n === 1 ? "" : "s"}`;
      host.appendChild(cell);
    }
  }
}

async function refreshDashboard() {
  const data = await send("get_dashboard");
  if (!data || !data.stats) return;
  const stats = data.stats;

  const score = computeAttentionScore(stats);
  $("attentionScore").textContent = score == null ? "—" : score;
  const daysSinceInstall = Math.max(1, Math.round((Date.now() - data.installedAt) / (24 * 60 * 60 * 1000)));
  $("attentionSub").textContent = score == null
    ? "Score appears after you rack up a few closes."
    : `Based on last 7 days · ${stats.closedLast7} closes · ${formatDuration(stats.secondsSavedLast7)} reclaimed`;

  $("statSaved7d").textContent = formatDuration(stats.secondsSavedLast7);
  $("statSaved7dSub").textContent = `${formatDuration(stats.secondsSavedToday)} today`;

  $("statClosed7d").textContent = stats.closedLast7;
  $("statClosed7dSub").textContent = `${stats.closedToday} today`;

  $("statToday").textContent = stats.closedToday;
  $("statTodaySub").textContent = `${formatDuration(stats.secondsSavedToday)} saved`;

  $("statAll").textContent = stats.totalClosed;
  $("statAllSub").textContent = `${formatDuration(stats.totalSecondsSaved)} over ${daysSinceInstall}d`;

  const chart = $("chart7d");
  chart.innerHTML = "";
  const maxCount = Math.max(1, ...stats.perDayLast7.map((d) => d.closed));
  const MAX_BAR_PX = 90;
  for (let i = 0; i < stats.perDayLast7.length; i++) {
    const day = stats.perDayLast7[i];
    const col = document.createElement("div");
    col.className = "bar-col";
    const count = document.createElement("div");
    count.className = "bar-count";
    count.textContent = day.closed || "";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${(day.closed / maxCount) * MAX_BAR_PX}px`;
    bar.title = `${day.closed} tabs, ${formatDuration(day.secondsSaved)} saved`;
    const label = document.createElement("div");
    label.className = "bar-label";
    label.textContent = dayLabel(day.dayOffset);
    col.appendChild(count);
    col.appendChild(bar);
    col.appendChild(label);
    chart.appendChild(col);
  }

  renderPolicy(data.policy, data.feedbackCounts);
  renderHeatmap(data.heatmap);

  const bd = $("sourceBreakdown");
  bd.innerHTML = "";
  const sources = stats.bySource;
  const sourceOrder = [
    ["blocklist", "Blocklist"],
    ["claude", "Claude API"],
    ["rule", "Local rule"],
    ["cache", "Cache"],
    ["user_flag", "User flag"],
    ["user_block", "User block"],
    ["session_boost", "Session boost"],
    ["override", "Override"]
  ];
  const totalBySource = Math.max(1, Object.values(sources).reduce((a, b) => a + b, 0));
  for (const [key, name] of sourceOrder) {
    const n = sources[key] || 0;
    if (n === 0) continue;
    const row = document.createElement("div");
    row.className = "breakdown-row";
    row.innerHTML = `
      <div class="breakdown-name">${name}</div>
      <div class="breakdown-bar"><div class="breakdown-fill" style="width:${(n / totalBySource) * 100}%"></div></div>
      <div class="breakdown-count">${n}</div>
    `;
    bd.appendChild(row);
  }
  if (bd.children.length === 0) bd.innerHTML = `<div class="empty">No data yet — use the extension for a bit.</div>`;

  const logResp = await send("get_log");
  const log = logResp?.log || [];
  const recentCloses = log
    .filter((e) => e.verdict === "unproductive" || e.kind === "blocklist" || e.kind === "user_flag")
    .slice(-8).reverse();
  const rc = $("recentCloses");
  rc.innerHTML = "";
  if (recentCloses.length === 0) {
    rc.innerHTML = `<div class="empty">No closes yet.</div>`;
  } else {
    for (const e of recentCloses) {
      const row = document.createElement("div");
      row.className = "recent-item";
      const kindCls = e.kind === "youtube" ? "yt" : e.kind === "user_flag" ? "uf" : "bl";
      const kindLabel = e.kind === "youtube" ? "YT" : e.kind === "user_flag" ? "FLAG" : "BL";
      const title = e.title || e.matchedEntry || e.hostname || "(unknown)";
      const sub = e.kind === "youtube" ? (e.channel || "") : (e.reason || "");
      row.innerHTML = `
        <span class="recent-kind ${kindCls}">${kindLabel}</span>
        <div class="recent-main">
          <div class="recent-title"></div>
          <div class="recent-sub"></div>
        </div>
        <span class="recent-time">${formatRelativeTime(e.at)}</span>
      `;
      row.querySelector(".recent-title").textContent = title;
      row.querySelector(".recent-sub").textContent = sub;
      rc.appendChild(row);
    }
  }

  renderCostCard().catch(() => {});
  renderModelCostTable().catch(() => {});
}

function describeRefuteAction(action, entry) {
  if (action === "video_whitelisted") return `whitelisted "${entry.title || "video"}"${entry.channel ? ` and channel "${entry.channel}"` : ""}`;
  if (action === "video_blocked") return `blocked "${entry.title || "video"}"${entry.channel ? ` and channel "${entry.channel}"` : ""}`;
  if (action === "domain_unblocked") return `permanently unblocked "${entry.matchedEntry || entry.hostname}"`;
  return "applied";
}

function showLogToast(text) {
  const host = $("logToast");
  if (!host) return;
  host.textContent = text;
  host.classList.remove("hidden");
  host.classList.add("visible");
  clearTimeout(showLogToast._t);
  showLogToast._t = setTimeout(() => {
    host.classList.remove("visible");
    setTimeout(() => host.classList.add("hidden"), 200);
  }, 3500);
}

async function refreshLog() {
  const logResp = await send("get_log");
  const log = logResp?.log || [];
  currentLog = log.slice().reverse();
  renderLog();
}

function renderLog() {
  const q = ($("logSearch").value || "").toLowerCase();
  const verdictFilter = $("logVerdict").value;
  const kindFilter = $("logKind").value;

  const filtered = currentLog.filter((e) => {
    if (kindFilter !== "all" && e.kind !== kindFilter) return false;
    const isClose = e.verdict === "unproductive" || e.kind === "blocklist" || e.kind === "user_flag";
    if (verdictFilter === "close" && !isClose) return false;
    if (verdictFilter === "keep" && isClose) return false;
    if (q) {
      const haystack = [e.title, e.channel, e.hostname, e.matchedEntry, e.reason, e.url, e.source].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  $("logCount").textContent = filtered.length;
  const body = $("logBody");
  body.innerHTML = "";
  if (filtered.length === 0) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-mute);padding:30px;">No entries match.</td></tr>`;
    return;
  }
  for (const e of filtered.slice(0, 500)) {
    const tr = document.createElement("tr");
    const isRefuted = !!e.refutedAt;
    if (isRefuted) tr.classList.add("refuted");
    const isClose = e.verdict === "unproductive" || e.kind === "blocklist" || e.kind === "user_flag";
    const pillCls = e.kind === "user_flag" ? "pill-flag" : (isClose ? "pill-close" : "pill-keep");
    const pillText = e.kind === "user_flag" ? "FLAG" : (isClose ? "CLOSE" : "KEEP");
    const target = e.kind === "youtube"
      ? `${e.title || e.videoId || ""}${e.channel ? " — " + e.channel : ""}`
      : (e.matchedEntry || e.hostname || e.url || "");

    tr.innerHTML = `
      <td>${new Date(e.at).toLocaleString()}</td>
      <td>${e.kind || ""}</td>
      <td><span class="pill ${pillCls}">${pillText}</span>${isRefuted ? ' <span class="pill pill-refuted" title="You refuted this decision">REFUTED</span>' : ""}</td>
      <td class="log-target"></td>
      <td></td>
      <td>${e.source || ""}</td>
      <td><div class="log-actions"></div></td>
    `;
    tr.querySelector(".log-target").textContent = target;
    tr.querySelectorAll("td")[4].textContent = e.reason || "";
    const actions = tr.querySelector(".log-actions");
    const canRefute = (e.kind === "youtube" && e.videoId) ||
                      (e.kind === "user_flag" && e.videoId) ||
                      (e.kind === "blocklist" && e.matchedEntry);
    if (canRefute && !isRefuted) {
      const refuteBtn = document.createElement("button");
      refuteBtn.className = "refute";
      refuteBtn.textContent = "Refute";
      refuteBtn.title = isClose
        ? "Mark as wrongly closed — future visits will pass through"
        : "Mark as wrongly kept — future visits will close";
      refuteBtn.addEventListener("click", async () => {
        const verb = isClose ? "whitelist" : "block";
        if (!confirm(`Refute this decision? Focus Closer will ${verb} this ${e.kind === "blocklist" ? "domain" : "video/channel"} going forward.`)) return;
        const res = await send("refute_log_entry", { at: e.at });
        if (res?.ok) {
          showLogToast(`Refuted ✓  ${describeRefuteAction(res.action, e)}`);
          refreshLog();
        } else {
          alert("Couldn't refute this entry.");
        }
      });
      actions.appendChild(refuteBtn);
    } else if (isRefuted) {
      const done = document.createElement("button");
      done.className = "refuted-done";
      done.textContent = "Refuted ✓";
      done.disabled = true;
      done.title = `${describeRefuteAction(e.refuteAction, e)} · ${formatRelativeTime(e.refutedAt)}`;
      actions.appendChild(done);
    }
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove this entry from the log";
    removeBtn.addEventListener("click", async () => {
      await send("remove_log_entry", { at: e.at });
      refreshLog();
      refreshDashboard();
    });
    actions.appendChild(removeBtn);
    body.appendChild(tr);
  }
}

async function loadRules() {
  const data = await send("get_dashboard");
  const settings = data?.settings || {};
  $("apiKey").value = settings.apiKey || "";
  // Show stored-key confirmation so the user can SEE that a key is on file.
  const status = $("apiKeyStatus");
  if (status) {
    if (settings.apiKey && settings.apiKey.startsWith("sk-ant-")) {
      status.textContent = `✓ Stored · ending in …${settings.apiKey.slice(-6)}`;
      status.className = "card-sub api-key-ok";
    } else {
      status.textContent = "Not set — paste your key below";
      status.className = "card-sub";
    }
  }
  wireApiKeyAutoSave();
  $("musicRule").value = settings.musicRule || "instrumental_only";
  $("blocklist").value = (settings.blocklist || []).join("\n");
  $("channelWhitelist").value = (settings.channelWhitelist || []).join("\n");
  $("channelBlocklist").value = (settings.channelBlocklist || []).join("\n");
  $("toggleX").checked = settings.domainToggles?.["x.com"] !== false;
  $("toggleLinkedIn").checked = settings.domainToggles?.["linkedin.com"] !== false;
  $("classifierModel").value = settings.classifierModel || DEFAULT_MODEL;
  $("monthlyBudget").value = settings.monthlyBudgetUsd ?? 5;
  await loadSystemPrompt(settings);
  updateLatencyWarning();
}

// API key auto-save — pasting + Enter + blur all save. Visible confirmation
// next to the field so the user trusts that it persisted.
let _apiKeySaveTimer = null;
async function saveApiKey(source) {
  const input = $("apiKey");
  const status = $("apiKeyStatus");
  const key = (input.value || "").trim();
  if (!status) return;

  if (!key) {
    status.textContent = "";
    status.className = "card-sub";
    return;
  }
  if (!key.startsWith("sk-ant-") || key.length < 30) {
    status.textContent = "⚠ Doesn't look like an Anthropic key (should start with sk-ant-)";
    status.className = "card-sub api-key-warn";
    return;
  }

  await send("set_settings", { partial: { apiKey: key } });

  // Verify the round-trip — read it back to confirm it actually persisted.
  const data = await send("get_dashboard");
  const stored = data?.settings?.apiKey || "";
  if (stored === key) {
    const tail = key.slice(-6);
    status.textContent = `✓ Saved · ending in …${tail} · ${source}`;
    status.className = "card-sub api-key-ok";
  } else {
    status.textContent = "⚠ Save didn't persist — chrome.storage.sync may be full or rate-limited";
    status.className = "card-sub api-key-warn";
  }
}

function wireApiKeyAutoSave() {
  const input = $("apiKey");
  if (!input || input.dataset.wired) return;
  input.dataset.wired = "1";

  // Paste — fires before the input event, so wait a tick for the value.
  input.addEventListener("paste", () => {
    setTimeout(() => saveApiKey("paste"), 10);
  });

  // Enter — explicit user intent.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveApiKey("press Enter");
    }
  });

  // Blur — safety net.
  input.addEventListener("blur", () => saveApiKey("autosave"));

  // Debounced typing — saves while you type.
  input.addEventListener("input", () => {
    clearTimeout(_apiKeySaveTimer);
    _apiKeySaveTimer = setTimeout(() => saveApiKey("typing"), 800);
  });
}

async function loadSystemPrompt(settings) {
  const ta = $("systemPrompt");
  const badge = $("promptStatusBadge");
  if (!ta) return;
  const custom = (settings.customSystemPrompt || "").trim();
  if (custom.length > 50) {
    ta.value = custom;
    badge.textContent = "Custom";
    badge.classList.add("custom");
  } else {
    const res = await send("get_default_system_prompt");
    ta.value = res?.prompt || "";
    badge.textContent = "Default";
    badge.classList.remove("custom");
  }
}

async function saveSystemPrompt() {
  const ta = $("systemPrompt");
  const status = $("promptSaveStatus");
  const text = (ta.value || "").trim();
  if (text.length < 100) {
    status.textContent = "Prompt looks too short — paste the full instructions or click Reset to default.";
    status.style.color = "var(--unproductive)";
    return;
  }
  // Compare against default — if identical, store empty (use default).
  const defaultRes = await send("get_default_system_prompt");
  const isDefault = defaultRes?.prompt && text === defaultRes.prompt.trim();
  await send("set_settings", { partial: { customSystemPrompt: isDefault ? "" : text } });
  status.textContent = isDefault ? "Saved as default ✓" : "Custom prompt saved ✓";
  status.style.color = "";
  setTimeout(() => (status.textContent = ""), 2500);
  // Also clear the verdict cache so future classifications use the new prompt.
  await send("clear_video_cache");
  loadRules();
}

async function resetSystemPrompt() {
  if (!confirm("Reset to the default system prompt? Your customizations will be lost.")) return;
  await send("set_settings", { partial: { customSystemPrompt: "" } });
  await send("clear_video_cache");
  loadRules();
  $("promptSaveStatus").textContent = "Reset to default ✓";
  setTimeout(() => ($("promptSaveStatus").textContent = ""), 2500);
}

function updateLatencyWarning() {
  const sel = $("classifierModel");
  const warn = $("modelLatencyWarn");
  if (!sel || !warn) return;
  const speed = MODELS[sel.value]?.speed || "fastest";
  warn.classList.toggle("hidden", speed === "fastest");
}

async function saveRules() {
  const toggles = {
    "x.com": $("toggleX").checked,
    "twitter.com": $("toggleX").checked,
    "linkedin.com": $("toggleLinkedIn").checked
  };
  await send("set_settings", {
    partial: {
      apiKey: $("apiKey").value.trim(),
      musicRule: $("musicRule").value,
      blocklist: linesToArray($("blocklist").value),
      channelWhitelist: linesToArray($("channelWhitelist").value),
      channelBlocklist: linesToArray($("channelBlocklist").value),
      domainToggles: toggles,
      classifierModel: $("classifierModel").value,
      monthlyBudgetUsd: parseFloat($("monthlyBudget").value) || 0,
    }
  });
  $("saveStatus").textContent = "Saved ✓";
  setTimeout(() => ($("saveStatus").textContent = ""), 2500);
  renderCostCard().catch(() => {});
  renderModelCostTable().catch(() => {});
}

// Onboarding
async function maybeShowOnboarding() {
  const data = await send("get_dashboard");
  const settings = data?.settings || {};
  // Migration: if user already has an API key, consider onboarding done.
  if (settings.apiKey && !settings.onboardingComplete) {
    await send("set_settings", { partial: { onboardingComplete: true } });
    return;
  }
  if (!settings.onboardingComplete) {
    $("onboarding").classList.remove("hidden");
  }
}
async function finishOnboarding(partial) {
  await send("set_settings", { partial: { ...partial, onboardingComplete: true } });
  $("onboarding").classList.add("hidden");
  loadRules();
  refreshDashboard();
}
$("onboardSkip1").addEventListener("click", async () => { await finishOnboarding({}); });
$("onboardDone").addEventListener("click", async () => {
  const key = $("onboardApiKey").value.trim();
  const strict = document.querySelector('input[name="strict"]:checked').value;
  const briefText = ($("onboardBrief").value || "").trim();
  const partial = { strictLevel: strict };
  if (key) partial.apiKey = key;
  // Save settings + close onboarding immediately so the user isn't waiting.
  await finishOnboarding(partial);
  // Then fire the brief application in the background if they wrote one.
  if (briefText && key) {
    const res = await send("apply_brief", { text: briefText });
    if (res?.ok) {
      const s = res.summary;
      const parts = [];
      if (s.domainsAdded.length) parts.push(`blocked ${s.domainsAdded.length} domain${s.domainsAdded.length === 1 ? "" : "s"}`);
      if (s.channelsAdded.length) parts.push(`${s.channelsAdded.length} channel${s.channelsAdded.length === 1 ? "" : "s"}`);
      if (s.rulesAdded) parts.push(`${s.rulesAdded} policy rule${s.rulesAdded === 1 ? "" : "s"}`);
      if (parts.length) alert(`Trained from your description: ${parts.join(", ")}.`);
      loadRules();
      refreshDashboard();
    }
  }
});

async function applyBrief() {
  const btn = $("briefApplyBtn");
  const status = $("briefStatus");
  const text = ($("briefText").value || "").trim();
  if (!text) { status.textContent = "Write a description first."; status.style.color = "var(--unproductive)"; return; }
  btn.disabled = true;
  btn.textContent = "Training…";
  status.textContent = "";
  const res = await send("apply_brief", { text });
  btn.disabled = false;
  btn.textContent = "Train";
  if (!res?.ok) {
    status.textContent = res?.reason || "Failed to apply.";
    status.style.color = "var(--unproductive)";
    return;
  }
  const s = res.summary;
  const parts = [];
  if (s.domainsAdded.length) parts.push(`+${s.domainsAdded.length} domain${s.domainsAdded.length === 1 ? "" : "s"}`);
  if (s.channelsAdded.length) parts.push(`+${s.channelsAdded.length} channel${s.channelsAdded.length === 1 ? "" : "s"}`);
  if (s.rulesAdded) parts.push(`+${s.rulesAdded} rule${s.rulesAdded === 1 ? "" : "s"}`);
  if (s.domainsRejected.length) parts.push(`(${s.domainsRejected.length} skipped — work-protected)`);
  status.textContent = parts.length ? `${parts.join(" · ")} ✓` : "No new rules — already covered.";
  status.style.color = "";
  $("briefText").value = "";
  setTimeout(() => (status.textContent = ""), 4000);
  loadRules();
  refreshDashboard();
}
$("briefApplyBtn").addEventListener("click", applyBrief);
$("savePromptBtn").addEventListener("click", saveSystemPrompt);
$("resetPromptBtn").addEventListener("click", resetSystemPrompt);
$("viewPromptLink").addEventListener("click", (e) => {
  e.preventDefault();
  document.querySelector('.tab[data-tab="rules"]').click();
  setTimeout(() => {
    const card = document.querySelector(".prompt-card");
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1400);
    }
  }, 60);
});

// Sessions
async function startSession() {
  const task = $("sessionTask").value.trim() || "Deep work";
  const checked = document.querySelector('input[name="dur"]:checked');
  let durationMs = parseInt(checked.value, 10);
  if (checked.value === "custom") {
    const min = parseInt($("sessionCustomMin").value, 10);
    if (!min || min < 5 || min > 240) {
      alert("Enter a custom duration between 5 and 240 minutes.");
      $("sessionCustomMin").focus();
      return;
    }
    durationMs = min * 60 * 1000;
  }
  await send("start_session", { durationMs, task, strictBoost: true });
  $("sessionTask").value = "";
  refreshStatusBar();
  document.querySelector('.tab[data-tab="dashboard"]').click();
}
$("sessionStartBtn").addEventListener("click", startSession);
document.querySelectorAll('input[name="dur"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (r.value === "custom" && r.checked) $("sessionCustomMin").focus();
  });
});
$("sessionCustomMin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); startSession(); }
});
$("sessionTask").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); startSession(); }
});
$("sessionEndBtn").addEventListener("click", async () => {
  await send("end_session");
  refreshStatusBar();
  refreshDashboard();
});

$("save").addEventListener("click", saveRules);
$("classifierModel")?.addEventListener("change", updateLatencyWarning);
$("monthlyBudget")?.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  await saveRules();
  document.querySelector('.tab[data-tab="dashboard"]')?.click();
});
$("clearLog").addEventListener("click", async () => {
  if (!confirm("Clear the entire decision log?")) return;
  await send("clear_log");
  currentLog = [];
  renderLog();
  refreshDashboard();
});
$("clearCache").addEventListener("click", async () => {
  if (!confirm("Clear the video verdict cache? Next visits will re-classify.")) return;
  const res = await send("clear_video_cache");
  alert(`Removed ${res.removed} cached verdicts.`);
});
$("clearUsage")?.addEventListener("click", async () => {
  if (!confirm("Clear the API usage log? This resets the cost donut and projections.")) return;
  await clearUsageLog();
  await renderCostCard();
  await renderModelCostTable();
});
$("replayOnboarding").addEventListener("click", async () => {
  await send("set_settings", { partial: { onboardingComplete: false } });
  $("onboarding").classList.remove("hidden");
});
$("reflectBtn").addEventListener("click", async () => {
  const btn = $("reflectBtn");
  const status = $("reflectStatus");
  btn.disabled = true;
  btn.textContent = "Distilling…";
  status.textContent = "";
  const res = await send("run_reflection");
  if (!res?.ok) {
    btn.disabled = false;
    btn.textContent = "Re-distill from feedback";
    const err = res?.error || res?.policy;
    status.textContent = (err?.reason || err?.error || "Distillation failed.") + " (check Anthropic API key + balance)";
    status.style.color = "var(--unproductive)";
    refreshDashboard();
    return;
  }

  // Mark the success window so renderPolicy keeps the card visible briefly
  // with "0 new pieces — up to date" before normal hide-logic kicks in.
  _justDistilledAt = Date.now();
  const n = res.policy?.rules?.length || 0;
  status.textContent = `Distilled ${n} rule${n === 1 ? "" : "s"} ✓`;
  status.style.color = "";

  // Render once now (shows the success state).
  await refreshDashboard();
  // After 2s, render again — the success window has expired so the card hides.
  setTimeout(() => {
    status.textContent = "";
    refreshDashboard();
  }, 2200);
});
$("clearPolicyBtn").addEventListener("click", async () => {
  if (!confirm("Clear the learned policy? Feedback history is preserved — you can re-distill anytime.")) return;
  await send("clear_personal_policy");
  refreshDashboard();
});
["logSearch", "logVerdict", "logKind"].forEach((id) => {
  $(id).addEventListener("input", renderLog);
  $(id).addEventListener("change", renderLog);
});

$("costEditBudget")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.querySelector('.tab[data-tab="rules"]')?.click();
  const budgetInput = $("monthlyBudget");
  if (budgetInput) {
    budgetInput.focus();
    budgetInput.select();
  }
});

loadRules();
refreshStatusBar();
refreshDashboard();
maybeShowOnboarding();
setInterval(refreshStatusBar, 15000);
