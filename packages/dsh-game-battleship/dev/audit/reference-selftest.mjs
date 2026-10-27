/**
 * reference-selftest.mjs — proves the independent Battleship oracle is correct.
 *
 * Run: node packages/dsh-game-battleship/dev/audit/reference-selftest.mjs
 * Read-only. Exit 0 = all oracle self-checks pass.
 *
 * Why: diff-fuzz only means something if the oracle itself is trustworthy, so
 * geometry, adjacency (especially diagonals), fleet validation, shot resolution,
 * turn flow, AI invariants and the state validator are all asserted here against
 * hand-built expectations — not against client.js.
 */
import assert from 'node:assert/strict'
import * as ref from './reference-battleship.mjs'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    failures.push({ name, error })
    console.error('not ok - ' + name)
    console.error(error && error.stack ? error.stack : error)
  }
}

const H = (state, origin, len) => ref.shipCells(origin, len, true)
const V = (state, origin, len) => ref.shipCells(origin, len, false)

function makeFleet() {
  // Five non-touching ships, two rows apart.
  return [
    { key: 'carrier', cells: ref.shipCells(0, 5, true) },
    { key: 'battleship', cells: ref.shipCells(20, 4, true) },
    { key: 'cruiser', cells: ref.shipCells(40, 3, true) },
    { key: 'submarine', cells: ref.shipCells(60, 3, false) }, // x=0, y=6..8 -> 60,70,80
    { key: 'destroyer', cells: ref.shipCells(85, 2, true) }, // 85,86
  ]
}

/* ------------------------------------------------------------------ *
 * 1. RNG
 * ------------------------------------------------------------------ */
test('mulberry32: deterministic, in [0,1), nextRandom matches the closure', () => {
  for (const seed of [0, 1, 2, 12345, 0x7fffffff, 0xffffffff]) {
    const a = ref.makeRng(seed)
    const b = ref.makeRng(seed)
    const values = []
    for (let i = 0; i < 20; i += 1) {
      const value = a()
      assert.equal(value, b(), `seed ${seed} step ${i} not deterministic`)
      assert.ok(value >= 0 && value < 1, `seed ${seed} value ${value}`)
      values.push(value)
    }
    const first = ref.nextRandom(seed)
    assert.equal(first.value, values[0], `nextRandom(seed) must match makeRng(seed) first value (seed ${seed})`)
    const second = ref.nextRandom(first.rng)
    assert.equal(second.value, values[1], `nextRandom chaining (seed ${seed})`)
  }
  const distinct = new Set()
  for (let seed = 0; seed < 50; seed += 1) distinct.add(ref.makeRng(seed)())
  assert.ok(distinct.size > 40, `only ${distinct.size} distinct first values across 50 seeds`)
})

/* ------------------------------------------------------------------ *
 * 2. Geometry
 * ------------------------------------------------------------------ */
test('shipCells: every in-bounds horizontal/vertical ship has the exact cell count', () => {
  for (const len of [2, 3, 4, 5]) {
    let horizontal = 0
    let vertical = 0
    for (let origin = 0; origin < ref.CELL_COUNT; origin += 1) {
      const h = H(null, origin, len)
      if (h) {
        horizontal += 1
        assert.equal(h.length, len)
        for (let i = 0; i < len; i += 1) assert.equal(h[i], origin + i)
        let prev = null
        for (const cell of h) {
          if (prev !== null) assert.equal(ref.cellY(cell), ref.cellY(prev), 'horizontal ship changes row')
          prev = cell
        }
      }
      const v = V(null, origin, len)
      if (v) {
        vertical += 1
        assert.equal(v.length, len)
        for (let i = 0; i < len; i += 1) assert.equal(v[i], origin + i * 10)
      }
    }
    assert.equal(horizontal, (10 - len + 1) * 10, `horizontal placements for len ${len}`)
    assert.equal(vertical, (10 - len + 1) * 10, `vertical placements for len ${len}`)
  }
})

