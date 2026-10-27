/**
 * Pure-logic self test for @local/dsh-game-minesweeper.
 *
 * Run: node dev/test-logic.mjs
 *
 * The browser bundle is the only entry, so the test imports client.js with a
 * minimal `window` stub and uses the opt-in test seam
 * (`window.__DSH_GAME_MINESWEEPER_TEST__ = true`). No React, canvas or host
 * needed.
 */
import assert from 'node:assert/strict'

const storage = new Map()
let loadedDefinition = null

globalThis.window = {
  __DSH_GAME_MINESWEEPER_TEST__: true,
  __ModuleLoader__: {
    load(definition) {
      loadedDefinition = definition
    },
  },
  localStorage: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null
    },
    setItem(key, value) {
      storage.set(key, String(value))
    },
    removeItem(key) {
      storage.delete(key)
    },
  },
  performance: { now: () => 0 },
}

await import(new URL('../client.js', import.meta.url).href)

const api = globalThis.window.__DSH_GAME_MINESWEEPER__
assert.ok(api, 'test seam should be installed')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    failed += 1
    console.error('not ok - ' + name)
    console.error(error)
  }
}

function makeRng(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** Build a started board with an explicit mine layout (any rows/cols). */
function boardWith(rows, cols, mineIndices, overrides) {
  const total = rows * cols
  const state = {
    difficulty: 'beginner',
    rows,
    cols,
    mines: mineIndices.length,
    mine: new Array(total).fill(0),
    adjacent: new Array(total).fill(0),
    revealed: new Array(total).fill(0),
    flagged: new Array(total).fill(0),
    started: true,
    status: 'playing',
    exploded: -1,
    elapsedMs: 0,
    best: api.emptyBestMap(),
  }
  for (const index of mineIndices) state.mine[index] = 1
  state.adjacent = api.computeAdjacent(rows, cols, state.mine)
  return Object.assign(state, overrides || {})
}

/** Real preset-sized state with a valid number of mines (for persistence tests). */
function levelState(difficulty, mineIndices) {
  const state = api.freshState(difficulty)
  for (const index of mineIndices) state.mine[index] = 1
  state.adjacent = api.computeAdjacent(state.rows, state.cols, state.mine)
  state.started = true
  state.status = 'playing'
  return state
}

function countOnes(values) {
  return values.filter((value) => value === 1).length
}

const BEGINNER_MINES = [0, 8, 72, 80, 13, 22, 31, 40, 58, 67]

// ---------------------------------------------------------------------------
// Registration / contract shape
// ---------------------------------------------------------------------------

test('module loader id equals the package name', () => {
  assert.equal(loadedDefinition.id, '@local/dsh-game-minesweeper')
  assert.equal(typeof loadedDefinition.factory, 'function')
})

test('factory registers only into game.stage with contract v1 shape', () => {
  const ReactStub = {
    createElement() {
      return null
    },
    useRef() {
      return { current: null }
    },
    useEffect() {},
    useState() {
      return [undefined, () => {}]
    },
    useCallback(fn) {
      return fn
    },
    Component: class {
      constructor(props) {
        this.props = props
      }
      setState() {}
    },
  }
  const plugin = loadedDefinition.factory((id) => {
    assert.equal(id, 'react')
    return ReactStub
  })
  assert.deepEqual(plugin.inject, ['slots'])

  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject(slotName, callback) {
        injections.push(slotName)
        const dispose = callback()
        assert.equal(typeof dispose, 'function')
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  assert.deepEqual(injections, ['game.stage'])
  assert.equal(registrations.length, 1)
  const { options, component } = registrations[0]
  assert.equal(options.name, 'game.stage')
  assert.equal(options.id, 'minesweeper')
  assert.equal(options.label(), '扫雷')
  assert.deepEqual(options.select({ gameId: 'minesweeper' }), {})
  assert.equal(options.select({ gameId: '2048' }), null)
  assert.equal(options.select({ gameId: 'memory' }), null)
  assert.equal(options.select({}), null)
  assert.equal(options.select(null), null)
  assert.equal(typeof component, 'function')
})

// ---------------------------------------------------------------------------
// Presets / fresh state
// ---------------------------------------------------------------------------

test('three classic presets are valid and distinct', () => {
  assert.deepEqual(
    { rows: api.LEVELS.beginner.rows, cols: api.LEVELS.beginner.cols, mines: api.LEVELS.beginner.mines },
    { rows: 9, cols: 9, mines: 10 },
  )
  assert.deepEqual(
    { rows: api.LEVELS.intermediate.rows, cols: api.LEVELS.intermediate.cols, mines: api.LEVELS.intermediate.mines },
    { rows: 16, cols: 16, mines: 40 },
  )
  assert.deepEqual(
    { rows: api.LEVELS.expert.rows, cols: api.LEVELS.expert.cols, mines: api.LEVELS.expert.mines },
    { rows: 16, cols: 30, mines: 99 },
  )
  for (const id of api.LEVEL_IDS) {
    const level = api.LEVELS[id]
    assert.ok(level.mines > 0 && level.mines < level.rows * level.cols, id + ' must leave safe cells')
  }
})

test('freshState starts ready with no mines, no reveals and null bests', () => {
  const state = api.freshState('beginner')
  assert.equal(state.difficulty, 'beginner')
  assert.equal(state.rows, 9)
  assert.equal(state.cols, 9)
  assert.equal(state.mines, 10)
  assert.equal(state.started, false)
  assert.equal(state.status, 'ready')
  assert.equal(state.exploded, -1)
  assert.equal(state.elapsedMs, 0)
  assert.equal(countOnes(state.mine), 0)
  assert.equal(countOnes(state.revealed), 0)
  assert.equal(countOnes(state.flagged), 0)
  assert.deepEqual(state.best, { beginner: null, intermediate: null, expert: null })
})

test('freshState falls back to beginner for an unknown difficulty and keeps best', () => {
  const state = api.freshState('space', { beginner: 1234, intermediate: 99 })
  assert.equal(state.difficulty, 'beginner')
  assert.equal(state.best.beginner, 1234)
  assert.equal(state.best.intermediate, 99)
  assert.equal(state.best.expert, null)
})

test('normalizeBestMap keeps only valid times', () => {
  const best = api.normalizeBestMap({
    beginner: 5000,
    intermediate: -1,
    expert: 1.5,
    extra: 10,
  })
  assert.equal(best.beginner, 5000)
  assert.equal(best.intermediate, null)
  assert.equal(best.expert, null)
  assert.equal(Object.prototype.hasOwnProperty.call(best, 'extra'), false)
  assert.deepEqual(api.normalizeBestMap(null), { beginner: null, intermediate: null, expert: null })
})

// ---------------------------------------------------------------------------
// Neighbours / mine placement
// ---------------------------------------------------------------------------

test('neighborIndices handles centre, edge and corner cells', () => {
  assert.equal(api.neighborIndices(9, 9, 40).length, 8)
  assert.equal(api.neighborIndices(9, 9, 0).length, 3)
  assert.deepEqual(api.neighborIndices(9, 9, 0).sort((a, b) => a - b), [1, 9, 10])
  assert.equal(api.neighborIndices(9, 9, 4).length, 5)
  assert.equal(api.neighborIndices(9, 9, 40).includes(40), false, 'a cell is not its own neighbour')
  assert.deepEqual(api.neighborIndices(9, 9, -1), [])
  assert.deepEqual(api.neighborIndices(9, 9, 81), [])
})

test('computeAdjacent counts surrounding mines and leaves mine cells at 0', () => {
  // 3x3, mines in the four corners; only the cross cells touch them.
  const mine = [1, 0, 1, 0, 0, 0, 1, 0, 1]
  const adjacent = api.computeAdjacent(3, 3, mine)
  assert.equal(adjacent[1], 2)
  assert.equal(adjacent[3], 2)
  assert.equal(adjacent[4], 4)
  assert.equal(adjacent[5], 2)
  assert.equal(adjacent[7], 2)
  assert.equal(adjacent[0], 0)
  assert.equal(adjacent[2], 0)
})

test('generateMines places exactly the requested mines and keeps the first-click ring safe', () => {
  for (const difficulty of api.LEVEL_IDS) {
    const level = api.LEVELS[difficulty]
    const rng = makeRng(12345)
    const mine = api.generateMines(level.rows, level.cols, level.mines, 0, rng)
    assert.equal(mine.length, level.rows * level.cols)
    assert.equal(countOnes(mine), level.mines, difficulty + ' mine count')
    const safe = [0].concat(api.neighborIndices(level.rows, level.cols, 0))
    for (const index of safe) {
      assert.equal(mine[index], 0, difficulty + ' first-click ring must be safe at ' + index)
    }
  }
})

test('generateMines is deterministic for a seeded RNG and unique per cell', () => {
  const level = api.LEVELS.beginner
  const first = api.generateMines(level.rows, level.cols, level.mines, 40, makeRng(7))
  const second = api.generateMines(level.rows, level.cols, level.mines, 40, makeRng(7))
  assert.deepEqual(first, second)
  assert.equal(first.length, 81)
  // Unique cells by construction; a second click position yields a safe ring too.
  const other = api.generateMines(level.rows, level.cols, level.mines, 18, makeRng(7))
  assert.equal(other[18], 0)
})

test('ensureMines flips a ready state to playing with adjacent counts', () => {
  const state = api.freshState('intermediate')
  api.ensureMines(state, 100, makeRng(3))
  assert.equal(state.started, true)
  assert.equal(state.status, 'playing')
  assert.equal(countOnes(state.mine), 40)
  assert.equal(state.mine[100], 0)
  assert.equal(state.adjacent.length, 256)
})

// ---------------------------------------------------------------------------
// Reveal / flood fill / flag / chord
// ---------------------------------------------------------------------------

test('first reveal is always safe and opens at least its own cell', () => {
  const level = api.LEVELS.beginner
  for (let seed = 1; seed <= 40; seed += 1) {
    const state = api.freshState('beginner')
    const clicked = (seed * 17) % (level.rows * level.cols)
    assert.equal(api.revealAt(state, clicked, makeRng(seed)), true)
    assert.equal(state.status, 'playing')
    assert.equal(state.mine[clicked], 0, 'clicked cell must never be a mine')
    assert.equal(state.revealed[clicked], 1)
    assert.equal(state.exploded, -1)
    assert.equal(countOnes(state.mine), 10)
  }
})

test('revealing a number only opens that cell', () => {
  const state = boardWith(3, 3, [0])
  api.revealAt(state, 1)
  assert.equal(api.countRevealed(state), 1)
  assert.equal(state.revealed[1], 1)
  assert.equal(state.status, 'playing')
})

test('flood fill opens connected empty cells and their numbered border', () => {
  // 3x3, mines at the two bottom-right cells. Clicking 0 opens every safe cell
  // except 6 (which is only reachable through numbers) — and never a mine.
  const state = boardWith(3, 3, [7, 8])
  api.revealAt(state, 0)
  for (const index of [0, 1, 2, 3, 4, 5]) {
    assert.equal(state.revealed[index], 1, 'cell ' + index + ' should be revealed')
  }
  assert.equal(state.revealed[6], 0, 'flood fill must stop at a closed numbered cell')
  assert.equal(state.revealed[7], 0)
  assert.equal(state.revealed[8], 0)
  assert.equal(state.status, 'playing')
})

test('flags block reveal; invalid indices are no-ops', () => {
  const state = boardWith(3, 3, [8])
  assert.equal(api.toggleFlag(state, 1), true)
  assert.equal(state.flagged[1], 1)
  assert.equal(api.revealAt(state, 1), false)
  assert.equal(state.revealed[1], 0)
  assert.equal(api.revealAt(state, -1), false)
  assert.equal(api.revealAt(state, 99), false)
  assert.equal(api.revealAt(state, 1.5), false)
})

test('toggleFlag toggles, refuses revealed cells and works before the first reveal', () => {
  const ready = api.freshState('beginner')
  assert.equal(api.toggleFlag(ready, 0), true)
  assert.equal(ready.flagged[0], 1)
  assert.equal(ready.started, false, 'flagging must not start the game')
  assert.equal(api.toggleFlag(ready, 0), true)
  assert.equal(ready.flagged[0], 0)

  const playing = boardWith(3, 3, [8], { revealed: [1, 0, 0, 0, 0, 0, 0, 0, 0] })
  assert.equal(api.toggleFlag(playing, 0), false, 'revealed cells cannot be flagged')
  playing.status = 'lost'
  assert.equal(api.toggleFlag(playing, 1), false, 'finished games are frozen')
})

test('chord does nothing without matching flags', () => {
  const state = boardWith(3, 3, [8], { revealed: [0, 0, 0, 0, 1, 0, 0, 0, 0] })
  assert.equal(api.chordAt(state, 4), false)
  assert.equal(api.countRevealed(state), 1)
  assert.equal(api.chordAt(state, 0), false, 'unrevealed cells cannot chord')
})

test('chord opens the unflagged neighbours when flags match the number', () => {
  const state = boardWith(3, 3, [8], { revealed: [0, 0, 0, 0, 1, 0, 0, 0, 0] })
  assert.equal(state.adjacent[4], 1)
  assert.equal(api.toggleFlag(state, 8), true)
  assert.equal(api.chordAt(state, 4), true)
  assert.equal(state.status, 'won', 'opening every safe neighbour wins')
  assert.equal(api.countRevealed(state), 8)
  assert.equal(state.revealed[8], 0)
})

test('chord with a wrong flag can lose the game', () => {
  const state = boardWith(3, 3, [8], { revealed: [0, 0, 0, 0, 1, 0, 0, 0, 0] })
  assert.equal(api.toggleFlag(state, 7), true, 'a safe cell gets the wrong flag')
  assert.equal(api.chordAt(state, 4), true)
  assert.equal(state.status, 'lost')
  assert.equal(state.exploded, 8)
})

test('revealing a mine loses the game and freezes the board', () => {
  const state = boardWith(3, 3, [8])
  assert.equal(api.revealAt(state, 8), true)
  assert.equal(state.status, 'lost')
  assert.equal(state.exploded, 8)
  assert.equal(state.revealed[8], 0, 'the exploded mine is drawn from exploded, not revealed')
  assert.equal(api.revealAt(state, 0), false)
  assert.equal(api.toggleFlag(state, 1), false)
  assert.equal(api.chordAt(state, 0), false)
})

test('winning reveals every safe cell, auto-flags the mines and is idempotent', () => {
  const state = boardWith(3, 3, [7, 8])
  assert.equal(api.revealAt(state, 0), true)
  assert.equal(state.status, 'playing')
  assert.equal(api.countRevealed(state), 6)
  assert.equal(api.revealAt(state, 6), true)
  assert.equal(state.status, 'won')
  assert.equal(api.isWon(state), true)
  assert.equal(api.checkWin(state), false, 'already won')
  assert.equal(state.flagged[7], 1)
  assert.equal(state.flagged[8], 1)
  assert.equal(api.countFlagged(state), 2)
  assert.equal(api.revealAt(state, 1), false)
})

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('storage key is the minesweeper key and never the 2048 key', () => {
  assert.equal(api.STORE_KEY, 'dsh.game.minesweeper.v1')
  assert.notEqual(api.STORE_KEY, 'dsh.game.2048.v1')
  assert.equal(api.GAME_ID, 'minesweeper')
})

test('serialize -> sanitize round-trips a playing state including flags and timer', () => {
  const state = levelState('beginner', BEGINNER_MINES)
  state.revealed[1] = 1
  state.flagged[2] = 1
  state.elapsedMs = 4321
  state.best.beginner = 12000
  const raw = api.serializeState(state)
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.difficulty, 'beginner')
  assert.deepEqual(raw.mine, state.mine)
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'adjacent'), false, 'adjacent is derived, not stored')
  const restored = api.sanitizeState(raw)
  assert.ok(restored)
  assert.deepEqual(api.serializeState(restored), raw)
  // cell 1 touches mine 0 (and no other mine of BEGINNER_MINES)
  assert.equal(restored.adjacent[1], 1)
})

