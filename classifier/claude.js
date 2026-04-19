const MODEL = "claude-haiku-4-5-20251001";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 200;

function buildSystemPrompt(settings) {
  const musicRule = {
    instrumental_only: `- Music: ONLY instrumental/lofi/focus/study/ambient/classical-for-study = productive. Songs with vocals, pop/rap/rock, music videos (MVs), artist uploads = unproductive.`,
    all_productive: `- Music: any music-categorized video = productive.`,
    all_unproductive: `- Music: any music-categorized video = unproductive (YouTube is for learning only).`
  }[settings.musicRule || "instrumental_only"];

  return `You classify YouTube videos as "productive" or "unproductive" for a user trying to stay focused.

PRODUCTIVE:
- Academic lectures, courses, tutorials (physics, chemistry, math, AP subjects, programming, engineering)
- Long-form technical interviews and podcasts with scientists/engineers/founders
- History documentaries, science documentaries
- Conference talks, keynotes, paper walkthroughs
- Coding livestreams and screencasts
${musicRule}

UNPRODUCTIVE:
- Gaming content (Minecraft, Fortnite, GTA, any "let's play"/"gameplay"/"speedrun")
- Vlogs, day-in-the-life, morning routines
- Reaction videos, meme compilations, TikTok compilations, "funny moments"
- Movie/TV recaps, celebrity gossip, drama
- Pranks, unboxings
- Pop/rap/rock music videos or songs with visuals (per music rule above)
- YouTube Shorts (always unproductive by format)

The user is strict-leaning: when truly ambiguous, prefer "unproductive". A 5-second recovery UI handles false positives, so erring strict is OK.

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
