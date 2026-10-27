# Independent verifier report — dsh-game-battleship (task 1)

**Verdict: PASS WITH NOTES** — no blockers. Every suite was run from the repo
root against the final `client.js` and exits `0`; the one non-blocking strategy
note and the unverified boundaries are listed in §7/§8.

Independent audit by teammate `verifier`. I did not modify any runtime file: all
writes are under `packages/dsh-game-battleship/dev/audit/`. I did not install the
plugin, did not open the DSH host GUI, and used no network. The host package and
the frozen contract were hash-baselined before the audit and re-verified after.

## 0. Artifact under audit

| file | sha256 | bytes |
|---|---|---|
| `packages/dsh-game-battleship/client.js` | `b81a41ffc43dd5d1ce8eb25a4d568bdfd2f197b68073b5b8768f6b986729312d` | 96,085 |
| `packages/dsh-game-battleship/package.json` | `552b9821f8e8f095e228e7fba999fa7f098596114461f5e519190ad958afde82` | 661 |
| `packages/dsh-game-battleship/index.js` | `c8b7dd23f969ba1a3df60697085f06cf58f56591bc2709988ffce51ebded25bf` | 316 |
| `packages/dsh-game-battleship/cordis.patch.yml` | `32d72f289cd602443564dc04f9cbb982ea29e8d066c38da58b1e49dfdaeda71d` | 77 |
| `packages/dsh-game-battleship/locale/zh.json` | `6a7e39f83584089c3976ec61e00f976aa4878fd472f6eb241b922b0c8e947df7` | — |
| `packages/dsh-game-battleship/locale/en.json` | `c792a67501a9e4885746c5745082013ec2a2f5875bcc852c4c163a6729580b58` | — |
| `packages/dsh-game-battleship/icon.svg` | `848d03d0af4300cdc99d1388dd9538dfe904035aa18f5d585ad4468106ce158c` | 973 |
| `packages/dsh-game-battleship/README.md` (Lead-owned) | `19af0a80a0495d651feea8ffbde9be98baa98adfa03541db97604c69d3bee348` | 8,877 |

`client.js` is **96,085 B**, sha256 `b81a41ff…` (mtime 2026-10-18 19:39:03) —
the **frozen build**. The full suite was run on this hash and the hash was
identical **before and after** the final battery; all counts are the same as on
`4d0a49d9` (UI-only change). Revision history of the frozen candidate:
- `cfcca13a` fixed the place-phase `sanitizeState` fall-through (5-ship
  randomized-but-not-started saves are now accepted/restorable) and added the
  resize-recovery measurement (`layout.usedFallback`/`canRefine`, bounded rAF
  refine budget) plus the view-only `view.shipDock` placement dock.
- `4d0a49d9` fixed narrow-screen stacking (`.dshbs-body` `flexDirection: row`
  when `layout.sideBySide`, else `column`) — CSS-only, no seam/state change.
- `b81a41ff` is one inline-style-only change on top of `4d0a49d9`
  (`.dshbs-fleet` gets `minHeight: layout.shipListH` so the two panels are equal
  height and their boards align vertically when side-by-side); no
  seam/state/logic/save change (verified: all suites re-run, identical counts).
Earlier in-development builds (e.g. `58558d…`, `b930…`, `94…`) were audited
during development too; **all counts in this report are for `b81a41ff…`**. The
Lead confirmed the seam/test-seam contract used here.

## 1. How to reproduce (repo root)

```powershell
node packages/dsh-game-battleship/dev/audit/reference-selftest.mjs                 # oracle self-test
node packages/dsh-game-battleship/dev/audit/check-contract.mjs                      # static contract/manifest
node packages/dsh-game-battleship/dev/audit/check-host-untouched.mjs                # host/contract baseline
node packages/dsh-game-battleship/dev/audit/diff-fuzz.mjs --games 20 --actions 400  # differential rules
node packages/dsh-game-battleship/dev/audit/save-fuzz.mjs --mutations 5000          # persistence fuzz
node packages/dsh-game-battleship/dev/audit/lifecycle.mjs                           # lifecycle/registration
```

