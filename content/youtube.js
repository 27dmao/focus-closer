(function () {
  "use strict";

  const DEBUG_PREFIX = "[focus-closer]";
  const METADATA_TIMEOUT_MS = 3000;

  let currentVideoId = null;
  let inFlight = false;
  let retryPending = false;

  function isExtensionAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function getVideoIdFromLocation() {
    const url = new URL(window.location.href);
    if (url.pathname === "/watch") return { kind: "watch", videoId: url.searchParams.get("v") };
    if (url.pathname.startsWith("/shorts/")) {
      const v = url.pathname.split("/")[2];
      return v ? { kind: "short", videoId: v } : null;
    }
    return null;
  }

  function readPlayerResponse() {
    try {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        const t = s.textContent;
        if (!t || t.indexOf("ytInitialPlayerResponse") === -1) continue;
        const m = t.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});/);
        if (m) return JSON.parse(m[1]);
      }
    } catch (e) {
      console.warn(DEBUG_PREFIX, "failed to parse ytInitialPlayerResponse", e);
    }
    return null;
  }

  function extractFromPlayerResponse(pr) {
    const vd = pr?.videoDetails;
    const mc = pr?.microformat?.playerMicroformatRenderer;
    if (!vd) return null;
    return {
      title: vd.title || "",
      channel: vd.author || "",
      description: vd.shortDescription || "",
      tags: vd.keywords || [],
      category: mc?.category || "",
      lengthSeconds: parseInt(vd.lengthSeconds || "0", 10)
    };
  }

  function extractFromDom() {
    const titleEl = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, h1.ytd-video-primary-info-renderer");
    const channelEl = document.querySelector("#channel-name a, ytd-channel-name a, #owner #channel-name a");
    const descEl = document.querySelector("#description-inline-expander, #description yt-formatted-string");
    const title = titleEl?.textContent?.trim() || document.title.replace(/ - YouTube$/, "");
    const channel = channelEl?.textContent?.trim() || "";
    const description = descEl?.textContent?.trim() || "";
    if (!title) return null;
    return { title, channel, description, tags: [], category: "", lengthSeconds: 0 };
  }

  function waitForMetadata(videoId) {
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (meta, path) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        if (meta) resolve({ ...meta, path });
        else resolve(null);
      };

      // YouTube watch pages mutate constantly (player, comments, recs).
      // Without these guards, tryExtract ran on every batch — multiple
      // querySelectorAll's + a script-tag scan + regex per call. Measurable
      // CPU on slow machines.
      let extractInProgress = false;
      let pendingDebounce = null;
      const tryExtract = () => {
        if (resolved || extractInProgress) return;
        extractInProgress = true;
        try {
          const here = getVideoIdFromLocation();
          if (!here || here.videoId !== videoId) return;
          const pr = readPlayerResponse();
          const fromPr = pr && extractFromPlayerResponse(pr);
          if (fromPr && fromPr.title) return finish(fromPr, "playerResponse");
          const fromDom = extractFromDom();
          if (fromDom && fromDom.title) return finish(fromDom, "dom");
        } finally {
          extractInProgress = false;
        }
      };

      const debouncedExtract = () => {
        if (pendingDebounce || resolved) return;
        pendingDebounce = setTimeout(() => {
          pendingDebounce = null;
          tryExtract();
        }, 100);
      };

      const obs = new MutationObserver(debouncedExtract);
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const interval = setInterval(tryExtract, 250);
      const timeout = setTimeout(() => finish(null, "timeout"), METADATA_TIMEOUT_MS);

      function cleanup() {
        obs.disconnect();
        clearInterval(interval);
        clearTimeout(timeout);
        if (pendingDebounce) { clearTimeout(pendingDebounce); pendingDebounce = null; }
      }
      tryExtract();
    });
  }

  async function classifyCurrent() {
    if (!isExtensionAlive()) return;
    const loc = getVideoIdFromLocation();
    if (!loc || !loc.videoId) return;
    if (inFlight) { retryPending = true; return; }
    if (loc.videoId === currentVideoId) return;
    currentVideoId = loc.videoId;
    inFlight = true;

    try {
      const meta = await waitForMetadata(loc.videoId);
      if (!meta) {
        console.warn(DEBUG_PREFIX, "metadata timeout for", loc.videoId);
        return;
      }
      if (!isExtensionAlive()) return;

      const payload = {
        type: "yt_metadata",
        meta: {
          videoId: loc.videoId,
          isShort: loc.kind === "short",
          title: meta.title,
          channel: meta.channel,
          description: meta.description,
          tags: meta.tags || [],
          category: meta.category || "",
          lengthSeconds: meta.lengthSeconds || 0,
          extractPath: meta.path
        }
      };

      console.log(DEBUG_PREFIX, "classifying", payload.meta);
      try {
        const resp = await chrome.runtime.sendMessage(payload);
        if (resp?.result) {
          console.log(DEBUG_PREFIX, "verdict", resp.result, resp.willClose ? "(closing tab)" : "");
        }
      } catch (e) {
        if (!/Extension context invalidated/i.test(String(e?.message || e))) {
          console.warn(DEBUG_PREFIX, "sendMessage failed", e);
        }
      }
    } finally {
      inFlight = false;
      if (retryPending) {
        retryPending = false;
        // User navigated to a different video while we were classifying;
        // re-run so the new video gets classified too.
        setTimeout(classifyCurrent, 50);
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "yt_route_change") {
      if (msg.videoId !== currentVideoId) {
        currentVideoId = null;
        setTimeout(classifyCurrent, 50);
      }
      return false;
    }
    if (msg?.type === "yt_get_meta") {
      const loc = getVideoIdFromLocation();
      if (!loc) { sendResponse({ meta: null }); return false; }
      const pr = readPlayerResponse();
      const fromPr = pr && extractFromPlayerResponse(pr);
      const fromDom = !fromPr && extractFromDom();
      const m = fromPr || fromDom;
      sendResponse({ meta: m ? { videoId: loc.videoId, isShort: loc.kind === "short", ...m } : null });
      return false;
    }
  });

  window.addEventListener("yt-navigate-finish", () => {
    if (!isExtensionAlive()) return;
    currentVideoId = null;
    setTimeout(classifyCurrent, 50);
  });

  if (isExtensionAlive()) setTimeout(classifyCurrent, 300);
})();
