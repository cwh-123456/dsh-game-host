/**
 * @local/dsh-game-battleship — browser half.
 *
 * Registers a Battleship (海战棋) game into the host's `game.stage` chain slot
 * (dsh-game-host plugin contract v1):
 *   - `select({ gameId })` returns the frozen `MATCHED` object only when the
 *     host selected `battleship`, otherwise `null`
 *   - the component only relies on the `matched` prop, never on host internals
 *
 * Why everything lives in this one file: `client.js` is the only browser entry
 * the module loader serves. The loader's `require` resolves entries from the
 * module table (react, ...) and cannot load package-relative modules
 * synchronously, so a separate logic file would be unreachable in the browser.
 * Pure logic is therefore defined first and exposed on
 * `window.__DSH_GAME_BATTLESHIP__` only when
 * `window.__DSH_GAME_BATTLESHIP_TEST__ === true`, which lets `dev/` node tests
 * exercise it without a host (and an independent verifier diff-test it).
 *
 * Rules implemented:
 *   - 10x10 sea per side, 5 ships: carrier 5, battleship 4, cruiser 3,
 *     submarine 3, destroyer 2 (17 cells per fleet)
 *   - placement: horizontal/vertical, in bounds, no overlap, and by default no
 *     adjacency to another ship including diagonals (relaxed by a setting)
 *   - player fires first; hit / miss feedback; a ship whose every cell is hit
 *     is sunk (ship name is announced); first side to sink all five wins
 *   - AI: easy = uniform random; normal = hunt/target (random until a hit, then
 *     the four orthogonal neighbours, line continuation preferred, back to
 *     random after a sink); hard = hunt/target + probability density over the
 *     remaining fleet. The AI never fires a fired cell and never deadlocks.
 *
 * Save key: localStorage['dsh.game.battleship.v1'] (schemaVersion: 1).
 * Other games' keys are never read or written here.
 */
