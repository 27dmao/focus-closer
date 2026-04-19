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
  // Gaming
  "minecraft", "fortnite", "roblox", "gta", "call of duty", "valorant", "league of legends", "elden ring",
  "gameplay", "playthrough", "let's play", "lets play", "speedrun", "pro gamer", "ranked",
  "ishowspeed", "kai cenat",
  // Vlog / lifestyle
  "vlog", "day in the life", "day in my life", "morning routine", "night routine", "what i eat",
  // Reactions / compilations
  "reaction", "reacts to", "reacting to",
  "compilation", "funny moments", "best moments", "tiktok",
  // Movies / TV / clips
  "movie clip", "movie scene", "scene -", "fight scene", "court scene",
  "endgame", "marvel", "spider-man", "spiderman", "iron man", "batman", "naruto", "anime moments",
  "every leak", "ending explained", "trailer breakdown", "post credits",
  // Pranks / social-experiment
  "prank", "unboxing", "social experiment", "convinced a stranger", "i convinced",
  // Celebrity / drama
  "drama recap", "celebrity", "gossip", "leaked", "exposed",
  // MrBeast-style challenge clickbait
  "mrbeast", "i trapped", "last to leave", "last to ", "i survived", "i tested", "wins $",
  // Pop-sci / dopamine bait
  "you won't believe", "shocked the world", "blew my mind", "changed everything",
  "creepier the deeper", "creepier than", "scariest",
  // Sports / esports
  "blindfold chess", "vs. magnus", "vs magnus", "guess your elo", "talent show",
  "world #", "world no",
  // Livestream entertainment
  "greatest livestream", "live stream highlights", "stream highlights"
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

  // Unproductive keywords: scan title, description, and tags. Many gaming/entertainment
  // videos (e.g., "I Trapped 100 Players...") don't say "minecraft" in the title but say
  // it everywhere else. Catching those with a free local rule beats paying Claude.
  const tagsStr = (tags || []).join(" ");
  const unprodTitle = anyMatch(title, UNPRODUCTIVE_TITLE_KEYWORDS);
  const unprodDesc = anyMatch(description, UNPRODUCTIVE_TITLE_KEYWORDS);
  const unprodTags = anyMatch(tagsStr, UNPRODUCTIVE_TITLE_KEYWORDS);
  if (unprodTitle || unprodDesc || unprodTags) {
    return {
      verdict: "unproductive",
      confidence: unprodTitle ? 0.92 : 0.88,
      reason: unprodTitle ? "unproductive keyword in title" : (unprodDesc ? "unproductive keyword in description" : "unproductive keyword in tags"),
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
