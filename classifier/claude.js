const MODEL = "claude-haiku-4-5-20251001";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 200;

function buildSystemPrompt(settings) {
  const musicRule = {
    instrumental_only: `Music: ONLY instrumental/lofi/focus/study/ambient/classical-for-study = productive. Vocal songs, music videos = unproductive.`,
    all_productive: `Music: any music video = productive.`,
    all_unproductive: `Music: any music video = unproductive.`
  }[settings.musicRule || "instrumental_only"];

  return `You are a strict YouTube productivity classifier.

THE ONLY QUESTION:
"Is the user actually LEARNING a real skill or subject — or just getting a DOPAMINE hit?"

PRODUCTIVE = structured learning. Real curriculum. Genuine technical depth.
- Academic lectures, exam prep (AP, MIT, Stanford, named CS courses)
- Real technical tutorials and programming walkthroughs (multi-step, teaches a concept end-to-end)
- Long-form interviews where the guest is a researcher/scientist/engineer/founder discussing their actual work
- Conference talks, keynotes, paper walkthroughs

UNPRODUCTIVE = dopamine entertainment. Even if the topic sounds intellectual.
Real examples (close all of these and anything similar):
- "I Trapped 100 Players, But Cactus Rises Every 20 Seconds..."   gaming + "I [verb]" clickbait
- "iShowSpeed China & Mongolia Moments! 😂"                       gaming creator entertainment
- "I coded a FREE Chess Game Review website."                      "I built X for fun" — not a tutorial
- "Robert Downey Jr. and Russo Brothers introduce Avengers..."     celebrity / movie promo
- "Monsters Inc (2001) FULL MOVIE"                                 actual movie
- "Tony Stark being a genius for 5 minutes straight"               movie character compilation
- "Every Leak that Spoiled Endgame"                                movie content
- "All The Spider-Men Discover Their Powers | Compilation"         movie clips
- "the endgame time travel scenes but only the chaotic parts"     movie edit
- "MrBeast Is What Marx Warned Us About"                           hot take / commentary
- "The Darkest Philosopher in History - Arthur Schopenhauer"       pop-philosophy entertainment
- "why do we make our lives harder on purpose?"                    pop-psych dopamine
- "Every Feeling You Can't Name Explained"                         pop-psych bait
- "Why Deep Sea Creatures Get Creepier the Deeper You Go"          pop-sci dopamine bait
- "Chimpanzees Have Entered The Stone Age"                         pop-sci clickbait headline
- "When the character is so boring, they actually become fascinating"  random pop content
- "The Greatest Chess Endgame ever | Anand vs Carlsen"             chess entertainment
- "FABIANO SACRIFICES 2 ROOKS AND WINS IN 9 MOVES!"                chess entertainment
- "Intercontinental Ballistic Missile Gambit (real opening)"       chess entertainment
- "World #1 FACES World No #2 in BLINDFOLD Chess Match"            competitive entertainment
- "I Convinced a Stranger to Rob a Bank"                           social experiment
- "I Solved Connect 4"                                              clickbait, even if technical
- "If The Economy Is F*cked, Why Hasn't It Crashed Yet?"           commentary
- "PRANK That's NOT a student..."                                   prank
- "MY 5AM MORNING ROUTINE"                                          vlog
- "TRY NOT TO LAUGH CHALLENGE"                                      meme

CHESS NUANCE: actual chess INSTRUCTION (a coach teaching the Caro-Kann opening with diagrams, IM/GM courses, structured chess curriculum) = productive. Chess HIGHLIGHTS, brilliancies, memorable matches, opening trick videos = unproductive. Same logic for programming: Andrej Karpathy's "Let's build GPT from scratch" = productive (real tutorial); "I coded a chess website" = unproductive (build-for-fun showcase).

PRODUCTIVE examples for calibration:
- "AP Psychology: Everything You Need To Know! (Units 0-5 Summarized)"
- "AP Physics 1 - Unit 8 Review - Fluids - Exam Prep"
- "How to Ace the AP Language Rhetorical Analysis Essay"
- "Stanford CS229: Machine Learning Lecture 2"
- "Linear Algebra 14: Inner products and lengths"
- "But what is a neural network? | Chapter 1, Deep Learning"
- "How Kafka works (distributed systems deep dive)"
- "Yann LeCun: Meta AI, Open Source, Limits of LLMs | Lex Fridman"
- "The Story of Stripe: Patrick & John Collison at Y Combinator"

${musicRule}

DECISION RULE: If you cannot confidently say "this teaches a structured skill or subject end-to-end", choose UNPRODUCTIVE. Bias strongly toward closing — false positives are recovered in 5 seconds, false negatives waste an hour.

Respond with ONLY a JSON object, no prose:
{"verdict": "productive" | "unproductive", "confidence": 0.0-1.0, "reason": "<one short sentence>"}`;
}

function buildUserPrompt(meta) {
  const desc = (meta.description || "").slice(0, 500);
  const tags = (meta.tags || []).slice(0, 15).join(", ");
  return `Title: ${meta.title || "(unknown)"}
Channel: ${meta.channel || "(unknown)"}
Category: ${meta.category || "(unknown)"}
Tags: ${tags || "(none)"}
Description (first 500 chars): ${desc || "(empty)"}`;
}

export async function classifyWithClaude(meta, settings) {
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
    messages: [{ role: "user", content: buildUserPrompt(meta) }]
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
