/**
 * _debug-probe.mjs — repro for the non-blocking AI note in VERIFIER.md (§7.1).
 *
 * Replays diff-fuzz seed 7 to step 115 and prints the client AI's decision
 * inputs. It shows normal-mode `lineContinuationCells()` returning cell 22 (the
 * unknown end of an already-SUNK battleship hit-run) while unresolved-hit
 * targets {87,96,98} exist around the destroyer hit at 97. The client picks the
 * line cell first; this wastes one shot but repeats no cell and never deadlocks,
 * and every shot outcome still matches the independent oracle.
 *
 * Run: node packages/dsh-game-battleship/dev/audit/_debug-probe.mjs
 * Read-only.
 */
import * as ref from './reference-battleship.mjs'
import { seam } from './harness.mjs'

const seedValue = 7
const clientState = seam.newGameState(seedValue)
clientState.difficulty = 'normal'
let randomized = false
for (let attempt = 0; attempt < 20 && !randomized; attempt += 1) if (seam.randomizePlayerFleet(clientState).ok) randomized = true
seam.startBattle(clientState)
const rng = ref.makeRng(((seedValue ^ 0x51ed270b) >>> 0))
for (let step = 0; step <= 115; step += 1) {
  if (clientState.phase !== 'battle') break
  if (clientState.turn === 'player') {
    const fired = []
    for (let pos = 0; pos < 100; pos += 1) if (clientState.playerShots[pos] !== 0) fired.push(pos)
    let cell
    if (fired.length > 0 && rng() < 0.12) cell = fired[Math.floor(rng() * fired.length)]
    else if (rng() < 0.1) {
      const bad = [-1, 100, 1.5, NaN, '5', null]
      cell = bad[Math.floor(rng() * bad.length)]
    } else {
      const unfired = ref.unfiredCells(clientState.playerShots)
      cell = unfired[Math.floor(rng() * unfired.length)]
    }
    seam.fireAt(clientState, cell)
  } else {
    seam.aiFire(clientState)
  }
  if (step === 115) {
    const hits = seam.unresolvedHitCells(clientState)
    const line = seam.lineContinuationCells(clientState)
    const neighbours = seam.adjacentUnknownCells(clientState)
    const targets = ref.targetCells(clientState.playerShips, clientState.enemyShots)
    console.log(JSON.stringify({ step, turn: clientState.turn, hits, line, neighbours, targets }, null, 2))
    console.log('line cell(s) ' + JSON.stringify(line) + ' belong to an already-sunk ship run; unresolved targets are ' + JSON.stringify(targets))
  }
}
