# Cost visibility and model switcher

Date: 2026-04-18
Status: approved — ready for implementation plan

## Problem

Users can't see what Focus Closer is costing them or how close they are to running out of API credits. And they're locked into Haiku 4.5 — no way to trade latency for classification quality, or cost for speed. This feature adds both.

## Scope

1. Capture real token usage on every Claude call.
2. Show a donut chart: month-to-date spend vs. a user-set monthly budget.
3. Show projected monthly burn based on actual token volumes.
4. Let the user switch between Haiku 4.5 / Sonnet 4.6 / Opus 4.6 / Opus 4.7.
5. Show a per-model cost projection table so the cost impact of switching is legible *before* switching.

## Constraint: no true "credits remaining"

Anthropic's Messages API key does not expose account credit balance. The Admin API does, but it requires a separate `sk-ant-admin...` key. We accepted the trade-off of keeping onboarding to one key and showing "spent vs. budget" instead of "true credits left." A link to console.anthropic.com covers the authoritative lookup.

## Components

### `lib/pricing.js` (new)

Single source of truth for model IDs, labels, per-1M-token prices, and latency class.

```js
export const MODELS = {
  "claude-haiku-4-5-20251001": {
    label: "Haiku 4.5",
    speed: "fastest",
    in: 1, out: 5, cacheRead: 0.10, cacheWrite: 1.25
  },
  "claude-sonnet-4-6": {
    label: "Sonnet 4.6",
    speed: "medium",
    in: 3, out: 15, cacheRead: 0.30, cacheWrite: 3.75
  },
  "claude-opus-4-6": {
    label: "Opus 4.6",
    speed: "slow",
    in: 15, out: 75, cacheRead: 1.50, cacheWrite: 18.75
  },
  "claude-opus-4-7": {
    label: "Opus 4.7",
    speed: "slow",
    in: 15, out: 75, cacheRead: 1.50, cacheWrite: 18.75
  }
};

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export function costForCall(usage, modelId) { ... }
```

Verify exact prices against console.anthropic.com/settings/limits at implementation time.

### `lib/usage.js` (new)

Append-only usage log + rollup functions.

- `logUsage({at, model, usage, costUsd})` — appends to `chrome.storage.local.usageLog`, bounded at 5000 entries.
- `getUsageStats()` — returns:
  - `monthSpentUsd` — sum of `costUsd` where `at >= start-of-month`
  - `dailyAvgUsd` — last 7 days average (or fewer if less data)
  - `projectedMonthlyUsd` — `dailyAvgUsd * 30`
  - `tokenTotals` — `{input, output, cacheRead, cacheWrite}` summed across last 30d
  - `callsThisMonth` — count
  - `dataDays` — how many days of data we have (for confidence label)
- `projectPerModel()` — applies every model's pricing to `tokenTotals` to produce an array of `{modelId, label, speed, monthlyUsd}`.

### `classifier/claude.js` (modify)

- Replace the `const MODEL = "claude-haiku-4-5-20251001"` with `settings.classifierModel || DEFAULT_MODEL`.
- After a successful response, call `logUsage(...)` with `response.usage` and the computed cost.

### `classifier/insights.js` (modify)

- Same treatment: read from settings, log usage after the call.

### `lib/storage.js` (modify)

- Add `classifierModel` and `monthlyBudgetUsd` (default 5) to the settings schema and defaults.

### `options/options.html` + `options.js` + `options.css` (modify)

**Dashboard panel — new "API usage" card** (above or alongside the stats grid):

```
┌─────────────────────────────────────────────┐
│  API usage this month                       │
│                                             │
│    ╭────────╮     $1.24                     │
│    │  74%   │     of $5.00 budget           │
│    ╰────────╯                               │
│                                             │
│  Projected: $3.80/mo · 23 calls · Haiku 4.5 │
│  [Edit budget]  [View balance on console →] │
└─────────────────────────────────────────────┘
```

- SVG donut, ~120px. Filled arc = `monthSpentUsd / monthlyBudgetUsd`. Overflow (>100%) shows as a full ring in a warning color.
- Empty state when `dataDays < 1`: donut renders at 0% with subtitle "Not enough data yet — check back after a few classifications."

**Dashboard panel — "Estimated monthly cost by model" card** (below the donut):

| Model | Projected | Speed | Action |
|---|---|---|---|
| Haiku 4.5 | $0.30/mo | Fastest | current |
| Sonnet 4.6 | $0.90/mo | Medium | Switch → |
| Opus 4.6 | $4.50/mo | Slow | Switch → |
| Opus 4.7 | $4.50/mo | Slow | Switch → |

- "Switch" button sets `classifierModel` in storage.sync and re-renders.
- Speed column renders with a subtle color cue (green/amber/red).
- Small caption under the table: "Projections use your actual token volumes and cache-hit ratio from the last 30 days."

**Rules tab — model picker** (new card under the API key card):

```
Classifier model
[ Haiku 4.5 — fastest, cheapest (recommended) ▼ ]

⚠ Slower models may close the tab after you've already
  started scrolling. Haiku runs in ~500ms; Sonnet ~1-2s;
  Opus 3-5s.
```

- Single `<select>` with all four models.
- Warning banner appears only when a non-Haiku model is selected.

**Rules tab — budget field** (inside an existing or new card):

```
Monthly budget
[ $ 5.00 ]
Used for the donut chart on the dashboard. Not enforced —
real limits live in your Anthropic console.
```

## Data flow

```
Claude API response
  ├─ usage {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}
  └─ → costForCall(usage, modelId) → costUsd
         └─ → logUsage({at, model, usage, costUsd})
                └─ → chrome.storage.local.usageLog (bounded 5000)

Dashboard render
  ├─ getUsageStats() → donut + "projected: $X/mo"
  └─ projectPerModel() → per-model table
```

## Edge cases

- **First run, no data:** donut at 0%, table shows "—" for every model. Explicit copy tells the user to come back after a few classifications.
- **Model switch mid-month:** past calls keep their original model in the log, so projection uses the mixed real token volumes. Reasonable — the user's traffic pattern is what matters, not which model answered it.
- **Budget = 0 or blank:** donut falls back to showing month-to-date dollars only, no percentage.
- **Anthropic changes prices:** pricing lives in `lib/pricing.js`, one file to update. Added a comment noting where to verify.
- **Usage log rotation:** bounded at 5000 entries (months of data at typical volume) — old entries dropped FIFO, same pattern as `decisionLog`.

## Testing

Manual:
1. Fresh install → dashboard shows empty state copy.
2. Classify a few videos → donut starts filling; usageLog has entries with non-zero `costUsd`.
3. Switch model via Rules tab → next classify call uses new model; usageLog reflects it.
4. Switch model via dashboard row → same behavior, re-render is correct.
5. Set budget = $1, spend past it → donut shows >100% in warning color.
6. Clear usageLog → graceful degrade to empty state.

No automated tests planned — this is pure display/rollup logic over `chrome.storage.local`, and the existing codebase has no test harness for storage/UI. The eval harness covers classifier correctness and is model-agnostic, so switching models doesn't require new evals.

## Out of scope (YAGNI)

- True Anthropic credit balance (needs Admin key — deferred until users ask).
- Usage alerts or hard budget caps (display-only for now).
- Per-classification cost display (noise vs. signal — month-level is the right zoom).
- Historical spend chart (donut + projection covers the need).
