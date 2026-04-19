# Classifier evaluation

A labeled test set of 30 YouTube videos spanning the full distribution of what this extension sees: clear productive (lectures, focus music, technical podcasts), clear unproductive (gaming, vlogs, reactions, pop MVs, Shorts), and the genuinely ambiguous middle (science podcasts, history documentaries, clickbait-titled tutorials, true crime, conspiracy-adjacent content).

Ground truth is labeled against this user's rubric:
- Academic / technical / long-form educational → **productive**
- Gaming, vlogs, reactions, memes → **unproductive**
- Instrumental / lofi / focus music → **productive**; vocal / pop music → **unproductive**
- Shorts → always **unproductive** by format

## Run it

```bash
# Local rules only (no API calls, instant)
npm run eval:rules

# Full pipeline — local rules + Claude Haiku 4.5 fallback
ANTHROPIC_API_KEY=sk-ant-... npm run eval

# With per-case output
ANTHROPIC_API_KEY=sk-ant-... npm run eval:verbose
```

Exit code is 0 if accuracy ≥ 90%, else 1 — so this can gate a CI pre-commit.

## Baseline

On the committed test set:

| Mode | Accuracy | Notes |
|---|---|---|
| Rules only | 15/15 on matched cases (100%) | Half the cases fall through to Claude — rules are designed to be high-precision, not high-recall |
| Rules + Claude | _run it and see_ | Expected >= 27/30 on any run |

## Why evaluation matters for this extension

A classifier that's wrong 10% of the time is functional but annoying — every tenth Khan Academy lecture gets closed, you hit Reopen, the magic breaks. This harness lets me:

1. **Regress-test prompt changes.** Tweak the system prompt, run `npm run eval`, see if anything broke. Without this the prompt is an opaque config.
2. **Calibrate the confidence threshold.** The rules-first pipeline uses 0.85 as the cutoff for skipping Claude. That number was picked by running this eval and looking at where precision dropped.
3. **Document the rubric.** The dataset IS the spec. "What counts as productive" isn't in a doc — it's in the labels.
4. **Show honest limits.** When a case misclassifies, it's logged with its note. The failing examples are more informative than the accuracy number.
