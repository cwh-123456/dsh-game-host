# Independent verifier report — dsh-game-solitaire (task 009)

**Verdict: PASS WITH NOTES** — two artifacts audited, both pass:
- **v1.0 (click-only)** `client.js be0bbf26…` (77,065 B): rules, save, lifecycle, contract — see §2–§9.
- **v1.1 (drag & drop)** `client.js d0549f77…` (89,639 B): drag layer + full rules regression —
  **addendum §10**. No blockers in either build. 2 open non-blocking notes in §7; the earlier
  foundation→tableau note was resolved by documentation; drag-specific notes live in §10.5.

Independent audit by teammate `verifier`. I did not modify any runtime file: all writes are under
`packages/dsh-game-solitaire/dev/audit/` (plus this report). I did not install the plugin, did not
touch the host package, and used no network.

## 0. Artifacts under audit

**v1.1 drag build (current, §10) — `client.js` sha256 `d0549f778f2a0c3912b7a81b9c44a0bd0042a142198a509cb39cfab058c211a7`, 89,639 B.**

Current runtime files:

| file | sha256 | bytes |
|---|---|---|
| `packages/dsh-game-solitaire/client.js` | `d0549f778f2a0c3912b7a81b9c44a0bd0042a142198a509cb39cfab058c211a7` | 89639 |
| `packages/dsh-game-solitaire/package.json` | `930cf25a52ab2d26676c1281e9f17c74b75ca7963560e4456244442738e67490` | 669 |
| `packages/dsh-game-solitaire/index.js` | `6e9ac3dbf49ef5e9a5c8a64215d0a6f07fb95050d19d7b28e6bf6233a42897e1` | 318 |
| `packages/dsh-game-solitaire/cordis.patch.yml` | `f186788f87e0a0cbf1f05b5e259349d7e2ab1dfd116715f740b3ce11ddb276b1` | 75 |
| `packages/dsh-game-solitaire/locale/zh.json` | `63ebd84b9a8e476cbc6aad5e7325805afbdb2b45fe9f645b0136d40cc78f2917` | 197 |
| `packages/dsh-game-solitaire/locale/en.json` | `847630d44a61255acb2e4d9dc5440e7385ba3fd89ea30a6f78e9e65b9c39ad27` | 231 |
| `packages/dsh-game-solitaire/icon.svg` | `3bf2d494392ec528d37acc12f4964b4ff8bf6f502aa26d8fe966623cb190dd35` | 1329 |
| `packages/dsh-game-solitaire/README.md` | `88238f5c058fca42d170741ccf453b9c537d990375ea343f952bb51fc76646c4` | 8810 |

Locale/README text changed for the drag build (descriptions now say "点击或拖拽"/"click or drag");
manifest, index.js, patch, icon are byte-identical to v1.0. `contract` still passes all 102 checks.

**v1.0 click-only build (historical, §2–§9)** — `client.js be0bbf26…` (77,065 B); its README was
`e9f0c07…` (7,411 B) and locale `009160…`/`356e1b…`. The v1.1 addendum re-ran every v1.0 suite on the
drag build: identical counts and zero divergence (§10.3), so the v1.0 conclusions carry over.

`client.js` is hashed before and after every run: the v1.1 hash above was stable before/after the
final battery (`mtime 2026-10-18T09:36:09Z`). If it changes again, re-run everything — all scripts
print their own hashes.

## 1. How to reproduce (repo root, `D:\desktop_files\artificial_intelligence\dsh-game-host`)

```powershell
node packages/dsh-game-solitaire/dev/audit/reference-selftest.mjs        # oracle self-test
node packages/dsh-game-solitaire/dev/audit/check-contract.mjs           # static contract/manifest
node packages/dsh-game-solitaire/dev/audit/check-host-untouched.mjs     # host/contract baseline
node packages/dsh-game-solitaire/dev/audit/diff-fuzz.mjs --games 24 --actions 600
node packages/dsh-game-solitaire/dev/audit/save-fuzz.mjs --mutations 5000
node packages/dsh-game-solitaire/dev/audit/lifecycle.mjs
node packages/dsh-game-solitaire/dev/audit/drag-audit.mjs               # v1.1 drag layer
```

All scripts are **read-only reporters** (this session's spawned `pwsh`/`node` processes are
read-only-confined on the workspace, so writing reports from them would fail; they print to stdout
instead). Exit code 0 = pass, 1 = failure. See `dev/audit/README.md`.

