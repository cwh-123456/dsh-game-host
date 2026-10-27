/**
 * Pure-logic tests for @local/dsh-game-battleship (dev-only).
 *
 * Loads client.js in a fake browser global with the opt-in test seam enabled,
 * then exercises rules, AI, save/restore, layout and determinism without React
 * or a DOM.
 *
 * Run from the repo root:  node packages/dsh-game-battleship/dev/test-logic.mjs
 */

const store = new Map()
const localStorageCalls = { get: [], set: [] }
globalThis.window = {
  __DSH_GAME_BATTLESHIP_TEST__: true,
  devicePixelRatio: 2,
  localStorage: {
    getItem(key) {
      localStorageCalls.get.push(key)
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      localStorageCalls.set.push(key)
      store.set(key, String(value))
    },
    removeItem(key) {
      store.delete(key)
    },
  },
}

await import('../client.js')
const G = window.__DSH_GAME_BATTLESHIP__
if (!G) throw new Error('test seam missing (window.__DSH_GAME_BATTLESHIP__)')

const results = { pass: 0, fail: 0, failures: [] }
function test(name, fn) {
  try {
    fn()
    results.pass += 1
  } catch (error) {
    results.fail += 1
    results.failures.push(name + ': ' + (error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error)))
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(label + ': expected ' + b + ', got ' + a)
}
function ok(cond, label) {
  if (!cond) throw new Error(label)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FLEET_PLACEMENTS_SAFE = [
  { key: 'carrier', origin: 0, horizontal: true }, // row 0
  { key: 'battleship', origin: 20, horizontal: true }, // row 2
  { key: 'cruiser', origin: 40, horizontal: true }, // row 4
  { key: 'submarine', origin: 60, horizontal: true }, // row 6
  { key: 'destroyer', origin: 80, horizontal: true }, // row 8
]

function buildPlayerFleetSafe() {
  return G.SHIPS.map(function (def, index) {
    const spec = FLEET_PLACEMENTS_SAFE[index]
    return { key: def.key, cells: G.shipCells(spec.origin, def.len, spec.horizontal) }
  })
}

function battleState(seed) {
  const state = G.newGameState(seed === undefined ? 424242 : seed)
  state.playerShips = buildPlayerFleetSafe()
  state.enemyShips = buildPlayerFleetSafe()
  state.placementIndex = 5
  state.phase = 'battle'
  state.turn = 'player'
  state.playerShots = new Array(100).fill(0)
  state.enemyShots = new Array(100).fill(0)
  return state
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(G.serializeState(state)))
}

function playGame(seed, difficulty, playerStrategy, allowAdjacent) {
  const state = G.newGameState(seed)
  state.difficulty = difficulty
  state.allowAdjacent = allowAdjacent === true
  const rnd = G.mulberry32((seed ^ 0x51ed270b) >>> 0)
  const fleet = G.randomFleet(rnd, state.allowAdjacent)
  if (!fleet) throw new Error('randomFleet failed for seed ' + seed)
  state.playerShips = fleet
  state.placementIndex = 5
  const started = G.startBattle(state)
  if (!started.ok) throw new Error('startBattle failed seed ' + seed)
  let guard = 0
  const aiFired = []
  while (state.phase === 'battle' && guard < 500) {
    guard += 1
    if (state.turn === 'player') {
      let cell = -1
      for (let c = 0; c < 100; c += 1) {
        if (state.playerShots[c] === 0) {
          cell = c
          break
        }
      }
      const result = G.fireAt(state, cell)
      if (!result.ok) throw new Error('player fire failed: ' + JSON.stringify(result))
    } else {
      const before = cloneState(state)
      const unresolved = G.unresolvedHitCells(state)
      const result = G.aiFire(state)
      if (!result.ok) throw new Error('ai fire failed: ' + JSON.stringify(result))
      if (state.enemyShots[result.cell] === 0) throw new Error('AI did not record a shot')
      if (aiFired.indexOf(result.cell) >= 0) throw new Error('AI repeated a cell')
      aiFired.push(result.cell)
      if (difficulty !== 'easy' && unresolved.length > 0) {
        // The AI must hit-target when unresolved hits exist and an unknown
        // neighbour is available (hard also allows density tie-breaking).
        const neighbours = G.adjacentUnknownCells(before)
        if (neighbours.length > 0) {
          const line = G.lineContinuationCells(before)
          if (difficulty === 'normal' && line.length > 0) {
            if (line.indexOf(result.cell) < 0) throw new Error('normal did not continue the line')
          } else if (neighbours.indexOf(result.cell) < 0) {
            throw new Error('AI ignored hunt/target neighbours')
          }
        }
      }
    }
  }
  if (state.phase !== 'over') throw new Error('game did not finish (seed ' + seed + ')')
  return state
}

// ---------------------------------------------------------------------------
// Constants / registration-facing values
// ---------------------------------------------------------------------------

