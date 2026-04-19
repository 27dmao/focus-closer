import { DEFAULT_MODEL } from "./pricing.js";

const SYNC_DEFAULTS = {
  apiKey: "",
  musicRule: "instrumental_only",
  onboardingComplete: false,
  strictLevel: "strict",
  classifierModel: DEFAULT_MODEL,
  monthlyBudgetUsd: 5,
  customSystemPrompt: "",
  channelWhitelist: [
    "3Blue1Brown",
    "Khan Academy",
    "MIT OpenCourseWare",
    "CrashCourse",
    "Veritasium",
    "Kurzgesagt – In a Nutshell",
    "Two Minute Papers",
    "Computerphile"
  ],
  channelBlocklist: [],
  blocklist: [
    "instagram.com",
    "x.com",
    "twitter.com",
    "facebook.com",
    "tiktok.com",
    "reddit.com",
    "linkedin.com/feed",
    "linkedin.com/notifications"
  ],
  domainToggles: {
    "x.com": true,
    "twitter.com": true,
    "linkedin.com": true
  }
};

// Universal work tools that should NEVER be auto-added to a blocklist by the
// AI parser. Users can still manually block any of these via the Rules tab,
// but a misinterpreted natural-language brief won't accidentally lock them
// out of email, calendar, or AI assistants.
const HARDCODED_WORK_WHITELIST = [
  // Google Workspace
  "google.com",
  "docs.google.com",
  "mail.google.com",
  "calendar.google.com",
  "drive.google.com",
  "meet.google.com",
  "accounts.google.com",
  // Microsoft Workspace
  "outlook.office.com",
  "outlook.live.com",
  "office.com",
  // AI assistants
  "claude.ai",
  "chatgpt.com",
  "gemini.google.com",
  // Developer tools
  "github.com",
  "gitlab.com",
  "stackoverflow.com",
  // Knowledge work
  "notion.so",
  "slack.com",
  "linear.app",
  "atlassian.com",
  "figma.com"
];

const VIDEO_OVERRIDES_KEY = "videoOverrides";
const DOMAIN_OVERRIDES_KEY = "domainOverrides";
const VIDEO_USER_BLOCK_KEY = "videoUserBlocks";
const INSTALL_META_KEY = "installMeta";
const SESSION_STATE_KEY = "sessionState";
const FEEDBACK_HISTORY_KEY = "feedbackHistory";
const FEEDBACK_HISTORY_MAX = 200;
const PERSONAL_POLICY_KEY = "personalPolicy";
const REFLECTION_TRIGGER_THRESHOLD = 5;

const BLOCKLIST_CLOSE_SECONDS_ESTIMATE = 300;

export async function getSync() {
  return chrome.storage.sync.get(SYNC_DEFAULTS);
}

export async function setSync(partial) {
  await chrome.storage.sync.set(partial);
}

export function isWorkWhitelisted(hostname) {
  const h = hostname.toLowerCase();
  return HARDCODED_WORK_WHITELIST.some(
    (wl) => h === wl || h.endsWith("." + wl)
  );
}

// Cache key prefix bumps when classifier prompt changes meaningfully — old
// entries (which may carry verdicts from a weaker prompt) become unreachable
// and re-classify on next visit.
const CACHE_KEY_PREFIX = "v4:";

export async function getVerdictFromCache(videoId) {
  const key = CACHE_KEY_PREFIX + videoId;
  const res = await chrome.storage.local.get(key);
  const entry = res[key];
  if (!entry) return null;
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - entry.at > THIRTY_DAYS) return null;
  return entry.verdict;
}

export async function setVerdictInCache(videoId, verdict) {
  await chrome.storage.local.set({
    [CACHE_KEY_PREFIX + videoId]: { verdict, at: Date.now() }
  });
}

export async function isVideoOverridden(videoId) {
  const res = await chrome.storage.local.get(VIDEO_OVERRIDES_KEY);
  const list = res[VIDEO_OVERRIDES_KEY] || [];
  return list.includes(videoId);
}

