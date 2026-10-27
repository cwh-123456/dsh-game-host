/**
 * diff-fuzz.mjs — differential rules audit: client.js test seam vs independent oracle.
 *
 * Run (repo root):
 *   node packages/dsh-game-battleship/dev/audit/diff-fuzz.mjs
 *   node packages/dsh-game-battleship/dev/audit/diff-fuzz.mjs --games 20 --actions 400
 *   node packages/dsh-game-battleship/dev/audit/diff-fuzz.mjs --seed 12345 --verbose   # single-game repro
 * Read-only. Exit 0 = no divergence; 1 = divergence (first mismatches printed).
 *
 * What is compared, for every seed:
 *   1. constants + mulberry32/stepRng sequences.
 *   2. shipCells() geometry exhaustively (all origins x lengths x orientations).
 *   3. isValidPlacement() verdicts on random fleets and deliberately illegal
 *      candidates (overlap / adjacency incl. DIAGONAL / duplicates / out of bounds).
 *   4. randomFleet(): always legal (both allowAdjacent modes), deterministic.
 *   5. newGameState() shape.
 *   6. placement actions: canPlaceCurrent / placeCurrent / removeLastShip /
 *      rotateOrientation, including refusals and purity of refusals.
 *   7. full battle walk (player fire + AI turns): fireAt result/shipKey and the
 *      complete resulting state (shots, turn, winner, phase, endReason), plus
 *      sunkKeys/allSunk per side and the oracle state invariants after every
 *      action.
 *   8. AI invariants: never repeats a fired cell, only advances rng, never
 *      returns null with cells left; hunt/target property (normal+hard) against
 *      the oracle's ground-truth unresolved-hit targets; easy=randomness; hard
 *      density-map best-cell property; no deadlock (games complete).
 *   9. edge scenarios: diagonal adjacency, allowAdjacent toggle, sinking every
 *      ship in order (sunk naming + win on the last cell), 99/100 fired cells,
 *      surrender, refusals after game over.
 *
 * AI *exact* cell choices are NOT compared to a reference AI (the handoff leaves
 * the AI implementation free); instead the AI is checked against properties and
 * the client's own density/line helpers, while every shot resolution and state
 * transition it causes is compared exactly against the oracle.
 */
