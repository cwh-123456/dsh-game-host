/**
 * reference-battleship.mjs — INDEPENDENT rules model for Battleship.
 *
 * Written from the Chinese spec (`handoff/to-sub/010-add-battleship.md`) and the
 * frozen plugin contract (`handoff/contract/game-plugin-api.v1.md`) — it does
 * NOT import or copy any logic from `packages/dsh-game-battleship/client.js`.
 *
 * The audit uses this model as an oracle for:
 *   - geometry: 10x10 board, ships 5/4/3/3/2, horizontal/vertical, in-bounds;
 *   - placement legality: no overlap, default no adjacency INCLUDING diagonals;
 *   - shot resolution: miss / hit / sunk (which ship) / win (all five sunk);
 *   - turn flow: player fires first, turns alternate, win ends the game;
 *   - AI invariants: never fires a fired cell, never deadlocks, hunt/target
 *     property (unresolved hits get priority) and easy=random / hard=density;
 *   - full-state invariants (validateState) used to judge states produced by the
 *     client implementation and by corrupted saves.
 *
 * State shape mirrored from the Lead's declared contract (handoff keys, task 1):
 *   { schemaVersion?, seed, rng, phase:'place'|'battle'|'over',
 *     allowAdjacent, difficulty:'easy'|'normal'|'hard', orientation:'h'|'v',
 *     placementIndex, playerShips:[{key,cells}], enemyShips:[{key,cells}],
 *     playerShots:number[100], enemyShots:number[100],
 *     turn:'player'|'enemy', winner:null|'player'|'enemy' }
 *   playerShots = shots BY the player AT the enemy fleet;
 *   enemyShots  = shots BY the AI  AT the player fleet.
 *
 * Cell indexing is row-major: cell = y*10 + x, 0..99. This is the natural reading
 * of "10x10" with a single 0..99 integer; diff-fuzz verifies the client agrees
 * via shipCells()/placement comparisons (a transposed client would be caught).
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

export const SIZE = 10
export const CELL_COUNT = SIZE * SIZE

/** Ship roster, in placement order (largest first, as listed by the spec). */
export const SHIPS = [
  { key: 'carrier', name: '航空母舰', len: 5 },
  { key: 'battleship', name: '战列舰', len: 4 },
  { key: 'cruiser', name: '巡洋舰', len: 3 },
  { key: 'submarine', name: '潜艇', len: 3 },
  { key: 'destroyer', name: '驱逐舰', len: 2 },
]

export const SHIP_KEYS = SHIPS.map((ship) => ship.key)
export const SHIP_BY_KEY = new Map(SHIPS.map((ship) => [ship.key, ship]))
export const TOTAL_SHIP_CELLS = SHIPS.reduce((sum, ship) => sum + ship.len, 0) // 17

export const SHOT_UNKNOWN = 0
export const SHOT_MISS = 1
export const SHOT_HIT = 2

export const PHASES = ['place', 'battle', 'over']
export const DIFFICULTIES = ['easy', 'normal', 'hard']
export const ORIENTATIONS = ['h', 'v']

/* ------------------------------------------------------------------ *
 * Deterministic RNG (mulberry32, the algorithm the Lead named in the seam)
 * ------------------------------------------------------------------ */

