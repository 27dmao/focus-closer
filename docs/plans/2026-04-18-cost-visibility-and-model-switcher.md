# Cost visibility and model switcher — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show month-to-date API spend as a donut, project monthly burn from real token volumes, and let the user switch between Haiku 4.5 / Sonnet 4.6 / Opus 4.6 / Opus 4.7 with per-model cost estimates.

**Architecture:** Capture `response.usage` on every Claude call → append to a bounded `usageLog` in `chrome.storage.local` → roll up into dashboard stats. Single pricing table in `lib/pricing.js` keyed by model ID. No automated tests (no runner in repo); each task ends with a manual "load extension, verify X" step.

**Tech Stack:** Vanilla JS, Chrome MV3, `chrome.storage.sync` (settings) + `chrome.storage.local` (logs). SVG for the donut.

**Design doc:** [docs/plans/2026-04-18-cost-visibility-and-model-switcher-design.md](2026-04-18-cost-visibility-and-model-switcher-design.md)

---

## Context the executor needs before starting

- `service-worker.js` orchestrates — classification happens in `classifier/claude.js` (per-video) and `classifier/insights.js` (weekly brief). Both fetch the Anthropic API directly from the service worker.
- Settings live in `chrome.storage.sync` and are read via `getSettings()` in [lib/storage.js](../../lib/storage.js).
- The decision log pattern (bounded array in `chrome.storage.local`, FIFO drop) is in [lib/logger.js](../../lib/logger.js) — mirror it for `usageLog`.
- The Anthropic Messages API returns a `usage` object on every response: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. The system prompt is cached (see `cache_control: ephemeral` in `classifier/claude.js:133`), so most input tokens should appear as `cache_read_input_tokens` after the first call.
- To load the extension: Chrome → `chrome://extensions` → Developer mode on → "Load unpacked" → point at the worktree root. Reload after edits via the circular arrow on the card.
- DevTools for the service worker: click "service worker" link on the extension card. DevTools for the options page: open the options page, then Cmd+Option+I.
- Prices below were chosen from the Anthropic public pricing page for Claude 4.x family. **Verify exact numbers at `console.anthropic.com/settings/limits` before first commit** — if any differ, update `lib/pricing.js` only.

---

## Task 1: Create pricing module

**Files:**
- Create: `lib/pricing.js`

**Step 1: Create the file**

```javascript
// Single source of truth for model IDs, labels, and per-1M-token prices.
// Prices are USD per 1,000,000 tokens. Verify against console.anthropic.com
// before shipping — if Anthropic changes pricing, update only this file.

export const MODELS = {
  "claude-haiku-4-5-20251001": {
    label: "Haiku 4.5",
    speed: "fastest",
    in: 1,
    out: 5,
    cacheRead: 0.10,
    cacheWrite: 1.25
  },
  "claude-sonnet-4-6": {
    label: "Sonnet 4.6",
    speed: "medium",
    in: 3,
    out: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75
  },
  "claude-opus-4-6": {
    label: "Opus 4.6",
    speed: "slow",
    in: 15,
    out: 75,
    cacheRead: 1.50,
    cacheWrite: 18.75
  },
  "claude-opus-4-7": {
    label: "Opus 4.7",
    speed: "slow",
    in: 15,
    out: 75,
    cacheRead: 1.50,
    cacheWrite: 18.75
  }
};

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// usage = the `usage` object returned by the Anthropic Messages API.
// Returns dollars (not per-million).
export function costForCall(usage, modelId) {
  const m = MODELS[modelId] || MODELS[DEFAULT_MODEL];
  const input = usage?.input_tokens || 0;
  const output = usage?.output_tokens || 0;
  const cacheRead = usage?.cache_read_input_tokens || 0;
  const cacheWrite = usage?.cache_creation_input_tokens || 0;
  return (
    (input * m.in + output * m.out + cacheRead * m.cacheRead + cacheWrite * m.cacheWrite) / 1_000_000
  );
}

// Given summed token volumes, project cost across every model.
// tokens = { input, output, cacheRead, cacheWrite }
// Returns [{ id, label, speed, cost }] sorted cheapest-first.
export function projectAcrossModels(tokens) {
  return Object.entries(MODELS)
    .map(([id, m]) => ({
      id,
      label: m.label,
      speed: m.speed,
      cost:
        (tokens.input * m.in +
          tokens.output * m.out +
          tokens.cacheRead * m.cacheRead +
          tokens.cacheWrite * m.cacheWrite) / 1_000_000
    }))
    .sort((a, b) => a.cost - b.cost);
}
```

