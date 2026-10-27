# Independent audit (verifier) — packages/dsh-game-battleship/dev/audit/

This directory is the **independent verifier's** audit assets for the 8th game
plugin, Battleship (海战棋). It is dev-only: `package.json` `files` does not
include `dev/`, so none of it ships.

Audit target: `packages/dsh-game-battleship/` (task `handoff/to-sub/010-add-battleship.md`,
contract `handoff/contract/game-plugin-api.v1.md` v1). I only read runtime files;
writes are confined to this directory. Full findings: [`VERIFIER.md`](./VERIFIER.md).

All scripts are **read-only reporters**: they print results to stdout and exit
`0` on pass, non-zero on any FAIL/BLOCKER. Rerun any of them from the repo root.

## Files

| file | purpose |
|---|---|
| `harness.mjs` | headless fake `window`/`document`/localStorage/`ResizeObserver`/rAF/`setTimeout` + dynamic `import` of `client.js` with `window.__DSH_GAME_BATTLESHIP_TEST__ = true`; exports the test seam and deterministic time helpers |
| `reference-battleship.mjs` | independent Battleship rules oracle written from the spec (own mulberry32, geometry, adjacency-incl-diagonals, fleet validator, shot resolution, turn/win state machine, hunt/target + density AI reference, full state validator, export/diff) — does **not** import or copy `client.js` |
| `reference-selftest.mjs` | oracle self-test: RNG, geometry counts, 8-neighbour adjacency, placement legality, fleet validation, random fleets, sunk naming/win, turn flow, AI invariants, state-corruption detection (23 tests) |
| `check-contract.mjs` | static contract audit: package.json / cordis.patch.yml / index.js / locale / icon / registration shape / save key + schema / safety greps / Battleship data attributes / cross-package id-name-key collisions / packaging hygiene |
| `baseline-hashes.json` + `check-host-untouched.mjs` | pre-audit sha256 baseline of `packages/dsh-game-host/**` + `handoff/contract/**`; re-verified unchanged at the end (`--print` regenerates a baseline candidate) |
| `diff-fuzz.mjs` | differential rules fuzz vs the oracle: geometry, placement, full battle walk (player fire + AI turns), sunk naming/win, per-side `sunkKeys`/`allSunk`, AI properties (never repeat, rng-only mutation, hunt/target ground truth, line continuation, easy randomness, hard density best-cell, 99/100 cells), edge scenarios (diagonal adjacency, allowAdjacent toggle, win on the last cell, surrender) |
| `save-fuzz.mjs` | persistence audit: lossless serialize/sanitize round-trip in every phase (place / battle / mid-AI-turn / win / surrender, all difficulties, allowAdjacent), 5,000 corrupt mutations × 2 forms (JSON + raw), independent validator, fixed point, `loadSavedState` garbage, key isolation, throwing `localStorage` |
| `lifecycle.mjs` | headless registration + controller lifecycle: mount/view emission, ResizeObserver, too-small hint + resize + dpr, placement actions, player fire, delayed AI turn (520 ms), destroy persist/idempotent/listener cleanup, place/mid-battle/mid-AI-turn reload, `document.hidden` pause, hygiene (no global keydown, no `document.body`) |
| `_debug-probe.mjs` | repro for the one non-blocking AI note (§7.1 in VERIFIER.md) |
| `VERIFIER.md` | final verdict, per-suite counts, exact repro commands, honest limits |

## Repro commands (repo root)

```powershell
node packages/dsh-game-battleship/dev/audit/reference-selftest.mjs     # oracle self-test
node packages/dsh-game-battleship/dev/audit/check-contract.mjs          # static contract/manifest
node packages/dsh-game-battleship/dev/audit/check-host-untouched.mjs    # host/contract baseline
node packages/dsh-game-battleship/dev/audit/diff-fuzz.mjs               # 20 seeds x 400 actions
node packages/dsh-game-battleship/dev/audit/save-fuzz.mjs --mutations 5000
node packages/dsh-game-battleship/dev/audit/lifecycle.mjs               # lifecycle/registration
node packages/dsh-game-battleship/dev/audit/_debug-probe.mjs            # AI note repro (optional)
```

## Honest boundaries

- Headless only: real React rendering, real browser layout/paint, dark/light
  readability and click hit-testing are covered by the Lead's Chromium preview
  pass, not here.
- No plugin installation and no DSH host GUI were run (not permitted / not
  needed for this audit).
- AI **exact** cell choices are intentionally not compared to a reference AI
  (the handoff leaves the strategy implementation free); the AI is checked
  against properties/invariants while every shot it causes is diffed exactly
  against the oracle.
- `reference-battleship.mjs` is an independent reimplementation from the spec,
  itself validated by `reference-selftest.mjs`; it is not a formal proof.