/** mulberry32 PRNG factory: returns a () => float in [0,1) closure. */
export function makeRng(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Advance a state.rng uint32 by one mulberry32 step.
 * Returns { value, rng } and never mutates its input.
 */
export function nextRandom(rngValue) {
  const a = ((Number.isFinite(rngValue) ? (rngValue >>> 0) : 0) + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, rng: a >>> 0 }
}

/** Random integer in [0, n) driven by a () => float rng. */
export function randInt(rng, n) {
  return Math.floor(rng() * n)
}

/** State-rng variant: advances state.rng in place (the documented aiChooseCell side effect). */
export function stateRandom(state) {
  const step = nextRandom(state.rng)
  state.rng = step.rng
  return step.value
}

/* ------------------------------------------------------------------ *
 * Cell geometry
 * ------------------------------------------------------------------ */

export function inBounds(x, y) {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE
}

export function cellX(cell) {
  return cell % SIZE
}

export function cellY(cell) {
  return Math.floor(cell / SIZE)
}

export function cellAt(x, y) {
  return y * SIZE + x
}

export function isCell(value) {
  return Number.isInteger(value) && value >= 0 && value < CELL_COUNT
}

/**
 * Cells occupied by a ship of length `len` with `origin` as its top/left cell.
 * horizontal=true expands along +x, false along +y. Returns null when any part
 * of the ship would leave the board (the client contract says null).
 */
export function shipCells(origin, len, horizontal) {
  if (!isCell(origin)) return null
  if (!Number.isInteger(len) || len < 1) return null
  const x0 = cellX(origin)
  const y0 = cellY(origin)
  const cells = []
  for (let i = 0; i < len; i += 1) {
    const x = horizontal ? x0 + i : x0
    const y = horizontal ? y0 : y0 + i
    if (!inBounds(x, y)) return null
    cells.push(cellAt(x, y))
  }
  return cells
}

/** Chebyshev-adjacent (8-neighbourhood, so diagonals count). */
export function isAdjacent(a, b) {
  if (a === b) return false
  return Math.abs(cellX(a) - cellX(b)) <= 1 && Math.abs(cellY(a) - cellY(b)) <= 1
}

/** True when any cell of A touches any cell of B (diagonals included). */
export function fleetsTouch(cellsA, cellsB) {
  for (const a of cellsA) for (const b of cellsB) if (isAdjacent(a, b)) return true
  return false
}

/* ------------------------------------------------------------------ *
 * Fleet shape / placement legality
 * ------------------------------------------------------------------ */

function shipCellsOf(ship) {
  return Array.isArray(ship) ? ship : ship && ship.cells
}

/** All distinct occupied cells of a list of ships, with duplicate detection. */
export function fleetOccupied(ships) {
  const seen = new Map()
  const duplicates = []
  for (const ship of ships || []) {
    const cells = shipCellsOf(ship)
    if (!Array.isArray(cells)) continue
    for (const cell of cells) {
      if (seen.has(cell)) duplicates.push(cell)
      else seen.set(cell, true)
    }
  }
  return { occupied: seen, duplicates }
}

/**
 * Independent placement legality for a candidate ship's cells against already
 * placed ships. `allowAdjacent=false` is the spec default: ships may not touch,
 * not even diagonally.
 * Returns { ok, reason } with a machine-friendly reason string.
 */
export function isValidPlacement(ships, cells, allowAdjacent) {
  if (!Array.isArray(cells) || cells.length === 0) return { ok: false, reason: 'no-cells' }
  const seen = new Set()
  for (const cell of cells) {
    if (!isCell(cell)) return { ok: false, reason: 'out-of-bounds' }
    if (seen.has(cell)) return { ok: false, reason: 'duplicate-cell' }
    seen.add(cell)
  }
  const existing = (ships || []).map(shipCellsOf).filter(Array.isArray)
  for (const other of existing) {
    for (const cell of other) {
      if (seen.has(cell)) return { ok: false, reason: 'overlap' }
    }
  }
  if (!allowAdjacent) {
    for (const other of existing) {
      if (fleetsTouch(seen, other)) return { ok: false, reason: 'adjacent' }
    }
  }
  return { ok: true, reason: null }
}

/**
 * Shape check of one ship: correct length for its key, straight contiguous run,
 * inside the board. Does NOT check inter-ship rules (validateFleet does).
 */
export function validateShipShape(ship) {
  const problems = []
  if (!ship || typeof ship !== 'object') return ['ship is not an object']
  const spec = SHIP_BY_KEY.get(ship.key)
  if (!spec) return [`unknown ship key ${JSON.stringify(ship.key)}`]
  const cells = ship.cells
  if (!Array.isArray(cells)) return [`${ship.key}: cells is not an array`]
  if (cells.length !== spec.len) problems.push(`${ship.key}: ${cells.length} cells, expected ${spec.len}`)
  const valid = []
  for (const cell of cells) {
    if (!isCell(cell)) {
      problems.push(`${ship.key}: invalid cell ${JSON.stringify(cell)}`)
      continue
    }
    valid.push(cell)
  }
  if (valid.length !== cells.length) return problems
  if (valid.length >= 2) {
    const sameRow = valid.every((cell) => cellY(cell) === cellY(valid[0]))
    const sameCol = valid.every((cell) => cellX(cell) === cellX(valid[0]))
    if (!sameRow && !sameCol) {
      problems.push(`${ship.key}: cells are not in one row or column`)
    } else if (sameRow) {
      const xs = valid.map(cellX).sort((a, b) => a - b)
      for (let i = 1; i < xs.length; i += 1) {
        if (xs[i] - xs[i - 1] !== 1) {
          problems.push(`${ship.key}: cells are not contiguous`)
          break
        }
      }
    } else {
      const ys = valid.map(cellY).sort((a, b) => a - b)
      for (let i = 1; i < ys.length; i += 1) {
        if (ys[i] - ys[i - 1] !== 1) {
          problems.push(`${ship.key}: cells are not contiguous`)
          break
        }
      }
    }
  }
  return problems
}

/**
 * Full fleet validation: exactly the five ships once each, each shaped right,
 * no overlap and (unless allowAdjacent) no adjacency including diagonals.
 * `requireAll` false allows a placement-phase prefix (0..5 ships in order).
 */
export function validateFleet(ships, allowAdjacent, options = {}) {
  const problems = []
  const requireAll = options.requireAll !== false
  if (!Array.isArray(ships)) return ['fleet is not an array']
  const expected = requireAll ? SHIPS.length : ships.length
  if (ships.length !== expected) problems.push(`fleet has ${ships.length} ships, expected ${expected}`)
  const seenKeys = new Set()
  for (let index = 0; index < ships.length; index += 1) {
    const ship = ships[index]
    if (requireAll) {
      const expectedKey = SHIPS[index] && SHIPS[index].key
      if (!ship || ship.key !== expectedKey) problems.push(`fleet[${index}] key ${JSON.stringify(ship && ship.key)} != ${expectedKey}`)
    }
    if (ship && ship.key) {
      if (seenKeys.has(ship.key)) problems.push(`duplicate ship key ${ship.key}`)
      seenKeys.add(ship.key)
    }
    problems.push(...validateShipShape(ship))
  }
  if (requireAll) {
    for (const spec of SHIPS) if (!seenKeys.has(spec.key)) problems.push(`missing ship ${spec.key}`)
  }
  const { duplicates } = fleetOccupied(ships)
  if (duplicates.length) problems.push(`overlapping cells: ${[...new Set(duplicates)].join(',')}`)
  if (!allowAdjacent) {
    for (let i = 0; i < ships.length; i += 1) {
      for (let j = i + 1; j < ships.length; j += 1) {
        const a = ships[i] && ships[i].cells
        const b = ships[j] && ships[j].cells
        if (Array.isArray(a) && Array.isArray(b) && fleetsTouch(a, b)) {
          problems.push(`ships ${ships[i].key} and ${ships[j].key} touch (adjacency incl. diagonal)`)
        }
      }
    }
  }
  return problems
}

/**
 * Draw a complete legal fleet with the supplied () => float rng.
 * Returns [{key,cells}] in SHIPS order, or null if it could not place all ships.
 * Independent of client code; used by the self-test and for seeding states.
 */
export function randomFleet(rng, allowAdjacent) {
  for (let restart = 0; restart < 60; restart += 1) {
    const ships = []
    let failed = false
    for (const spec of SHIPS) {
      let placed = false
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const horizontal = rng() < 0.5
        const origin = Math.floor(rng() * CELL_COUNT)
        const cells = shipCells(origin, spec.len, horizontal)
        if (!cells) continue
        const verdict = isValidPlacement(ships, cells, allowAdjacent)
        if (!verdict.ok) continue
        ships.push({ key: spec.key, cells })
        placed = true
        break
      }
      if (!placed) {
        failed = true
        break
      }
    }
    if (!failed) return ships
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Shot resolution
 * ------------------------------------------------------------------ */

/** cell -> ship key for a fleet. */
export function fleetMap(fleet) {
  const map = new Map()
  for (const ship of fleet || []) {
    for (const cell of ship.cells || []) map.set(cell, ship.key)
  }
  return map
}

/** Count of hit cells per ship key for a shots array. */
export function shipHitCounts(fleet, shots) {
  const counts = new Map()
  for (const ship of fleet || []) {
    let hits = 0
    for (const cell of ship.cells || []) if (shots[cell] === SHOT_HIT) hits += 1
    counts.set(ship.key, hits)
  }
  return counts
}

/** Ship keys whose every cell is hit (in SHIPS order). */
export function sunkKeys(fleet, shots) {
  const counts = shipHitCounts(fleet, shots)
  const sunk = []
  for (const spec of SHIPS) {
    if (counts.get(spec.key) === spec.len) sunk.push(spec.key)
  }
  return sunk
}

export function allSunk(fleet, shots) {
  return (fleet || []).length === SHIPS.length && sunkKeys(fleet, shots).length === SHIPS.length
}

/**
 * Resolve one shot at `cell` against `fleet`, mutating `shots`:
 *   miss -> 1 ; hit/sunk/win -> 2.
 * Returns { result:'miss'|'hit'|'sunk'|'win', shipKey } where shipKey is set for
 * hit/sunk/win (the ship touched; for win it is the final sunk ship).
 * The caller is responsible for validating the cell/repeat/phase.
 */
export function resolveShot(fleet, shots, cell) {
  const map = fleetMap(fleet)
  const shipKey = map.get(cell) || null
  if (!shipKey) {
    shots[cell] = SHOT_MISS
    return { result: 'miss', shipKey: null }
  }
  shots[cell] = SHOT_HIT
  const spec = SHIP_BY_KEY.get(shipKey)
  let hits = 0
  for (const ship of fleet) {
    if (ship.key !== shipKey) continue
    for (const shipCell of ship.cells) if (shots[shipCell] === SHOT_HIT) hits += 1
  }
  if (hits < spec.len) return { result: 'hit', shipKey }
  if (allSunk(fleet, shots)) return { result: 'win', shipKey }
  return { result: 'sunk', shipKey }
}

/* ------------------------------------------------------------------ *
 * Reference state machine (same field names the Lead declared)
 * ------------------------------------------------------------------ */

export const SAVE_SCHEMA_VERSION = 1

export function newGameState(seed, options = {}) {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    seed: (Number.isFinite(seed) ? seed >>> 0 : 0) >>> 0,
    rng: (Number.isFinite(seed) ? seed >>> 0 : 0) >>> 0,
    phase: 'place',
    allowAdjacent: options.allowAdjacent === true,
    difficulty: options.difficulty || 'normal',
    orientation: options.orientation || 'h',
    placementIndex: 0,
    playerShips: [],
    enemyShips: [],
    playerShots: new Array(CELL_COUNT).fill(SHOT_UNKNOWN),
    enemyShots: new Array(CELL_COUNT).fill(SHOT_UNKNOWN),
    turn: 'player',
    winner: null,
  }
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state))
}