test('shipCells: out-of-bounds returns null, invalid origin/len returns null', () => {
  assert.equal(H(null, 7, 4), null, 'horizontal overflow x')
  assert.equal(V(null, 70, 4), null, 'vertical overflow y')
  assert.equal(H(null, 8, 3), null)
  assert.equal(H(null, 99, 2), null)
  assert.equal(H(null, 9, 2), null)
  for (const origin of [-1, 100, 1.5, NaN, '3', null, undefined]) assert.equal(H(null, origin, 2), null, `origin ${String(origin)}`)
  for (const len of [0, -1, 1.5, '3', null]) assert.equal(H(null, 0, len), null, `len ${String(len)}`)
  // a vertical ship at the last column is fine
  assert.deepEqual(V(null, 9, 5), [9, 19, 29, 39, 49])
  // last legal horizontal position
  assert.deepEqual(H(null, 95, 5), [95, 96, 97, 98, 99])
  assert.deepEqual(H(null, 96, 5), null)
})

test('adjacency is 8-neighbourhood (diagonals count), distance is Manhattan for orth neighbours', () => {
  assert.equal(ref.isAdjacent(ref.cellAt(5, 5), ref.cellAt(6, 6)), true, 'diagonal must count')
  assert.equal(ref.isAdjacent(ref.cellAt(5, 5), ref.cellAt(4, 4)), true)
  assert.equal(ref.isAdjacent(ref.cellAt(5, 5), ref.cellAt(4, 6)), true)
  assert.equal(ref.isAdjacent(ref.cellAt(5, 5), ref.cellAt(6, 5)), true)
  assert.equal(ref.isAdjacent(ref.cellAt(5, 5), ref.cellAt(7, 5)), false, 'one gap must not count')
  assert.equal(ref.isAdjacent(ref.cellAt(5, 5), ref.cellAt(5, 7)), false)
  assert.equal(ref.isAdjacent(ref.cellAt(5, 5), ref.cellAt(5, 5)), false)
  assert.deepEqual(ref.orthNeighbors(ref.cellAt(0, 0)), [1, 10])
  assert.deepEqual(ref.orthNeighbors(ref.cellAt(9, 9)).sort((a, b) => a - b), [89, 98])
})

/* ------------------------------------------------------------------ *
 * 3. Placement legality
 * ------------------------------------------------------------------ */
test('isValidPlacement: in-bounds/overlap/adjacency incl diagonal/allowAdjacent', () => {
  const existing = [{ key: 'carrier', cells: H(null, 0, 5) }] // row 0, x 0..4
  // far away, same row gap of at least one empty column
  assert.equal(ref.isValidPlacement(existing, H(null, 11, 4), false).ok, false, 'row 1 directly below is adjacent')
  assert.equal(ref.isValidPlacement(existing, H(null, 11, 4), true).ok, true, 'allowAdjacent relaxes')
  assert.equal(ref.isValidPlacement(existing, H(null, 21, 4), false).ok, true, 'two rows away is legal')
  assert.equal(ref.isValidPlacement(existing, H(null, 20, 4), false).ok, true)
  // diagonal touch: row 1, x=1 is diagonal to (0,0)
  assert.equal(ref.isValidPlacement(existing, H(null, 11, 2), false).ok, false, 'diagonal adjacency must reject')
  // row 1 x=2 is diagonal to the carrier cell (1,0): still adjacent
  assert.equal(ref.isValidPlacement(existing, H(null, 12, 2), false).ok, false, 'diagonal adjacency (x offset) must reject')
  assert.equal(ref.isValidPlacement(existing, H(null, 22, 2), false).ok, true, 'two rows away is legal')
  // overlap
  assert.equal(ref.isValidPlacement(existing, [4, 5], false).ok, false)
  assert.equal(ref.isValidPlacement(existing, [4, 5], false).reason, 'overlap')
  // bounds and duplicates
  assert.equal(ref.isValidPlacement(existing, [8, 9, 100], false).reason, 'out-of-bounds')
  assert.equal(ref.isValidPlacement(existing, [1, 1], false).reason, 'duplicate-cell')
  assert.equal(ref.isValidPlacement(existing, [], false).reason, 'no-cells')
  // empty fleet: any legal cells ok
  assert.equal(ref.isValidPlacement([], H(null, 0, 5), false).ok, true)
  assert.equal(ref.isValidPlacement([], [55, 56], true).ok, true)
})

