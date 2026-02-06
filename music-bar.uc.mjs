// ==UserScript==
// @name MusicBarAccent.uc.mjs
// @description Cover-first background sync for Zen media controls
// @version 0.6.0
// @include main
// @grant none
// ==/UserScript==

(() => {
  "use strict";

  /* ── Config ── */
  const DEBUG = false;                   // flip to true when troubleshooting
  const SCRIPT_VERSION = "0.6.0";
  const LOG_PREFIX = "[MusicBar]";
  const CANVAS_SIZE = 32;                // small canvas for colour sampling
  const POLL_INTERVAL = 5000;            // fallback poll (ms) — events are primary

  /* ── DOM refs & CSS variable names ── */
  const ROOT = document.documentElement;
  const VAR_COVER   = "--music-bar-cover-url";
  const VAR_OPACITY = "--music-bar-cover-opacity";
  const VAR_ACCENT  = "--music-bar-accent";
  const RUN_ATTR    = "music-bar-script-running";
  const COVER_ATTR  = "music-bar-cover-active";

  /* ── Logging (minimal unless DEBUG) ── */
  const log  = (...a) => { if (DEBUG) console.log(LOG_PREFIX, ...a); };
  const warn = (...a) => console.warn(LOG_PREFIX, ...a);

  /* ── Tear down previous instance if hot-reloaded ── */
  if (window.MusicBarAccent?.destroy) {
    try { window.MusicBarAccent.destroy(); } catch {}
  }

  /* ── State ── */
  const state = {
    controller: null,
    browser: null,
    lastArtworkUrl: null,
    originalSetup: null,
    domPollId: null,
    waitCount: 0,
    refreshToken: 0,
    canvas: null,
    ctx: null
  };

  /* ════════════════════════════════════════════════════
   *  URL helpers
   * ════════════════════════════════════════════════════ */

  const resolveUrl = (url, base) => {
    if (!url || typeof url !== "string") return null;
    try { return new URL(url, base || window.location.href).href; }
    catch { return url; }
  };

  const getBrowserDocument = (browser) =>
    browser?.contentDocument || browser?.contentWindow?.document || null;

  /* ════════════════════════════════════════════════════
   *  Cover art CSS application
   * ════════════════════════════════════════════════════ */

  const applyCover = (url) => {
    if (!url) {
      ROOT.style.removeProperty(VAR_COVER);
      ROOT.style.setProperty(VAR_OPACITY, "0");
      ROOT.removeAttribute(COVER_ATTR);
      return;
    }
    ROOT.style.setProperty(VAR_COVER, `url("${url.replace(/"/g, '\\"')}")`);
    ROOT.style.setProperty(VAR_OPACITY, "1");
    ROOT.setAttribute(COVER_ATTR, "true");
  };

  /* ════════════════════════════════════════════════════
   *  Dominant colour extraction  (canvas → HSL → accent)
   * ════════════════════════════════════════════════════ */

  const ensureCanvas = () => {
    if (state.canvas) return;
    state.canvas = document.createElementNS(
      "http://www.w3.org/1999/xhtml", "canvas"
    );
    state.canvas.width  = CANVAS_SIZE;
    state.canvas.height = CANVAS_SIZE;
    state.ctx = state.canvas.getContext("2d", { willReadFrequently: true });
  };

  const sampleDominantColor = (data) => {
    let r = 0, g = 0, b = 0, total = 0;
    for (let i = 0; i < data.length; i += 16) {   // every 4th pixel
      const pr = data[i], pg = data[i + 1], pb = data[i + 2], pa = data[i + 3];
      if (pa < 64) continue;
      const mx = Math.max(pr, pg, pb);
      const mn = Math.min(pr, pg, pb);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const w = 0.3 + sat * 0.7;           // weight saturated pixels higher
      r += pr * w;  g += pg * w;  b += pb * w;
      total += w;
    }
    return total ? { r: r / total, g: g / total, b: b / total } : null;
  };

  const rgbToHsl = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h, s, l };
  };

  const hslToRgb = (h, s, l) => {
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
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
    return {
      r: hue2rgb(p, q, h + 1 / 3) * 255,
      g: hue2rgb(p, q, h) * 255,
      b: hue2rgb(p, q, h - 1 / 3) * 255
    };
  };

  const normalizeAccent = (c) => {
    const hsl = rgbToHsl(c.r, c.g, c.b);
    hsl.l = Math.max(0.48, Math.min(0.72, hsl.l));   // keep it light enough
    hsl.s = Math.max(0.20, Math.min(0.85, hsl.s));   // keep some saturation
    return hslToRgb(hsl.h, hsl.s, hsl.l);
  };

  const toHex = (n) =>
    Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

  const applyAccent = (color) => {
    if (!color) {
      ROOT.style.removeProperty(VAR_ACCENT);
      return;
    }
    ROOT.style.setProperty(
      VAR_ACCENT, `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`
    );
  };

  const colorFromImage = async (url) => {
    if (!url) return null;
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      await (img.decode
        ? img.decode()
        : new Promise((r) => { img.onload = r; img.onerror = r; }));
      if (!img.naturalWidth) return null;
      ensureCanvas();
      state.ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      state.ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
      const raw = sampleDominantColor(
        state.ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data
      );
      return raw ? normalizeAccent(raw) : null;
    } catch {
      return null;                       // CORS or decode failure — keep default
    }
  };

  /* ════════════════════════════════════════════════════
   *  Artwork URL extraction  (metadata → DOM fallback)
   * ════════════════════════════════════════════════════ */

  const parseSrcset = (v) => {
    if (!v) return null;
    const parts = v.split(",").map((e) => e.trim().split(" ")[0]).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  };

  const extractBgUrl = (v) => {
    if (!v || v === "none") return null;
    const m = v.match(/url\(["']?(.*?)["']?\)/);
    return m?.[1] || null;
  };

  const elImageUrl = (el) => {
    if (!el) return null;
    if (el.tagName === "IMG")
      return el.currentSrc || el.src || parseSrcset(el.getAttribute("srcset"));
    const cs = getComputedStyle(el);
    return extractBgUrl(cs.backgroundImage) || extractBgUrl(el.style?.backgroundImage);
  };

  const firstImageFromSelectors = (doc, selectors) => {
    for (const s of selectors) {
      const url = elImageUrl(doc.querySelector(s));
      if (url) return url;
    }
    return null;
  };

  const metaImage = (doc) => {
    for (const s of [
      'meta[property="og:image"]', 'meta[property="og:image:url"]',
      'meta[name="twitter:image"]', 'meta[property="twitter:image"]',
      'meta[itemprop="image"]', 'link[rel="image_src"]'
    ]) {
      const n = doc.querySelector(s);
      const u = n?.content || n?.getAttribute?.("href");
      if (u) return u;
    }
    return null;
  };

  const sizeScore = (e) => {
    if (!e || typeof e !== "object") return 0;
    if (typeof e.width === "number" && typeof e.height === "number")
      return e.width * e.height;
    const raw = String(e.sizes || "").trim();
    if (!raw) return 0;
    let best = 0;
    for (const c of raw.split(/\s+/)) {
      const [w, h] = c.split("x").map(Number);
      const a = (w || 0) * (h || 0);
      if (a > best) best = a;
    }
    return best;
  };

  const pickArtworkUrl = (list, base) => {
    if (!Array.isArray(list) || !list.length) return null;
    const sorted = [...list].sort((a, b) => sizeScore(b) - sizeScore(a));
    for (const e of sorted) {
      const src = e?.src || e?.url;
      if (typeof src === "string" && src.trim()) return resolveUrl(src, base);
    }
    return null;
  };

  const getMetadataArtworkUrl = (ctrl, doc) => {
    const md = ctrl?.getMetadata?.();
    if (!md) return null;
    const base = doc?.location?.href || window.location.href;
    for (const c of [md.artworkUrl, md.coverUrl, md.image, md.thumbnail,
                      md.albumArt, md.artwork?.src]) {
      if (typeof c === "string" && c.trim()) return resolveUrl(c, base);
    }
    for (const l of [md.artwork, md.images, md.pictures]) {
      const u = pickArtworkUrl(l, base);
      if (u) return u;
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
        url = firstImageFromSelectors(doc, [
          "ytmusic-player-bar img#song-image",
          "ytmusic-player-bar img.image",
          "ytmusic-player-bar img",
          "#song-image", "#player-bar img"
        ]);
      } else if (host.includes("open.spotify.com")) {
        url = firstImageFromSelectors(doc, [
          'img[data-testid="cover-art-image"]',
          'img[data-testid="track-image"]',
          '[data-testid="now-playing-widget"] img',
          'footer img[src*="i.scdn.co/image/"]',
          'img[src*="i.scdn.co/image/"]'
        ]);
      } else if (host.includes("youtube.com")) {
        url = metaImage(doc);
      } else {
        url = firstImageFromSelectors(doc, [
          'img[alt*="album" i]', 'img[alt*="cover" i]', 'img[class*="cover" i]'
        ]) || metaImage(doc);
      }

      return resolveUrl(url || metaImage(doc), doc.location?.href);
    } catch (e) {
      log("DOM lookup failed", e?.message);
      return null;
    }
  };

  /* ════════════════════════════════════════════════════
   *  Core refresh  (event-driven + fallback poll)
   * ════════════════════════════════════════════════════ */

  const refreshArtwork = async () => {
    const token = ++state.refreshToken;

    const browserDoc = getBrowserDocument(state.browser);
    const mdUrl  = getMetadataArtworkUrl(state.controller, browserDoc);
    const domUrl = mdUrl ? null : getDomArtworkUrl(state.browser);
    const artUrl = mdUrl || domUrl;

    if (!artUrl) {
      if (state.lastArtworkUrl) log("Artwork cleared");
      state.lastArtworkUrl = null;
      applyCover(null);
      applyAccent(null);
      return;
    }

    if (artUrl === state.lastArtworkUrl) return;

    state.lastArtworkUrl = artUrl;
    applyCover(artUrl);
    log("Cover →", artUrl);

    /* Sample dominant colour (async — guard against stale result) */
    const color = await colorFromImage(artUrl);
    if (token !== state.refreshToken) return;
    applyAccent(color);
    if (color) log("Accent →", `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`);
  };

  /* ── Event wiring ── */

  const onMediaEvent = (e) => {
    if (!e?.target || e.target === state.controller) refreshArtwork();
  };

  const listen   = (t, ev) => { try { t?.addEventListener?.(ev, onMediaEvent); } catch {} };
  const unlisten = (t, ev) => { try { t?.removeEventListener?.(ev, onMediaEvent); } catch {} };

  const stopPoll = () => {
    if (state.domPollId) { clearInterval(state.domPollId); state.domPollId = null; }
  };

  const startPoll = () => {
    stopPoll();
    state.domPollId = setInterval(() => {
      if (state.controller && state.browser) refreshArtwork();
    }, POLL_INTERVAL);
  };

  /* ── Controller lifecycle ── */

  const detach = () => {
    if (!state.controller) return;
    unlisten(state.controller, "metadatachange");
    unlisten(state.controller, "playbackstatechange");
    state.controller = null;
    state.browser = null;
    stopPoll();
  };

  const attach = (ctrl, browser) => {
    if (!ctrl || ctrl === state.controller) return;
    detach();
    state.controller = ctrl;
    state.browser = browser || null;
    listen(ctrl, "metadatachange");
    listen(ctrl, "playbackstatechange");
    refreshArtwork();
    startPoll();
    log("Attached controller");
  };

  const findFirst = (obj, keys) => {
    for (const k of keys) { if (obj?.[k]) return obj[k]; }
    return null;
  };

  const patchMediaController = () => {
    const zmc = window.gZenMediaController;
    if (!zmc || typeof zmc.setupMediaController !== "function") return false;
    if (state.originalSetup) return true;

    state.originalSetup = zmc.setupMediaController.bind(zmc);
    zmc.setupMediaController = (ctrl, browser) => {
      if (ctrl) attach(ctrl, browser);
      return state.originalSetup(ctrl, browser);
    };

    const cur = findFirst(zmc, [
      "_currentMediaController", "currentMediaController",
      "_mediaController", "mediaController"
    ]);
    const brw = findFirst(zmc, [
      "_currentBrowser", "currentBrowser", "browser"
    ]);
    if (cur) attach(cur, brw);

    log("Patched setupMediaController");
    return true;
  };

  const waitForController = () => {
    state.waitCount += 1;
    if (patchMediaController()) return;
    if (state.waitCount % 20 === 0) warn("Waiting for gZenMediaController…");
    setTimeout(waitForController, 250);
  };

  /* ════════════════════════════════════════════════════
   *  Public API  (hot-reload & cleanup)
   * ════════════════════════════════════════════════════ */

  const api = {
    destroy() {
      detach();
      const zmc = window.gZenMediaController;
      if (state.originalSetup && zmc) zmc.setupMediaController = state.originalSetup;
      state.originalSetup = null;
      applyCover(null);
      applyAccent(null);
      ROOT.removeAttribute(RUN_ATTR);
      delete window.MusicBarAccent;
      log("Destroyed");
    }
  };

  /* ── Boot ── */
  ROOT.setAttribute(RUN_ATTR, SCRIPT_VERSION);
  window.MusicBarAccent = api;
  console.log(`${LOG_PREFIX} boot v${SCRIPT_VERSION}`);
  waitForController();
})();