test('game constants', function () {
  eq(G.GAME_ID, 'battleship', 'GAME_ID')
  eq(G.STORE_KEY, 'dsh.game.battleship.v1', 'STORE_KEY')
  eq(G.SCHEMA_VERSION, 1, 'SCHEMA_VERSION')
  eq(G.BOARD, 10, 'BOARD')
  eq(G.CELLS, 100, 'CELLS')
  eq(
    G.SHIPS.map(function (s) {
      return s.key + ':' + s.len
    }),
    ['carrier:5', 'battleship:4', 'cruiser:3', 'submarine:3', 'destroyer:2'],
    'ships',
  )
  eq(G.FLEET_CELLS, 17, 'fleet cells')
  eq(G.DIFFICULTIES, ['easy', 'normal', 'hard'], 'difficulties')
})

// ---------------------------------------------------------------------------
// Geometry + placement
// ---------------------------------------------------------------------------

test('shipCells geometry', function () {
  const horizontal = G.shipCells(0, 5, true)
  eq(horizontal, [0, 1, 2, 3, 4], 'horizontal')
  const vertical = G.shipCells(0, 5, false)
  eq(vertical, [0, 10, 20, 30, 40], 'vertical')
  for (let length = 2; length <= 5; length += 1) {
    for (let origin = 0; origin < 100; origin += 1) {
      const h = G.shipCells(origin, length, true)
      const v = G.shipCells(origin, length, false)
      if (h) {
        eq(h.length, length, 'h length')
        for (let i = 1; i < h.length; i += 1) eq(h[i], h[0] + i, 'h contiguous')
      }
      if (v) {
        eq(v.length, length, 'v length')
        for (let i = 1; i < v.length; i += 1) eq(v[i], v[0] + 10 * i, 'v contiguous')
      }
    }
  }
  eq(G.shipCells(96, 5, true), null, 'right edge overflow')
  eq(G.shipCells(60, 5, false), null, 'bottom edge overflow')
  eq(G.shipCells(-1, 2, true), null, 'negative origin')
  eq(G.shipCells(100, 2, true), null, 'origin >= 100')
  eq(G.shipCells(0, 0, true), null, 'zero length')
  eq(G.shipCells(0, 11, true), null, 'too long')
  eq(G.shipCells(1.5, 2, true), null, 'fractional origin')
})

test('normalizeShipCells canonicalisation', function () {
  eq(G.normalizeShipCells([4, 2, 0, 3, 1], 5), [0, 1, 2, 3, 4], 'unsorted horizontal')
  eq(G.normalizeShipCells([20, 10, 0], 3), [0, 10, 20], 'unsorted vertical')
  eq(G.normalizeShipCells([0, 1, 2, 3], 3), null, 'wrong length')
  eq(G.normalizeShipCells([0, 1, 3], 3), null, 'gap')
  eq(G.normalizeShipCells([0, 1, 10], 3), null, 'L shape')
  eq(G.normalizeShipCells([0, 0, 1], 3), null, 'duplicate')
  eq(G.normalizeShipCells([98, 99, 100], 3), null, 'out of bounds')
  eq(G.normalizeShipCells([0, 1.5, 2], 3), null, 'non integer')
  eq(G.normalizeShipCells('nope', 3), null, 'not an array')
})

test('placement validity: bounds / overlap / adjacency', function () {
  const carrier = { key: 'carrier', cells: [0, 1, 2, 3, 4] }
  eq(G.isValidPlacement([], [0, 1, 2], false).ok, true, 'empty board')
  let result = G.isValidPlacement([carrier], [0, 1, 2], false)
  eq(result.ok, false, 'overlap rejected')
  eq(result.reason, 'overlap', 'overlap reason')
  result = G.isValidPlacement([carrier], [10, 11, 12], false)
  eq(result.ok, false, 'orthogonal adjacency rejected')
  eq(result.reason, 'adjacent', 'adjacent reason')
  result = G.isValidPlacement([carrier], [10, 11, 12], true)
  eq(result.ok, true, 'adjacency allowed when setting on')
  result = G.isValidPlacement([carrier], [11, 12, 13], false)
  eq(result.ok, false, 'diagonal adjacency rejected')
  result = G.isValidPlacement([carrier], [20, 21, 22], false)
  eq(result.ok, true, 'distance 2 rows allowed')
  result = G.isValidPlacement([carrier], [90, 91, 92, 93, 94, 95, 96, 97, 98, 100], false)
  eq(result.reason, 'out', 'out of bounds cells')
})