/** Turn a () => float rng into one that advances state.rng (in place). */
export function stateRng(state) {
  return () => stateRandom(state)
}

/** Current ship spec to place in the placement phase, or null. */
export function currentShip(state) {
  return state && state.phase === 'place' ? SHIPS[state.placementIndex] || null : null
}

/** Cells that the current ship would occupy; null when out of bounds. */
export function candidateCells(state, origin, orientation) {
  const spec = currentShip(state)
  if (!spec) return null
  const horizontal = orientation ? orientation === 'h' : state.orientation !== 'v'
  return shipCells(origin, spec.len, horizontal)
}

export function canPlaceCurrent(state, origin, orientation) {
  if (!state || state.phase !== 'place') return { ok: false, reason: 'phase' }
  const spec = currentShip(state)
  if (!spec) return { ok: false, reason: 'all-placed' }
  const cells = candidateCells(state, origin, orientation)
  if (!cells) return { ok: false, reason: 'out-of-bounds' }
  return isValidPlacement(state.playerShips, cells, state.allowAdjacent)
}

export function placeCurrent(state, origin, orientation) {
  const verdict = canPlaceCurrent(state, origin, orientation)
  if (!verdict.ok) return verdict
  const spec = currentShip(state)
  const cells = candidateCells(state, origin, orientation)
  state.playerShips.push({ key: spec.key, cells })
  state.placementIndex += 1
  return { ok: true, reason: null, key: spec.key, cells }
}

