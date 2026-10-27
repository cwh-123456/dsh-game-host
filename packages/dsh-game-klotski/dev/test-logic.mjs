/**
 * dev/test-logic.mjs — pure engine / save / registration self test (no deps).
 *
 *   node dev/test-logic.mjs
 *
 * Loads client.js through its Node test seam and exercises:
 *   §1  level metadata + legal 4x5 army layouts + task-spec level 1
 *   §2  createState / initial legal moves (spec-derived move count)
 *   §3  canSlide: 1- and 2-cell slides, path-clear rule, own-cell rule,
 *       bounds / diagonal / 0 / 3-cell rejection
 *   §4  listMoves / destinations
 *   §5  applySlide immutability + undo + restart
 *   §6  win state + isWon
 *   §7  serialize <-> sanitize roundtrip, canonical piece order
 *   §8  3,000-mutation bad-save fuzz (never throws; accepted saves valid)
 *   §9  formatTime
 *   §10 slot registration shape (inject ['slots'], game.stage, exact select)
 *
 * Exits non-zero on failure.
 */
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// window stub + module import (test seam), then a tiny fake React for §10
// ---------------------------------------------------------------------------

const storage = new Map()
let loadedDefinition = null

globalThis.window = {
  __DSH_GAME_KLOTSKI_TEST__: true,
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
    clear() {
      storage.clear()
    },
  },
  performance: { now: () => 0 },
}

await import(new URL('./fake-react.js', import.meta.url).href)
await import(new URL('../client.js', import.meta.url).href)

const api = globalThis.window.__DSH_GAME_KLOTSKI__
assert.ok(api, 'client.js should install window.__DSH_GAME_KLOTSKI__')
assert.ok(loadedDefinition, 'client.js should call window.__ModuleLoader__.load')
assert.ok(globalThis.window.FakeReact, 'dev/fake-react.js should install window.FakeReact')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures = []
const results = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.error('not ok - ' + name)
    console.error(error && error.stack ? error.stack : error)
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.keys(value).forEach((key) => deepFreeze(value[key]))
  }
  return value
}

function pieceIndex(state, id) {
  return state.pieces.findIndex((piece) => piece.id === id)
}

/** A valid level-1 arrangement with Cao Cao already at the exit. */
function winningState() {
  const state = api.createState(0)
  const positions = {
    zhang: [0, 0],
    cao: [1, 3],
    zhao: [3, 0],
    ma: [0, 2],
    guan: [1, 0],
    huang: [3, 2],
    bing1: [1, 1],
    bing2: [2, 1],
    bing3: [1, 2],
    bing4: [2, 2],
  }
  for (const piece of state.pieces) {
    piece.x = positions[piece.id][0]
    piece.y = positions[piece.id][1]
  }
  return state
}

// ---------------------------------------------------------------------------
// §1 level metadata / layouts / task-spec level 1
// ---------------------------------------------------------------------------

test('§1 constants and save key', () => {
  assert.equal(api.GAME_ID, 'klotski')
  assert.equal(api.STORE_KEY, 'dsh.game.klotski.v1')
  assert.equal(api.SCHEMA_VERSION, 1)
  assert.equal(api.COLS, 4)
  assert.equal(api.ROWS, 5)
  assert.deepEqual(api.EXIT, { x: 1, y: 3, w: 2, h: 2 })
})

test('§1 at least 3 levels, unique ids, positive par', () => {
  assert.ok(api.LEVELS.length >= 3)
  const ids = new Set()
  for (const level of api.LEVELS) {
    assert.ok(!ids.has(level.id))
    ids.add(level.id)
    assert.ok(Number.isInteger(level.par) && level.par > 0)
    assert.ok(typeof level.name === 'string' && level.name.length > 0)
  }
})

