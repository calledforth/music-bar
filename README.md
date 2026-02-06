# Music Bar Accent (Zen + Sine)

A Zen Browser mod that gives the media controls bar a YouTube-Music-inspired
ambient glow using the currently-playing track's cover art.

## What it does

- Styles `#zen-media-controls-toolbar` with a dark base and soft ambient glow.
- Uses a userChrome script (`music-bar.uc.mjs`) to read MediaSession artwork,
  with DOM fallback for YouTube Music, Spotify Web, and YouTube.
- The cover art is heavily blurred and dimmed so it tints the bar rather than
  flooding it — dark dominates, colour is atmospheric.

## Install with Sine

1. Push this repo to GitHub.
2. In Zen, open Sine settings and add this repo as a mod.
3. **Important:** In `about:config`, set `sine.allow-unsafe-js` to `true`
   (required for non-store mods that include JavaScript).
4. Restart Zen.

## Notes

- If no artwork is available, the bar falls back to a neutral dark style.
- Prioritized sites: YouTube Music, Spotify Web, YouTube.

## Debugging

- Open **Browser Console** (not page DevTools) and filter for `[MusicBar]`.
- On load, you should see `boot v0.6.0`.
- If you only see Sine stylesheet rebuild logs and no `[MusicBar]`, check that
  `sine.allow-unsafe-js` is `true` in `about:config`.
