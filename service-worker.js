import {
  getSync,
  setSync,
  getVerdictFromCache,
  setVerdictInCache,
  isWorkWhitelisted,
  isVideoOverridden,
  addVideoOverride,
  removeVideoOverride,
  isVideoUserBlocked,
  addVideoUserBlock,
  removeVideoUserBlock,
  getMatchingOverride,
  setOverride,
  entryMatchesUrl,
  parseBlocklistEntry,
  getPauseState,
  setPauseState,
  getOrInitInstallMeta,
  getSessionState,
  startSession,
  endSession,
  incrementSessionCloseCount,
  getInsightsCache,
  setInsightsCache
} from "./lib/storage.js";
import { logDecision, getStats, getLog, clearLog } from "./lib/logger.js";
import { generateSuggestions } from "./lib/suggestions.js";
import { classifyLocally } from "./classifier/rules.js";
import { classifyWithClaude } from "./classifier/claude.js";
import { generateInsights } from "./classifier/insights.js";

chrome.runtime.onInstalled.addListener(() => { getOrInitInstallMeta(); });
chrome.runtime.onStartup.addListener(() => { getOrInitInstallMeta(); });

function parseYouTubeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!u.hostname.endsWith("youtube.com")) return null;
    if (u.pathname === "/watch") {
      const v = u.searchParams.get("v");
      if (v) return { kind: "watch", videoId: v };
    }
    if (u.pathname.startsWith("/shorts/")) {
      const v = u.pathname.split("/")[2];
      if (v) return { kind: "short", videoId: v };
    }
    return null;
  } catch {
    return null;
  }
}

function hostnameFromUrl(urlStr) {
  try { return new URL(urlStr).hostname.toLowerCase(); }
  catch { return ""; }
}

function parseUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return { hostname: u.hostname.toLowerCase(), pathname: u.pathname };
  } catch { return null; }
}

function buildHourHeatmap(log) {
  // 7 days × 24 hours; day 0 = 6 days ago, day 6 = today. Closes only.
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  const DAY = 24 * 60 * 60 * 1000;
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const e of log) {
    const isClose = e.verdict === "unproductive" || e.kind === "blocklist" || e.kind === "user_flag";
    if (!isClose) continue;
    const d = new Date(e.at);
    const daysAgo = Math.floor((now.getTime() - d.getTime()) / DAY);
    if (daysAgo < 0 || daysAgo > 6) continue;
    const dayIdx = 6 - daysAgo;
    grid[dayIdx][d.getHours()] += 1;
  }
  return grid;
}

function findMatchingBlocklistEntry(hostname, pathname, blocklist, toggles) {
  for (const entry of blocklist) {
    if (!entryMatchesUrl(entry, hostname, pathname)) continue;
    const { domain } = parseBlocklistEntry(entry);
    if (toggles && toggles[domain] === false) continue;
    return entry;
  }
  return null;
}

async function classifyVideo(meta, settings, sessionActive) {
  if (await isVideoUserBlocked(meta.videoId)) {
    return { verdict: "unproductive", source: "user_block", reason: "you flagged this video as distracting", confidence: 1 };
  }
  if (await isVideoOverridden(meta.videoId)) {
    return { verdict: "productive", source: "override", reason: "video marked keep-open by user", confidence: 1 };
  }

  const cached = await getVerdictFromCache(meta.videoId);
  if (cached && !sessionActive) return { ...cached, source: cached.source || "cache", cached: true };

  const local = classifyLocally(meta, settings);
  if (local && local.confidence >= 0.85) {
    await setVerdictInCache(meta.videoId, local);
    return local;
  }

  const remote = await classifyWithClaude(meta, settings);
  if (remote.verdict) {
    if (sessionActive && remote.verdict === "productive" && remote.confidence < 0.8) {
      await setVerdictInCache(meta.videoId, remote);
      return { ...remote, verdict: "unproductive", reason: `low-confidence "productive" (${remote.reason}) — during Focus Session, borderline defaults to close`, source: "session_boost" };
    }
    await setVerdictInCache(meta.videoId, remote);
    return remote;
  }

  return {
    verdict: "keep_open",
    confidence: 0,
    reason: `classifier unavailable (${remote.error}): ${remote.reason}`,
    source: "fail_open"
  };
}