test('placement flow, undo, rotate, adjacency toggle', function () {
  const state = G.newGameState(1)
  eq(state.phase, 'place', 'starts in place phase')
  eq(state.placementIndex, 0, 'index 0')
  eq(state.orientation, 'h', 'default horizontal')
  eq(state.allowAdjacent, false, 'default no adjacency')
  eq(state.difficulty, 'normal', 'default difficulty')

  let result = G.placeCurrent(state, 96, 'h') // carrier cannot fit
  eq(result.ok, false, 'out placement rejected')
  eq(result.reason, 'out', 'out reason')

  for (let i = 0; i < G.SHIPS.length; i += 1) {
    const spec = FLEET_PLACEMENTS_SAFE[i]
    result = G.placeCurrent(state, spec.origin, spec.horizontal ? 'h' : 'v')
    eq(result.ok, true, 'place ship ' + i)
    eq(state.placementIndex, i + 1, 'placement index ' + i)
  }
  eq(state.playerShips.length, 5, 'five ships')
  eq(G.fleetCompleteOk(state.playerShips, false), true, 'complete fleet legal')
  eq(G.canPlaceCurrent(state, 90, 'h').reason, 'phase', 'no more placement')

  result = G.removeLastShip(state)
  eq(result.ok, true, 'undo')
  eq(state.playerShips.length, 4, 'four after undo')
  eq(state.placementIndex, 4, 'index after undo')
  eq(G.canPlaceCurrent(state, 90, 'h').ok, true, 'can place again')

  eq(G.rotateOrientation(state).orientation, 'v', 'rotate to vertical')
  eq(G.rotateOrientation(state).orientation, 'h', 'rotate back to horizontal')

  // A fleet that is only legal when adjacency is allowed.
  const adjacentState = G.newGameState(2)
  G.toggleAdjacent(adjacentState)
  eq(adjacentState.allowAdjacent, true, 'adjacency enabled')
  eq(G.placeCurrent(adjacentState, 0, 'h').ok, true, 'carrier')
  eq(G.placeCurrent(adjacentState, 10, 'h').ok, true, 'touching ship allowed')
  const off = G.toggleAdjacent(adjacentState)
  eq(off.ok, false, 'cannot disable adjacency with touching ships')
  eq(off.reason, 'adjacent', 'adjacency-off reason')

  const cleanState = G.newGameState(3)
  G.placeCurrent(cleanState, 0, 'h')
  G.placeCurrent(cleanState, 20, 'h')
  eq(G.toggleAdjacent(cleanState).ok, true, 'enable adjacency')
  eq(G.toggleAdjacent(cleanState).ok, true, 'disable adjacency again when legal')
  eq(cleanState.allowAdjacent, false, 'back to no adjacency')
})

test('random fleet legality and determinism', function () {
  for (let seed = 1; seed <= 300; seed += 1) {
    for (let pass = 0; pass < 2; pass += 1) {
      const allowAdjacent = pass === 1
      const rnd = G.mulberry32(seed * 2654435761)
      const fleet = G.randomFleet(rnd, allowAdjacent)
      eq(!!fleet, true, 'fleet generated seed ' + seed)
      eq(fleet.length, 5, 'five ships seed ' + seed)
      for (let i = 0; i < 5; i += 1) {
        eq(fleet[i].key, G.SHIPS[i].key, 'ship order')
        eq(fleet[i].cells.length, G.SHIPS[i].len, 'ship length')
      }
      eq(G.fleetCompleteOk(fleet, allowAdjacent), true, 'fleet legal seed ' + seed + ' adjacent=' + allowAdjacent)
    }
    const a = G.randomFleet(G.mulberry32(seed), false)
    const b = G.randomFleet(G.mulberry32(seed), false)
    eq(a, b, 'deterministic seed ' + seed)
  }
})

test('randomize + start battle', function () {
  for (let seed = 1; seed <= 40; seed += 1) {
    const state = G.newGameState(seed)
    const randomize = G.randomizePlayerFleet(state)
    eq(randomize.ok, true, 'randomize ok')
    eq(state.playerShips.length, 5, 'randomized five')
    eq(state.placementIndex, 5, 'randomized index')
    const start = G.startBattle(state)
    eq(start.ok, true, 'start ok seed ' + seed)
    eq(state.phase, 'battle', 'phase battle')
    eq(state.turn, 'player', 'player first')
    eq(state.winner, null, 'no winner')
    eq(state.playerShots.every((v) => v === 0), true, 'player shots empty')
    eq(state.enemyShots.every((v) => v === 0), true, 'enemy shots empty')
    eq(state.enemyShips.length, 5, 'enemy fleet generated')
    eq(G.fleetCompleteOk(state.enemyShips, state.allowAdjacent), true, 'enemy fleet legal')
    // Fresh battle can be saved and restored.
    const restored = G.sanitizeState(JSON.parse(JSON.stringify(G.serializeState(state))))
    ok(restored, 'fresh battle restore')
  }
  const incomplete = G.newGameState(9)
  G.placeCurrent(incomplete, 0, 'h')
  eq(G.startBattle(incomplete).ok, false, 'cannot start incomplete')
  eq(G.startBattle(incomplete).reason, 'fleet', 'incomplete reason')
})

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