All scripts are read-only reporters: exit `0` = pass, non-zero = FAIL/BLOCKER.
See `dev/audit/README.md` for the file map.

## 2. Results

| suite | result | scale |
|---|---|---|
| `reference-selftest.mjs` | **23/23 oracle tests pass**, exit 0 | RNG, geometry, adjacency, placement, fleets, shots, state machine, AI, validator |
| `check-contract.mjs` | **119 checks: 118 pass, 0 fail, 0 pending, 1 note**, exit 0 | final files incl. package README |
| `check-host-untouched.mjs` | **10/10 baseline files unchanged**, exit 0 | `packages/dsh-game-host/**` (8) + `handoff/contract/**` (2) |
| `diff-fuzz.mjs` | **0 mismatches**, exit 0 | 20 seeds, **50,273 comparisons**, 20/20 games finished (easy 8 / normal 6 / hard 6), 5 edge scenarios |
| `save-fuzz.mjs` | **462/462 checks, 0 failures**, exit 0 | 32 lossless round-trips (incl. place 0/1/4/5 ships), 5,000 mutations × 2 forms = **10,000 `sanitizeState` calls, 0 throws**, 46+6 must-reject cases |
| `lifecycle.mjs` | **17/17 tests pass**, exit 0 | registration, mount/layout, shipDock, placement, delayed AI, destroy/reload, visibility pause, hygiene |

## 3. Contract / manifest / registration

`check-contract.mjs` (119 checks) verifies, against the final files:

- `package.json`: name `@local/dsh-game-battleship`, version 0.1.0, private, ESM,
  exactly four `exports` (`.`, `./client`, `./locale/*.json`, `./icon`), `files`
  covers every runtime file and excludes `dev/`,
  `dsh.bundle.patch = ./cordis.patch.yml`, `dsh.client{platform:'web', immediately:true}`,
  **no** `dependencies`/`devDependencies`/`peer`/`optional`, **no** `dsh.client.inject`.
- `cordis.patch.yml`: `- insert:` / `id: game-battleship` / `name: '@local/dsh-game-battleship'`;
  the patch id, package name and save key collide with no sibling game package.
- `index.js`: only `export function apply() {}` (host half stays empty).
- `locale/zh.json` = 海战棋 + description; `locale/en.json` = Battleship +
  description; valid JSON, only `meta`, no U+FFFD.
- `icon.svg`: real `<svg>` with viewBox, no external refs, ≤256 KiB; no binary
  assets inside the publish scope.
- `client.js` registration: loader id equals the package name (via `MODULE_ID`),
  factory/require only `react`, no ESM import, `inject: ['slots']` exactly,
  **exactly one** `slots.inject('game.stage', …)` and **one** `slots.register(...)`,
  `name:'game.stage'`, `id:GAME_ID`, `GAME_ID='battleship'`, `label()` returns
  海战棋, strict `gameId === GAME_ID` select returning `null` otherwise, no
  `ctx.provide`, no host/session internals.
- save contract: key `dsh.game.battleship.v1` (derived as `'dsh.game.' + GAME_ID + '.v1'`;
  no other `dsh.game.*` literal referenced), `SCHEMA_VERSION = 1`, localStorage
  accesses guarded; only its own key is read/written (dynamically confirmed).
- safety: **no** window/document `keydown`/`keyup`/`keypress`; **no**
  `document.body` / `document.head` / `document.title`; no fetch/XHR/WebSocket/
  EventSource/sendBeacon; no `document.write`; no dynamic import; keyboard only
  via the root `onKeyDown` prop (R = rotate); window listeners only `resize`,
  document listener only `visibilitychange`; right-click suppressed.
- rendering/styling: root class `.dshbs-root` is `width:100%; height:100%`,
  `ResizeObserver`, rAF-deferred relayout, `<320×240` / min-board hint, ≥5
  `--dsw-alias-*` tokens, prefixed `dshbs-*` CSS, style element injected as a
  React child (not into `document.head`/`body`), `devicePixelRatio` tracked.
