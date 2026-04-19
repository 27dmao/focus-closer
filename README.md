<div align="center">
  <img src="icons/icon-128.png" width="96" alt="Focus Closer" />
  <h1>Focus Closer</h1>
  <p><strong>The AI bouncer for your browser.</strong></p>
  <p>A Chrome extension that auto-closes distracting tabs before you can scroll them.<br>Claude-powered YouTube classifier. Path-level blocklist. 5-second false-positive recovery.</p>
  <p>
    <a href="https://27dmao.github.io/focus-closer/">Landing page</a> ·
    <a href="#install">Install</a> ·
    <a href="#architecture">Architecture</a> ·
    <a href="#roadmap">Roadmap</a>
  </p>
</div>

---

## The problem

I queried my own Chrome history. Last 90 days, top visited domains:

| Domain | What it is | Visits |
|---|---|---:|
| linkedin.com | Sales outreach + occasional doomscroll | 6,283 |
| youtube.com | Lectures, or Minecraft. Depends on the day. | 4,354 |
| instagram.com | Zero defense of this one. | 3,760 |
| x.com | Startup Twitter. Mostly. | 2,974 |
| facebook.com | Legacy habit. | 889 |

Instagram and X are always distractions — a dumb domain block handles them. LinkedIn is mostly work. **YouTube is the hard one** — the same URL pattern (`/watch`) holds both Khan Academy and Minecraft. That's where an LLM earns its keep.

## The approach

Two independent subsystems behind one shared recovery UX:

1. **Domain blocklist closer** — instant close on always-distracting sites. No LLM, no latency, no cost. Path-level entries (`linkedin.com/feed` blocks the feed but leaves `/messaging` alone).
2. **YouTube content classifier** — reads video metadata, runs local rules first, falls back to Claude Haiku 4.5 on ambiguous cases. Closes the tab if unproductive.

Both feed a 5-second popup on your next active tab with contextual actions: **Reopen** (false positive), **Always allow/block this channel**, per-domain **Unblock** options. ESC to dismiss.

## Architecture

```
          ┌─────────────────┐
  nav →   │  Service worker │  ← popup actions (reopen, unblock, always allow)
          │   (coordinator) │
          └────────┬────────┘
                   │
       ┌───────────┴───────────┐
       ▼                       ▼
   YouTube?              Domain on blocklist?
       │                       │
       ▼                       ▼
  ┌─────────┐           ┌──────────────┐
  │ content │ metadata  │  close tab   │
  │ script  │──────────►│  + log       │
  └─────────┘           └──────┬───────┘
       │                       │
       ▼                       ▼
  ┌──────────────────────────────────────┐
  │  Classify waterfall:                 │
  │  1. User override (always allow/block│
  │  2. Cache (30d)                      │
  │  3. Local rules (channels + keywords)│
  │  4. Claude Haiku 4.5                 │
  │  5. Fail-open on error               │
  └────────────┬─────────────────────────┘
               │
          unproductive?
               │
               ▼
     Close tab + inject popup
     on the next active tab
```

## Features

| | |
|---|---|
| **Claude classifier** | Reads title, channel, description, tags. Returns productive/unproductive with reason. ~500ms, ~$0.0005 per call. Uses Anthropic prompt caching on the system prompt — subsequent calls are faster and cheaper. |
| **Evaluation harness** | 30-case labeled test set under `evals/`. Run `npm run eval` to validate prompt changes. Exit code gates CI. |
| **Focus Sessions** | Timer-based deep work mode. 25/50/90-min presets. During a session, classifier runs stricter and cache bypasses. End-of-session toast reports how many distractions got blocked. |
| **AI Weekly Insights** | Claude reads your last 7 days of closes and writes a personalized brief: pattern observed, biggest attention leak, one thing to try. ~$0.001 per generation. |
| **Attention score** | Single number, tracked daily. Trends over time. Progress has to be legible for behavior change to work. |
| **5-second recovery popup** | Reopen (false positive) button + "Always allow this channel" to teach the system forever. ESC to dismiss. Hover pauses timer. |
| **Path-level blocklist** | `linkedin.com/feed` blocked, `/messaging` untouched. Match is suffix-based on host, prefix-based on path with segment boundary. |
| **Work-whitelist** | Gmail, Calendar, Claude, ChatGPT, Apollo, HeyReach, Symbal, Ashby, Upwork can never be blocked — even if you try. |
| **Pause / panic button** | 1h / today / indefinite from popup, shortcut, or dashboard. Real products have escape valves. |
| `⌘+Shift+X` | Mark distracting — closes tab and auto-blocks the channel. Remembers the videoId so re-visits close instantly. |
| `⌘+Shift+S` | Mark productive — whitelists current video + channel, OR undoes the last close (within 5 min). |
| `⌘+Shift+P` | Pause/resume the extension for an hour. |
| (Windows/Linux: `Ctrl` instead of `⌘`) | |
| **LinkedIn badge hiding** | CSS rules that hide every notification badge except Messaging — because the only notification I want is when someone actually messages me. |
| **Commitment device** | Pairs with a macOS Chrome managed policy that disables Guest mode, Incognito, and new-profile creation — `sudo` to install and remove. |
| **Onboarding wizard** | First-run walks through API key, strictness level, and a test-it-now checklist. |