test('fire resolution, sunk names, win condition', function () {
  const state = battleState()
  // Enemy carrier occupies 0..4.
  for (let i = 0; i < 4; i += 1) {
    const result = G.fireAt(state, i)
    eq(result.ok, true, 'fire ' + i)
    eq(result.result, 'hit', 'hit ' + i)
    eq(result.shipKey, 'carrier', 'carrier name on hit')
    state.turn = 'player'
  }
  let result = G.fireAt(state, 4)
  eq(result.result, 'sunk', 'fourth hit after 4 cells sinks carrier')
  eq(result.shipKey, 'carrier', 'sunk carrier key')
  eq(G.sunkKeys(state, 'enemy'), ['carrier'], 'sunk list')
  eq(state.phase, 'battle', 'not over yet')

  // Sink battleship (20..23), cruiser (40..42), submarine (60..62), destroyer (80..81).
  const remaining = [[20, 21, 22, 23, 'battleship'], [40, 41, 42, 'cruiser'], [60, 61, 62, 'submarine'], [80, 81, 'destroyer']]
  for (let i = 0; i < remaining.length; i += 1) {
    const entry = remaining[i]
    const name = entry[entry.length - 1]
    for (let j = 0; j < entry.length - 1; j += 1) {
      state.turn = 'player'
      result = G.fireAt(state, entry[j])
      const last = j === entry.length - 2
      const expected = last ? (name === 'destroyer' ? 'win' : 'sunk') : 'hit'
      eq(result.result, expected, 'ship ' + name + ' cell ' + entry[j])
      if (last) eq(result.shipKey, name, 'sunk name ' + name)
    }
  }
  eq(state.phase, 'over', 'game over after five sinks')
  eq(state.winner, 'player', 'player wins')
  eq(state.endReason, 'sunk', 'end reason sunk')
  eq(G.allSunk(state, 'enemy'), true, 'enemy fleet sunk')
  eq(G.allSunk(state, 'player'), false, 'player fleet intact')
  eq(G.countShotCells(state.playerShots), 17, '17 hits fired')
  eq(G.countHitCells(state.playerShots), 17, 'all were hits')

  // A real game would have 16 AI misses before the final player shot.
  for (let i = 0; i < 10; i += 1) state.enemyShots[10 + i] = 1
  for (let i = 0; i < 6; i += 1) state.enemyShots[30 + i] = 1
  const restored = G.sanitizeState(JSON.parse(JSON.stringify(G.serializeState(state))))
  ok(restored, 'win state restorable')
  eq(restored.winner, 'player', 'winner kept')
})

test('miss + invalid shots + turn handling', function () {
  const state = battleState()
  const miss = G.fireAt(state, 99)
  eq(miss.result, 'miss', 'miss on water')
  eq(state.playerShots[99], 1, 'miss recorded')
  eq(state.turn, 'enemy', 'turn passes to AI')
  eq(G.fireAt(state, 10).ok, false, 'player cannot fire twice')
  eq(G.fireAt(state, 10).reason, 'turn', 'turn reason')

  state.turn = 'player'
  eq(G.fireAt(state, 99).ok, false, 'same cell rejected')
  eq(G.fireAt(state, 99).reason, 'fired', 'fired reason')
  eq(G.fireAt(state, -1).reason, 'range', 'range reason')
  eq(G.fireAt(state, 100).reason, 'range', 'range reason')
  eq(G.fireAt(state, 1.5).reason, 'range', 'integer reason')

  const place = G.newGameState(1)
  eq(G.fireAt(place, 0).reason, 'phase', 'cannot fire in placement')
  eq(G.surrender(place).ok, false, 'cannot surrender in placement')
})

test('AI turn resolution and AI win', function () {
  const state = battleState(77)
  state.turn = 'enemy'
  const result = G.aiFire(state)
  eq(result.ok, true, 'AI fires')
  eq(state.turn, 'player', 'turn back to player')
  eq(state.enemyShots.filter((v) => v !== 0).length, 1, 'one AI shot recorded')

  // Craft a nearly-lost player fleet: every ship sunk except destroyer 80/81.
  const losing = battleState(88)
  losing.turn = 'enemy'
  for (let cell = 0; cell < 100; cell += 1) losing.enemyShots[cell] = 1
  const playerShips = losing.playerShips
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < playerShips[i].cells.length; j += 1) losing.enemyShots[playerShips[i].cells[j]] = 2
  }
  losing.enemyShots[80] = 2
  losing.enemyShots[81] = 0
  let guard = 0
  while (losing.phase === 'battle' && guard < 30) {
    guard += 1
    const shot = G.aiFire(losing)
    eq(shot.ok, true, 'AI shot in endgame')
  }
  eq(losing.phase, 'over', 'AI finishes the game')
  eq(losing.winner, 'enemy', 'AI wins')
  eq(losing.endReason, 'sunk', 'AI win reason')
  eq(G.allSunk(losing, 'player'), true, 'player fleet sunk')
})

test('surrender + restart', function () {
  const state = battleState(5)
  const surrendered = G.surrender(state)
  eq(surrendered.ok, true, 'surrender ok')
  eq(state.phase, 'over', 'surrender ends game')
  eq(state.winner, 'enemy', 'enemy wins by surrender')
  eq(state.endReason, 'surrender', 'surrender reason')
  eq(G.allSunk(state, 'player'), false, 'surrender does not fake sinks')
  const restored = G.sanitizeState(JSON.parse(JSON.stringify(G.serializeState(state))))
  ok(restored, 'surrender state restorable')
  eq(restored.endReason, 'surrender', 'surrender reason kept')

  const restart = G.restartBattle(state)
  eq(restart.ok, true, 'restart ok')
  eq(state.phase, 'battle', 'restart phase')
  eq(state.turn, 'player', 'restart player first')
  eq(state.winner, null, 'restart no winner')
  eq(state.endReason, null, 'restart no end reason')
  eq(G.countShotCells(state.playerShots), 0, 'restart cleared player shots')
  eq(G.countShotCells(state.enemyShots), 0, 'restart cleared enemy shots')
  eq(state.playerShips.length, 5, 'restart keeps fleets')
  eq(state.enemyShips.length, 5, 'restart keeps enemy fleet')

  // AI turn surrender is refused.
  state.turn = 'enemy'
  eq(G.surrender(state).ok, false, 'cannot surrender while AI thinking')
})

