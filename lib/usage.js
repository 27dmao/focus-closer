import { DEFAULT_MODEL, costForCall, projectAcrossModels } from "./pricing.js";

const USAGE_KEY = "usageLog";
const MAX_ENTRIES = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function logUsage({ model, usage }) {
  if (!usage) return;
  const costUsd = costForCall(usage, model || DEFAULT_MODEL);
  const entry = {
    at: Date.now(),
    model: model || DEFAULT_MODEL,
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
    costUsd
  };
  const res = await chrome.storage.local.get(USAGE_KEY);
  const log = res[USAGE_KEY] || [];
  log.push(entry);
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  await chrome.storage.local.set({ [USAGE_KEY]: log });
}

export async function getUsageLog() {
  const res = await chrome.storage.local.get(USAGE_KEY);
  return res[USAGE_KEY] || [];
}

export async function clearUsageLog() {
  await chrome.storage.local.remove(USAGE_KEY);
}

export async function getUsageStats() {
  const log = await getUsageLog();
  const now = Date.now();
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  let monthSpentUsd = 0;
  let callsThisMonth = 0;
  const tokens30d = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const perDayUsd = new Map(); // day-key → sum
  let earliest = now;

  for (const e of log) {
    if (e.at < earliest) earliest = e.at;
    if (e.at >= startOfMonth.getTime()) {
      monthSpentUsd += e.costUsd || 0;
      callsThisMonth += 1;
    }
    if (now - e.at <= 30 * DAY_MS) {
      tokens30d.input += e.input || 0;
      tokens30d.output += e.output || 0;
      tokens30d.cacheRead += e.cacheRead || 0;
      tokens30d.cacheWrite += e.cacheWrite || 0;
    }
    if (now - e.at <= 7 * DAY_MS) {
      const dayKey = Math.floor((now - e.at) / DAY_MS);
      perDayUsd.set(dayKey, (perDayUsd.get(dayKey) || 0) + (e.costUsd || 0));
    }
  }

  const dataDays = log.length === 0 ? 0 : Math.max(1, Math.ceil((now - earliest) / DAY_MS));
  const daysForAvg = Math.min(7, dataDays) || 1;
  let last7Sum = 0;
  for (let d = 0; d < daysForAvg; d++) last7Sum += perDayUsd.get(d) || 0;
  const dailyAvgUsd = log.length ? last7Sum / daysForAvg : 0;
  const projectedMonthlyUsd = dailyAvgUsd * 30;

  return {
    monthSpentUsd,
    callsThisMonth,
    dailyAvgUsd,
    projectedMonthlyUsd,
    tokens30d,
    dataDays
  };
}

// Per-model monthly projection using real token volumes from the last 30 days,
// scaled to a 30-day window if we have less data.
export async function projectPerModel() {
  const { tokens30d, dataDays } = await getUsageStats();
  if (!dataDays) return projectAcrossModels({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const scale = dataDays < 30 ? 30 / dataDays : 1;
  const scaled = {
    input: tokens30d.input * scale,
    output: tokens30d.output * scale,
    cacheRead: tokens30d.cacheRead * scale,
    cacheWrite: tokens30d.cacheWrite * scale
  };
  return projectAcrossModels(scaled);
}
