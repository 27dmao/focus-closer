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

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
    tab.classList.add("active");
    document.querySelector(`.panel[data-panel="${tab.dataset.tab}"]`).classList.remove("hidden");
    if (tab.dataset.tab === "dashboard") refreshDashboard();
    if (tab.dataset.tab === "log") refreshLog();
    if (tab.dataset.tab === "insights") refreshInsights();
    if (tab.dataset.tab === "sessions") refreshStatusBar();
  });
});

let currentLog = [];

async function refreshStatusBar() {
  const data = await send("get_dashboard");
  if (!data || !data.stats) return;
  const pause = data.pause || { paused: false };
  const session = data.session || { active: false };

  const dot = $("statusDot");
  const text = $("statusText");
  const resumeBtn = $("resumeBtn");
  const pauseBtn = $("pauseBtn");
  const pauseToday = $("pauseTodayBtn");
  if (pause.paused) {
    dot.classList.add("paused");
    if (pause.pausedUntil) {
      const min = Math.max(1, Math.round((pause.pausedUntil - Date.now()) / 60000));
      text.textContent = `Paused · resumes in ${min < 60 ? min + "m" : Math.round(min / 60) + "h"}`;
    } else {
      text.textContent = "Paused · indefinitely";
    }
    resumeBtn.classList.remove("hidden");
    pauseBtn.classList.add("hidden");
    pauseToday.classList.add("hidden");
  } else {
    dot.classList.remove("paused");
    text.textContent = session?.active ? "Focus Session" : "Active";
    resumeBtn.classList.add("hidden");
    pauseBtn.classList.remove("hidden");
    pauseToday.classList.remove("hidden");
  }

  const banner = $("sessionBanner");
  if (session?.active) {
    banner.classList.remove("hidden");
    const minLeft = Math.max(1, Math.round((session.endsAt - Date.now()) / 60000));
    $("sessionSub").textContent = `${session.task} · ${minLeft}m left · ${session.closesDuringSession || 0} blocked`;
  } else {
    banner.classList.add("hidden");
  }
}

function renderSuggestions(suggestions) {
  const card = $("suggestionsCard");
  const host = $("suggestions");
  host.innerHTML = "";
  const shown = (suggestions || []).filter((s) => s.kind !== "info");
  if (shown.length === 0) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  for (const s of shown) {
    const item = document.createElement("div");
    item.className = "suggestion";
    const title = document.createElement("div");
    title.className = "suggestion-title";
    title.textContent = s.title;
    const body = document.createElement("div");
    body.className = "suggestion-body";
    body.textContent = s.body;
    item.appendChild(title);
    item.appendChild(body);
    if (s.action) {
      const actions = document.createElement("div");
      actions.className = "suggestion-actions";
      const apply = document.createElement("button");
      apply.className = "btn-tiny";
      apply.textContent = "Apply";
      apply.addEventListener("click", async () => {
        await send("apply_suggestion", { action: s.action });
        refreshDashboard();
      });
      const dismiss = document.createElement("button");
      dismiss.className = "btn-tiny ghost";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => item.remove());
      actions.appendChild(apply);
      actions.appendChild(dismiss);
      item.appendChild(actions);
    }
    host.appendChild(item);
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
  for (let i = 0; i < stats.perDayLast7.length; i++) {
    const day = stats.perDayLast7[i];
    const col = document.createElement("div");
    col.className = "bar-col";
    const count = document.createElement("div");
    count.className = "bar-count";
    count.textContent = day.closed || "";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${(day.closed / maxCount) * 100}%`;
    bar.title = `${day.closed} tabs, ${formatDuration(day.secondsSaved)} saved`;
    const label = document.createElement("div");
    label.className = "bar-label";
    label.textContent = dayLabel(day.dayOffset);
    col.appendChild(count);
    col.appendChild(bar);
    col.appendChild(label);
    chart.appendChild(col);
  }

  renderSuggestions(data.suggestions);
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
    const isClose = e.verdict === "unproductive" || e.kind === "blocklist" || e.kind === "user_flag";
    const pillCls = e.kind === "user_flag" ? "pill-flag" : (isClose ? "pill-close" : "pill-keep");
    const pillText = e.kind === "user_flag" ? "FLAG" : (isClose ? "CLOSE" : "KEEP");
    const target = e.kind === "youtube"
      ? `${e.title || e.videoId || ""}${e.channel ? " — " + e.channel : ""}`
      : (e.matchedEntry || e.hostname || e.url || "");

    tr.innerHTML = `
      <td>${new Date(e.at).toLocaleString()}</td>
      <td>${e.kind || ""}</td>
      <td><span class="pill ${pillCls}">${pillText}</span></td>
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
    if (canRefute) {
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
        if (res?.ok) refreshLog();
        else alert("Couldn't refute this entry.");
      });
      actions.appendChild(refuteBtn);
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

function renderInsights(insights) {
  const el = $("insightsContent");
  const meta = $("insightsMeta");
  el.innerHTML = "";
  if (insights?.error) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = insights.reason || insights.error;
    el.appendChild(err);
    meta.textContent = "";
    return;
  }
  if (!insights?.text) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = 'No insights yet — click "Generate fresh insights."';
    el.appendChild(empty);
    meta.textContent = "";
    return;
  }

  // Parse Claude's structured response into (label, body) sections.
  // Use textContent for all user-visible strings to avoid any HTML injection risk.
  const SECTIONS = [
    [/^PATTERN OBSERVED:\s*/im, "Pattern observed"],
    [/^BIGGEST ATTENTION LEAK:\s*/im, "Biggest attention leak"],
    [/^ONE THING TO TRY:\s*/im, "One thing to try"]
  ];

  const text = insights.text;
  // Locate each section in the text.
  const hits = [];
  for (const [re, label] of SECTIONS) {
    const m = text.match(re);
    if (m) hits.push({ idx: m.index, len: m[0].length, label });
  }
  hits.sort((a, b) => a.idx - b.idx);

  if (hits.length === 0) {
    const p = document.createElement("p");
    p.textContent = text;
    el.appendChild(p);
  } else {
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const bodyStart = h.idx + h.len;
      const bodyEnd = i + 1 < hits.length ? hits[i + 1].idx : text.length;
      const body = text.slice(bodyStart, bodyEnd).trim();
      const labelEl = document.createElement("span");
      labelEl.className = "section-label";
      labelEl.textContent = h.label;
      el.appendChild(labelEl);
      const p = document.createElement("p");
      p.textContent = body;
      p.style.marginBottom = "4px";
      el.appendChild(p);
    }
  }

  meta.textContent = `Generated ${formatRelativeTime(insights.generatedAt)}`;
}

