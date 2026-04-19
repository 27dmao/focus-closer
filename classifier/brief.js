// Natural-language brief parser.
//
// User types in plain English what distracts them — "I check Twitter
// constantly, MrBeast videos suck me in, I refresh email compulsively" —
// and Claude turns that into structured rules the extension can act on:
// domain blocklist entries, YouTube channel blocklist entries, and
// natural-language policy rules that ride along with every classification.
//
// Used both during onboarding (head start) and as a permanent feature in
// the Rules tab.

const MODEL = "claude-sonnet-4-6";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 800;

const SYSTEM_PROMPT = `You parse a user's natural-language description of what distracts them and convert it into structured rules for a Chrome extension that auto-closes distracting tabs.

Output STRICT JSON in exactly this shape, nothing else:
{
  "domains": ["instagram.com", "x.com"],
  "youtube_channels": ["MrBeast", "Sidemen"],
  "policy_rules": ["Close any drama-recap or hot-take commentary content.", "Close fitness/bodybuilding day-in-the-gym vlogs."],
  "summary": "one short sentence acknowledging what you parsed"
}

PARSING RULES:

1. Domains — extract bare hostnames the user wants blocked entirely:
   - "Twitter" / "X" → "x.com" AND "twitter.com"
   - "Instagram" → "instagram.com"
   - "TikTok" → "tiktok.com"
   - "Facebook" → "facebook.com"
   - "Reddit" → "reddit.com"
   - "LinkedIn" → "linkedin.com"
   - "YouTube" alone → DO NOT add youtube.com (the extension classifies YouTube videos individually; site-wide block would over-block)
   - Strip protocol, www, paths

2. EMAIL is special — even if the user says they check email compulsively, DO NOT block gmail.com, mail.google.com, outlook.com, or any work-domain email. The extension hardcode-protects work tools. Instead add a policy_rule like "User checks email compulsively — keep email work tabs open but discourage."

3. Other work tools that should NEVER be added to domains: docs.google.com, calendar.google.com, claude.ai, chatgpt.com, gemini.google.com, github.com. If the user mentions these as distractions, add a policy_rule but not a domain.

4. YouTube channels — if the user names a YouTube creator, add to youtube_channels. Examples: "MrBeast", "iShowSpeed", "Dream", "Sidemen", "Casey Neistat".

5. Policy rules — capture topical / behavioral patterns that aren't a domain or channel:
   - "I watch too much drama content" → "Close drama-recap and gossip content."
   - "I get sucked into political content" → "Close political commentary and partisan hot-takes."
   - "I keep watching chess highlights" → "Close chess entertainment (highlights, brilliancies, opening trick videos); keep structured chess instruction."
   Each rule should be a single short imperative sentence.

6. Summary — one short sentence in plain English describing what you parsed. Used to show the user what changed.

Be CONSERVATIVE. Only output what the user explicitly mentions. Don't extrapolate. Empty arrays are fine.`;

export async function parseBrief(userText, apiKey) {
  if (!apiKey) {
    return { error: "no_api_key", reason: "Add an Anthropic API key on the Rules tab to enable natural-language training." };
  }
  const text = (userText || "").trim();
  if (text.length < 4) {
    return { error: "empty", reason: "Write a sentence or two about what distracts you." };
  }

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
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: text }]
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { error: `http_${res.status}`, reason: body.slice(0, 200) || `HTTP ${res.status}` };
    }

    const json = await res.json();
    const out = json?.content?.[0]?.text?.trim() || "";
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return { error: "parse_failed", reason: out.slice(0, 200) };

    let parsed;
    try { parsed = JSON.parse(m[0]); }
    catch { return { error: "parse_failed", reason: out.slice(0, 200) }; }

    return {
      domains: Array.isArray(parsed.domains) ? parsed.domains.slice(0, 30) : [],
      youtube_channels: Array.isArray(parsed.youtube_channels) ? parsed.youtube_channels.slice(0, 30) : [],
      policy_rules: Array.isArray(parsed.policy_rules) ? parsed.policy_rules.slice(0, 12) : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "Updated your rules."
    };
  } catch (e) {
    return { error: "network", reason: String(e?.message || e) };
  }
}
