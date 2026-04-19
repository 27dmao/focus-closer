const MODEL = "claude-haiku-4-5-20251001";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 200;

function buildSystemPrompt(settings) {
  const musicRule = {
    instrumental_only: `Music: ONLY instrumental/lofi/focus/study/ambient/classical-for-study = productive. Vocal songs, music videos = unproductive.`,
    all_productive: `Music: any music video = productive.`,
    all_unproductive: `Music: any music video = unproductive.`
  }[settings.musicRule || "instrumental_only"];

  return `You are a strict YouTube productivity classifier for a focused user.

CORE PRINCIPLE — TRUST THE TITLE, NOT THE CHANNEL.
The TITLE is your primary signal. Channel is secondary context only — most distracting videos come from niche or unfamiliar channels with normal-sounding names. A title that reads as entertainment, gaming, hot take, dopamine bait, "I [did X]" clickbait, movie/TV reference, or pop-sci/pop-philosophy → UNPRODUCTIVE no matter how unknown the channel is. Do not give an unfamiliar channel the benefit of the doubt. Most channels are not academic.

THE ONE QUESTION:
"If a focused person clicks this, will they LEARN a structured skill or subject — or just scratch a curiosity / entertainment / dopamine itch?"

If you can't confidently answer "yes, structured learning," the answer is UNPRODUCTIVE.

WHAT A PRODUCTIVE TITLE LOOKS LIKE:
- Course unit numbers, lecture numbers, exam-prep markers ("Unit 8 Review", "Lecture 14", "Chapter 3", "Exam Prep")
- Named technical subjects with real depth ("Linear Algebra", "Distributed Systems", "Operating Systems", "AP Physics")
- "How to" + a real, structured skill ("How to ace the AP rhetorical analysis essay", "How Kafka works")
- Long-form interview where the guest is named and known for technical work (Lex Fridman with named researcher, Y Combinator interviews with named founders)
- Conference talk / keynote / paper walkthrough format ("Stanford CS229 Lecture 2", "GTC Keynote")
Real examples that pass:
- "AP Psychology: Everything You Need To Know! (Units 0-5 Summarized)"
- "Stanford CS229: Machine Learning Lecture 2"
- "But what is a neural network? | Chapter 1, Deep Learning"
- "How Kafka works (distributed systems deep dive)"
- "Yann LeCun: Meta AI, Open Source, Limits of LLMs | Lex Fridman"
- "The Story of Stripe: Patrick & John Collison at Y Combinator"

WHAT AN UNPRODUCTIVE TITLE LOOKS LIKE — close all of these no matter the channel:

PATTERN 1 — Starts with "I [verb]..." → close unconditionally
"I Trapped 100 Players...", "I Solved Connect 4", "I Built X", "I Coded X for fun", "I Convinced a Stranger to Rob a Bank", "I Survived...", "I Tested..."

PATTERN 2 — Number + people/things in a stunt context → close
"100 Players", "1000 Subscribers", "$250,000", "Last To Leave...", "Last To Stop..."

PATTERN 3 — Movie/TV references or character names → close
Marvel, Spider-Man, Iron Man, Tony Stark, Endgame, Avengers, naruto, Anime
"movie clip", "scene -", "compilation", "moments", "FULL MOVIE", "leaked scene"

PATTERN 4 — Pop-sci dopamine bait → close
"Why X is creepier than Y", "Creepier the deeper", "Shocked the world", "You won't believe", "Darkest", "Scariest", "Greatest of all time"

PATTERN 5 — Hot takes / commentary / "Why X is wrong" → close
"MrBeast Is What Marx Warned Us About", "If The Economy Is F*cked", "Why X is bad/wrong", "X explained" without academic context

PATTERN 6 — Pop-philosophy / pop-psych → close
"The Darkest Philosopher in History", "Every Feeling You Can't Name Explained", "why do we make our lives harder on purpose", "X you didn't know"

PATTERN 7 — Chess/sports/esports entertainment (highlights, NOT instruction) → close
"Greatest Endgame Ever", "Magnus vs Hikaru", "FABIANO SACRIFICES 2 ROOKS", "X Gambit (real opening)", "World #1 vs World #2", "BLINDFOLD chess", "guess your elo"
EXCEPTION: structured chess COURSEWORK (a named coach teaching a specific opening over a course, GM lecture series) = productive

PATTERN 8 — Reactions, vlogs, pranks, unboxings, livestream highlights → close
"reaction", "reacts to", "vlog", "day in my life", "morning routine", "PRANK", "unboxing", "Greatest Livestream", "X moments"

PATTERN 9 — "I built X for fun" / showcase videos (even if technical) → close
"I coded a FREE Chess Game Review website", "I built a X using Y" (when it's a showcase, not a tutorial)
EXCEPTION: real tutorials with curriculum format ("Let's build GPT from scratch by Andrej Karpathy") = productive

PATTERN 10 — Title style red flags
- ALL CAPS or excessive punctuation/emoji ("INSANE!!!", "🤯")
- Superlatives without substance ("greatest", "darkest", "scariest")
- "When X..." narrative style ("When the character is so boring...")
- Vague intriguing questions without academic framing ("Why do we...", "What if...")

CHANNEL ROLE — secondary tiebreaker ONLY:
- If title is borderline AND channel is a well-known academic source (Stanford, MIT OpenCourseWare, Khan Academy, 3Blue1Brown, Andrej Karpathy, Lex Fridman, Y Combinator) → productive
- If title is borderline AND channel is unfamiliar / niche → DEFAULT TO UNPRODUCTIVE
- Never let an unknown channel name make you assume the content is educational

${musicRule}

DECISION ALGORITHM:
1. Read the title. Match against the 10 unproductive patterns. If ANY match → unproductive, done.
2. Does the title look like structured learning per the productive criteria? If yes → productive.
3. Borderline → check channel. Famous academic source → productive. Anything else → unproductive.
4. When in doubt, ALWAYS choose unproductive. False positives recover in 5 seconds; false negatives waste an hour.

Respond with ONLY a JSON object, no prose:
{"verdict": "productive" | "unproductive", "confidence": 0.0-1.0, "reason": "<one short sentence stating which pattern or which productive criterion applies>"}`;
}