/* ------------------------------------------------------------------ *
 * 4. Fleet validation
 * ------------------------------------------------------------------ */
test('validateFleet: hand-built valid fleet passes; every corruption is caught', () => {
  const fleet = makeFleet()
  assert.deepEqual(ref.validateFleet(fleet, false), [])
  assert.deepEqual(ref.validateFleet(fleet, true), [])
  const clone = () => JSON.parse(JSON.stringify(fleet))

  let bad = clone(); bad[0].cells = [0, 1, 2, 3] // wrong length
  assert.ok(ref.validateFleet(bad, false).length > 0, 'short carrier not caught')

  bad = clone(); bad[0].key = 'battleship'
  assert.ok(ref.validateFleet(bad, false).length > 0, 'wrong key order not caught')

  bad = clone(); bad[4].cells = [80, 91] // not contiguous
  assert.ok(ref.validateFleet(bad, false).length > 0, 'gap ship not caught')

  bad = clone(); bad[4].cells = [80, 90] // not straight (actually vertical-adjacent -> straight!) use L shape
  bad[4].cells = [80, 91]
  assert.ok(ref.validateFleet(bad, false).length > 0, 'L-shaped ship not caught')

  bad = clone(); bad[1].cells = [0, 1, 2, 3] // overlaps carrier
  assert.ok(ref.validateFleet(bad, false).length > 0, 'overlap not caught')

  bad = clone(); bad[1].cells = [10, 11, 12, 13] // row 1, adjacent to carrier row 0
  assert.ok(ref.validateFleet(bad, false).length > 0, 'adjacency not caught')
  assert.deepEqual(ref.validateFleet(bad, true), [], 'allowAdjacent fleet is accepted')

  bad = clone(); bad[1].cells = [11, 12, 13, 14] // diagonal adjacency with (0,0)? (1,1) vs (0,0): yes
  assert.ok(ref.validateFleet(bad, false).length > 0, 'diagonal adjacency not caught')

  bad = clone(); bad.push({ key: 'destroyer', cells: [95, 96] })
  assert.ok(ref.validateFleet(bad, false).length > 0, 'duplicate ship key not caught')

  bad = clone(); bad.pop()
  assert.ok(ref.validateFleet(bad, false).length > 0, 'missing ship not caught')
  assert.deepEqual(ref.validateFleet(bad.slice(0, 2), false, { requireAll: false }), [], 'placement prefix allowed')
})

test('fleetOccupied: duplicate cells across ships are reported', () => {
  const a = { key: 'carrier', cells: [0, 1, 2, 3, 4] }
  const b = { key: 'battleship', cells: [4, 5, 6, 7] }
  assert.deepEqual(ref.fleetOccupied([a, b]).duplicates, [4])
  assert.equal(ref.fleetOccupied([a]).duplicates.length, 0)
})

/* ------------------------------------------------------------------ *
 * 5. randomFleet
 * ------------------------------------------------------------------ */
test('randomFleet: always legal (adjacent + non-adjacent), deterministic, varied', () => {
  const seen = new Set()
  for (const allowAdjacent of [false, true]) {
    for (let seed = 0; seed < 80; seed += 1) {
      const fleet = ref.randomFleet(ref.makeRng(seed), allowAdjacent)
      assert.ok(fleet, `seed ${seed} allowAdjacent=${allowAdjacent}: randomFleet returned null`)
      assert.deepEqual(ref.validateFleet(fleet, allowAdjacent), [], `seed ${seed} allowAdjacent=${allowAdjacent}`)
      assert.deepEqual(fleet.map((ship) => ship.key), ref.SHIP_KEYS)
      seen.add(JSON.stringify(fleet))
    }
  }
  assert.ok(seen.size > 120, `only ${seen.size} distinct fleets across 160 draws`)
  assert.deepEqual(
    ref.randomFleet(ref.makeRng(424242), false),
    ref.randomFleet(ref.makeRng(424242), false),
    'same rng seed must draw the same fleet',
  )
})

/* ------------------------------------------------------------------ *
 * 6. Shot resolution
 * ------------------------------------------------------------------ */