import * as ref from './reference-battleship.mjs'
import { seam, clone } from './harness.mjs'

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2)
function arg(name, fallback) {
  const index = argv.indexOf('--' + name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}
const GAMES = Math.max(1, Number(arg('games', 20)))
const ACTIONS = Math.max(1, Number(arg('actions', 400)))
const ONLY_SEED = arg('seed', null)
const VERBOSE = argv.includes('--verbose')
const seeds = ONLY_SEED !== null
  ? [Number(ONLY_SEED) >>> 0]
  : [0, 0xffffffff, ...Array.from({ length: Math.max(0, GAMES - 2) }, (_, i) => i + 1)]

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */
let checks = 0
const counts = {}
const mismatches = []
const notes = new Map()
const MAX_PRINTED = 10

function note(kind, detail) {
  notes.set(kind, (notes.get(kind) || 0) + 1)
  if (VERBOSE) console.log('  NOTE [' + kind + '] ' + JSON.stringify(detail))
}

function bump(kind) {
  counts[kind] = (counts[kind] || 0) + 1
}

function record(kind, context, detail) {
  mismatches.push({ kind, context, detail })
  if (mismatches.length <= MAX_PRINTED) {
    console.log(`\nMISMATCH #${mismatches.length} [${kind}]`)
    console.log('  context: ' + JSON.stringify(context))
    console.log('  detail : ' + JSON.stringify(detail).slice(0, 3000))
  }
}

function check(kind, context, condition, detail) {
  checks += 1
  bump(kind)
  if (!condition) record(kind, context, detail || {})
  return !!condition
}

function checkEqual(kind, context, actual, expected) {
  return check(kind, context, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

/* ------------------------------------------------------------------ *
 * State helpers (the oracle state mirrors the client's declared shape)
 * ------------------------------------------------------------------ */

function mirrorOf(clientState) {
  return {
    schemaVersion: ref.SAVE_SCHEMA_VERSION,
    seed: clientState.seed,
    rng: clientState.rng,
    phase: clientState.phase,
    allowAdjacent: clientState.allowAdjacent,
    difficulty: clientState.difficulty,
    orientation: clientState.orientation,
    placementIndex: clientState.placementIndex,
    playerShips: clone(clientState.playerShips),
    enemyShips: clone(clientState.enemyShips),
    playerShots: clientState.playerShots.slice(),
    enemyShots: clientState.enemyShots.slice(),
    turn: clientState.turn,
    winner: clientState.winner,
    endReason: clientState.endReason,
  }
}

function compareFullState(kind, context, clientState, oracleState) {
  checks += 1
  bump(kind)
  const diffs = ref.diffState(ref.exportState(oracleState), ref.exportState(clientState))
  if (diffs) {
    record(kind, context, { diffs })
    return false
  }
  return true
}

function compareValidity(kind, context, clientState) {
  checks += 1
  bump(kind)
  const problems = ref.validateState(clientState)
  if (problems.length) {
    record(kind, context, { problems: problems.slice(0, 8), state: ref.describeState(clientState).slice(0, 1200) })
    return false
  }
  return true
}

function expectedEndReason(state) {
  if (state.phase !== 'over') return null
  if (state.winner === 'player') return 'sunk'
  return state.endReason === 'surrender' ? 'surrender' : 'sunk'
}

function compareEndReason(kind, context, clientState) {
  checks += 1
  bump(kind)
  const expected = expectedEndReason(clientState)
  if (clientState.endReason !== expected) {
    record(kind, context, { actual: clientState.endReason, expected, phase: clientState.phase, winner: clientState.winner })
    return false
  }
  return true
}

/* ------------------------------------------------------------------ *
 * 1. Constants + RNG
 * ------------------------------------------------------------------ */

function checkConstants() {
  checkEqual('const', { name: 'GAME_ID' }, seam.GAME_ID, 'battleship')
  checkEqual('const', { name: 'STORE_KEY' }, seam.STORE_KEY, 'dsh.game.battleship.v1')
  checkEqual('const', { name: 'SCHEMA_VERSION' }, seam.SCHEMA_VERSION, 1)
  checkEqual('const', { name: 'BOARD' }, seam.BOARD, ref.SIZE)
  checkEqual('const', { name: 'CELLS' }, seam.CELLS, ref.CELL_COUNT)
  checkEqual('const', { name: 'FLEET_CELLS' }, seam.FLEET_CELLS, ref.TOTAL_SHIP_CELLS)
  checkEqual('const', { name: 'MIN_WIDTH' }, seam.MIN_WIDTH, 320)
  checkEqual('const', { name: 'MIN_HEIGHT' }, seam.MIN_HEIGHT, 240)
  checkEqual('const', { name: 'SHIPS' }, seam.SHIPS.map(({ key, name, len }) => ({ key, name, len })), ref.SHIPS.map(({ key, name, len }) => ({ key, name, len })))
  checkEqual('const', { name: 'DIFFICULTIES' }, seam.DIFFICULTIES.slice().sort(), ref.DIFFICULTIES.slice().sort())
}

function checkRng() {
  for (const seedValue of [0, 1, 2, 7, 42, 123456, 0x7fffffff, 0xdeadbeef, 0xffffffff]) {
    const clientRng = seam.mulberry32(seedValue)
    const oracleRng = ref.makeRng(seedValue)
    for (let step = 0; step < 40; step += 1) {
      checkEqual('rng', { seed: seedValue, step }, clientRng(), oracleRng())
    }
    let clientRngState = seedValue >>> 0
    let oracleRngState = seedValue >>> 0
    for (let step = 0; step < 40; step += 1) {
      const clientStep = seam.stepRng(clientRngState)
      const oracleStep = ref.nextRandom(oracleRngState)
      checkEqual('rng-step', { seed: seedValue, step, field: 'value' }, clientStep.value, oracleStep.value)
      checkEqual('rng-step', { seed: seedValue, step, field: 'rng' }, clientStep.rng, oracleStep.rng)
      clientRngState = clientStep.rng
      oracleRngState = oracleStep.rng
    }
  }
  const randomSeeds = new Set()
  for (let i = 0; i < 8; i += 1) {
    const value = seam.randomSeed()
    check('randomSeed', { i }, Number.isInteger(value) && value >= 0 && value <= 0xffffffff, { value })
    randomSeeds.add(value)
  }
  check('randomSeed', { distinct: randomSeeds.size }, randomSeeds.size >= 7, { distinct: randomSeeds.size })
}

/* ------------------------------------------------------------------ *
 * 2. Geometry
 * ------------------------------------------------------------------ */
function checkGeometry() {
  for (let origin = -2; origin <= 102; origin += 1) {
    for (let length = 0; length <= 6; length += 1) {
      for (const horizontal of [true, false]) {
        const clientCells = seam.shipCells(origin, length, horizontal)
        const oracleCells = ref.shipCells(origin, length, horizontal)
        checkEqual('shipCells', { origin, length, horizontal }, clientCells, oracleCells)
      }
    }
  }
  for (const origin of [1.5, NaN, '3', null, undefined]) {
    checkEqual('shipCells', { origin: String(origin), length: 3, horizontal: true }, seam.shipCells(origin, 3, true), null)
  }
  for (const length of [1.5, NaN, '3', null, undefined]) {
    checkEqual('shipCells', { origin: 0, length: String(length), horizontal: true }, seam.shipCells(0, length, true), null)
  }
}

/* ------------------------------------------------------------------ *
 * 3. Placement legality
 * ------------------------------------------------------------------ */
function checkIsValidPlacement() {
  let rng = ref.makeRng(0x51ed270b)
  const trial = (allowAdjacent) => {
    const fleet = ref.randomFleet(ref.makeRng((rng() * 0xffffffff) >>> 0), allowAdjacent)
    if (!fleet) return
    // 1) random candidate shapes (some legal, some not)
    for (let i = 0; i < 30; i += 1) {
      const length = 2 + Math.floor(rng() * 4)
      const horizontal = rng() < 0.5
      const origin = Math.floor(rng() * ref.CELL_COUNT)
      const cells = seam.shipCells(origin, length, horizontal)
      const candidate = cells || []
      const clientVerdict = seam.isValidPlacement(fleet, candidate, allowAdjacent)
      const oracleVerdict = ref.isValidPlacement(fleet, candidate, allowAdjacent)
      check('isValidPlacement', { allowAdjacent, phase: 'random', origin, length, horizontal }, !!clientVerdict.ok === !!oracleVerdict.ok, { clientVerdict, oracleVerdict })
      if (!clientVerdict.ok) check('isValidPlacement', { phase: 'random-reason' }, typeof clientVerdict.reason === 'string' && clientVerdict.reason.length > 0, clientVerdict)
    }
    // 2) deliberately illegal candidates derived from a placed ship cell
    const ship = fleet[Math.floor(rng() * fleet.length)]
    const anchor = ship.cells[Math.floor(rng() * ship.cells.length)]
    const x = ref.cellX(anchor)
    const y = ref.cellY(anchor)
    const diagonals = []
    for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [0, 1]]) {
      if (ref.inBounds(x + dx, y + dy)) diagonals.push(ref.cellAt(x + dx, y + dy))
    }
    for (const cell of diagonals) {
      const clientVerdict = seam.isValidPlacement(fleet, [cell], false)
      const oracleVerdict = ref.isValidPlacement(fleet, [cell], false)
      check('isValidPlacement', { allowAdjacent: false, phase: 'touch', cell }, clientVerdict.ok === false && oracleVerdict.ok === false, { clientVerdict, oracleVerdict })
    }
    // overlap
    const overlapVerdict = seam.isValidPlacement(fleet, [anchor, anchor], allowAdjacent)
    const overlapOracle = ref.isValidPlacement(fleet, [anchor, anchor], allowAdjacent)
    check('isValidPlacement', { allowAdjacent, phase: 'overlap' }, overlapVerdict.ok === false && overlapOracle.ok === false, { overlapVerdict })
    // out of bounds / non-integers
    for (const bad of [[-1], [100], [1.5], ['3'], [NaN]]) {
      const clientVerdict = seam.isValidPlacement(fleet, bad, allowAdjacent)
      const oracleVerdict = ref.isValidPlacement(fleet, bad, allowAdjacent)
      check('isValidPlacement', { allowAdjacent, phase: 'bad', bad: String(bad) }, clientVerdict.ok === false && oracleVerdict.ok === false, { clientVerdict })
    }
  }
  for (const allowAdjacent of [false, true]) {
    for (let round = 0; round < 60; round += 1) trial(allowAdjacent)
  }

  // explicit canonical diagonal case
  const carrier = [{ key: 'carrier', cells: seam.shipCells(0, 5, true) }]
  const cases = [
    { origin: 11, length: 2, horizontal: true, allowAdjacent: false, expectOk: false },  // diagonal
    { origin: 12, length: 2, horizontal: true, allowAdjacent: false, expectOk: false },  // diagonal
    { origin: 22, length: 2, horizontal: true, allowAdjacent: false, expectOk: true },   // two rows away
    { origin: 21, length: 4, horizontal: true, allowAdjacent: false, expectOk: true },
    { origin: 11, length: 4, horizontal: true, allowAdjacent: true, expectOk: true },    // relaxed adjacency
    { origin: 4, length: 2, horizontal: true, allowAdjacent: false, expectOk: false },   // overlap
    { origin: 96, length: 5, horizontal: true, allowAdjacent: false, expectOk: false },  // bounds
  ]
  for (const testCase of cases) {
    const cells = seam.shipCells(testCase.origin, testCase.length, testCase.horizontal) || []
    const clientVerdict = seam.isValidPlacement(carrier, cells, testCase.allowAdjacent)
    const oracleVerdict = ref.isValidPlacement(carrier, cells, testCase.allowAdjacent)
    check('isValidPlacement', { explicit: testCase }, clientVerdict.ok === oracleVerdict.ok && clientVerdict.ok === testCase.expectOk, { clientVerdict, oracleVerdict })
  }
}

/* ------------------------------------------------------------------ *
 * 4. randomFleet
 * ------------------------------------------------------------------ */
function checkRandomFleet() {
  for (const allowAdjacent of [false, true]) {
    const seen = new Set()
    for (let seedValue = 0; seedValue < 40; seedValue += 1) {
      const fleetA = seam.randomFleet(seam.mulberry32(seedValue), allowAdjacent)
      const fleetB = seam.randomFleet(seam.mulberry32(seedValue), allowAdjacent)
      check('randomFleet', { allowAdjacent, seed: seedValue, nonNull: true }, Array.isArray(fleetA), { fleetA: fleetA && fleetA.length })
      if (!fleetA) continue
      checkEqual('randomFleet', { allowAdjacent, seed: seedValue, deterministic: true }, fleetB, fleetA)
      checkEqual('randomFleet', { allowAdjacent, seed: seedValue, keys: true }, fleetA.map((ship) => ship.key), ref.SHIP_KEYS)
      check('randomFleet', { allowAdjacent, seed: seedValue, legal: true }, ref.validateFleet(fleetA, allowAdjacent).length === 0, ref.validateFleet(fleetA, allowAdjacent))
      seen.add(JSON.stringify(fleetA))
    }
    check('randomFleet', { allowAdjacent, variety: true }, seen.size >= 35, { distinct: seen.size })
  }
  check('randomFleet', { invalidRng: true }, seam.randomFleet(null, false) === null, { result: seam.randomFleet(null, false) })
}

/* ------------------------------------------------------------------ *
 * 5. newGameState
 * ------------------------------------------------------------------ */
function checkNewGameState(seedValue) {
  const clientState = seam.newGameState(seedValue)
  const oracleState = ref.newGameState(seedValue)
  compareFullState('newGameState', { seed: seedValue }, clientState, oracleState)
  checkEqual('newGameState', { seed: seedValue, schemaVersion: true }, clientState.schemaVersion, 1)
  checkEqual('newGameState', { seed: seedValue, endReason: true }, clientState.endReason, null)
  compareValidity('newGameState', { seed: seedValue }, clientState)
}

/* ------------------------------------------------------------------ *
 * 6. Placement differential
 * ------------------------------------------------------------------ */
function placementDifferential(seedValue) {
  const clientState = seam.newGameState(seedValue)
  const oracleState = ref.newGameState(seedValue)
  const rng = ref.makeRng((seedValue ^ 0x9e3779b9) >>> 0)
  for (let step = 0; step < 160; step += 1) {
    if (clientState.phase !== 'place') break
    const mode = rng()
    const context = { seed: seedValue, step, mode: null }
    if (mode < 0.72) {
      context.mode = 'place'
      let origin = Math.floor(rng() * ref.CELL_COUNT)
      if (rng() < 0.25) origin = Math.floor(rng() * 12) // bias towards the top edge to hit out-of-bounds
      if (rng() < 0.1) origin = 90 + Math.floor(rng() * 10) // and the bottom edge
      const orientation = rng() < 0.5 ? 'h' : 'v'
      context.origin = origin
      context.orientation = orientation
      const before = JSON.stringify(clientState)
      const clientCan = seam.canPlaceCurrent(clientState, origin, orientation)
      check('placement', { ...context, can: true }, JSON.stringify(clientState) === before, { note: 'canPlaceCurrent must not mutate the state' })
      const oracleCan = ref.canPlaceCurrent(oracleState, origin, orientation)
      check('placement', { ...context, can: true }, !!clientCan.ok === !!oracleCan.ok, { clientCan, oracleCan })
      if (clientCan.ok !== true) {
        const clientBefore = JSON.stringify(clientState)
        const clientPlace = seam.placeCurrent(clientState, origin, orientation)
        check('placement', { ...context, refused: true }, clientPlace.ok === false && JSON.stringify(clientState) === clientBefore, { clientPlace })
      } else {
        const clientPlace = seam.placeCurrent(clientState, origin, orientation)
        const oraclePlace = ref.placeCurrent(oracleState, origin, orientation)
        check('placement', { ...context, placeOk: true }, clientPlace.ok === true && oraclePlace.ok === true, { clientPlace, oraclePlace })
        checkEqual('placement', { ...context, ships: true }, clientState.playerShips, oracleState.playerShips)
        checkEqual('placement', { ...context, placementIndex: true }, clientState.placementIndex, oracleState.placementIndex)
      }
    } else if (mode < 0.86) {
      context.mode = 'undo'
      const clientUndo = seam.removeLastShip(clientState)
      const oracleUndo = ref.removeLastShip(oracleState)
      check('placement', context, !!clientUndo.ok === !!oracleUndo.ok, { clientUndo, oracleUndo })
      checkEqual('placement', { ...context, ships: true }, clientState.playerShips, oracleState.playerShips)
      checkEqual('placement', { ...context, placementIndex: true }, clientState.placementIndex, oracleState.placementIndex)
    } else {
      context.mode = 'rotate'
      const clientRotate = seam.rotateOrientation(clientState)
      const expected = oracleState.orientation === 'h' ? 'v' : 'h'
      oracleState.orientation = expected
      check('placement', context, clientRotate.ok === true && clientState.orientation === expected, { clientRotate })
      checkEqual('placement', { ...context, orientation: true }, clientState.orientation, oracleState.orientation)
    }
    compareValidity('placement-state', context, clientState)
  }
  compareFullState('placement-final', { seed: seedValue }, clientState, oracleState)
}

/* ------------------------------------------------------------------ *
 * 7. AI invariant probes (read-only, on clones)
 * ------------------------------------------------------------------ */
function probeAIBasics(state, context) {
  if (!state || state.phase !== 'battle') return
  const before = ref.exportState(state)
  const unknown = []
  for (let cell = 0; cell < ref.CELL_COUNT; cell += 1) if (state.enemyShots[cell] === 0) unknown.push(cell)
  const chosen = []
  for (let sample = 0; sample < 3; sample += 1) {
    const probe = clone(state)
    probe.rng = ((state.rng ^ ((0x9e3779b9 * (sample + 3)) >>> 0)) >>> 0)
    const cell = seam.aiChooseCell(probe)
    checks += 1
    bump('ai')
    const mutated = ref.diffState(before, ref.exportState(probe))
    if (mutated) record('ai-mutated', context, { mutated })
    if (cell === null) {
      check('ai', { ...context, nullCase: true }, unknown.length === 0, { unknown: unknown.length })
    } else {
      check('ai', { ...context, cell: true }, ref.isCell(cell), { cell })
      check('ai', { ...context, unfired: true }, state.enemyShots[cell] === 0, { cell, shot: state.enemyShots[cell] })
      chosen.push(cell)
    }
  }
  if (chosen.length === 0) return

  // Independent hunt/target property: normal and hard must chase unresolved hits.
  // normal may also extend a line of hits with the line-continuation heuristic;
  // that heuristic is allowed to look at any hit run, so the accept set is
  // (unresolved-hit neighbours) ∪ (line extensions of any hit run). A normal
  // choice that only extends an already-sunk line is recorded as a NOTE.
  if (state.difficulty !== 'easy') {
    const targets = ref.targetCells(state.playerShips, state.enemyShots)
    const lineAny = ref.lineContinuationTargets(state.enemyShots)
    if (targets.length > 0) {
      for (const cell of chosen) {
        const allowed = state.difficulty === 'normal'
          ? targets.includes(cell) || lineAny.includes(cell)
          : targets.includes(cell)
        check('ai-target', { ...context, difficulty: state.difficulty, cell }, allowed, { targets, lineAny, cell })
      }
      if (state.difficulty === 'normal' && lineAny.length === 0) {
        for (const cell of chosen) check('ai-target', { ...context, mode: 'neighbourOnly', cell }, targets.includes(cell), { targets, cell })
      }
      if (state.difficulty === 'normal') {
        for (const cell of chosen) {
          if (!targets.includes(cell) && lineAny.includes(cell)) note('sunk-line-distraction', { ...context, cell, targets, lineAny })
        }
      }
    }
  }

  // Client's own line-continuation priority (normal).
  if (state.difficulty === 'normal') {
    const hits = seam.unresolvedHitCells(state)
    if (hits.length > 0) {
      const line = seam.lineContinuationCells(state)
      if (line.length > 0) {
        for (const cell of chosen) check('ai-line', { ...context, cell }, line.includes(cell), { line, cell })
      }
    }
  }

  // Hard: chosen cell must be a maximum-density cell within the decision pool.
  if (state.difficulty === 'hard') {
    const probe = clone(state)
    const scores = seam.densityMap(probe)
    const hits = seam.unresolvedHitCells(state)
    let pool = null
    if (hits.length > 0) {
      const neighbours = seam.adjacentUnknownCells(state)
      if (neighbours.length > 0) pool = neighbours
    }
    if (!pool) pool = unknown
    if (pool.length > 0) {
      const max = Math.max(...pool.map((cell) => scores[cell]))
      for (const cell of chosen) {
        check('ai-density', { ...context, cell }, scores[cell] === max, { score: scores[cell], max, pool: pool.length })
      }
      const shouldUseTargets = state.difficulty === 'hard'
      void shouldUseTargets
    }
  }

  // Easy: genuinely random, not target-locked.
  if (state.difficulty === 'easy') {
    const targets = new Set(ref.targetCells(state.playerShips, state.enemyShots))
    const sampleCells = new Set()
    let outsideTargets = 0
    for (let sample = 0; sample < 24; sample += 1) {
      const easyProbe = clone(state)
      easyProbe.rng = ((sample * 2654435761 + 17) >>> 0)
      const cell = seam.aiChooseCell(easyProbe)
      if (cell === null) continue
      sampleCells.add(cell)
      check('ai-easy', { ...context, unfired: true }, state.enemyShots[cell] === 0, { cell })
      if (!targets.has(cell)) outsideTargets += 1
    }
    check('ai-easy', { ...context, variety: true }, sampleCells.size >= 6, { distinct: sampleCells.size })
    if (targets.size > 0) check('ai-easy', { ...context, notTargetLocked: true }, outsideTargets > 0, { outsideTargets })
  }
}

/* ------------------------------------------------------------------ *
 * 8. Battle differential
 * ------------------------------------------------------------------ */
const finishedGames = []
function battleDifferential(seedValue) {
  const clientState = seam.newGameState(seedValue)
  clientState.difficulty = ref.DIFFICULTIES[seedValue % ref.DIFFICULTIES.length]
  let randomized = false
  for (let attempt = 0; attempt < 20 && !randomized; attempt += 1) {
    const result = seam.randomizePlayerFleet(clientState)
    if (result.ok) randomized = true
  }
  if (!check('battle-setup', { seed: seedValue, randomized: true }, randomized, {})) return
  check('battle-setup', { seed: seedValue, fleetLegal: true }, ref.validateFleet(clientState.playerShips, clientState.allowAdjacent).length === 0)
  const start = seam.startBattle(clientState)
  check('battle-setup', { seed: seedValue, start: true }, start.ok === true, start)
  if (!start.ok) return
  check('battle-setup', { seed: seedValue, playerFirst: true }, clientState.phase === 'battle' && clientState.turn === 'player')
  check('battle-setup', { seed: seedValue, enemyFleetLegal: true }, ref.validateFleet(clientState.enemyShips, clientState.allowAdjacent).length === 0)
  compareValidity('battle-state', { seed: seedValue, phase: 'setup' }, clientState)

  let oracleState = mirrorOf(clientState)
  const rng = ref.makeRng(((seedValue ^ 0x51ed270b) >>> 0))
  let steps = 0
  let finished = false

  for (let step = 0; step < ACTIONS; step += 1) {
    if (clientState.phase !== 'battle') {
      finished = true
      break
    }
    steps += 1
    const context = { seed: seedValue, step, turn: clientState.turn }
    if (clientState.turn === 'player') {
      let cell
      const firedCells = []
      for (let pos = 0; pos < ref.CELL_COUNT; pos += 1) if (clientState.playerShots[pos] !== 0) firedCells.push(pos)
      if (firedCells.length > 0 && rng() < 0.12) {
        cell = firedCells[Math.floor(rng() * firedCells.length)] // deliberate repeat
        context.mode = 'repeat'
      } else if (rng() < 0.1) {
        const bad = [-1, 100, 1.5, NaN, '5', null]
        cell = bad[Math.floor(rng() * bad.length)] // deliberate invalid
        context.mode = 'invalid'
      } else {
        cell = ref.unfiredCells(clientState.playerShots)[Math.floor(rng() * ref.unfiredCells(clientState.playerShots).length)]
        context.mode = 'fire'
      }
      context.cell = cell
      const before = JSON.stringify(clientState)
      const clientResult = seam.fireAt(clientState, cell)
      const oracleResult = ref.fireAt(oracleState, cell)
      if (!clientResult.ok) {
        check('fire-refused', context, oracleResult.ok === false && JSON.stringify(clientState) === before, { clientResult, oracleResult })
        continue
      }
      check('fire', { ...context, oracleOk: true }, oracleResult.ok === true, { clientResult, oracleResult })
      checkEqual('fire', { ...context, result: true }, clientResult.result, oracleResult.result)
      checkEqual('fire', { ...context, shipKey: true }, clientResult.shipKey || null, oracleResult.shipKey || null)
      compareFullState('fire-state', context, clientState, oracleState)
      compareEndReason('fire-state', context, clientState)
      compareValidity('fire-state', context, clientState)
    } else {
      const unknownBefore = []
      for (let pos = 0; pos < ref.CELL_COUNT; pos += 1) if (clientState.enemyShots[pos] === 0) unknownBefore.push(pos)
      const clientResult = seam.aiFire(clientState)
      check('ai-fire', { ...context, ok: true }, clientResult.ok === true, { clientResult })
      if (!clientResult.ok) continue
      check('ai-fire', { ...context, unfired: true }, unknownBefore.includes(clientResult.cell), { cell: clientResult.cell })
      check('ai-fire', { ...context, validCell: true }, ref.isCell(clientResult.cell), { cell: clientResult.cell })
      const oracleResult = ref.enemyFireAt(oracleState, clientResult.cell)
      check('ai-fire', { ...context, oracleOk: true }, oracleResult.ok === true, { clientResult, oracleResult })
      checkEqual('ai-fire', { ...context, result: true }, clientResult.result, oracleResult.result)
      checkEqual('ai-fire', { ...context, shipKey: true }, clientResult.shipKey || null, oracleResult.shipKey || null)
      compareFullState('ai-fire-state', context, clientState, oracleState)
      compareEndReason('ai-fire-state', context, clientState)
      compareValidity('ai-fire-state', context, clientState)
    }

    // periodic extra checks
    if (step % 17 === 0) {
      for (const side of ['player', 'enemy']) {
        checkEqual('sunkKeys', { ...context, side }, seam.sunkKeys(clientState, side), ref.stateSunkKeys(oracleState, side))
        checkEqual('allSunk', { ...context, side }, seam.allSunk(clientState, side), ref.stateAllSunk(oracleState, side))
      }
    }
    if (step % 23 === 0) probeAIBasics(clientState, { seed: seedValue, step })
    if (VERBOSE && step % 50 === 0) console.log(`  seed ${seedValue} step ${step} turn ${clientState.turn} fired p=${ref.unfiredCells(clientState.playerShots).length} e=${ref.unfiredCells(clientState.enemyShots).length}`)
  }

  if (!finished && clientState.phase === 'battle') {
    record('unfinished', { seed: seedValue, steps }, { note: `game still in battle after ${steps} actions` })
  }
  if (clientState.phase === 'over') {
    finishedGames.push({ seed: seedValue, difficulty: clientState.difficulty, winner: clientState.winner, steps })
    compareValidity('battle-final', { seed: seedValue }, clientState)
    compareEndReason('battle-final', { seed: seedValue }, clientState)
    // after game over nothing may fire
    const frozen = JSON.stringify(clientState)
    check('after-over', { seed: seedValue, fire: true }, seam.fireAt(clientState, 50).ok === false && JSON.stringify(clientState) === frozen)
    check('after-over', { seed: seedValue, ai: true }, seam.aiFire(clientState).ok === false && JSON.stringify(clientState) === frozen)
  }
}

/* ------------------------------------------------------------------ *
 * 9. Edge scenarios
 * ------------------------------------------------------------------ */
function scenarioDiagonalAndToggle() {
  const clientState = seam.newGameState(1)
  const oracleState = ref.newGameState(1)
  const placement = seam.placeCurrent(clientState, 0, 'h')
  ref.placeCurrent(oracleState, 0, 'h')
  check('scenario-diagonal', { placement: true }, placement.ok === true)
  const diagonalCases = [11, 12, 10, 21, 22, 20]
  for (const origin of diagonalCases) {
    const clientCan = seam.canPlaceCurrent(clientState, origin, 'h')
    const oracleCan = ref.canPlaceCurrent(oracleState, origin, 'h')
    check('scenario-diagonal', { origin, can: true }, !!clientCan.ok === !!oracleCan.ok, { clientCan, oracleCan })
    if (origin === 10) check('scenario-diagonal', { origin, orthAdjacentRejected: true }, clientCan.ok === false)
    if (origin === 11) check('scenario-diagonal', { origin, diagAdjacentRejected: true }, clientCan.ok === false)
    if (origin === 22) check('scenario-diagonal', { origin, twoRowsAccepted: true }, clientCan.ok === true)
  }
  // allowAdjacent toggle
  const toggleState = seam.newGameState(2)
  seam.placeCurrent(toggleState, 0, 'h')
  const toggleOn = seam.toggleAdjacent(toggleState)
  check('scenario-toggle', { on: true }, toggleOn.ok === true && toggleState.allowAdjacent === true, toggleOn)
  const adjacentPlace = seam.canPlaceCurrent(toggleState, 10, 'h')
  check('scenario-toggle', { adjacentAllowed: true }, adjacentPlace.ok === true, adjacentPlace)
  const filled = seam.placeCurrent(toggleState, 10, 'h')
  check('scenario-toggle', { placedAdjacent: true }, filled.ok === true)
  const toggleOff = seam.toggleAdjacent(toggleState)
  check('scenario-toggle', { offRefused: true }, toggleOff.ok === false && toggleState.allowAdjacent === true, toggleOff)
  const oracleProblems = ref.validateFleet(toggleState.playerShips, false, { requireAll: false })
  check('scenario-toggle', { oracleAgrees: true }, oracleProblems.length > 0, { oracleProblems })
}

function scenarioSunkNamingAndWin() {
  const clientState = seam.newGameState(3)
  for (let attempt = 0; attempt < 20 && clientState.phase === 'place'; attempt += 1) {
    if (seam.randomizePlayerFleet(clientState).ok) break
  }
  seam.startBattle(clientState)
  const oracleState = mirrorOf(clientState)
  const order = clientState.enemyShips.flatMap((ship) => ship.cells)
  const shipsByCell = new Map()
  for (const ship of clientState.enemyShips) for (const cell of ship.cells) shipsByCell.set(cell, ship.key)
  const results = []
  for (const cell of order) {
    clientState.turn = 'player'
    oracleState.turn = 'player'
    const clientResult = seam.fireAt(clientState, cell)
    const oracleResult = ref.fireAt(oracleState, cell)
    results.push(clientResult)
    checkEqual('scenario-sunk', { cell, result: true }, clientResult.result, oracleResult.result)
    checkEqual('scenario-sunk', { cell, shipKey: true }, clientResult.shipKey || null, oracleResult.shipKey || null)
    if (clientResult.result === 'hit' || clientResult.result === 'sunk' || clientResult.result === 'win') {
      checkEqual('scenario-sunk', { cell, namedShip: true }, clientResult.shipKey, shipsByCell.get(cell))
    }
    compareFullState('scenario-sunk-state', { cell }, clientState, oracleState)
  }
  const sunkResults = results.filter((result) => result.result === 'sunk')
  const winResults = results.filter((result) => result.result === 'win')
  check('scenario-sunk', { sunkCount: true }, sunkResults.length === 4, { sunkCount: sunkResults.length })
  check('scenario-sunk', { winCount: true }, winResults.length === 1 && results[results.length - 1].result === 'win', { winCount: winResults.length })
  check('scenario-sunk', { winner: true }, clientState.winner === 'player' && clientState.phase === 'over' && clientState.endReason === 'sunk')
  check('scenario-sunk', { lastShipKey: true }, results[results.length - 1].shipKey === clientState.enemyShips[clientState.enemyShips.length - 1].key)
  check('scenario-sunk', { shipNames: true }, results.filter((result) => result.shipKey).every((result) => ref.SHIP_BY_KEY.has(result.shipKey)))
  compareValidity('scenario-sunk-state', { final: true }, clientState)
  const frozen = JSON.stringify(clientState)
  check('scenario-sunk', { noFireAfterWin: true }, seam.fireAt(clientState, 50).ok === false && JSON.stringify(clientState) === frozen)
}

function scenarioNearlyFullBoard() {
  const base = seam.newGameState(4)
  for (let attempt = 0; attempt < 20 && base.phase === 'place'; attempt += 1) {
    if (seam.randomizePlayerFleet(base).ok) break
  }
  seam.startBattle(base)
  const target = base.playerShips[base.playerShips.length - 1].cells[0]
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const probe = clone(base)
    probe.difficulty = difficulty
    for (let cell = 0; cell < ref.CELL_COUNT; cell += 1) probe.enemyShots[cell] = ref.SHOT_MISS
    probe.enemyShots[target] = 0
    const before = ref.exportState(probe)
    const chosen = seam.aiChooseCell(probe)
    check('scenario-99', { difficulty, onlyCell: true }, chosen === target, { chosen, target })
    check('scenario-99', { difficulty, onlyRngChanged: true }, ref.diffState(before, ref.exportState(probe)) === null)
  }
  // 100 fired -> null for every difficulty
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const probe = clone(base)
    probe.difficulty = difficulty
    probe.enemyShots = new Array(ref.CELL_COUNT).fill(ref.SHOT_MISS)
    check('scenario-100', { difficulty, nullResult: true }, seam.aiChooseCell(probe) === null)
  }
}

