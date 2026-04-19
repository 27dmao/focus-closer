// Universal domain classifier. Returns { verdict, confidence, reason, source }
// or { verdict: null, error, reason } on failure.
//
// Resolution waterfall (fast → slow), reuses helpers from lib/storage.js:
//   1. work-whitelist     → productive (instant, free)
//   2. user blocklist     → unproductive (instant, free)  [caller passes settings]
//   3. domain verdict cache (30d) → cached (free)
//   4. personal policy hostname mention → use that
//   5. Claude classification → cache by hostname
//
// YouTube is special-cased OUT — the existing video-level classifier handles
// it. This module just returns { verdict: "mixed", source: "youtube" } when
// asked about youtube.com so the dot can show grey/yellow until the video
// classifier resolves.

import { isWorkWhitelisted, getDomainVerdict, setDomainVerdict, parseBlocklistEntry, entryMatchesUrl } from "../lib/storage.js";
import { logUsage } from "../lib/usage.js";
import { DEFAULT_MODEL } from "../lib/pricing.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 200;

function findBlocklistMatch(hostname, pathname, settings) {
  const list = settings.blocklist || [];
  const toggles = settings.domainToggles || {};
  for (const entry of list) {
    if (!entryMatchesUrl(entry, hostname, pathname)) continue;
    const { domain } = parseBlocklistEntry(entry);
    if (toggles && toggles[domain] === false) continue;
    return entry;
  }
  return null;
}

function policyMentionsHostname(policy, hostname) {
  if (!policy?.rules) return null;
  const h = hostname.toLowerCase();
  for (const rule of policy.rules) {
    const r = rule.toLowerCase();
    if (r.includes(h)) {
      // Heuristic: if the rule contains "close" or "block" → unproductive, "keep"/"allow" → productive
      if (/\b(close|block|avoid|skip)\b/.test(r)) {
        return { verdict: "unproductive", reason: `personal policy: "${rule}"`, confidence: 0.95 };
      }
      if (/\b(keep|allow|productive|whitelist)\b/.test(r)) {
        return { verdict: "productive", reason: `personal policy: "${rule}"`, confidence: 0.95 };
      }
    }
  }
  return null;
}

function buildDomainSystemPrompt() {
  return `You classify a single WEBSITE (by hostname + page metadata) as productive or unproductive for a focused user.

DEFAULT TO UNPRODUCTIVE. The bar for productive is high.

PRODUCTIVE = the site primarily exists for:
- Work tools, email, calendars, communication for work (Gmail, Slack, Linear, Jira, Notion)
- Code / dev tools (GitHub, Stack Overflow, MDN, package docs)
- Structured learning (Khan Academy, Coursera, MIT OCW, AP/exam-prep sites)
- Reference (Wikipedia for academic topics, official docs, scientific journals)
- AI assistants (Claude, ChatGPT, Gemini)
- Banking / finance management
- Cloud consoles, CRMs, business analytics

UNPRODUCTIVE = the site primarily exists for:
- Social media / scrolling feeds (Instagram, TikTok, X/Twitter, Reddit, Facebook, Snapchat, Threads)
- Entertainment streaming (Netflix, Hulu, Disney+, Twitch — even YouTube outside of structured lectures)
- News commentary, hot takes, drama, gossip, celebrity content
- Pop-content sites (Buzzfeed, Bored Panda, dopamine listicles)
- Gaming / esports / sports highlights / fantasy sports
- Forums for entertainment topics
- Shopping for non-essentials, fashion, deals sites
- Blogs / Substacks unless they're structured technical/academic
- Online quiz/personality-test sites

GREY ZONE — be strict:
- Wikipedia rabbit holes outside of work topics → unproductive
- News (NYT, WSJ, etc.) → unproductive UNLESS the user is in a job that requires news consumption
- LinkedIn → mixed; the site exists for professional networking but the feed is a doomscroll surface

If the hostname clearly matches one category, classify it. If unclear or genuinely mixed (the site has both), pick "mixed" so the dot is yellow rather than red.

Respond with ONLY a JSON object, no prose:
{"verdict": "productive" | "unproductive" | "mixed", "confidence": 0.0-1.0, "reason": "<one short sentence>"}`;
}

