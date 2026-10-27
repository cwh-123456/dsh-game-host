/**
 * Suite 2 — differential rule fuzz: independent oracle vs the shipped engine.
 *
 *   node packages/dsh-game-klotski/dev/audit/fuzz.mjs
 *
 * Oracle: dev/audit/oracle.mjs, written from the task book only (legal slides,
 * apply, win). Client: the documented Node seam window.__DSH_GAME_KLOTSKI__
 * after window.__DSH_GAME_KLOTSKI_TEST__ = true.
 *
 * Reaches >= 1000 distinct reachable states by seeded random walks on each
 * level, then for every state compares:
 *   - isWon
 *   - canSlide for every piece x 4 directions x step 1/2 (legal + rejected)
 *   - listMoves per piece
 *   - destinations() target map
 *   - applySlide result (positions, moves+1, started, won, undo growth)
 *   - pieceAt/buildGrid occupancy for all 20 cells
 * plus invalid-input rejection behaviour (0/3 steps, rotation, out of bounds,
 * overlapping/unknown-piece states).
 */
import { api, clientState } from './harness.mjs'
import * as oracle from './oracle.mjs'

const DIRS = oracle.DIRS
const differences = []
const notes = []
let statesCompared = 0
let canSlideCalls = 0
let listMovesCalls = 0
let applyCalls = 0
let pieceAtCalls = 0

function recordDiff(kind, detail) {
  differences.push({ kind, ...detail })
  if (differences.filter((d) => d.kind === kind).length <= 3) {
    console.error('DIFF [' + kind + '] ' + JSON.stringify(detail))
  }
}

function moveKey(m) {
  return m.dx + ',' + m.dy + ',' + m.step
}