for (let index = 0; index < api.LEVELS.length; index += 1) {
  test('§1 level ' + (index + 1) + ' "' + api.LEVELS[index].name + '" is a legal 4x5 layout', () => {
    const level = api.LEVELS[index]
    const state = api.createState(index)
    const grid = api.buildGrid(state)
    let empties = 0
    for (let i = 0; i < grid.length; i += 1) if (grid[i] === -1) empties += 1
    assert.equal(empties, 2)
    const kinds = {}
    for (const piece of level.pieces) kinds[piece.kind] = (kinds[piece.kind] || 0) + 1
    assert.equal(kinds.cao, 1)
    assert.equal(kinds.guan, 1)
    assert.equal(kinds.general, 4)
    assert.equal(kinds.soldier, 4)
    assert.equal(level.pieces.length, 10)
    assert.ok(level.par >= 70, 'all four layouts are non-trivial')
  })
}

test('§1 level 1 is exactly the task-spec 横刀立马 layout', () => {
  const level = api.LEVELS[0]
  assert.equal(level.name, '横刀立马')
  const expected = {
    zhang: [0, 0],
    cao: [1, 0],
    zhao: [3, 0],
    ma: [0, 2],
    guan: [1, 2],
    huang: [3, 2],
    bing1: [1, 3],
    bing2: [2, 3],
    bing3: [0, 4],
    bing4: [3, 4],
  }
  assert.equal(level.pieces.length, Object.keys(expected).length)
  for (const piece of level.pieces) {
    assert.deepEqual([piece.x, piece.y], expected[piece.id], 'piece ' + piece.id)
  }
})

// ---------------------------------------------------------------------------
// §2 createState / initial moves
// ---------------------------------------------------------------------------

test('§2 createState copies level definition into a fresh state', () => {
  const state = api.createState(0)
  assert.equal(state.levelIndex, 0)
  assert.equal(state.moves, 0)
  assert.equal(state.elapsedMs, 0)
  assert.equal(state.started, false)
  assert.equal(state.won, false)
  assert.deepEqual(state.undo, [])
  assert.equal(state.pieces.length, 10)
  assert.equal(state.pieces[0].id, 'zhang')
  const cao = state.pieces.find((piece) => piece.id === 'cao')
  assert.equal(cao.x, 1)
  assert.equal(cao.y, 0)
})

test('§2 initial 横刀立马 has exactly 6 legal slides (soldiers only)', () => {
  const state = api.createState(0)
  const all = []
  for (let i = 0; i < state.pieces.length; i += 1) {
    for (const move of api.listMoves(state, i)) all.push({ id: state.pieces[i].id, move })
  }
  assert.equal(all.length, 6)
  const summary = all.map((entry) => entry.id + ':' + entry.move.dx + ',' + entry.move.dy + 'x' + entry.move.step).sort()
  assert.deepEqual(summary, ['bing1:0,1x1', 'bing2:0,1x1', 'bing3:1,0x1', 'bing3:1,0x2', 'bing4:-1,0x1', 'bing4:-1,0x2'])
})

// ---------------------------------------------------------------------------
// §3 canSlide
// ---------------------------------------------------------------------------

test('§3 one-cell slide into an empty cell is legal', () => {
  const state = api.createState(0)
  assert.equal(api.canSlide(state, pieceIndex(state, 'bing1'), 0, 1, 1), true)
  assert.equal(api.canSlide(state, pieceIndex(state, 'bing2'), 0, 1, 1), true)
})

test('§3 two-cell slide needs both entered cells empty', () => {
  const state = api.createState(0)
  assert.equal(api.canSlide(state, pieceIndex(state, 'bing3'), 1, 0, 2), true)
  assert.equal(api.canSlide(state, pieceIndex(state, 'bing4'), -1, 0, 2), true)
  // Move bing1 into (1,4): bing3 can then enter (1,4) but not continue to (2,4).
  const next = api.applySlide(state, pieceIndex(state, 'bing1'), 0, 1, 1)
  assert.ok(next)
  assert.equal(api.canSlide(next, pieceIndex(next, 'bing3'), 1, 0, 1), false)
  assert.equal(api.canSlide(next, pieceIndex(next, 'bing3'), 1, 0, 2), false)
})

test('§3 two-cell slide is rejected when the first entered cell is occupied', () => {
  const state = api.createState(0)
  // bing1 at (1,3) cannot move 2 cells down: (1,4) is empty but (1,5) is out of bounds.
  assert.equal(api.canSlide(state, pieceIndex(state, 'bing1'), 0, 1, 2), false)
})

