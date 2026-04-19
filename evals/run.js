#!/usr/bin/env node
// Classifier evaluation harness.
//
// Usage:
//   node evals/run.js              # rules + Claude (requires ANTHROPIC_API_KEY)
//   node evals/run.js --rules-only # local rules only, no API calls
//   node evals/run.js --verbose    # print per-case result
//
// Exit code: 0 if accuracy >= threshold (default 90%), else 1.
//
// Requires Node 22+ for native fetch.

import { TEST_CASES } from "./dataset.js";
import { classifyLocally } from "../classifier/rules.js";

const args = new Set(process.argv.slice(2));
const RULES_ONLY = args.has("--rules-only");
const VERBOSE = args.has("--verbose");
const THRESHOLD = 0.90;

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!RULES_ONLY && !API_KEY) {
  console.error("Set ANTHROPIC_API_KEY or pass --rules-only");
  process.exit(2);
}

const DEFAULT_SETTINGS = {
  musicRule: "instrumental_only",
  channelWhitelist: [
    "3Blue1Brown", "Khan Academy", "MIT OpenCourseWare", "CrashCourse",
    "Veritasium", "Kurzgesagt – In a Nutshell", "Two Minute Papers", "Computerphile"
  ],
  channelBlocklist: []
};

async function classifyWithClaudeNode(meta) {
  const system = buildSystemPrompt(DEFAULT_SETTINGS);
  const user = `Title: ${meta.title || "(unknown)"}
Channel: ${meta.channel || "(unknown)"}
Category: ${meta.category || "(unknown)"}
Tags: ${(meta.tags || []).join(", ") || "(none)"}
Description (first 500 chars): ${(meta.description || "").slice(0, 500)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }]
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json.content?.[0]?.text?.trim() || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON in response");
  return JSON.parse(match[0]);
}

function buildSystemPrompt(settings) {
  const musicRule = {
    instrumental_only: `- Music: ONLY instrumental/lofi/focus/study/ambient/classical-for-study = productive. Songs with vocals, pop/rap/rock, music videos (MVs), artist uploads = unproductive.`,
    all_productive: `- Music: any music-categorized video = productive.`,
    all_unproductive: `- Music: any music-categorized video = unproductive.`
  }[settings.musicRule || "instrumental_only"];

  return `You classify YouTube videos as "productive" or "unproductive" for a user trying to stay focused.

PRODUCTIVE:
- Academic lectures, courses, tutorials (physics, chemistry, math, AP subjects, programming, engineering)
- Long-form technical interviews and podcasts with scientists/engineers/founders
- History documentaries, science documentaries
- Conference talks, keynotes, paper walkthroughs
- Coding livestreams and screencasts
${musicRule}

UNPRODUCTIVE:
- Gaming content (Minecraft, Fortnite, GTA, any "let's play"/"gameplay"/"speedrun")
- Vlogs, day-in-the-life, morning routines
- Reaction videos, meme compilations, TikTok compilations, "funny moments"
- Movie/TV recaps, celebrity gossip, drama
- Pranks, unboxings
- Pop/rap/rock music videos or songs with visuals (per music rule above)
- YouTube Shorts (always unproductive by format)

The user is strict-leaning: when truly ambiguous, prefer "unproductive".

Respond with ONLY a JSON object, no prose:
{"verdict": "productive" | "unproductive", "confidence": 0.0-1.0, "reason": "<one short sentence>"}`;
}

async function classifyOne(meta) {
  const local = classifyLocally(meta, DEFAULT_SETTINGS);
  if (local && local.confidence >= 0.85) return { ...local, source: "rule" };
  if (RULES_ONLY) return { verdict: null, source: "no_rule" };
  const remote = await classifyWithClaudeNode(meta);
  return { ...remote, source: "claude" };
}

function fmt(s, n) { return String(s).padEnd(n).slice(0, n); }

(async () => {
  console.log(`\n▶ Focus Closer — classifier eval`);
  console.log(`  mode: ${RULES_ONLY ? "rules only" : "rules + Claude Haiku 4.5"}`);
  console.log(`  cases: ${TEST_CASES.length}\n`);

  let correct = 0, wrong = 0, skipped = 0;
  const wrongs = [];
  const bySource = {};
  const t0 = Date.now();

  for (const c of TEST_CASES) {
    try {
      const r = await classifyOne(c.meta);
      if (r.verdict === null) {
        skipped += 1;
        if (VERBOSE) console.log(`  ⊘ ${fmt(c.meta.title, 60)}  skipped (rules-only, no rule matched)`);
        continue;
      }
      bySource[r.source] = (bySource[r.source] || 0) + 1;
      const ok = r.verdict === c.expected;
      if (ok) correct += 1;
      else {
        wrong += 1;
        wrongs.push({ ...c, got: r });
      }
      if (VERBOSE) {
        const mark = ok ? "✓" : "✗";
        console.log(`  ${mark} ${fmt(c.meta.title, 60)}  expected=${c.expected}  got=${r.verdict}  (${r.source})`);
      }
    } catch (e) {
      wrong += 1;
      wrongs.push({ ...c, got: { verdict: "ERROR", source: "error", reason: String(e?.message || e) } });
      if (VERBOSE) console.log(`  ✗ ${fmt(c.meta.title, 60)}  ERROR: ${e?.message || e}`);
    }
  }

  const total = correct + wrong;
  const acc = total === 0 ? 0 : correct / total;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n──────────────────────────────────────`);
  console.log(`  Accuracy: ${(acc * 100).toFixed(1)}%  (${correct}/${total})`);
  if (skipped) console.log(`  Skipped:  ${skipped} (no rule matched, Claude disabled)`);
  console.log(`  Elapsed:  ${elapsed}s`);
  console.log(`  Source:   ${Object.entries(bySource).map(([s, n]) => `${s}=${n}`).join("  ")}`);
  console.log(`──────────────────────────────────────\n`);

  if (wrongs.length) {
    console.log("Misclassifications:");
    for (const w of wrongs) {
      console.log(`  ✗ "${w.meta.title}"`);
      console.log(`      channel: ${w.meta.channel}`);
      console.log(`      expected: ${w.expected}  got: ${w.got.verdict}  (${w.got.source})`);
      console.log(`      note: ${w.note}`);
      if (w.got.reason) console.log(`      model reason: ${w.got.reason}`);
      console.log();
    }
  }

  process.exit(acc >= THRESHOLD ? 0 : 1);
})();