// ---------------------------------------------------------------------------
// AI strategy properties
// ---------------------------------------------------------------------------

test('aiChooseCell only picks unfired cells and never deadlocks', function () {
  for (let seed = 1; seed <= 120; seed += 1) {
    for (const difficulty of ['easy', 'normal', 'hard']) {
      const state = playGame(seed, difficulty, null, seed % 2 === 0)
      eq(state.phase, 'over', 'finished seed ' + seed + ' ' + difficulty)
      ok(state.winner === 'player' || state.winner === 'enemy', 'winner')
      eq(G.countShotCells(state.enemyShots), new Set(state.enemyShots.map((v, i) => (v ? i : -1)).filter((v) => v >= 0)).size, 'AI shots unique')
    }
  }
  const place = G.newGameState(3)
  eq(G.aiChooseCell(place), null, 'no AI move during placement')
})

test('normal AI hunts around a hit and returns after sinking', function () {
  const state = battleState(123)
  state.difficulty = 'normal'
  state.turn = 'enemy'
  state.enemyShots[22] = 2 // hit in the middle of battleship row 2
  const neighbours = new Set([12, 32, 21, 23])
  for (let i = 0; i < 100; i += 1) {
    const cell = G.aiChooseCell(state)
    ok(neighbours.has(cell), 'normal targeted neighbour, got ' + cell)
  }
  state.enemyShots[21] = 2
  for (let i = 0; i < 100; i += 1) {
    const cell = G.aiChooseCell(state)
    ok(cell === 20 || cell === 23, 'normal continues the line, got ' + cell)
  }
  // Sink the battleship; the AI must fall back to hunting elsewhere.
  state.enemyShots[20] = 2
  state.enemyShots[23] = 2
  for (let i = 0; i < 100; i += 1) {
    const cell = G.aiChooseCell(state)
    ok(cell !== 21 && cell !== 22 && state.enemyShots[cell] === 0, 'normal back to hunting')
  }
})

test('hard AI probability density points at the only legal placement', function () {
  const state = battleState(321)
  state.difficulty = 'hard'
  state.turn = 'enemy'
  for (let cell = 0; cell < 100; cell += 1) state.enemyShots[cell] = 1
  // Mark the first four ships as fully sunk; destroyer (80/81) stays unknown.
  const sunkShips = state.playerShips.slice(0, 4)
  for (let i = 0; i < sunkShips.length; i += 1) {
    for (let j = 0; j < sunkShips[i].cells.length; j += 1) state.enemyShots[sunkShips[i].cells[j]] = 2
  }
  state.enemyShots[80] = 0
  state.enemyShots[81] = 0
  const scores = G.densityMap(state)
  eq(scores[80], 1, 'density at 80')
  eq(scores[81], 1, 'density at 81')
  for (let cell = 0; cell < 100; cell += 1) {
    if (cell === 80 || cell === 81) continue
    eq(scores[cell], 0, 'density 0 at ' + cell)
  }
  for (let i = 0; i < 100; i += 1) {
    const cell = G.aiChooseCell(state)
    ok(cell === 80 || cell === 81, 'hard picks a high-density cell, got ' + cell)
  }
})

test('easy AI is uniform over unknown cells', function () {
  const state = battleState(654)
  state.difficulty = 'easy'
  state.turn = 'enemy'
  const counts = new Array(100).fill(0)
  for (let i = 0; i < 4000; i += 1) {
    const cell = G.aiChooseCell(state)
    eq(Number.isInteger(cell), true, 'integer cell')
    ok(state.enemyShots[cell] === 0, 'unknown cell')
    counts[cell] += 1
  }
  // A uniform sampler should visit a healthy fraction of the board, not one row.
  const visited = counts.filter((c) => c > 0).length
  ok(visited > 60, 'easy AI visits most cells, visited=' + visited)
})

test('AI never repeats in adversarial nearly-full boards', function () {
  const state = battleState(999)
  state.difficulty = 'hard'
  state.turn = 'enemy'
  const seen = new Set()
  for (let i = 0; i < 90; i += 1) {
    const cell = G.aiChooseCell(state)
    ok(cell !== null, 'not stuck')
    eq(Number.isInteger(cell), true, 'integer cell')
    ok(state.enemyShots[cell] === 0, 'unknown cell')
    ok(!seen.has(cell), 'never repeats')
    seen.add(cell)
    state.enemyShots[cell] = 1
  }
  eq(seen.size, 90, '90 distinct AI choices')
})

// ---------------------------------------------------------------------------
// Save / restore
// ---------------------------------------------------------------------------