- Battleship data attributes present: `data-dsh-game`, `data-phase`, `data-turn`,
  `data-board`, `data-cell`, `data-shot`, `data-ship`, `data-sunk`, `data-action`
  (incl. dynamic `difficulty-*`), `data-status`, `data-message`; shipped actions
  rotate/randomize/start/new-game/restart/surrender/place-undo/toggle-adjacent.
- test seam gated by `window.__DSH_GAME_BATTLESHIP_TEST__ === true` and published
  via `Object.defineProperty(window, '__DSH_GAME_BATTLESHIP__', …)`; all declared
  pure functions present.

Dynamic registration (`lifecycle.mjs` test 1) instantiates the real module
factory with a fake `require('react')` and a fake slot ctx: exactly one
`inject('game.stage')`, one `register(...)`, label 海战棋, `select({gameId:'battleship'})`
returns a **frozen** object stable across calls, other gameIds/`{}`/`null`/
`undefined` → `null`, component is a function, no services provided, no console
errors.

## 4. Rules correctness — differential fuzz vs independent oracle

Oracle: `dev/audit/reference-battleship.mjs`, written from the spec only (own
mulberry32/stepRng, row-major cell geometry, Chebyshev-8 adjacency, fleet/ship
validator, shot resolution, place/battle/over state machine, hunt/target +
density AI reference, full state validator, canonical export/diff). It does not
import or copy `client.js`; it is itself validated by `reference-selftest.mjs`
(23 tests, incl. hand-computed geometry counts `(10−len+1)·10` per orientation,
diagonal adjacency, sunk naming, winner/turn flow, AI invariants and corruption
detection).

`diff-fuzz.mjs` — 20 seeds (`0`, `0xffffffff`, `1..18`) with placement + battle
differentials, **50,273 comparisons, 0 mismatches**. Counts:

- constants 10, rng 360, rng-step 720 (mulberry32 + `stepRng` values/state match),
  randomSeed 9 (uint32, varied).
- `shipCells` 1,480 — **all** origins (−2..102) × lengths 0..6 × both orientations,
  plus non-integer/NaN/string origins and lengths; identical to the oracle
  (row-major indexing confirmed: a transposed implementation would diverge).
- `isValidPlacement` 7,452 — random fleets with random candidates plus
  deliberately illegal candidates (overlap, duplicate cells, out-of-bounds,
  negative/NaN/string cells, orthogonal and **diagonal** adjacency); verbatim
  verdict agreement, and every refusal carries a non-empty reason.
- `randomFleet` 323 — 40 seeds × {allowAdjacent false, true}: always a legal
  5-ship fleet in roster order, deterministic per seed, varied; invalid rng →
  `null`.
- `newGameState` 16 + 20 battle-setup + 20 placement-final: phase/fleets/shots/
  turn/winner/seed/rng/orientation/placementIndex match the oracle shape.
- placement 10,175 (+ state validity 3,200): `canPlaceCurrent` does not mutate,
  refusals don't mutate, accepted placements/undos/orientation changes match the
  oracle exactly (including top/bottom-edge out-of-bounds attempts).
- fire 4,428 result/shipKey comparisons, fire-state 4,428 full-state diffs,
  fire-refused 391 purity checks — deliberate repeats and invalid cells
  (`-1`, `100`, `1.5`, `NaN`, `'5'`, `null`) are refused by both engines with no
  mutation; every accepted shot mutates `playerShots`, `turn`, `phase`, `winner`
  and `endReason` exactly like the oracle.
- AI turns: ai-fire 8,838 (each AI shot verified to target an **unknown** cell)
  and ai-fire-state 4,419 full-state diffs; shot-resolution results/ship keys
  always match the oracle.
- `sunkKeys` 348 + `allSunk` 348 per-side checks (side = player own fleet vs
  enemy fleet) match the oracle during live games.
- AI property probes: ai 1,170 (aiChooseCell never returns a fired cell, returns
  `null` only when no unknown cell remains, and mutates **only** `state.rng`),
  ai-target 54 (normal/hard chase unresolved-hit neighbours; normal may also
  line-extend), ai-line 9, ai-density 81 (hard picks a maximum-density cell in
  its decision pool), ai-easy 1,682 (easy is unfired + varied + not
  target-locked). 99-cells-fired scenario: every difficulty returns the single
  remaining cell; 100-cells-fired: `null`.
