# Focus Closer

A Chrome extension that auto-closes distracting tabs before you can doomscroll them.

Built because I was watching 48 YouTube videos a day.

---

## The problem

I queried my own Chrome history. Last 90 days:

| Domain | Visits |
|---|---:|
| linkedin.com | 6,283 |
| youtube.com | 4,354 |
| instagram.com | 3,760 |
| x.com | 2,974 |
| facebook.com | 889 |

LinkedIn is (mostly) work. The rest is drift. YouTube is the hard one — the same URL pattern contains both Khan Academy lectures and Minecraft speedruns, so a blunt domain block doesn't work.

## The approach

Two independent subsystems behind one shared recovery UX:

1. **Domain blocklist closer** — instant close on always-distracting sites. No LLM, no latency, no cost. Supports path-level entries (`linkedin.com/feed` blocks the feed but leaves `/messaging` alone).
2. **YouTube content classifier** — reads video metadata, runs a local rule pass, falls back to Claude Haiku 4.5 on ambiguous cases. Closes the tab if unproductive.

Both feed a 5-second popup on the next active tab with a **Reopen** button (false positive) or per-domain **Unblock** options. ESC to dismiss.

## Architecture

```
          ┌─────────────────┐
  nav →   │  Service worker │  ← popup actions
          │   (coordinator)  │
          └────────┬────────┘
                   │
       ┌───────────┴───────────┐
       │                       │
   YouTube?              Domain on blocklist?
       │                       │
       ▼                       ▼
  ┌─────────┐           ┌──────────────┐
  │ content │ metadata  │  close tab   │
  │ script  │──────────►│  + log       │
  └─────────┘           └──────┬───────┘
       │                       │
       ▼                       ▼
  ┌────────────────────────────────┐
  │  Classify:                     │
  │  1. User override              │
  │  2. Cache (30d)                │
  │  3. Local rules (channels + keywords)
  │  4. Claude Haiku 4.5           │
  │  5. Fail-open                  │
  └────────────┬───────────────────┘
               │
          unproductive?
               │
               ▼
     Close tab + inject popup
     on the next active tab
```

## Cost

Claude Haiku 4.5 only runs on ambiguous videos (about half after cache + local rules).

- ~300 input + 50 output tokens per ambiguous video
- At ~50 YouTube visits/day × 50% LLM hit rate = **~$0.30/month**
- Latency: 300–800ms. Hidden inside the metadata-extraction wait.

## Design decisions

A few non-obvious choices worth pointing out:

- **Strict-by-default with 5-second recovery, not tentative classifier.** Asking "are you sure?" before every close is exhausting and trains you to dismiss modals. Closing immediately with a reopen button trains the system from real signal — if you never reopen, it's working.
- **Two subsystems, not one generic classifier.** LLM-classifying every tab is expensive, slow, and risks misclassifying work tools (Gmail, Calendar, internal dashboards). A domain blocklist handles the obvious 95%; the LLM handles only the ambiguous content at `youtube.com/watch`.
- **Path-level blocklist.** `linkedin.com/feed` ≠ `linkedin.com/messaging`. One is a doomscroll surface, the other is how leads reach out. Match is prefix with segment boundary (so `/feed` doesn't match `/feedback`).
- **Self-teaching loop.** Every popup offers "Always allow this channel" / "Always block this channel" — one click teaches the classifier forever. The channel whitelist becomes your personal model of "what's actually productive for me."
- **Fail-open, not fail-closed.** If the Claude API goes down, the tab stays open. Never silently break browsing — the user should never wonder why a legitimate page vanished.
- **Commitment device layer.** The extension alone is trivially bypassed (Guest mode, Incognito, new profile). For real enforcement, pair with a Chrome managed policy at `/Library/Managed Preferences/com.google.Chrome.plist` that disables Guest/Incognito/new-profile creation. Requires `sudo` to install and to remove — friction is the point.

## Features

- **Strict YouTube classifier** (local rules → Claude Haiku fallback → fail-open)
- **Path-level blocklist** with per-entry temporary overrides (60s / 30min / today / permanent)
- **Work-whitelist** — Google Workspace, Claude, Apollo, HeyReach, Symbal, Ashby, etc. can never be blocked even if you try
- **`Ctrl+Shift+X`** — mark current tab as distracting (closes + remembers so it closes on re-visit)
- **`Ctrl+Shift+P`** — pause the extension for an hour (or "Pause until tomorrow" from the dashboard)
- **Dashboard** — time saved, tabs closed per day, source breakdown, searchable decision log
- **Channel learning** — one-click "always allow" / "always block" from the close popup
- **LinkedIn badge hiding** — CSS rules that hide every notification badge except Messaging
- **Cross-device sync** — API key, blocklist, channel rules sync via `chrome.storage.sync`

## Stats

_Run the thing for a week, paste your numbers here. The dashboard tab shows these live at any time._

```
Last 7 days:
  — 94 tabs closed
  — 47 minutes of YouTube drift prevented
  — 3 false positives (recovered via Reopen)
  — Breakdown: 58 blocklist / 28 Claude / 5 local rule / 3 user flag
```

## Install (dev)

```bash
# 1. Clone
git clone https://github.com/<you>/focus-closer
cd focus-closer

# 2. Chrome → chrome://extensions → Developer mode → Load unpacked
#    Point it at this directory.

# 3. Click the extension icon → Rules tab → paste your Anthropic API key
#    (from console.anthropic.com → API keys)
```

Cost reminder: new API accounts require a one-time credit purchase before programmatic access unlocks, even if you have signup credit — the signup credit is Workbench-only until you buy.

## Limitations

Things I know are weak, in order of severity:

- **YouTube DOM churn.** I parse `ytInitialPlayerResponse` as the primary source (more stable), with DOM selectors as fallback. Both will break eventually. Needs maintenance every few months.
- **LinkedIn class names churn faster.** The badge-hiding CSS uses `href`-based selectors for nav items as a hedge, but new LinkedIn redesigns still break it periodically.
- **No mobile.** Chrome extensions don't run on mobile Chrome. The Mac policy doesn't apply on phones either. Mobile distraction is still on you.
- **Single-tab edge case.** If you have only one tab open and it gets closed, the window closes — nowhere to inject the popup. Falls back to a native OS notification. Rare.
- **Classifier is as biased as the prompt.** The prompt treats "vlogs" and "reactions" as unproductive by default. If that's too aggressive for you, it's one prompt-edit away.

## Stack

Zero dependencies. No build step. Pure vanilla JS + Manifest V3.

- `service-worker.js` — coordinator, navigation events, Claude calls, tab close, popup injection
- `content/youtube.js` — SPA route detection, metadata extraction with `ytInitialPlayerResponse` + DOM fallback
- `classifier/rules.js` — local pre-classifier (channel + title keywords)
- `classifier/claude.js` — Claude Haiku 4.5 wrapper with strict-leaning prompt
- `lib/storage.js` — `chrome.storage` wrappers, override expiry, path match logic
- `lib/logger.js` — decision log ring buffer + stats aggregation
- `options/` — dashboard UI

## License

MIT