## 2. Results

| suite | result | scale |
|---|---|---|
| `reference-selftest.mjs` (oracle correctness) | **24/24 tests pass**, exit 0 | 50 seeds deal invariants, 12 seeds × 250-action self-play with invariants, rules table, recycle order, purity |
| `check-contract.mjs` | **102 checks: 100 pass, 0 fail, 0 pending, 2 notes**, exit 0 — re-run after the README doc fix, unchanged | final files incl. README |
| `check-host-untouched.mjs` | **10/10 baseline files unchanged**, exit 0 — re-run after the README doc fix, unchanged | `packages/dsh-game-host/**` (8) + `handoff/contract/**` (2) |
| `diff-fuzz.mjs --games 24 --actions 600` | **0 divergences**, exit 0 | 14 400 random actions, **722 995 comparisons**, 512-seed deal sweep, 6 constructed scenarios |
| `save-fuzz.mjs --mutations 5000` | **0 failures**, exit 0 | 24 round-trips, 10 000 corrupted-sanitize calls (5 000 mutations × JSON + raw), 311 checks |
| `lifecycle.mjs` | **16/16 tests pass**, exit 0 | registration, mount/layout/timer, visibility pause, destroy/reload, restart/new game, win, hygiene |

## 3. Contract / manifest / registration (static + dynamic)

`check-contract.mjs` (102 checks) verifies, against the final files:

- `package.json`: name `@local/dsh-game-solitaire`, private, ESM, exactly the four `exports`
  (`.`, `./client`, `./locale/*.json`, `./icon`), `files` covers all runtime files (incl. README)
  and excludes `dev/`, `dsh.bundle.patch`, `dsh.client{platform:'web', immediately:true}`,
  **no** `dependencies`/`devDependencies`/`peer`/`optional`, **no** `dsh.client.inject`.
- `cordis.patch.yml`: `- insert:` / `id: game-solitaire` / `name: '@local/dsh-game-solitaire'`;
  patch id, package name and save key collide with no sibling game package.
- `index.js`: only `export function apply() {}`.
- `locale/zh.json` = 接龙 + description; `locale/en.json` = Solitaire + description; valid JSON,
  no U+FFFD, only `meta`.
- `icon.svg`: real `<svg>` with viewBox, no external refs, ≤256 KiB; no binary assets inside the
  publish scope.
- `client.js`: loader id equals package name; factory/require only `react`; `inject: ['slots']`
  exactly; exactly one `slots.inject('game.stage', …)` and one `slots.register(...)`;
  `name:'game.stage'`, `id:GAME_ID`, `GAME_ID='solitaire'`, `label` returns 接龙, strict
  `gameId === GAME_ID` select; no `ctx.provide`; no session internals.
- save: `dsh.game.solitaire.v1` (literal or `GAME_ID`-derived), `SCHEMA_VERSION = 1`,
  no other `dsh.game.*` key referenced; localStorage access guarded.
- safety: **no** window/document `keydown`/`keyup`/`keypress`; **no** `document.body`;
  **no** `document.title` writes; no fetch/XHR/WebSocket/EventSource/sendBeacon; no dynamic import;
  no `document.write`; document listener limited to `visibilitychange`; window listener limited to
  `resize` (dynamically confirmed by `lifecycle.mjs`).
- rendering/styling: root 100%×100%, `ResizeObserver`, `requestAnimationFrame`, `<320×240` hint,
  ≥5 `--dsw-alias-*` tokens, prefixed `dshsol-*` CSS, style node injected as a React child
  (`h('style', …)` inside the game root — not into `document.head`/`body`), right-click suppressed,
  timer/步数 markers, tabIndex=0 + focus.
- test seam only when `window.__DSH_GAME_SOLITAIRE_TEST__ === true` (`Object.defineProperty`).

Dynamic registration check (`lifecycle.mjs` test 1) instantiates the real module factory with a fake
`require('react')` and a fake slot ctx: exactly one `inject('game.stage')`, one `register(...)`,
label `接龙`, `select({gameId:'solitaire'})` returns a **frozen** object stable across calls,
other gameIds/`{}`/`null` → `null`, component is a function, no services provided.

## 4. Rules correctness — differential fuzz vs independent oracle