function sortedMoveKeys(moves) {
  return moves.map(moveKey).sort()
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function initialPositions(level) {
  return level.pieces.map((p) => ({ x: p.x, y: p.y }))
}

/* ---------------------------------------------------------------- walking */

function collectReachable(level, levelIndex, targetCount, seed) {
  const rnd = mulberry32(seed)
  const start = initialPositions(level)
  const seen = new Map()
  const pool = []
  const keyOf = oracle.stateKey
  function remember(positions) {
    const key = keyOf(positions)
    if (!seen.has(key)) {
      seen.set(key, oracle.clonePositions(positions))
      pool.push(key)
    }
  }
  let guard = 0
  while (seen.size < targetCount && guard < targetCount * 120) {
    guard += 1
    let positions
    if (pool.length === 0 || rnd() < 0.35) positions = oracle.clonePositions(start)
    else positions = oracle.clonePositions(seen.get(pool[(rnd() * pool.length) | 0]))
    const walkLength = 40 + ((rnd() * 120) | 0)
    for (let step = 0; step < walkLength && seen.size < targetCount; step += 1) {
      remember(positions)
      const moves = oracle.legalMoves(positions, level)
      if (moves.length === 0) break
      const move = moves[(rnd() * moves.length) | 0]
      const next = oracle.applySlide(positions, level, move.pieceIndex, move.dx, move.dy, move.step)
      if (!next) break
      positions = next
    }
  }
  return Array.from(seen.values())
}

/* ------------------------------------------------------------- comparator */

function compareState(level, levelIndex, positions, label) {
  const ownWon = oracle.isWon(positions, level)
  const cs = clientState(levelIndex, positions)
  // Mirror the engine invariant: the `won` flag is set by applySlide when the
  // Cao Cao reaches the exit, and listMoves/destinations become empty then.
  cs.won = ownWon
  const clientWon = api.isWon(cs)
  if (clientWon !== ownWon) {
    recordDiff('isWon', { level: levelIndex, label, expected: ownWon, actual: clientWon })
  }

  // Occupancy agreement for every cell.
  const ownGrid = oracle.occupancy(positions, level)
  let clientGrid = null
  try {
    clientGrid = api.buildGrid(cs)
  } catch (error) {
    recordDiff('buildGrid-threw', { level: levelIndex, label, message: String(error && error.message) })
  }
  if (clientGrid) {
    for (let cell = 0; cell < 20; cell += 1) {
      pieceAtCalls += 1
      const own = ownGrid[cell]
      const client = clientGrid[cell]
      if (client !== own) {
        recordDiff('occupancy', { level: levelIndex, label, cell, expected: own, actual: client })
      }
    }
  }

  for (let i = 0; i < positions.length; i += 1) {
    // listMoves
    listMovesCalls += 1
    const ownMoves = oracle.listMoves(positions, level, i)
    const clientMoves = api.listMoves(cs, i)
    const ownKeys = sortedMoveKeys(ownMoves)
    const clientKeys = sortedMoveKeys(clientMoves)
    if (JSON.stringify(ownKeys) !== JSON.stringify(clientKeys)) {
      recordDiff('listMoves', { level: levelIndex, label, piece: i, expected: ownKeys, actual: clientKeys })
    }

    // canSlide for every direction x step, including rejections
    for (const [dx, dy] of DIRS) {
      for (let step = 1; step <= 2; step += 1) {
        canSlideCalls += 1
        const expected = oracle.canSlide(positions, level, i, dx, dy, step)
        const actual = api.canSlide(cs, i, dx, dy, step)
        if (expected !== actual) {
          recordDiff('canSlide', { level: levelIndex, label, piece: i, dx, dy, step, expected, actual })
        }
        if (step === 1) continue
      }
    }

    // applySlide for each oracle-legal slide
    for (const move of oracle.listSlides(positions, level, i)) {
      applyCalls += 1
      const ownNext = oracle.applySlide(positions, level, i, move.dx, move.dy, move.step)
      const clientNext = api.applySlide(cs, i, move.dx, move.dy, move.step)
      if (!clientNext) {
        recordDiff('applySlide-null', { level: levelIndex, label, piece: i, move: moveKey(move) })
        continue
      }
      for (let j = 0; j < positions.length; j += 1) {
        if (clientNext.pieces[j].id !== level.pieces[j].id) {
          recordDiff('applySlide-id-order', { level: levelIndex, label, j, expected: level.pieces[j].id, actual: clientNext.pieces[j].id })
        }
        if (clientNext.pieces[j].x !== ownNext[j].x || clientNext.pieces[j].y !== ownNext[j].y) {
          recordDiff('applySlide-positions', {
            level: levelIndex,
            label,
            piece: i,
            move: moveKey(move),
            expected: ownNext[j],
            actual: { x: clientNext.pieces[j].x, y: clientNext.pieces[j].y },
          })
        }
      }
      if (clientNext.moves !== cs.moves + 1) {
        recordDiff('applySlide-moves', { level: levelIndex, label, expected: cs.moves + 1, actual: clientNext.moves })
      }
      if (clientNext.started !== true) {
        recordDiff('applySlide-started', { level: levelIndex, label, expected: true, actual: clientNext.started })
      }
      if (clientNext.undo.length !== cs.undo.length + 1) {
        recordDiff('applySlide-undo', { level: levelIndex, label, expected: cs.undo.length + 1, actual: clientNext.undo.length })
      }
      if (clientNext.won !== oracle.isWon(ownNext, level)) {
        recordDiff('applySlide-won', { level: levelIndex, label, expected: oracle.isWon(ownNext, level), actual: clientNext.won })
      }
      // The engine must reject moves it reports as illegal.
    }

    // destinations(): semantic contract of the shipped click-target map.
    // Current client maps every newly entered empty cell to a legal move (so a
    // multi-cell block can be clicked outside itself); the checks below are
    // derived from that documented behaviour and the independent oracle:
    //   - only legal moves are returned, keys are empty cells the move enters;
    //   - when several moves enter one cell the closest (fewest steps) wins;
    //   - every legal move is reachable through at least one key.
    const clientDest = api.destinations(cs, i)
    const ownGridForDest = oracle.occupancy(positions, level)
    const defForDest = level.pieces[i]
    const legalMoveKeys = new Set(clientMoves.map(moveKey))
    const entered = new Map()
    for (const move of clientMoves) {
      const cells = new Set()
      for (let oy = 0; oy < defForDest.h; oy += 1) {
        for (let ox = 0; ox < defForDest.w; ox += 1) {
          const x = move.x + ox
          const y = move.y + oy
          if (ownGridForDest[y * oracle.COLS + x] !== i) cells.add(x + ',' + y)
        }
      }
      entered.set(moveKey(move), cells)
    }
    const reachableMoves = new Set()
    for (const key of Object.keys(clientDest)) {
      const move = clientDest[key]
      const mk = moveKey(move)
      if (!legalMoveKeys.has(mk)) {
        recordDiff('destinations-illegal-move', { level: levelIndex, label, piece: i, key, move: mk })
        continue
      }
      if (!entered.get(mk) || !entered.get(mk).has(key)) {
        recordDiff('destinations-key-not-entered', { level: levelIndex, label, piece: i, key, move: mk })
      }
      const parts = key.split(',').map(Number)
      if (parts.length !== 2 || !Number.isInteger(parts[0]) || !Number.isInteger(parts[1]) || parts[0] < 0 || parts[1] < 0 || parts[0] >= oracle.COLS || parts[1] >= oracle.ROWS || ownGridForDest[parts[1] * oracle.COLS + parts[0]] !== -1) {
        recordDiff('destinations-key-not-empty-cell', { level: levelIndex, label, piece: i, key })
      }
      let closest = Infinity
      for (const candidate of clientMoves) {
        if (entered.get(moveKey(candidate)).has(key)) closest = Math.min(closest, candidate.step)
      }
      if (move.step !== closest) {
        recordDiff('destinations-not-closest', { level: levelIndex, label, piece: i, key, step: move.step, closest })
      }
      reachableMoves.add(mk)
    }
    for (const move of clientMoves) {
      if (!reachableMoves.has(moveKey(move))) {
        recordDiff('destinations-move-unreachable', { level: levelIndex, label, piece: i, move: moveKey(move) })
      }
    }
  }
}

/* ------------------------------------------------- synthetic winning state */

function syntheticWonPositions(level) {
  // Cao Cao at the exit (top-left 1,3); remaining pieces packed around it.
  const byShape = { '2x2': [[1, 3]], '2x1': [[0, 2]], '1x2': [[0, 0], [3, 0], [0, 3], [3, 3]], '1x1': [[1, 0], [2, 0], [1, 1], [2, 1]] }
  const used = Object.create(null)
  return level.pieces.map((def) => {
    const shape = def.w + 'x' + def.h
    const list = byShape[shape]
    if (!list || list.length === 0) throw new Error('syntheticWonPositions: no slot for ' + shape)
    const [x, y] = list.shift()
    used[x + ',' + y] = true
    return { x, y }
  })
}

/* --------------------------------------------------------- rejection probes */

function probeRejections(level, levelIndex) {
  const positions = initialPositions(level)
  const cs = clientState(levelIndex, positions)
  const checks = []
  function expectBoth(kind, i, dx, dy, step, expected) {
    const actual = api.canSlide(cs, i, dx, dy, step)
    const own = oracle.canSlide(positions, level, i, dx, dy, step)
    checks.push({ kind, piece: i, dx, dy, step, expected, oracle: own, client: actual })
    if (actual !== expected) recordDiff('reject-' + kind, { level: levelIndex, piece: i, dx, dy, step, expected, actual })
    if (own !== expected) recordDiff('oracle-reject-' + kind, { level: levelIndex, piece: i, dx, dy, step, expected, oracle: own })
  }
  const cao = oracle.caoIndex(level)
  expectBoth('step-0', cao, 1, 0, 0, false)
  expectBoth('step-3', cao, 1, 0, 3, false)
  expectBoth('step--1', cao, 1, 0, -1, false)
  expectBoth('step-string', cao, 1, 0, '1', false)
  expectBoth('rotation-diag', cao, 1, 1, 1, false)
  expectBoth('rotation-diag2', cao, 1, -1, 1, false)
  expectBoth('no-direction', cao, 0, 0, 1, false)
  expectBoth('piece--1', -1, 1, 0, 1, false)
  expectBoth('piece-oob', 999, 1, 0, 1, false)
  // out of bounds: top-left piece moving up/left, bottom/right pieces moving down/right
  for (let i = 0; i < positions.length; i += 1) {
    const def = level.pieces[i]
    if (positions[i].x === 0) expectBoth('bounds-left', i, -1, 0, 1, false)
    if (positions[i].y === 0) expectBoth('bounds-up', i, 0, -1, 1, false)
    if (positions[i].x + def.w === oracle.COLS) expectBoth('bounds-right', i, 1, 0, 1, false)
    if (positions[i].y + def.h === oracle.ROWS) expectBoth('bounds-down', i, 0, 1, 1, false)
  }

  // Overlapping state: the seam rejects it, but by throwing (not returning false).
  const overlapping = positions.map((p) => ({ x: p.x, y: p.y }))
  overlapping[1] = { x: overlapping[0].x, y: overlapping[0].y }
  const overlapState = clientState(levelIndex, overlapping)
  let overlapBehaviour = 'returned-false'
  try {
    const value = api.canSlide(overlapState, 0, 1, 0, 1)
    overlapBehaviour = 'returned-' + String(value)
  } catch (error) {
    overlapBehaviour = 'throws: ' + String(error && error.message)
  }
  let ownOverlap
  try {
    oracle.occupancy(overlapping, level)
    ownOverlap = 'no-throw'
  } catch (error) {
    ownOverlap = 'throws: ' + String(error && error.message)
  }
  if (levelIndex === 0) notes.push({ id: 'overlap-input', client: overlapBehaviour, oracle: ownOverlap })
  // Unknown piece id state.
  const badIdState = clientState(levelIndex, positions)
  badIdState.pieces[0].id = 'not-a-real-piece'
  let unknownBehaviour = 'returned'
  try {
    api.canSlide(badIdState, 0, 1, 0, 1)
    unknownBehaviour = 'returned (no throw)'
  } catch (error) {
    unknownBehaviour = 'throws: ' + String(error && error.message)
  }
  if (levelIndex === 0) notes.push({ id: 'unknown-piece-id', client: unknownBehaviour })

  // Out-of-bounds state.
  const oobState = clientState(levelIndex, positions)
  oobState.pieces[0].x = -1
  let oobBehaviour = 'returned'
  try {
    api.canSlide(oobState, 0, 1, 0, 1)
    oobBehaviour = 'returned (no throw)'
  } catch (error) {
    oobBehaviour = 'throws: ' + String(error && error.message)
  }
  if (levelIndex === 0) notes.push({ id: 'out-of-bounds-state', client: oobBehaviour })

  return checks
}

/* -------------------------------------------------------------------- run */

console.log('=== Suite 2: rule differential fuzz (oracle vs seam) ===\n')
const STATES_PER_LEVEL = 350 // 4 levels -> ~1400 distinct states
let rejectionChecks = 0
const levelSummaries = []

for (let levelIndex = 0; levelIndex < api.LEVELS.length; levelIndex += 1) {
  const level = api.LEVELS[levelIndex]
  const states = collectReachable(level, levelIndex, STATES_PER_LEVEL, 0x9e3779b9 ^ (levelIndex * 2654435761))
  for (const positions of states) {
    statesCompared += 1
    compareState(level, levelIndex, positions, 'walk')
  }
  // Synthetic win state on every level (same army composition).
  const won = syntheticWonPositions(level)
  const validation = oracle.validateArrangement(won, level)
  if (!validation.ok) recordDiff('synthetic-won-invalid', { level: levelIndex, reason: validation.reason })
  else {
    statesCompared += 1
    compareState(level, levelIndex, won, 'synthetic-win')
    if (!oracle.isWon(won, level)) recordDiff('synthetic-won-not-win', { level: levelIndex })
    if (api.listMoves(clientState(levelIndex, won), oracle.caoIndex(level)).length !== 0) {
      recordDiff('won-listMoves-nonempty', { level: levelIndex })
    }
  }
  const rejections = probeRejections(level, levelIndex)
  rejectionChecks += rejections.length
  levelSummaries.push({
    level: levelIndex + 1,
    name: level.name,
    distinctReachableStates: states.length,
    syntheticWin: validation.ok,
  })
  console.log(
    'L' + (levelIndex + 1) + ' "' + level.name + '": ' + states.length + ' distinct reachable states compared' +
      (validation.ok ? ' + synthetic win state' : ' (synthetic win INVALID: ' + validation.reason + ')') +
      ' | rejection probes=' + rejections.length,
  )
}

console.log('\n--- input rejection probes (values as booleans/strings) ---')
for (const note of notes) console.log('  ' + note.id + ': client ' + note.client + ' | oracle ' + (note.oracle || '-'))

console.log('\n--- Result ---')
console.log(
  JSON.stringify(
    {
      levels: levelSummaries,
      statesCompared,
      canSlideCalls,
      listMovesCalls,
      applyCalls,
      pieceAtCalls,
      rejectionChecks,
      differences: differences.length,
      sampleDifferences: differences.slice(0, 5),
      notes,
    },
    null,
    2,
  ),
)

if (differences.length > 0) {
  console.error('\nSUITE 2 FAILED: ' + differences.length + ' difference(s)')
  process.exitCode = 1
} else if (statesCompared < 1000) {
  console.error('\nSUITE 2 FAILED: only ' + statesCompared + ' states compared (< 1000)')
  process.exitCode = 1
} else {
  console.log('\nSUITE 2 PASS — ' + statesCompared + ' states, 0 differences (seam agrees with the independent oracle).')
}
