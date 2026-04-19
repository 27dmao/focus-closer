const SYNC_DEFAULTS = {
  apiKey: "",
  musicRule: "instrumental_only",
  onboardingComplete: false,
  strictLevel: "strict",
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
  channelBlocklist: ["MrBeast", "MrBeast Gaming", "Beast Philanthropy"],
  blocklist: [
    "instagram.com",
    "x.com",
    "twitter.com",
    "facebook.com",
    "tiktok.com",
    "tikmate.cc",
    "reddit.com",
    "123movies.com",
    "linkedin.com/feed",
    "linkedin.com/in/davidmao1",
    "linkedin.com/notifications"
  ],
  domainToggles: {
    "x.com": true,
    "twitter.com": true,
    "linkedin.com": true
  }
};

const HARDCODED_WORK_WHITELIST = [
  "google.com",
  "docs.google.com",
  "mail.google.com",
  "calendar.google.com",
  "drive.google.com",
  "meet.google.com",
  "accounts.google.com",
  "claude.ai",
  "chatgpt.com",
  "gemini.google.com",
  "grok.com",
  "app.apollo.io",
  "app.heyreach.io",
  "symbal.ai",
  "cal.com",
  "upwork.com",
  "ext.manatal.com",
  "you.ashbyhq.com",
  "hiring.naukri.com",
  "outlook.office.com",
  "outlook.cloud.microsoft"
];

const VIDEO_OVERRIDES_KEY = "videoOverrides";
const DOMAIN_OVERRIDES_KEY = "domainOverrides";
const VIDEO_USER_BLOCK_KEY = "videoUserBlocks";
const PAUSE_STATE_KEY = "pauseState";
const INSTALL_META_KEY = "installMeta";
const SESSION_STATE_KEY = "sessionState";
const INSIGHTS_CACHE_KEY = "insightsCache";

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

export async function getVerdictFromCache(videoId) {
  const key = `v:${videoId}`;
  const res = await chrome.storage.local.get(key);
  const entry = res[key];
  if (!entry) return null;
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - entry.at > THIRTY_DAYS) return null;
  return entry.verdict;
}

export async function setVerdictInCache(videoId, verdict) {
  await chrome.storage.local.set({
    [`v:${videoId}`]: { verdict, at: Date.now() }
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

export async function getPauseState() {
  const res = await chrome.storage.local.get(PAUSE_STATE_KEY);
  const s = res[PAUSE_STATE_KEY];
  if (!s) return { paused: false };
  if (s.pausedUntil === null || s.pausedUntil > Date.now()) {
    return { paused: true, pausedUntil: s.pausedUntil, reason: s.reason || "manual" };
  }
  return { paused: false };
}

export async function setPauseState(durationMs, reason) {
  if (durationMs === 0) {
    await chrome.storage.local.remove(PAUSE_STATE_KEY);
    return;
  }
  await chrome.storage.local.set({
    [PAUSE_STATE_KEY]: {
      pausedUntil: durationMs === null ? null : Date.now() + durationMs,
      setAt: Date.now(),
      reason: reason || "manual"
    }
  });
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

export async function getInsightsCache() {
  const res = await chrome.storage.local.get(INSIGHTS_CACHE_KEY);
  return res[INSIGHTS_CACHE_KEY] || null;
}

export async function setInsightsCache(insights) {
  await chrome.storage.local.set({
    [INSIGHTS_CACHE_KEY]: { ...insights, generatedAt: Date.now() }
  });
}

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