Oracle: `dev/audit/reference-solitaire.mjs`, written from the spec only (own mulberry32 +
Fisher–Yates + classic row-major deal, own move generator/validator, stock/waste with draw-1 and
classic recycle order, auto-flip, win, snapshot history, full state invariants). It does not import
or copy `client.js`.

`diff-fuzz.mjs` seeds each game from the **client's own deal** (so a hypothetical dealer difference
cannot mask a rule difference) and asserts deal equality separately. Per step it compares:
`canDrop` verdict, moved card list, resulting piles, `moves`, `won`; draws (ok / draw-vs-recycle /
piles); double-click auto-move (ok / target foundation / piles); undo; purity of refusals
(a refused `applyMove` must not mutate state); and oracle invariants after every mutation.
Periodically it compares the **entire** selection×target rules table (including malformed indices,
negative/out-of-range columns/piles, unknown kinds) — 675 387 `canDrop` comparisons total.

- 24 games (seeds `0`, `0xffffffff`, `1..22`) × 600 actions = **14 400 actions**, 24/24 completed
  with **0 divergences**, **722 995 comparisons** (deal 536, canDrop 675 387, apply 19 225,
  draw 2 430, auto 1 320, undo 1 124, invariant 14 400, purity 4 227).
- Extra single-seed runs @800 actions: `0` → 44 570 comparisons; `123456789` → 45 916;
  `0xdeadbeef` → 43 365; `0xffffffff` → 43 282; all 0 divergences.
- Deal sweep: **512 numeric seeds** (incl. 0, 1, 0x7fffffff, 0xffffffff) produce identical deals
  (same 7 columns, face-up flags and stock in the same order). Deal invariants are also asserted
  independently: 7 columns with 1..7 cards, only tops face-up, 24-card stock, all 52 unique
  (oracle self-test for seeds 1..50). Draw order after recycle repeats the classic
  sequence; `moves` increments by one per successful draw/recycle/move (matches Lead's stated
  convention over all 14 400 actions).
- 6 constructed edge scenarios (positions random play rarely reaches), all PASS:
  1. `win-after-foundation-and-draw` — foundations 12×4 + three tableau kings + one stock king:
     four moves + one draw finish the game; both engines flag `won` and stop the timer.
  2. `foundation-to-tableau-extension` — card back from a foundation onto the tableau, then back
     to its foundation; off-rank move refused.
  3. `auto-flip-and-run-move` — whole run moved, exposed face-down card auto-flips; grabbing a
     face-down card refused; auto-move refuses a non-playable top card.
  4. `auto-move-double-click` — A then 2 accepted to the foundation, off-rank 7 refused.
  5. `win-detection` — a fully built position reports win; win flag consistent.
  6. `stock-recycle-order` — 24 draws, recycle, 24 draws (order repeats), recycle again, 6 draws;
     every step pile-identical.

## 5. Save / undo robustness

`save-fuzz.mjs` (311 independent checks, 0 failures):

- **Round-trip**: 6 seeds × 4 action depths (0/12/60/180) → `serializeState` → JSON →
  `sanitizeState` is lossless for piles, seed, moves, started, won, elapsedMs and retained undo
  snapshots; accepted states pass an independent validator (52 unique cards, foundation order,
  tableau face rules + run validity, win flag, ranges); `sanitize(serialize(x))` fixed point holds.
  `makeSnapshot`/`restoreSnapshot` and `encodeTableau`/`decodeTableau` round-trip exactly.
- **Corruption**: 5 000 mutations × 2 forms (JSON-parsed = real save, and raw object with
  `NaN`/`Infinity`/`undefined`) = **10 000 `sanitizeState` calls: 0 throws**, 2 138 accepted
  (all renormalized and independently valid — e.g. excess undo trimmed to 40, `started`
  normalized, unknown keys dropped) and 7 862 rejected. 29 hand-written must-reject cases
  (bad schema, non-integer/negative/out-of-range seed/moves/elapsed, missing/duplicate cards,
  out-of-range ids, wrong foundation suit/rank, malformed tableau encodings, inconsistent `won`,
  non-object saves) → **29/29 rejected**. `loadSavedState` never throws on garbage (18 cases +
  200 mutational) and agrees with `sanitizeState`; a throwing `localStorage` is survived both ways.
- **Key isolation**: exactly `dsh.game.solitaire.v1` is written/read; a planted
  `dsh.game.quoridor.v1` and other keys are untouched. Save ≤ 64 KiB (observed max 11 040 bytes);
  stable across save → load → save.

