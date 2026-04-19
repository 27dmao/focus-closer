<div align="center">
  <img src="icons/icon-128.png" width="96" alt="Focus Closer" />
  <h1>Focus Closer</h1>
  <p><strong>A self-improving attention firewall for your browser.</strong></p>
  <p>Auto-closes distracting tabs before you scroll them. Claude classifies every YouTube video.<br>The model learns YOUR taste — every keyboard correction compounds permanently.</p>
  <p>
    <a href="https://27dmao.github.io/focus-closer/">Landing page</a> ·
    <a href="#install">Install</a> ·
    <a href="#how-the-learning-loop-works">Learning loop</a> ·
    <a href="#architecture">Architecture</a>
  </p>
</div>

---

## What it actually does

Three rejection layers stack to filter every tab you open. They get smarter over time.

**1. Hard rules** — Shorts always close. Channels you've explicitly whitelisted/blocklisted resolve instantly. Domains in your blocklist (Instagram, X, etc.) close before the page renders.

**2. Personal policy** — A short list of crisp rules distilled from your flag history. After you've used `Cmd+Shift+X` and `Cmd+Shift+S` ~15 times, Claude has compressed your taste into rules like *"Close UFC, MMA, and combat-sports highlights"* and *"Keep AP exam-prep videos including unit reviews."* The policy travels with every classification.

**3. Claude Haiku 4.5** — When the rules + policy aren't enough, the title goes to Claude with the full personal context. ~500ms, ~$0.001/call. Strict-leaning prompt: the burden of proof is on the *productive* side. If the title doesn't read as structured learning, it closes.

False positives recover in 5 seconds via a popup with **Reopen** + **Always allow this channel**. Each correction feeds back into the policy.

## How the learning loop works

```
                      ┌──────────────────────────────────┐
                      │  YOU                             │
                      │  ⌘+Shift+X (this is distracting) │
                      │  ⌘+Shift+S (this is productive)  │
                      └────────────────┬─────────────────┘
                                       │
                       ┌───────────────▼─────────────────┐
                       │  Feedback history (200 entries) │
                       │  videoId · title · channel      │
                       └───────────────┬─────────────────┘
                                       │ every 5 new signals
                                       ▼
                       ┌─────────────────────────────────┐
                       │  Reflection pass (Sonnet 4.6)   │
                       │  "Distill this user's taste     │
                       │   into 5–12 imperative rules"   │
                       └───────────────┬─────────────────┘
                                       │
                                       ▼
                       ┌─────────────────────────────────┐
                       │  Personal policy                │
                       │  • Close UFC / combat highlights│
                       │  • Close 'I [verb]' clickbait   │
                       │  • Keep AP exam prep            │
                       │  • Keep YC founder interviews   │
                       │  • ...                          │
                       └───────────────┬─────────────────┘
                                       │ rides every classification
                                       ▼
                       ┌─────────────────────────────────┐
                       │  Future videos classify with    │
                       │  YOUR rules baked in            │
                       └─────────────────────────────────┘
```

The convergence story: after ~30 corrections spanning your distraction shapes, the policy + channel rules + Shorts handle the vast majority. Claude calls become rare and high-confidence. You stop needing to flag.

## Three ways to teach the model

| Mechanism | When |
|---|---|
| `⌘+Shift+X` | While browsing — flags the current tab as distracting. Adds the channel (if YouTube) or the domain (else) to your blocklist, AND records the title for the next reflection. |
| `⌘+Shift+S` | While browsing — flags the current tab as productive (or undoes the most recent close within 5 min). Whitelists the video + channel, removes from blocklist if present. |
| **Train by description** | Plain English on the Rules tab: *"I scroll Instagram, MrBeast videos suck me in, I check email compulsively, I get sucked into chess highlights."* Claude parses it into domains, channels, and rules. |
| **Refute** (Log tab) | Per-row button on every decision in the log. "I disagree with this verdict" — flips the policy going forward. |

All four feed the same `feedbackHistory` that drives the reflection pass.

## Onboarding

First-run is one screen with a guided probe:
1. Anthropic API key
2. Strictness (Strict — recommended — closes borderline; Balanced — only high-confidence closes)
3. Four optional probing questions:
   - Which websites distract you most?
   - On YouTube, what kinds of videos suck you in?
   - What kinds of YouTube content IS productive for you?
   - Anything else? (compulsive habits, time-wasters)

Answers go to Claude, which extracts initial domain blocks, channel blocks, and seed policy rules. Skip everything if you want — the system learns from your `⌘+Shift+X` / `⌘+Shift+S` either way.

## Architecture

