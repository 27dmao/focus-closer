// Focus Closer floating indicator dot. Injected on every page (via manifest
// content_scripts <all_urls>). Reads verdict from the service worker, renders
// a small fixed-position dot, click to dismiss for this domain forever.

(function () {
  "use strict";

  if (window.top !== window) return; // top frame only
  if (document.documentElement.hasAttribute("data-focus-closer-dot")) return; // single instance

  const ID = "__focus_closer_dot__";

  function isExtensionAlive() {
    try { return !!chrome?.runtime?.id; } catch { return false; }
  }

  function send(type, extra = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...extra }, (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res);
        });
      } catch { resolve(null); }
    });
  }

  function fmtMs(ms) {
    if (!ms || ms < 1000) return "0s";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function colorFor(verdict) {
    if (verdict === "productive") return "#3ecf8e";   // green
    if (verdict === "unproductive") return "#ff6b6b"; // red
    if (verdict === "mixed") return "#f5a623";        // amber
    return "#6c7280";                                  // grey (unknown)
  }

  function labelFor(verdict) {
    if (verdict === "productive") return "Productive";
    if (verdict === "unproductive") return "Unproductive";
    if (verdict === "mixed") return "Mixed (per-page)";
    return "Classifying…";
  }

  function ensureDot() {
    let el = document.getElementById(ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = ID;
    el.setAttribute("aria-label", "Focus Closer indicator");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    document.documentElement.appendChild(el);
    document.documentElement.setAttribute("data-focus-closer-dot", "1");
    return el;
  }

  function setTooltip(el, text) {
    el.setAttribute("title", text);
  }

  let state = { hostname: location.hostname.toLowerCase(), verdict: null, todayMs: 0, totalMs: 0 };

  function paint() {
    const el = ensureDot();
    el.style.background = colorFor(state.verdict);
    el.dataset.verdict = state.verdict || "unknown";
    setTooltip(el,
      `Focus Closer — ${labelFor(state.verdict)}\n` +
      `${state.hostname}\n` +
      `Today: ${fmtMs(state.todayMs)} · All time: ${fmtMs(state.totalMs)}\n` +
      (state.reason ? `Reason: ${state.reason}\n` : "") +
      `Click to hide on this site forever.`
    );
  }

  async function refresh() {
    if (!isExtensionAlive()) return;
    const res = await send("get_indicator_state", { hostname: state.hostname });
    if (!res || !res.ok) return;
    if (res.dismissed) {
      const el = document.getElementById(ID);
      if (el) el.remove();
      document.documentElement.removeAttribute("data-focus-closer-dot");
      return;
    }
    state.verdict = res.verdict;
    state.reason = res.reason || "";
    state.todayMs = res.todayMs || 0;
    state.totalMs = res.totalMs || 0;
    paint();
  }

  function attachClick() {
    const el = ensureDot();
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.style.opacity = "0";
      setTimeout(() => { el.remove(); document.documentElement.removeAttribute("data-focus-closer-dot"); }, 220);
      try { await send("dismiss_indicator", { hostname: state.hostname }); } catch {}
    }, { capture: true });
  }

  // Initial render (grey "classifying") then update once the SW responds.
  ensureDot();
  paint();
  attachClick();
  refresh();

  // React to verdict changes pushed via chrome.storage.onChanged.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const dvKey = "dv:" + state.hostname;
      if (dvKey in changes || "dismissedDomains" in changes || "domainTimeTracking" in changes) {
        refresh();
      }
    });
  } catch {}

  // Periodic tooltip refresh so live "today" minutes stay current.
  setInterval(() => { if (document.getElementById(ID)) refresh(); }, 30_000);
})();