test('resolveShot: miss/hit/sunk/win with correct ship naming', () => {
  const fleet = makeFleet()
  const shots = new Array(ref.CELL_COUNT).fill(0)
  assert.deepEqual(ref.resolveShot(fleet, shots, 99), { result: 'miss', shipKey: null })
  assert.equal(shots[99], ref.SHOT_MISS)

  assert.deepEqual(ref.resolveShot(fleet, shots, 0), { result: 'hit', shipKey: 'carrier' })
  for (const cell of [1, 2, 3]) assert.equal(ref.resolveShot(fleet, shots, cell).result, 'hit')
  assert.deepEqual(ref.resolveShot(fleet, shots, 4), { result: 'sunk', shipKey: 'carrier' })
  assert.equal(shots[4], ref.SHOT_HIT)
  assert.deepEqual(ref.sunkKeys(fleet, shots), ['carrier'])
  assert.equal(ref.allSunk(fleet, shots), false)

  // submarine is vertical at cells 60,70,80
  assert.deepEqual(ref.resolveShot(fleet, shots, 60), { result: 'hit', shipKey: 'submarine' })
  assert.deepEqual(ref.resolveShot(fleet, shots, 70), { result: 'hit', shipKey: 'submarine' })
  assert.deepEqual(ref.resolveShot(fleet, shots, 80), { result: 'sunk', shipKey: 'submarine' }, 'sinking one of several ships must not report win')
})

test('sunkKeys/allSunk: only fully-hit fleets count; win is the fifth sunk ship', () => {
  const fleet = makeFleet()
  const shots = new Array(ref.CELL_COUNT).fill(0)
  const order = fleet.flatMap((ship) => ship.cells)
  let last = null
  for (const cell of order) last = ref.resolveShot(fleet, shots, cell)
  assert.equal(last.result, 'win')
  assert.equal(last.shipKey, 'destroyer', 'win reports the ship sunk last')
  assert.deepEqual(ref.sunkKeys(fleet, shots).slice().sort(), ref.SHIP_KEYS.slice().sort())
  assert.equal(ref.allSunk(fleet, shots), true)

  // one cell missing on the last ship -> not sunk, not win
  const shots2 = new Array(ref.CELL_COUNT).fill(0)
  for (const cell of fleet.flatMap((ship) => ship.cells).slice(0, -1)) ref.resolveShot(fleet, shots2, cell)
  assert.deepEqual(ref.sunkKeys(fleet, shots2).slice().sort(), ['battleship', 'carrier', 'cruiser', 'submarine'])
  assert.equal(ref.allSunk(fleet, shots2), false)
})

/* ------------------------------------------------------------------ *
 * 7. State machine: placement, turn flow, winner, over
 * ------------------------------------------------------------------ */
test('placement phase: out-of-bounds/overlap/adjacency rejected, order enforced', () => {
  const state = ref.newGameState(1)
  assert.equal(state.phase, 'place')
  assert.equal(state.turn, 'player')
  assert.deepEqual(ref.validateState(state), [])

  let result = ref.placeCurrent(state, 97, 'h') // carrier len 5 -> out of bounds
  assert.equal(result.ok, false)
  assert.equal(state.placementIndex, 0)

  result = ref.placeCurrent(state, 0, 'h')
  assert.equal(result.ok, true)
  assert.equal(state.placementIndex, 1)
  assert.deepEqual(state.playerShips[0], { key: 'carrier', cells: [0, 1, 2, 3, 4] })

  // battleship origin 10 (row 1) is adjacent to the carrier
  assert.equal(ref.canPlaceCurrent(state, 10, 'h').ok, false)
  assert.equal(ref.canPlaceCurrent(state, 11, 'h').ok, false, 'diagonal adjacency rejected')
  assert.equal(ref.placeCurrent(state, 23, 'v').ok, true) // battleship x3 y2..5
  assert.equal(state.playerShips[1].key, 'battleship')

  assert.equal(ref.placeCurrent(state, 45, 'v').ok, true) // cruiser x5 y4..6
  assert.equal(ref.placeCurrent(state, 47, 'v').ok, true) // submarine x7 y4..6
  assert.equal(ref.placeCurrent(state, 87, 'h').ok, true) // destroyer row 8 x7..8
  assert.equal(state.placementIndex, 5)
  assert.equal(ref.canPlaceCurrent(state, 90, 'h').ok, false, 'no ship left to place')
  assert.deepEqual(ref.validateState(state), [])
})