**Step 2: Verify manually**

Open a scratch tab, load `lib/pricing.js` and sanity-check a known call:

```
node --input-type=module -e "
import('./lib/pricing.js').then(m => {
  const cost = m.costForCall({input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0}, 'claude-haiku-4-5-20251001');
  console.log('cost =', cost.toFixed(6));
  // expected: (100*1 + 50*5 + 1000*0.10) / 1M = 450/1M = 0.00045
})
"
```

Expected: `cost = 0.000450`

**Step 3: Commit**

```bash
git add lib/pricing.js
git commit -m "Add model pricing table + cost helpers"
```

---

## Task 2: Create usage-log module

**Files:**
- Create: `lib/usage.js`

**Step 1: Create the file**

```javascript
import { DEFAULT_MODEL, costForCall, projectAcrossModels } from "./pricing.js";

const USAGE_KEY = "usageLog";
const MAX_ENTRIES = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function logUsage({ model, usage }) {
  if (!usage) return;
  const costUsd = costForCall(usage, model || DEFAULT_MODEL);
  const entry = {
    at: Date.now(),
    model: model || DEFAULT_MODEL,
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
    costUsd
  };
  const res = await chrome.storage.local.get(USAGE_KEY);
  const log = res[USAGE_KEY] || [];
  log.push(entry);
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  await chrome.storage.local.set({ [USAGE_KEY]: log });
}

export async function getUsageLog() {
  const res = await chrome.storage.local.get(USAGE_KEY);
  return res[USAGE_KEY] || [];
}

export async function clearUsageLog() {
  await chrome.storage.local.remove(USAGE_KEY);
}

export async function getUsageStats() {
  const log = await getUsageLog();
  const now = Date.now();
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  let monthSpentUsd = 0;
  let callsThisMonth = 0;
  const tokens30d = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const perDayUsd = new Map(); // day-key → sum
  let earliest = now;

  for (const e of log) {
    if (e.at < earliest) earliest = e.at;
    if (e.at >= startOfMonth.getTime()) {
      monthSpentUsd += e.costUsd || 0;
      callsThisMonth += 1;
    }
    if (now - e.at <= 30 * DAY_MS) {
      tokens30d.input += e.input || 0;
      tokens30d.output += e.output || 0;
      tokens30d.cacheRead += e.cacheRead || 0;
      tokens30d.cacheWrite += e.cacheWrite || 0;
    }
    if (now - e.at <= 7 * DAY_MS) {
      const dayKey = Math.floor((now - e.at) / DAY_MS);
      perDayUsd.set(dayKey, (perDayUsd.get(dayKey) || 0) + (e.costUsd || 0));
    }
  }

  const dataDays = log.length === 0 ? 0 : Math.max(1, Math.ceil((now - earliest) / DAY_MS));
  const daysForAvg = Math.min(7, dataDays) || 1;
  let last7Sum = 0;
  for (let d = 0; d < daysForAvg; d++) last7Sum += perDayUsd.get(d) || 0;
  const dailyAvgUsd = log.length ? last7Sum / daysForAvg : 0;
  const projectedMonthlyUsd = dailyAvgUsd * 30;

  return {
    monthSpentUsd,
    callsThisMonth,
    dailyAvgUsd,
    projectedMonthlyUsd,
    tokens30d,
    dataDays
  };
}

// Per-model monthly projection using real token volumes from the last 30 days,
// scaled to a 30-day window if we have less data.
export async function projectPerModel() {
  const { tokens30d, dataDays } = await getUsageStats();
  if (!dataDays) return projectAcrossModels({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const scale = dataDays < 30 ? 30 / dataDays : 1;
  const scaled = {
    input: tokens30d.input * scale,
    output: tokens30d.output * scale,
    cacheRead: tokens30d.cacheRead * scale,
    cacheWrite: tokens30d.cacheWrite * scale
  };
  return projectAcrossModels(scaled);
}
```

**Step 2: Verify**