- battle-final 40 + after-over 40 + battle-state 20: every finished game state is
  oracle-valid; firing/AI after game over is refused and inert.
- Edge scenarios (57+18+10+7+6+6+5+6 checks): diagonal adjacency rejected and
  two-rows-apart accepted; `allowAdjacent` toggle on lets ships touch and
  refuses to turn back off while ships are adjacent; sinking all 17 cells gives
  exactly 4 `sunk` + 1 `win` on the last cell with the correct ship key/name and
  `endReason='sunk'`; surrender gives winner=enemy/endReason=surrender and
  round-trips through save; refusals after over.
- All 20/20 games finished in ≤225 actions (easy 8, normal 6, hard 6); no
  deadlock, no stuck state, invariants valid after every action.

## 5. Save / persistence robustness

`save-fuzz.mjs` — **462/462 checks, 0 failures**:

- **Round-trip (32 cases, lossless):** 6 seeds × {place-phase partial fleet,
  battle, mid-AI-turn (turn=enemy)} + battle at each difficulty + a battle with
  `allowAdjacent:true` + place-phase states with **0, 1, 4 and 5 player ships**
  (5 = "randomized but not started", enemyShips empty) + 3 random finished games
  + a player win + an enemy win + a surrender. `serializeState` → JSON →
  `sanitizeState` reproduces the save byte-identically (ships, shots, seed, rng,
  phase, turn, winner, endReason, difficulty, allowAdjacent, orientation,
  placementIndex); accepted states pass the independent validator;
  `sanitizeState(serializeState(x))` is a fixed point.
- **Place-phase rules (new revision):** saves with 0/1/4/5 placed ships are
  accepted, keep `placementIndex`, keep `enemyShips` empty and force
  `endReason` to `null`; each is lossless, fixed-point and independently valid.
  6/6 place-specific corruptions are rejected: non-empty `enemyShips`, shots on
  the board, a winner, `turn=enemy`, `placementIndex` mismatch, six ships.
  An `endReason:'sunk'` on a place save is **normalized to null**, not fatal.
- **Corruption:** 5,000 mutations × 2 forms (JSON-parsed = real localStorage and
  raw objects with `NaN`/`Infinity`/`undefined`/arrays) = **10,000 `sanitizeState`
  calls: 0 throws**, 896 accepted (all renormalized/independently valid and
  fixed-point stable), 9,104 rejected.
- **46/46 hand-written must-reject cases rejected** (battle/persistence
  invariants), one per invariant: wrong/
  missing schemaVersion, top-level array/null/string, bad seed/rng (negative,
  >2³², non-integer), bad phase/allowAdjacent/difficulty/orientation,
  placementIndex out of range or mismatched, ship overlap, out-of-bounds cells
  (100, −1), wrong length, non-contiguous cells, ship-key mismatch/duplicate,
  **adjacency violation incl. diagonal**, hit on water, miss on ship, hit/miss
  inconsistency on the AI board, shot value 3/`'2'`, shot array too short/long,
  winner mismatch (not sunk), winner=enemy without sunk fleet or surrender, over
  without winner, winner on a battle state, bad winner, turn mismatch in battle,
  broken shot parity, bogus endReason, missing fleets, non-array/null shots.
- **Parity/turn/endReason machine invariants** are enforced independently
  (playerFired === enemyFired or enemyFired+1; battle turn must be `enemy` iff
  odd parity; winner=player needs enemy fleet sunk + odd parity + endReason
  `sunk`; winner=enemy needs even parity and either player fleet sunk (endReason
  `sunk`) or endReason `surrender`).
- **Load path:** 18 hand-written garbage saves + 200 random mutations through
  `loadSavedState` never throw, agree with `sanitizeState`, and valid saves load
  identically.
- **Key isolation:** `saveStateToStorage` writes exactly
  `dsh.game.battleship.v1` and creates no other key; a planted
  `dsh.game.quoridor.v1` and an unrelated key are untouched; `loadSavedState`
  ignores them.