test('removeLastShip: pops in reverse order; placementIndex tracks', () => {
  const state = ref.newGameState(7)
  ref.placeCurrent(state, 0, 'h')
  ref.placeCurrent(state, 23, 'v')
  assert.equal(ref.removeLastShip(state).ok, true)
  assert.equal(state.placementIndex, 1)
  assert.deepEqual(state.playerShips.map((ship) => ship.key), ['carrier'])
  assert.equal(ref.removeLastShip(state).ok, true)
  assert.equal(state.placementIndex, 0)
  assert.equal(ref.removeLastShip(state).ok, false)
  assert.equal(ref.removeLastShip(state).ok, false, 'idempotent on empty')
})

test('startBattle: requires a full fleet, generates a legal enemy fleet, player first', () => {
  const state = ref.newGameState(3)
  assert.equal(ref.startBattle(state).ok, false, 'empty fleet must not start')
  ref.placeCurrent(state, 0, 'h')
  assert.equal(ref.startBattle(state).ok, false, 'partial fleet must not start')
  ref.removeLastShip(state)
  assert.equal(ref.randomizePlacement(state).ok, true)
  assert.equal(state.placementIndex, 5)
  assert.equal(ref.startBattle(state).ok, true)
  assert.equal(state.phase, 'battle')
  assert.equal(state.turn, 'player')
  assert.equal(state.winner, null)
  assert.deepEqual(ref.validateFleet(state.enemyShips, state.allowAdjacent), [])
  assert.deepEqual(ref.validateState(state), [])
})

test('fire flow: player first, turn alternation, repeat/off-turn rejection, win ends game', () => {
  const state = ref.newGameState(11)
  ref.randomizePlacement(state)
  ref.startBattle(state)

  assert.equal(ref.fireAt(state, 0).ok, true, 'player fires first')
  assert.equal(state.turn, 'enemy')
  const before = state.playerShots.slice()
  assert.equal(ref.fireAt(state, 1).ok, false, 'player cannot fire twice')
  assert.equal(ref.fireAt(state, 0).ok, false, 'repeat cell must be rejected')
  assert.deepEqual(state.playerShots, before, 'rejected shots must not mutate')
  assert.equal(ref.aiTurn(state).ok, true, 'AI takes its turn')
  assert.equal(state.turn, 'player')

  // play the rest deterministically: player shoots every enemy ship cell
  const target = state.enemyShips.flatMap((ship) => ship.cells)
  let guard = 0
  while (state.phase === 'battle' && guard < 400) {
    guard += 1
    if (state.turn === 'player') {
      const cell = target.find((candidate) => state.playerShots[candidate] === 0)
      assert.ok(cell !== undefined, 'player has no enemy ship cell left but game is not over')
      ref.fireAt(state, cell)
    } else {
      ref.aiTurn(state)
    }
    assert.deepEqual(ref.validateState(state), [], `invalid state after action (guard ${guard})`)
  }
  assert.ok(guard < 400, 'game did not terminate')
  assert.equal(state.phase, 'over')
  assert.equal(state.winner, 'player')
  assert.equal(ref.fireAt(state, 95).ok, false, 'no firing after the game is over')
  assert.equal(ref.aiTurn(state).ok, false, 'no AI turn after the game is over')
})

/* ------------------------------------------------------------------ *
 * 8. AI invariants
 * ------------------------------------------------------------------ */
