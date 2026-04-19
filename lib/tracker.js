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

// Heartbeat interval is enforced by chrome.alarms (registered in service-worker.js
// as "tracker_heartbeat", periodInMinutes: 0.5 = 30s minimum granted by the API).
// MV3 SWs terminate setInterval timers on idle, so we cannot rely on JS timers
// to keep the heartbeat alive — only alarms persist across SW restarts.
const HEARTBEAT_ALARM = "tracker_heartbeat";
const MAX_GAP_BEFORE_FINALIZE_MS = 90_000; // 30s alarm cadence + grace

// ─── Single-writer serialization ─────────────────────────────────────────────
// chrome.storage.local writes are atomic per-call but get→modify→set is not.
// All writes flow through this in-SW promise chain, plus an init promise so
// recovery completes before any event handler runs.
let _initPromise = null;
let _writeChain = Promise.resolve();

function _runRecovery() {
  return (async () => {
    const s = await getCurrentTrackerSession();
    if (!s) return;
    const gap = Date.now() - (s.lastHeartbeat || s.startedAt);
    if (gap > MAX_GAP_BEFORE_FINALIZE_MS) {
      // SW was dead — credit time only up to the last heartbeat.
      const at = s.lastHeartbeat || s.startedAt;
      const delta = Math.max(0, at - s.startedAt);
      if (delta > 0 && s.hostname) await commitDomainTime(s.hostname, delta);
      await setCurrentTrackerSession(null);
    }
    // else: recent heartbeat → keep the session as-is, the next event handler
    // will reconcile it via startSession's tab-equality check.
  })().catch((e) => { console.warn("[tracker] recovery failed", e); });
}

function ensureInitialized() {
  if (!_initPromise) _initPromise = _runRecovery();
  return _initPromise;
}

function withLock(fn) {
  const next = _writeChain.then(fn, fn);
  _writeChain = next.catch(() => {});
  return next;
}

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

// Called from service-worker.js's chrome.alarms.onAlarm listener when the
// HEARTBEAT_ALARM fires. Bumps lastHeartbeat on whatever session is in storage.
// Goes through the same write-chain as other tracker mutations so it can't
// resurrect a session that was just nulled by a focus-change event.
export async function onHeartbeatTick() {
  await ensureInitialized();
  return withLock(async () => {
    const s = await getCurrentTrackerSession();
    if (!s) return;
    s.lastHeartbeat = Date.now();
    await setCurrentTrackerSession(s);
  });
}

// Commit any in-flight time and clear the session. Caller must immediately
// `startSession` if they want to continue tracking another tab/domain.
export async function endCurrentSession({ at = Date.now(), reason = "" } = {}) {
  const s = await getCurrentTrackerSession();
  if (!s) return null;
  const delta = Math.max(0, at - s.startedAt);
  if (delta > 0 && s.hostname) await commitDomainTime(s.hostname, delta);
  await setCurrentTrackerSession(null);
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
  return session;
}

// Public recovery hook (called from SW startup/install). Idempotent — first
// call kicks off recovery, subsequent calls await the same promise.
export function recoverFromSwDeath() {
  return ensureInitialized();
}

// Public API used by service-worker.js wiring. All entry points await
// ensureInitialized() so recovery completes before any new event mutates
// state, and serialize through withLock() so chrome.storage.local writes
// don't interleave.

export async function onTabActivated({ tabId, windowId, url }) {
  await ensureInitialized();
  return withLock(() => startSession({ tabId, windowId, url }));
}

export async function onTabUpdated({ tabId, windowId, url }) {
  // Same tab, new URL (SPA nav, reload) → start a new session for the new host
  await ensureInitialized();
  return withLock(() => startSession({ tabId, windowId, url }));
}

export async function onTabClosed({ tabId }) {
  await ensureInitialized();
  return withLock(async () => {
    const s = await getCurrentTrackerSession();
    if (s && s.tabId === tabId) await endCurrentSession({ reason: "tab_closed" });
  });
}

export async function onWindowFocusChanged({ focusedWindowId, focusedTab }) {
  await ensureInitialized();
  return withLock(async () => {
    if (focusedWindowId == null || focusedWindowId === -1) {
      await endCurrentSession({ reason: "chrome_unfocused" });
      return;
    }
    if (focusedTab && trackable(focusedTab.url)) {
      await startSession({
        tabId: focusedTab.id,
        windowId: focusedWindowId,
        url: focusedTab.url
      });
    } else {
      await endCurrentSession({ reason: "no_active_tab" });
    }
  });
}

export async function onIdleStateChanged({ state, focusedTab, focusedWindowId }) {
  await ensureInitialized();
  return withLock(async () => {
    if (state === "active") {
      if (focusedTab && trackable(focusedTab.url)) {
        await startSession({
          tabId: focusedTab.id,
          windowId: focusedWindowId,
          url: focusedTab.url
        });
      }
    } else {
      await endCurrentSession({ reason: `idle_${state}` });
    }
  });
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