export async function addVideoOverride(videoId) {
  const res = await chrome.storage.local.get(VIDEO_OVERRIDES_KEY);
  const list = res[VIDEO_OVERRIDES_KEY] || [];
  if (!list.includes(videoId)) {
    list.push(videoId);
    await chrome.storage.local.set({ [VIDEO_OVERRIDES_KEY]: list });
  }
}

export function parseBlocklistEntry(entry) {
  const e = entry.trim().toLowerCase();
  const slashIdx = e.indexOf("/");
  if (slashIdx === -1) return { domain: e, path: null };
  const domain = e.slice(0, slashIdx);
  let path = e.slice(slashIdx);
  while (path.endsWith("/")) path = path.slice(0, -1);
  if (path === "") return { domain, path: null };
  return { domain, path };
}

export function entryMatchesUrl(entry, hostname, pathname) {
  const { domain, path } = parseBlocklistEntry(entry);
  const h = hostname.toLowerCase();
  const hostMatches = h === domain || h.endsWith("." + domain);
  if (!hostMatches) return false;
  if (path === null) return true;
  let pn = pathname;
  while (pn.endsWith("/") && pn.length > 1) pn = pn.slice(0, -1);
  return pn === path || pn.startsWith(path + "/");
}

export async function getMatchingOverride(hostname, pathname) {
  const res = await chrome.storage.local.get(DOMAIN_OVERRIDES_KEY);
  const map = res[DOMAIN_OVERRIDES_KEY] || {};
  for (const [entry, meta] of Object.entries(map)) {
    if (!entryMatchesUrl(entry, hostname, pathname)) continue;
    if (meta.expiresAt === null || meta.expiresAt > Date.now()) return { entry, ...meta };
  }
  return null;
}

export async function setOverride(entry, durationMs) {
  const res = await chrome.storage.local.get(DOMAIN_OVERRIDES_KEY);
  const map = res[DOMAIN_OVERRIDES_KEY] || {};
  map[entry.toLowerCase()] = {
    expiresAt: durationMs === null ? null : Date.now() + durationMs,
    setAt: Date.now()
  };
  await chrome.storage.local.set({ [DOMAIN_OVERRIDES_KEY]: map });
}

export async function getAllOverrides() {
  const res = await chrome.storage.local.get(DOMAIN_OVERRIDES_KEY);
  return res[DOMAIN_OVERRIDES_KEY] || {};
}

export async function isVideoUserBlocked(videoId) {
  const res = await chrome.storage.local.get(VIDEO_USER_BLOCK_KEY);
  const list = res[VIDEO_USER_BLOCK_KEY] || [];
  return list.includes(videoId);
}

export async function addVideoUserBlock(videoId) {
  const res = await chrome.storage.local.get(VIDEO_USER_BLOCK_KEY);
  const list = res[VIDEO_USER_BLOCK_KEY] || [];
  if (!list.includes(videoId)) {
    list.push(videoId);
    await chrome.storage.local.set({ [VIDEO_USER_BLOCK_KEY]: list });
  }
}

export async function removeVideoUserBlock(videoId) {
  const res = await chrome.storage.local.get(VIDEO_USER_BLOCK_KEY);
  const list = (res[VIDEO_USER_BLOCK_KEY] || []).filter((v) => v !== videoId);
  await chrome.storage.local.set({ [VIDEO_USER_BLOCK_KEY]: list });
}

export async function removeVideoOverride(videoId) {
  const res = await chrome.storage.local.get(VIDEO_OVERRIDES_KEY);
  const list = (res[VIDEO_OVERRIDES_KEY] || []).filter((v) => v !== videoId);
  await chrome.storage.local.set({ [VIDEO_OVERRIDES_KEY]: list });
}