test('AI: never fires a fired cell, only advances rng, never null with cells left', () => {
  for (const difficulty of ref.DIFFICULTIES) {
    for (const seed of [0, 5, 77, 123456]) {
      const state = ref.newGameState(seed)
      state.difficulty = difficulty
      ref.randomizePlacement(state)
      ref.startBattle(state)
      // scatter some shots so both boards have misses/hits
      for (let i = 0; i < 30; i += 1) {
        if (state.phase !== 'battle') break
        if (state.turn === 'player') ref.fireAt(state, (i * 7 + seed) % 100)
        else ref.aiTurn(state)
      }
      for (let sample = 0; sample < 40; sample += 1) {
        const probe = ref.cloneState(state)
        const before = ref.exportState(probe)
        const cell = ref.aiChooseCell(probe)
        const after = ref.exportState(probe)
        assert.deepEqual(after, before, `${difficulty}: aiChooseCell must only advance rng`)
        if (cell === null) {
          assert.ok(
            state.phase !== 'battle' || state.enemyShots.filter((shot) => shot === 0).length === 0,
            'null only when the board is full or the game is over',
          )
          continue
        }
        assert.ok(ref.isCell(cell), `${difficulty}: bad cell ${cell}`)
        assert.equal(state.enemyShots[cell], 0, `${difficulty}: AI chose an already-fired cell ${cell}`)
      }
      // once all 100 cells are fired the AI has nothing left
      const full = ref.cloneState(state)
      full.enemyShots = new Array(100).fill(ref.SHOT_MISS)
      assert.equal(ref.aiChooseCell(full), null)
    }
  }
})

test('AI hunt/target: unresolved hits get priority for normal and hard', () => {
  for (const difficulty of ['normal', 'hard']) {
    for (const seed of [0, 1, 2, 3]) {
      const state = ref.newGameState(seed)
      state.difficulty = difficulty
      ref.randomizePlacement(state)
      ref.startBattle(state)
      // hit some (not all) cells of a large ship so it is unresolved
      const ship = state.playerShips[0]
      state.enemyShots[ship.cells[0]] = ref.SHOT_HIT
      state.enemyShots[ship.cells[1]] = ref.SHOT_HIT
      const expected = ref.targetCells(state.playerShips, state.enemyShots)
      assert.ok(expected.length > 0, 'test setup must create target cells')
      for (let sample = 0; sample < 30; sample += 1) {
        const probe = ref.cloneState(state)
        probe.rng = (seed * 131 + sample * 7919) >>> 0
        const cell = ref.aiChooseCell(probe)
        assert.ok(expected.includes(cell), `${difficulty}: chose ${cell}, expected one of ${expected.join(',')}`)
      }
    }
  }
})

test('AI easy: random (not target-locked) and never repeats', () => {
  const state = ref.newGameState(99)
  state.difficulty = 'easy'
  ref.randomizePlacement(state)
  ref.startBattle(state)
  const ship = state.playerShips[0]
  state.enemyShots[ship.cells[0]] = ref.SHOT_HIT
  const targets = new Set(ref.targetCells(state.playerShips, state.enemyShots))
  const chosen = new Set()
  for (let sample = 0; sample < 120; sample += 1) {
    const probe = ref.cloneState(state)
    probe.rng = (sample * 2654435761) >>> 0
    const cell = ref.aiChooseCell(probe)
    assert.equal(state.enemyShots[cell], 0, 'easy AI chose a fired cell')
    chosen.add(cell)
  }
  assert.ok(chosen.size > 20, `easy AI only chose ${chosen.size} distinct cells in 120 samples`)
  const nonTarget = [...chosen].filter((cell) => !targets.has(cell)).length
  assert.ok(nonTarget > chosen.size * 0.5, 'easy AI must not be target-locked')
})

test('AI hard: uses the density map (chosen cell is a max-probability cell)', () => {
  const state = ref.newGameState(2024)
  state.difficulty = 'hard'
  ref.randomizePlacement(state)
  ref.startBattle(state)
  // mark a row of misses (no unresolved hits) so density is well-defined
  for (const cell of [0, 1, 2, 3, 4]) state.enemyShots[cell] = ref.SHOT_MISS
  const { counts } = ref.placementProbability(state.playerShips, state.enemyShots, state.allowAdjacent)
  const max = Math.max(...counts)
  assert.ok(max > 0, 'density map should have candidates')
  for (let sample = 0; sample < 25; sample += 1) {
    const probe = ref.cloneState(state)
    probe.rng = (sample * 40503 + 12345) >>> 0
    const cell = ref.aiChooseCell(probe)
    assert.equal(counts[cell], max, `hard chose ${cell} with density ${counts[cell]} < max ${max}`)
  }
})

