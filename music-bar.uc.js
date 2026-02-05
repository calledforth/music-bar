// ==UserScript==
// @name MusicBarAccent.uc.js
// @description Dynamic accent color for Zen media controls
// @version 0.3.1
// @include main
// @grant none
// ==/UserScript==

(() => {
  "use strict";

  const DEBUG = true;
  const log = (...args) => DEBUG && console.log("[MusicBar]", ...args);
  const warn = (...args) => DEBUG && console.warn("[MusicBar]", ...args);

  if (window.MusicBarAccent?.destroy) {
    try {
      window.MusicBarAccent.destroy();
    } catch {}
  }

  const ROOT = document.documentElement;
  const VAR_ACCENT = "--music-bar-accent";
  const VAR_ACCENT_DIM = "--music-bar-accent-dim";
  const VAR_ACCENT_GLOW = "--music-bar-accent-glow";
  const VAR_COVER = "--music-bar-cover-url";
  const VAR_COVER_OPACITY = "--music-bar-cover-opacity";
  const ACTIVE_ATTR = "music-bar-accent-active";

  const DEFAULT_COLOR = { r: 124, g: 92, b: 255 };
  const CANVAS_SIZE = 32;

  const state = {
    controller: null,
    browser: null,
    lastArtworkUrl: null,
    canvas: null,
    ctx: null,
    originalSetup: null,
    domPollId: null,
    refreshToken: 0
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const rgbToHsl = (r, g, b) => {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        case b:
          h = (r - g) / d + 4;
          break;
      }
      h /= 6;
    }
    return { h, s, l };
  };

  const hslToRgb = (h, s, l) => {
    let r;
    let g;
    let b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return { r: r * 255, g: g * 255, b: b * 255 };
  };

  const ensureCanvas = () => {
    if (!state.canvas) {
      state.canvas = document.createElement("canvas");
      state.canvas.width = CANVAS_SIZE;
      state.canvas.height = CANVAS_SIZE;
      state.ctx = state.canvas.getContext("2d", { willReadFrequently: true });
    }
  };

  const applyAccent = ({ r, g, b }) => {
    const cr = Math.round(r);
    const cg = Math.round(g);
    const cb = Math.round(b);
    ROOT.style.setProperty(VAR_ACCENT, `rgb(${cr}, ${cg}, ${cb})`);
    ROOT.style.setProperty(VAR_ACCENT_DIM, `rgba(${cr}, ${cg}, ${cb}, 0.35)`);
    ROOT.style.setProperty(VAR_ACCENT_GLOW, `rgba(${cr}, ${cg}, ${cb}, 0.6)`);
    ROOT.setAttribute(ACTIVE_ATTR, "true");
  };

  const clearAccent = () => {
    ROOT.style.removeProperty(VAR_ACCENT);
    ROOT.style.removeProperty(VAR_ACCENT_DIM);
    ROOT.style.removeProperty(VAR_ACCENT_GLOW);
    ROOT.removeAttribute(ACTIVE_ATTR);
  };

  const applyCover = (url) => {
    if (!url) {
      ROOT.style.removeProperty(VAR_COVER);
      ROOT.style.setProperty(VAR_COVER_OPACITY, "0");
      return;
    }
    ROOT.style.setProperty(VAR_COVER, `url("${url}")`);
    ROOT.style.setProperty(VAR_COVER_OPACITY, "1");
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

  const getMetaImageUrl = (doc) => {
    const metaSelectors = [
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
      'meta[property="twitter:image"]',
      'link[rel="image_src"]'
    ];
    for (const selector of metaSelectors) {
      const node = doc.querySelector(selector);
      const url = node?.content || node?.getAttribute?.("href");
      if (url) return url;
    }
    return null;
  };

  const getImageFromSelectors = (doc, selectors) => {
    for (const selector of selectors) {
      const el = doc.querySelector(selector);
      const url = getElementImageUrl(el);
      if (url) return url;
    }
    return null;
  };

  const getDomArtworkUrl = (browser) => {
    try {
      log("getDomArtworkUrl called, browser:", browser);
      const doc = browser?.contentDocument || browser?.contentWindow?.document;
      log("Got document:", !!doc);
      if (!doc) return null;
      
      const host = doc.location?.host || "";
      log("Document host:", host);

      if (host.includes("music.youtube.com")) {
        log("Detected YouTube Music");
        const ytMusicSelectors = [
          "ytmusic-player-bar img#song-image",
          "ytmusic-player-bar .image",
          "ytmusic-player-bar img",
          "#player-bar img",
          "img#song-image"
        ];
        const result = getImageFromSelectors(doc, ytMusicSelectors) || getMetaImageUrl(doc);
        log("YT Music result:", result);
        return result;
      }

      if (host.includes("open.spotify.com")) {
        log("Detected Spotify");
        const spotifySelectors = [
          '[data-testid="now-playing-widget"] img',
          'img[data-testid="cover-art-image"]',
          'img[data-testid="track-image"]',
          'footer img[src*="i.scdn.co/image/"]',
          'img[src*="i.scdn.co/image/"]'
        ];
        const result = getImageFromSelectors(doc, spotifySelectors) || getMetaImageUrl(doc);
        log("Spotify result:", result);
        return result;
      }

      if (host.includes("youtube.com")) {
        log("Detected YouTube");
        const result = getMetaImageUrl(doc);
        log("YouTube result:", result);
        return result;
      }

      log("Unknown site, trying meta image");
      return getMetaImageUrl(doc);
    } catch (e) {
      warn("getDomArtworkUrl error:", e);
      return null;
    }
  };

  const getMetadataArtworkUrl = (controller) => {
    const metadata = controller?.getMetadata?.();
    log("Metadata from controller:", metadata);
    const artwork = metadata?.artwork;
    log("Artwork array:", artwork);
    return pickArtworkUrl(artwork);
  };

  const normalizeAccent = ({ r, g, b }) => {
    const { h, s, l } = rgbToHsl(r, g, b);
    const nextS = clamp(s, 0.4, 0.95);
    const nextL = clamp(l, 0.35, 0.72);
    return hslToRgb(h, nextS, nextL);
  };

  const pickArtworkUrl = (artwork) => {
    if (!Array.isArray(artwork) || artwork.length === 0) return null;
    const sorted = [...artwork].sort((a, b) => {
      const [aw, ah] = (a.sizes || "").split("x").map(Number);
      const [bw, bh] = (b.sizes || "").split("x").map(Number);
      return (bw || 0) * (bh || 0) - (aw || 0) * (ah || 0);
    });
    return sorted[0]?.src || null;
  };

  const sampleDominantColor = (data) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 16) {
      const a = data[i + 3];
      if (a < 64) continue;
      const pr = data[i];
      const pg = data[i + 1];
      const pb = data[i + 2];
      const max = Math.max(pr, pg, pb);
      const min = Math.min(pr, pg, pb);
      const saturation = (max - min) / 255;
      const weight = 0.5 + saturation;
      r += pr * weight;
      g += pg * weight;
      b += pb * weight;
      total += weight;
    }
    if (!total) return null;
    return { r: r / total, g: g / total, b: b / total };
  };

  const colorFromImage = async (url) => {
    if (!url) return null;
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      if (img.decode) {
        await img.decode();
      } else {
        await new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
        });
      }
      if (!img.naturalWidth || !img.naturalHeight) return null;
      ensureCanvas();
      state.ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      state.ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
      const data = state.ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
      return sampleDominantColor(data);
    } catch {
      return null;
    }
  };

  const refreshArtwork = async () => {
    const token = ++state.refreshToken;
    log("refreshArtwork called, controller:", !!state.controller, "browser:", !!state.browser);
    
    const metadataUrl = getMetadataArtworkUrl(state.controller);
    log("metadataUrl:", metadataUrl);
    
    const domUrl = metadataUrl ? null : getDomArtworkUrl(state.browser);
    log("domUrl:", domUrl);
    
    const artworkUrl = metadataUrl || domUrl;
    log("Final artworkUrl:", artworkUrl);

    if (!artworkUrl) {
      log("No artwork URL, using defaults");
      applyCover(null);
      applyAccent(DEFAULT_COLOR);
      state.lastArtworkUrl = null;
      return;
    }
    if (artworkUrl === state.lastArtworkUrl) {
      log("Same artwork URL, skipping");
      return;
    }

    log("Applying new artwork:", artworkUrl);
    state.lastArtworkUrl = artworkUrl;
    applyCover(artworkUrl);
    const sampled = await colorFromImage(artworkUrl);
    log("Sampled color:", sampled);
    if (token !== state.refreshToken) return;
    const color = sampled ? normalizeAccent(sampled) : DEFAULT_COLOR;
    applyAccent(color);
  };

  const attachToController = (controller, browser) => {
    log("attachToController called, controller:", controller, "browser:", browser);
    if (!controller || controller === state.controller) {
      log("Skipping attach - no controller or same controller");
      return;
    }
    detachController();
    state.controller = controller;
    state.browser = browser || null;
    log("Controller attached, browser set:", !!state.browser);
    controller.addEventListener("metadatachange", updateFromEvent);
    controller.addEventListener("playbackstatechange", updateFromEvent);
    refreshArtwork();
    startDomPolling();
  };

  const detachController = () => {
    if (!state.controller) return;
    state.controller.removeEventListener("metadatachange", updateFromEvent);
    state.controller.removeEventListener("playbackstatechange", updateFromEvent);
    state.controller = null;
    state.browser = null;
    stopDomPolling();
  };

  const updateFromEvent = (event) => {
    if (!event?.target || event.target === state.controller) {
      refreshArtwork();
    }
  };

  const patchMediaController = () => {
    log("patchMediaController called");
    log("gZenMediaController exists:", !!window.gZenMediaController);
    log("setupMediaController exists:", !!window.gZenMediaController?.setupMediaController);
    
    if (!window.gZenMediaController?.setupMediaController || state.originalSetup) {
      warn("Cannot patch or already patched");
      return;
    }
    
    state.originalSetup = gZenMediaController.setupMediaController.bind(gZenMediaController);
    gZenMediaController.setupMediaController = (controller, browser) => {
      log("setupMediaController intercepted, controller:", controller, "browser:", browser);
      if (controller) {
        attachToController(controller, browser);
      }
      return state.originalSetup(controller, browser);
    };
    
    log("Patch applied, checking for existing controller...");
    log("_currentMediaController:", gZenMediaController._currentMediaController);
    log("_currentBrowser:", gZenMediaController._currentBrowser);
    
    const current = gZenMediaController._currentMediaController;
    if (current) {
      log("Found existing controller, attaching...");
      attachToController(current, gZenMediaController._currentBrowser);
    }
  };

  const startDomPolling = () => {
    stopDomPolling();
    state.domPollId = setInterval(() => {
      if (state.controller && state.browser) {
        refreshArtwork();
      }
    }, 1600);
  };

  const stopDomPolling = () => {
    if (state.domPollId) {
      clearInterval(state.domPollId);
      state.domPollId = null;
    }
  };

  const waitForController = () => {
    log("waitForController called, gZenMediaController:", !!window.gZenMediaController);
    if (window.gZenMediaController?.setupMediaController) {
      log("gZenMediaController found, patching...");
      patchMediaController();
      return;
    }
    log("gZenMediaController not ready, waiting...");
    if (window.requestIdleCallback) {
      requestIdleCallback(() => setTimeout(waitForController, 200));
    } else {
      setTimeout(waitForController, 200);
    }
  };

  const api = {
    destroy() {
      detachController();
      if (state.originalSetup && window.gZenMediaController?.setupMediaController) {
        gZenMediaController.setupMediaController = state.originalSetup;
      }
      state.originalSetup = null;
      applyCover(null);
      clearAccent();
      delete window.MusicBarAccent;
    }
  };

  window.MusicBarAccent = api;
  log("MusicBarAccent script starting...");
  waitForController();
})();