test('save round-trip for every phase', function () {
  const states = []
  const fresh = G.newGameState(11)
  states.push(['fresh place', fresh])

  const placing = G.newGameState(12)
  G.placeCurrent(placing, 0, 'h')
  G.placeCurrent(placing, 20, 'v')
  states.push(['partial place', placing])

  const randomized = G.newGameState(13)
  G.randomizePlayerFleet(randomized)
  states.push(['randomized place', randomized])

  const battle = battleState(14)
  states.push(['fresh battle', battle])

  const midPlayer = battleState(15)
  midPlayer.turn = 'player'
  midPlayer.playerShots[55] = 1
  midPlayer.enemyShots[44] = 1
  midPlayer.playerShots[1] = 2
  midPlayer.enemyShots[22] = 2
  states.push(['mid battle player turn', midPlayer])

  const midEnemy = cloneState(midPlayer)
  midEnemy.turn = 'enemy'
  midEnemy.playerShots[57] = 1 // player fired once more than the AI
  states.push(['mid battle enemy turn', midEnemy])

  const won = battleState(16)
  won.phase = 'over'
  won.winner = 'player'
  won.endReason = 'sunk'
  // Sink all enemy ships.
  for (let i = 0; i < won.enemyShips.length; i += 1) {
    for (let j = 0; j < won.enemyShips[i].cells.length; j += 1) won.playerShots[won.enemyShips[i].cells[j]] = 2
  }
  // Both sides fired: player 17 hits, AI 16 water misses (player moved last).
  for (let i = 0; i < 10; i += 1) won.enemyShots[10 + i] = 1
  for (let i = 0; i < 6; i += 1) won.enemyShots[30 + i] = 1
  states.push(['won', won])

  const lost = cloneState(won)
  lost.winner = 'enemy'
  lost.endReason = 'sunk'
  // Make player fleet fully sunk instead.
  lost.enemyShots = new Array(100).fill(0)
  for (let i = 0; i < lost.playerShips.length; i += 1) {
    for (let j = 0; j < lost.playerShips[i].cells.length; j += 1) lost.enemyShots[lost.playerShips[i].cells[j]] = 2
  }
  // Restore enemy fleet not fully sunk: 17 water misses by the player.
  lost.playerShots = new Array(100).fill(0)
  for (let i = 0; i < 10; i += 1) lost.playerShots[10 + i] = 1
  for (let i = 0; i < 7; i += 1) lost.playerShots[30 + i] = 1
  states.push(['lost', lost])

  const surrendered = battleState(17)
  surrendered.turn = 'player'
  G.surrender(surrendered)
  states.push(['surrendered', surrendered])

  for (let i = 0; i < states.length; i += 1) {
    const label = states[i][0]
    const serialized = JSON.parse(JSON.stringify(G.serializeState(states[i][1])))
    const restored = G.sanitizeState(serialized)
    ok(restored, 'sanitize accepts ' + label)
    eq(JSON.parse(JSON.stringify(G.serializeState(restored))), serialized, 'fixed point ' + label)
  }
})

test('sanitizeState rejects inconsistent saves', function () {
  const base = cloneState(battleState(21))
  base.playerShots[55] = 1
  base.enemyShots[44] = 1
  base.playerShots[1] = 2
  base.enemyShots[22] = 2
  base.turn = 'player'

  function reject(label, mutate) {
    const copy = JSON.parse(JSON.stringify(base))
    mutate(copy)
    const restored = G.sanitizeState(copy)
    ok(restored === null, 'must reject: ' + label)
  }

  reject('schema version', (s) => { s.schemaVersion = 2 })
  reject('phase', (s) => { s.phase = 'nope' })
  reject('allowAdjacent type', (s) => { s.allowAdjacent = 'yes' })
  reject('difficulty', (s) => { s.difficulty = 'insane' })
  reject('seed negative', (s) => { s.seed = -1 })
  reject('seed float', (s) => { s.seed = 1.5 })
  reject('rng missing', (s) => { delete s.rng })
  reject('orientation', (s) => { s.orientation = 'd' })
  reject('player ship key', (s) => { s.playerShips[0].key = 'destroyer' })
  reject('player ships missing', (s) => { s.playerShips = s.playerShips.slice(0, 4) })
  reject('player ship length', (s) => { s.playerShips[0].cells = s.playerShips[0].cells.slice(0, 4) })
  reject('player ship duplicate cell', (s) => { s.playerShips[1].cells[1] = s.playerShips[1].cells[0] })
  reject('player ship gap', (s) => { s.playerShips[0].cells = [0, 1, 2, 3, 5] })
  reject('player ship overlap', (s) => { s.playerShips[1].cells = s.playerShips[0].cells.slice() })
  reject('enemy ships missing', (s) => { s.enemyShips = [] })
  reject('enemy ship adjacency', (s) => {
    s.allowAdjacent = false
    // Move enemy destroyer directly below carrier.
    s.enemyShips[4].cells = [10, 11]
  })
  reject('player shots length', (s) => { s.playerShots = s.playerShots.slice(0, 99) })
  reject('player shot value', (s) => { s.playerShots[55] = 3 })
  reject('hit on water', (s) => { s.playerShots[54] = 2 })
  reject('miss on ship', (s) => { s.playerShots[20] = 1 })
  reject('enemy hit on water', (s) => { s.enemyShots[45] = 2 })
  reject('enemy miss on ship', (s) => { s.enemyShots[0] = 1 })
  reject('turn value', (s) => { s.turn = 'nobody' })
  reject('winner in battle', (s) => { s.winner = 'player' })
  reject('winner value', (s) => { s.winner = 'draw' })
  reject('placement index', (s) => { s.placementIndex = 4 })
  reject('shot parity', (s) => { s.playerShots[56] = 1 })
  reject('turn vs parity', (s) => { s.turn = 'enemy' })
  reject('over without win', (s) => {
    s.phase = 'over'
    s.winner = 'player'
    s.endReason = 'sunk'
  })
  reject('over winner player not all sunk', (s) => {
    s.phase = 'over'
    s.winner = 'player'
    s.endReason = 'sunk'
    s.playerShots[56] = 1
  })
  reject('place phase with shots', (s) => {
    s.phase = 'place'
    s.playerShips = s.playerShips.slice(0, 2)
    s.placementIndex = 2
    s.enemyShips = []
    s.turn = 'player'
    s.playerShots = new Array(100).fill(0)
    s.enemyShots = new Array(100).fill(0)
    s.playerShots[0] = 1
  })
  reject('place phase with enemy fleet', (s) => {
    s.phase = 'place'
    s.playerShips = s.playerShips.slice(0, 2)
    s.placementIndex = 2
    s.turn = 'player'
    s.playerShots = new Array(100).fill(0)
    s.enemyShots = new Array(100).fill(0)
  })
  reject('battle missing shots', (s) => { delete s.playerShots })
})