// Feedback history is the user's recent X/S keypresses, used as personalized
// few-shot examples in the Claude prompt. Each press teaches the classifier
// not just one channel but a SHAPE of preference — so flagging one Minecraft
// video makes Claude recognize all gaming/MrBeast-style content next time.
export async function recordFeedback(verdict, entry) {
  // Title OR hostname must be present so the reflection pass has something
  // semantic to learn from. Cross-domain flags pass hostname (no title).
  if (!entry.title && !entry.hostname) return;
  const res = await chrome.storage.local.get(FEEDBACK_HISTORY_KEY);
  const history = res[FEEDBACK_HISTORY_KEY] || { flags: [], allows: [], unreflectedSince: 0 };
  const list = verdict === "unproductive" ? history.flags : history.allows;
  const dedupKey = entry.videoId || entry.url || entry.hostname;
  const filtered = dedupKey ? list.filter((e) => (e.videoId || e.url || e.hostname) !== dedupKey) : list;
  filtered.push({
    at: Date.now(),
    title: entry.title || "",
    channel: entry.channel || "",
    videoId: entry.videoId || "",
    hostname: entry.hostname || "",
    url: entry.url || ""
  });
  if (filtered.length > FEEDBACK_HISTORY_MAX) filtered.splice(0, filtered.length - FEEDBACK_HISTORY_MAX);
  if (verdict === "unproductive") history.flags = filtered;
  else history.allows = filtered;
  history.unreflectedSince = (history.unreflectedSince || 0) + 1;
  await chrome.storage.local.set({ [FEEDBACK_HISTORY_KEY]: history });
}

export async function getUnreflectedCount() {
  const res = await chrome.storage.local.get(FEEDBACK_HISTORY_KEY);
  return res[FEEDBACK_HISTORY_KEY]?.unreflectedSince || 0;
}

export async function markReflected() {
  const res = await chrome.storage.local.get(FEEDBACK_HISTORY_KEY);
  const history = res[FEEDBACK_HISTORY_KEY] || { flags: [], allows: [] };
  history.unreflectedSince = 0;
  await chrome.storage.local.set({ [FEEDBACK_HISTORY_KEY]: history });
}

export const REFLECTION_THRESHOLD = REFLECTION_TRIGGER_THRESHOLD;

export async function getPersonalPolicy() {
  const res = await chrome.storage.local.get(PERSONAL_POLICY_KEY);
  return res[PERSONAL_POLICY_KEY] || null;
}

export async function setPersonalPolicy(policy) {
  await chrome.storage.local.set({
    [PERSONAL_POLICY_KEY]: { ...policy, updatedAt: Date.now() }
  });
}

export async function clearPersonalPolicy() {
  await chrome.storage.local.remove(PERSONAL_POLICY_KEY);
}

export async function getFeedbackHistory() {
  const res = await chrome.storage.local.get(FEEDBACK_HISTORY_KEY);
  return res[FEEDBACK_HISTORY_KEY] || { flags: [], allows: [] };
}

export async function getOrInitInstallMeta() {
  const res = await chrome.storage.local.get(INSTALL_META_KEY);
  if (res[INSTALL_META_KEY]) return res[INSTALL_META_KEY];
  const meta = { installedAt: Date.now() };
  await chrome.storage.local.set({ [INSTALL_META_KEY]: meta });
  return meta;
}

export async function getSessionState() {
  const res = await chrome.storage.local.get(SESSION_STATE_KEY);
  const s = res[SESSION_STATE_KEY];
  if (!s || !s.active) return { active: false };
  if (s.endsAt && s.endsAt <= Date.now()) {
    return { active: false, justEnded: s };
  }
  return { active: true, ...s };
}

export async function startSession({ durationMs, task, strictBoost }) {
  const state = {
    active: true,
    startedAt: Date.now(),
    endsAt: Date.now() + durationMs,
    task: task || "Deep work",
    strictBoost: !!strictBoost,
    closesDuringSession: 0
  };
  await chrome.storage.local.set({ [SESSION_STATE_KEY]: state });
  return state;
}

export async function endSession() {
  const res = await chrome.storage.local.get(SESSION_STATE_KEY);
  const s = res[SESSION_STATE_KEY];
  await chrome.storage.local.remove(SESSION_STATE_KEY);
  return s;
}

export async function incrementSessionCloseCount() {
  const res = await chrome.storage.local.get(SESSION_STATE_KEY);
  const s = res[SESSION_STATE_KEY];
  if (!s || !s.active) return;
  s.closesDuringSession = (s.closesDuringSession || 0) + 1;
  await chrome.storage.local.set({ [SESSION_STATE_KEY]: s });
}

