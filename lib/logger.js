import { estimateSecondsSaved } from "./storage.js";

const LOG_KEY = "decisionLog";
const MAX_ENTRIES = 1000;

export async function logDecision(entry) {
  const full = { at: Date.now(), ...entry };
  const res = await chrome.storage.local.get(LOG_KEY);
  const log = res[LOG_KEY] || [];
  log.push(full);
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  await chrome.storage.local.set({ [LOG_KEY]: log });
  console.log("[focus-closer]", full);
}

export async function getLog() {
  const res = await chrome.storage.local.get(LOG_KEY);
  return res[LOG_KEY] || [];
}

export async function clearLog() {
  await chrome.storage.local.remove(LOG_KEY);
}

export async function removeLogEntry(at) {
  const res = await chrome.storage.local.get(LOG_KEY);
  const log = res[LOG_KEY] || [];
  const filtered = log.filter((e) => e.at !== at);
  await chrome.storage.local.set({ [LOG_KEY]: filtered });
  return { removed: log.length - filtered.length };
}

export async function getLogEntry(at) {
  const res = await chrome.storage.local.get(LOG_KEY);
  const log = res[LOG_KEY] || [];
  return log.find((e) => e.at === at) || null;
}

export async function markLogEntryRefuted(at, action) {
  const res = await chrome.storage.local.get(LOG_KEY);
  const log = res[LOG_KEY] || [];
  const entry = log.find((e) => e.at === at);
  if (!entry) return false;
  entry.refutedAt = Date.now();
  entry.refuteAction = action || "refuted";
  await chrome.storage.local.set({ [LOG_KEY]: log });
  return true;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getStats() {
  const log = await getLog();
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const stats = {
    totalClosed: 0,
    totalSecondsSaved: 0,
    closedToday: 0,
    closedLast7: 0,
    secondsSavedToday: 0,
    secondsSavedLast7: 0,
    bySource: { blocklist: 0, claude: 0, cache: 0, rule: 0, user_flag: 0, user_block: 0, override: 0, other: 0 },
    byKind: { blocklist: 0, youtube: 0, user_flag: 0 },
    recentFalsePositives: 0,
    perDayLast7: Array.from({ length: 7 }, (_, i) => ({
      dayOffset: 6 - i,
      closed: 0,
      secondsSaved: 0
    }))
  };

  for (const e of log) {
    const isClose = (e.verdict === "unproductive") || e.kind === "blocklist" || e.kind === "user_flag";
    if (!isClose) continue;

    stats.totalClosed += 1;
    const saved = estimateSecondsSaved(e);
    stats.totalSecondsSaved += saved;

    const src = e.source || "other";
    if (stats.bySource[src] !== undefined) stats.bySource[src] += 1;
    else stats.bySource.other += 1;

    if (stats.byKind[e.kind] !== undefined) stats.byKind[e.kind] += 1;

    if (e.at >= startOfToday.getTime()) {
      stats.closedToday += 1;
      stats.secondsSavedToday += saved;
    }
    if (now - e.at <= 7 * DAY_MS) {
      stats.closedLast7 += 1;
      stats.secondsSavedLast7 += saved;

      const dayOffset = Math.floor((now - e.at) / DAY_MS);
      if (dayOffset >= 0 && dayOffset < 7) {
        const bucket = stats.perDayLast7[6 - dayOffset];
        bucket.closed += 1;
        bucket.secondsSaved += saved;
      }
    }
  }

  return stats;
}
