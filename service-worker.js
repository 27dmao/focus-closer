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
  getOrInitInstallMeta,
  getSessionState,
  startSession,
  endSession,
  incrementSessionCloseCount,
  recordFeedback,
  getFeedbackHistory,
  getUnreflectedCount,
  markReflected,
  REFLECTION_THRESHOLD,
  getPersonalPolicy,
  setPersonalPolicy,
  clearPersonalPolicy,
  getDomainTimeStats,
  getDomainVerdict,
  isDomainDismissed,
  dismissDomainIndicator,
  resetDismissedDomains,
  getAllDismissedDomains,
  isDomainKeepOpen,
  setDomainKeepOpen,
  getTrainingMode,
  startTrainingMode,
  endTrainingModeEarly,
  pruneOldBuckets,
  clearDomainVerdictCache
} from "./lib/storage.js";
import { logDecision, getStats, getLog, clearLog, removeLogEntry, getLogEntry, markLogEntryRefuted } from "./lib/logger.js";
import { classifyLocally } from "./classifier/rules.js";
import { classifyWithClaude, getDefaultSystemPrompt } from "./classifier/claude.js";
import { distillPolicy } from "./classifier/policy.js";
import { parseBrief } from "./classifier/brief.js";
import { classifyDomain } from "./classifier/domain.js";
import {
  onTabActivated as trackerOnTabActivated,
  onTabUpdated as trackerOnTabUpdated,
  onTabClosed as trackerOnTabClosed,
  onWindowFocusChanged as trackerOnWindowFocusChanged,
  onIdleStateChanged as trackerOnIdleStateChanged,
  recoverFromSwDeath as trackerRecoverFromSwDeath,
  getCurrentSnapshot as trackerCurrentSnapshot,
  getDomainStatus as trackerDomainStatus,
  onHeartbeatTick as trackerHeartbeatTick
} from "./lib/tracker.js";

chrome.runtime.onInstalled.addListener(async () => {
  getOrInitInstallMeta();
  await startTrainingMode();
  try { await chrome.storage.local.remove("trainingEndedNotified"); } catch {}
  try { chrome.idle.setDetectionInterval(30); } catch {}
  try { chrome.alarms.create("prune_buckets", { periodInMinutes: 24 * 60 }); } catch {}
  try { chrome.alarms.create("training_check", { periodInMinutes: 5 }); } catch {}
  try { chrome.alarms.create("tracker_heartbeat", { periodInMinutes: 0.5 }); } catch {}
});
chrome.runtime.onStartup.addListener(async () => {
  getOrInitInstallMeta();
  try { chrome.idle.setDetectionInterval(30); } catch {}
  try { chrome.alarms.create("prune_buckets", { periodInMinutes: 24 * 60 }); } catch {}
  try { chrome.alarms.create("training_check", { periodInMinutes: 5 }); } catch {}
  try { chrome.alarms.create("tracker_heartbeat", { periodInMinutes: 0.5 }); } catch {}
});

// Recover any in-flight tracker session left behind when the SW died.
trackerRecoverFromSwDeath().catch(() => {});

// Toolbar icon → open the options dashboard in a full tab. (Without this,
// or a default_popup, clicking the icon does nothing.)
chrome.action.onClicked.addListener(() => {
  try { chrome.runtime.openOptionsPage(); } catch (e) { console.warn("[focus-closer] open options failed", e); }
});

// ─── Tracker wiring: tab focus, window focus, idle, navigation ───────────────

async function activeFocusedTab() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal", "popup"] });
    if (!win || win.focused === false) return null;
    const tab = (win.tabs || []).find((t) => t.active);
    return tab ? { tab, windowId: win.id } : null;
  } catch { return null; }
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) await trackerOnTabActivated({ tabId, windowId, url: tab.url });
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only fire on URL changes for the *active* tab in the *focused* window.
  if (!changeInfo.url) return;
  if (!tab.active) return;
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (!win.focused) return;
  } catch { return; }
  await trackerOnTabUpdated({ tabId, windowId: tab.windowId, url: changeInfo.url });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await trackerOnTabClosed({ tabId });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await trackerOnWindowFocusChanged({ focusedWindowId: -1, focusedTab: null });
    return;
  }
  try {
    const win = await chrome.windows.get(windowId, { populate: true });
    const tab = (win.tabs || []).find((t) => t.active);
    await trackerOnWindowFocusChanged({ focusedWindowId: windowId, focusedTab: tab });
  } catch {}
});

