// ==UserScript==
// @name MusicBarAccent.uc.mjs
// @description Cover-first background sync for Zen media controls
// @version 0.5.0
// @include main
// @grant none
// ==/UserScript==

(() => {
  "use strict";

  const DEBUG = true;
  const SCRIPT_VERSION = "0.5.0";
  const LOG_PREFIX = "[MusicBar]";

  const ROOT = document.documentElement;
  const VAR_COVER = "--music-bar-cover-url";
  const VAR_COVER_OPACITY = "--music-bar-cover-opacity";
  const RUN_ATTR = "music-bar-script-running";
  const COVER_ACTIVE_ATTR = "music-bar-cover-active";

  let ServicesRef = null;
  try {
    ServicesRef =
      globalThis.Services ||
      ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs")
        .Services;
  } catch {}

  const state = {
    controller: null,
    browser: null,
    lastArtworkUrl: null,
    originalSetup: null,
    domPollId: null,
    waitCount: 0
  };

  const toText = (value) => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const emit = (level, args) => {
    if (!DEBUG) return;
    try {
      const fn =
        typeof console?.[level] === "function" ? console[level] : console.log;
      fn.call(console, LOG_PREFIX, ...args);
    } catch {}
    if (ServicesRef?.console?.logStringMessage) {
      try {
        ServicesRef.console.logStringMessage(
          `${LOG_PREFIX} ${args.map(toText).join(" ")}`
        );
      } catch {}
    }
  };

  const log = (...args) => emit("log", args);
  const warn = (...args) => emit("warn", args);

  if (window.MusicBarAccent?.destroy) {
    try {
      window.MusicBarAccent.destroy();
    } catch {}
  }

  const resolveUrl = (url, baseUrl) => {
    if (!url || typeof url !== "string") return null;
    try {
      return new URL(url, baseUrl || window.location.href).href;
    } catch {
      return url;
    }
  };

  const getBrowserDocument = (browser) => {
    return (
      browser?.contentDocument || browser?.contentWindow?.document || null
    );
  };

  const applyCover = (url) => {
    if (!url) {
      ROOT.style.removeProperty(VAR_COVER);
      ROOT.style.setProperty(VAR_COVER_OPACITY, "0");
      ROOT.removeAttribute(COVER_ACTIVE_ATTR);
      return;
    }
    const escaped = url.replace(/"/g, '\\"');
    ROOT.style.setProperty(VAR_COVER, `url("${escaped}")`);
    ROOT.style.setProperty(VAR_COVER_OPACITY, "1");
    ROOT.setAttribute(COVER_ACTIVE_ATTR, "true");
  };

  const parseSrcset = (value) => {
    if (!value) return null;
    const parts = value
      .split(",")
      .map((entry) => entry.trim().split(" ")[0])
      .filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  };

  const extractBackgroundUrl = (value) => {
    if (!value || value === "none") return null;
    const match = value.match(/url\(["']?(.*?)["']?\)/);
    return match?.[1] || null;
  };

  const getElementImageUrl = (el) => {
    if (!el) return null;
    if (el.tagName === "IMG") {
      return el.currentSrc || el.src || parseSrcset(el.getAttribute("srcset"));
    }
    const style = getComputedStyle(el);
    return (
      extractBackgroundUrl(style.backgroundImage) ||
      extractBackgroundUrl(el.style?.backgroundImage)
    );
  };

  const getImageFromSelectors = (doc, selectors) => {
    for (const selector of selectors) {
      const el = doc.querySelector(selector);
      const url = getElementImageUrl(el);
      if (url) return url;
    }
    return null;
  };

  const getMetaImageUrl = (doc) => {
    const selectors = [
      'meta[property="og:image"]',
      'meta[property="og:image:url"]',
      'meta[name="twitter:image"]',
      'meta[property="twitter:image"]',
      'meta[itemprop="image"]',
      'link[rel="image_src"]'
    ];
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      const url = node?.content || node?.getAttribute?.("href");
      if (url) return url;
    }
    return null;
  };

  const sizeScore = (entry) => {
    if (!entry || typeof entry !== "object") return 0;
    if (typeof entry.width === "number" && typeof entry.height === "number") {
      return entry.width * entry.height;
    }
    const raw = String(entry.sizes || "").trim();
    if (!raw) return 0;
    const chunks = raw.split(/\s+/);
    let best = 0;
    for (const chunk of chunks) {
      const [w, h] = chunk.split("x").map(Number);
      const area = (w || 0) * (h || 0);
      if (area > best) best = area;
    }
    return best;
  };

  const pickArtworkUrl = (artwork, baseUrl) => {
    if (!Array.isArray(artwork) || artwork.length === 0) return null;
    const sorted = [...artwork].sort((a, b) => sizeScore(b) - sizeScore(a));
    for (const entry of sorted) {
      const src = entry?.src || entry?.url;
      if (typeof src === "string" && src.trim()) {
        return resolveUrl(src, baseUrl);
      }
    }
    return null;
  };

  const getMetadataArtworkUrl = (controller, browserDoc) => {
    const metadata = controller?.getMetadata?.();
    if (!metadata) return null;

    const baseUrl = browserDoc?.location?.href || window.location.href;
    const directCandidates = [
      metadata.artworkUrl,
      metadata.coverUrl,
      metadata.image,
      metadata.thumbnail,
      metadata.albumArt,
      metadata.artwork?.src
    ];

    for (const candidate of directCandidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return resolveUrl(candidate, baseUrl);
      }
    }

    const listCandidates = [
      metadata.artwork,
      metadata.images,
      metadata.pictures
    ];
    for (const list of listCandidates) {
      const url = pickArtworkUrl(list, baseUrl);
      if (url) return url;
    }

    return null;
  };

  const getDomArtworkUrl = (browser) => {
    try {
      const doc = getBrowserDocument(browser);
      if (!doc) return null;

      const host = doc.location?.host || "";
      let url = null;

      if (host.includes("music.youtube.com")) {
        url = getImageFromSelectors(doc, [
          "ytmusic-player-bar img#song-image",
          "ytmusic-player-bar img.image",
          "ytmusic-player-bar img",
          "#song-image",
          "#player-bar img"
        ]);
      } else if (host.includes("open.spotify.com")) {
        url = getImageFromSelectors(doc, [
          'img[data-testid="cover-art-image"]',
          'img[data-testid="track-image"]',
          '[data-testid="now-playing-widget"] img',
          'footer img[src*="i.scdn.co/image/"]',
          'img[src*="i.scdn.co/image/"]'
        ]);
      } else if (host.includes("youtube.com")) {
        url = getMetaImageUrl(doc);
      } else {
        url =
          getImageFromSelectors(doc, [
            'img[alt*="album" i]',
            'img[alt*="cover" i]',
            'img[class*="cover" i]'
          ]) || getMetaImageUrl(doc);
      }

      if (!url) {
        url = getMetaImageUrl(doc);
      }
      return resolveUrl(url, doc.location?.href);
    } catch (error) {
      warn("DOM artwork lookup failed", error?.message || error);
      return null;
    }
  };

  const refreshArtwork = () => {
    const browserDoc = getBrowserDocument(state.browser);
    const metadataUrl = getMetadataArtworkUrl(state.controller, browserDoc);
    const domUrl = metadataUrl ? null : getDomArtworkUrl(state.browser);
    const artworkUrl = metadataUrl || domUrl;

    if (!artworkUrl) {
      if (state.lastArtworkUrl) {
        log("No artwork available, clearing cover");
      }
      state.lastArtworkUrl = null;
      applyCover(null);
      return;
    }

    if (artworkUrl === state.lastArtworkUrl) return;

    state.lastArtworkUrl = artworkUrl;
    applyCover(artworkUrl);
    log("Applied cover artwork", artworkUrl);
  };

  const updateFromEvent = (event) => {
    if (!event?.target || event.target === state.controller) {
      refreshArtwork();
    }
  };

  const addListener = (target, type) => {
    try {
      target?.addEventListener?.(type, updateFromEvent);
    } catch (error) {
      warn(`Failed to add listener: ${type}`, error?.message || error);
    }
  };

  const removeListener = (target, type) => {
    try {
      target?.removeEventListener?.(type, updateFromEvent);
    } catch {}
  };

  const stopDomPolling = () => {
    if (state.domPollId) {
      clearInterval(state.domPollId);
      state.domPollId = null;
    }
  };

  const startDomPolling = () => {
    stopDomPolling();
    state.domPollId = setInterval(() => {
      if (state.controller && state.browser) {
        refreshArtwork();
      }
    }, 1800);
  };

  const detachController = () => {
    if (!state.controller) return;
    removeListener(state.controller, "metadatachange");
    removeListener(state.controller, "playbackstatechange");
    state.controller = null;
    state.browser = null;
    stopDomPolling();
  };

  const attachToController = (controller, browser) => {
    if (!controller || controller === state.controller) return;
    detachController();
    state.controller = controller;
    state.browser = browser || null;
    addListener(controller, "metadatachange");
    addListener(controller, "playbackstatechange");
    refreshArtwork();
    startDomPolling();
    log("Attached controller", { hasBrowser: !!state.browser });
  };

  const findFirst = (obj, keys) => {
    for (const key of keys) {
      if (obj?.[key]) return obj[key];
    }
    return null;
  };

  const patchMediaController = () => {
    const zmc = window.gZenMediaController;
    if (!zmc || typeof zmc.setupMediaController !== "function") return false;
    if (state.originalSetup) return true;

    state.originalSetup = zmc.setupMediaController.bind(zmc);
    zmc.setupMediaController = (controller, browser) => {
      if (controller) {
        attachToController(controller, browser);
      }
      return state.originalSetup(controller, browser);
    };

    const currentController = findFirst(zmc, [
      "_currentMediaController",
      "currentMediaController",
      "_mediaController",
      "mediaController"
    ]);
    const currentBrowser = findFirst(zmc, [
      "_currentBrowser",
      "currentBrowser",
      "browser"
    ]);
    if (currentController) {
      attachToController(currentController, currentBrowser);
    }

    log("Patched gZenMediaController.setupMediaController");
    return true;
  };

  const waitForController = () => {
    state.waitCount += 1;
    if (patchMediaController()) return;

    if (state.waitCount % 20 === 0) {
      warn("Waiting for gZenMediaController...");
    }
    setTimeout(waitForController, 250);
  };

  const api = {
    destroy() {
      detachController();
      const zmc = window.gZenMediaController;
      if (state.originalSetup && zmc) {
        zmc.setupMediaController = state.originalSetup;
      }
      state.originalSetup = null;
      applyCover(null);
      ROOT.removeAttribute(RUN_ATTR);
      delete window.MusicBarAccent;
      log("Destroyed");
    }
  };

  ROOT.setAttribute(RUN_ATTR, SCRIPT_VERSION);
  window.MusicBarAccent = api;
  log(`Booted v${SCRIPT_VERSION}`);
  try {
    console.error(`${LOG_PREFIX} boot marker v${SCRIPT_VERSION}`);
  } catch {}
  waitForController();
})();