test('sanitizeState never throws on 4000 corrupted saves', function () {
  const base = cloneState(battleState(31))
  base.playerShots[55] = 1
  base.enemyShots[44] = 1
  base.playerShots[1] = 2
  base.enemyShots[22] = 2
  base.turn = 'player'
  const rnd = G.mulberry32(0xc0ffee)
  const keys = Object.keys(base)
  let accepted = 0
  let rejected = 0
  for (let iteration = 0; iteration < 4000; iteration += 1) {
    const copy = JSON.parse(JSON.stringify(base))
    const mutations = 1 + Math.floor(rnd() * 3)
    for (let m = 0; m < mutations; m += 1) {
      const kind = Math.floor(rnd() * 6)
      const key = keys[Math.floor(rnd() * keys.length)]
      if (kind === 0) delete copy[key]
      else if (kind === 1) copy[key] = null
      else if (kind === 2) copy[key] = 'x'
      else if (kind === 3) copy[key] = Math.floor(rnd() * 1000) - 500
      else if (kind === 4 && Array.isArray(copy[key])) {
        const list = copy[key]
        if (list.length > 0) list[Math.floor(rnd() * list.length)] = Math.floor(rnd() * 5)
      } else if (kind === 5 && copy[key] && typeof copy[key] === 'object') {
        const nested = copy[key]
        if (Array.isArray(nested) && nested.length > 0) {
          const index = Math.floor(rnd() * nested.length)
          if (nested[index] && typeof nested[index] === 'object') {
            nested[index].key = ['carrier', 'battleship', 'cruiser', 'destroyer', 'x'][Math.floor(rnd() * 5)]
            if (Array.isArray(nested[index].cells)) nested[index].cells.reverse()
          }
        }
      }
    }
    let restored = null
    try {
      restored = G.sanitizeState(copy)
    } catch (error) {
      throw new Error('sanitizeState threw: ' + (error && error.message))
    }
    if (restored) {
      accepted += 1
      // Accepted saves must be internally consistent and idempotent.
      const serialized = G.serializeState(restored)
      const again = G.sanitizeState(JSON.parse(JSON.stringify(serialized)))
      ok(again, 'accepted save re-sanitizes')
      eq(JSON.parse(JSON.stringify(G.serializeState(again))), JSON.parse(JSON.stringify(serialized)), 'accepted save fixed point')
      ok(restored.playerShots.length === 100 && restored.enemyShots.length === 100, 'shots length')
      eq(G.sanitizeState(JSON.parse(JSON.stringify(G.serializeState(restored)))) !== null, true, 'accepted stable')
    } else {
      rejected += 1
    }
  }
  ok(accepted + rejected === 4000, 'all fuzz cases processed')
  ok(accepted > 0, 'some mutated saves are still legal and accepted')
  ok(rejected > 2500, 'most mutations rejected (accepted=' + accepted + ', rejected=' + rejected + ')')
})

