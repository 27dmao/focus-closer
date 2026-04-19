// Reflection / policy distillation.
//
// Reads the user's full feedback history and asks Claude (Sonnet — quality
// matters here more than cost) to compress it into a small list of crisp
// imperative rules. Those rules then ride along with every classification
// call, so the user's accumulated taste compounds permanently — they don't
// have to keep re-flagging the same shape of content.
//
// Triggered automatically every REFLECTION_THRESHOLD new flags/allows, or
// manually from the dashboard.

const REFLECTION_MODEL = "claude-sonnet-4-6";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 1200;
const MIN_FEEDBACK_FOR_REFLECTION = 4;

function fmtList(items, label) {
  if (!items || items.length === 0) return "";
  const lines = items.slice(-80).map((e) => {
    const where = e.title || e.hostname || e.url || "";
    const who = e.channel ? ` — ${e.channel}` : "";
    return `- "${where}"${who}`;
  });
  return `${label}:\n${lines.join("\n")}`;
}

export async function distillPolicy(history, apiKey) {
  if (!apiKey) {
    return { error: "no_api_key", reason: "Add an Anthropic API key in Rules to enable policy learning." };
  }

  const flags = history?.flags || [];
  const allows = history?.allows || [];
  const total = flags.length + allows.length;

  if (total < MIN_FEEDBACK_FOR_REFLECTION) {
    return {
      error: "insufficient_feedback",
      reason: `Need at least ${MIN_FEEDBACK_FOR_REFLECTION} pieces of feedback before distilling. You have ${total}. Use Cmd+Shift+X / Cmd+Shift+S to teach the system.`
    };
  }

  const system = `You analyze a focused user's productivity feedback and distill it into crisp, durable POLICY RULES that a downstream classifier will follow on every future video.

Your job is the opposite of generic: be SPECIFIC to what THIS user has actually flagged. Compress similar flags into one rule. Capture both what they close and what they keep.

Output STRICT JSON in exactly this shape:
{
  "rules": [
    "short imperative rule",
    "another rule",
    ...
  ],
  "summary": "one short paragraph (2-3 sentences) describing the user's pattern in plain English"
}

Rules must be short imperative sentences a classifier can match against a new video title. 5 to 12 rules. No more.

Examples of good rules:
- "Close UFC, MMA, and any combat-sports highlight content."
- "Close Marvel/Avengers/Spider-Man movie clips and edits."
- "Close any 'I [verb]...' clickbait title even if the topic sounds wholesome."
- "Close fitness/bodybuilding vlogs (Sam Sulek, gym day-in-the-life style)."
- "Close pop-history clickbait ('How X Was Invented', 'Why X Was So Difficult')."
- "Close business-guru / hustle commentary content."
- "Keep AP exam-prep videos including unit reviews and full-course summaries."
- "Keep structured Stanford / MIT / Khan Academy / 3Blue1Brown lecture content."

Examples of BAD rules (too generic, do not produce these):
- "Close distracting content."
- "Keep educational videos."
- "Avoid wasting time."

Be aggressive about consolidation. If 5 of the user's flags are MrBeast-style stunts, that's ONE rule, not five. If 4 of their allows are AP review videos, that's ONE rule.`;

  const user = `${fmtList(flags, "User flagged DISTRACTING (close anything similar in shape, topic, or vibe)")}

${fmtList(allows, "User flagged PRODUCTIVE (keep anything similar)")}

Distill into POLICY RULES.`;

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: REFLECTION_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }]
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `http_${res.status}`, reason: text.slice(0, 200) || `HTTP ${res.status}` };
    }

    const json = await res.json();
    const text = json?.content?.[0]?.text?.trim() || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { error: "parse_failed", reason: text.slice(0, 200) };

    let parsed;
    try { parsed = JSON.parse(match[0]); }
    catch { return { error: "parse_failed", reason: text.slice(0, 200) }; }

    if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
      return { error: "no_rules", reason: "Reflection produced no rules." };
    }

    return {
      rules: parsed.rules.slice(0, 12),
      summary: parsed.summary || "",
      feedbackCount: total,
      generatedAt: Date.now()
    };
  } catch (e) {
    return { error: "network", reason: String(e?.message || e) };
  }
}