Can't easily unit-verify without a runner. Visual review: re-read the file and confirm the month-start math (line with `startOfMonth.setDate(1)`), the 30-day scale factor, and the FIFO cap.

**Step 3: Commit**

```bash
git add lib/usage.js
git commit -m "Add usage log + stats rollup"
```

---

## Task 3: Add settings defaults

**Files:**
- Modify: `lib/storage.js`

**Step 1: Read the current file**

Open [lib/storage.js](../../lib/storage.js) and find the `DEFAULT_SETTINGS` / `getSettings()` definitions. Locate where the existing defaults like `apiKey`, `strictness`, `musicRule`, `channelWhitelist`, etc. are declared.

**Step 2: Add two new defaults**

Add to the defaults object (alphabetically or with existing order — follow whatever pattern is there):

```javascript
classifierModel: "claude-haiku-4-5-20251001",
monthlyBudgetUsd: 5
```

Also add an import at the top if needed:

```javascript
import { DEFAULT_MODEL } from "./pricing.js";
```

…and use `DEFAULT_MODEL` instead of the literal string, so `lib/pricing.js` stays the single source of truth.

**Step 3: Verify**

Reload the extension, open the options page DevTools console, run:

```js
chrome.storage.sync.get(null).then(console.log)
```

Expected: the returned object includes `classifierModel: "claude-haiku-4-5-20251001"` and `monthlyBudgetUsd: 5` (on a fresh install or after clearing settings).

**Step 4: Commit**

```bash
git add lib/storage.js
git commit -m "Add classifierModel + monthlyBudgetUsd defaults"
```

---

## Task 4: Wire classifier to settings + log usage

**Files:**
- Modify: `classifier/claude.js`

**Step 1: Replace the hard-coded model + add usage logging**

At `classifier/claude.js:1` remove:

```javascript
const MODEL = "claude-haiku-4-5-20251001";
```

Add at the top of the file:

```javascript
import { DEFAULT_MODEL } from "../lib/pricing.js";
import { logUsage } from "../lib/usage.js";
```

In `classifyWithClaude`, replace the `model: MODEL` line in the body with:

```javascript
const modelId = settings.classifierModel || DEFAULT_MODEL;
// ...
const body = {
  model: modelId,
  // ... rest unchanged
};
```

After the successful `const json = await res.json();` line (around `classifier/claude.js:160`), log usage before parsing the content:

```javascript
if (json?.usage) {
  logUsage({ model: modelId, usage: json.usage }).catch(() => {});
}
```

Fire-and-forget — a storage failure must not break classification.

**Step 2: Verify**

1. Reload the extension.
2. Open service-worker DevTools.
3. Visit a YouTube video that triggers Claude (not a cached one).
4. In the options DevTools console:

```js
chrome.storage.local.get("usageLog").then(r => console.log(r.usageLog?.slice(-1)))
```

Expected: one entry with non-zero `input` + `output` (and likely `cacheWrite` on the first call, `cacheRead` on subsequent), and `costUsd > 0`.

**Step 3: Commit**

```bash
git add classifier/claude.js
git commit -m "Read classifier model from settings + log token usage"
```

---

## Task 5: Wire insights to settings + log usage

**Files:**
- Modify: `classifier/insights.js`

**Step 1: Read current file, apply same pattern**

Open [classifier/insights.js](../../classifier/insights.js). Find the hard-coded model constant and the `fetch(...)` call. Repeat the pattern from Task 4:

- Import `DEFAULT_MODEL` and `logUsage`.
- Replace the hard-coded model with `settings.classifierModel || DEFAULT_MODEL`.
- After the successful response, call `logUsage({model: modelId, usage: json.usage}).catch(() => {})`.

Decision point: do we want the insights call to respect the user's classifier-model choice, or always use Haiku? Insights is a one-shot weekly call — quality matters more than cost. **Recommendation:** always use Haiku for insights (hard-code it), because (a) the prompt is very different and may not be tuned for Opus, (b) the design doc only specifies model-switching for the classifier. If the user wants model switching for insights later, it's a separate feature.

**Revised Step 1:** Keep the insights model hard-coded as Haiku. Still add `logUsage` so its cost shows up in the donut.