export function removeLastShip(state) {
  if (!state || state.phase !== 'place' || state.placementIndex === 0) return { ok: false, reason: 'nothing-to-remove' }
  state.playerShips.pop()
  state.placementIndex -= 1
  return { ok: true, reason: null }
}

export function randomizePlacement(state) {
  if (!state || state.phase !== 'place') return { ok: false, reason: 'phase' }
  const fleet = randomFleet(stateRng(state), state.allowAdjacent)
  if (!fleet) return { ok: false, reason: 'no-fleet' }
  state.playerShips = fleet
  state.placementIndex = SHIPS.length
  return { ok: true, reason: null }
}

/**
 * Start the battle: requires a complete legal player fleet; generates the enemy
 * fleet with the state rng and sets turn='player' (the spec: player fires first).
 */
export function startBattle(state) {
  if (!state || state.phase !== 'place') return { ok: false, reason: 'phase' }
  if (state.placementIndex !== SHIPS.length) return { ok: false, reason: 'fleet-incomplete' }
  const problems = validateFleet(state.playerShips, state.allowAdjacent)
  if (problems.length) return { ok: false, reason: 'fleet-invalid', problems }
  const enemyShips = randomFleet(stateRng(state), state.allowAdjacent)
  if (!enemyShips) return { ok: false, reason: 'no-enemy-fleet' }
  state.enemyShips = enemyShips
  state.phase = 'battle'
  state.turn = 'player'
  state.winner = null
  return { ok: true, reason: null }
}

/* ------------------------------------------------------------------ *
 * Firing / turns
 * ------------------------------------------------------------------ */

function shotVerdict(state, cell, expectedTurn) {
  if (!state || state.phase !== 'battle') return { ok: false, reason: 'phase' }
  if (state.winner) return { ok: false, reason: 'winner' }
  if (expectedTurn && state.turn !== expectedTurn) return { ok: false, reason: 'turn' }
  if (!isCell(cell)) return { ok: false, reason: 'bad-cell' }
  return null
}

/** The player fires at the enemy fleet. Mutates shots/turn/winner exactly like the rules. */
export function fireAt(state, cell) {
  const blocked = shotVerdict(state, cell, 'player')
  if (blocked) return blocked
  if (state.playerShots[cell] !== SHOT_UNKNOWN) return { ok: false, reason: 'repeat' }
  const resolution = resolveShot(state.enemyShips, state.playerShots, cell)
  if (resolution.result === 'win') {
    state.winner = 'player'
    state.phase = 'over'
  } else {
    state.turn = 'enemy'
  }
  return {
    ok: true,
    result: resolution.result,
    shipKey: resolution.shipKey,
    shipName: resolution.shipKey ? SHIP_BY_KEY.get(resolution.shipKey).name : null,
  }
}