test('§3 moving piece may pass through / into its own current cells', () => {
  const level3 = api.createState(2) // 齐头并进: ma at (0,2), bing3 at (0,4)
  const bing3 = pieceIndex(level3, 'bing3')
  assert.equal(api.canSlide(level3, bing3, 1, 0, 1), true) // (0,4) -> (1,4)
  const moved = api.applySlide(level3, bing3, 1, 0, 1)
  assert.ok(moved)
  // ma (0,2)-(0,3): slide down one cell; (0,3) is its own cell, (0,4) is now empty.
  assert.equal(api.canSlide(moved, pieceIndex(moved, 'ma'), 0, 1, 1), true)
})

test('§3 illegal directions / steps are rejected', () => {
  const state = api.createState(0)
  const bing = pieceIndex(state, 'bing1')
  assert.equal(api.canSlide(state, bing, 0, 0, 1), false, 'zero vector')
  assert.equal(api.canSlide(state, bing, 1, 1, 1), false, 'diagonal')
  assert.equal(api.canSlide(state, bing, 0, 1, 0), false, 'step 0')
  assert.equal(api.canSlide(state, bing, 0, 1, 3), false, 'step 3')
  assert.equal(api.canSlide(state, -1, 0, 1, 1), false, 'bad piece index')
  assert.equal(api.canSlide(state, 99, 0, 1, 1), false, 'bad piece index')
})

test('§3 blocked piece cannot move', () => {
  const state = api.createState(0)
  assert.equal(api.canSlide(state, pieceIndex(state, 'cao'), 0, 1, 1), false)
  assert.equal(api.canSlide(state, pieceIndex(state, 'cao'), -1, 0, 1), false)
  assert.equal(api.canSlide(state, pieceIndex(state, 'zhang'), 0, 1, 1), false)
  assert.equal(api.canSlide(state, pieceIndex(state, 'guan'), 0, 1, 1), false)
})

// ---------------------------------------------------------------------------
// §4 listMoves / destinations
// ---------------------------------------------------------------------------

test('§4 destinations map: bing3 can slide right 1 or 2', () => {
  const state = api.createState(0)
  const map = api.destinations(state, pieceIndex(state, 'bing3'))
  assert.deepEqual(Object.keys(map).sort(), ['1,4', '2,4'])
  assert.equal(map['1,4'].step, 1)
  assert.equal(map['2,4'].step, 2)
  assert.equal(map['1,4'].x, 1)
  assert.equal(map['1,4'].y, 4)
})

test('§4 destinations for a blocked piece is empty', () => {
  const state = api.createState(0)
  assert.equal(Object.keys(api.destinations(state, pieceIndex(state, 'cao'))).length, 0)
  assert.equal(api.listMoves(state, pieceIndex(state, 'cao')).length, 0)
})

// ---------------------------------------------------------------------------
// §5 applySlide / undo / restart
// ---------------------------------------------------------------------------

test('§5 applySlide is immutable and records one undo snapshot', () => {
  const state = api.createState(0)
  deepFreeze(state)
  const frozenSnapshot = JSON.stringify(state)
  const bing1 = pieceIndex(state, 'bing1')
  const next = api.applySlide(state, bing1, 0, 1, 1)
  assert.ok(next)
  assert.equal(JSON.stringify(state), frozenSnapshot, 'source state must not mutate')
  assert.equal(next.moves, 1)
  assert.equal(next.started, true)
  assert.equal(next.pieces[bing1].y, 4)
  assert.equal(next.undo.length, 1)
  assert.deepEqual(next.undo[0].pieces, state.pieces)
  assert.equal(next.undo[0].moves, 0)
  assert.equal(next.won, false)
})

test('§5 illegal applySlide returns null and does not mutate', () => {
  const state = api.createState(0)
  const before = JSON.stringify(state)
  assert.equal(api.applySlide(state, pieceIndex(state, 'cao'), 0, 1, 1), null)
  assert.equal(api.applySlide(state, pieceIndex(state, 'bing1'), 0, 1, 3), null)
  assert.equal(JSON.stringify(state), before)
})