- **Throwing localStorage survived:** `loadSavedState()` → `null`,
  `saveStateToStorage()` → `false`, and `createGame` + `destroy` do not throw.
- Save is stable across save→load→save; observed max save size **1,057 bytes**
  (< 64 KiB); place-phase reload keeps the placed ships and empty enemy fleet.

## 6. Lifecycle (headless, fake DOM/window; 17/17 pass)

- registration test above; constants (id, key, schema 1, min 320×240, ship lens).
- mount: emits a place-phase view (`playerCells`/`enemyCells` 100 each, stats,
  0 placed), `ResizeObserver` observes the host, fresh game persisted
  immediately, no console errors.
- layout: `computeLayout` returns `tooSmall` for 300×200/319×700/1024×239/
  320×240/NaN, finite positive `boardPx`/`cellPx` above the threshold; resizing
  300×220 → 900×680 flips the too-small hint and re-emits; a devicePixelRatio
  change to 3 is observed. The new resize-recovery path (`measure()` fallback +
  bounded rAF refine) is exercised by creating the game on a host with no
  `[data-dsh-body]` child (fake host: `querySelector` returns null) and then
  resizing; layout stays finite/valid (`usedFallback`/`canRefine` are view-only
  measurement hints and do not change game state).
- placement dock: `view.shipDock` is an array of the 5 ships in roster order in
  the place phase, with `placed`/`current` flags (all unplaced, first current at
  mount; first placed / second current after one placement; all placed after
  randomize); it is empty in battle. Purely view state — no rules effect.
- placement via controller: click places the carrier, illegal click is refused
  with a message and no mutation, rotate flips orientation, an illegal
  orthogonal/diagonal placement is rejected, undo pops, randomize yields 5
  oracle-legal ships, every action persists.
- battle: player fires first, turn becomes enemy, exactly one 520 ms AI timer is
  scheduled, the AI does not move before the delay, then fires exactly once,
  turn returns to player, and the view reflects the AI shot; the AI never
  repeats a cell.
- sunk/win messaging: firing a ship's cells produces a 击沉/全灭 message
  containing that ship's Chinese name; repeat fire is inert.
- destroy: persists the exact live state, removes window/document listeners,
  disconnects the ResizeObserver, clears pending AI/message timers, is idempotent
  (second destroy writes nothing), post-destroy `clickCell` is inert.
- reload: place-phase ships restored; mid-battle state (fleets, shots, turn)
  restored byte-identically; a save made mid-AI-turn restores turn=enemy,
  shows `aiThinking`, and resumes the AI after the delay exactly once.
- `document.hidden`: a pending AI turn is paused (no timer, no move after 60 s
  hidden), the state is persisted with turn=enemy, and returning to visible
  resumes exactly one AI move.
- restart keeps fleets and clears both shot boards; new game starts a fresh
  place phase with a new seed; difficulty and allow-adjacent settings persist and
  reach the view; surrender → over/winner=enemy/endReason=surrender, saved and
  independently valid.
- corrupt saves (invalid JSON, null, array, bad schema, inconsistent battle)
  → fresh valid place-phase game, no throw.
- hygiene: after mount+play, window listeners = `['resize']`, document listeners
  = `['visibilitychange']`, no keydown/keyup/keypress on either, zero
  `document.body` touches, no `body`/`html` elements created.

## 7. Notes (non-blocking)

1. **Normal-mode line continuation can chase an already-sunk ship.** In
   `client.js` `lineContinuationCells()` scans every hit cell without excluding
   ships that are already sunk, and `aiChooseCell('normal')` prefers that list
   over the unresolved-hit neighbours. Repro: `node dev/audit/_debug-probe.mjs`
   (diff-fuzz seed 7, step 115) — cell 22 is the unknown end of the fully-sunk
   battleship run 23–26, chosen while unresolved destroyer hit 97 had targets
   {87, 96, 98}. Seen 3 times in 54 AI target probes. It does not violate a hard
   requirement: no cell is repeated, no deadlock, and every shot's result/state
   transition still matches the oracle — it is a small strategy inefficiency only
   (one wasted shot). Suggested (optional) fix: skip sunk ships in
   `lineContinuationCells`. I did **not** modify `client.js`.