function buildUserPrompt(meta, history) {
  const desc = (meta.description || "").slice(0, 500);
  const tags = (meta.tags || []).slice(0, 15).join(", ");

  // Personalized few-shot from the user's actual flag/allow history.
  // This is the LEARNING loop: every X/S press becomes context Claude reasons
  // over. After ~10 flags Claude internalizes the user's specific taste.
  const historyBlock = formatHistoryBlock(history);

  return `${historyBlock}NOW CLASSIFY:
Title: ${meta.title || "(unknown)"}
Channel: ${meta.channel || "(unknown)"}
Category: ${meta.category || "(unknown)"}
Tags: ${tags || "(none)"}
Description (first 500 chars): ${desc || "(empty)"}`;
}

function formatHistoryBlock(history) {
  if (!history) return "";
  const flags = (history.flags || []).slice(-12);
  const allows = (history.allows || []).slice(-8);
  if (flags.length === 0 && allows.length === 0) return "";

  const parts = ["THIS USER'S RECENT FEEDBACK — weight these heavily as ground truth for their personal taste:"];
  if (flags.length) {
    parts.push("");
    parts.push("Marked DISTRACTING (close anything similar in shape, topic, or vibe):");
    for (const e of flags) {
      parts.push(`  • "${e.title}"${e.channel ? `  —  ${e.channel}` : ""}`);
    }
  }
  if (allows.length) {
    parts.push("");
    parts.push("Marked PRODUCTIVE (keep anything similar in shape, topic, or vibe):");
    for (const e of allows) {
      parts.push(`  • "${e.title}"${e.channel ? `  —  ${e.channel}` : ""}`);
    }
  }
  parts.push("");
  parts.push("If the new video resembles ANY flagged item by topic, format, or clickbait pattern, choose unproductive even if the channel is unfamiliar.");
  parts.push("");
  return parts.join("\n") + "\n";
}

export async function classifyWithClaude(meta, settings, history) {
  if (!settings.apiKey) {
    return {
      verdict: null,
      error: "no_api_key",
      reason: "No Anthropic API key set — open the extension options page"
    };
  }

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: "text",
        text: buildSystemPrompt(settings),
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [{ role: "user", content: buildUserPrompt(meta, history) }]
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        verdict: null,
        error: `http_${res.status}`,
        reason: text.slice(0, 200) || `HTTP ${res.status}`
      };
    }

    const json = await res.json();
    const text = json?.content?.[0]?.text?.trim() || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return { verdict: null, error: "parse_failed", reason: text.slice(0, 200) };
    }

    const parsed = JSON.parse(match[0]);
    if (parsed.verdict !== "productive" && parsed.verdict !== "unproductive") {
      return { verdict: null, error: "bad_verdict", reason: text.slice(0, 200) };
    }

    return {
      verdict: parsed.verdict,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      reason: parsed.reason || "(no reason given)",
      source: "claude"
    };
  } catch (e) {
    return { verdict: null, error: "network", reason: String(e?.message || e) };
  }
}