/** The AI fires at the player fleet (no choice logic — cell supplied). */
export function enemyFireAt(state, cell) {
  const blocked = shotVerdict(state, cell, 'enemy')
  if (blocked) return blocked
  if (state.enemyShots[cell] !== SHOT_UNKNOWN) return { ok: false, reason: 'repeat' }
  const resolution = resolveShot(state.playerShips, state.enemyShots, cell)
  if (resolution.result === 'win') {
    state.winner = 'enemy'
    state.phase = 'over'
  } else {
    state.turn = 'player'
  }
  return {
    ok: true,
    result: resolution.result,
    shipKey: resolution.shipKey,
    shipName: resolution.shipKey ? SHIP_BY_KEY.get(resolution.shipKey).name : null,
  }
}

/** Sunk ship keys for one side. side='player' means the player's own fleet. */
export function stateSunkKeys(state, side) {
  return side === 'player' ? sunkKeys(state.playerShips, state.enemyShots) : sunkKeys(state.enemyShips, state.playerShots)
}

export function stateAllSunk(state, side) {
  return side === 'player' ? allSunk(state.playerShips, state.enemyShots) : allSunk(state.enemyShips, state.playerShots)
}

/* ------------------------------------------------------------------ *
 * AI reference implementations
 * ------------------------------------------------------------------ */

/** Unknown (not yet fired-at) cells on the board the AI shoots at. */
export function unfiredCells(shots) {
  const cells = []
  for (let cell = 0; cell < CELL_COUNT; cell += 1) if (shots[cell] === SHOT_UNKNOWN) cells.push(cell)
  return cells
}

/** Orthogonal neighbours of a cell (not diagonal). */
export function orthNeighbors(cell) {
  const x = cellX(cell)
  const y = cellY(cell)
  const out = []
  if (x > 0) out.push(cellAt(x - 1, y))
  if (x < SIZE - 1) out.push(cellAt(x + 1, y))
  if (y > 0) out.push(cellAt(x, y - 1))
  if (y < SIZE - 1) out.push(cellAt(x, y + 1))
  return out
}

/**
 * Unresolved hits: hit cells belonging to a ship that is not fully hit yet.
 * Uses the true fleet (oracle knowledge) — this is the audit's ground-truth
 * definition of "there is something to chase", not necessarily how the client
 * stores it internally.
 */
export function unresolvedHitCells(ships, shots) {
  const map = fleetMap(ships)
  const perShip = new Map()
  for (const ship of ships || []) {
    let hits = 0
    for (const cell of ship.cells) if (shots[cell] === SHOT_HIT) hits += 1
    perShip.set(ship.key, hits)
  }
  const out = []
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (shots[cell] !== SHOT_HIT) continue
    const key = map.get(cell)
    const ship = ships.find((candidate) => candidate.key === key)
    if (!ship) continue
    if (perShip.get(key) !== ship.cells.length) out.push(cell)
  }
  return out
}

