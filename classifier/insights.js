const MODEL = "claude-haiku-4-5-20251001";
const ENDPOINT = "https://api.anthropic.com/v1/messages";

function summarizeLog(log) {
  const now = Date.now();
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const week = log.filter((e) => now - e.at <= WEEK);
  const closed = week.filter((e) => e.verdict === "unproductive" || e.kind === "blocklist" || e.kind === "user_flag");

  const byDomain = {};
  const byChannel = {};
  const bySource = {};
  const byHour = Array(24).fill(0);
  const byDay = Array(7).fill(0);

  for (const e of closed) {
    const d = new Date(e.at);
    byHour[d.getHours()] += 1;
    byDay[d.getDay()] += 1;
    const src = e.source || "other";
    bySource[src] = (bySource[src] || 0) + 1;
    if (e.kind === "youtube" || e.kind === "user_flag") {
      if (e.channel) byChannel[e.channel] = (byChannel[e.channel] || 0) + 1;
    }
    if (e.kind === "blocklist" && e.matchedEntry) {
      byDomain[e.matchedEntry] = (byDomain[e.matchedEntry] || 0) + 1;
    }
  }

  const topN = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

  const peakHour = byHour.indexOf(Math.max(...byHour));
  const peakDay = byDay.indexOf(Math.max(...byDay));
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return {
    totalClosed: closed.length,
    topDomains: topN(byDomain, 5),
    topChannels: topN(byChannel, 5),
    bySource,
    peakHour,
    peakDay: dayNames[peakDay],
    peakDayCount: byDay[peakDay],
    peakHourCount: byHour[peakHour],
    recentTitles: closed.filter((e) => e.title).slice(-8).map((e) => ({ title: e.title, channel: e.channel }))
  };
}

export async function generateInsights(log, apiKey) {
  if (!apiKey) return { error: "no_api_key", reason: "No Anthropic API key configured. Add one on the Rules tab." };

  const summary = summarizeLog(log);
  if (summary.totalClosed < 5) {
    return {
      error: "insufficient_data",
      reason: `Only ${summary.totalClosed} closes in the last 7 days — use the extension for a few more days before asking for insights.`
    };
  }

  const system = `You are a concise, thoughtful attention-management analyst. You analyze a week of data from a Chrome extension that closes distracting tabs. Generate a personalized brief in exactly this structure (plain text, no markdown headings):

PATTERN OBSERVED:
One sentence stating the single most interesting behavioral pattern in the data — something the user wouldn't necessarily notice themselves.

BIGGEST ATTENTION LEAK:
One sentence naming their #1 distraction source and what it costs them (time or frequency).

ONE THING TO TRY:
One actionable, specific recommendation — not generic advice. Tied to the data.

Keep each section to 1-2 sentences. Total output < 120 words. Talk directly to the user in second person. Be sharp, not saccharine.`;

  const user = `Here is the user's close data from the last 7 days:

- Total tabs closed: ${summary.totalClosed}
- Peak distraction day: ${summary.peakDay} (${summary.peakDayCount} closes)
- Peak distraction hour: ${summary.peakHour}:00 (${summary.peakHourCount} closes)
- Sources: ${JSON.stringify(summary.bySource)}
- Top distracting domains: ${JSON.stringify(summary.topDomains)}
- Top distracting YouTube channels: ${JSON.stringify(summary.topChannels)}
- Sample of recent closed video titles: ${JSON.stringify(summary.recentTitles)}`;

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
        max_tokens: 400,
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
    if (!text) return { error: "empty_response", reason: "Claude returned no text" };

    return { text, summary, generatedAt: Date.now() };
  } catch (e) {
    return { error: "network", reason: String(e?.message || e) };
  }
}