## Cost

~$0.30/month at typical use. Local rules and cache cover most of the load; Claude Haiku only runs on ambiguous videos.

```
~50 YT visits/day × 50% LLM hit rate × $0.0005/call
≈ $0.01/day ≈ $0.30/month
```

Blocklist closes are free. Cache hits are free. Only ambiguous YouTube videos hit the API.

## Design decisions

Four non-obvious calls worth pointing out:

**Strict-by-default with instant recovery, not "are you sure?" prompts.** Asking before every close is exhausting and trains you to dismiss the modal. Closing immediately with a visible Reopen button means only actual false positives cost you 2 seconds.

**Two subsystems, not one generic classifier.** LLM-classifying every tab is expensive, slow, and risks misclassifying work tools. A cheap domain blocklist handles the obvious 95%; the LLM handles only the ambiguous content at `youtube.com/watch`.

**Path-level blocklist.** `linkedin.com/feed` ≠ `linkedin.com/messaging`. One is a doomscroll surface, the other is how customers reach out. Granularity without fiddling.

**Self-teaching loop.** Every close popup offers one-click "Always allow this channel" / "Always block this channel." The channel whitelist becomes your personal model of what's productive *for you*. AI Weekly Insights surface patterns you'd miss on your own.

**Fail-open, not fail-closed.** If the Claude API goes down, the tab stays. Never silently break browsing — users should never wonder why a legitimate page vanished.

## Install

```bash
# 1. Clone
git clone https://github.com/27dmao/focus-closer
cd focus-closer

# 2. Chrome → chrome://extensions → Developer mode → Load unpacked
#    Point it at this directory.

# 3. Onboarding wizard prompts you for:
#    - Anthropic API key (get one at console.anthropic.com)
#    - Strictness level (strict/balanced)
```

New API accounts require a one-time credit purchase before programmatic access unlocks. $5 covers ~16 months at typical use.

### Commitment device (macOS)

The extension alone is bypassable — Guest mode, Incognito, or a fresh Chrome profile all defeat it. For real enforcement, install this Chrome managed policy:

```bash
sudo tee "/Library/Managed Preferences/com.google.Chrome.plist" > /dev/null <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>BrowserGuestModeEnabled</key><false/>
    <key>IncognitoModeAvailability</key><integer>1</integer>
    <key>BrowserAddPersonEnabled</key><false/>
</dict>
</plist>
PLIST
```

Then fully quit Chrome (`Cmd+Q` every window) and relaunch. Verify at `chrome://policy`. Requires `sudo` to install *and to remove* — the friction is the point.

## Roadmap

What this could become:

- **Next**: Sync across devices via `chrome.storage.sync` (already partially there). Firefox + Edge port (MV3 is cross-browser).
- **Later**: Team tier with shared blocklists and admin-pushed focus policies. Mobile companion with iOS Screen Time integration. Calendar integration — auto-start Focus Sessions during meetings. Opt-in accountability digest to a chosen contact.

Attention is becoming the scarcest resource in the knowledge economy. There's a product wedge here for individuals → teams → enterprise.

## Stack

Zero runtime dependencies. No build step. No server. Pure vanilla JS + Manifest V3.

```
manifest.json        LICENSE           README.md         package.json (eval scripts)
service-worker.js    (coordinator: nav events, Claude calls, tab close, popup inject, sessions, insights, suggestions)
icons/               icon-{16,32,48,128}.png + icon.svg
classifier/          rules.js (local pre-classifier) · claude.js (Haiku + prompt caching) · insights.js (weekly summary)
content/             youtube.js (SPA detection, metadata extraction) · linkedin-hide-badges.css
lib/                 storage.js · logger.js · suggestions.js (proactive pattern detection)
options/             options.html · options.css · options.js (tabbed dashboard + onboarding)
evals/               dataset.js (30 labeled cases) · run.js (eval harness) · README.md
docs/                index.html (GitHub Pages landing)
```

## Limitations

Real things, in order of severity:

- **YouTube DOM churn.** Primary extraction parses `ytInitialPlayerResponse` from page source (stable); DOM selectors are fallback. Both break eventually. Needs tuning every few months.
- **LinkedIn class names churn faster.** Badge-hiding CSS uses `href`-based nav selectors as a hedge. Still needs occasional adjustment.
- **No mobile.** Chrome extensions don't run on mobile Chrome. Mobile distraction is still on you.
- **Single-tab edge case.** If your only tab is closed, the window closes — no popup. Falls back to native OS notification. Rare in practice.
- **Classifier reflects its prompt.** Vlogs and reactions default to unproductive. If that's too aggressive for you, it's one prompt edit away in `classifier/claude.js`.

## License

MIT. See [LICENSE](LICENSE).