/** Unknown orthogonal neighbours of the unresolved hits (deduped, ascending). */
export function targetCells(ships, shots) {
  const set = new Set()
  for (const cell of unresolvedHitCells(ships, shots)) {
    for (const neighbor of orthNeighbors(cell)) if (shots[neighbor] === SHOT_UNKNOWN) set.add(neighbor)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * Unknown cells that extend a straight line of at least two consecutive hits
 * (any hit, including hits belonging to an already-sunk ship). This is the
 * common "line continuation" heuristic; the audit uses it to classify an AI
 * choice as a line extension regardless of whether the client filters sunk
 * ships (that filtering is a strategy question, not a rules question).
 */
export function lineContinuationTargets(shots) {
  const set = new Set()
  const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]]
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (shots[cell] !== SHOT_HIT) continue
    const row = cellY(cell)
    const col = cellX(cell)
    for (const [dr, dc] of deltas) {
      let r = row + dr
      let c = col + dc
      if (!inBounds(r, c) || shots[cellAt(c, r)] !== SHOT_HIT) continue
      while (inBounds(r, c) && shots[cellAt(c, r)] === SHOT_HIT) {
        r += dr
        c += dc
      }
      if (inBounds(r, c) && shots[cellAt(c, r)] === SHOT_UNKNOWN) set.add(cellAt(c, r))
    }
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * Reference dictionary used to check the AI never touches a fired cell and to
 * compute probabilities for the hard-mode density sanity check.
 */
export function placementProbability(ships, shots, allowAdjacent) {
  const counts = new Array(CELL_COUNT).fill(0)
  let placements = 0
  const map = fleetMap(ships)
  const perShip = new Map()
  for (const ship of ships || []) {
    let hits = 0
    for (const cell of ship.cells) if (shots[cell] === SHOT_HIT) hits += 1
    perShip.set(ship.key, hits)
  }
  const sunkCells = []
  const remaining = []
  for (const ship of ships || []) {
    if (perShip.get(ship.key) === ship.cells.length) sunkCells.push(...ship.cells)
    else remaining.push(SHIP_BY_KEY.get(ship.key))
  }
  const blocked = new Set(sunkCells)
  for (let cell = 0; cell < CELL_COUNT; cell += 1) if (shots[cell] === SHOT_MISS) blocked.add(cell)
  for (const spec of remaining) {
    for (let origin = 0; origin < CELL_COUNT; origin += 1) {
      for (const horizontal of [true, false]) {
        const cells = shipCells(origin, spec.len, horizontal)
        if (!cells) continue
        if (cells.some((cell) => blocked.has(cell))) continue
        if (!allowAdjacent) {
          if (cells.some((cell) => { const key = map.get(cell); return key && !remaining.some((spec2) => spec2.key === key) })) continue
          let touchesSunk = false
          for (const cell of cells) if (sunkCells.some((sunk) => isAdjacent(cell, sunk))) { touchesSunk = true; break }
          if (touchesSunk) continue
        }
        placements += 1
        for (const cell of cells) if (shots[cell] === SHOT_UNKNOWN) counts[cell] += 1
      }
    }
  }
  return { counts, placements }
}

/**
 * Reference AI choose (mutates state.rng only, like the client contract).
 * easy   = uniform random over unfired cells;
 * normal = hunt/target: unresolved-hit neighbours first, else uniform random;
 * hard   = hunt/target + probability density over placements of remaining ships.
 * This is an oracle for property checks; the client is free to implement its own
 * equivalent algorithm, so fuzz never compares the exact chosen cell for AI.
 */
export function aiChooseCell(state) {
  if (!state || state.phase !== 'battle' || state.winner) return null
  const shots = state.enemyShots
  const candidates = unfiredCells(shots)
  if (candidates.length === 0) return null
  const difficulty = DIFFICULTIES.includes(state.difficulty) ? state.difficulty : 'normal'

  if (difficulty === 'easy') {
    return candidates[Math.floor(stateRandom(state) * candidates.length)]
  }

  const preferred = targetCells(state.playerShips, shots)
  if (preferred.length > 0) {
    // Hunt/target priority; hard also honours this (density only breaks ties /
    // guides the rest of the board).
    if (difficulty === 'normal') return preferred[Math.floor(stateRandom(state) * preferred.length)]
  }

  if (difficulty === 'hard') {
    const { counts } = placementProbability(state.playerShips, shots, state.allowAdjacent)
    let best = []
    let bestScore = -1
    for (const cell of candidates) {
      const score = counts[cell]
      if (score > bestScore) {
        bestScore = score
        best = [cell]
      } else if (score === bestScore) {
        best.push(cell)
      }
    }
    if (best.length && bestScore > 0) {
      // still chase unresolved hits if any (density is a tie-breaker there)
      if (preferred.length > 0) {
        const overlap = preferred.filter((cell) => bestScore === counts[cell])
        if (overlap.length) return overlap[Math.floor(stateRandom(state) * overlap.length)]
        return preferred[Math.floor(stateRandom(state) * preferred.length)]
      }
      return best[Math.floor(stateRandom(state) * best.length)]
    }
    return preferred.length
      ? preferred[Math.floor(stateRandom(state) * preferred.length)]
      : candidates[Math.floor(stateRandom(state) * candidates.length)]
  }

  return candidates[Math.floor(stateRandom(state) * candidates.length)]
}

/** AI fires once (chooses + resolves); requires turn='enemy' in battle. */
export function aiFire(state) {
  const blocked = shotVerdict(state, 0, 'enemy')
  if (blocked) return blocked
  const cell = aiChooseCell(state)
  if (cell === null) return { ok: false, reason: 'no-cell' }
  const result = enemyFireAt(state, cell)
  return Object.assign({ cell }, result)
}

/** Complete AI turn: fire + hand the turn back (unless won). */
export function aiTurn(state) {
  const blocked = shotVerdict(state, 0, 'enemy')
  if (blocked) return blocked
  const result = aiFire(state)
  return result
}

/* ------------------------------------------------------------------ *
 * Full-state validator (audit ground truth; not client code)
 * ------------------------------------------------------------------ */

/**
 * Independent validation of a full game state. Returns an array of problems
 * (empty = valid). Used to judge client states during fuzz and accepted saves.
 * Options: { allowMissingSchema:true } tolerates the internal state having no
 * schemaVersion field (saves must carry it; the client may keep it internally).
 */
export function validateState(state, options = {}) {
  const problems = []
  if (!state || typeof state !== 'object' || Array.isArray(state)) return ['state is not an object']

  if ('schemaVersion' in state && state.schemaVersion !== SAVE_SCHEMA_VERSION) {
    problems.push(`schemaVersion ${JSON.stringify(state.schemaVersion)} !== ${SAVE_SCHEMA_VERSION}`)
  }
  if (!('schemaVersion' in state) && !options.allowMissingSchema) problems.push('schemaVersion missing')

  if (!Number.isInteger(state.seed) || state.seed < 0 || state.seed > 0xffffffff) problems.push(`bad seed ${JSON.stringify(state.seed)}`)
  if (!Number.isInteger(state.rng) || state.rng < 0 || state.rng > 0xffffffff) problems.push(`bad rng ${JSON.stringify(state.rng)}`)
  if (!PHASES.includes(state.phase)) problems.push(`bad phase ${JSON.stringify(state.phase)}`)
  if (typeof state.allowAdjacent !== 'boolean') problems.push('allowAdjacent is not boolean')
  if (!DIFFICULTIES.includes(state.difficulty)) problems.push(`bad difficulty ${JSON.stringify(state.difficulty)}`)
  if (!ORIENTATIONS.includes(state.orientation)) problems.push(`bad orientation ${JSON.stringify(state.orientation)}`)
  if (!Number.isInteger(state.placementIndex) || state.placementIndex < 0 || state.placementIndex > SHIPS.length) {
    problems.push(`bad placementIndex ${JSON.stringify(state.placementIndex)}`)
  }

  const allowAdjacent = state.allowAdjacent === true
  if (!Array.isArray(state.playerShips)) problems.push('playerShips is not an array')
  else if (state.phase === 'place') {
    if (state.playerShips.length !== state.placementIndex) problems.push(`place phase: ${state.playerShips.length} ships but placementIndex ${state.placementIndex}`)
    if (state.placementIndex > SHIPS.length) problems.push('place phase: too many ships')
    problems.push(...validateFleet(state.playerShips, allowAdjacent, { requireAll: false }))
  } else {
    problems.push(...validateFleet(state.playerShips, allowAdjacent))
  }

  if (!Array.isArray(state.enemyShips)) problems.push('enemyShips is not an array')
  else if (state.phase === 'place') {
    // The implementation may either pre-generate the enemy fleet at new-game or
    // at startBattle; both are consistent with the handoff, which only fixes the
    // state fields, not the generation moment. A partial enemy fleet is invalid.
    if (state.enemyShips.length !== 0 && state.enemyShips.length !== SHIPS.length) {
      problems.push(`place phase: enemyShips has ${state.enemyShips.length} ships (expected 0 or 5)`)
    }
    if (state.enemyShips.length === SHIPS.length) problems.push(...validateFleet(state.enemyShips, allowAdjacent))
  } else {
    problems.push(...validateFleet(state.enemyShips, allowAdjacent))
  }

  for (const side of ['playerShots', 'enemyShots']) {
    const shots = state[side]
    if (!Array.isArray(shots) || shots.length !== CELL_COUNT) {
      problems.push(`${side} is not a ${CELL_COUNT}-element array`)
      continue
    }
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      if (shots[cell] !== SHOT_UNKNOWN && shots[cell] !== SHOT_MISS && shots[cell] !== SHOT_HIT) {
        problems.push(`${side}[${cell}] = ${JSON.stringify(shots[cell])}`)
        break
      }
      if (shots[cell] !== SHOT_UNKNOWN) continue
    }
  }

  // Shot/fleet consistency (only meaningful with complete fleets).
  if (state.phase !== 'place' && Array.isArray(state.enemyShips) && Array.isArray(state.playerShots)) {
    const enemyMap = fleetMap(state.enemyShips)
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      const shot = state.playerShots[cell]
      if (shot === SHOT_HIT && !enemyMap.has(cell)) problems.push(`playerShots[${cell}] is a hit on water`)
      if (shot === SHOT_MISS && enemyMap.has(cell)) problems.push(`playerShots[${cell}] is a miss on a ship`)
    }
  }
  if (state.phase !== 'place' && Array.isArray(state.playerShips) && Array.isArray(state.enemyShots)) {
    const playerMap = fleetMap(state.playerShips)
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      const shot = state.enemyShots[cell]
      if (shot === SHOT_HIT && !playerMap.has(cell)) problems.push(`enemyShots[${cell}] is a hit on water`)
      if (shot === SHOT_MISS && playerMap.has(cell)) problems.push(`enemyShots[${cell}] is a miss on a ship`)
    }
  }

  // Winner / phase consistency.
  if (!('winner' in state) || (state.winner !== null && state.winner !== 'player' && state.winner !== 'enemy')) {
    problems.push(`bad winner ${JSON.stringify(state.winner)}`)
  }
  const surrendered = state.endReason === 'surrender'
  if (state.phase === 'place') {
    if (state.winner !== null) problems.push('place phase has a winner')
  } else if (Array.isArray(state.playerShips) && Array.isArray(state.enemyShips) &&
             Array.isArray(state.playerShots) && Array.isArray(state.enemyShots)) {
    const playerWon = allSunk(state.enemyShips, state.playerShots)
    const enemyWon = allSunk(state.playerShips, state.enemyShots)
    if (playerWon && enemyWon) problems.push('both fleets are sunk')
    if (state.winner === 'player') {
      if (!playerWon) problems.push('winner=player but the enemy fleet is not sunk')
      if (enemyWon) problems.push('winner=player but the player fleet is sunk')
    }
    if (state.winner === 'enemy' && !enemyWon && !surrendered) {
      problems.push('winner=enemy but the player fleet is not sunk (and it was not a surrender)')
    }
    if (state.winner === null && playerWon) problems.push('enemy fleet sunk but no winner')
    if (state.winner === null && enemyWon) problems.push('player fleet sunk but no winner')
    if (surrendered) {
      if (state.winner !== 'enemy') problems.push('endReason=surrender but winner is not enemy')
      if (state.phase !== 'over') problems.push('endReason=surrender but phase is not over')
    } else if (state.winner === 'enemy' && enemyWon) {
      if (state.endReason !== undefined && state.endReason !== 'sunk') problems.push(`endReason ${JSON.stringify(state.endReason)} for a sunk player fleet`)
    }
    const endedBySinking = playerWon || enemyWon
    if (endedBySinking && state.phase !== 'over') problems.push(`a side is sunk but phase is ${state.phase}`)
    if (!endedBySinking && state.phase === 'over' && !surrendered) problems.push('phase=over but no fleet is sunk')
    if (state.winner === 'player' && state.endReason !== undefined && state.endReason !== 'sunk') {
      problems.push(`winner=player endReason ${JSON.stringify(state.endReason)} != sunk`)
    }
  }
  if (state.phase === 'battle' && state.winner === null) {
    if (state.turn !== 'player' && state.turn !== 'enemy') problems.push(`bad turn ${JSON.stringify(state.turn)}`)
  } else if (!('turn' in state) || (state.turn !== 'player' && state.turn !== 'enemy')) {
    problems.push(`bad turn ${JSON.stringify(state.turn)}`)
  }

  return problems
}