async function refreshInsights() {
  const el = $("insightsContent");
  el.innerHTML = `<div class="empty">Loading cached insights...</div>`;
  const data = await send("get_dashboard");
  if (data.insights) {
    renderInsights(data.insights);
  } else {
    el.innerHTML = `<div class="empty">No insights generated yet. Click "Generate fresh insights" below — costs about $0.001.</div>`;
  }
}

async function generateInsights() {
  const el = $("insightsContent");
  const btn = $("insightsGenerate");
  btn.disabled = true;
  btn.textContent = "Generating...";
  el.innerHTML = `<div class="empty">Asking Claude...</div>`;
  const res = await send("get_insights", { force: true });
  renderInsights(res.insights);
  btn.disabled = false;
  btn.textContent = "Generate fresh insights";
}

async function loadRules() {
  const data = await send("get_dashboard");
  const settings = data?.settings || {};
  $("apiKey").value = settings.apiKey || "";
  $("musicRule").value = settings.musicRule || "instrumental_only";
  $("blocklist").value = (settings.blocklist || []).join("\n");
  $("channelWhitelist").value = (settings.channelWhitelist || []).join("\n");
  $("channelBlocklist").value = (settings.channelBlocklist || []).join("\n");
  $("toggleX").checked = settings.domainToggles?.["x.com"] !== false;
  $("toggleLinkedIn").checked = settings.domainToggles?.["linkedin.com"] !== false;
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
      domainToggles: toggles
    }
  });
  $("saveStatus").textContent = "Saved ✓";
  setTimeout(() => ($("saveStatus").textContent = ""), 2500);
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
  const partial = { strictLevel: strict };
  if (key) partial.apiKey = key;
  await finishOnboarding(partial);
});

// Sessions
$("sessionStartBtn").addEventListener("click", async () => {
  const task = $("sessionTask").value.trim() || "Deep work";
  const checked = document.querySelector('input[name="dur"]:checked');
  let durationMs = parseInt(checked.value, 10);
  if (checked.value === "custom") {
    const min = parseInt($("sessionCustomMin").value, 10);
    if (!min || min < 5) { alert("Enter a duration (≥5 min)."); return; }
    durationMs = min * 60 * 1000;
  }
  await send("start_session", { durationMs, task, strictBoost: true });
  $("sessionTask").value = "";
  refreshStatusBar();
  document.querySelector('.tab[data-tab="dashboard"]').click();
});
$("sessionEndBtn").addEventListener("click", async () => {
  await send("end_session");
  refreshStatusBar();
  refreshDashboard();
});

$("save").addEventListener("click", saveRules);
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
$("replayOnboarding").addEventListener("click", async () => {
  await send("set_settings", { partial: { onboardingComplete: false } });
  $("onboarding").classList.remove("hidden");
});
$("pauseBtn").addEventListener("click", async () => {
  await send("set_pause", { durationMs: 60 * 60 * 1000, reason: "manual" });
  refreshStatusBar();
  refreshDashboard();
});
$("pauseTodayBtn").addEventListener("click", async () => {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  await send("set_pause", { durationMs: end.getTime() - Date.now(), reason: "manual" });
  refreshStatusBar();
});
$("resumeBtn").addEventListener("click", async () => {
  await send("set_pause", { durationMs: 0 });
  refreshStatusBar();
});
$("insightsGenerate").addEventListener("click", generateInsights);
["logSearch", "logVerdict", "logKind"].forEach((id) => {
  $(id).addEventListener("input", renderLog);
  $(id).addEventListener("change", renderLog);
});

loadRules();
refreshStatusBar();
refreshDashboard();
maybeShowOnboarding();
setInterval(refreshStatusBar, 15000);