test('targetCells / lineContinuationTargets: unresolved-hit neighbours and hit-run extensions', () => {
  const fleet = makeFleet() // carrier 0..4, battleship 20..23, ...
  const shots = new Array(100).fill(0)
  // unresolved carrier hits 2,3,4 (carrier not sunk) -> neighbours of the run
  shots[2] = ref.SHOT_HIT
  shots[3] = ref.SHOT_HIT
  shots[4] = ref.SHOT_HIT
  assert.deepEqual(ref.unresolvedHitCells(fleet, shots).sort((a, b) => a - b), [2, 3, 4])
  const targets = ref.targetCells(fleet, shots)
  for (const cell of [1, 5]) assert.ok(targets.includes(cell), `targetCells must include ${cell}`)
  // line extension of the same run: 1 and 5 (both ends)
  const lines = ref.lineContinuationTargets(shots)
  assert.ok(lines.includes(1) && lines.includes(5), `lineContinuationTargets ${lines.join(',')}`)
  // fully sunk battleship at 20..23 with unknown cell 24 beyond it: unresolved
  // hits are gone, but the line heuristic still sees the extension 24.
  shots[20] = shots[21] = shots[22] = shots[23] = ref.SHOT_HIT
  assert.ok(ref.lineContinuationTargets(shots).includes(24))
  const stillUnresolved = ref.unresolvedHitCells(fleet, shots).sort((a, b) => a - b)
  assert.deepEqual(stillUnresolved, [2, 3, 4], 'sunk ship hits are not unresolved')
  const targetsAfter = ref.targetCells(fleet, shots)
  assert.ok(!targetsAfter.includes(24), 'a sunk ship line extension is not an unresolved-hit target')
  // single hit has no line continuation, but is still a target source
  shots[70] = ref.SHOT_HIT // submarine cell 70 (vertical 60,70,80)
  assert.ok(!ref.lineContinuationTargets(shots).includes(71), 'single hit must not create a line target')
  assert.ok(ref.targetCells(fleet, shots).includes(71), 'single unresolved hit must create neighbours')
})

test('AI gauntlet: every difficulty finishes a game in bounded turns, state always valid', () => {
  for (const difficulty of ref.DIFFICULTIES) {
    for (const seed of [0, 1, 2, 3, 4]) {
      const state = ref.newGameState(seed)
      state.difficulty = difficulty
      ref.randomizePlacement(state)
      ref.startBattle(state)
      let turns = 0
      while (state.phase === 'battle' && turns < 400) {
        turns += 1
        if (state.turn === 'player') {
          // a deliberately weak "player": shoot unfired cells in ascending order
          const cell = ref.unfiredCells(state.playerShots)[0]
          assert.ok(cell !== undefined, 'player has no cell left during battle')
          ref.fireAt(state, cell)
        } else {
          const result = ref.aiTurn(state)
          assert.equal(result.ok, true, `${difficulty}: AI turn failed while battle active`)
        }
        assert.deepEqual(ref.validateState(state), [], `${difficulty} seed ${seed} turn ${turns}`)
      }
      assert.ok(turns < 400, `${difficulty} seed ${seed}: game did not terminate (${turns} turns)`)
      assert.equal(state.phase, 'over')
      assert.ok(state.winner === 'player' || state.winner === 'enemy')
      assert.deepEqual(ref.validateState(state), [])
    }
  }
})

/* ------------------------------------------------------------------ *
 * 9. State validator catches corruption
 * ------------------------------------------------------------------ */