/* ------------------------------------------------------------------ *
 * Canonical export / diff helpers
 * ------------------------------------------------------------------ */

export function exportFleet(fleet) {
  return (fleet || []).map((ship) => ({ key: ship.key, cells: [...(ship.cells || [])].sort((a, b) => a - b) }))
}

export function exportState(state) {
  return {
    phase: state.phase,
    allowAdjacent: state.allowAdjacent,
    difficulty: state.difficulty,
    orientation: state.orientation,
    placementIndex: state.placementIndex,
    playerShips: exportFleet(state.playerShips),
    enemyShips: exportFleet(state.enemyShips),
    playerShots: Array.isArray(state.playerShots) ? [...state.playerShots] : state.playerShots,
    enemyShots: Array.isArray(state.enemyShots) ? [...state.enemyShots] : state.enemyShots,
    turn: state.turn,
    winner: state.winner,
  }
}

/** Field-by-field diff of two exported states; returns null when identical. */
export function diffState(expected, actual) {
  const diffs = []
  const fields = ['phase', 'allowAdjacent', 'difficulty', 'orientation', 'placementIndex', 'turn', 'winner']
  for (const field of fields) {
    if (JSON.stringify(expected[field]) !== JSON.stringify(actual[field])) {
      diffs.push({ field, expected: expected[field], actual: actual[field] })
    }
  }
  for (const fleet of ['playerShips', 'enemyShips']) {
    if (JSON.stringify(expected[fleet]) !== JSON.stringify(actual[fleet])) {
      diffs.push({ field: fleet, expected: expected[fleet], actual: actual[fleet] })
    }
  }
  for (const shots of ['playerShots', 'enemyShots']) {
    const a = expected[shots]
    const b = actual[shots]
    if (!Array.isArray(a) || !Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ field: shots, expected: a, actual: b })
      continue
    }
    const changed = []
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) changed.push({ cell: i, expected: a[i], actual: b[i] })
    }
    if (changed.length) diffs.push({ field: shots, changed: changed.slice(0, 12), count: changed.length })
  }
  return diffs.length ? diffs : null
}

/** Stable description of a state for repro output (no rng noise). */
export function describeState(state) {
  const exported = exportState(state)
  return JSON.stringify(exported)
}