`lifecycle.mjs` additionally proves: action + destroy + hidden-tab persistence, exact reload of
piles/moves/elapsed/seed, destroy idempotent (second destroy writes nothing, no listeners left),
post-destroy calls inert.

## 6. Lifecycle (headless, fake DOM/window; 16/16 pass)

- mount at 1024×700: layout, timer `00:00`, 0 moves, 52 cards distributed, ResizeObserver observing
  its own host; < 320×240 → `tooSmall`, `layout=null`; resize + dpr change observed (client defers
  relayout one rAF — verified by flushing the frame); layout finite/ordered/contained at
  320×240 … 2560×1440 incl. deep column fanning that stays inside the tableau.
- timer/moves: draw starts the clock, `elapsedText`/`elapsedSeconds` advance with rAF; undo of a
  draw restores piles + counter exactly.
- `document.hidden`: pause settles elapsed (4 s), 60 s hidden adds **zero**; on return it resumes
  4 s → 6 s (no jump). No frames scheduled while hidden.
- destroy: persists state equal to live state, removes window/document listeners, disconnects
  ResizeObserver, cancels rAF; second destroy is a no-op; post-destroy calls don't write.
- restart = same seed deal (moves/elapsed/undo reset); new game = different deal; 25 consecutive
  undos walk back to the original deal (undo depth ≥ 20 requirement; in-memory keep 200, saved 40).
- win (loaded near-win save): last foundation card sets `won`, timer stops and freezes;
  double-click waste-top-to-foundation and tableau-top-to-foundation both exercised.
- corrupt save at load → fresh rules-valid deal, no throw.
- hygiene: only `window resize` + `document visibilitychange`; no keydown/keyup/keypress on
  window/document; zero `document.body` touches.

## 7. Notes (non-blocking)

### Open notes (2)

1. **Seam names differ from the original handoff target list** (`newState`/`sanitize`/`serialize`/
   `doubleClickMove` → `emptyState`/`sanitizeState`/`serializeState`/`autoMoveToFoundation` + `applyMove`).
   This matches the Lead's final seam declaration and is only a dev/test API; all dynamic tests use
   the actual names. The static contract checker reports this as a NOTE, not a failure.
2. DOM rendering path (not canvas): contract §5's canvas DPR rules don't apply; client still tracks
   `devicePixelRatio` to relayout (verified). Style is injected inside the game root — no host
   style pollution observed statically or via the fake-DOM listener/DOM watchers.

### Resolved after the audit (1)

- **Foundation → tableau is allowed** (classic-Klondike convenience). The v1 handoff rule list is
  silent about moving cards off foundations, and the implementation allows it (verified consistent
  with the oracle's classic variant: `foundation-to-tableau-extension` scenario + exhaustive
  `canDrop` table). This was originally a "please document it" note; the Lead added the
  documentation to `README.md` (rule bullet lines 13–14, controls table line 26: 「点基座顶牌 →
  选中它，可移回牌桌」), and I confirmed both spots. README-only change; `client.js` unchanged
  (`be0bbf26…`), so no rules/save/lifecycle result is affected. **Resolved.**

## 8. Honest limits (what this audit did NOT verify)

- **Headless only.** `client.js` was imported into Node with a fake `window`/`document`, test seam
  enabled. I did **not** run real React rendering, real browser layout, dark/light readability,
  high-DPI crispness, or DOM click hit-testing — the Lead's Chromium preview pass covers those.
- **No host installation / no GUI.** I could not (and did not) install the plugin or open the DSH
  game page, so "directory shows 接龙 / slot mounts in host / error boundary behaves in host" is
  the Lead's/user's browser acceptance, not mine.
- **No network, no file changes outside my scope.** Host package + contract file hashes prove
  `packages/dsh-game-host/**` and `handoff/contract/**` are unchanged from the pre-audit baseline
  (`dev/audit/baseline-hashes.json`, 10/10 match). Sibling game packages were only read.
- Deal equality is agreement between two implementations of the same standard algorithm
  (mulberry32 + row-major deal); 512-seed identity plus independent deal invariants (52 unique,
  7 columns, only tops up, 24 stock) is strong evidence but is not a statistical proof of shuffle
  quality.
- The reference oracle was itself tested first (`reference-selftest.mjs`); during development the
  oracle had a seed-0 bug (it substituted a constant for seed 0) which the client correctly did
  not — the oracle was fixed before any verdict, and the 512-seed deal sweep now includes seed 0.

