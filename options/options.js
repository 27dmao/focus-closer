const $ = (id) => document.getElementById(id);

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
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

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
    tab.classList.add("active");
    document.querySelector(`.panel[data-panel="${tab.dataset.tab}"]`).classList.remove("hidden");
    if (tab.dataset.tab === "dashboard") refreshDashboard();
    if (tab.dataset.tab === "log") refreshLog();
  });
});

let currentLog = [];

async function refreshStatusBar() {
  const { pause } = await send("get_dashboard");
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
    text.textContent = "Active";
    resumeBtn.classList.add("hidden");
    pauseBtn.classList.remove("hidden");
    pauseToday.classList.remove("hidden");
  }
}

async function refreshDashboard() {
  const { stats, installedAt } = await send("get_dashboard");

  $("statSaved7d").textContent = formatDuration(stats.secondsSavedLast7);
  $("statSaved7dSub").textContent = `${formatDuration(stats.secondsSavedToday)} today`;

  $("statClosed7d").textContent = stats.closedLast7;
  $("statClosed7dSub").textContent = `${stats.closedToday} today`;

  $("statToday").textContent = stats.closedToday;
  $("statTodaySub").textContent = `${formatDuration(stats.secondsSavedToday)} saved`;

  $("statAll").textContent = stats.totalClosed;
  const daysSinceInstall = Math.max(1, Math.round((Date.now() - installedAt) / (24 * 60 * 60 * 1000)));
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

  const { log } = await send("get_log");
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
  const { log } = await send("get_log");
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
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-mute);padding:30px;">No entries match.</td></tr>`;
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
    `;
    tr.querySelector(".log-target").textContent = target;
    tr.querySelectorAll("td")[4].textContent = e.reason || "";
    body.appendChild(tr);
  }
}

async function loadRules() {
  const { settings } = await send("get_dashboard");
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
["logSearch", "logVerdict", "logKind"].forEach((id) => {
  $(id).addEventListener("input", renderLog);
  $(id).addEventListener("change", renderLog);
});

loadRules();
refreshStatusBar();
refreshDashboard();
setInterval(refreshStatusBar, 30000);