chrome.idle.onStateChanged.addListener(async (state) => {
  const focused = await activeFocusedTab();
  await trackerOnIdleStateChanged({
    state,
    focusedTab: focused?.tab || null,
    focusedWindowId: focused?.windowId || null
  });
});

// ─── Universal domain classification on every committed navigation ───────────

const _classifyInflight = new Set(); // hostname-level dedup

async function classifyDomainAndMaybeClose({ tabId, hostname, pathname, url, title }) {
  if (!hostname || _classifyInflight.has(hostname)) return;
  _classifyInflight.add(hostname);
  try {
    const settings = await getSync();
    const policy = await getPersonalPolicy();
    const history = await getFeedbackHistory();

    const result = await classifyDomain({
      hostname, pathname, title: title || "", description: "",
      settings, policy, history
    });

    // Auto-close gating: only on high-confidence unproductive verdicts, only
    // when not in training mode, never for keep-open overrides, never for
    // YouTube (handled by per-video classifier).
    if (result.verdict !== "unproductive") return;
    if (result.source === "blocklist") return; // already handled by onBeforeNavigate
    if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) return;
    const training = await getTrainingMode();
    if (training.active) return;
    if (await isDomainKeepOpen(hostname)) return;
    if (typeof result.confidence === "number" && result.confidence < 0.85) return;
    if (tabId == null) return;

    await logDecision({
      kind: "domain_close",
      hostname,
      url,
      verdict: "unproductive",
      reason: result.reason || "",
      source: `domain_${result.source || "claude"}`
    });

    await closeAndNotify(tabId, {
      kind: "domain",
      hostname,
      url,
      reason: `"${hostname}" classified unproductive: ${result.reason || ""}`
    });
  } finally {
    _classifyInflight.delete(hostname);
  }
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const parsed = parseUrl(details.url);
  if (!parsed) return;
  const { hostname, pathname } = parsed;
  if (!hostname) return;
  // Skip our own pages and chrome internals
  if (details.url.startsWith("chrome://") || details.url.startsWith("chrome-extension://")) return;
  // Best-effort title fetch
  let title = "";
  try {
    const tab = await chrome.tabs.get(details.tabId);
    title = tab.title || "";
  } catch {}
  classifyDomainAndMaybeClose({ tabId: details.tabId, hostname, pathname, url: details.url, title }).catch(() => {});
});

// Run a policy reflection if the user has accumulated enough new feedback
// since the last reflection. Idempotent and cheap to call. Always returns
// the (possibly updated) policy.
async function maybeRunReflection({ force = false } = {}) {
  const settings = await getSync();
  if (!settings.apiKey) return { error: "no_api_key", reason: "Add your Anthropic API key on the Rules tab." };

  const unreflected = await getUnreflectedCount();
  if (!force && unreflected < REFLECTION_THRESHOLD) {
    return await getPersonalPolicy() || { error: "below_threshold", reason: `Need ${REFLECTION_THRESHOLD} new feedback signals; you have ${unreflected}.` };
  }

  const history = await getFeedbackHistory();
  const result = await distillPolicy(history, settings.apiKey);
  if (result.error) {
    console.warn("[focus-closer] reflection failed:", result.error, result.reason);
    return result;
  }
  await setPersonalPolicy(result);
  await markReflected();
  return result;
}

