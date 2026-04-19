// Focus-music keywords are kept because they're a USER-OPTED rule (the music-rule
// setting). They're not pattern-matching for content judgment — they're respecting
// the user's explicit "lofi while I work is OK" preference.
const PRODUCTIVE_FOCUS_MUSIC_KEYWORDS = [
  "lofi", "lo-fi", "lo fi", "focus music", "study music",
  "deep focus", "concentration music", "ambient study",
  "white noise", "brown noise", "rain sounds",
  "classical music for studying", "instrumental study",
  "coding music", "deep work"
];

function normalize(s) {
  return (s || "").toLowerCase();
}

function anyMatch(haystack, needles) {
  const h = normalize(haystack);
  return needles.some((n) => h.includes(n));
}

// Local rules are USER-DRIVEN ONLY: channel lists, video overrides, Shorts-by-format,
// and the user's opt-in focus-music rule. Pattern-matching on titles for content judgment
// is REMOVED — every non-rule case goes to Claude. Keywords created brittle false
// positives (Huberman "Dreams") and false negatives (gaming videos that don't literally
// say "minecraft"). The classifier is a real LLM, not a python script.
export function classifyLocally(meta, settings) {
  const { title = "", channel = "", description = "", isShort = false } = meta;

  if (isShort) {
    return {
      verdict: "unproductive",
      confidence: 0.95,
      reason: "YouTube Shorts (format always unproductive)",
      source: "rule"
    };
  }

  if (settings.channelWhitelist?.some((c) => normalize(c) === normalize(channel))) {
    return {
      verdict: "productive",
      confidence: 0.98,
      reason: `channel "${channel}" is on your whitelist`,
      source: "rule"
    };
  }

  if (settings.channelBlocklist?.some((c) => normalize(c) === normalize(channel))) {
    return {
      verdict: "unproductive",
      confidence: 0.98,
      reason: `channel "${channel}" is on your blocklist`,
      source: "rule"
    };
  }

  // User's focus-music opt-in: if the title or description signals study/focus music
  // and the user hasn't disabled the rule, keep it open.
  const focusMusicHit = anyMatch(title, PRODUCTIVE_FOCUS_MUSIC_KEYWORDS) ||
                       anyMatch(description, PRODUCTIVE_FOCUS_MUSIC_KEYWORDS);
  if (focusMusicHit && settings.musicRule !== "all_unproductive") {
    return {
      verdict: "productive",
      confidence: 0.9,
      reason: "focus/study/ambient music",
      source: "rule"
    };
  }

  // Everything else → Claude. No keyword shortcuts. The whole point of having an LLM
  // is to use it.
  return null;
}