;(function () {
  'use strict'

  const GAME_ID = 'battleship'
  const STORE_KEY = 'dsh.game.' + GAME_ID + '.v1'
  const SCHEMA_VERSION = 1
  const BOARD = 10
  const CELLS = BOARD * BOARD
  const MIN_WIDTH = 320
  const MIN_HEIGHT = 240
  const MIN_BOARD_PX = 90
  const ROOT_PAD = 8
  const PANEL_PAD = 8
  const BOARD_GAP = 14
  const PANEL_HEADER_H = 22
  const MESSAGE_MS = 2600
  const AI_DELAY_MS = 520

  const SHIPS = [
    { key: 'carrier', name: '航空母舰', short: '航母', len: 5 },
    { key: 'battleship', name: '战列舰', short: '战列', len: 4 },
    { key: 'cruiser', name: '巡洋舰', short: '巡洋', len: 3 },
    { key: 'submarine', name: '潜艇', short: '潜艇', len: 3 },
    { key: 'destroyer', name: '驱逐舰', short: '驱逐', len: 2 },
  ]

  const DIFFICULTIES = ['easy', 'normal', 'hard']
  const DIFFICULTY_LABELS = { easy: '简单', normal: '普通', hard: '困难' }
  const MODES = ['ai', 'duo']
  const MODE_LABELS = { ai: '单人', duo: '双人' }
  const SIDE_LABELS = { player: '玩家 A', enemy: '玩家 B' }
  const FLEET_CELLS = SHIPS.reduce(function (sum, ship) {
    return sum + ship.len
  }, 0)
  const SHIP_BY_KEY = (function () {
    const map = {}
    for (let i = 0; i < SHIPS.length; i += 1) map[SHIPS[i].key] = SHIPS[i]
    return map
  })()

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function clamp(value, low, high) {
    if (!Number.isFinite(value)) return low
    if (value < low) return low
    if (value > high) return high
    return value
  }

  function isUint32(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
  }

  function toUint32(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0
    return Math.floor(value) >>> 0
  }

  function cellRow(cell) {
    return Math.floor(cell / BOARD)
  }

  function cellCol(cell) {
    return cell % BOARD
  }

  function inBounds(row, col) {
    return row >= 0 && row < BOARD && col >= 0 && col < BOARD
  }

  function pluralShipName(key) {
    const def = SHIP_BY_KEY[key]
    return def ? def.name : '舰船'
  }

  // ---------------------------------------------------------------------------
  // Seeded RNG
  //
  // The game state stores the 32-bit generator state (`state.rng`), so a saved
  // game continues the exact same random sequence (AI moves, random fleets).
  // ---------------------------------------------------------------------------

  function mulberry32(seed) {
    let state = seed >>> 0
    return function next() {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function randomSeed() {
    let value = 0
    try {
      const cryptoObj = typeof crypto !== 'undefined' ? crypto : null
      if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        const bucket = new Uint32Array(1)
        cryptoObj.getRandomValues(bucket)
        value = bucket[0] >>> 0
      }
    } catch (error) {
      value = 0
    }
    if (!value) {
      value = ((Math.floor(Math.random() * 0xffffffff) >>> 0) ^ (Date.now() >>> 0)) >>> 0
    }
    return value >>> 0
  }

  function stepRng(rng) {
    const state = (rng + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return { rng: state >>> 0, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  }

  function nextRandom(state) {
    const result = stepRng(state.rng >>> 0)
    state.rng = result.rng
    return result.value
  }

  function pickRandom(state, list) {
    if (!Array.isArray(list) || list.length === 0) return null
    const index = Math.floor(nextRandom(state) * list.length)
    return list[clamp(index, 0, list.length - 1)]
  }

  // ---------------------------------------------------------------------------
  // Ship geometry + placement legality
  // ---------------------------------------------------------------------------

  /**
   * Cells covered by a ship starting at `origin`; null when any cell is off the
   * board. Horizontal ships grow to the right, vertical ships grow downwards.
   */
  function shipCells(origin, length, horizontal) {
    if (!Number.isInteger(origin) || origin < 0 || origin >= CELLS) return null
    if (!Number.isInteger(length) || length < 1 || length > BOARD) return null
    const row = cellRow(origin)
    const col = cellCol(origin)
    const cells = []
    for (let i = 0; i < length; i += 1) {
      const r = horizontal ? row : row + i
      const c = horizontal ? col + i : col
      if (!inBounds(r, c)) return null
      cells.push(r * BOARD + c)
    }
    return cells
  }

  function chebyshevAdjacent(a, b) {
    return Math.max(Math.abs(cellRow(a) - cellRow(b)), Math.abs(cellCol(a) - cellCol(b))) === 1
  }

  function shipsAdjacent(cellsA, cellsB) {
    for (let i = 0; i < cellsA.length; i += 1) {
      for (let j = 0; j < cellsB.length; j += 1) {
        if (chebyshevAdjacent(cellsA[i], cellsB[j])) return true
      }
    }
    return false
  }

  /**
   * Canonicalise a ship's cell list: unique in-bounds integers forming one
   * straight contiguous row or column, sorted ascending. Returns null if the
   * cells are not a legal ship shape of `length` cells.
   */
  function normalizeShipCells(rawCells, length) {
    if (!Array.isArray(rawCells) || rawCells.length !== length) return null
    const seen = new Set()
    const cells = []
    for (let i = 0; i < rawCells.length; i += 1) {
      const value = rawCells[i]
      if (!Number.isInteger(value) || value < 0 || value >= CELLS || seen.has(value)) return null
      seen.add(value)
      cells.push(value)
    }
    cells.sort(function (a, b) {
      return a - b
    })
    const sameRow = cells.every(function (cell) {
      return cellRow(cell) === cellRow(cells[0])
    })
    const sameCol = cells.every(function (cell) {
      return cellCol(cell) === cellCol(cells[0])
    })
    if (!sameRow && !sameCol) return null
    for (let i = 1; i < cells.length; i += 1) {
      const step = sameRow ? 1 : BOARD
      if (cells[i] !== cells[0] + i * step) return null
    }
    return cells
  }

  /**
   * Placement check against already placed ships (overlap + optional
   * adjacency). Shape/bounds are validated by the caller (or by shipCells).
   */
  function isValidPlacement(placedShips, cells, allowAdjacent) {
    if (!Array.isArray(cells) || cells.length === 0) return { ok: false, reason: 'out' }
    if (!Array.isArray(placedShips)) return { ok: false, reason: 'out' }
    const seen = new Set()
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i]
      if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return { ok: false, reason: 'out' }
      if (seen.has(cell)) return { ok: false, reason: 'overlap' }
      seen.add(cell)
    }
    const occupied = new Set()
    for (let i = 0; i < placedShips.length; i += 1) {
      const ship = placedShips[i]
      if (!ship || !Array.isArray(ship.cells)) continue
      for (let j = 0; j < ship.cells.length; j += 1) occupied.add(ship.cells[j])
    }
    for (let i = 0; i < cells.length; i += 1) {
      if (occupied.has(cells[i])) return { ok: false, reason: 'overlap' }
    }
    if (allowAdjacent !== true) {
      for (let i = 0; i < placedShips.length; i += 1) {
        const ship = placedShips[i]
        if (!ship || !Array.isArray(ship.cells)) continue
        if (shipsAdjacent(cells, ship.cells)) return { ok: false, reason: 'adjacent' }
      }
    }
    return { ok: true, reason: null }
  }

  /** Structural check for a partial/complete fleet in SHIPS order. */
  function fleetSubsetOk(ships, allowAdjacent) {
    if (!Array.isArray(ships) || ships.length > SHIPS.length) return false
    const occupied = new Set()
    for (let i = 0; i < ships.length; i += 1) {
      const ship = ships[i]
      if (!ship || typeof ship !== 'object' || ship.key !== SHIPS[i].key) return false
      const cells = normalizeShipCells(ship.cells, SHIPS[i].len)
      if (!cells) return false
      for (let j = 0; j < cells.length; j += 1) {
        if (occupied.has(cells[j])) return false
        occupied.add(cells[j])
      }
    }
    if (allowAdjacent !== true) {
      for (let i = 0; i < ships.length; i += 1) {
        for (let j = i + 1; j < ships.length; j += 1) {
          if (shipsAdjacent(ships[i].cells, ships[j].cells)) return false
        }
      }
    }
    return true
  }

  function fleetCompleteOk(ships, allowAdjacent) {
    return Array.isArray(ships) && ships.length === SHIPS.length && fleetSubsetOk(ships, allowAdjacent)
  }

  // ---------------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------------

  function emptyShots() {
    return new Array(CELLS).fill(0)
  }

  function cloneShips(ships) {
    return ships.map(function (ship) {
      return { key: ship.key, cells: ship.cells.slice() }
    })
  }

  function otherSide(side) {
    return side === 'enemy' ? 'player' : 'enemy'
  }

  /**
   * Which fleet the current placement step writes into. In solo mode that is
   * always the human fleet (`playerShips`); in duo mode the second player places
   * into `enemyShips` after the hand-off curtain.
   */
  function placingSide(state) {
    return state && state.mode === 'duo' && state.placeTurn === 'enemy' ? 'enemy' : 'player'
  }

  function placedShips(state) {
    return shipsForSide(state, placingSide(state))
  }

  function isDuo(state) {
    return !!state && state.mode === 'duo'
  }

  function newGameState(seed, mode) {
    const value = isUint32(seed) ? seed : randomSeed()
    const chosen = MODES.indexOf(mode) >= 0 ? mode : 'ai'
    return {
      schemaVersion: SCHEMA_VERSION,
      seed: value,
      rng: value,
      mode: chosen,
      phase: 'place',
      allowAdjacent: false,
      difficulty: 'normal',
      orientation: 'h',
      placementIndex: 0,
      placeTurn: 'player',
      handoff: null,
      playerShips: [],
      enemyShips: [],
      playerShots: emptyShots(),
      enemyShots: emptyShots(),
      turn: 'player',
      winner: null,
      endReason: null,
    }
  }

  function currentShipDef(state) {
    if (!state || state.phase !== 'place') return null
    const fleet = placedShips(state)
    if (fleet.length >= SHIPS.length) return null
    return SHIPS[fleet.length]
  }

  function canPlaceCurrent(state, origin, orientation) {
    if (!state || state.phase !== 'place') return { ok: false, reason: 'phase', cells: null }
    const def = currentShipDef(state)
    if (!def) return { ok: false, reason: 'phase', cells: null }
    const horizontal = (orientation || state.orientation) === 'h'
    const cells = shipCells(origin, def.len, horizontal)
    if (!cells) return { ok: false, reason: 'out', cells: null }
    const check = isValidPlacement(placedShips(state), cells, state.allowAdjacent)
    return { ok: check.ok, reason: check.reason, cells: cells }
  }

  function placeCurrent(state, origin, orientation) {
    if (!state || state.phase !== 'place') return { ok: false, reason: 'phase' }
    const result = canPlaceCurrent(state, origin, orientation)
    if (!result.ok) return result
    const def = currentShipDef(state)
    const fleet = placedShips(state)
    fleet.push({ key: def.key, cells: result.cells.slice() })
    state.placementIndex = fleet.length
    return { ok: true, reason: null, cells: result.cells, shipKey: def.key, side: placingSide(state) }
  }

  function removeLastShip(state) {
    if (!state || state.phase !== 'place') return { ok: false, reason: 'phase' }
    const fleet = placedShips(state)
    if (fleet.length === 0) return { ok: false, reason: 'empty' }
    const removed = fleet.pop()
    state.placementIndex = fleet.length
    return { ok: true, shipKey: removed.key, side: placingSide(state) }
  }

  function randomizePlayerFleet(state) {
    if (!state || state.phase !== 'place') return { ok: false, reason: 'phase' }
    let fleet = null
    for (let attempt = 0; attempt < 120 && !fleet; attempt += 1) {
      fleet = randomFleet(function () {
        return nextRandom(state)
      }, state.allowAdjacent)
    }
    if (!fleet) return { ok: false, reason: 'fleet' }
    const target = placedShips(state)
    target.length = 0
    for (let i = 0; i < fleet.length; i += 1) target.push(fleet[i])
    state.placementIndex = SHIPS.length
    return { ok: true, side: placingSide(state) }
  }

  function randomFleet(rng, allowAdjacent) {
    if (typeof rng !== 'function') return null
    for (let attempt = 0; attempt < 220; attempt += 1) {
      const ships = []
      let ok = true
      for (let i = 0; i < SHIPS.length; i += 1) {
        const def = SHIPS[i]
        let chosen = null
        for (let tries = 0; tries < 260; tries += 1) {
          const horizontal = rng() < 0.5
          const origin = Math.floor(rng() * CELLS)
          const cells = shipCells(origin, def.len, horizontal)
          if (!cells) continue
          const check = isValidPlacement(ships, cells, allowAdjacent)
          if (check.ok) {
            chosen = { key: def.key, cells: cells }
            break
          }
        }
        if (!chosen) {
          ok = false
          break
        }
        ships.push(chosen)
      }
      if (ok && ships.length === SHIPS.length) return ships
    }
    return null
  }

  function rotateOrientation(state) {
    if (!state || state.phase !== 'place') return { ok: false, reason: 'phase' }
    state.orientation = state.orientation === 'h' ? 'v' : 'h'
    return { ok: true, orientation: state.orientation }
  }

  function setDifficulty(state, difficulty) {
    if (!state || DIFFICULTIES.indexOf(difficulty) < 0) return { ok: false, reason: 'difficulty' }
    state.difficulty = difficulty
    return { ok: true }
  }

  function toggleAdjacent(state) {
    if (!state || state.phase !== 'place') return { ok: false, reason: 'phase' }
    if (state.allowAdjacent === true) {
      if (!fleetSubsetOk(state.playerShips, false) || !fleetSubsetOk(state.enemyShips, false)) {
        return { ok: false, reason: 'adjacent' }
      }
      state.allowAdjacent = false
    } else {
      state.allowAdjacent = true
    }
    return { ok: true, allowAdjacent: state.allowAdjacent }
  }

  /**
   * Placement step finished for the fleet currently being placed.
   * Solo: generates the AI fleet and starts the battle (unchanged).
   * Duo: player A finishes → hand the device to player B; player B finishes →
   * battle starts. The opponent fleet is never generated for the player.
   */
  function startBattle(state) {
    if (!state || state.phase !== 'place') return { ok: false, reason: 'phase' }
    const fleet = placedShips(state)
    if (!fleetCompleteOk(fleet, state.allowAdjacent)) return { ok: false, reason: 'fleet' }
    if (isDuo(state)) {
      if (placingSide(state) === 'player') {
        state.placeTurn = 'enemy'
        state.placementIndex = state.enemyShips.length
        state.handoff = 'curtain'
        return { ok: true, next: 'place', side: 'enemy' }
      }
      state.playerShots = emptyShots()
      state.enemyShots = emptyShots()
      state.phase = 'battle'
      state.turn = 'player'
      state.handoff = 'curtain'
      state.winner = null
      state.endReason = null
      return { ok: true, next: 'battle', side: 'player' }
    }
    let enemy = null
    for (let attempt = 0; attempt < 80 && !enemy; attempt += 1) {
      enemy = randomFleet(function () {
        return nextRandom(state)
      }, state.allowAdjacent)
    }
    if (!enemy) return { ok: false, reason: 'fleet' }
    state.enemyShips = enemy
    state.playerShots = emptyShots()
    state.enemyShots = emptyShots()
    state.phase = 'battle'
    state.turn = 'player'
    state.winner = null
    state.endReason = null
    return { ok: true, next: 'battle', side: 'player' }
  }

  function restartBattle(state) {
    if (!state || (state.phase !== 'battle' && state.phase !== 'over')) return { ok: false, reason: 'phase' }
    if (state.playerShips.length !== SHIPS.length || state.enemyShips.length !== SHIPS.length) {
      return { ok: false, reason: 'fleet' }
    }
    state.playerShots = emptyShots()
    state.enemyShots = emptyShots()
    state.phase = 'battle'
    state.turn = 'player'
    state.handoff = isDuo(state) ? 'curtain' : null
    state.winner = null
    state.endReason = null
    return { ok: true }
  }

  function surrender(state) {
    if (!state || state.phase !== 'battle') return { ok: false, reason: 'phase' }
    if (!isDuo(state) && state.turn === 'enemy') return { ok: false, reason: 'turn' }
    const side = isDuo(state) ? state.turn : 'player'
    state.phase = 'over'
    state.winner = otherSide(side)
    state.endReason = 'surrender'
    state.handoff = null
    return { ok: true, side: side }
  }

  /**
   * Duo flow: after a shot the board must stay on the shooter's view until the
   * device is physically handed over, otherwise the next player's fleet would
   * pop into view. `'pass'` = shooter is still looking; `'curtain'` = the board
   * is covered and the next player must confirm.
   */
  function passDevice(state) {
    if (!isDuo(state) || state.handoff !== 'pass') return { ok: false, reason: 'phase' }
    state.handoff = 'curtain'
    return { ok: true }
  }

  /** The next player confirms they hold the device; the board comes back. */
  function acknowledgeHandoff(state) {
    if (!isDuo(state) || state.handoff !== 'curtain') return { ok: false, reason: 'phase' }
    state.handoff = null
    return { ok: true }
  }

  /** Whose eyes the boards are rendered through (solo always reads the human). */
  function viewSideOf(state) {
    if (!isDuo(state)) return 'player'
    if (state.phase === 'place') return placingSide(state)
    if (state.handoff === 'pass') return otherSide(state.turn)
    return state.turn
  }

  // ---------------------------------------------------------------------------
  // Shots / fleet status
  // ---------------------------------------------------------------------------

  function findShipAt(ships, cell) {
    if (!Array.isArray(ships)) return null
    for (let i = 0; i < ships.length; i += 1) {
      const ship = ships[i]
      if (ship && Array.isArray(ship.cells) && ship.cells.indexOf(cell) >= 0) return ship
    }
    return null
  }

  function isShipSunk(shots, ship) {
    if (!ship || !Array.isArray(ship.cells) || ship.cells.length === 0) return false
    for (let i = 0; i < ship.cells.length; i += 1) {
      if (shots[ship.cells[i]] !== 2) return false
    }
    return true
  }

  function allSunk(shots, ships) {
    if (!Array.isArray(ships) || ships.length === 0) return false
    for (let i = 0; i < ships.length; i += 1) {
      if (!isShipSunk(shots, ships[i])) return false
    }
    return true
  }

  function shipsForSide(state, side) {
    return side === 'enemy' ? state.enemyShips : state.playerShips
  }

  function shotsAtSide(state, side) {
    return side === 'enemy' ? state.playerShots : state.enemyShots
  }

  function sunkKeys(state, side) {
    const ships = shipsForSide(state, side)
    const shots = shotsAtSide(state, side)
    const keys = []
    for (let i = 0; i < ships.length; i += 1) {
      if (isShipSunk(shots, ships[i])) keys.push(ships[i].key)
    }
    return keys
  }

  function sideAllSunk(state, side) {
    return allSunk(shotsAtSide(state, side), shipsForSide(state, side))
  }

  function countShotCells(shots) {
    let count = 0
    for (let i = 0; i < shots.length; i += 1) if (shots[i] !== 0) count += 1
    return count
  }

  function countHitCells(shots) {
    let count = 0
    for (let i = 0; i < shots.length; i += 1) if (shots[i] === 2) count += 1
    return count
  }

  /**
   * One shot from `side` at the opponent's fleet. `shotsAtSide(target)` holds
   * the marks that shooter left on the target board, so the same routine serves
   * the human, the AI and the second local player.
   */
  function fireAtSide(state, side, cell) {
    if (!state || state.phase !== 'battle') return { ok: false, reason: 'phase' }
    // While the device is being handed over nobody may fire (duo only).
    if (state.handoff) return { ok: false, reason: 'turn' }
    if (state.turn !== side) return { ok: false, reason: 'turn' }
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return { ok: false, reason: 'range' }
    const target = otherSide(side)
    const shots = shotsAtSide(state, target)
    if (shots[cell] !== 0) return { ok: false, reason: 'fired' }
    const targetShips = shipsForSide(state, target)
    const ship = findShipAt(targetShips, cell)
    shots[cell] = ship ? 2 : 1
    let result = ship ? 'hit' : 'miss'
    let shipKey = ship ? ship.key : null
    if (ship && isShipSunk(shots, ship)) {
      result = 'sunk'
      if (allSunk(shots, targetShips)) {
        result = 'win'
        state.phase = 'over'
        state.winner = side
        state.endReason = 'sunk'
        state.handoff = null
      }
    }
      if (state.phase === 'battle') {
        state.turn = target
        if (isDuo(state)) state.handoff = 'pass'
      }
    return { ok: true, reason: null, result: result, shipKey: shipKey, cell: cell, side: side }
  }

  function fireAt(state, cell) {
    return fireAtSide(state, 'player', cell)
  }

  // ---------------------------------------------------------------------------
  // AI — hunt / target + probability density
  // ---------------------------------------------------------------------------

  function unresolvedHitCells(state) {
    const cells = []
    for (let cell = 0; cell < CELLS; cell += 1) {
      if (state.enemyShots[cell] !== 2) continue
      const ship = findShipAt(state.playerShips, cell)
      if (ship && !isShipSunk(state.enemyShots, ship)) cells.push(cell)
    }
    return cells
  }

  function adjacentUnknownCells(state) {
    const hits = unresolvedHitCells(state)
    const found = new Set()
    const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]]
    for (let i = 0; i < hits.length; i += 1) {
      const row = cellRow(hits[i])
      const col = cellCol(hits[i])
      for (let d = 0; d < deltas.length; d += 1) {
        const r = row + deltas[d][0]
        const c = col + deltas[d][1]
        if (!inBounds(r, c)) continue
        const cell = r * BOARD + c
        if (state.enemyShots[cell] === 0) found.add(cell)
      }
    }
    return Array.from(found).sort(function (a, b) {
      return a - b
    })
  }

  /**
   * When at least two hits are lined up, the most promising cells are the two
   * ends of that line; the AI tests those before other neighbours.
   */
  function lineContinuationCells(state) {
    const found = new Set()
    const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]]
    for (let cell = 0; cell < CELLS; cell += 1) {
      if (state.enemyShots[cell] !== 2) continue
      for (let d = 0; d < deltas.length; d += 1) {
        const dr = deltas[d][0]
        const dc = deltas[d][1]
        let row = cellRow(cell)
        let col = cellCol(cell)
        if (!inBounds(row + dr, col + dc)) continue
        if (state.enemyShots[(row + dr) * BOARD + (col + dc)] !== 2) continue
        // Walk through the run of hits, then look at the unknown cell after it.
        while (inBounds(row + dr, col + dc) && state.enemyShots[(row + dr) * BOARD + (col + dc)] === 2) {
          row += dr
          col += dc
        }
        const nextRow = row + dr
        const nextCol = col + dc
        if (!inBounds(nextRow, nextCol)) continue
        const nextCell = nextRow * BOARD + nextCol
        if (state.enemyShots[nextCell] === 0) found.add(nextCell)
      }
    }
    return Array.from(found).sort(function (a, b) {
      return a - b
    })
  }

  function densityMap(state) {
    const scores = new Array(CELLS).fill(0)
    const blocked = new Set()
    for (let i = 0; i < state.playerShips.length; i += 1) {
      const ship = state.playerShips[i]
      if (isShipSunk(state.enemyShots, ship)) {
        for (let j = 0; j < ship.cells.length; j += 1) blocked.add(ship.cells[j])
      }
    }
    for (let i = 0; i < state.playerShips.length; i += 1) {
      const ship = state.playerShips[i]
      if (isShipSunk(state.enemyShots, ship)) continue
      const length = ship.cells.length
      for (let horizontal = 0; horizontal <= 1; horizontal += 1) {
        for (let origin = 0; origin < CELLS; origin += 1) {
          const cells = shipCells(origin, length, horizontal === 1)
          if (!cells) continue
          let legal = true
          for (let j = 0; j < cells.length; j += 1) {
            const cell = cells[j]
            if (state.enemyShots[cell] === 1 || blocked.has(cell)) {
              legal = false
              break
            }
          }
          if (!legal) continue
          for (let j = 0; j < cells.length; j += 1) scores[cells[j]] += 1
        }
      }
    }
    return scores
  }

  function chooseBestDensity(state, candidates, scores) {
    let best = []
    let bestScore = -1
    for (let i = 0; i < candidates.length; i += 1) {
      const cell = candidates[i]
      const score = scores[cell]
      if (score > bestScore) {
        bestScore = score
        best = [cell]
      } else if (score === bestScore) {
        best.push(cell)
      }
    }
    return pickRandom(state, best)
  }

  function unknownCells(state) {
    const cells = []
    for (let cell = 0; cell < CELLS; cell += 1) if (state.enemyShots[cell] === 0) cells.push(cell)
    return cells
  }

  /** Pick the AI's next shot. Advances `state.rng`; does not fire. */
  function aiChooseCell(state) {
    if (!state || state.phase !== 'battle') return null
    const unknown = unknownCells(state)
    if (unknown.length === 0) return null
    if (state.difficulty === 'easy') return pickRandom(state, unknown)
    const hits = unresolvedHitCells(state)
    if (state.difficulty === 'normal') {
      if (hits.length > 0) {
        const line = lineContinuationCells(state)
        if (line.length > 0) return pickRandom(state, line)
        const neighbours = adjacentUnknownCells(state)
        if (neighbours.length > 0) return pickRandom(state, neighbours)
      }
      return pickRandom(state, unknown)
    }
    // hard: hunt/target + probability density
    const scores = densityMap(state)
    if (hits.length > 0) {
      const neighbours = adjacentUnknownCells(state)
      if (neighbours.length > 0) return chooseBestDensity(state, neighbours, scores)
    }
    return chooseBestDensity(state, unknown, scores)
  }

  function aiFire(state) {
    if (!state || state.phase !== 'battle') return { ok: false, reason: 'phase' }
    if (state.turn !== 'enemy') return { ok: false, reason: 'turn' }
    const cell = aiChooseCell(state)
    if (cell === null) return { ok: false, reason: 'nomove' }
    return fireAtSide(state, 'enemy', cell)
  }

  function aiTurn(state) {
    return aiFire(state)
  }

  // ---------------------------------------------------------------------------
  // Save / restore
  // ---------------------------------------------------------------------------

  function sanitizeShots(raw) {
    if (!Array.isArray(raw) || raw.length !== CELLS) return null
    const shots = new Array(CELLS)
    for (let i = 0; i < CELLS; i += 1) {
      const value = raw[i]
      if (value !== 0 && value !== 1 && value !== 2) return null
      shots[i] = value
    }
    return shots
  }

  function sanitizeFleet(raw, allowAdjacent, mode) {
    if (mode === 'empty') {
      if (!Array.isArray(raw) || raw.length !== 0) return null
      return []
    }
    if (!Array.isArray(raw)) return null
    const maxLength = mode === 'partial' ? SHIPS.length : SHIPS.length
    if (raw.length > maxLength) return null
    const ships = []
    const occupied = new Set()
    for (let i = 0; i < raw.length; i += 1) {
      const def = SHIPS[i]
      const entry = raw[i]
      if (!entry || typeof entry !== 'object') return null
      if (entry.key !== def.key) return null
      const cells = normalizeShipCells(entry.cells, def.len)
      if (!cells) return null
      for (let j = 0; j < cells.length; j += 1) {
        if (occupied.has(cells[j])) return null
        occupied.add(cells[j])
      }
      ships.push({ key: def.key, cells: cells })
    }
    if (allowAdjacent !== true) {
      for (let i = 0; i < ships.length; i += 1) {
        for (let j = i + 1; j < ships.length; j += 1) {
          if (shipsAdjacent(ships[i].cells, ships[j].cells)) return null
        }
      }
    }
    return ships
  }

  function shotsConsistent(shots, ships) {
    for (let cell = 0; cell < CELLS; cell += 1) {
      const value = shots[cell]
      if (value === 0) continue
      const ship = findShipAt(ships, cell)
      if (value === 2 && !ship) return false
      if (value === 1 && ship) return false
    }
    return true
  }

  /**
   * Validate + normalize a saved state. Returns null for anything inconsistent
   * (the caller then starts a fresh game) — this must never throw.
   */
  function sanitizeState(raw) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      if (raw.schemaVersion !== SCHEMA_VERSION) return null
      const phase = raw.phase
      if (phase !== 'place' && phase !== 'battle' && phase !== 'over') return null
      // `mode` was added after v1 shipped: an older save without it is a solo game.
      const mode = raw.mode === undefined ? 'ai' : raw.mode
      if (mode !== 'ai' && mode !== 'duo') return null
      const placeTurn = raw.placeTurn === undefined ? 'player' : raw.placeTurn
      if (placeTurn !== 'player' && placeTurn !== 'enemy') return null
      if (mode === 'ai' && placeTurn !== 'player') return null
      const handoff = raw.handoff === undefined || raw.handoff === null ? null : raw.handoff
      if (handoff !== null && handoff !== 'pass' && handoff !== 'curtain') return null
      if (mode === 'ai' && handoff !== null) return null
      if (handoff === 'pass' && phase !== 'battle') return null
      if (raw.allowAdjacent !== true && raw.allowAdjacent !== false) return null
      const allowAdjacent = raw.allowAdjacent === true
      if (DIFFICULTIES.indexOf(raw.difficulty) < 0) return null
      const difficulty = raw.difficulty
      if (!isUint32(raw.seed) || !isUint32(raw.rng)) return null
      const orientation = raw.orientation === 'h' || raw.orientation === 'v' ? raw.orientation : null
      if (!orientation) return null
      const playerShips = sanitizeFleet(raw.playerShips, allowAdjacent, phase === 'place' ? 'partial' : 'full')
      if (!playerShips) return null
      const enemyFleetMode = phase === 'place' ? (mode === 'duo' ? 'partial' : 'empty') : 'full'
      const enemyShips = sanitizeFleet(raw.enemyShips, allowAdjacent, enemyFleetMode)
      if (!enemyShips) return null
      const playerShots = sanitizeShots(raw.playerShots)
      if (!playerShots) return null
      const enemyShots = sanitizeShots(raw.enemyShots)
      if (!enemyShots) return null
      if (!shotsConsistent(playerShots, enemyShips)) return null
      if (!shotsConsistent(enemyShots, playerShips)) return null
      const turn = raw.turn === 'player' || raw.turn === 'enemy' ? raw.turn : null
      if (!turn) return null
      const winner = raw.winner === null || raw.winner === undefined ? null : raw.winner
      if (winner !== null && winner !== 'player' && winner !== 'enemy') return null
      if (!Number.isInteger(raw.placementIndex) || raw.placementIndex < 0 || raw.placementIndex > SHIPS.length) {
        return null
      }
      const placementIndex = raw.placementIndex
      let endReason = raw.endReason === 'sunk' || raw.endReason === 'surrender' ? raw.endReason : null
      if (phase === 'place') {
        const placeFleet = mode === 'duo' && placeTurn === 'enemy' ? enemyShips : playerShips
        if (placementIndex !== placeFleet.length) return null
        if (mode === 'duo' && placeTurn === 'enemy') {
          // Player B places second: player A's fleet is already complete.
          if (playerShips.length !== SHIPS.length) return null
        } else if (enemyShips.length !== 0) {
          return null
        }
        if (winner !== null) return null
        if (turn !== 'player') return null
        if (countShotCells(playerShots) !== 0 || countShotCells(enemyShots) !== 0) return null
        endReason = null
      } else {
        if (playerShips.length !== SHIPS.length || enemyShips.length !== SHIPS.length) return null
        if (placementIndex !== SHIPS.length) return null
      }
      const playerFired = countShotCells(playerShots)
      const enemyFired = countShotCells(enemyShots)
      if (playerFired !== enemyFired && playerFired !== enemyFired + 1) return null
      const playerFleetSunk = allSunk(enemyShots, playerShips)
      const enemyFleetSunk = allSunk(playerShots, enemyShips)
      if (phase === 'battle') {
        if (winner !== null) return null
        if (playerFleetSunk || enemyFleetSunk) return null
        endReason = null
        if (playerFired === enemyFired + 1) {
          if (turn !== 'enemy') return null
        } else if (turn !== 'player') return null
      } else if (phase === 'over') {
        if (winner === null) return null
        if (winner === 'player') {
          if (enemyFleetSunk) {
            if (playerFleetSunk) return null
            if (playerFired !== enemyFired + 1) return null
            if (endReason !== 'sunk') return null
          } else {
            // Only duo games can end with the human/A side winning by
            // resignation: B surrenders while A's fleet is still afloat.
            if (mode !== 'duo') return null
            if (endReason !== 'surrender') return null
            if (playerFired !== enemyFired) return null
          }
        } else {
          if (playerFleetSunk) {
            if (endReason !== 'sunk') return null
          } else {
            if (endReason !== 'surrender') return null
          }
          if (playerFired !== enemyFired) return null
        }
      }
      return {
        schemaVersion: SCHEMA_VERSION,
        seed: raw.seed,
        rng: raw.rng,
        mode: mode,
        phase: phase,
        allowAdjacent: allowAdjacent,
        difficulty: difficulty,
        orientation: orientation,
        placementIndex: placementIndex,
        placeTurn: placeTurn,
        handoff: handoff,
        playerShips: playerShips,
        enemyShips: enemyShips,
        playerShots: playerShots,
        enemyShots: enemyShots,
        turn: turn,
        winner: winner,
        endReason: endReason,
      }
    } catch (error) {
      return null
    }
  }

  function serializeState(state) {
    return {
      schemaVersion: SCHEMA_VERSION,
      seed: state.seed,
      rng: state.rng,
      mode: state.mode === 'duo' ? 'duo' : 'ai',
      phase: state.phase,
      allowAdjacent: state.allowAdjacent === true,
      difficulty: state.difficulty,
      orientation: state.orientation,
      placementIndex: state.placementIndex,
      placeTurn: state.placeTurn === 'enemy' ? 'enemy' : 'player',
      handoff: state.handoff === 'pass' || state.handoff === 'curtain' ? state.handoff : null,
      playerShips: cloneShips(state.playerShips),
      enemyShips: cloneShips(state.enemyShips),
      playerShots: state.playerShots.slice(),
      enemyShots: state.enemyShots.slice(),
      turn: state.turn,
      winner: state.winner,
      endReason: state.endReason,
    }
  }

  function loadSavedState() {
    if (typeof window === 'undefined' || !window.localStorage) return null
    try {
      const raw = window.localStorage.getItem(STORE_KEY)
      if (!raw) return null
      return sanitizeState(JSON.parse(raw))
    } catch (error) {
      return null
    }
  }

  function saveStateToStorage(state) {
    if (typeof window === 'undefined' || !window.localStorage) return false
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(serializeState(state)))
      return true
    } catch (error) {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Responsive layout (measured from the board area, not window.innerWidth)
  // ---------------------------------------------------------------------------

  function estimateFleetHeight(boardPx) {
    // Compact chips (just the length number) are used below 190px boards;
    // full-name chips otherwise. Keep this conservative so the measured panel
    // never overflows the board area.
    const compact = boardPx < 190
    // Full-name chips ("航空母舰 · 5") need ~84px; compact ones only the number.
    const chipWidth = compact ? 26 : 84
    const available = Math.max(1, boardPx + PANEL_PAD * 2)
    const perRow = Math.max(1, Math.floor(available / chipWidth))
    const rows = Math.ceil(SHIPS.length / perRow)
    return rows * 18 + (rows - 1) * 4 + 2
  }

  function computeLayout(width, height, panels) {
    // `panels: 1` is used while a duo player places a fleet: only that board is
    // on screen, so it may use the whole stage instead of half of it.
    const panelCount = panels === 1 ? 1 : 2
    let w = 0
    let h = 0
    try {
      w = Number(width)
      h = Number(height)
    } catch (error) {
      w = 0
      h = 0
    }
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < MIN_WIDTH || h < MIN_HEIGHT) {
      return {
        width: Number.isFinite(w) ? Math.max(0, w) : 0,
        height: Number.isFinite(h) ? Math.max(0, h) : 0,
        sideBySide: false,
        tooSmall: true,
        boardPx: 0,
        cellPx: 0,
        shipListH: 0,
      }
    }
    const sideBySide = w >= 680
    let fleetH = 42
    let board = 0
    for (let pass = 0; pass < 4; pass += 1) {
      let next = 0
      if (panelCount === 1) {
        const widthLimit = w - ROOT_PAD * 2 - 2 * PANEL_PAD
        const heightLimit = h - ROOT_PAD * 2 - PANEL_HEADER_H - fleetH - 2 * PANEL_PAD - 10
        next = Math.min(widthLimit, heightLimit)
      } else if (sideBySide) {
        const widthLimit = (w - ROOT_PAD * 2 - BOARD_GAP - 4 * PANEL_PAD) / 2
        const heightLimit = h - ROOT_PAD * 2 - PANEL_HEADER_H - fleetH - 2 * PANEL_PAD - 10
        next = Math.min(widthLimit, heightLimit)
      } else {
        const widthLimit = w - ROOT_PAD * 2 - 2 * PANEL_PAD
        const heightLimit = (h - ROOT_PAD * 2 - BOARD_GAP - 2 * (PANEL_HEADER_H + fleetH + 2 * PANEL_PAD + 8)) / 2
        next = Math.min(widthLimit, heightLimit)
      }
      board = Math.floor(next)
      const wanted = estimateFleetHeight(Math.max(1, board))
      if (wanted === fleetH) break
      fleetH = wanted
    }
    const boardPx = Math.max(0, board)
    const tooSmall = boardPx < MIN_BOARD_PX
    return {
      width: w,
      height: h,
      sideBySide: sideBySide,
      tooSmall: tooSmall,
      boardPx: tooSmall ? 0 : boardPx,
      cellPx: tooSmall ? 0 : boardPx / BOARD,
      shipListH: fleetH,
    }
  }

  /**
   * Rough chrome height (header + settings + status) used only for the very
   * first frame and for recovering when a resize reflow momentarily removes the
   * measured body element. Conservative on purpose; a re-measure follows.
   */
  function estimateChromeHeight(width) {
    return width >= 430 ? 93 : 116
  }

  // ---------------------------------------------------------------------------
  // Controller
  //
  // Owns the game state, persistence, layout measurement and the AI timer.
  // React only renders the emitted view and forwards user actions back here;
  // this keeps the game drivable from headless tests.
  // ---------------------------------------------------------------------------

  function createGame(host, options) {
    const opts = options || {}
    const onState = typeof opts.onState === 'function' ? opts.onState : function () {}
    const onError = typeof opts.onError === 'function' ? opts.onError : function () {}
    let state = loadSavedState()
    let freshStart = false
    if (!state) {
      state = newGameState(randomSeed())
      freshStart = true
    }
    let layoutCache = computeLayout(0, 0)
    let lastPanelCount = -1
    let viewCache = null
    let message = ''
    let messageTone = 'info'
    let messageTimer = null
    let aiTimer = null
    let aiPending = false
    let lastShot = null
    let hover = null
    let disposed = false
    let resizing = false
    let rafId = null
    let observer = null
    let windowResizeHandler = null
    let visibilityHandler = null
    let rootSize = { width: 0, height: 0 }
    let errorLimit = 0
    let refineBudget = 3

    function getDpr() {
      try {
        return typeof window !== 'undefined' && Number(window.devicePixelRatio) > 0 ? Number(window.devicePixelRatio) : 1
      } catch (error) {
        return 1
      }
    }

    function rectOf(element) {
      try {
        if (!element || typeof element.getBoundingClientRect !== 'function') return { width: 0, height: 0 }
        const rect = element.getBoundingClientRect()
        return { width: Number(rect.width) || 0, height: Number(rect.height) || 0 }
      } catch (error) {
        return { width: 0, height: 0 }
      }
    }

    function findChild(selector) {
      try {
        if (!host || typeof host.querySelector !== 'function') return null
        return host.querySelector(selector)
      } catch (error) {
        return null
      }
    }

    function panelsForLayout() {
      return isDuo(state) && state.phase === 'place' ? 1 : 2
    }

    function measure() {
      const rootRect = rectOf(host)
      rootSize = rootRect
      const bodyEl = findChild('[data-dsh-body]')
      let bodyWidth = rootRect.width
      let bodyHeight = rootRect.height
      let usedFallback = false
      if (bodyEl) {
        const bodyRect = rectOf(bodyEl)
        bodyWidth = bodyRect.width
        bodyHeight = bodyRect.height
      } else {
        // The body element is missing on the very first frame (the component
        // renders a placeholder before the first state arrives) and on the
        // too-small placeholder. Estimate the chrome so the first real layout
        // is usable instead of flashing "window too small"; a re-measure runs
        // on the next frame once the real body exists.
        usedFallback = true
        bodyHeight = Math.max(0, rootRect.height - estimateChromeHeight(rootRect.width))
      }
      const layout = computeLayout(bodyWidth, bodyHeight, panelsForLayout())
      if (rootRect.width < MIN_WIDTH || rootRect.height < MIN_HEIGHT) layout.tooSmall = true
      layout.usedFallback = usedFallback
      layout.canRefine = false
      if (layout.tooSmall) {
        // A resize can momentarily measure the old side-by-side body inside a
        // narrower stage and land just below the minimum; if the stage itself
        // could still fit a stacked layout, schedule one more measurement after
        // the re-render instead of getting stuck on the too-small screen.
        const potential = computeLayout(
          rootRect.width,
          Math.max(0, rootRect.height - estimateChromeHeight(rootRect.width)),
          panelsForLayout(),
        )
        if (!potential.tooSmall) layout.canRefine = true
      }
      return layout
    }

    function reportError(error) {
      if (errorLimit > 8) return
      errorLimit += 1
      try {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[dsh-game-battleship]', error)
        }
      } catch (logError) {
        // ignore
      }
      try {
        onError('游戏出错了，点「重新开始」再试一次。')
      } catch (callbackError) {
        // ignore
      }
    }

    function persist() {
      try {
        saveStateToStorage(state)
      } catch (error) {
        // storage is best-effort; keep playing in memory
      }
    }

    function setMessage(text, tone) {
      message = text ? String(text) : ''
      messageTone = tone || 'info'
      if (messageTimer) {
        clearTimeout(messageTimer)
        messageTimer = null
      }
      if (message) {
        messageTimer = setTimeout(function () {
          messageTimer = null
          message = ''
          messageTone = 'info'
          emit()
        }, MESSAGE_MS)
      }
    }

    function isHidden() {
      try {
        return typeof document !== 'undefined' && (document.hidden === true || document.visibilityState === 'hidden')
      } catch (error) {
        return false
      }
    }

    function shipView(ship, shots) {
      const def = SHIP_BY_KEY[ship.key]
      return {
        key: ship.key,
        name: def ? def.name : ship.key,
        short: def ? def.short : ship.key,
        len: ship.cells.length,
        cells: ship.cells.slice(),
        sunk: isShipSunk(shots, ship),
      }
    }

    function sideLabel(side) {
      return SIDE_LABELS[side] || SIDE_LABELS.player
    }

    function statusText(layout) {
      if (layout.tooSmall) return '窗口太小'
      const duo = isDuo(state)
      if (state.phase === 'place') {
        const side = placingSide(state)
        if (duo && state.handoff) return '请把设备交给 ' + sideLabel(side) + '，准备布阵'
        const who = duo ? sideLabel(side) + ' ' : ''
        const def = currentShipDef(state)
        if (def) {
          return who + '布阵：放置「' + def.name + '」（' + def.len + ' 格）· 点击海域放置，R 键旋转'
        }
        return duo ? who + '布阵完成，点「完成布阵」' : '布阵完成，点「开始」开战'
      }
      if (state.phase === 'over') {
        if (duo) {
          if (state.endReason === 'surrender') return sideLabel(state.winner) + ' 获胜（对方投降）'
          return sideLabel(state.winner) + ' 获胜：对方 5 艘舰船全部被击沉'
        }
        if (state.winner === 'player') return '胜利！敌方 5 艘舰船全部被击沉'
        if (state.endReason === 'surrender') return '你已投降，本局结束'
        return '失败：你的舰队被全部击沉'
      }
      if (duo) {
        if (state.handoff === 'pass') {
          return sideLabel(otherSide(state.turn)) + ' 本回合结束，点「交给 ' + sideLabel(state.turn) + '」'
        }
        if (state.handoff === 'curtain') return '请把设备交给 ' + sideLabel(state.turn) + '，轮到其开火'
        return sideLabel(state.turn) + ' 的回合：点击对方海域开火'
      }
      return state.turn === 'player' ? '你的回合：点击敌方海域开火' : '敌方思考中…'
    }

    function buildView() {
      const layout = layoutCache
      const duo = isDuo(state)
      const placement = state.phase === 'place'
      // Whose eyes are we looking through? Solo: always the human's (the AI turn
      // must not flip the boards). Duo: the fleet being placed, then whoever's
      // turn it is — the other fleet stays hidden behind the hand-off curtain.
      const ownSide = viewSideOf(state)
      const oppSide = otherSide(ownSide)
      const ownShips = shipsForSide(state, ownSide)
      const oppShips = shipsForSide(state, oppSide)
      const ownShots = shotsAtSide(state, ownSide)
      const oppShots = shotsAtSide(state, oppSide)
      const ownSunkSet = new Set(sunkKeys(state, ownSide))
      const oppSunkSet = new Set(sunkKeys(state, oppSide))

      let previewCells = []
      let previewValid = false
      if (placement && hover !== null && Number.isInteger(hover)) {
        const preview = canPlaceCurrent(state, hover, state.orientation)
        if (preview.cells) previewCells = preview.cells
        previewValid = preview.ok
      }
      const previewSet = new Set(previewCells)

      const playerCells = []
      for (let cell = 0; cell < CELLS; cell += 1) {
        const ship = findShipAt(ownShips, cell)
        const shot = ownShots[cell]
        const sunk = ship ? ownSunkSet.has(ship.key) : false
        playerCells.push({
          cell: cell,
          row: cellRow(cell),
          col: cellCol(cell),
          ship: ship ? ship.key : null,
          shipName: ship ? pluralShipName(ship.key) : null,
          sunk: sunk,
          shotCode: shot,
          shot: sunk ? 'sunk' : shot === 2 ? 'hit' : shot === 1 ? 'miss' : 'none',
          preview: previewSet.has(cell),
          previewValid: previewValid,
          last: lastShot !== null && lastShot.side === oppSide && lastShot.cell === cell,
        })
      }

      const enemyCells = []
      for (let cell = 0; cell < CELLS; cell += 1) {
        const ship = findShipAt(oppShips, cell)
        const shot = oppShots[cell]
        const sunk = !!(ship && shot === 2 && oppSunkSet.has(ship.key))
        enemyCells.push({
          cell: cell,
          row: cellRow(cell),
          col: cellCol(cell),
          ship: sunk && ship ? ship.key : null,
          shipName: sunk && ship ? pluralShipName(ship.key) : null,
          sunk: sunk,
          shotCode: shot,
          shot: sunk ? 'sunk' : shot === 2 ? 'hit' : shot === 1 ? 'miss' : 'none',
          preview: false,
          previewValid: false,
          last: lastShot !== null && lastShot.side === ownSide && lastShot.cell === cell,
        })
      }

      const current = currentShipDef(state)
      const fleet = placedShips(state)
      const shipDock = []
      if (placement) {
        for (let i = 0; i < SHIPS.length; i += 1) {
          const def = SHIPS[i]
          shipDock.push({
            key: def.key,
            name: def.name,
            short: def.short,
            len: def.len,
            placed: i < fleet.length,
            current: i === fleet.length,
            sunk: false,
          })
        }
      }
      const playerShotsFired = countShotCells(state.playerShots)
      const enemyShotsFired = countShotCells(state.enemyShots)
      const aiThinking = !duo && state.phase === 'battle' && state.turn === 'enemy'
      const handoffSide = state.handoff === 'curtain'
        ? (placement ? placingSide(state) : state.turn)
        : null
      return {
        width: layout.width,
        height: layout.height,
        rootWidth: rootSize.width,
        rootHeight: rootSize.height,
        dpr: getDpr(),
        tooSmall: layout.tooSmall,
        layout: layout,
        mode: duo ? 'duo' : 'ai',
        duo: duo,
        phase: state.phase,
        turn: state.turn,
        winner: state.winner,
        endReason: state.endReason,
        difficulty: state.difficulty,
        allowAdjacent: state.allowAdjacent === true,
        orientation: state.orientation,
        handoff: state.handoff || null,
        handoffSide: handoffSide,
        handoffLabel: handoffSide ? sideLabel(handoffSide) : '',
        ownSide: ownSide,
        oppSide: oppSide,
        ownLabel: sideLabel(ownSide),
        oppLabel: sideLabel(oppSide),
        nextLabel: sideLabel(state.turn),
        showOpponentPanel: !(duo && placement),
        playerShips: ownShips.map(function (ship) {
          return shipView(ship, ownShots)
        }),
        shipDock: shipDock,
        enemyShips: oppShips.map(function (ship) {
          return shipView(ship, oppShots)
        }),
        playerCells: playerCells,
        enemyCells: enemyCells,
        currentShip: current ? { key: current.key, name: current.name, len: current.len } : null,
        placedCount: fleet.length,
        totalShips: SHIPS.length,
        canStart: placement && fleet.length === SHIPS.length && !state.handoff,
        canFire: state.phase === 'battle' && state.winner === null && !state.handoff &&
          (duo || state.turn === 'player'),
        aiThinking: aiThinking,
        hover: hover,
        previewValid: previewValid,
        lastShot: lastShot,
        message: message,
        messageTone: messageTone,
        stats: {
          playerFired: playerShotsFired,
          enemyFired: enemyShotsFired,
          playerHits: countHitCells(state.playerShots),
          enemyHits: countHitCells(state.enemyShots),
          enemySunk: oppSunkSet.size,
          playerSunk: ownSunkSet.size,
          enemyRemaining: SHIPS.length - oppSunkSet.size,
          playerRemaining: SHIPS.length - ownSunkSet.size,
        },
        statusText: statusText(layout),
      }
    }

    function emit() {
      if (disposed) return
      try {
        // Duo placement shows a single board, so the stage can hold a bigger
        // one; re-measure whenever that changes (enter/leave placement, mode).
        const panels = panelsForLayout()
        if (panels !== lastPanelCount) {
          lastPanelCount = panels
          layoutCache = measure()
        }
        viewCache = buildView()
        onState(viewCache)
      } catch (error) {
        reportError(error)
      }
    }

    function reasonText(reason) {
      switch (reason) {
        case 'out':
          return '超出海域边界'
        case 'overlap':
          return '与已有舰船重叠'
        case 'adjacent':
          return '不能与其它舰船相邻（含斜向）'
        case 'phase':
          return '当前阶段不能这么做'
        case 'fleet':
          return '舰队尚未布阵完成'
        case 'turn':
          return '还没轮到你'
        case 'range':
          return '这一格不在海域内'
        case 'fired':
          return '这一格已经打过了'
        case 'empty':
          return '还没有放置舰船'
        case 'nomove':
          return '没有可射击的格子'
        default:
          return '操作无法完成'
      }
    }

    function shotMessage(result, shipKey, side) {
      const name = shipKey ? pluralShipName(shipKey) : ''
      if (side === 'player') {
        if (result === 'win') return { text: '击沉「' + name + '」！敌方舰队全灭，你赢了！', tone: 'good' }
        if (result === 'sunk') return { text: '击沉「' + name + '」！', tone: 'good' }
        if (result === 'hit') return { text: '命中！', tone: 'good' }
        return { text: '未命中…', tone: 'info' }
      }
      if (result === 'win') return { text: '你的「' + name + '」被击沉，舰队全灭，你输了…', tone: 'bad' }
      if (result === 'sunk') return { text: '你的「' + name + '」被击沉！', tone: 'warn' }
      if (result === 'hit') return { text: '敌方命中了你的「' + name + '」', tone: 'warn' }
      return { text: '敌方未命中', tone: 'info' }
    }

    function duoShotMessage(result, shipKey) {
      const name = shipKey ? pluralShipName(shipKey) : ''
      if (result === 'win') return { text: '击沉「' + name + '」！对方舰队全灭，你赢了！', tone: 'good' }
      if (result === 'sunk') return { text: '击沉「' + name + '」！', tone: 'good' }
      if (result === 'hit') return { text: '命中！', tone: 'good' }
      return { text: '未命中…', tone: 'info' }
    }

    function clearAITimer() {
      if (aiTimer) {
        clearTimeout(aiTimer)
        aiTimer = null
      }
    }

    function scheduleAI() {
      clearAITimer()
      if (disposed || isDuo(state)) return
      if (state.phase !== 'battle' || state.turn !== 'enemy') return
      if (isHidden()) {
        aiPending = true
        return
      }
      aiPending = false
      aiTimer = setTimeout(runAI, AI_DELAY_MS)
    }

    function runAI() {
      aiTimer = null
      if (disposed) return
      if (isHidden()) {
        aiPending = true
        return
      }
      let result = null
      try {
        result = aiFire(state)
      } catch (error) {
        reportError(error)
        return
      }
      if (!result || !result.ok) {
        if (result && result.reason === 'turn') return
        emit()
        return
      }
      lastShot = { cell: result.cell, side: 'enemy' }
      const rendered = shotMessage(result.result, result.shipKey, 'enemy')
      setMessage(rendered.text, rendered.tone)
      persist()
      if (state.phase === 'battle' && state.turn === 'enemy') scheduleAI()
      emit()
    }

    function onVisibilityChange() {
      try {
        if (isHidden()) {
          persist()
          if (aiTimer) {
            clearAITimer()
            aiPending = true
          }
        } else if (aiPending && state.phase === 'battle' && state.turn === 'enemy') {
          aiPending = false
          scheduleAI()
          emit()
        }
      } catch (error) {
        reportError(error)
      }
    }

    function scheduleMeasure() {
      if (disposed || resizing) return
      resizing = true
      const run = function () {
        resizing = false
        if (disposed) return
        try {
          layoutCache = measure()
          emit()
          if (refineBudget > 0 && (layoutCache.usedFallback || layoutCache.canRefine)) {
            refineBudget -= 1
            scheduleMeasure()
          }
        } catch (error) {
          reportError(error)
        }
      }
      try {
        if (typeof requestAnimationFrame === 'function') {
          rafId = requestAnimationFrame(run)
        } else {
          run()
        }
      } catch (error) {
        run()
      }
    }

    // ----- user actions ------------------------------------------------------

    function rotate() {
      if (state.phase !== 'place') return
      const result = rotateOrientation(state)
      if (!result.ok) return
      setMessage('方向：' + (state.orientation === 'h' ? '横向' : '纵向'), 'info')
      persist()
      emit()
    }

    function randomize() {
      if (state.phase !== 'place' || state.handoff) return
      const result = randomizePlayerFleet(state)
      if (!result.ok) {
        setMessage(reasonText(result.reason), 'warn')
        emit()
        return
      }
      setMessage(isDuo(state) ? '已随机布阵，点「完成布阵」' : '已随机布阵，点「开始」开战', 'info')
      persist()
      emit()
    }

    function undoPlacement() {
      if (state.phase !== 'place' || state.handoff) return
      const result = removeLastShip(state)
      if (!result.ok) {
        setMessage(reasonText(result.reason), 'info')
        emit()
        return
      }
      setMessage('已撤销「' + pluralShipName(result.shipKey) + '」', 'info')
      persist()
      emit()
    }

    function start() {
      if (state.phase !== 'place') return
      if (state.handoff) return
      const result = startBattle(state)
      if (!result.ok) {
        setMessage('无法开始：' + reasonText(result.reason), 'warn')
        emit()
        return
      }
      lastShot = null
      if (isDuo(state)) {
        if (result.next === 'place') {
          setMessage(sideLabel('player') + ' 布阵完成', 'info')
        } else {
          setMessage('双方布阵完成，' + sideLabel('player') + ' 先手', 'good')
        }
      } else {
        setMessage('开战！你先手', 'good')
      }
      persist()
      emit()
    }

    function fire(cell) {
      if (state.phase !== 'battle') return
      if (state.handoff) return
      const side = isDuo(state) ? state.turn : 'player'
      if (state.turn !== side) return
      const result = fireAtSide(state, side, cell)
      if (!result.ok) {
        if (result.reason === 'fired') setMessage('这一格已经打过了', 'warn')
        else if (result.reason !== 'turn' && result.reason !== 'phase') setMessage(reasonText(result.reason), 'warn')
        emit()
        return
      }
      lastShot = { cell: result.cell, side: side }
      const rendered = isDuo(state)
        ? duoShotMessage(result.result, result.shipKey)
        : shotMessage(result.result, result.shipKey, 'player')
      setMessage(rendered.text, rendered.tone)
      persist()
      if (!isDuo(state) && state.phase === 'battle' && state.turn === 'enemy') {
        scheduleAI()
      }
      emit()
    }

    /** Duo: the shooter keeps the board until they hand the device over. */
    function passTurn() {
      const result = passDevice(state)
      if (!result.ok) return
      lastShot = null
      setMessage('请把设备交给 ' + sideLabel(state.turn), 'info')
      persist()
      emit()
    }

    /** Duo: the next player lifted the curtain. */
    function acknowledge() {
      const result = acknowledgeHandoff(state)
      if (!result.ok) return
      const side = state.phase === 'place' ? placingSide(state) : state.turn
      setMessage(sideLabel(side) + ' 继续', 'info')
      persist()
      emit()
    }

    function newGame() {
      clearAITimer()
      const previous = state
      state = newGameState(randomSeed(), previous.mode)
      state.allowAdjacent = previous.allowAdjacent === true
      state.difficulty = previous.difficulty
      hover = null
      lastShot = null
      message = ''
      messageTone = 'info'
      if (messageTimer) {
        clearTimeout(messageTimer)
        messageTimer = null
      }
      setMessage(isDuo(state) ? '新游戏：' + sideLabel('player') + ' 先布阵' : '新游戏：先布阵', 'info')
      persist()
      emit()
    }

    function restart() {
      const result = restartBattle(state)
      if (!result.ok) return
      clearAITimer()
      lastShot = null
      setMessage(
        isDuo(state) ? '已重开本局（舰队不变，清空射击），' + sideLabel('player') + ' 先手' : '已重开本局（舰队不变，清空射击）',
        'info',
      )
      persist()
      emit()
    }

    function surrenderGame() {
      const result = surrender(state)
      if (!result.ok) {
        setMessage(reasonText(result.reason), 'warn')
        emit()
        return
      }
      clearAITimer()
      if (isDuo(state)) {
        setMessage(sideLabel(result.side) + ' 投降，' + sideLabel(state.winner) + ' 获胜', 'bad')
      } else {
        setMessage('你已投降，本局结束', 'bad')
      }
      persist()
      emit()
    }

    function switchMode(mode) {
      if (MODES.indexOf(mode) < 0) return
      if ((state.mode === 'duo' ? 'duo' : 'ai') === mode) return
      clearAITimer()
      const previous = state
      state = newGameState(randomSeed(), mode)
      state.allowAdjacent = previous.allowAdjacent === true
      state.difficulty = previous.difficulty
      hover = null
      lastShot = null
      message = ''
      messageTone = 'info'
      if (messageTimer) {
        clearTimeout(messageTimer)
        messageTimer = null
      }
      setMessage(mode === 'duo' ? '已切换到双人：玩家 A 先布阵' : '已切换到单人：你先布阵', 'info')
      persist()
      emit()
    }

    function changeDifficulty(difficulty) {
      const result = setDifficulty(state, difficulty)
      if (!result.ok) return
      setMessage('难度：' + DIFFICULTY_LABELS[difficulty], 'info')
      persist()
      emit()
    }

    function toggleAdjacentSetting() {
      const result = toggleAdjacent(state)
      if (!result.ok) {
        setMessage(result.reason === 'adjacent' ? '已有相邻舰船，无法关闭「允许相邻」' : reasonText(result.reason), 'warn')
        emit()
        return
      }
      setMessage(state.allowAdjacent ? '已允许舰船相邻（含斜向）' : '已恢复：舰船不可相邻', 'info')
      persist()
      emit()
    }

    function hoverCell(cell) {
      if (state.phase !== 'place') return
      if (cell !== null && (!Number.isInteger(cell) || cell < 0 || cell >= CELLS)) return
      if (hover === cell) return
      hover = cell
      emit()
    }

    function clearHover() {
      if (hover === null) return
      hover = null
      if (state.phase === 'place') emit()
    }

    function clickCell(cell) {
      if (disposed) return
      try {
        if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return
        if (state.phase === 'place') {
          if (state.handoff) return
          const result = placeCurrent(state, cell, state.orientation)
          if (!result.ok) {
            setMessage(reasonText(result.reason), 'warn')
            emit()
            return
          }
          const def = SHIP_BY_KEY[result.shipKey]
          const fleet = placedShips(state)
          if (fleet.length === SHIPS.length) {
            setMessage(
              isDuo(state)
                ? '已放置「' + def.name + '」，布阵完成，点「完成布阵」'
                : '已放置「' + def.name + '」，布阵完成，点「开始」开战',
              'good',
            )
          } else {
            setMessage('已放置「' + def.name + '」', 'info')
          }
          persist()
          emit()
          return
        }
        if (state.phase === 'battle') fire(cell)
      } catch (error) {
        reportError(error)
      }
    }

    function destroy() {
      if (disposed) return
      clearAITimer()
      if (messageTimer) {
        clearTimeout(messageTimer)
        messageTimer = null
      }
      if (rafId !== null) {
        try {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
        } catch (error) {
          // ignore
        }
        rafId = null
      }
      if (observer) {
        try {
          observer.disconnect()
        } catch (error) {
          // ignore
        }
        observer = null
      }
      if (windowResizeHandler) {
        try {
          window.removeEventListener('resize', windowResizeHandler)
        } catch (error) {
          // ignore
        }
        windowResizeHandler = null
      }
      if (visibilityHandler) {
        try {
          if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('visibilitychange', visibilityHandler)
          }
        } catch (error) {
          // ignore
        }
        visibilityHandler = null
      }
      try {
        saveStateToStorage(state)
      } catch (error) {
        // ignore
      }
      disposed = true
      hover = null
      viewCache = null
    }

    // ----- lifecycle ---------------------------------------------------------

    try {
      layoutCache = measure()
    } catch (error) {
      layoutCache = computeLayout(0, 0)
    }
    try {
      if (freshStart) persist()
    } catch (error) {
      // ignore
    }
    try {
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(function () {
          refineBudget = 3
          scheduleMeasure()
        })
        observer.observe(host)
        const bodyEl = findChild('[data-dsh-body]')
        if (bodyEl && bodyEl !== host) observer.observe(bodyEl)
      }
    } catch (error) {
      observer = null
    }
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        windowResizeHandler = function () {
          refineBudget = 3
          scheduleMeasure()
        }
        window.addEventListener('resize', windowResizeHandler)
      }
    } catch (error) {
      windowResizeHandler = null
    }
    try {
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        visibilityHandler = onVisibilityChange
        document.addEventListener('visibilitychange', visibilityHandler)
      }
    } catch (error) {
      visibilityHandler = null
    }

    emit()
    if (refineBudget > 0 && (layoutCache.usedFallback || layoutCache.canRefine)) {
      refineBudget -= 1
      scheduleMeasure()
    }
    if (state.phase === 'battle' && state.turn === 'enemy') scheduleAI()

    return {
      // state / view
      getView: function () {
        return viewCache || buildView()
      },
      getState: function () {
        return state
      },
      // actions
      clickCell: clickCell,
      fire: fire,
      rotate: rotate,
      randomize: randomize,
      undoPlacement: undoPlacement,
      start: start,
      newGame: newGame,
      restart: restart,
      surrender: surrenderGame,
      setDifficulty: changeDifficulty,
      toggleAdjacent: toggleAdjacentSetting,
      setMode: switchMode,
      pass: passTurn,
      acknowledge: acknowledge,
      hoverCell: hoverCell,
      clearHover: clearHover,
      // lifecycle
      destroy: destroy,
      // test helpers (harmless in production)
      saveNow: function () {
        persist()
      },
      scheduleMeasure: function () {
        scheduleMeasure()
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Browser UI (DOM + React from the host module table)
  // ---------------------------------------------------------------------------

  const STYLE_TEXT = `
.dshbs-root {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  box-sizing: border-box;
  outline: none;
  user-select: none;
  -webkit-user-select: none;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2328);
  font: 13px/1.4 "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.dshbs-root * { box-sizing: border-box; }
.dshbs-header {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 6px 10px 2px;
}
.dshbs-titlewrap { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dshbs-title { font-weight: 700; font-size: 15px; letter-spacing: .02em; white-space: nowrap; }
.dshbs-sub {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #57606a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dshbs-spacer { flex: 1 1 auto; }
.dshbs-controls { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.dshbs-btn {
  font: inherit;
  font-size: 11.5px;
  line-height: 1;
  padding: 6px 9px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  background: var(--dsw-alias-bg-layer-2, #f1f3f5);
  color: var(--dsw-alias-label-primary, #1f2328);
  cursor: pointer;
  white-space: nowrap;
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.dshbs-btn:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l2, #b6bec8);
  background: var(--dsw-alias-interactive-bg-hover, #eceff2);
}
.dshbs-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, #dfe4e9); }
.dshbs-btn:disabled { opacity: .42; cursor: default; }
.dshbs-btn.is-active {
  border-color: var(--dsw-alias-brand-primary, #2f81f7);
  color: var(--dsw-alias-brand-primary, #2f81f7);
  background: var(--dsw-alias-bg-base, #ffffff);
  font-weight: 600;
}
.dshbs-btn--primary {
  background: var(--dsw-alias-brand-primary, #2f81f7);
  border-color: transparent;
  color: #ffffff;
  font-weight: 600;
}
.dshbs-btn--primary:hover:not(:disabled) {
  background: var(--dsw-alias-brand-primary, #2f81f7);
  border-color: transparent;
  filter: brightness(1.08);
}
.dshbs-settings {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  padding: 1px 10px 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #57606a);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #d0d7de);
}
.dshbs-settings-label { font-weight: 600; margin-right: 2px; }
.dshbs-settings-hint { opacity: .8; }
.dshbs-settings .dshbs-btn { padding: 4px 7px; font-size: 11px; }
.dshbs-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-wrap: wrap;
  align-content: center;
  justify-content: center;
  align-items: center;
  gap: 14px;
  padding: 8px;
  position: relative;
  overflow: hidden;
}
.dshbs-panel { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshbs-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
  height: 22px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #57606a);
  line-height: 16px;
  white-space: nowrap;
}
.dshbs-panel--player .dshbs-panel-head span:first-child { color: #1f7a9c; }
.dshbs-panel--enemy .dshbs-panel-head span:first-child { color: #a34a68; }
.dshbs-panel-head span:last-child { opacity: .85; font-weight: 400; }
.dshbs-board {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  grid-template-rows: repeat(10, 1fr);
  gap: 2px;
  padding: 4px;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .10), 0 3px 10px rgba(0, 0, 0, .16);
  touch-action: manipulation;
}
.dshbs-board--player { background: #0b2737; }
.dshbs-board--enemy { background: #2a1724; }
.dshbs-cell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
  overflow: hidden;
  background: #14425c;
  transition: background .1s ease, box-shadow .1s ease;
}
.dshbs-board--enemy .dshbs-cell { background: #3c2534; }
.dshbs-cell.is-ship { background: #5f8ea4; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .22); }
.dshbs-cell.is-miss { background: #1a4c66; }
.dshbs-board--enemy .dshbs-cell.is-miss { background: #472c3d; }
.dshbs-cell.is-hit { background: #d9822b; }
.dshbs-cell.is-sunk { background: #a63731; }
.dshbs-cell.is-sunk-ship { background: #8e2f2b; }
.dshbs-cell--clickable { cursor: pointer; }
.dshbs-board--enemy .dshbs-cell--clickable:hover { background: #5c3a4e; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .38); }
.dshbs-board--player .dshbs-cell--clickable:hover { background: #1d5b7c; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .38); }
.dshbs-cell.is-preview-ok { background: #2e8f63; box-shadow: inset 0 0 0 1px #7df0b0; }
.dshbs-cell.is-preview-bad { background: #8f3b3b; box-shadow: inset 0 0 0 1px #ff9a90; }
.dshbs-cell.is-last { box-shadow: inset 0 0 0 2px #ffd166; }
.dshbs-mark { color: #ffffff; font-weight: 700; line-height: 1; text-shadow: 0 1px 2px rgba(0, 0, 0, .45); }
.dshbs-dot {
  width: 32%;
  height: 32%;
  border-radius: 50%;
  background: rgba(226, 241, 250, .55);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .18) inset;
}
.dshbs-board--player .dshbs-cell.is-hit .dshbs-dot,
.dshbs-board--enemy .dshbs-cell.is-hit .dshbs-dot { display: none; }
.dshbs-fleet { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 20px; }
.dshbs-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  background: var(--dsw-alias-bg-layer-2, #f1f3f5);
  color: var(--dsw-alias-label-secondary, #57606a);
  white-space: nowrap;
}
.dshbs-chip.is-sunk { text-decoration: line-through; opacity: .5; }
.dshbs-chip.is-unplaced { opacity: .45; border-style: dashed; }
.dshbs-chip.is-current { border-color: var(--dsw-alias-brand-primary, #2f81f7); color: var(--dsw-alias-brand-primary, #2f81f7); font-weight: 600; }
.dshbs-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: #6f9fb5; }
.dshbs-panel--enemy .dshbs-chip-dot { background: #b26782; }
.dshbs-chip.is-sunk .dshbs-chip-dot { background: #c94f48; }
.dshbs-chip.is-current .dshbs-chip-dot { background: var(--dsw-alias-brand-primary, #2f81f7); }
.dshbs-fleet-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #8b949e); }
.dshbs-chip.is-compact { padding: 3px 4px; font-size: 10px; gap: 2px; }
.dshbs-status {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px 10px;
  padding: 5px 10px 7px;
  border-top: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #57606a);
  min-height: 28px;
}
.dshbs-status-text {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshbs-status-text.is-good { color: #1a7f37; }
.dshbs-status-text.is-warn { color: #b35900; }
.dshbs-status-text.is-bad { color: #cf222e; }
.dshbs-toast {
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshbs-toast.is-good { color: #1a7f37; }
.dshbs-toast.is-warn { color: #b35900; }
.dshbs-toast.is-bad { color: #cf222e; }
.dshbs-stats {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  opacity: .85;
}
.dshbs-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--dsw-alias-bg-mask-1, rgba(9, 12, 16, .38));
}
.dshbs-overlay-card {
  width: 100%;
  max-width: 340px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  text-align: center;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2328);
  box-shadow: 0 14px 44px rgba(0, 0, 0, .35);
}
.dshbs-overlay-title { font-size: 18px; font-weight: 700; }
.dshbs-overlay-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, #57606a); }
.dshbs-overlay-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 2px; }
.dshbs-curtain {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--dsw-alias-bg-base, #ffffff);
}
.dshbs-curtain-card {
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  text-align: center;
  padding: 18px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  background: var(--dsw-alias-bg-layer-2, #f1f3f5);
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dshbs-toosmall, .dshbs-error-card {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  padding: 16px;
  text-align: center;
  color: var(--dsw-alias-label-secondary, #57606a);
}
.dshbs-toosmall b, .dshbs-error-card b { color: var(--dsw-alias-label-primary, #1f2328); font-size: 14px; }
.dshbs-loading { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary, #57606a); }
/* 「规则」弹窗：与同系列其它游戏保持同一套几何与 token。 */
.dshbs-rules-mask {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45));
}
.dshbs-rules-card {
  width: min(560px, 100%);
  max-height: 86%;
  overflow: auto;
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-2, #f1f3f5);
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  color: var(--dsw-alias-label-primary, #1f2328);
  outline: none;
}
.dshbs-rules-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 18px;
  background: var(--dsw-alias-bg-layer-2, #f1f3f5);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #d0d7de);
}
.dshbs-rules-title { flex: 1; font-size: 15px; font-weight: 600; }
.dshbs-rules-close {
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8b949e);
  cursor: pointer;
  font-size: 22px;
  line-height: 1;
  padding: 0 4px;
  border-radius: 6px;
  font-family: inherit;
}
.dshbs-rules-body { padding: 2px 18px 20px; }
.dshbs-rules-body h3 {
  font-size: 12.5px;
  letter-spacing: 0.04em;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
  margin: 20px 0 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #d0d7de);
}
.dshbs-rules-body ul { margin: 8px 0; padding-left: 19px; }
.dshbs-rules-body li {
  font-size: 13px;
  line-height: 21px;
  color: var(--dsw-alias-label-secondary, #57606a);
  margin: 6px 0;
}
.dshbs-rules-tip {
  font-size: 12.5px;
  line-height: 19px;
  color: var(--dsw-alias-label-secondary, #57606a);
  background: var(--dsw-alias-interactive-bg-hover, #eceff2);
  border-left: 2px solid var(--dsw-alias-brand-primary, #2f81f7);
  border-radius: 0 7px 7px 0;
  padding: 9px 12px;
  margin: 10px 0;
}
`

  const MODULE_ID = '@local/dsh-game-battleship'

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    try {
      window.__ModuleLoader__.load({
        id: MODULE_ID,
        factory: function factory(require) {
          const React = require('react')
          const h = React.createElement

          function preventDefault(event) {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
          }

          function makeCellTitle(side, view, cell) {
            const prefix = side === 'player' ? '你的海域' : '敌方海域'
            const where = '第 ' + (cell.row + 1) + ' 行第 ' + (cell.col + 1) + ' 列'
            let stateText = '未知'
            if (cell.shot === 'miss') stateText = '未命中'
            else if (cell.shot === 'hit') stateText = '命中'
            else if (cell.shot === 'sunk') stateText = '击沉'
            else if (side === 'player' && cell.ship) stateText = view.phase === 'place' ? '你的舰船' : '你的舰船（未受击）'
            return prefix + where + ' · ' + stateText + (cell.shipName ? ' · ' + cell.shipName : '')
          }

          function renderCell(view, side, cell, act) {
            const layout = view.layout
            const classes = ['dshbs-cell', 'dshbs-cell--' + side]
            const clickable = side === 'enemy' ? view.canFire : view.phase === 'place'
            if (clickable) classes.push('dshbs-cell--clickable')
            if (cell.ship) classes.push('is-ship')
            if (cell.sunk) classes.push('is-sunk-ship')
            if (cell.shot !== 'none') classes.push('is-' + cell.shot)
            if (cell.preview) classes.push(cell.previewValid ? 'is-preview-ok' : 'is-preview-bad')
            if (cell.last) classes.push('is-last')
            const attrs = {
              key: cell.cell,
              className: classes.join(' '),
              'data-cell': String(cell.cell),
              'data-shot': cell.shot,
              'data-row': String(cell.row),
              'data-col': String(cell.col),
              role: 'gridcell',
              title: makeCellTitle(side, view, cell),
              style: { fontSize: Math.max(8, layout.cellPx * 0.55) + 'px' },
            }
            if (side === 'player') {
              attrs['data-ship'] = cell.ship || ''
              if (cell.sunk) attrs['data-sunk'] = '1'
            } else {
              if (cell.ship) attrs['data-ship'] = cell.ship
              if (cell.sunk) attrs['data-sunk'] = '1'
            }
            attrs.onClick = function () {
              if (clickable) act('cell', cell.cell)
            }
            if (side === 'player' && view.phase === 'place') {
              attrs.onMouseEnter = function () {
                act('hover', cell.cell)
              }
              attrs.onMouseLeave = function () {
                act('hover', null)
              }
              attrs.onFocus = function () {
                act('hover', cell.cell)
              }
              attrs.onBlur = function () {
                act('hover', null)
              }
            }
            let content = null
            if (cell.shot === 'hit' || cell.shot === 'sunk') {
              content = h('span', { className: 'dshbs-mark' }, '✕')
            } else if (cell.shot === 'miss') {
              content = h('span', { className: 'dshbs-dot' })
            }
            return h('div', attrs, content)
          }

          function renderChip(view, ship, compact, opts) {
            const options = opts || {}
            const label = compact ? String(ship.len) : ship.name + ' · ' + ship.len
            const classes = ['dshbs-chip']
            if (ship.sunk) classes.push('is-sunk')
            if (compact) classes.push('is-compact')
            if (options.placed === false) classes.push('is-unplaced')
            if (options.current) classes.push('is-current')
            let title = ship.name + '（' + ship.len + ' 格）' + (ship.sunk ? ' · 已击沉' : ' · 未击沉')
            if (options.current) title = ship.name + '（' + ship.len + ' 格）· 正在放置'
            else if (options.placed === false) title = ship.name + '（' + ship.len + ' 格）· 待放置'
            return h(
              'span',
              {
                key: ship.key,
                className: classes.join(' '),
                'data-ship-key': ship.key,
                'data-sunk': ship.sunk ? '1' : '0',
                'data-placed': options.placed === false ? '0' : '1',
                'data-current': options.current ? '1' : '0',
                title: title,
              },
              h('span', { className: 'dshbs-chip-dot' }),
              h('span', null, label),
            )
          }

          function renderPanel(view, side, act) {
            const layout = view.layout
            const isPlayer = side === 'player'
            const placement = view.phase === 'place'
            const cells = isPlayer ? view.playerCells : view.enemyCells
            const ships = isPlayer && placement ? view.shipDock : isPlayer ? view.playerShips : view.enemyShips
            const compact = layout.boardPx < 190
            const title = isPlayer
              ? view.duo ? '我方海域' : '你的海域'
              : view.duo ? '对方海域' : '敌方海域'
            let summary
            if (isPlayer) {
              summary = placement ? '已布阵 ' + view.placedCount + '/' + view.totalShips : '剩余 ' + view.stats.playerRemaining + '/' + view.totalShips
            } else if (view.phase === 'place') summary = '等待开战'
            else summary = '已击沉 ' + view.stats.enemySunk + '/' + view.totalShips
            if (view.duo) summary = (isPlayer ? view.ownLabel : view.oppLabel) + ' · ' + summary
            const panelStyle = { width: layout.boardPx + PANEL_PAD * 2 + 'px' }
            const boardStyle = { width: layout.boardPx + 'px', height: layout.boardPx + 'px' }
            const cellNodes = []
            for (let i = 0; i < cells.length; i += 1) cellNodes.push(renderCell(view, side, cells[i], act))
            const chipNodes = []
            for (let i = 0; i < ships.length; i += 1) {
              chipNodes.push(
                renderChip(
                  view,
                  ships[i],
                  compact,
                  isPlayer && placement ? { placed: ships[i].placed, current: ships[i].current } : null,
                ),
              )
            }
            if (!isPlayer && placement) {
              chipNodes.push(h('span', { key: 'waiting', className: 'dshbs-fleet-hint' }, '开战后显示敌方舰船状态'))
            }
            return h(
              'div',
              { className: 'dshbs-panel dshbs-panel--' + side, style: panelStyle },
              h(
                'div',
                { className: 'dshbs-panel-head' },
                h('span', null, title),
                h('span', null, summary),
              ),
              h(
                'div',
                {
                  className: 'dshbs-board dshbs-board--' + side,
                  style: boardStyle,
                  role: 'grid',
                  'aria-label': title,
                  'data-board': side,
                },
                cellNodes,
              ),
              h('div', { className: 'dshbs-fleet', style: { minHeight: layout.shipListH + 'px' } }, chipNodes),
            )
          }

          // Stable identity so React does not detach/re-attach the ref every render.
          function focusRulesCard(node) {
            if (node) node.focus()
          }

          function renderRules(onClose) {
            function li(key, children) {
              return h('li', { key: key }, children)
            }
            function b(key, text) {
              return h('b', { key: key }, text)
            }
            return h(
              'div',
              {
                key: 'rules',
                className: 'dshbs-rules-mask',
                onMouseDown: function (event) {
                  if (event.target === event.currentTarget) onClose()
                },
              },
              h(
                'div',
                {
                  ref: focusRulesCard,
                  tabIndex: -1,
                  className: 'dshbs-rules-card',
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-label': '海战棋规则',
                  onKeyDown: function (event) {
                    // Modal: swallow every key so the board behind does not react.
                    event.stopPropagation()
                    if (event.key === 'Escape') onClose()
                  },
                },
                h(
                  'div',
                  { className: 'dshbs-rules-head' },
                  h('span', { className: 'dshbs-rules-title' }, '海战棋 · 规则与操作'),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshbs-rules-close',
                      onClick: onClose,
                      'aria-label': '关闭',
                    },
                    '×',
                  ),
                ),
                h(
                  'div',
                  { className: 'dshbs-rules-body' },
                  h('h3', null, '一、目标'),
                  h(
                    'ul',
                    null,
                    li('a1', ['10×10 海域，双方各有 5 艘舰船：', b('a1a', '航母 5 格、战列舰 4 格、巡洋舰 3 格、潜艇 3 格、驱逐舰 2 格'), '。']),
                    li('a2', ['轮流炮击对方海域，', b('a2a', '先击沉对方全部 5 艘'), '的人获胜。']),
                  ),
                  h('h3', null, '二、布阵'),
                  h(
                    'ul',
                    null,
                    li('b1', ['点自己的海域放船；按 R 或点「旋转」换横竖；「随机布阵」一键摆完；「撤销」拿回上一艘。']),
                    li('b2', ['「允许相邻」控制舰船能不能挨着放：关掉更接近经典规则（船与船之间必须留空），开着更容易摆。']),
                    li('b3', ['摆完点「完成布阵」。单人模式还要先选难度：简单 / 普通 / 困难。']),
                  ),
                  h('h3', null, '三、开火'),
                  h(
                    'ul',
                    null,
                    li('c1', ['点对方海域的格子开炮：', b('c1a', '命中'), '显示 ✕ 并画出被打中的船身，落空显示一个圆点。']),
                    li('c2', ['一艘船的所有格子都被命中就算击沉，右侧舰队列表会把它划掉。']),
                    li('c3', ['沉掉对方全部 5 艘即结束，会显示胜负与命中率。']),
                  ),
                  h('h3', null, '四、双人同机'),
                  h(
                    'ul',
                    null,
                    li('d1', ['同一台设备轮流玩：A 先布阵 → 幕布交接 → B 布阵 → 开战。']),
                    li('d2', ['每回合结束点「交给 玩家 X」进入交接幕布；', b('d2a', '确认之前'), '看不到对方海域，也点不动棋盘。']),
                    li('d3', ['所以两个人可以放心把设备递来递去，不会提前看到对方的船在哪。']),
                  ),
                  h(
                    'div',
                    { className: 'dshbs-rules-tip' },
                    '别把五艘船挤成一团：挨着摆虽然省地方，但对手一旦命中，顺着一条线追下去就能连沉好几艘。命中之后沿着直线继续追，是效率最高的打法。',
                  ),
                ),
              ),
            )
          }

          function renderHeader(view, act) {
            function button(action, label, opts) {
              const options = opts || {}
              const className = 'dshbs-btn' +
                (options.primary ? ' dshbs-btn--primary' : '') +
                (options.active ? ' is-active' : '')
              return h(
                'button',
                {
                  key: action,
                  type: 'button',
                  className: className,
                  'data-action': action,
                  'aria-pressed': options.active ? 'true' : 'false',
                  disabled: options.disabled === true,
                  onClick: function () {
                    act(action)
                  },
                },
                label,
              )
            }
            const controls = []
            if (view.phase === 'place') {
              controls.push(button('rotate', view.layout.width < 430 ? '旋转' : '旋转 (R)'))
              controls.push(button('randomize', '随机布阵'))
              controls.push(button('place-undo', '撤销', { disabled: view.placedCount === 0 }))
              controls.push(button('start', view.duo ? '完成布阵' : '开始', { primary: true, disabled: !view.canStart }))
            } else {
              controls.push(button('restart', '重开'))
              if (view.phase === 'battle') {
                controls.push(
                  button('surrender', '投降', {
                    disabled: view.duo ? view.handoff !== null : view.turn === 'enemy',
                  }),
                )
              }
            }
            controls.push(button('rules', '📖 规则'))
            controls.push(button('new-game', '新游戏'))
            return h(
              'div',
              { className: 'dshbs-header', 'data-dsh-header': '' },
              h(
                'div',
                { className: 'dshbs-titlewrap' },
                h('span', { className: 'dshbs-title' }, '海战棋'),
                view.layout.width >= 560
                  ? h(
                      'span',
                      { className: 'dshbs-sub' },
                      view.duo ? '双人 · 同一台设备轮流 · 交棒后由对方确认' : '10×10 海域 · 5 艘舰船 · 先击沉对方全部舰船',
                    )
                  : null,
              ),
              h('div', { className: 'dshbs-spacer' }),
              h('div', { className: 'dshbs-controls' }, controls),
            )
          }

          function renderSettings(view, act) {
            function button(action, label, opts) {
              const options = opts || {}
              return h(
                'button',
                {
                  key: action,
                  type: 'button',
                  className: 'dshbs-btn' + (options.active ? ' is-active' : ''),
                  'data-action': action,
                  'aria-pressed': options.active ? 'true' : 'false',
                  disabled: options.disabled === true,
                  onClick: function () {
                    act(action)
                  },
                },
                label,
              )
            }
            const children = [h('span', { key: 'mode-label', className: 'dshbs-settings-label' }, '模式')]
            children.push(button('mode-ai', '单人', { active: view.mode === 'ai' }))
            children.push(button('mode-duo', '双人', { active: view.mode === 'duo' }))
            if (view.mode === 'ai') {
              children.push(h('span', { key: 'label', className: 'dshbs-settings-label' }, '难度'))
              for (let i = 0; i < DIFFICULTIES.length; i += 1) {
                const difficulty = DIFFICULTIES[i]
                children.push(
                  button('difficulty-' + difficulty, DIFFICULTY_LABELS[difficulty], {
                    active: view.difficulty === difficulty,
                  }),
                )
              }
            }
            children.push(
              button('toggle-adjacent', view.allowAdjacent ? '允许相邻：开' : '允许相邻：关', {
                active: view.allowAdjacent,
                disabled: view.phase !== 'place',
              }),
            )
            if (view.layout.width >= 520) {
              children.push(
                h(
                  'span',
                  { key: 'hint', className: 'dshbs-settings-hint' },
                  view.duo
                    ? '双人：同一台设备轮流，交回设备前请勿看对方海域'
                    : view.phase === 'place'
                      ? '默认舰船不可相邻（含斜向），可在开始前放开'
                      : '难度影响 AI 之后的选择；允许相邻仅在布阵阶段可调',
                ),
              )
            }
            return h('div', { className: 'dshbs-settings', 'data-dsh-settings': '' }, children)
          }

          function renderStatus(view, act) {
            const tone = view.messageTone
            const statusClass = 'dshbs-status-text' +
              (tone === 'good' ? ' is-good' : tone === 'warn' ? ' is-warn' : tone === 'bad' ? ' is-bad' : '')
            const children = [
              h(
                'span',
                { key: 'status', className: statusClass, 'data-status': '' },
                view.statusText,
              ),
              h(
                'span',
                {
                  key: 'toast',
                  className: 'dshbs-toast is-' + tone,
                  'data-message': '',
                  'data-tone': tone,
                },
                view.message || '',
              ),
            ]
            if (view.handoff === 'pass') children.push(renderPassBar(view, act))
            if (view.layout.width >= 520) {
              children.push(
                h(
                  'span',
                  { key: 'stats', className: 'dshbs-stats' },
                  view.duo
                    ? 'A ' + view.stats.playerFired + ' 发 / 命中 ' + view.stats.playerHits +
                      ' · B ' + view.stats.enemyFired + ' 发 / 命中 ' + view.stats.enemyHits
                    : '你 ' + view.stats.playerFired + ' 发 / 命中 ' + view.stats.playerHits +
                      ' · 敌 ' + view.stats.enemyFired + ' 发 / 命中 ' + view.stats.enemyHits,
                ),
              )
            }
            return h('div', { className: 'dshbs-status', 'data-dsh-status': '' }, children)
          }

          function renderOverlay(view, act) {
            if (view.phase !== 'over' || !view.winner) return null
            const won = view.winner === 'player'
            const title = view.duo
              ? view.winner === 'player' ? '玩家 A 获胜' : '玩家 B 获胜'
              : won ? '胜利！' : view.endReason === 'surrender' ? '已投降' : '失败'
            const subtitle = view.duo
              ? view.endReason === 'surrender' ? '对方投降，可以再来一局' : '对方 5 艘舰船全部被击沉'
              : won ? '你击沉了敌方全部 5 艘舰船' : view.endReason === 'surrender' ? '你结束了本局，可以再来一局' : '你的舰队被全部击沉'
            const statsLine = view.duo
              ? 'A ' + view.stats.playerFired + ' 发 / 命中 ' + view.stats.playerHits +
                ' · B ' + view.stats.enemyFired + ' 发 / 命中 ' + view.stats.enemyHits
              : '你 ' + view.stats.playerFired + ' 发 / 命中 ' + view.stats.playerHits +
                ' · 敌 ' + view.stats.enemyFired + ' 发 / 命中 ' + view.stats.enemyHits
            return h(
              'div',
              { className: 'dshbs-overlay', 'data-overlay': view.duo ? 'over' : won ? 'win' : 'lose' },
              h(
                'div',
                { className: 'dshbs-overlay-card' },
                h('div', { className: 'dshbs-overlay-title' }, title),
                h('div', { className: 'dshbs-overlay-sub' }, subtitle),
                h('div', { className: 'dshbs-overlay-sub' }, statsLine),
                h(
                  'div',
                  { className: 'dshbs-overlay-actions' },
                  h(
                    'button',
                    {
                      key: 'again',
                      type: 'button',
                      className: 'dshbs-btn dshbs-btn--primary',
                      'data-action': 'restart',
                      onClick: function () {
                        act('restart')
                      },
                    },
                    '再来一局',
                  ),
                  h(
                    'button',
                    {
                      key: 'fresh',
                      type: 'button',
                      className: 'dshbs-btn',
                      'data-action': 'new-game',
                      onClick: function () {
                        act('new-game')
                      },
                    },
                    '新游戏',
                  ),
                ),
              ),
            )
          }

          function renderHandoff(view, act) {
            if (view.handoff !== 'curtain' || !view.handoffLabel) return null
            const placing = view.phase === 'place'
            return h(
              'div',
              { className: 'dshbs-curtain', 'data-handoff': 'curtain' },
              h(
                'div',
                { className: 'dshbs-curtain-card' },
                h('div', { className: 'dshbs-overlay-title' }, '请把设备交给 ' + view.handoffLabel),
                h(
                  'div',
                  { className: 'dshbs-overlay-sub' },
                  placing ? view.handoffLabel + ' 布阵：请不要看对方海域' : view.handoffLabel + ' 的回合：点击对方海域开火',
                ),
                h('div', { className: 'dshbs-overlay-sub' }, '确认后才显示你的海域'),
                h(
                  'div',
                  { className: 'dshbs-overlay-actions' },
                  h(
                    'button',
                    {
                      key: 'ack',
                      type: 'button',
                      className: 'dshbs-btn dshbs-btn--primary',
                      'data-action': 'ack',
                      onClick: function () {
                        act('ack')
                      },
                    },
                    '我是 ' + view.handoffLabel + '，继续',
                  ),
                ),
              ),
            )
          }

          function renderPassBar(view, act) {
            // Rendered inline in the status bar, never on top of the boards.
            if (view.handoff !== 'pass') return null
            return h(
              'button',
              {
                key: 'pass',
                type: 'button',
                className: 'dshbs-btn dshbs-btn--primary',
                'data-action': 'pass',
                onClick: function () {
                  act('pass')
                },
              },
              '交给 ' + view.nextLabel + ' →',
            )
          }

          function Game() {
            const rootRef = React.useRef(null)
            const gameRef = React.useRef(null)
            const measuredRef = React.useRef(false)
            const [view, setView] = React.useState(null)
            const [error, setError] = React.useState(null)
            const [rulesOpen, setRulesOpen] = React.useState(false)
            const [attempt, setAttempt] = React.useState(0)

            React.useEffect(function () {
              const root = rootRef.current
              if (!root) return undefined
              let game = null
              measuredRef.current = false
              try {
                game = createGame(root, {
                  onState: function onState(next) {
                    setView(next)
                    setError(null)
                  },
                  onError: function onError(messageText) {
                    setError(messageText)
                  },
                })
                gameRef.current = game
                game.scheduleMeasure()
              } catch (createError) {
                try {
                  console.error('[dsh-game-battleship] failed to start', createError)
                } catch (logError) {
                  // ignore
                }
                setError('游戏启动失败，点「重试」重新开始。')
                return undefined
              }
              try {
                if (typeof root.focus === 'function') root.focus({ preventScroll: true })
              } catch (focusError) {
                try {
                  root.focus()
                } catch (fallbackError) {
                  // ignore
                }
              }
              return function cleanup() {
                gameRef.current = null
                try {
                  game.destroy()
                } catch (destroyError) {
                  try {
                    console.error('[dsh-game-battleship] cleanup failed', destroyError)
                  } catch (logError) {
                    // ignore
                  }
                }
              }
            }, [attempt])

            function retry() {
              setError(null)
              setView(null)
              setAttempt(function (value) {
                return value + 1
              })
            }

            function act(action, arg) {
              if (action === 'rules') {
                setRulesOpen(true)
                return
              }
              const game = gameRef.current
              if (!game) return
              try {
                if (action === 'cell') game.clickCell(arg)
                else if (action === 'hover') game.hoverCell(arg)
                else if (action === 'rotate') game.rotate()
                else if (action === 'randomize') game.randomize()
                else if (action === 'place-undo') game.undoPlacement()
                else if (action === 'start') game.start()
                else if (action === 'new-game') game.newGame()
                else if (action === 'restart') game.restart()
                else if (action === 'surrender') game.surrender()
                else if (action === 'toggle-adjacent') game.toggleAdjacent()
                else if (action === 'ack') game.acknowledge()
                else if (action === 'pass') game.pass()
                else if (action === 'mode-ai') game.setMode('ai')
                else if (action === 'mode-duo') game.setMode('duo')
                else if (action.indexOf('difficulty-') === 0) game.setDifficulty(action.slice('difficulty-'.length))
              } catch (actionError) {
                try {
                  console.error('[dsh-game-battleship] action failed', actionError)
                } catch (logError) {
                  // ignore
                }
              }
            }

            function focusRoot() {
              const root = rootRef.current
              if (!root || typeof root.focus !== 'function') return
              try {
                root.focus({ preventScroll: true })
              } catch (focusError) {
                try {
                  root.focus()
                } catch (fallbackError) {
                  // ignore
                }
              }
            }

            function onRootMouseDown(event) {
              const target = event && event.target
              if (target && typeof target.closest === 'function' && target.closest('button')) return
              focusRoot()
            }

            function onKeyDown(event) {
              if (!event) return
              const key = event.key
              if ((key === 'r' || key === 'R') && view && view.phase === 'place' && view.handoff !== 'curtain') {
                preventDefault(event)
                act('rotate')
              }
            }

            const phase = view ? view.phase : 'place'
            const rootAttrs = {
              ref: rootRef,
              className: 'dshbs-root',
              'data-dsh-game': GAME_ID,
              'data-phase': phase,
              'data-mode': view ? view.mode : 'ai',
              'data-handoff': view && view.handoff ? view.handoff : '',
              'data-turn': view ? view.turn : 'player',
              'data-winner': view && view.winner ? view.winner : '',
              tabIndex: 0,
              onKeyDown: onKeyDown,
              onMouseDown: onRootMouseDown,
              onContextMenu: preventDefault,
            }

            if (!view) {
              return h(
                'div',
                rootAttrs,
                h('style', { key: 'style' }, STYLE_TEXT),
                h('div', { key: 'loading', className: 'dshbs-loading' }, '加载中…'),
              )
            }

            const children = [h('style', { key: 'style' }, STYLE_TEXT)]
            if (error) {
              children.push(
                h(
                  'div',
                  { key: 'error', className: 'dshbs-error-card', 'data-error': '' },
                  h('b', null, '游戏出错了'),
                  h('span', null, error),
                  h(
                    'button',
                    {
                      key: 'retry',
                      type: 'button',
                      className: 'dshbs-btn dshbs-btn--primary',
                      'data-action': 'retry',
                      onClick: retry,
                    },
                    '重试',
                  ),
                ),
              )
            } else if (view.tooSmall) {
              children.push(
                h(
                  'div',
                  { key: 'toosmall', className: 'dshbs-toosmall', 'data-status': '' },
                  h('b', null, '窗口太小'),
                  h('span', null, '把窗口放大一些再玩（至少 320 × 240）'),
                ),
              )
            } else {
              children.push(renderHeader(view, act))
              children.push(renderSettings(view, act))
              const bodyChildren = [renderPanel(view, 'player', act)]
              if (view.showOpponentPanel) bodyChildren.push(renderPanel(view, 'enemy', act))
              bodyChildren.push(renderOverlay(view, act))
              bodyChildren.push(renderHandoff(view, act))
              children.push(
                h(
                  'div',
                  {
                    key: 'body',
                    className: 'dshbs-body',
                    'data-dsh-body': '',
                    style: {
                      flexDirection: view.layout.sideBySide ? 'row' : 'column',
                      flexWrap: 'nowrap',
                    },
                  },
                  bodyChildren,
                ),
              )
              children.push(renderStatus(view, act))
            }
            if (rulesOpen) {
              children.push(
                renderRules(function () {
                  setRulesOpen(false)
                }),
              )
            }
            return h('div', rootAttrs, children)
          }

          class GameBoundary extends React.Component {
            constructor(props) {
              super(props)
              this.state = { failed: false }
            }

            static getDerivedStateFromError() {
              return { failed: true }
            }

            componentDidCatch(error, info) {
              try {
                console.error('[dsh-game-battleship] component crashed', error, info)
              } catch (logError) {
                // ignore
              }
            }

            render() {
              if (this.state.failed) {
                return h(
                  'div',
                  { style: { padding: 16, color: 'var(--dsw-alias-label-secondary, #57606a)' } },
                  '海战棋加载失败，请切走再重新进入「游戏」页。',
                )
              }
              return this.props.children
            }
          }

          function GameEntry(props) {
            return h(GameBoundary, null, h(Game, props))
          }

          // Stable `matched` payload: a fresh `{}` on every select call would make
          // the chain renderer see a new matched reference on each render.
          const MATCHED = Object.freeze({})

          return {
            inject: ['slots'],
            apply: function apply(ctx) {
              try {
                ctx.slots.inject('game.stage', function () {
                  try {
                    return ctx.slots.register(
                      {
                        name: 'game.stage',
                        id: GAME_ID,
                        label: function label() {
                          return '海战棋'
                        },
                        select: function select(ownerProps) {
                          return ownerProps && ownerProps.gameId === GAME_ID ? MATCHED : null
                        },
                      },
                      GameEntry,
                    )
                  } catch (registerError) {
                    try {
                      console.error('[dsh-game-battleship] slot registration failed', registerError)
                    } catch (logError) {
                      // ignore
                    }
                    return function () {}
                  }
                })
              } catch (injectError) {
                try {
                  console.error('[dsh-game-battleship] slot inject failed', injectError)
                } catch (logError) {
                  // ignore
                }
              }
            },
          }
        },
      })
    } catch (loaderError) {
      try {
        console.error('[dsh-game-battleship] module registration failed', loaderError)
      } catch (logError) {
        // ignore
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Opt-in test seam (used by dev/test-*.mjs and the independent verifier;
  // never enabled by the host)
  // ---------------------------------------------------------------------------

  if (typeof window !== 'undefined' && window.__DSH_GAME_BATTLESHIP_TEST__ === true) {
    try {
      Object.defineProperty(window, '__DSH_GAME_BATTLESHIP__', {
        value: Object.freeze({
          GAME_ID: GAME_ID,
          STORE_KEY: STORE_KEY,
          SCHEMA_VERSION: SCHEMA_VERSION,
          BOARD: BOARD,
          CELLS: CELLS,
          MIN_WIDTH: MIN_WIDTH,
          MIN_HEIGHT: MIN_HEIGHT,
          MIN_BOARD_PX: MIN_BOARD_PX,
          SHIPS: SHIPS.map(function (ship) {
            return { key: ship.key, name: ship.name, short: ship.short, len: ship.len }
          }),
          FLEET_CELLS: FLEET_CELLS,
          DIFFICULTIES: DIFFICULTIES.slice(),
          DIFFICULTY_LABELS: Object.assign({}, DIFFICULTY_LABELS),
          MODES: MODES.slice(),
          MODE_LABELS: Object.assign({}, MODE_LABELS),
          SIDE_LABELS: Object.assign({}, SIDE_LABELS),
          otherSide: otherSide,
          placingSide: placingSide,
          placedShips: placedShips,
          viewSideOf: viewSideOf,
          clamp: clamp,
          mulberry32: mulberry32,
          randomSeed: randomSeed,
          stepRng: stepRng,
          shipCells: shipCells,
          isValidPlacement: isValidPlacement,
          normalizeShipCells: normalizeShipCells,
          fleetSubsetOk: fleetSubsetOk,
          fleetCompleteOk: fleetCompleteOk,
          newGameState: newGameState,
          currentShipDef: currentShipDef,
          canPlaceCurrent: canPlaceCurrent,
          placeCurrent: placeCurrent,
          removeLastShip: removeLastShip,
          randomizePlayerFleet: randomizePlayerFleet,
          randomFleet: randomFleet,
          rotateOrientation: rotateOrientation,
          setDifficulty: setDifficulty,
          toggleAdjacent: toggleAdjacent,
          startBattle: startBattle,
          restartBattle: restartBattle,
          surrender: surrender,
          fireAt: fireAt,
          fireAtSide: fireAtSide,
          passDevice: passDevice,
          acknowledgeHandoff: acknowledgeHandoff,
          aiChooseCell: aiChooseCell,
          aiFire: aiFire,
          aiTurn: aiTurn,
          unresolvedHitCells: unresolvedHitCells,
          adjacentUnknownCells: adjacentUnknownCells,
          lineContinuationCells: lineContinuationCells,
          densityMap: densityMap,
          sunkKeys: sunkKeys,
          allSunk: sideAllSunk,
          allSunkRaw: allSunk,
          shotsAtSide: shotsAtSide,
          countShotCells: countShotCells,
          countHitCells: countHitCells,
          sanitizeState: sanitizeState,
          serializeState: serializeState,
          loadSavedState: loadSavedState,
          saveStateToStorage: saveStateToStorage,
          computeLayout: computeLayout,
          createGame: createGame,
        }),
        configurable: true,
      })
    } catch (seamError) {
      // keep playing; the seam is dev-only
    }
  }
})()