// Helper to also record a feedback signal whenever any X/S action happens —
// then opportunistically kick off a reflection in the background.
async function recordAndMaybeReflect(verdict, entry) {
  await recordFeedback(verdict, entry);
  // Fire-and-forget reflection. Doesn't block the caller.
  maybeRunReflection().catch((e) => console.warn("[focus-closer] reflection bg error:", e));
}

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

  const history = await getFeedbackHistory();
  const policy = await getPersonalPolicy();
  const remote = await classifyWithClaude(meta, settings, history, policy);
  if (remote.verdict) {
    // Strict-mode confidence threshold: if Claude says "productive" with anything
    // less than high confidence, treat as unproductive. The whole product is
    // strict-leaning — ambiguous productive verdicts should default to close.
    // Sessions push the bar even higher.
    const minConfidence = sessionActive ? 0.9 : 0.85;
    if (remote.verdict === "productive" && remote.confidence < minConfidence) {
      const flipped = {
        ...remote,
        verdict: "unproductive",
        reason: `low-confidence productive (${remote.confidence.toFixed(2)}: ${remote.reason}) — borderline defaults to close`,
        source: sessionActive ? "session_boost" : "low_confidence_flip"
      };
      await setVerdictInCache(meta.videoId, flipped);
      return flipped;
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
  return function renderPopup(detail, nonce) {
    const EXISTING_ID = "__focus_closer_popup__";
    const prev = document.getElementById(EXISTING_ID);
    if (prev) prev.remove();

    const isYt = detail.kind === "youtube";
    const isUserFlag = detail.kind === "user_flag";
    const isDomain = detail.kind === "domain";
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
    header.textContent = isUserFlag ? "Flagged as distracting"
      : isYt ? "Closed YouTube video"
      : isDomain ? `Closed ${detail.hostname}`
      : `Closed ${detail.matchedEntry || detail.hostname}`;
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
        chrome.runtime.sendMessage({ type: "popup_action", payload, nonce });
        cleanup();
      });
      return b;
    }

    if (isUserFlag) {
      actions.appendChild(mkBtn("Undo", { action: "undo_user_flag", videoId: detail.videoId, url: detail.url, channel: detail.channelAutoBlocked ? detail.channel : null }, true));
    } else if (isYt) {
      actions.appendChild(mkBtn("Reopen (false positive)", { action: "reopen_video", videoId: detail.videoId, url: detail.url }, true));
      if (detail.channel) {
        actions.appendChild(mkBtn(`Always allow "${detail.channel}"`, { action: "always_allow_channel", channel: detail.channel, videoId: detail.videoId, url: detail.url }));
      }
    } else if (isDomain) {
      actions.appendChild(mkBtn("Keep open this time", { action: "keep_domain_open", hostname: detail.hostname, url: detail.url, durationMs: 60 * 60 * 1000 }, true));
      actions.appendChild(mkBtn("Keep open today", { action: "keep_domain_open", hostname: detail.hostname, url: detail.url, durationMs: 24 * 60 * 60 * 1000 }));
      actions.appendChild(mkBtn("Always keep open", { action: "keep_domain_open", hostname: detail.hostname, url: detail.url, durationMs: null }));
    } else {
      const entry = detail.matchedEntry || detail.hostname;
      actions.appendChild(mkBtn("Reopen 60s", { action: "reopen_once", entry, url: detail.url }, true));
      actions.appendChild(mkBtn("Unblock 30 min", { action: "unblock", entry, url: detail.url, durationMs: 30 * 60 * 1000 }));
      actions.appendChild(mkBtn("Unblock today", { action: "unblock", entry, url: detail.url, durationMs: 24 * 60 * 60 * 1000 }));
      actions.appendChild(mkBtn("Unblock forever", { action: "unblock", entry, url: detail.url, durationMs: null }));
    }
    card.appendChild(actions);

    const meta = document.createElement("div");
    meta.style.cssText = "margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);font-size:9px;opacity:0.5;text-align:center;";
    meta.textContent = "ESC to dismiss · hover to hold";
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
  const nonce = _issuePopupNonce(targetId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetId },
      func: popupRendererSource(),
      args: [detail, nonce],
      world: "ISOLATED"
    });
  } catch (e) {
    console.warn("[focus-closer] popup inject failed", e);
    _popupNonces.delete(targetId);
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

async function notifyTrainingEnded() {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "Training mode ended",
      message: "Focus Closer will now auto-close unproductive sites. You can keep any site open from the recovery popup."
    });
  } catch {}
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "tracker_heartbeat") {
    try { await trackerHeartbeatTick(); } catch (e) { console.warn("[focus-closer] heartbeat failed", e); }
    return;
  }
  if (alarm.name === "prune_buckets") {
    try { await pruneOldBuckets(); } catch (e) { console.warn("[focus-closer] prune failed", e); }
    return;
  }
  if (alarm.name === "training_check") {
    try {
      const t = await getTrainingMode();
      if (t && t.endsAt && !t.active) {
        const flag = await chrome.storage.local.get("trainingEndedNotified");
        if (!flag.trainingEndedNotified) {
          await notifyTrainingEnded();
          await chrome.storage.local.set({ trainingEndedNotified: true });
        }
      }
    } catch (e) { console.warn("[focus-closer] training_check failed", e); }
    return;
  }
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