async function pickPopupTabId(excludeTabId) {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter(
    (t) => t.id !== excludeTabId &&
           t.url &&
           !t.url.startsWith("chrome://") &&
           !t.url.startsWith("chrome-extension://") &&
           !t.url.startsWith("edge://")
  );
  const active = candidates.find((t) => t.active);
  if (active) return active.id;
  if (candidates.length > 0) return candidates[0].id;
  return null;
}

function popupRendererSource() {
  return function renderPopup(detail) {
    const EXISTING_ID = "__focus_closer_popup__";
    const prev = document.getElementById(EXISTING_ID);
    if (prev) prev.remove();

    const isYt = detail.kind === "youtube";
    const isUserFlag = detail.kind === "user_flag";
    const bg = "#1e1e1e";
    const accent = isUserFlag ? "#f57c00" : (isYt ? "#c0392b" : "#8e24aa");

    const host = document.createElement("div");
    host.id = EXISTING_ID;
    host.style.cssText = [
      "position:fixed",
      "bottom:16px",
      "right:16px",
      "z-index:2147483647",
      "font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "transform:translateY(6px) scale(0.98)",
      "opacity:0",
      "transition:transform 220ms cubic-bezier(0.16,1,0.3,1),opacity 180ms ease-out"
    ].join(";");

    const card = document.createElement("div");
    card.style.cssText = [
      `background:${bg}`,
      "color:#fff",
      "padding:10px 12px",
      "border-radius:10px",
      "box-shadow:0 10px 28px rgba(0,0,0,0.45),0 2px 6px rgba(0,0,0,0.25)",
      `border-left:3px solid ${accent}`,
      "min-width:260px",
      "max-width:340px",
      "backdrop-filter:blur(10px)"
    ].join(";");

    const header = document.createElement("div");
    header.style.cssText = "font-weight:700;letter-spacing:0.4px;margin-bottom:4px;font-size:10px;opacity:0.8;text-transform:uppercase;";
    header.textContent = isUserFlag ? "Flagged as distracting" : (isYt ? "Closed YouTube video" : `Closed ${detail.matchedEntry || detail.hostname}`);
    card.appendChild(header);

    const body = document.createElement("div");
    body.style.cssText = "margin-bottom:2px;opacity:0.95;";
    if (isYt || isUserFlag) {
      const t = document.createElement("div");
      t.style.cssText = "font-weight:600;margin-bottom:1px;font-size:12px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;";
      t.textContent = detail.title || "(unknown title)";
      const c = document.createElement("div");
      c.style.cssText = "opacity:0.65;font-size:11px;";
      c.textContent = detail.channel || "";
      body.appendChild(t);
      if (detail.channel) body.appendChild(c);
    }
    const reason = document.createElement("div");
    reason.style.cssText = "margin-top:4px;opacity:0.75;font-size:11px;line-height:1.35;";
    reason.textContent = detail.reason || "";
    body.appendChild(reason);
    card.appendChild(body);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:5px;flex-wrap:wrap;margin-top:9px;";

    function mkBtn(label, payload, primary) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = [
        "border:0",
        `background:${primary ? accent : "rgba(255,255,255,0.1)"}`,
        "color:#fff",
        "padding:6px 9px",
        "border-radius:5px",
        "font:600 11px/1 inherit",
        "cursor:pointer",
        "white-space:nowrap",
        "transition:background 120ms ease,transform 80ms ease"
      ].join(";");
      b.addEventListener("mouseenter", () => { b.style.background = primary ? "#ff8363" : "rgba(255,255,255,0.18)"; });
      b.addEventListener("mouseleave", () => { b.style.background = primary ? accent : "rgba(255,255,255,0.1)"; });
      b.addEventListener("mousedown", () => { b.style.transform = "scale(0.96)"; });
      b.addEventListener("mouseup", () => { b.style.transform = "scale(1)"; });
      b.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "popup_action", payload });
        cleanup();
      });
      return b;
    }

    if (isUserFlag) {
      actions.appendChild(mkBtn("Undo", { action: "undo_user_flag", videoId: detail.videoId, url: detail.url }, true));
      if (detail.channel) actions.appendChild(mkBtn(`Always block "${detail.channel}"`, { action: "always_block_channel", channel: detail.channel }));
    } else if (isYt) {
      actions.appendChild(mkBtn("Reopen (false positive)", { action: "reopen_video", videoId: detail.videoId, url: detail.url }, true));
      if (detail.channel) {
        actions.appendChild(mkBtn(`Always allow "${detail.channel}"`, { action: "always_allow_channel", channel: detail.channel, videoId: detail.videoId, url: detail.url }));
      }
    } else {
      const entry = detail.matchedEntry || detail.hostname;
      actions.appendChild(mkBtn("Reopen 60s", { action: "reopen_once", entry, url: detail.url }, true));
      actions.appendChild(mkBtn("Unblock 30 min", { action: "unblock", entry, url: detail.url, durationMs: 30 * 60 * 1000 }));
      actions.appendChild(mkBtn("Unblock today", { action: "unblock", entry, url: detail.url, durationMs: 24 * 60 * 60 * 1000 }));
      actions.appendChild(mkBtn("Unblock forever", { action: "unblock", entry, url: detail.url, durationMs: null }));
    }
    card.appendChild(actions);

    const meta = document.createElement("div");
    meta.style.cssText = "margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center;font-size:9px;opacity:0.5;";
    const left = document.createElement("span");
    left.textContent = "ESC to dismiss · hover to hold";
    const right = document.createElement("a");
    right.textContent = "Pause extension";
    right.href = "#";
    right.style.cssText = "color:inherit;text-decoration:underline;cursor:pointer;";
    right.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "popup_action", payload: { action: "pause", durationMs: 60 * 60 * 1000 } });
      cleanup();
    });
    meta.appendChild(left);
    meta.appendChild(right);
    card.appendChild(meta);

    host.appendChild(card);
    document.documentElement.appendChild(host);

    requestAnimationFrame(() => {
      host.style.transform = "translateY(0) scale(1)";
      host.style.opacity = "1";
    });

    let remaining = 5000;
    let lastTick = Date.now();
    let paused = false;
    let timer = null;
    let closed = false;

    function tick() {
      if (paused || closed) return;
      const now = Date.now();
      remaining -= now - lastTick;
      lastTick = now;
      if (remaining <= 0) cleanup();
      else timer = setTimeout(tick, Math.min(remaining, 200));
    }
    function cleanup() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("keydown", onKey, true);
      host.style.transform = "translateY(8px) scale(0.98)";
      host.style.opacity = "0";
      setTimeout(() => { if (host.parentNode) host.remove(); }, 200);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); cleanup(); }
    }
    host.addEventListener("mouseenter", () => { paused = true; });
    host.addEventListener("mouseleave", () => { paused = false; lastTick = Date.now(); tick(); });
    document.addEventListener("keydown", onKey, true);
    lastTick = Date.now();
    tick();
  };
}