test('localStorage load/save behaviour', function () {
  store.clear()
  localStorageCalls.set.length = 0
  localStorageCalls.get.length = 0
  const state = battleState(41)
  state.playerShots[55] = 1
  state.enemyShots[44] = 1
  state.turn = 'player'
  eq(G.saveStateToStorage(state), true, 'save returns true')
  eq(localStorageCalls.set, ['dsh.game.battleship.v1'], 'only our key written')
  const loaded = G.loadSavedState()
  ok(loaded, 'load returns state')
  eq(loaded.seed, state.seed, 'seed restored')
  eq(loaded.playerShots[55], 1, 'shots restored')

  store.set('dsh.game.battleship.v1', '{not json')
  eq(G.loadSavedState(), null, 'invalid JSON ignored')
  store.set('dsh.game.battleship.v1', JSON.stringify({ schemaVersion: 2, phase: 'place' }))
  eq(G.loadSavedState(), null, 'wrong version ignored')
  store.delete('dsh.game.battleship.v1')
  // Foreign keys must be ignored.
  store.set('dsh.game.2048.v1', JSON.stringify({ schemaVersion: 1, board: [] }))
  eq(G.loadSavedState(), null, 'foreign key ignored')
  eq(localStorageCalls.get.every((key) => key === 'dsh.game.battleship.v1'), true, 'only our key read')

  // localStorage that throws must not break the game.
  const throwing = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
    removeItem() {},
  }
  const original = window.localStorage
  window.localStorage = throwing
  try {
    eq(G.loadSavedState(), null, 'throwing getItem returns null')
    eq(G.saveStateToStorage(state), false, 'throwing setItem returns false')
  } finally {
    window.localStorage = original
  }
})

test('surrender save parity invariants', function () {
  const state = battleState(51)
  state.playerShots[1] = 2
  state.enemyShots[22] = 2
  state.turn = 'player'
  G.surrender(state)
  const copy = cloneState(state)
  ok(G.sanitizeState(copy), 'valid surrender')
  copy.playerShots[57] = 1 // breaks parity
  eq(G.sanitizeState(copy), null, 'surrender parity enforced')
  const forced = cloneState(state)
  forced.endReason = 'adjacent'
  eq(G.sanitizeState(forced), null, 'bad end reason rejected')
})

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

test('computeLayout invariants across sizes', function () {
  const sizes = [
    [0, 0],
    [319, 239],
    [300, 220],
    [320, 240],
    [344, 420],
    [360, 520],
    [420, 700],
    [560, 500],
    [640, 520],
    [680, 400],
    [720, 600],
    [800, 800],
    [1100, 700],
    [1600, 1000],
    [1600, 400],
  ]
  for (let i = 0; i < sizes.length; i += 1) {
    const width = sizes[i][0]
    const height = sizes[i][1]
    const layout = G.computeLayout(width, height)
    if (width < 320 || height < 240) {
      eq(layout.tooSmall, true, 'too small ' + width + 'x' + height)
      continue
    }
    if (layout.tooSmall) continue
    ok(layout.boardPx >= 90, 'board >= 90 ' + width + 'x' + height)
    eq(layout.cellPx, layout.boardPx / 10, 'cell size')
    const panelW = layout.boardPx + 16
    if (layout.sideBySide) {
      ok(panelW * 2 + 14 <= width - 16 + 2, 'fits width side by side ' + width + 'x' + height)
      ok(layout.boardPx + 22 + layout.shipListH + 16 <= height - 16, 'fits height side by side ' + width + 'x' + height)
    } else {
      ok(panelW <= width - 16 + 2, 'fits width stacked ' + width + 'x' + height)
      ok(2 * (22 + layout.boardPx + layout.shipListH + 16) + 14 <= height - 16 + 4, 'fits height stacked ' + width + 'x' + height)
    }
  }
  const desktop = G.computeLayout(984, 520)
  eq(desktop.sideBySide, true, 'wide is side by side')
  ok(desktop.boardPx >= 300, 'desktop board large: ' + desktop.boardPx)
  const narrow = G.computeLayout(344, 420)
  eq(narrow.sideBySide, false, 'narrow stacks')
  ok(!narrow.tooSmall && narrow.boardPx >= 90, 'narrow playable: ' + JSON.stringify(narrow))
  const tiny = G.computeLayout(200, 150)
  eq(tiny.tooSmall, true, 'tiny too small')
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('same seed and actions produce identical games', function () {
  function play() {
    const state = G.newGameState(2026)
    eq(G.randomizePlayerFleet(state).ok, true, 'randomize')
    eq(G.startBattle(state).ok, true, 'start')
    for (let i = 0; i < 12; i += 1) {
      if (state.phase !== 'battle') break
      if (state.turn === 'player') {
        let cell = -1
        for (let c = 0; c < 100; c += 1) {
          if (state.playerShots[c] === 0) {
            cell = c
            break
          }
        }
        G.fireAt(state, cell)
      } else {
        G.aiFire(state)
      }
    }
    return cloneState(state)
  }
  eq(play(), play(), 'deterministic')
  const a = G.newGameState(1)
  const b = G.newGameState(1)
  eq(G.serializeState(a), G.serializeState(b), 'new game deterministic')
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const total = results.pass + results.fail
console.log('')
console.log('battleship test-logic: ' + results.pass + '/' + total + ' passed, ' + results.fail + ' failed')
if (results.failures.length > 0) {
  console.log('')
  for (let i = 0; i < results.failures.length; i += 1) console.log('FAIL  ' + results.failures[i])
  process.exitCode = 1
}
