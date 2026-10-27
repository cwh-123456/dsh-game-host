# dev preview / browser verification (`@local/dsh-game-battleship`)

**dev-only** — this directory is not listed in `package.json.files` and is never shipped.
This page is a *fake host + minimal fake React* over real Chromium DOM. It is **not** host
acceptance: the plugin is not installed and the DSH host GUI is not exercised here.

## What exists

| File | Purpose |
|---|---|
| `preview.html` | Fake host page: DSH-like light/dark token sets, stage sizes (720×600 / 1100×700 / 360×520 / 300×220), module-loader stub that runs the real `client.js` with `window.__DSH_GAME_BATTLESHIP_TEST__ = true`, capture mode (`?capture=1`), screenshot scenarios (`?scenario=placement|battle|battleFast|toosmall`), and an automated interaction self-test (`?selftest=1`). |
| `fake-react.js` | Minimal React-compatible renderer (createElement, hooks, class components/error boundary, keyed lists, style/className/events/refs, render/unmount). |
| `test-browser.mjs` | Optional standalone runner: launches an isolated headless Edge/Chromium over DevTools protocol (no third-party deps) and runs the page selftest. Not required when the shared browser tooling is available. |
| `screenshots/` | Six real-Chromium captures of the final build (list below). |

## Results on the final build

Client: `client.js` sha256 `b81a41ffc43dd5d1ce8eb25a4d568bdfd2f197b68073b5b8768f6b986729312d`
(96,085 B). Real Chromium via the DSH browser tool, file:// preview, fake React, fake host:

- Interaction self-test: **26 pass / 0 fail / 26 checks**, duration 7.9 s,
  **0 window errors / 0 unhandled rejections / 0 console.error**. Covers:
  boot/registration/manifest shape; initial placement view; rotate via button **and** `R`;
  out-of-bounds / overlap / orthogonal-adjacent / diagonal-adjacent rejection with messages;
  randomize = 5 legal non-overlapping non-adjacent ships synced to DOM; toggle-adjacent
  on/off semantics; start battle (enemy fleet not leaked); miss + AI delayed reply with no
  repeat; hit feedback; sunk destroyer (`data-shot="sunk"`, ship name in the message);
  own fleet + incoming shots rendered; save key/schema/persist-on-every-action;
  unmount→remount restore of battle **and** placement; difficulty buttons persisted;
  360×520 stacked, 720×600 side-by-side, 1100×700 side-by-side, no overflow;
  300×220 too-small prompt; no `document.body` writes / no global keyboard / title unchanged;
  victory (last ship sunk → `phase=over`, `winner=player`, win message); no runtime errors.
- Extra manual checks on the same build: resize 720×600 → 360×520 → 1100×700 → 360×520 by
  live ResizeObserver (no stuck too-small; boards reappear within ~1 rAF; stacked at 360×520,
  side-by-side at ≥680; boards inside the stage; no overflow); player/enemy boards aligned at
  the same top on wide layouts; placement dock shows 5 ships with current/unplaced states.
- Known harness caveat: the `?scenario=battle` path drives real DOM clicks and is only used
  to exercise flows; `?scenario=battleFast` constructs a deterministic midgame save for
  stable screenshots. `preview.html` is dev-only and was last edited by the Lead after the
  preview teammate crashed; the interaction selftest above is the authoritative result.

## Screenshots (real Chromium, captured from the final build)

| File | Stage | Content |
|---|---|---|
| `light-720x600-placement.png` | 720×600 light | placement phase; 3 ships placed, 5-ship dock (current 潜艇 highlighted, 驱逐舰 pending), enemy panel waiting |
| `light-720x600-battle-midgame.png` | 720×600 light | mid-battle: own fleet, 5 misses / 3 hits / 2 sunk, enemy destroyer sunk, fleet chips struck through |
| `dark-720x600-battle.png` | 720×600 dark | same midgame in dark theme (readable tokens + self-coloured boards) |
| `light-1100x700-battle.png` | 1100×700 light | wide side-by-side layout, larger boards |
| `light-360x520-stacked.png` | 360×520 light | narrow stacked layout (player above enemy), compact length chips, no overflow |
| `light-300x220-toosmall.png` | 300×220 light | 窗口太小 prompt instead of a broken board |

## Reproduce

```powershell
# from the repo root; open in a browser (file://)
#   dev/preview.html                                  interactive
#   dev/preview.html?selftest=1                       automated interaction self-test
#   dev/preview.html?capture=1&scenario=placement&size=720x600&theme=light
#   dev/preview.html?capture=1&scenario=battleFast&size=360x520&theme=dark
node packages/dsh-game-battleship/dev/test-browser.mjs   # standalone headless run (optional)
```