```
        ┌─────────────────┐
nav →   │  Service worker │  ← popup actions, shortcuts, dashboard messaging
        │  (coordinator)  │
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
┌──────────────────────────────────────────┐
│  Classify waterfall:                     │
│  1. User overrides / blocks (instant)    │
│  2. Channel whitelist / blocklist        │
│  3. Verdict cache (30d, prompt-keyed)    │
│  4. Personal policy + Claude Haiku 4.5   │
│       (with full feedback history)       │
│  5. Confidence-flip: low-conf productive │
│       → unproductive (strict mode)       │
│  6. Fail-open on API error               │
└────────────┬─────────────────────────────┘
             │
             ▼
   Close tab + inject popup
   on the next active tab
```

## Dashboard

| | |
|---|---|
| **Attention score** | Single number, log-scaled on weekly closes + time saved. Trends over time. |
| **API usage donut** | Spent vs. budget this month. Edit budget inline. |
| **Estimated cost by model** | Switch between Haiku 4.5 / Sonnet 4.6 / Opus 4.7. Real projections from your usage. |
| **What I've learned about you** | Auto-shows when ≥5 new feedback signals are ready to distill. Hidden when up to date. |
| **Last 7 days bar chart** | Closes per day. |
| **When you get distracted** | 7 × 24 heatmap showing your peak distraction hours. |
| **Source breakdown** | Which path each close took (channel rule, policy, Claude, user flag). |
| **Recent closes** | Live feed of the latest 8 with title + channel + reason. |
| **Searchable Log tab** | Every classification ever made. Filter by source, kind, verdict. **Refute** any decision per-row to flip it permanently — refuted rows show a green pill and persist across reloads. |

## System prompt — viewable + editable

Full transparency. Rules tab → **System prompt** card → see exactly what Claude reads on every classification. Edit it freely. Reset to default anytime. The default is carefully tuned (16 unproductive patterns + burden-of-proof framing) but you can override it. Personal policy and recent feedback are still appended automatically.

## Cost

| Operation | Model | Per call | Typical / month |
|---|---|---|---|
| Per-video classification | Haiku 4.5 (default) | ~$0.001 | ~$1.50 |
| Reflection pass | Sonnet 4.6 (Haiku fallback) | ~$0.005 | ~$0.10 |
| Brief parser | Sonnet 4.6 | ~$0.005 | one-shot |

Built-in cost dashboard shows live spend vs. budget. You can switch the per-video classifier to any of Haiku 4.5 / Sonnet 4.6 / Opus 4.7 from the Dashboard.

## Install

```bash
git clone https://github.com/27dmao/focus-closer
cd focus-closer
# Chrome → chrome://extensions → Developer mode → Load unpacked → select this folder
```

Onboarding wizard prompts for an Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com)). New API accounts require a one-time credit purchase before programmatic access unlocks. $5 covers ~3+ months at typical use.

### Commitment device (macOS, optional)

The extension alone is bypassable — Guest mode, Incognito, or a fresh Chrome profile defeat it. For real enforcement, install this Chrome managed policy:

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

Fully quit Chrome and relaunch. Verify at `chrome://policy`. `sudo` to install AND to remove — the friction is the point.

## Stack

Zero runtime dependencies. No build step. No server. Pure vanilla JS + Manifest V3.

```
manifest.json        LICENSE             README.md          package.json
service-worker.js    (coordinator)
icons/               icon-{16,32,48,128}.png + icon.svg
classifier/          rules.js (local pre-classifier)
                     claude.js (Haiku + prompt caching)
                     policy.js (Sonnet reflection pass)
                     brief.js (NL → structured rules)
content/             youtube.js (SPA detection + metadata)
                     linkedin-hide-badges.css
lib/                 storage.js (sync + local + overrides + sessions + feedback)
                     logger.js (decision log + stats)
                     pricing.js (model catalog)
                     usage.js (token tracking + projections)
options/             options.html · options.css · options.js
evals/               dataset.js (30 labeled cases) · run.js · README.md
docs/                index.html (GitHub Pages landing)
```

## Limitations

- **YouTube DOM churn.** Primary path parses `ytInitialPlayerResponse` (stable); DOM selectors are fallback. Both break eventually.
- **No mobile.** Chrome extensions don't run on mobile Chrome.
- **Single-tab edge case.** If your only tab is closed, the window closes — no popup. Native OS notification fallback. Rare in practice.
- **The default Claude prompt is one user's calibration.** It's strict by design. If you want different defaults, edit it on the Rules tab — that's why it's exposed.
- **Personal policy needs feedback to bootstrap.** First-run is generic until you've corrected 5+ classifications. The onboarding probe gives a head start.

## License

MIT. See [LICENSE](LICENSE).
