// Smart suggestions: analyzes the decision log and settings for actionable
// one-click suggestions shown on the dashboard. Rules-based, no LLM call.

const MIN_CHANNEL_FLAGS = 2;
const MIN_CHANNEL_REOPENS = 2;
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export function generateSuggestions(log, settings) {
  const now = Date.now();
  const recent = log.filter((e) => now - e.at <= LOOKBACK_MS);
  const out = [];

  // 1. Channels you've manually flagged repeatedly → suggest adding to channel blocklist
  const flagCounts = {};
  for (const e of recent) {
    if (e.kind === "user_flag" && e.channel) {
      flagCounts[e.channel] = (flagCounts[e.channel] || 0) + 1;
    }
  }
  for (const [channel, n] of Object.entries(flagCounts)) {
    if (n < MIN_CHANNEL_FLAGS) continue;
    if ((settings.channelBlocklist || []).includes(channel)) continue;
    out.push({
      id: `block_channel:${channel}`,
      kind: "block_channel",
      channel,
      title: `Always block "${channel}"`,
      body: `You've manually flagged ${n} videos from this channel in the last 2 weeks. Auto-close future ones.`,
      action: { type: "add_channel_blocklist", channel }
    });
  }

  // 2. Channels you've reopened multiple times as false positives → suggest whitelisting
  const overrideVideos = new Set(); // videoIds that got reopened
  // We don't directly log reopens, but we can detect repeated closes → override pattern
  // by looking at videos where a verdict was unproductive but then the user flipped it.
  // For MVP we proxy this: look at channels that appear in close logs but ALSO in the
  // channelWhitelist. Skip that path — rely on an upcoming explicit reopen log event.

  // 3. Domains closed many times → suggest an unblock schedule if during work hours
  const domainCounts = {};
  for (const e of recent) {
    if (e.kind === "blocklist" && e.matchedEntry) {
      domainCounts[e.matchedEntry] = (domainCounts[e.matchedEntry] || 0) + 1;
    }
  }
  const topDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0];
  if (topDomain && topDomain[1] >= 10) {
    out.push({
      id: `top_domain:${topDomain[0]}`,
      kind: "top_domain",
      title: `"${topDomain[0]}" hit the blocklist ${topDomain[1]}× recently`,
      body: `If you're navigating there on purpose (link from email, etc.), consider unblocking temporarily during specific hours instead of hitting the close popup repeatedly.`,
      action: null
    });
  }

  // 4. Peak distraction hour — surface it as an awareness suggestion
  const byHour = Array(24).fill(0);
  let totalClosed = 0;
  for (const e of recent) {
    const isClose = e.verdict === "unproductive" || e.kind === "blocklist" || e.kind === "user_flag";
    if (!isClose) continue;
    totalClosed += 1;
    byHour[new Date(e.at).getHours()] += 1;
  }
  if (totalClosed >= 20) {
    const maxHour = byHour.indexOf(Math.max(...byHour));
    const maxCount = byHour[maxHour];
    if (maxCount / totalClosed >= 0.15) {
      const hourLabel = `${maxHour % 12 || 12}${maxHour < 12 ? "am" : "pm"}`;
      out.push({
        id: `peak_hour:${maxHour}`,
        kind: "peak_hour",
        title: `Your peak distraction hour is ${hourLabel}`,
        body: `${maxCount} of your ${totalClosed} closes (${Math.round((maxCount / totalClosed) * 100)}%) happen at this time. Consider a Focus Session during this window.`,
        action: null
      });
    }
  }

  // 5. No data yet → cue the user to use the extension
  if (totalClosed === 0 && Object.keys(flagCounts).length === 0) {
    out.push({
      id: "cold_start",
      kind: "info",
      title: "No data yet",
      body: "Use the extension for a few days and suggestions will appear here — patterns in your distraction log that you'd never spot on your own.",
      action: null
    });
  }

  return out.slice(0, 4);
}