```javascript
import { logUsage } from "../lib/usage.js";

// ... inside the function after getting json:
if (json?.usage) {
  logUsage({ model: "claude-haiku-4-5-20251001", usage: json.usage }).catch(() => {});
}
```

**Step 2: Verify**

1. Reload extension.
2. Options page → Insights tab → "Generate fresh insights".
3. In DevTools console:

```js
chrome.storage.local.get("usageLog").then(r => console.log(r.usageLog?.slice(-1)))
```

Expected: a new entry with notably larger `input`/`output` than a classifier call (insights prompts are bigger).

**Step 3: Commit**

```bash
git add classifier/insights.js
git commit -m "Log token usage from weekly insights calls"
```

---

## Task 6: Dashboard donut — HTML + CSS

**Files:**
- Modify: `options/options.html`
- Modify: `options/options.css`

**Step 1: Insert card markup**

In [options/options.html](../../options/options.html), inside the `data-panel="dashboard"` section, directly **after** the closing `</div>` of `.stats-grid` (around line 100), insert:

```html
<div class="card cost-card">
  <div class="card-header">
    <h3>API usage this month</h3>
    <span class="card-sub">spent vs. your budget</span>
  </div>
  <div class="cost-body">
    <svg class="cost-donut" viewBox="0 0 120 120" aria-hidden="true">
      <circle class="cost-donut-track" cx="60" cy="60" r="50" />
      <circle class="cost-donut-fill" cx="60" cy="60" r="50"
              stroke-dasharray="0 999" transform="rotate(-90 60 60)" />
      <text class="cost-donut-pct" x="60" y="66" text-anchor="middle">—</text>
    </svg>
    <div class="cost-meta">
      <div class="cost-spent" id="costSpent">—</div>
      <div class="cost-budget" id="costBudget">of — budget</div>
      <div class="cost-projection" id="costProjection">Projected: — · — calls · —</div>
      <div class="cost-actions">
        <a href="#" id="costEditBudget">Edit budget</a>
        <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener">View balance on console →</a>
      </div>
    </div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <h3>Estimated monthly cost by model</h3>
    <span class="card-sub">based on your actual usage</span>
  </div>
  <table class="model-cost-table" id="modelCostTable">
    <thead><tr><th>Model</th><th>Projected</th><th>Speed</th><th></th></tr></thead>
    <tbody><tr><td colspan="4" class="empty">Classify a few videos to see projections.</td></tr></tbody>
  </table>
  <div class="help">Projections use your actual token volumes and cache-hit ratio from the last 30 days.</div>
</div>
```

**Step 2: Add CSS**

Append to [options/options.css](../../options/options.css):

```css
/* Cost card */
.cost-body {
  display: flex;
  gap: 24px;
  align-items: center;
}
.cost-donut { width: 120px; height: 120px; flex-shrink: 0; }
.cost-donut-track { fill: none; stroke: var(--bg-elev, #1a1a1a); stroke-width: 14; }
.cost-donut-fill {
  fill: none;
  stroke: var(--accent, #6ee7b7);
  stroke-width: 14;
  stroke-linecap: round;
  transition: stroke-dasharray 400ms ease, stroke 200ms;
}
.cost-donut-fill.over-budget { stroke: #f87171; }
.cost-donut-pct {
  font-size: 18px;
  font-weight: 600;
  fill: var(--text, #e5e5e5);
}
.cost-meta { flex: 1; min-width: 0; }
.cost-spent { font-size: 28px; font-weight: 600; line-height: 1.2; }
.cost-budget { color: var(--muted, #888); margin-top: 2px; }
.cost-projection { margin-top: 10px; color: var(--muted, #888); font-size: 13px; }
.cost-actions { margin-top: 12px; display: flex; gap: 16px; font-size: 13px; }
.cost-actions a { color: var(--accent, #6ee7b7); text-decoration: none; }
.cost-actions a:hover { text-decoration: underline; }

/* Model cost table */
.model-cost-table { width: 100%; border-collapse: collapse; }
.model-cost-table th, .model-cost-table td {
  text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border, #222);
}
.model-cost-table .empty { text-align: center; color: var(--muted, #888); padding: 20px; }
.model-cost-table .speed-fastest { color: #6ee7b7; }
.model-cost-table .speed-medium { color: #fbbf24; }
.model-cost-table .speed-slow { color: #f87171; }
.model-cost-table .current-badge {
  background: var(--accent-bg, #1f3a2f); color: var(--accent, #6ee7b7);
  padding: 2px 8px; border-radius: 4px; font-size: 12px;
}
.model-cost-table .btn-switch {
  background: transparent; border: 1px solid var(--border, #333); color: var(--text, #e5e5e5);
  padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;
}
.model-cost-table .btn-switch:hover { border-color: var(--accent, #6ee7b7); }
```