## 9. If a divergence is ever found

`diff-fuzz.mjs` prints the first mismatches with exact repro data (seed, step, action JSON,
expected-vs-actual pile fields) and a replay command. `save-fuzz.mjs` prints the mutation
description plus accepted-invalid details. All scripts are deterministic: same hash + same
arguments ⇒ same numbers as above.

## 10. Addendum v1.1 — drag & drop build (`client.js d0549f77…`, 89,639 B)

User request: "纸牌要能拖拽". The Lead added a pointer-driven drag layer to the same file; v1.1 is
re-audited here with the new `dev/audit/drag-audit.mjs` (16 tests, **8,269 checks**, exit 0) plus a
full re-run of every v1.0 suite.

### 10.1 Drag audit — what it checks and how (independent of `findDropTarget`)

`drag-audit.mjs` loads the real `client.js` under the same fake `window`/`document`, drives the
controller API (`pointerDown/pointerMove/pointerUp/pointerCancel/clickCapture/getDrag`) with synthetic
pointer events whose `target` is a stub carrying the same `data-dshsol-*` dataset a rendered card
would have, and compares against an **independent geometric model**:

- rect math is derived from `computeLayout()` fields (`colX/colY/tableauTop/tableauH/foundationX/
  topY/cardW/cardH/wasteX/wasteFanStep/colOffsets`, pad = `max(4, cardW × 6%)`) — the hit-test
  logic is written in the audit from the documented geometry, not copied from the client;
- legality of a hit target comes from the independent oracle (`ref.canDrop`), not from the client's
  own `canDrop`;
- drop order model: foundations pile 0..3 first, then tableau columns 0..6; a later legal hit wins
  over an earlier illegal hover (message plumbing), matching documented behaviour.

### 10.2 Focus areas — results

1. **Geometry hit-testing vs `drag.target`:** 4 states (deal seed 1, waste-3, K-run, foundation card)
   × 5 sizes (360×520 … 1600×1000) × 90 activated drag sources × 89 points each (30 seeded-random +
   59 systematic boundary/centre/outside points) = **8,010 compared positions, 0 mismatches**.
   Non-vacuity: 363 positions expected a legal target (8 distinct targets hit: `foundation:3` and
   `tableau:0..6`), 5,607 expected an illegal hover, 2,040 expected empty space. `view.drag.target`
   matched `getDrag().target` at every point; target checks include pad-edge points (±pad±1) where
   narrow-window column/foundation rects overlap, which exercises the documented first-legal-hit
   ordering.
2. **Click/drag coexistence:** 5 threshold probes — 5 px move stays inactive (no capture, no state
   change, click path intact), **6 px boundary activates**, 7 px/7,7 px activate. Activation clears
   an existing click selection and sets pointer capture **exactly once** (20 further moves add none).
   A below-threshold pointerup leaves no drag state, does not swallow the following click, and
   `onWasteClick`/`onTableauCardClick` still select normally. After a real drag, `clickCapture`
   swallows exactly one click (calls `stopPropagation` + `preventDefault`), then normal clicks pass;
   the 0 ms timer clears the flag (verified after a real `setTimeout`). Drag activation also clears
   the tooltip message.
3. **Sources:** waste top (only), any face-up tableau index (whole suffix run), foundation top
   `{cards}` match the oracle's selection exactly; the floating-stack origin offsets match the
   independently derived layout origin (`0.5·cardW`, `0.35·cardH` in the test points) and
   `view.drag.step = max(6, layout.faceUpBase)`. Face-down cards (no dataset), stock (no dataset),
   right-button (`button≠0`), non-primary pointer, a second `pointerDown` mid-drag, and wrong
   `pointerId` moves/ups are all ignored. Too-small stage (no layout) cannot start a drag.
4. **Failed/illegal drop purity:** illegal drop (2H onto empty spade foundation, Q onto empty column)
   → piles, `moves`, undo length and `localStorage` byte-identical; `view.message` equals the client's
   `canDrop` reason string exactly; drag cleared; click after the failed drag swallowed. 6 additional
   independently-found invalid-hover points surface the matching reason (0 mismatches). Drop outside
   every rect: no state change, **no message**, no undo, drag cleared. `pointercancel` mid-drag: no
   state change, no undo, drag cleared.
