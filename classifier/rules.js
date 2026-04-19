const PRODUCTIVE_TITLE_KEYWORDS = [
  "lecture", "tutorial", "course", "lesson",
  "explained", "crash course", "intro to", "introduction to",
  "how to code", "algorithm", "data structure",
  "ap physics", "ap chemistry", "ap psychology", "ap biology", "ap calc",
  "proof of", "theorem", "derivation",
  "documentary", "history of",
  "conference talk", "keynote",
  "paper review", "research paper"
];

const PRODUCTIVE_FOCUS_MUSIC_KEYWORDS = [
  "lofi", "lo-fi", "lo fi", "focus music", "study music",
  "deep focus", "concentration music", "ambient study",
  "white noise", "brown noise", "rain sounds",
  "classical music for studying", "instrumental study",
  "coding music", "deep work"
];

const UNPRODUCTIVE_TITLE_KEYWORDS = [
  "minecraft", "fortnite", "roblox", "gta", "call of duty",
  "gameplay", "playthrough", "let's play", "lets play",
  "speedrun", "pro gamer",
  "vlog", "day in the life", "morning routine",
  "reaction", "reacts to", "reacting to",
  "meme compilation", "tiktok compilation", "funny moments",
  "prank", "unboxing",
  "drama recap", "celebrity", "gossip"
];

const UNPRODUCTIVE_CATEGORY_HINTS = [
  "gaming", "entertainment", "comedy", "shorts"
];

function normalize(s) {
  return (s || "").toLowerCase();
}

function anyMatch(haystack, needles) {
  const h = normalize(haystack);
  return needles.some((n) => h.includes(n));
}

export function classifyLocally(meta, settings) {
  const { title = "", channel = "", description = "", tags = [], category = "", isShort = false } = meta;
  const titleLc = normalize(title);

  if (isShort) {
    return {
      verdict: "unproductive",
      confidence: 0.95,
      reason: "YouTube Shorts format",
      source: "rule"
    };
  }

  if (settings.channelWhitelist?.some((c) => normalize(c) === normalize(channel))) {
    return {
      verdict: "productive",
      confidence: 0.98,
      reason: `channel "${channel}" is whitelisted`,
      source: "rule"
    };
  }

  if (settings.channelBlocklist?.some((c) => normalize(c) === normalize(channel))) {
    return {
      verdict: "unproductive",
      confidence: 0.98,
      reason: `channel "${channel}" is blocklisted`,
      source: "rule"
    };
  }

  const focusMusicHit = anyMatch(title, PRODUCTIVE_FOCUS_MUSIC_KEYWORDS) ||
                       anyMatch(description, PRODUCTIVE_FOCUS_MUSIC_KEYWORDS);
  if (focusMusicHit && settings.musicRule !== "all_unproductive") {
    return {
      verdict: "productive",
      confidence: 0.9,
      reason: "focus/study/ambient music keywords",
      source: "rule"
    };
  }

  if (anyMatch(title, UNPRODUCTIVE_TITLE_KEYWORDS)) {
    return {
      verdict: "unproductive",
      confidence: 0.9,
      reason: `unproductive keyword match in title`,
      source: "rule"
    };
  }

  if (category && UNPRODUCTIVE_CATEGORY_HINTS.includes(normalize(category)) && settings.musicRule !== "all_productive") {
    return {
      verdict: "unproductive",
      confidence: 0.75,
      reason: `category "${category}"`,
      source: "rule"
    };
  }

  // Productive title keywords used to short-circuit to "productive" with confidence 0.85.
  // That was too aggressive — MrBeast-style titles were somehow matching and skipping
  // the Claude check. Now we fall through to Claude for verification, which is the right
  // behavior for a strict-leaning user: the rule can hint, but only the LLM decides.
  return null;
}
