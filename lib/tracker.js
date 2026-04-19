// Active-time tracker. Records elapsed milliseconds per hostname while:
//   • the tab is the active tab in its window
//   • the window is the focused Chrome window
//   • the user is not idle (chrome.idle threshold = 30s)
//
// Multi-monitor: Chrome has exactly ONE focused window across all displays.
// chrome.windows.onFocusChanged fires when focus moves between Chrome windows
// or to a non-Chrome window (WINDOW_ID_NONE). We just react — no display-
// specific code needed.
//
// Service-worker death resilience: state is persisted to chrome.storage.local
// after every transition, with a heartbeat so we can recover (or finalize) on
// wake. SW dies after 30s idle; on wake we check the heartbeat and credit at
// most that gap to the previous session before starting fresh.

import {
  getCurrentTrackerSession,
  setCurrentTrackerSession,
  commitDomainTime,
  bumpVisitCount,
  getDomainVerdict
} from "./storage.js";

const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_GAP_BEFORE_FINALIZE_MS = 60_000; // if the SW was dead longer than this, end the session there

let lastHeartbeatTimer = null;

function hostnameOf(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.toLowerCase();
  } catch { return null; }
}

function trackable(urlStr) {
  if (!urlStr) return false;
  return /^https?:\/\//i.test(urlStr);
}

function startHeartbeat() {
  if (lastHeartbeatTimer) clearInterval(lastHeartbeatTimer);
  lastHeartbeatTimer = setInterval(async () => {
    const s = await getCurrentTrackerSession();
    if (!s) return;
    s.lastHeartbeat = Date.now();
    await setCurrentTrackerSession(s);
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (lastHeartbeatTimer) { clearInterval(lastHeartbeatTimer); lastHeartbeatTimer = null; }
}

// Commit any in-flight time and clear the session. Caller must immediately
// `startSession` if they want to continue tracking another tab/domain.
export async function endCurrentSession({ at = Date.now(), reason = "" } = {}) {
  const s = await getCurrentTrackerSession();
  if (!s) { stopHeartbeat(); return null; }
  const delta = Math.max(0, at - s.startedAt);
  if (delta > 0 && s.hostname) await commitDomainTime(s.hostname, delta);
  await setCurrentTrackerSession(null);
  stopHeartbeat();
  return { hostname: s.hostname, deltaMs: delta, reason };
}

export async function startSession({ tabId, windowId, url, at = Date.now() }) {
  if (!trackable(url)) {
    // End any prior session but don't start a new one for non-trackable URLs
    await endCurrentSession({ at, reason: "non_trackable_url" });
    return null;
  }
  const hostname = hostnameOf(url);
  if (!hostname) {
    await endCurrentSession({ at, reason: "no_hostname" });
    return null;
  }

  // If we're already tracking the same tab+url, no-op (avoids double-counting
  // on duplicate events fired by Chrome).
  const existing = await getCurrentTrackerSession();
  if (existing && existing.tabId === tabId && existing.hostname === hostname && existing.windowId === windowId) {
    return existing;
  }

  // End the previous session (commits elapsed time for the previous hostname).
  if (existing) await endCurrentSession({ at, reason: "switch" });

  const session = {
    tabId,
    windowId,
    hostname,
    url,
    startedAt: at,
    lastHeartbeat: at
  };
  await setCurrentTrackerSession(session);
  await bumpVisitCount(hostname);
  startHeartbeat();
  return session;
}

// Recovery: on service-worker wake, if there's a stale session in storage,
// credit at most MAX_GAP_BEFORE_FINALIZE_MS to it and clear, so we don't
// lose the time the SW was alive but we also don't credit a 6-hour suspend.
export async function recoverFromSwDeath() {
  const s = await getCurrentTrackerSession();
  if (!s) return;
  const gap = Date.now() - (s.lastHeartbeat || s.startedAt);
  if (gap > MAX_GAP_BEFORE_FINALIZE_MS) {
    // Finalize at the last known heartbeat; assume the SW died there.
    await endCurrentSession({ at: s.lastHeartbeat || s.startedAt, reason: "sw_death" });
  } else {
    // Heartbeat fresh enough — keep going.
    startHeartbeat();
  }
}

// Public API used by service-worker.js wiring.
//
// Caller should compute the actual focused window/tab and pass them; this
// module doesn't query chrome.* directly to keep it side-effect-light and
// testable.

export async function onTabActivated({ tabId, windowId, url }) {
  await startSession({ tabId, windowId, url });
}

export async function onTabUpdated({ tabId, windowId, url }) {
  // Same tab, new URL (SPA nav, reload) → start a new session for the new host
  await startSession({ tabId, windowId, url });
}

export async function onTabClosed({ tabId }) {
  const s = await getCurrentTrackerSession();
  if (s && s.tabId === tabId) await endCurrentSession({ reason: "tab_closed" });
}

export async function onWindowFocusChanged({ focusedWindowId, focusedTab }) {
  // focusedWindowId === chrome.windows.WINDOW_ID_NONE → user switched to
  // a non-Chrome app → pause tracking
  if (focusedWindowId == null || focusedWindowId === -1) {
    await endCurrentSession({ reason: "chrome_unfocused" });
    return;
  }
  // Chrome regained focus on some window — start tracking its active tab
  if (focusedTab && trackable(focusedTab.url)) {
    await startSession({
      tabId: focusedTab.id,
      windowId: focusedWindowId,
      url: focusedTab.url
    });
  } else {
    // No trackable tab in the focused window
    await endCurrentSession({ reason: "no_active_tab" });
  }
}

export async function onIdleStateChanged({ state, focusedTab, focusedWindowId }) {
  if (state === "active") {
    // User came back. Start tracking the currently focused tab if there is one.
    if (focusedTab && trackable(focusedTab.url)) {
      await startSession({
        tabId: focusedTab.id,
        windowId: focusedWindowId,
        url: focusedTab.url
      });
    }
  } else {
    // "idle" or "locked" → stop accumulating
    await endCurrentSession({ reason: `idle_${state}` });
  }
}

// Helpers for the indicator + dashboard

export async function getCurrentSnapshot() {
  const s = await getCurrentTrackerSession();
  if (!s) return null;
  const elapsedMs = Date.now() - s.startedAt;
  return {
    hostname: s.hostname,
    url: s.url,
    tabId: s.tabId,
    windowId: s.windowId,
    elapsedMs,
    startedAt: s.startedAt
  };
}

// Read-through — checks current session + cached verdict
export async function getDomainStatus(hostname) {
  const verdict = await getDomainVerdict(hostname);
  const snap = await getCurrentSnapshot();
  return {
    hostname,
    verdict: verdict?.verdict || null,
    reason: verdict?.reason || "",
    confidence: verdict?.confidence ?? null,
    classifiedAt: verdict?.at || null,
    isCurrent: snap?.hostname === hostname,
    currentElapsedMs: snap?.hostname === hostname ? snap.elapsedMs : 0
  };
}