test('ready and lost and won states round-trip', () => {
  const ready = api.freshState('beginner', { beginner: 5000 })
  const readyRestored = api.sanitizeState(api.serializeState(ready))
  assert.ok(readyRestored)
  assert.equal(readyRestored.status, 'ready')
  assert.equal(readyRestored.started, false)
  assert.equal(readyRestored.best.beginner, 5000)

  const lost = levelState('beginner', BEGINNER_MINES)
  lost.status = 'lost'
  lost.exploded = 0
  lost.revealed[1] = 1
  lost.flagged[8] = 1
  lost.flagged[2] = 1 // wrong flag on a safe cell
  lost.elapsedMs = 15000
  const lostRaw = api.serializeState(lost)
  const lostRestored = api.sanitizeState(lostRaw)
  assert.ok(lostRestored)
  assert.deepEqual(api.serializeState(lostRestored), lostRaw)

  const won = levelState('beginner', BEGINNER_MINES)
  for (let index = 0; index < won.rows * won.cols; index += 1) {
    if (!won.mine[index]) won.revealed[index] = 1
  }
  won.status = 'won'
  for (const index of BEGINNER_MINES) won.flagged[index] = 1
  won.elapsedMs = 9000
  won.best.beginner = 9000
  const wonRaw = api.serializeState(won)
  const wonRestored = api.sanitizeState(wonRaw)
  assert.ok(wonRestored)
  assert.deepEqual(api.serializeState(wonRestored), wonRaw)
})