test('§5 undoState restores pieces + moves and leaves elapsed alone', () => {
  let state = api.createState(0)
  state.elapsedMs = 12345
  state.started = true
  const first = api.applySlide(state, pieceIndex(state, 'bing1'), 0, 1, 1)
  const second = api.applySlide(first, pieceIndex(first, 'bing2'), 0, 1, 1)
  assert.equal(second.moves, 2)
  assert.equal(second.undo.length, 2)
  assert.equal(second.elapsedMs, 12345)
  const undone = api.undoState(second)
  assert.ok(undone)
  assert.equal(undone.moves, 1)
  assert.equal(undone.pieces[pieceIndex(undone, 'bing2')].y, 3)
  assert.equal(undone.undo.length, 1)
  assert.equal(undone.elapsedMs, 12345)
  const root = api.undoState(undone)
  assert.equal(root.moves, 0)
  assert.deepEqual(root.pieces, api.createState(0).pieces)
  assert.equal(api.undoState(root), null)
})

test('§5 undo stack is capped at UNDO_LIMIT', () => {
  let state = api.createState(0)
  // Alternate bing3 right/left 250 times; undo snapshots must stay capped.
  for (let i = 0; i < 250; i += 1) {
    const move = i % 2 === 0 ? [1, 0] : [-1, 0]
    const next = api.applySlide(state, pieceIndex(state, 'bing3'), move[0], move[1], 1)
    assert.ok(next, 'alternating soldier slides must stay legal')
    state = next
  }
  assert.equal(state.undo.length, api.UNDO_LIMIT)
})

test('§5 restartState resets progress but keeps best records', () => {
  let state = api.createState(0)
  state = api.applySlide(state, pieceIndex(state, 'bing1'), 0, 1, 1)
  state.started = true
  state.elapsedMs = 5000
  state.best = { hengdao: { moves: 90, elapsedMs: 60000 } }
  const fresh = api.restartState(state)
  assert.equal(fresh.levelIndex, 0)
  assert.equal(fresh.moves, 0)
  assert.equal(fresh.elapsedMs, 0)
  assert.equal(fresh.started, false)
  assert.equal(fresh.won, false)
  assert.deepEqual(fresh.pieces, api.createState(0).pieces)
  assert.deepEqual(fresh.best, { hengdao: { moves: 90, elapsedMs: 60000 } })
})

// ---------------------------------------------------------------------------
// §6 win
// ---------------------------------------------------------------------------

test('§6 isWon is true only when Cao Cao top-left reaches the exit', () => {
  const state = api.createState(0)
  assert.equal(api.isWon(state), false)
  const won = winningState()
  assert.equal(api.isWon(won), true)
  assert.equal(won.pieces[pieceIndex(won, 'cao')].x, 1)
  assert.equal(won.pieces[pieceIndex(won, 'cao')].y, 3)
})

test('§6 constructing the winning arrangement is a legal layout', () => {
  const won = winningState()
  const grid = api.buildGrid(won)
  let empties = 0
  for (let i = 0; i < grid.length; i += 1) if (grid[i] === -1) empties += 1
  assert.equal(empties, 2)
})

test('§6 sliding into the exit flips won', () => {
  // Hand-built near-win layout: Cao Cao at (1,2) and only (1,4)/(2,4) empty,
  // so a single slide down brings its top-left to the exit (1,3).
  const state = api.createState(0)
  const layout = {
    zhang: [0, 0],
    zhao: [3, 0],
    ma: [0, 2],
    huang: [3, 2],
    guan: [1, 0],
    cao: [1, 2],
    bing1: [0, 4],
    bing2: [3, 4],
    bing3: [1, 1],
    bing4: [2, 1],
  }
  for (const piece of state.pieces) {
    piece.x = layout[piece.id][0]
    piece.y = layout[piece.id][1]
  }
  // Verify the layout is legal first (exactly two empty cells at (1,4)/(2,4)).
  api.buildGrid(state)
  assert.equal(api.isWon(state), false)
  const next = api.applySlide(state, pieceIndex(state, 'cao'), 0, 1, 1)
  assert.ok(next, 'Cao Cao can slide down into the exit')
  assert.equal(next.won, true)
  assert.equal(next.pieces[pieceIndex(next, 'cao')].y, 3)
})