test('validateState: accepts legal states, catches every class of corruption', () => {
  const state = ref.newGameState(42)
  ref.randomizePlacement(state)
  ref.startBattle(state)
  ref.fireAt(state, 0)
  ref.aiTurn(state)
  assert.deepEqual(ref.validateState(state), [])

  const mutationProblems = (mutate) => {
    const copy = ref.cloneState(state)
    mutate(copy)
    return ref.validateState(copy)
  }

  assert.ok(mutationProblems((s) => { s.playerShips[0].cells[0] = 99 }).length > 0, 'out-of-bounds ship cell')
  assert.ok(mutationProblems((s) => { s.playerShips[1].cells = s.playerShips[0].cells.slice(0, 4) }).length > 0, 'overlap')
  assert.ok(mutationProblems((s) => {
    // put the battleship on the row directly under the carrier's first cell: guaranteed adjacency
    const x = ref.cellX(s.playerShips[0].cells[0])
    const y = ref.cellY(s.playerShips[0].cells[0])
    s.playerShips[1].cells = [ref.cellAt(Math.min(x, 6), y + 1), ref.cellAt(Math.min(x, 6) + 1, y + 1),
      ref.cellAt(Math.min(x, 6) + 2, y + 1), ref.cellAt(Math.min(x, 6) + 3, y + 1)]
  }).length > 0, 'adjacency')
  assert.ok(mutationProblems((s) => { s.playerShips[0].cells[0] = 95; s.playerShips[0].cells[1] = 96 }).length > 0, 'broken shape')
  const enemyCells = new Set(state.enemyShips.flatMap((ship) => ship.cells))
  const water = [...Array(ref.CELL_COUNT).keys()].find((cell) => !enemyCells.has(cell))
  assert.ok(mutationProblems((s) => { s.playerShots[water] = ref.SHOT_HIT }).length > 0, 'hit on water')
  assert.ok(mutationProblems((s) => { s.enemyShots[s.playerShips[0].cells[0]] = ref.SHOT_MISS }).length > 0, 'miss on a ship')
  assert.ok(mutationProblems((s) => { s.winner = 'player' }).length > 0, 'winner without sunk fleet')
  assert.ok(mutationProblems((s) => { s.playerShots = new Array(99).fill(0) }).length > 0, 'short shots array')
  assert.ok(mutationProblems((s) => { s.playerShots[3] = 7 }).length > 0, 'bad shot value')
  assert.ok(mutationProblems((s) => { s.phase = 'over' }).length > 0, 'over with no winner')
  assert.ok(mutationProblems((s) => { s.turn = 'nobody' }).length > 0, 'bad turn')
  assert.ok(mutationProblems((s) => { s.schemaVersion = 2 }).length > 0, 'bad schemaVersion')
  assert.ok(ref.validateState([]).length > 0, 'array is not a state')
  assert.ok(ref.validateState(null).length > 0, 'null is not a state')
  assert.ok(mutationProblems((s) => { s.enemyShips[0].cells = s.enemyShips[0].cells.slice(0, 2) }).length > 0, 'enemy ship wrong length')
})

test('validateState: winner/phase consistency both directions; sunk fleet without winner rejected', () => {
  const state = ref.newGameState(8)
  ref.randomizePlacement(state)
  ref.startBattle(state)
  // sink the whole enemy fleet (fireAt requires the player's turn)
  for (const ship of state.enemyShips) for (const cell of ship.cells) { state.turn = 'player'; ref.fireAt(state, cell) }
  assert.equal(state.winner, 'player')
  assert.deepEqual(ref.validateState(state), [])
  const copy = ref.cloneState(state)
  copy.winner = null
  copy.phase = 'battle'
  assert.ok(ref.validateState(copy).length > 0, 'sunk fleet with no winner must be rejected')
})

/* ------------------------------------------------------------------ *
 * 10. export/diff helpers
 * ------------------------------------------------------------------ */
test('exportState/diffState: identical states diff to null; changes are reported', () => {
  const state = ref.newGameState(5)
  ref.randomizePlacement(state)
  ref.startBattle(state)
  ref.fireAt(state, 0)
  const exported = ref.exportState(state)
  assert.equal(ref.diffState(exported, ref.exportState(state)), null)
  const changed = ref.cloneState(state)
  changed.turn = state.turn === 'player' ? 'enemy' : 'player'
  const diffs = ref.diffState(exported, ref.exportState(changed))
  assert.ok(diffs && diffs.some((entry) => entry.field === 'turn'))
  const shotChange = ref.cloneState(state)
  shotChange.playerShots[5] = 1
  assert.ok(ref.diffState(exported, ref.exportState(shotChange)).some((entry) => entry.field === 'playerShots'))
})

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */
console.log(`\nreference-selftest: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.error('REFERENCE SELFTEST FAILED')
  process.exit(1)
}
console.log('REFERENCE SELFTEST OK')