test('sanitize rejects malformed saves instead of throwing', () => {
  const good = api.serializeState(
    (() => {
      const state = levelState('beginner', BEGINNER_MINES)
      state.revealed[1] = 1
      state.flagged[2] = 1
      return state
    })(),
  )
  assert.ok(api.sanitizeState(good))
  assert.equal(api.sanitizeState(null), null)
  assert.equal(api.sanitizeState(undefined), null)
  assert.equal(api.sanitizeState({}), null)
  assert.equal(api.sanitizeState('nope'), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { schemaVersion: 2 })), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { difficulty: 'space' })), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { mine: good.mine.slice(0, 80) })), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { mine: good.mine.map((v, i) => (i === 0 ? 2 : v)) })), null)
  assert.equal(
    api.sanitizeState(Object.assign({}, good, { mine: good.mine.map((v, i) => (i === 0 ? 0 : v)) })),
    null,
    'missing one mine is rejected',
  )
  assert.equal(
    api.sanitizeState(Object.assign({}, good, { revealed: good.revealed.map((v, i) => (i === 0 ? 1 : v)) })),
    null,
    'a revealed mine is rejected',
  )
  assert.equal(
    api.sanitizeState(
      Object.assign({}, good, { flagged: good.flagged.map((v, i) => (i === 1 ? 1 : v)) }),
    ),
    null,
    'a cell cannot be revealed and flagged at once',
  )
  assert.equal(api.sanitizeState(Object.assign({}, good, { started: false })), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { status: 'paused' })), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { elapsedMs: -1 })), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { elapsedMs: 1.5 })), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { elapsedMs: api.MAX_LOG_MS + 1 })), null)
  assert.equal(
    api.sanitizeState(Object.assign({}, good, { status: 'lost', exploded: -1 })),
    null,
    'a lost game needs the exploded mine',
  )
  assert.equal(
    api.sanitizeState(Object.assign({}, good, { status: 'lost', exploded: 1 })),
    null,
    'the exploded cell must be a mine',
  )
  assert.equal(
    api.sanitizeState(Object.assign({}, good, { exploded: 0 })),
    null,
    'a playing game cannot carry an exploded cell',
  )

  const ready = api.serializeState(api.freshState('beginner'))
  assert.equal(
    api.sanitizeState(Object.assign({}, ready, { mine: ready.mine.map((v, i) => (i === 0 ? 1 : v)) })),
    null,
    'a ready game cannot ship pre-placed mines',
  )
  assert.equal(
    api.sanitizeState(Object.assign({}, ready, { revealed: ready.revealed.map((v, i) => (i === 0 ? 1 : v)) })),
    null,
    'a ready game cannot ship revealed cells',
  )
})