// ---------------------------------------------------------------------------
// §7 save roundtrip
// ---------------------------------------------------------------------------

test('§7 serializeState/sanitizeSave roundtrip preserves the game', () => {
  let state = api.createState(0)
  state = api.applySlide(state, pieceIndex(state, 'bing1'), 0, 1, 1)
  state = api.applySlide(state, pieceIndex(state, 'bing2'), 0, 1, 1)
  state.elapsedMs = 31250
  state.started = true
  state.best = { qitou: { moves: 76, elapsedMs: 40000 } }
  const raw = api.serializeState(state)
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.levelIndex, 0)
  assert.equal(raw.moves, 2)
  assert.equal(raw.elapsedMs, 31250)
  const restored = api.sanitizeSave(JSON.parse(JSON.stringify(raw)))
  assert.ok(restored)
  assert.deepEqual(restored, state)
})

test('§7 sanitizeSave accepts shuffled piece order and canonicalises it', () => {
  const state = api.createState(0)
  const raw = api.serializeState(state)
  raw.pieces = raw.pieces.slice().reverse()
  const restored = api.sanitizeSave(raw)
  assert.ok(restored)
  assert.deepEqual(restored.pieces, state.pieces)
})

test('§7 sanitizeSave accepts a winning save', () => {
  const won = winningState()
  won.moves = 42
  won.started = true
  won.elapsedMs = 90000
  won.won = true
  const raw = api.serializeState(won)
  const restored = api.sanitizeSave(raw)
  assert.ok(restored)
  assert.equal(restored.won, true)
  assert.equal(restored.moves, 42)
})

test('§7 specific bad saves are rejected', () => {
  const good = api.serializeState(api.createState(0))
  const cases = [
    null,
    undefined,
    'string',
    42,
    [],
    {},
    Object.assign({}, good, { schemaVersion: 2 }),
    Object.assign({}, good, { schemaVersion: '1' }),
    Object.assign({}, good, { levelIndex: -1 }),
    Object.assign({}, good, { levelIndex: 4 }),
    Object.assign({}, good, { levelIndex: 1.5 }),
    Object.assign({}, good, { pieces: null }),
    Object.assign({}, good, { pieces: good.pieces.slice(1) }),
    Object.assign({}, good, { pieces: good.pieces.concat([good.pieces[0]]) }),
    Object.assign({}, good, { moves: -1 }),
    Object.assign({}, good, { moves: 1e9 }),
    Object.assign({}, good, { elapsedMs: -5 }),
    Object.assign({}, good, { elapsedMs: api.UNDO_LIMIT * 1e9 }),
    Object.assign({}, good, { started: 'yes' }),
    Object.assign({}, good, { won: 'yes' }),
    Object.assign({}, good, { won: true }),
  ]
  const overlap = JSON.parse(JSON.stringify(good))
  overlap.pieces[0].x = 1
  overlap.pieces[0].y = 0 // zhang onto Cao Cao
  cases.push(overlap)
  const outOfBounds = JSON.parse(JSON.stringify(good))
  outOfBounds.pieces[0].x = -1
  cases.push(outOfBounds)
  const unknownPiece = JSON.parse(JSON.stringify(good))
  unknownPiece.pieces[0].id = 'mystery'
  cases.push(unknownPiece)
  const describe = (value) => {
    try {
      const text = JSON.stringify(value)
      return text === undefined ? String(value) : text.slice(0, 80)
    } catch (ignored) {
      return String(value)
    }
  }
  for (const value of cases) assert.equal(api.sanitizeSave(value), null, 'must reject: ' + describe(value))
})

