# Focus Closer — repo notes for Claude

Chrome MV3 extension that auto-closes distracting tabs. Service worker classifies pages with Claude (Haiku 4.5 default for video, Sonnet 4.6 for reflection). No build step — vanilla ESM modules loaded directly by Chrome. `npm run eval` runs the offline classifier eval suite.

## Verify before claiming done

After ANY edit to `service-worker.js`, `lib/*.js`, `classifier/*.js`, `content/*.js`, or `options/options.js`:

```bash
node --check <file>            # syntax check — must pass
python3 -c "import json; json.load(open('manifest.json'))"   # if manifest changed
```

For runtime verification of a feature: `cd /tmp/focus-closer-qa && node qa.mjs` (or recreate from the QA harness used previously). This launches Playwright Chromium with `--load-extension`, exercises the dot/dashboard/training-mode, dumps a JSON report. Real-browser MV3 SW behavior is the only reliable check; headless has flaky alarms.

There are no unit tests. The `evals/` directory is for classifier accuracy evaluation, not correctness regression — don't expect it to catch bugs.

## MV3 service worker — the constant trap

The SW dies after ~30s idle and respawns on any registered event. Every change to SW state must survive that:

- **Never use `setInterval`/`setTimeout` for anything that must persist.** Timers die with the SW. Use `chrome.alarms` (min `periodInMinutes: 0.5`).
- **Never assume in-memory state survives.** All durable state goes through `chrome.storage.local`.
- **`chrome.storage.local` writes are atomic per call, but `get → modify → set` is not.** If two events race to update the same key, the second `set` clobbers the first. The tracker has a `withLock` mutex pattern in [lib/tracker.js](lib/tracker.js) — copy it for any new shared-key write path.
- **Top-level code in `service-worker.js` runs on every spawn.** Side effects there race with event handlers from the same spawn. Wrap any init in a memoized promise (`ensureInitialized` pattern in tracker).

## Security model for message handlers

Content scripts run on attacker-controlled pages and can call any `chrome.runtime.sendMessage`. Validate sender on every handler in [service-worker.js](service-worker.js):

- **Extension-only handlers** (options page, settings mutations, log mutations): require `isExtensionOriginated(sender)` — no `sender.tab` AND `sender.url` starts with `chrome-extension://<our-id>/`.
- **Content-script + hostname-bound** (indicator queries about its own host): require `hostnameMatches(sender, msg.hostname)` — verify the claimed hostname matches `sender.tab.url`.
- **Popup actions**: require the single-use nonce we issue when injecting (`_issuePopupNonce` / `_consumePopupNonce`).

Pre-existing handlers (`set_settings`, `clear_log`, `apply_brief`, others) are NOT yet hardened — adding hardening is welcome but flag it explicitly in the commit. The `set_settings` one is highest priority (lets a malicious page overwrite the user's API key).

## Storage schema (chrome.storage.local)

Most-touched keys — full list in [lib/storage.js](lib/storage.js) constants:

- `v4:<videoId>` — per-video Claude verdict cache
- `dv:<hostname>` — per-domain Claude verdict cache (30d TTL)
- `domainTimeTracking` — `{hostname: {totalMs, visitCount, lastSeenAt}}`
- `domainTimeBuckets` — `{"YYYY-MM-DD": {hostname: ms}}` (90d retention via `prune_buckets` alarm)
- `tracker:currentSession` — single in-flight session, persisted with `lastHeartbeat` for SW-death recovery
- `trainingModeEndsAt` — timestamp; before this, no universal auto-close
- `dismissedDomains`, `domainOpenOverrides`, `videoOverrides`, `videoUserBlocks` — user-override state

Use the named helpers in [lib/storage.js](lib/storage.js); don't `chrome.storage.local.get(key)` directly — most keys have defaults to apply.

## Conventions

- **Atomic commits.** One conceptual change per commit. Review-fix commits go on top of the feature commit, not squashed into it.
- **Commit message: imperative subject + heredoc body** with the *why*. See `git log feature/universal-classification` for the template — multi-paragraph bodies explaining the bug, the root cause, the fix.
- **Don't add backwards-compat shims** — if you remove a feature, remove the dead code.
- **Don't add error handling for impossible scenarios.** Trust internal invariants. Validate at boundaries (user input, message payloads, external API responses).
- **Comments only for non-obvious WHY** (a hidden invariant, a workaround for a specific Chrome bug). No comments restating what the code does.

## Workflow (gstack-style)

For new features: prefer `/office-hours` → `/autoplan` → build → code-reviewer subagent → Playwright QA → atomic commits → `/ship`. The skills are at `~/.claude/skills/<name>/SKILL.md`.

For bug investigations: `/investigate` first (forces root-cause analysis before any fix).

## Out of scope right now

- Unit testing infrastructure — no framework set up; don't introduce one without asking
- Bundling / minification — not needed for an extension under 200KB
- TypeScript — not adopted; keep using JSDoc-style hints if you need them