5. **Pointer cleanup / listeners:** only React props on the board (`onPointerDown/Move/Up/Cancel`,
   `onClickCapture`, plus `data-dshsol-*` only on movable cards — verified statically); **no
   window/document `pointer*` listeners**; pointer capture set once per drag and released on
   success/failure/cancel; destroy mid-drag leaves the controller inert (no state change, no storage
   write, no throw), and a finishing `pointerUp` after destroy releases the capture. No
   `document.body` touches.
6. **Successful drops:** waste→tableau/foundation, K-headed run→empty column, foundation top→tableau
   (documented convenience) — each applies exactly the oracle move, `moves +1`, one undo snapshot,
   persists, clears drag view; the post-drag click is swallowed.

### 10.3 Rules regression on the drag hash (drag reuses the same canDrop/applyMove path)

| suite | v1.1 result | compared to v1.0 |
|---|---|---|
| `reference-selftest.mjs` | 24/24 pass | identical |
| `diff-fuzz.mjs --games 24 --actions 600` | 722,995 comparisons, 0 divergences | identical counts |
| deal sweep | 512/512 seeds identical deals | identical |
| `save-fuzz.mjs --mutations 5000` | 311/311 checks, 0 throws (2,138 renormalized / 7,862 rejected) | identical |
| `lifecycle.mjs` | 16/16 pass | identical |
| `check-contract.mjs` | 102 checks: 100 pass, 0 fail, 0 pending, 2 notes | identical |
| `check-host-untouched.mjs` | 10/10 host+contract files unchanged | identical |

So the drag layer is additive: no rule/save/lifecycle behaviour changed, and the seam's pure
functions are byte-for-byte equivalent in behaviour to v1.0 on the same inputs.

### 10.4 Static wiring (in `drag-audit.mjs`, all pass)

`DRAG_THRESHOLD = 6` and the `dx²+dy² < threshold²` guard; `pointerDown/Move/Up/Cancel/clickCapture/
getDrag` exposed from `createGame`; `data-dshsol-card` gated by `spec.dragSource` (waste = top only,
foundation = top card only, tableau = `card.up`); stock not draggable; pointer capture set only after
the threshold and released on finish; `touch-action:none` on the board; `onClickCapture` wired as a
React capture handler; `suppressClick` stopPropagation/preventDefault logic present.

### 10.5 Notes (drag-specific, non-blocking)

1. **Docs updated for drag**: `locale/zh.json`/`locale/en.json` descriptions and `README.md` now
   mention drag ("点击或拖拽 / click or drag"; 6 px threshold, click-after-drag swallowed). Docs-only
   change; `package.json`/`index.js`/`cordis.patch.yml`/`icon.svg` are byte-identical to v1.0 and the
   contract suite still passes 102/102.
2. **Cancelled drags also set the click-suppression flag.** `finishDrag` sets `suppressClick = true`
   even when called from `pointerCancel`; it is cleared next macrotask and pointercancel normally
   isn't followed by a click, so this is harmless — noted for completeness.
3. **Destroy does not itself release pointer capture**; in a real browser the DOM node removal
   releases capture, and a finishing pointer event releases it too (tested). No leak observed in
   headless tests; the browser pass covers the real unmount path.
4. `getDrag()` exposes `x/y` only; the floating-stack offsets are exposed on `view.drag`
   (`offsetX/offsetY/step`). Documented seam shape, used accordingly by this audit.

### 10.6 Honest limits for v1.1 (in addition to §8)

- **Synthetic pointers, not a browser.** Events are plain objects with a stub target carrying the
  dataset attributes; real PointerEvent capture, `touch-action`, device pen/touch behaviour, drag
  cursor and the floating card's actual painting are **not** verified here — the Lead's Chromium
  preview selftest (24/24, including 6 synthetic-pointer drag checks) and screenshots cover those.
- **Data-attribute gating is verified statically** (which card nodes receive `data-dshsol-*`), not by
  rendering React; the real-DOM consequence is covered by the Lead's browser pass.
- The geometry oracle intentionally consumes `computeLayout()` output as its layout source (this
  audit targets `findDropTarget`, not layout math; layout math was sanity-checked in §6/v1.0).
  Same 512-seed/14,400-action rules oracle, same fake-browser caveat: not a statistical proof of
  shuffle quality.
- `drag-audit.mjs` is deterministic; the geometry points are seeded, so the same hash + arguments
  yield the same 8,010 comparisons.