function buildDomainUserPrompt({ hostname, title, description, policy, history }) {
  const parts = [];

  // Personal policy block (same shape as classifier/claude.js uses)
  if (policy?.rules?.length) {
    parts.push("USER'S PERSONAL POLICY — apply BEFORE the generic rubric. If a rule applies to this site, follow it:");
    for (const r of policy.rules) parts.push(`  • ${r}`);
    parts.push("");
  }

  // Recent feedback for additional context
  const recentFlagged = (history?.flags || []).slice(-6);
  const recentAllowed = (history?.allows || []).slice(-4);
  if (recentFlagged.length || recentAllowed.length) {
    parts.push("RECENT USER FEEDBACK (videos & sites they corrected):");
    if (recentFlagged.length) {
      parts.push("Closed (distracting):");
      for (const e of recentFlagged) parts.push(`  • "${e.title || e.hostname || e.url}"${e.channel ? ` — ${e.channel}` : ""}`);
    }
    if (recentAllowed.length) {
      parts.push("Kept (productive):");
      for (const e of recentAllowed) parts.push(`  • "${e.title || e.hostname || e.url}"${e.channel ? ` — ${e.channel}` : ""}`);
    }
    parts.push("");
  }

  parts.push("CLASSIFY THIS WEBSITE:");
  parts.push(`Hostname: ${hostname}`);
  if (title) parts.push(`Page title: ${title}`);
  if (description) parts.push(`Page description (first 200 chars): ${description.slice(0, 200)}`);
  return parts.join("\n");
}

async function callClaude({ hostname, title, description, settings, policy, history }) {
  const apiKey = settings.apiKey;
  if (!apiKey) return { verdict: null, error: "no_api_key", reason: "No Anthropic API key configured" };
  const model = settings.classifierModel || DEFAULT_MODEL;
  const system = buildDomainSystemPrompt();
  const user = buildDomainUserPrompt({ hostname, title, description, policy, history });

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
        model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }]
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { verdict: null, error: `http_${res.status}`, reason: text.slice(0, 200) };
    }
    const json = await res.json();
    const usage = json.usage || {};
    try { await logUsage({ model, inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0, cacheReadTokens: usage.cache_read_input_tokens || 0, cacheCreateTokens: usage.cache_creation_input_tokens || 0 }); } catch {}
    const text = json.content?.[0]?.text?.trim() || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { verdict: null, error: "parse_failed", reason: text.slice(0, 200) };
    let parsed;
    try { parsed = JSON.parse(m[0]); }
    catch { return { verdict: null, error: "parse_failed", reason: text.slice(0, 200) }; }
    if (!["productive", "unproductive", "mixed"].includes(parsed.verdict)) {
      return { verdict: null, error: "bad_verdict", reason: text.slice(0, 200) };
    }
    return {
      verdict: parsed.verdict,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      reason: parsed.reason || "(no reason)",
      source: "claude"
    };
  } catch (e) {
    return { verdict: null, error: "network", reason: String(e?.message || e) };
  }
}

// Main entry point. Returns { verdict, source, confidence, reason } or
// { verdict: null, error, reason } on failure.
export async function classifyDomain({ hostname, pathname = "/", title = "", description = "", settings, policy, history }) {
  if (!hostname) return { verdict: null, error: "no_hostname", reason: "No hostname provided" };

  // YouTube special-case — defer to per-video classifier; mark "mixed" for the dot
  if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) {
    return { verdict: "mixed", source: "youtube_deferred", confidence: 1.0, reason: "YouTube — per-video classification" };
  }

  // 1. Work-whitelist → instant productive
  if (isWorkWhitelisted(hostname)) {
    return { verdict: "productive", source: "work_whitelist", confidence: 1.0, reason: "Universal work-tool whitelist" };
  }

  // 2. User blocklist → instant unproductive
  const blockMatch = findBlocklistMatch(hostname, pathname, settings);
  if (blockMatch) {
    return { verdict: "unproductive", source: "blocklist", confidence: 1.0, reason: `On your blocklist: ${blockMatch}` };
  }

  // 3. Domain verdict cache
  const cached = await getDomainVerdict(hostname);
  if (cached && cached.verdict) {
    return { ...cached, source: cached.source ? `${cached.source}_cached` : "cache" };
  }

  // 4. Personal policy mention
  const policyHit = policyMentionsHostname(policy, hostname);
  if (policyHit) {
    const out = { ...policyHit, source: "personal_policy" };
    await setDomainVerdict(hostname, out);
    return out;
  }

  // 5. Claude classification
  const result = await callClaude({ hostname, title, description, settings, policy, history });
  if (result.verdict) await setDomainVerdict(hostname, result);
  return result;
}
