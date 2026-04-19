const MODEL = "claude-haiku-4-5-20251001";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 200;

function buildSystemPrompt(settings) {
  const musicRule = {
    instrumental_only: `Music rule: ONLY instrumental/lofi/focus/study/ambient/classical-for-study = productive. Songs with vocals, pop/rap/rock, music videos (MVs), artist uploads = unproductive.`,
    all_productive: `Music rule: any music-categorized video = productive.`,
    all_unproductive: `Music rule: any music-categorized video = unproductive.`
  }[settings.musicRule || "instrumental_only"];

  return `You classify YouTube videos as "productive" or "unproductive" for a user trying to stay focused on real work and learning.

THE CORE QUESTION TO ASK:
"Is this user actually LEARNING something useful by watching this — or just getting a hit of DOPAMINE?"

Apply this rigorously. Most "interesting", "viral", or "fun fact" content is dopamine, even when the topic sounds intellectual. Genuine learning is structured, technical, sustained, and skill-building. Erring strict is the entire point — a 5-second recovery UI catches the rare false positive.

UNPRODUCTIVE — these are all real titles. Close all of them and anything similar:
- "I Trapped 100 Players, But Cactus Rises Every 20 Seconds..."   (gaming + I-did-X clickbait)
- "Every Leak that Spoiled Endgame"                                (movie content)
- "All The Spider-Men Discover Their Powers | Compilation"         (movie clips)
- "MrBeast Is What Marx Warned Us About"                           (commentary / hot take)
- "Every Feeling You Can't Name Explained"                         (pop-psych dopamine bait)
- "Tony Stark Court Scene - Iron Man 2 Movie CLIP HD"              (movie clip)
- "Chimpanzees Have Entered The Stone Age"                         (pop-sci clickbait)
- "Why Deep Sea Creatures Get Creepier the Deeper You Go"          (pop-sci dopamine bait)
- "The Greatest Livestream Of All Time"                            (livestream entertainment)
- "World #1 FACES World No #2 in BLINDFOLD Chess Match"            (competitive entertainment)
- "I Convinced a Stranger to Rob a Bank"                           (social experiment)
- "If The Economy Is F*cked, Why Hasn't It Crashed Yet?"           (commentary / hot take)
- "I Solved Connect 4"                                              (clickbait, even if technical)
- "the endgame time travel scenes but only the chaotic parts"      (movie edit)
- "PRANK That's NOT a student..."                                   (prank)
- "MY 5AM MORNING ROUTINE"                                          (vlog)
- "TRY NOT TO LAUGH CHALLENGE"                                      (meme)
Categories: ALL gaming. ALL vlogs. ALL reactions. ALL "I [verb]" challenge videos. Movie/TV recaps, clips, edits, fan content. Celebrity content, drama, gossip, hot takes. Pranks, unboxings. Pop/rap music. YouTube Shorts (always).

PRODUCTIVE — these are real titles. Keep all of them and anything similar:
- "AP Psychology: Everything You Need To Know! (Units 0-5 Summarized)"
- "AP Physics 1 - Unit 8 Review - Fluids - Exam Prep"
- "How to Ace the AP Language Rhetorical Analysis Essay"
- "Stanford CS229: Machine Learning Lecture 2"
- "Linear Algebra 14: Inner products and lengths"
- "But what is a neural network? | Chapter 1, Deep Learning"
- "How Kafka works (distributed systems deep dive)"
- "The Story of Stripe: Patrick & John Collison at Y Combinator"
Categories: Academic lectures, exam prep, structured course material. Real technical tutorials and programming walkthroughs. Long-form interviews with scientists/engineers/founders (Lex with researchers, YC founders, Andrew Ng style). Conference talks, keynotes, paper walkthroughs.

ANTI-PATTERNS in titles — strong unproductive signals:
- Starts with "I [verb]..." ("I Trapped", "I Solved", "I Convinced")
- "Every X you didn't know / can't name / spoiled"
- Numbers + people ("100 Players", "1000 Subscribers", "$250,000")
- Movie / TV character names (Spider-Man, Iron Man, Marvel, Endgame)
- "scenes", "clip", "compilation", "moments"
- Sport competitor names ("vs.", "World #1", "Magnus")
- "Greatest of all time", "you won't believe", "shocked the world"
- "creepier than", "scariest", "darkest"

${musicRule}

Decision rule: If you cannot confidently say "this teaches a real, structured skill or subject", choose UNPRODUCTIVE. Bias toward closing.

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