test('§7 bad undo entries are dropped, not fatal', () => {
  const state = api.applySlide(api.createState(0), pieceIndex(api.createState(0), 'bing1'), 0, 1, 1)
  const raw = api.serializeState(state)
  raw.undo = [
    { pieces: raw.pieces, moves: 0 },
    { pieces: null, moves: 0 },
    { pieces: raw.pieces, moves: 999 },
    'nope',
    null,
  ]
  const restored = api.sanitizeSave(raw)
  assert.ok(restored)
  assert.equal(restored.undo.length, 1)
  assert.equal(restored.undo[0].moves, 0)
})

test('§7 best records are sanitised', () => {
  const raw = api.serializeState(api.createState(0))
  raw.best = {
    hengdao: { moves: 90, elapsedMs: 60000 },
    zhihui: { moves: -3, elapsedMs: 1 },
    qitou: { moves: 76, elapsedMs: 'x' },
    cengceng: 'bad',
    unknown: { moves: 10, elapsedMs: 10 },
  }
  const restored = api.sanitizeSave(raw)
  assert.ok(restored)
  assert.deepEqual(restored.best, { hengdao: { moves: 90, elapsedMs: 60000 } })
})

test('§7 loadSavedState / persistState use only dsh.game.klotski.v1', () => {
  storage.clear()
  const state = api.createState(3)
  state.moves = 3
  assert.equal(api.persistState(state), true)
  assert.deepEqual(Array.from(storage.keys()), ['dsh.game.klotski.v1'])
  const loaded = api.loadSavedState()
  assert.ok(loaded)
  assert.equal(loaded.levelIndex, 3)
  assert.equal(loaded.moves, 3)
  storage.set('dsh.game.klotski.v1', '{bad json')
  assert.equal(api.loadSavedState(), null)
  storage.set('dsh.game.klotski.v1', JSON.stringify({ schemaVersion: 0 }))
  assert.equal(api.loadSavedState(), null)
  storage.clear()
})

// ---------------------------------------------------------------------------
// §8 bad-save fuzz
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('§8 3,000 mutated saves: sanitizeSave never throws, accepts are valid', () => {
  const random = mulberry32(0x4b1c)
  let seedState = api.createState(0)
  seedState = api.applySlide(seedState, pieceIndex(seedState, 'bing1'), 0, 1, 1)
  seedState.elapsedMs = 15000
  seedState.started = true
  seedState.best = { hengdao: { moves: 90, elapsedMs: 72000 } }
  const base = api.serializeState(seedState)
  const pick = (list) => list[Math.floor(random() * list.length)]
  let accepted = 0
  let rejected = 0
  for (let i = 0; i < 3000; i += 1) {
    const copy = JSON.parse(JSON.stringify(base))
    const mutations = 1 + Math.floor(random() * 3)
    for (let m = 0; m < mutations; m += 1) {
      const target = Math.floor(random() * 8)
      if (target === 0) copy.schemaVersion = pick([0, 2, '1', null, undefined, true])
      else if (target === 1) copy.levelIndex = pick([-1, 4, 1.5, '1', null, undefined, 0])
      else if (target === 2) copy.moves = pick([-1, 100001, 1.5, '3', null, undefined, 0])
      else if (target === 3) copy.elapsedMs = pick([-1, 604800001, 1.5, 'x', null, undefined, 0])
      else if (target === 4) copy.started = pick([true, false, 'true', 1, null, undefined])
      else if (target === 5) copy.won = pick([true, false, 'true', 1, null, undefined])
      else if (target === 6) {
        if (Array.isArray(copy.pieces) && copy.pieces.length) {
          const piece = copy.pieces[Math.floor(random() * copy.pieces.length)]
          if (piece && typeof piece === 'object') {
            const field = pick(['x', 'y', 'id'])
            if (field === 'id') piece.id = pick(['cao', 'nope', 42, null])
            else piece[field] = pick([-1, 4, 1.5, '2', null, undefined])
          } else copy.pieces = pick([null, 'x', [], [null]])
        } else copy.pieces = pick([null, 'x', [], [null, 1]])
      } else {
        if (Array.isArray(copy.undo)) {
          copy.undo = pick([
            null,
            'x',
            [],
            [null],
            [{ pieces: null, moves: 0 }],
            [{ pieces: copy.pieces, moves: -1 }],
            copy.undo.slice(0, 1),
          ])
        } else copy.undo = pick([null, 'x', 1])
      }
    }
    let result
    try {
      result = api.sanitizeSave(copy)
      if (result) {
        accepted += 1
        assert.ok(result.levelIndex >= 0 && result.levelIndex < api.LEVELS.length)
        assert.ok(result.moves >= 0 && result.moves <= 100000)
        assert.ok(result.elapsedMs >= 0)
        assert.equal(result.won, api.isWon(result))
        assert.equal(result.pieces.length, api.LEVELS[result.levelIndex].pieces.length)
        api.buildGrid(result)
        for (const snap of result.undo) {
          api.buildGrid({ levelIndex: result.levelIndex, pieces: snap.pieces })
          assert.ok(snap.moves >= 0 && snap.moves <= result.moves)
        }
      } else {
        rejected += 1
      }
    } catch (error) {
      throw new Error('sanitizeSave threw on mutation case ' + i + ': ' + error.message)
    }
  }
  assert.ok(accepted > 0, 'some mutations should still be acceptable')
  assert.ok(rejected > accepted, 'a large majority of mutations should be rejected')
  results.push({ suite: 'bad-save fuzz', detail: accepted + ' accepted / ' + rejected + ' rejected / 0 throws' })
})