test('sanitize normalizes a "playing" save whose safe cells are all revealed', () => {
  const won = levelState('beginner', BEGINNER_MINES)
  for (let index = 0; index < won.rows * won.cols; index += 1) {
    if (!won.mine[index]) won.revealed[index] = 1
  }
  won.status = 'playing'
  const raw = api.serializeState(won)
  const restored = api.sanitizeState(raw)
  assert.ok(restored)
  assert.equal(restored.status, 'won')
  assert.equal(api.countFlagged(restored), 10)
})

test('sanitize repairs a won save without flags and a lost save with a flag on the exploded cell', () => {
  const won = levelState('beginner', BEGINNER_MINES)
  for (let index = 0; index < won.rows * won.cols; index += 1) {
    if (!won.mine[index]) won.revealed[index] = 1
  }
  won.status = 'won'
  won.elapsedMs = 1000
  const wonRestored = api.sanitizeState(api.serializeState(won))
  assert.ok(wonRestored)
  assert.equal(api.countFlagged(wonRestored), 10, 'a won board auto-flags every mine')
  assert.equal(wonRestored.flagged[0], 1)

  const lost = levelState('beginner', BEGINNER_MINES)
  lost.status = 'lost'
  lost.exploded = 0
  lost.flagged[0] = 1
  lost.elapsedMs = 1000
  const lostRestored = api.sanitizeState(api.serializeState(lost))
  assert.ok(lostRestored)
  assert.equal(lostRestored.flagged[0], 0, 'the boom cell must not be covered by a flag')
})

test('sanitize derives size/adjacent and normalizes bad best entries', () => {
  const state = levelState('beginner', BEGINNER_MINES)
  const raw = api.serializeState(state)
  raw.rows = 99
  raw.cols = 99
  raw.mines = 999
  raw.adjacent = [1, 2, 3]
  raw.best = { beginner: -5, intermediate: 1.5, expert: 'fast' }
  const restored = api.sanitizeState(raw)
  assert.ok(restored)
  assert.equal(restored.rows, 9)
  assert.equal(restored.cols, 9)
  assert.equal(restored.mines, 10)
  assert.equal(restored.adjacent.length, 81)
  assert.deepEqual(restored.best, { beginner: null, intermediate: null, expert: null })
})

test('serialize clamps an over-long elapsed time into the valid range', () => {
  const state = levelState('beginner', BEGINNER_MINES)
  state.elapsedMs = api.MAX_LOG_MS + 5000
  const raw = api.serializeState(state)
  assert.equal(raw.elapsedMs, api.MAX_LOG_MS)
  assert.ok(api.sanitizeState(raw))
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log('logic tests: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