// ─── Universal time tracking + per-domain verdict cache ──────────────────────

const DOMAIN_TIME_KEY = "domainTimeTracking";   // { hostname: { totalMs, visitCount, lastSeenAt } }
const DOMAIN_BUCKETS_KEY = "domainTimeBuckets"; // { "YYYY-MM-DD": { hostname: ms, ... } }
const CURRENT_SESSION_KEY = "tracker:currentSession"; // active accumulation
const DOMAIN_VERDICT_PREFIX = "dv:";           // dv:<hostname> → { verdict, reason, confidence, at }
const DOMAIN_VERDICT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DISMISSED_DOMAINS_KEY = "dismissedDomains"; // [hostname, ...]
const DOMAIN_OPEN_OVERRIDES_KEY = "domainOpenOverrides"; // { hostname: until_ts | null }
const TRAINING_MODE_KEY = "trainingModeEndsAt"; // ts; before this, no auto-close on universal verdicts
const BUCKET_RETENTION_DAYS = 90;

export function todayBucketKey(at = Date.now()) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function getCurrentTrackerSession() {
  const res = await chrome.storage.local.get(CURRENT_SESSION_KEY);
  return res[CURRENT_SESSION_KEY] || null;
}

export async function setCurrentTrackerSession(s) {
  if (s == null) await chrome.storage.local.remove(CURRENT_SESSION_KEY);
  else await chrome.storage.local.set({ [CURRENT_SESSION_KEY]: s });
}

export async function commitDomainTime(hostname, deltaMs) {
  if (!hostname || !deltaMs || deltaMs <= 0) return;
  const cap = 4 * 60 * 60 * 1000; // 4h max single-accumulation safety cap
  const safe = Math.min(deltaMs, cap);
  const bucketKey = todayBucketKey();
  const res = await chrome.storage.local.get([DOMAIN_TIME_KEY, DOMAIN_BUCKETS_KEY]);
  const totals = res[DOMAIN_TIME_KEY] || {};
  const buckets = res[DOMAIN_BUCKETS_KEY] || {};
  const t = totals[hostname] || { totalMs: 0, visitCount: 0, lastSeenAt: 0 };
  t.totalMs += safe;
  t.lastSeenAt = Date.now();
  totals[hostname] = t;
  const day = buckets[bucketKey] || {};
  day[hostname] = (day[hostname] || 0) + safe;
  buckets[bucketKey] = day;
  await chrome.storage.local.set({ [DOMAIN_TIME_KEY]: totals, [DOMAIN_BUCKETS_KEY]: buckets });
}

export async function bumpVisitCount(hostname) {
  if (!hostname) return;
  const res = await chrome.storage.local.get(DOMAIN_TIME_KEY);
  const totals = res[DOMAIN_TIME_KEY] || {};
  const t = totals[hostname] || { totalMs: 0, visitCount: 0, lastSeenAt: 0 };
  t.visitCount += 1;
  t.lastSeenAt = Date.now();
  totals[hostname] = t;
  await chrome.storage.local.set({ [DOMAIN_TIME_KEY]: totals });
}

export async function getDomainTimeStats() {
  const res = await chrome.storage.local.get([DOMAIN_TIME_KEY, DOMAIN_BUCKETS_KEY]);
  return {
    totals: res[DOMAIN_TIME_KEY] || {},
    buckets: res[DOMAIN_BUCKETS_KEY] || {}
  };
}

export async function pruneOldBuckets() {
  const res = await chrome.storage.local.get(DOMAIN_BUCKETS_KEY);
  const buckets = res[DOMAIN_BUCKETS_KEY] || {};
  const cutoff = Date.now() - BUCKET_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffKey = todayBucketKey(cutoff);
  const kept = {};
  for (const [k, v] of Object.entries(buckets)) {
    if (k >= cutoffKey) kept[k] = v;
  }
  await chrome.storage.local.set({ [DOMAIN_BUCKETS_KEY]: kept });
}

// ─── Domain verdict cache ────────────────────────────────────────────────────