async function showPopup(excludeTabId, detail) {
  const targetId = await pickPopupTabId(excludeTabId);
  if (targetId === null) {
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: detail.kind === "youtube" ? "Closed YouTube video" : `Closed ${detail.hostname || ""}`,
        message: (detail.title || detail.hostname || "") + " — " + (detail.reason || "")
      });
    } catch {}
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetId },
      func: popupRendererSource(),
      args: [detail],
      world: "ISOLATED"
    });
  } catch (e) {
    console.warn("[focus-closer] popup inject failed", e);
  }
}

async function closeAndNotify(tabId, detail) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    console.warn("[focus-closer] tab close failed", e);
  }
  await incrementSessionCloseCount();
  await showPopup(tabId, detail);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "session_end") return;
  const s = await endSession();
  if (!s) return;
  const duration = Math.round((s.endsAt - s.startedAt) / 60000);
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabId = tabs[0]?.id;
  const message = `${s.task} • ${duration} min • ${s.closesDuringSession || 0} distractions blocked`;
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "Focus session complete",
      message
    });
  } catch {}
  if (tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: (detail) => {
          const prev = document.getElementById("__focus_closer_session_toast__");
          if (prev) prev.remove();
          const host = document.createElement("div");
          host.id = "__focus_closer_session_toast__";
          host.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483647;font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;";
          host.innerHTML = `
            <div style="background:#1e1e1e;color:#fff;padding:16px 18px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.4);border-left:4px solid #3ecf8e;min-width:320px;max-width:420px;">
              <div style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.85;margin-bottom:6px;">Focus Session Complete</div>
              <div style="font-weight:600;margin-bottom:4px;">${detail.task}</div>
              <div style="opacity:0.8;font-size:12px;">${detail.duration} min · ${detail.closes} distractions blocked</div>
              <div style="opacity:0.5;font-size:10px;margin-top:10px;">Click to dismiss</div>
            </div>`;
          host.addEventListener("click", () => host.remove());
          document.documentElement.appendChild(host);
          setTimeout(() => host.remove(), 8000);
        },
        args: [{ task: s.task, duration, closes: s.closesDuringSession || 0 }]
      });
    } catch {}
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "yt_metadata") {
    (async () => {
      const settings = await getSync();
      const pause = await getPauseState();
      const session = await getSessionState();
      const { meta } = msg;
      const result = await classifyVideo(meta, settings, session.active);

      await logDecision({
        kind: "youtube",
        videoId: meta.videoId,
        url: sender.tab?.url,
        title: meta.title,
        channel: meta.channel,
        isShort: meta.isShort,
        lengthSeconds: meta.lengthSeconds || 0,
        ...result
      });

      const shouldClose = result.verdict === "unproductive" && !pause.paused;
      sendResponse({ ok: true, result, willClose: shouldClose, paused: pause.paused });

      if (shouldClose && sender.tab?.id != null) {
        await closeAndNotify(sender.tab.id, {
          kind: "youtube",
          videoId: meta.videoId,
          url: sender.tab.url,
          title: meta.title,
          channel: meta.channel,
          lengthSeconds: meta.lengthSeconds || 0,
          reason: result.reason || ""
        });
      }
    })();
    return true;
  }

  if (msg?.type === "popup_action") {
    (async () => {
      const p = msg.payload || {};
      if (p.action === "reopen_video") {
        if (p.videoId) await addVideoOverride(p.videoId);
        if (p.url) await chrome.tabs.create({ url: p.url });
      } else if (p.action === "undo_user_flag") {
        if (p.videoId) {
          await removeVideoUserBlock(p.videoId);
          await addVideoOverride(p.videoId);
        }
        if (p.url) await chrome.tabs.create({ url: p.url });
      } else if (p.action === "reopen_once") {
        if (p.entry) await setOverride(p.entry, 60 * 1000);
        if (p.url) await chrome.tabs.create({ url: p.url });
      } else if (p.action === "unblock") {
        if (p.entry) await setOverride(p.entry, p.durationMs);
        if (p.url) await chrome.tabs.create({ url: p.url });
      } else if (p.action === "always_allow_channel") {
        const settings = await getSync();
        const list = settings.channelWhitelist || [];
        if (p.channel && !list.includes(p.channel)) {
          list.push(p.channel);
          await setSync({ channelWhitelist: list });
        }
        if (p.videoId) await addVideoOverride(p.videoId);
        if (p.url) await chrome.tabs.create({ url: p.url });
      } else if (p.action === "always_block_channel") {
        const settings = await getSync();
        const list = settings.channelBlocklist || [];
        if (p.channel && !list.includes(p.channel)) {
          list.push(p.channel);
          await setSync({ channelBlocklist: list });
        }
      } else if (p.action === "pause") {
        await setPauseState(p.durationMs, "popup");
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "get_dashboard") {
    (async () => {
      const [stats, pause, settings, meta, session, insights, log] = await Promise.all([
        getStats(),
        getPauseState(),
        getSync(),
        getOrInitInstallMeta(),
        getSessionState(),
        getInsightsCache(),
        getLog()
      ]);
      const suggestions = generateSuggestions(log, settings);
      const heatmap = buildHourHeatmap(log);
      sendResponse({ stats, pause, settings, installedAt: meta.installedAt, session, insights, suggestions, heatmap });
    })();
    return true;
  }

  if (msg?.type === "apply_suggestion") {
    (async () => {
      const a = msg.action || {};
      if (a.type === "add_channel_blocklist" && a.channel) {
        const settings = await getSync();
        const list = settings.channelBlocklist || [];
        if (!list.includes(a.channel)) {
          list.push(a.channel);
          await setSync({ channelBlocklist: list });
        }
      } else if (a.type === "add_channel_whitelist" && a.channel) {
        const settings = await getSync();
        const list = settings.channelWhitelist || [];
        if (!list.includes(a.channel)) {
          list.push(a.channel);
          await setSync({ channelWhitelist: list });
        }
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "start_session") {
    (async () => {
      const session = await startSession({
        durationMs: msg.durationMs || 25 * 60 * 1000,
        task: msg.task || "Deep work",
        strictBoost: msg.strictBoost !== false
      });
      chrome.alarms.create("session_end", { when: session.endsAt });
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (msg?.type === "end_session") {
    (async () => {
      chrome.alarms.clear("session_end");
      const s = await endSession();
      sendResponse({ ok: true, ended: s });
    })();
    return true;
  }

  if (msg?.type === "get_insights") {
    (async () => {
      const settings = await getSync();
      const existing = await getInsightsCache();
      if (!msg.force && existing && Date.now() - existing.generatedAt < 60 * 60 * 1000) {
        sendResponse({ ok: true, cached: true, insights: existing });
        return;
      }
      const log = await getLog();
      const result = await generateInsights(log, settings.apiKey);
      if (!result.error) await setInsightsCache(result);
      sendResponse({ ok: !result.error, insights: result });
    })();
    return true;
  }

  if (msg?.type === "get_log") {
    (async () => {
      const log = await getLog();
      sendResponse({ log });
    })();
    return true;
  }

  if (msg?.type === "clear_log") {
    (async () => { await clearLog(); sendResponse({ ok: true }); })();
    return true;
  }

  if (msg?.type === "set_settings") {
    (async () => {
      await setSync(msg.partial || {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "set_pause") {
    (async () => {
      await setPauseState(msg.durationMs, msg.reason || "manual");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "clear_video_cache") {
    (async () => {
      const items = await chrome.storage.local.get(null);
      const toRemove = Object.keys(items).filter((k) => k.startsWith("v:"));
      if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
      sendResponse({ ok: true, removed: toRemove.length });
    })();
    return true;
  }
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const parsed = parseUrl(details.url);
  if (!parsed) return;
  const { hostname, pathname } = parsed;
  if (isWorkWhitelisted(hostname)) return;

  const pause = await getPauseState();
  if (pause.paused) return;

  const settings = await getSync();
  const matchedEntry = findMatchingBlocklistEntry(hostname, pathname, settings.blocklist, settings.domainToggles);
  if (!matchedEntry) return;

  const override = await getMatchingOverride(hostname, pathname);
  if (override) return;

  await logDecision({
    kind: "blocklist",
    hostname,
    matchedEntry,
    url: details.url,
    verdict: "unproductive",
    reason: `"${matchedEntry}" is on blocklist`,
    source: "blocklist"
  });

  await closeAndNotify(details.tabId, {
    kind: "blocklist",
    hostname,
    matchedEntry,
    url: details.url,
    reason: `"${matchedEntry}" is on your blocklist`
  });
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  const parsed = parseYouTubeUrl(details.url);
  if (!parsed) return;
  chrome.tabs.sendMessage(details.tabId, { type: "yt_route_change", ...parsed }).catch(() => {});
}, { url: [{ hostSuffix: "youtube.com" }] });

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "mark-distracting") {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id == null || !tab.url) return;

    const parsed = parseYouTubeUrl(tab.url);
    const hostname = hostnameFromUrl(tab.url);

    let meta = {};
    if (parsed) {
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: "yt_get_meta" });
        if (resp?.meta) meta = resp.meta;
      } catch {}
      await addVideoUserBlock(parsed.videoId);
    }

    await logDecision({
      kind: "user_flag",
      videoId: parsed?.videoId,
      url: tab.url,
      hostname,
      title: meta.title || tab.title,
      channel: meta.channel,
      lengthSeconds: meta.lengthSeconds || 0,
      verdict: "unproductive",
      reason: "manually flagged by user",
      source: "user_flag"
    });

    await closeAndNotify(tab.id, {
      kind: "user_flag",
      videoId: parsed?.videoId,
      url: tab.url,
      title: meta.title || tab.title,
      channel: meta.channel,
      lengthSeconds: meta.lengthSeconds || 0,
      reason: parsed ? "you flagged this video — won't reopen unless you Undo" : "you flagged this tab as distracting"
    });
    return;
  }

  if (command === "toggle-pause") {
    const pause = await getPauseState();
    if (pause.paused) await setPauseState(0);
    else await setPauseState(60 * 60 * 1000, "shortcut");
  }
});