Use whichever CSS variable names the rest of the file uses — inspect the top of `options.css` first and match its naming. If it uses hex literals directly (no vars), substitute the literals in.

**Step 3: Verify**

Reload the extension, open options → Dashboard tab. Confirm:
- The card is visible under the stats grid.
- Donut renders as a gray track (no fill yet — will be wired in Task 7).
- Model cost table shows the "Classify a few videos to see projections." empty row.
- Layout doesn't break at narrow widths (try narrowing the window).

**Step 4: Commit**

```bash
git add options/options.html options/options.css
git commit -m "Add dashboard cost card + model cost table markup"
```

---

## Task 7: Dashboard donut — JS rendering

**Files:**
- Modify: `options/options.js`

**Step 1: Import and render**

At the top of [options/options.js](../../options/options.js), add:

```javascript
import { getUsageStats, projectPerModel } from "../lib/usage.js";
import { MODELS, DEFAULT_MODEL } from "../lib/pricing.js";
```

Find the function that renders the dashboard (search for how the stats grid gets populated — likely a `renderDashboard` or similar). After existing dashboard render calls, add a call to `renderCostCard()`:

```javascript
async function renderCostCard() {
  const settings = await getSettings(); // use the existing settings helper
  const stats = await getUsageStats();
  const budget = Number(settings.monthlyBudgetUsd) || 0;
  const spent = stats.monthSpentUsd;
  const pct = budget > 0 ? Math.min(spent / budget, 1.5) : 0;

  // Donut: circumference ≈ 2π × 50 ≈ 314.16
  const C = 314.16;
  const fill = document.querySelector(".cost-donut-fill");
  const pctText = document.querySelector(".cost-donut-pct");
  if (budget > 0) {
    fill.setAttribute("stroke-dasharray", `${(pct * C).toFixed(2)} ${C}`);
    fill.classList.toggle("over-budget", spent > budget);
    pctText.textContent = `${Math.round((spent / budget) * 100)}%`;
  } else {
    fill.setAttribute("stroke-dasharray", `0 ${C}`);
    pctText.textContent = "—";
  }

  document.getElementById("costSpent").textContent = `$${spent.toFixed(2)}`;
  document.getElementById("costBudget").textContent =
    budget > 0 ? `of $${budget.toFixed(2)} budget` : "no budget set";

  const modelLabel = MODELS[settings.classifierModel || DEFAULT_MODEL]?.label || "Haiku 4.5";
  const projText = stats.dataDays === 0
    ? "Not enough data yet — check back after a few classifications."
    : `Projected: $${stats.projectedMonthlyUsd.toFixed(2)}/mo · ${stats.callsThisMonth} calls · ${modelLabel}`;
  document.getElementById("costProjection").textContent = projText;
}
```

Call `renderCostCard()` alongside the existing dashboard renders.

**Step 2: Verify**

1. Reload extension, open Dashboard.
2. Donut should render with an arc proportional to (spent/budget). At first, spent will be very small, so the arc will be a thin sliver.
3. In DevTools console:

```js
chrome.storage.local.set({usageLog: Array.from({length: 20}, (_, i) => ({
  at: Date.now() - i*3600000, model: "claude-haiku-4-5-20251001",
  input: 50, output: 30, cacheRead: 1500, cacheWrite: 0,
  costUsd: 0.0004
}))})
```

Then reload the page. Expected: donut fills to ~0.16% of $5 (tiny arc), spent shows `$0.01`, projected shows `$0.24/mo` or so.

4. Change budget: `chrome.storage.sync.set({monthlyBudgetUsd: 0.005})` → reload → donut should show over-budget red.

**Step 3: Commit**

```bash
git add options/options.js
git commit -m "Render cost donut + projected spend on dashboard"
```

---

## Task 8: Per-model projection table — JS rendering

**Files:**
- Modify: `options/options.js`