// ---------------------------------------------------------------------------
// §9 formatTime
// ---------------------------------------------------------------------------

test('§9 formatTime', () => {
  assert.equal(api.formatTime(0), '00:00')
  assert.equal(api.formatTime(999), '00:00')
  assert.equal(api.formatTime(1000), '00:01')
  assert.equal(api.formatTime(59000), '00:59')
  assert.equal(api.formatTime(60000), '01:00')
  assert.equal(api.formatTime(3599000), '59:59')
  assert.equal(api.formatTime(3600000), '1:00:00')
  assert.equal(api.formatTime(3661000), '1:01:01')
  assert.equal(api.formatTime(-5), '00:00')
  assert.equal(api.formatTime(NaN), '00:00')
})

// ---------------------------------------------------------------------------
// §10 slot registration shape
// ---------------------------------------------------------------------------

test('§10 module id / factory / inject / game.stage registration', () => {
  assert.equal(loadedDefinition.id, '@local/dsh-game-klotski')
  assert.equal(typeof loadedDefinition.factory, 'function')
  const requireCalls = []
  const mod = loadedDefinition.factory((name) => {
    requireCalls.push(name)
    if (name === 'react') return globalThis.window.FakeReact
    throw new Error('unexpected require: ' + name)
  })
  assert.deepEqual(requireCalls, ['react'])
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')

  const calls = []
  const ctx = {
    slots: {
      inject(name, callback) {
        calls.push({ kind: 'inject', name })
        const registered = callback()
        calls.push({ kind: 'registered', registered })
        return registered
      },
      register(config, component) {
        calls.push({ kind: 'register', config, component })
        return { config, component }
      },
    },
  }
  mod.apply(ctx)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], { kind: 'inject', name: 'game.stage' })
  const registerCall = calls.find((call) => call.kind === 'register')
  assert.ok(registerCall)
  assert.equal(registerCall.config.name, 'game.stage')
  assert.equal(registerCall.config.id, 'klotski')
  assert.equal(typeof registerCall.config.label, 'function')
  assert.equal(registerCall.config.label(), '华容道')
  assert.equal(typeof registerCall.config.select, 'function')
  assert.deepEqual(registerCall.config.select({ gameId: 'klotski' }), {})
  assert.equal(registerCall.config.select({ gameId: '2048' }), null)
  assert.equal(registerCall.config.select({}), null)
  assert.equal(typeof registerCall.component, 'function')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed')
for (const row of results) console.log('  ' + row.suite + ': ' + row.detail)
if (failed > 0) {
  console.error('\nFAILED')
  for (const failure of failures) console.error('- ' + failure.name + ': ' + failure.error.message)
  process.exit(1)
}
console.log('LOGIC TESTS OK')