function scenarioSurrender() {
  const clientState = seam.newGameState(5)
  for (let attempt = 0; attempt < 20 && clientState.phase === 'place'; attempt += 1) {
    if (seam.randomizePlayerFleet(clientState).ok) break
  }
  seam.startBattle(clientState)
  const result = seam.surrender(clientState)
  check('scenario-surrender', { ok: true }, result.ok === true)
  check('scenario-surrender', { phaseOver: true }, clientState.phase === 'over')
  check('scenario-surrender', { winner: true }, clientState.winner === 'enemy')
  check('scenario-surrender', { endReason: true }, clientState.endReason === 'surrender')
  compareValidity('scenario-surrender', {}, clientState)
  const oracleState = mirrorOf(clientState)
  check('scenario-surrender', { oracleValid: true }, ref.validateState(oracleState).length === 0, { problems: ref.validateState(oracleState) })
  const sanitized = seam.sanitizeState(JSON.parse(JSON.stringify(seam.serializeState(clientState))))
  check('scenario-surrender', { saveRoundTrip: true }, sanitized !== null && sanitized.winner === 'enemy' && sanitized.endReason === 'surrender', { sanitized: sanitized && { winner: sanitized.winner, endReason: sanitized.endReason } })
}

function scenarioFireRefusals() {
  const clientState = seam.newGameState(6)
  seam.placeCurrent(clientState, 0, 'h')
  ref.placeCurrent(ref.newGameState(6), 0, 'h')
  check('scenario-refusal', { placePhaseFire: true }, seam.fireAt(clientState, 0).ok === false)
  for (let attempt = 0; attempt < 20 && clientState.phase === 'place'; attempt += 1) {
    if (seam.randomizePlayerFleet(clientState).ok) break
  }
  seam.startBattle(clientState)
  clientState.turn = 'enemy'
  const frozen = JSON.stringify(clientState)
  check('scenario-refusal', { offTurn: true }, seam.fireAt(clientState, 0).ok === false && JSON.stringify(clientState) === frozen)
  clientState.turn = 'player'
  const first = seam.fireAt(clientState, 0)
  check('scenario-refusal', { firstShot: true }, first.ok === true, first)
  const afterFirst = JSON.stringify(clientState)
  check('scenario-refusal', { doubleFire: true }, seam.fireAt(clientState, 1).ok === false && JSON.stringify(clientState) === afterFirst)
  clientState.turn = 'player'
  check('scenario-refusal', { repeat: true }, seam.fireAt(clientState, 0).ok === false)
  check('scenario-refusal', { invalidCell: true }, seam.fireAt(clientState, 100).ok === false)
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
const startedAt = Date.now()
checkConstants()
checkRng()
checkGeometry()
checkIsValidPlacement()
checkRandomFleet()
for (const seedValue of [0, 1, 42, 0xffffffff]) checkNewGameState(seedValue)

let totalSteps = 0
for (const seedValue of seeds) {
  if (VERBOSE) console.log(`\n--- seed ${seedValue} ---`)
  placementDifferential(seedValue)
  battleDifferential(seedValue)
  totalSteps += 1
}

scenarioDiagonalAndToggle()
scenarioSunkNamingAndWin()
scenarioNearlyFullBoard()
scenarioSurrender()
scenarioFireRefusals()

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
console.log('\n=== diff-fuzz summary ===')
console.log(`seeds: ${seeds.length} (placement + battle differentials), games finished: ${finishedGames.length}`)
for (const game of finishedGames) console.log(`  seed ${game.seed} (${game.difficulty}): winner ${game.winner} after ${game.steps} actions`)
const byDifficulty = {}
for (const game of finishedGames) byDifficulty[game.difficulty] = (byDifficulty[game.difficulty] || 0) + 1
console.log('finished by difficulty: ' + JSON.stringify(byDifficulty))
console.log(`actions walked: ${totalSteps} games`)
console.log(`comparisons: ${checks} total, ${mismatches.length} mismatches`)
for (const [kind, count] of Object.entries(counts)) console.log(`  ${kind.padEnd(18)} ${count}`)
console.log('mismatch kinds: ' + (mismatches.length ? [...new Set(mismatches.map((mismatch) => mismatch.kind))].join(', ') : 'none'))
if (notes.size) {
  console.log('non-blocking notes:')
  for (const [kind, count] of notes) console.log(`  NOTE ${kind}: ${count}`)
}
console.log(`elapsed ${elapsed}s`)
if (mismatches.length) {
  console.error('\nDIFF-FUZZ FAILED')
  const first = mismatches[0]
  console.error('  first mismatch kind: ' + first.kind)
  console.error('  context: ' + JSON.stringify(first.context))
  console.error('  detail : ' + JSON.stringify(first.detail, null, 2).slice(0, 4000))
  process.exit(1)
}
console.log('\nDIFF-FUZZ OK')