**Step 1: Add render function**

```javascript
async function renderModelCostTable() {
  const settings = await getSettings();
  const projections = await projectPerModel();
  const currentId = settings.classifierModel || DEFAULT_MODEL;
  const tbody = document.querySelector("#modelCostTable tbody");
  const { dataDays } = await getUsageStats();

  if (dataDays === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">Classify a few videos to see projections.</td></tr>`;
    return;
  }

  const speedLabel = { fastest: "Fastest", medium: "Medium", slow: "Slow" };
  tbody.innerHTML = projections.map(p => {
    const isCurrent = p.id === currentId;
    return `
      <tr>
        <td>${p.label}</td>
        <td>$${p.cost.toFixed(2)}/mo</td>
        <td class="speed-${p.speed}">${speedLabel[p.speed]}</td>
        <td>${isCurrent
          ? `<span class="current-badge">current</span>`
          : `<button class="btn-switch" data-model-id="${p.id}">Switch →</button>`}</td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll(".btn-switch").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.modelId;
      await chrome.storage.sync.set({ classifierModel: id });
      await renderModelCostTable();
      await renderCostCard();
      // Also refresh the Rules tab dropdown if currently shown
      const sel = document.getElementById("classifierModel");
      if (sel) sel.value = id;
    });
  });
}
```

Call `renderModelCostTable()` alongside `renderCostCard()`.

**Step 2: Verify**

1. Reload. Dashboard shows four rows. The current model row shows a "current" badge; others show "Switch →".
2. Click "Switch →" on Sonnet. The badge moves to Sonnet. Confirm:
```js
chrome.storage.sync.get("classifierModel").then(console.log)
```
→ `{classifierModel: "claude-sonnet-4-6"}`
3. Confirm speed colors: Haiku green, Sonnet amber, Opus red.

**Step 3: Commit**

```bash
git add options/options.js
git commit -m "Render per-model cost projection table with switch action"
```

---

## Task 9: Rules tab — model picker with latency warning

**Files:**
- Modify: `options/options.html`
- Modify: `options/options.js`

**Step 1: Add markup**

In `options.html`, in the Rules panel (`data-panel="rules"`), directly after the API key card (around line 197), insert:

```html
<div class="card">
  <div class="card-header"><h3>Classifier model</h3></div>
  <select id="classifierModel">
    <option value="claude-haiku-4-5-20251001">Haiku 4.5 — fastest, cheapest (recommended)</option>
    <option value="claude-sonnet-4-6">Sonnet 4.6 — medium speed, higher quality</option>
    <option value="claude-opus-4-6">Opus 4.6 — slowest, highest quality</option>
    <option value="claude-opus-4-7">Opus 4.7 — slowest, highest quality</option>
  </select>
  <div id="modelLatencyWarn" class="help warn hidden">
    ⚠ Slower models may close the tab after you've already started scrolling.
    Haiku runs in ~500ms; Sonnet ~1–2s; Opus ~3–5s.
  </div>
  <div class="help">The weekly AI Insights always uses Haiku regardless of this setting.</div>
</div>

<div class="card">
  <div class="card-header"><h3>Monthly budget</h3></div>
  <label class="inline-label">$ <input id="monthlyBudget" type="number" step="0.50" min="0" style="width:100px;" /></label>
  <div class="help">Used for the donut chart on the dashboard. Not enforced — real limits live in your Anthropic console.</div>
</div>
```

Add to `options.css`:

```css
.help.warn { color: #fbbf24; }
.help.warn.hidden { display: none; }
.inline-label { display: inline-flex; gap: 8px; align-items: center; }
```

**Step 2: Wire JS**

In `options.js`, in the function that loads settings into the Rules form, add:

```javascript
document.getElementById("classifierModel").value = settings.classifierModel || DEFAULT_MODEL;
document.getElementById("monthlyBudget").value = settings.monthlyBudgetUsd ?? 5;
updateLatencyWarning();
```

Add this helper:

```javascript
function updateLatencyWarning() {
  const sel = document.getElementById("classifierModel");
  const warn = document.getElementById("modelLatencyWarn");
  const speed = MODELS[sel.value]?.speed || "fastest";
  warn.classList.toggle("hidden", speed === "fastest");
}
```

Wire change handler near the other settings listeners:

```javascript
document.getElementById("classifierModel").addEventListener("change", updateLatencyWarning);
```

In the Save button handler, read both new fields and persist:

```javascript
const newSettings = {
  // ...existing fields
  classifierModel: document.getElementById("classifierModel").value,
  monthlyBudgetUsd: parseFloat(document.getElementById("monthlyBudget").value) || 0
};
```

After save, re-render the cost card and table so dashboard reflects the new budget / model:

```javascript
await renderCostCard();
await renderModelCostTable();
```

Also: the "Edit budget" link in the cost card should jump to the Rules tab and focus the budget input:

```javascript
document.getElementById("costEditBudget").addEventListener("click", (e) => {
  e.preventDefault();
  document.querySelector('.tab[data-tab="rules"]').click();
  document.getElementById("monthlyBudget").focus();
  document.getElementById("monthlyBudget").select();
});
```

**Step 3: Verify**

1. Reload, Rules tab. Model dropdown appears. Select Sonnet — amber warning appears. Select Haiku — warning disappears.
2. Change budget to `10`, click Save. Go back to Dashboard — donut now shows `of $10.00 budget`.
3. Click "Edit budget" on dashboard — lands in Rules tab with budget input focused.
4. Switch model on dashboard → re-open Rules tab → dropdown reflects the dashboard switch (bidirectional sync works).

**Step 4: Commit**

```bash
git add options/options.html options/options.css options/options.js
git commit -m "Add model picker + latency warning + monthly budget field in Rules"
```

---

## Task 10: Maintenance — add "Clear usage log" button

**Files:**
- Modify: `options/options.html`
- Modify: `options/options.js`

**Step 1: Add button**

In the Rules-tab Maintenance card, next to "Clear verdict cache" and "Clear decision log", add:

```html
<button id="clearUsage" class="btn-ghost">Clear usage log</button>
```

In `options.js`:

```javascript
import { clearUsageLog } from "../lib/usage.js";

document.getElementById("clearUsage").addEventListener("click", async () => {
  if (!confirm("Clear the API usage log? This resets the cost donut and projections.")) return;
  await clearUsageLog();
  await renderCostCard();
  await renderModelCostTable();
});
```

**Step 2: Verify**

Click button → confirm → donut resets to 0 / empty state copy.

**Step 3: Commit**

```bash
git add options/options.html options/options.js
git commit -m "Add maintenance button to clear usage log"
```

---

## Task 11: End-to-end manual verification

**No code.** Before merging:

1. Fresh install: uninstall extension, reinstall. Dashboard cost card shows empty state. Model table shows empty row.
2. Classify 3 YouTube videos that hit Claude. Dashboard refreshes — donut fills slightly, spent shows pennies, projection fires.
3. Switch to Sonnet via dashboard row. Classify another video. Look at usage log last entry — `model: "claude-sonnet-4-6"`, cost ~3× Haiku's.
4. Switch to Opus 4.7. Confirm warning banner in Rules. Classify a video — confirm it's slower but works.
5. Set budget to $0.01. Reload dashboard. Donut goes red, >100%.
6. Generate AI weekly insights. Confirm a usage entry was logged with a big `cacheWrite` (first insights call of the day).
7. Clear usage log via Maintenance button. Dashboard resets cleanly.

If any step fails, open DevTools for the page where it fails, check console for errors, fix, re-commit.

---

## Task 12: Update README cost numbers (optional)

**Files:**
- Modify: `README.md`

The current README says "~$0.30/month at typical use" assuming Haiku. After shipping this feature, the user can also see their own actual numbers. Consider adding a one-liner:

```
Check your actual spend + switch models in the extension's Dashboard tab.
```

Commit separately if changed.

---

## Summary of commits expected

1. Add model pricing table + cost helpers
2. Add usage log + stats rollup
3. Add classifierModel + monthlyBudgetUsd defaults
4. Read classifier model from settings + log token usage
5. Log token usage from weekly insights calls
6. Add dashboard cost card + model cost table markup
7. Render cost donut + projected spend on dashboard
8. Render per-model cost projection table with switch action
9. Add model picker + latency warning + monthly budget field in Rules
10. Add maintenance button to clear usage log
11. (no commit — manual verification only)
12. (optional README tweak)