// ─── Sender validation ───────────────────────────────────────────────────────
// Content scripts on attacker-controlled pages can call any chrome.runtime
// message handler. We validate sender by category:
//   - extension-only: caller must be our own extension page (no sender.tab,
//     and sender.id matches our extension)
//   - content-script + hostname-bound: sender.tab.url's hostname must match
//     the hostname in the message payload
//   - popup-action: caller must include the single-use nonce we generated when
//     injecting the popup into that specific tab
function isExtensionOriginated(sender) {
  // Messages from extension pages (options, popup) have no sender.tab and
  // sender.url starts with chrome-extension://<our-id>/
  if (sender?.tab) return false;
  if (sender?.id !== chrome.runtime.id) return false;
  return typeof sender.url === "string" && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

function senderHostname(sender) {
  try { return new URL(sender?.tab?.url || "").hostname.toLowerCase(); } catch { return null; }
}

function hostnameMatches(sender, claimed) {
  if (!claimed) return false;
  const h = senderHostname(sender);
  if (!h) return false;
  return h === String(claimed).toLowerCase();
}

// Single-use nonces for the injected popup. Map<tabId, nonce>; cleared on
// use or after a 60s timeout.
const _popupNonces = new Map();
function _issuePopupNonce(tabId) {
  const nonce = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36));
  _popupNonces.set(tabId, nonce);
  setTimeout(() => { if (_popupNonces.get(tabId) === nonce) _popupNonces.delete(tabId); }, 60_000);
  return nonce;
}
function _consumePopupNonce(tabId, nonce) {
  if (!tabId || !nonce) return false;
  if (_popupNonces.get(tabId) !== nonce) return false;
  _popupNonces.delete(tabId);
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "yt_metadata") {
    (async () => {
      const settings = await getSync();
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

      const shouldClose = result.verdict === "unproductive";
      sendResponse({ ok: true, result, willClose: shouldClose });

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
    // Single-use nonce: only the popup we just injected into this exact tab
    // can act on these privileged actions.
    if (!_consumePopupNonce(sender?.tab?.id, msg.nonce)) {
      sendResponse({ ok: false, error: "invalid_nonce" });
      return true;
    }
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
        // If the flag auto-blocked the channel, undo that too.
        if (p.channel) {
          const settings = await getSync();
          const list = (settings.channelBlocklist || []).filter((c) => c !== p.channel);
          await setSync({ channelBlocklist: list });
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
      } else if (p.action === "keep_domain_open") {
        if (p.hostname) await setDomainKeepOpen(p.hostname, p.durationMs ?? null);
        if (p.url) await chrome.tabs.create({ url: p.url });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "get_dashboard") {
    (async () => {
      const [stats, settings, meta, session, log, policy, history, unreflected, timeStats, training, snapshot] = await Promise.all([
        getStats(),
        getSync(),
        getOrInitInstallMeta(),
        getSessionState(),
        getLog(),
        getPersonalPolicy(),
        getFeedbackHistory(),
        getUnreflectedCount(),
        getDomainTimeStats(),
        getTrainingMode(),
        trackerCurrentSnapshot()
      ]);
      const heatmap = buildHourHeatmap(log);
      const feedbackCounts = {
        flags: history.flags?.length || 0,
        allows: history.allows?.length || 0,
        unreflected
      };
      // Resolve verdicts for all domains in timeStats so the dashboard can color them.
      // Read from cache only — don't trigger Claude calls just to render the dashboard.
      const domainVerdicts = {};
      const allHosts = new Set([
        ...Object.keys(timeStats.totals || {}),
        ...Object.values(timeStats.buckets || {}).flatMap((d) => Object.keys(d))
      ]);
      for (const host of allHosts) {
        if (host === "youtube.com" || host.endsWith(".youtube.com")) {
          domainVerdicts[host] = "mixed";
          continue;
        }
        if (isWorkWhitelisted(host)) { domainVerdicts[host] = "productive"; continue; }
        const cached = await getDomainVerdict(host);
        if (cached?.verdict) domainVerdicts[host] = cached.verdict;
      }
      sendResponse({
        stats, settings, installedAt: meta.installedAt, session, heatmap, policy, feedbackCounts,
        timeStats, domainVerdicts, training, snapshot
      });
    })();
    return true;
  }

  if (msg?.type === "get_indicator_state") {
    // Indicator content script asks about its own host — verify the claimed
    // hostname matches the sender's tab URL.
    if (!hostnameMatches(sender, msg.hostname)) {
      sendResponse({ ok: false, error: "hostname_mismatch" });
      return true;
    }
    (async () => {
      const hostname = msg.hostname || "";
      if (!hostname) { sendResponse({ ok: false }); return; }
      const dismissed = await isDomainDismissed(hostname);
      const status = await trackerDomainStatus(hostname);
      const stats = await getDomainTimeStats();
      const today = stats.buckets[(new Date().toISOString().slice(0, 10))] || {};
      const todayMs = today[hostname] || 0;
      const totalMs = stats.totals[hostname]?.totalMs || 0;
      sendResponse({
        ok: true,
        hostname,
        dismissed,
        verdict: status.verdict,
        reason: status.reason,
        confidence: status.confidence,
        todayMs,
        totalMs
      });
    })();
    return true;
  }

  if (msg?.type === "dismiss_indicator") {
    // Indicator content script dismisses its own dot — must match sender host.
    if (!hostnameMatches(sender, msg.hostname)) {
      sendResponse({ ok: false, error: "hostname_mismatch" });
      return true;
    }
    (async () => {
      await dismissDomainIndicator(msg.hostname);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "reset_dismissed_domains") {
    if (!isExtensionOriginated(sender)) { sendResponse({ ok: false, error: "forbidden" }); return true; }
    (async () => { await resetDismissedDomains(); sendResponse({ ok: true }); })();
    return true;
  }

  if (msg?.type === "end_training_mode") {
    if (!isExtensionOriginated(sender)) { sendResponse({ ok: false, error: "forbidden" }); return true; }
    (async () => { await endTrainingModeEarly(); sendResponse({ ok: true }); })();
    return true;
  }

  if (msg?.type === "clear_domain_verdict_cache") {
    if (!isExtensionOriginated(sender)) { sendResponse({ ok: false, error: "forbidden" }); return true; }
    (async () => {
      const removed = await clearDomainVerdictCache();
      sendResponse({ ok: true, removed });
    })();
    return true;
  }

  if (msg?.type === "keep_domain_open") {
    // Top-level keep_domain_open is for the options page only (not the popup —
    // popup uses popup_action which has its own nonce-based path).
    if (!isExtensionOriginated(sender)) { sendResponse({ ok: false, error: "forbidden" }); return true; }
    (async () => {
      if (msg.hostname) await setDomainKeepOpen(msg.hostname, msg.durationMs ?? null);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "run_reflection") {
    (async () => {
      const result = await maybeRunReflection({ force: true });
      const ok = !!(result && !result.error);
      sendResponse({ ok, policy: ok ? result : null, error: ok ? null : result });
    })();
    return true;
  }

  if (msg?.type === "clear_personal_policy") {
    (async () => {
      await clearPersonalPolicy();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "get_default_system_prompt") {
    (async () => {
      const settings = await getSync();
      sendResponse({ ok: true, prompt: getDefaultSystemPrompt(settings) });
    })();
    return true;
  }

  if (msg?.type === "apply_brief") {
    (async () => {
      const settings = await getSync();
      if (!settings.apiKey) {
        sendResponse({ ok: false, error: "no_api_key", reason: "Add an Anthropic API key on the Rules tab first." });
        return;
      }
      const result = await parseBrief(msg.text || "", settings.apiKey);
      if (result.error) {
        sendResponse({ ok: false, error: result.error, reason: result.reason });
        return;
      }

      const summary = { domainsAdded: [], channelsAdded: [], rulesAdded: 0, domainsRejected: [] };

      // Merge domains, skipping any that fall under the hardcoded work-whitelist.
      const blocklist = (settings.blocklist || []).slice();
      for (const raw of result.domains) {
        const d = String(raw || "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
        if (!d) continue;
        if (isWorkWhitelisted(d)) {
          summary.domainsRejected.push(d);
          continue;
        }
        if (!blocklist.includes(d)) {
          blocklist.push(d);
          summary.domainsAdded.push(d);
        }
      }

      // Merge YouTube channels.
      const channelBlocklist = (settings.channelBlocklist || []).slice();
      for (const c of result.youtube_channels) {
        const name = String(c || "").trim();
        if (name && !channelBlocklist.includes(name)) {
          channelBlocklist.push(name);
          summary.channelsAdded.push(name);
        }
      }

      if (summary.domainsAdded.length || summary.channelsAdded.length) {
        await setSync({ blocklist, channelBlocklist });
      }

      // Merge policy rules into the personal policy.
      if (result.policy_rules.length > 0) {
        const existing = await getPersonalPolicy();
        const existingRules = existing?.rules || [];
        const merged = [...existingRules];
        for (const r of result.policy_rules) {
          const rule = String(r || "").trim();
          if (!rule) continue;
          const norm = rule.toLowerCase();
          if (!merged.some((e) => e.toLowerCase() === norm)) {
            merged.push(rule);
            summary.rulesAdded += 1;
          }
        }
        await setPersonalPolicy({
          rules: merged.slice(0, 24),
          summary: existing?.summary || result.summary,
          feedbackCount: existing?.feedbackCount || 0,
          generatedAt: Date.now()
        });
      }

      sendResponse({ ok: true, summary, modelSummary: result.summary });
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

  if (msg?.type === "remove_log_entry") {
    (async () => {
      const res = await removeLogEntry(msg.at);
      sendResponse({ ok: true, ...res });
    })();
    return true;
  }

  if (msg?.type === "refute_log_entry") {
    (async () => {
      const entry = await getLogEntry(msg.at);
      if (!entry) { sendResponse({ ok: false, error: "not_found" }); return; }
      const isClose = entry.verdict === "unproductive" || entry.kind === "blocklist" || entry.kind === "user_flag";

      if (entry.kind === "youtube" || entry.kind === "user_flag") {
        if (!entry.videoId) { sendResponse({ ok: false, error: "no_video_id" }); return; }
        if (isClose) {
          // Wrongly closed — whitelist the video + the channel (if we have it)
          await removeVideoUserBlock(entry.videoId);
          await addVideoOverride(entry.videoId);
          if (entry.channel) {
            const settings = await getSync();
            const wl = settings.channelWhitelist || [];
            if (!wl.includes(entry.channel)) {
              wl.push(entry.channel);
              await setSync({ channelWhitelist: wl });
            }
          }
          if (entry.title) await recordAndMaybeReflect("productive", { title: entry.title, channel: entry.channel, videoId: entry.videoId });
          await markLogEntryRefuted(msg.at, "video_whitelisted");
          sendResponse({ ok: true, action: "video_whitelisted" });
        } else {
          // Wrongly kept — user-block the video + the channel (if we have it)
          await removeVideoOverride(entry.videoId);
          await addVideoUserBlock(entry.videoId);
          if (entry.channel) {
            const settings = await getSync();
            const bl = settings.channelBlocklist || [];
            if (!bl.includes(entry.channel)) {
              bl.push(entry.channel);
              await setSync({ channelBlocklist: bl });
            }
          }
          if (entry.title) await recordAndMaybeReflect("unproductive", { title: entry.title, channel: entry.channel, videoId: entry.videoId });
          await markLogEntryRefuted(msg.at, "video_blocked");
          sendResponse({ ok: true, action: "video_blocked" });
        }
        return;
      }

      if (entry.kind === "blocklist") {
        // Wrongly blocked — permanent override for the matched entry so future visits pass.
        if (entry.matchedEntry) await setOverride(entry.matchedEntry, null);
        await markLogEntryRefuted(msg.at, "domain_unblocked");
        sendResponse({ ok: true, action: "domain_unblocked" });
        return;
      }

      sendResponse({ ok: false, error: "unsupported_kind" });
    })();
    return true;
  }

  if (msg?.type === "set_settings") {
    (async () => {
      await setSync(msg.partial || {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "clear_video_cache") {
    (async () => {
      const items = await chrome.storage.local.get(null);
      const toRemove = Object.keys(items).filter((k) => k.startsWith("v:") || k.startsWith("v2:") || k.startsWith("v3:") || k.startsWith("v4:"));
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
    let channelAutoBlocked = false;
    if (parsed) {
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: "yt_get_meta" });
        if (resp?.meta) meta = resp.meta;
      } catch {}
      await addVideoUserBlock(parsed.videoId);

      // Generalize: if we know the channel and it isn't already on the blocklist,
      // add it. One flag of a Dream Minecraft video should kill all Dream videos.
      if (meta.channel) {
        const settings = await getSync();
        const list = settings.channelBlocklist || [];
        if (!list.includes(meta.channel)) {
          list.push(meta.channel);
          await setSync({ channelBlocklist: list });
          channelAutoBlocked = true;
        }
      }

      // Record this flag as a few-shot example for Claude. Future videos
      // that resemble this title's shape/topic/vibe will close even from
      // unfamiliar channels.
      await recordAndMaybeReflect("unproductive", { title: meta.title || tab.title, channel: meta.channel, videoId: parsed.videoId });
    } else if (tab.url) {
      // Non-YouTube tab: also a flagging signal. Record domain + title so the
      // policy reflection can derive cross-domain rules ("close any X-style
      // site"), and also auto-add the hostname to the blocklist.
      let domainAutoBlocked = false;
      const settings = await getSync();
      const list = settings.blocklist || [];
      if (!list.includes(hostname)) {
        list.push(hostname);
        await setSync({ blocklist: list });
        domainAutoBlocked = true;
      }
      await recordAndMaybeReflect("unproductive", { title: tab.title || hostname, hostname, url: tab.url });
      // Override the reason for the close popup since flow falls through to closeAndNotify
      meta.title = tab.title;
      // Replace the channel-based reason text below.
      meta._domainAutoBlocked = domainAutoBlocked;
    }

    const reason = !parsed
      ? (meta._domainAutoBlocked
          ? `flagged — also blocked "${hostname}" site-wide. Undo to revert.`
          : `flagged "${hostname}" — already on blocklist`)
      : channelAutoBlocked
        ? `flagged — also blocked channel "${meta.channel}". Undo to revert both.`
        : meta.channel
          ? `flagged — channel "${meta.channel}" already on blocklist`
          : "you flagged this video — won't reopen unless you Undo";

    await logDecision({
      kind: "user_flag",
      videoId: parsed?.videoId,
      url: tab.url,
      hostname,
      title: meta.title || tab.title,
      channel: meta.channel,
      lengthSeconds: meta.lengthSeconds || 0,
      verdict: "unproductive",
      reason: channelAutoBlocked ? `manually flagged by user (auto-blocked channel "${meta.channel}")` : "manually flagged by user",
      source: "user_flag"
    });

    await closeAndNotify(tab.id, {
      kind: "user_flag",
      videoId: parsed?.videoId,
      url: tab.url,
      title: meta.title || tab.title,
      channel: meta.channel,
      channelAutoBlocked,
      lengthSeconds: meta.lengthSeconds || 0,
      reason
    });
    return;
  }

  if (command === "mark-productive") {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

    // Helper to commit a "this is productive" decision: whitelist video + channel.
    async function commitAllow({ videoId, channel }) {
      let channelAdded = false, channelRemoved = false;
      if (videoId) {
        await removeVideoUserBlock(videoId);
        await addVideoOverride(videoId);
      }
      if (channel) {
        const settings = await getSync();
        const wl = settings.channelWhitelist || [];
        const blOriginal = settings.channelBlocklist || [];
        if (!wl.includes(channel)) { wl.push(channel); channelAdded = true; }
        const bl = blOriginal.filter((c) => c !== channel);
        if (bl.length !== blOriginal.length) channelRemoved = true;
        if (channelAdded || channelRemoved) {
          await setSync({ channelWhitelist: wl, channelBlocklist: bl });
        }
      }
      return { channelAdded, channelRemoved };
    }

    function buildAllowReason(channel, channelAdded, channelRemoved, mode) {
      if (mode === "undo") {
        if (channelAdded) return `restored — also whitelisted channel "${channel}"`;
        return "restored from recent close";
      }
      if (channelAdded) return `marked productive — whitelisted channel "${channel}"`;
      if (channelRemoved) return `marked productive — removed "${channel}" from blocklist`;
      return "marked productive";
    }

    async function showAllowToastOnTab(tabId, detail) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: (d) => {
            const ID = "__focus_closer_allow_toast__";
            const prev = document.getElementById(ID);
            if (prev) prev.remove();
            const host = document.createElement("div");
            host.id = ID;
            host.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:2147483647;font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;transform:translateY(6px) scale(0.98);opacity:0;transition:transform 220ms cubic-bezier(0.16,1,0.3,1),opacity 180ms ease-out;";
            const card = document.createElement("div");
            card.style.cssText = "background:#1e1e1e;color:#fff;padding:10px 12px;border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,0.45),0 2px 6px rgba(0,0,0,0.25);border-left:3px solid #3ecf8e;min-width:240px;max-width:340px;";
            const head = document.createElement("div");
            head.style.cssText = "font-weight:700;letter-spacing:0.4px;margin-bottom:4px;font-size:10px;opacity:0.8;text-transform:uppercase;";
            head.textContent = "Marked productive";
            card.appendChild(head);
            if (d.title) {
              const t = document.createElement("div");
              t.style.cssText = "font-weight:600;font-size:12px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;";
              t.textContent = d.title;
              card.appendChild(t);
            }
            if (d.channel) {
              const c = document.createElement("div");
              c.style.cssText = "opacity:0.65;font-size:11px;margin-top:1px;";
              c.textContent = d.channel;
              card.appendChild(c);
            }
            const r = document.createElement("div");
            r.style.cssText = "margin-top:4px;opacity:0.75;font-size:11px;line-height:1.35;";
            r.textContent = d.reason || "";
            card.appendChild(r);
            host.appendChild(card);
            document.documentElement.appendChild(host);
            requestAnimationFrame(() => { host.style.transform = "translateY(0) scale(1)"; host.style.opacity = "1"; });
            setTimeout(() => {
              host.style.transform = "translateY(6px) scale(0.98)";
              host.style.opacity = "0";
              setTimeout(() => host.remove(), 200);
            }, 3000);
          },
          args: [detail]
        });
      } catch {}
    }

    // Case 1 — active YouTube /watch tab: preemptive whitelist.
    if (tab && tab.url && parseYouTubeUrl(tab.url) && tab.id != null) {
      const parsed = parseYouTubeUrl(tab.url);
      let meta = {};
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: "yt_get_meta" });
        if (resp?.meta) meta = resp.meta;
      } catch {}
      const { channelAdded, channelRemoved } = await commitAllow({ videoId: parsed.videoId, channel: meta.channel });
      const reason = buildAllowReason(meta.channel, channelAdded, channelRemoved, "preempt");
      await recordAndMaybeReflect("productive", { title: meta.title || tab.title, channel: meta.channel, videoId: parsed.videoId });
      await logDecision({
        kind: "user_allow",
        videoId: parsed.videoId,
        url: tab.url,
        title: meta.title || tab.title,
        channel: meta.channel,
        verdict: "productive",
        reason,
        source: "user_allow"
      });
      await showAllowToastOnTab(tab.id, { title: meta.title || tab.title, channel: meta.channel, reason });
      return;
    }

    // Case 2 — recent close in the last 5 minutes: undo it.
    const log = await getLog();
    const FIVE_MIN = 5 * 60 * 1000;
    const recent = [...log].reverse().find((e) =>
      Date.now() - e.at < FIVE_MIN &&
      (e.verdict === "unproductive" || e.kind === "blocklist" || e.kind === "user_flag")
    );

    if (recent) {
      let reason;
      if (recent.kind === "blocklist" && recent.matchedEntry) {
        await setOverride(recent.matchedEntry, null);
        reason = `restored — "${recent.matchedEntry}" permanently unblocked`;
      } else {
        const { channelAdded } = await commitAllow({ videoId: recent.videoId, channel: recent.channel });
        reason = buildAllowReason(recent.channel, channelAdded, false, "undo");
      }
      if (recent.title || recent.hostname) {
        await recordAndMaybeReflect("productive", { title: recent.title, channel: recent.channel, videoId: recent.videoId, hostname: recent.hostname, url: recent.url });
      }
      await logDecision({
        kind: "user_allow",
        videoId: recent.videoId,
        url: recent.url,
        title: recent.title,
        channel: recent.channel,
        hostname: recent.hostname,
        verdict: "productive",
        reason,
        source: "user_allow"
      });
      const newTab = recent.url ? await chrome.tabs.create({ url: recent.url }) : null;
      if (newTab?.id != null) {
        // After the page loads, show the confirmation toast there.
        const tabId = newTab.id;
        const cleanup = () => { try { chrome.tabs.onUpdated.removeListener(listener); } catch {} };
        // Fallback timeout: if the tab never reaches "complete" (closed first,
        // navigation aborted, SW dies and respawns) the listener would otherwise
        // sit registered for the rest of this SW's life.
        const fallback = setTimeout(cleanup, 30_000);
        function listener(updatedId, info) {
          if (updatedId !== tabId || info.status !== "complete") return;
          clearTimeout(fallback);
          cleanup();
          showAllowToastOnTab(tabId, { title: recent.title, channel: recent.channel, reason });
        }
        chrome.tabs.onUpdated.addListener(listener);
      }
      return;
    }

    // Case 3 — nothing to act on.
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: "Focus Closer",
        message: "Nothing to mark productive — open a YouTube video first, or use within 5 minutes of a close."
      });
    } catch {}
  }
});
