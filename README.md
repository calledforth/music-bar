# Music Bar Accent (Zen + Sine)

This mod styles the Zen media controls bar and updates its accent glow based on the current track's album art.

## What it does

- Styles `#zen-media-controls-toolbar` with a dark glassy background and glow.
- Uses a userChrome script to read MediaSession metadata and sample album art color.
- Updates CSS variables so the bar responds dynamically to music.

## Install with Sine

1. Push this repo to GitHub.
2. In Zen, open Sine settings and add this repo as a mod.
3. Enable the mod and restart Zen.

## Notes

- Dynamic colors come from the `artwork` field in media metadata.
- If no artwork is available, the bar falls back to the default accent in `chrome.css`.