2. **DOM rendering path.** The board is DOM-rendered (no `<canvas>`), so contract
   §5's canvas-DPR rules do not literally apply; `check-contract.mjs` records this
   as a NOTE. The client still tracks `devicePixelRatio` and re-lays out on dpr
   changes (dynamically verified), so the §5 intent is met.
3. **Test-seam shape.** The actual seam (Lead-declared) adds `endReason` to the
   state and helpers such as `randomizePlayerFleet`, `allSunk(state, side)` /
   `allSunkRaw(shots, ships)`, `normalizeShipCells`, `fleetSubsetOk`,
   `fleetCompleteOk`, `restartBattle`, `surrender`, `stepRng`, `countShotCells`,
   `countHitCells`. All dynamic tests use the actual names; the seam is gated by
   `window.__DSH_GAME_BATTLESHIP_TEST__ === true` and is dev-only.
4. **Revision changes verified.** (a) the place-phase `sanitizeState`
   fall-through is fixed: 5-ship randomized-but-not-started saves are accepted and
   restored, and place saves with enemyShips/shots/winner/turn/index violations
   are still rejected (added coverage in `save-fuzz.mjs`); (b) resize recovery
   (`measure()` fallback, `layout.usedFallback`/`canRefine`, bounded rAF refine)
   does not regress mount/resize/dpr behaviour (lifecycle); (c) `view.shipDock` is
   view-only and reflects placement progress (lifecycle); (d) the `4d0a49d9`
   CSS-only stacking change and the final `b81a41ff` inline-style-only equal-panel
   change (`.dshbs-fleet` `minHeight`) leave every logic/save/lifecycle count
   unchanged (suites re-run on the final hash). No rules/save regression was
   observed. For completeness, the Lead reports its own `test-logic` 23/23 and
   `test-headless` 19/19, and the preview-dev Chromium run (`dev/PREVIEW.md`:
   26/26 page self-test, 6 screenshots in `dev/screenshots/`) on the final hash;
   those are the Lead's/preview-dev's runs, **not** independently audited here.

## 8. Honest limits (what this audit did NOT verify)

- **Headless only.** `client.js` was imported into Node with a fake
  `window`/`document`/localStorage/ResizeObserver/rAF/timers. Real React
  rendering, real browser layout/paint, dark/light readability, high-DPI
  crispness and pointer/click hit-testing are **not** verified here; the Lead's
  separate Chromium preview pass (preview-dev, `dev/PREVIEW.md` + 6 screenshots
  in `dev/screenshots/`) reports green on the final hash, but I did not run it and
  no screenshots were produced by this audit.
- **No plugin installation / no DSH host GUI.** "Directory shows 海战棋 / slot
  mounts in the host / error boundary behaves in the host" is the user's/Lead's
  browser acceptance, not mine.
- **AI exact choices are property-checked, not diffed.** The handoff leaves the
  AI strategy implementation free, so the audit does not compare AI-selected cells
  to the reference AI; it checks hard invariants (never fires a fired cell, only
  rng mutation, no deadlock, games terminate), the spec's hunt/target priority
  (via ground-truth unresolved hits), easy randomness, hard density best-cell
  behaviour and 99/100-cell edge cases. This is not a statistical proof of AI
  strength.
- The reference oracle is an independent reimplementation from the spec, itself
  self-tested first; agreement with it is strong evidence but not a formal proof.
- Seeded paths are deterministic; `randomSeed()` itself uses Node/Web crypto for
  new-game seeds (only its uint32/range/variety was asserted).
- Host + contract hashes prove `packages/dsh-game-host/**` and
  `handoff/contract/**` are unchanged from the pre-audit baseline
  (`dev/audit/baseline-hashes.json`, 10/10 match). Sibling game packages were
  only read; the package `README.md` is Lead-owned and was written during the
  audit.

## 9. If a divergence is ever found

`diff-fuzz.mjs` prints the first mismatches with kind/context and a replay
command (`--seed N --actions M --verbose`); `save-fuzz.mjs` prints the failing
check plus the mutation description. All scripts are deterministic, so the same
`client.js` hash + arguments reproduce the same counts.