export async function getDomainVerdict(hostname) {
  const key = DOMAIN_VERDICT_PREFIX + hostname;
  const res = await chrome.storage.local.get(key);
  const entry = res[key];
  if (!entry) return null;
  if (Date.now() - entry.at > DOMAIN_VERDICT_TTL_MS) return null;
  return entry;
}

export async function setDomainVerdict(hostname, verdict) {
  const key = DOMAIN_VERDICT_PREFIX + hostname;
  await chrome.storage.local.set({ [key]: { ...verdict, at: Date.now() } });
}

export async function clearDomainVerdictCache() {
  const all = await chrome.storage.local.get(null);
  const remove = Object.keys(all).filter((k) => k.startsWith(DOMAIN_VERDICT_PREFIX));
  if (remove.length) await chrome.storage.local.remove(remove);
  return remove.length;
}

// ─── Indicator dismissed domains (per-profile, per-domain, forever) ──────────

export async function isDomainDismissed(hostname) {
  const res = await chrome.storage.local.get(DISMISSED_DOMAINS_KEY);
  const list = res[DISMISSED_DOMAINS_KEY] || [];
  return list.includes(hostname);
}

export async function dismissDomainIndicator(hostname) {
  const res = await chrome.storage.local.get(DISMISSED_DOMAINS_KEY);
  const list = res[DISMISSED_DOMAINS_KEY] || [];
  if (!list.includes(hostname)) {
    list.push(hostname);
    await chrome.storage.local.set({ [DISMISSED_DOMAINS_KEY]: list });
  }
}

export async function resetDismissedDomains() {
  await chrome.storage.local.remove(DISMISSED_DOMAINS_KEY);
}

export async function getAllDismissedDomains() {
  const res = await chrome.storage.local.get(DISMISSED_DOMAINS_KEY);
  return res[DISMISSED_DOMAINS_KEY] || [];
}

// ─── Per-domain "keep open" override (for non-YouTube auto-close recovery) ───

export async function isDomainKeepOpen(hostname) {
  const res = await chrome.storage.local.get(DOMAIN_OPEN_OVERRIDES_KEY);
  const map = res[DOMAIN_OPEN_OVERRIDES_KEY] || {};
  const entry = map[hostname];
  if (!entry) return false;
  if (entry.until === null) return true;
  return entry.until > Date.now();
}

export async function setDomainKeepOpen(hostname, durationMs) {
  const res = await chrome.storage.local.get(DOMAIN_OPEN_OVERRIDES_KEY);
  const map = res[DOMAIN_OPEN_OVERRIDES_KEY] || {};
  map[hostname] = { until: durationMs == null ? null : Date.now() + durationMs, at: Date.now() };
  await chrome.storage.local.set({ [DOMAIN_OPEN_OVERRIDES_KEY]: map });
}

// ─── Training mode (24h grace period before universal auto-close engages) ────

const TRAINING_MODE_DURATION_MS = 24 * 60 * 60 * 1000;

export async function getTrainingMode() {
  const res = await chrome.storage.local.get(TRAINING_MODE_KEY);
  const endsAt = res[TRAINING_MODE_KEY];
  if (!endsAt || typeof endsAt !== "number") return { active: false, endsAt: null };
  if (Date.now() >= endsAt) return { active: false, endsAt };
  return { active: true, endsAt };
}

export async function startTrainingMode(durationMs = TRAINING_MODE_DURATION_MS) {
  await chrome.storage.local.set({ [TRAINING_MODE_KEY]: Date.now() + durationMs });
}

export async function endTrainingModeEarly() {
  await chrome.storage.local.set({ [TRAINING_MODE_KEY]: Date.now() - 1 });
}

// ─────────────────────────────────────────────────────────────────────────────

export function estimateSecondsSaved(entry) {
  if (entry.kind === "youtube" || entry.kind === "user_flag") {
    const len = entry.lengthSeconds || 0;
    if (len > 0) return Math.min(len, 60 * 60);
    return 180;
  }
  if (entry.kind === "blocklist") {
    return BLOCKLIST_CLOSE_SECONDS_ESTIMATE;
  }
  return 0;
}
