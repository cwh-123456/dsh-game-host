/**
 * Pure-logic self test for @local/dsh-game-tetris.
 *
 * Run: node dev/test-logic.mjs
 *
 * The browser bundle is the only entry, so the test imports client.js with a
 * minimal `window` stub and uses the opt-in test seam
 * (`window.__DSH_GAME_TETRIS_TEST__ = true`). No React, canvas or host needed.
 */
import assert from 'node:assert/strict'

const storage = new Map()
let loadedDefinition = null

globalThis.window = {
  __DSH_GAME_TETRIS_TEST__: true,
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

const api = globalThis.window.__DSH_GAME_TETRIS__
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
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function fresh(seed) {
  return api.freshState(makeRng(seed === undefined ? 1 : seed))
}

function rowsText(board) {
  return board
    .map(function (row) {
      return row
        .map(function (value) {
          return value === 0 ? '.' : String(value)
        })
        .join('')
    })
    .join('\n')
}

function cellSet(cells) {
  const set = new Set()
  for (const cell of cells) set.add(cell[0] + ',' + cell[1])
  return set
}

function riggedState() {
  const state = fresh(99)
  state.board = api.createEmptyBoard()
  state.current = null
  state.score = 0
  state.lines = 0
  state.level = 1
  state.over = false
  return state
}

// ---------------------------------------------------------------------------
// Registration / contract shape
// ---------------------------------------------------------------------------

test('module loader id equals the package name', () => {
  assert.equal(loadedDefinition.id, '@local/dsh-game-tetris')
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
    useState(value) {
      return [value, function () {}]
    },
    useCallback(fn) {
      return fn
    },
    Component: class Component {
      constructor(props) {
        this.props = props
      }
    },
  }

  const calls = { inject: [], register: [] }
  const ctx = {
    slots: {
      inject(name, callback) {
        calls.inject.push(name)
        calls.callback = callback
      },
      register(config, component) {
        calls.register.push({ config, component })
        return function () {}
      },
    },
  }

  const plugin = loadedDefinition.factory(function (name) {
    assert.equal(name, 'react')
    return ReactStub
  })
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')

  plugin.apply(ctx)
  assert.deepEqual(calls.inject, ['game.stage'])
  assert.equal(typeof calls.callback, 'function')

  calls.callback()
  assert.equal(calls.register.length, 1)
  const registration = calls.register[0]
  assert.equal(registration.config.name, 'game.stage')
  assert.equal(registration.config.id, 'tetris')
  assert.equal(typeof registration.config.label, 'function')
  assert.equal(registration.config.label(), '俄罗斯方块')
  assert.equal(typeof registration.config.select, 'function')
  assert.ok(registration.config.select({ gameId: 'tetris' }))
  assert.equal(registration.config.select({ gameId: '2048' }), null)
  assert.equal(registration.config.select({}), null)
  assert.equal(registration.config.select(null), null)
  assert.equal(typeof registration.component, 'function')
})

test('a failing slot registration is swallowed (host may be absent)', () => {
  const ReactStub = {
    createElement() {},
    useRef() {
      return { current: null }
    },
    useEffect() {},
    useState(value) {
      return [value, function () {}]
    },
    useCallback(fn) {
      return fn
    },
    Component: class {},
  }
  const errors = []
  const originalError = console.error
  console.error = function () {
    errors.push(Array.prototype.slice.call(arguments).join(' '))
  }
  try {
    const plugin = loadedDefinition.factory(function () {
      return ReactStub
    })
    plugin.apply({
      slots: {
        inject(name, callback) {
          callback()
        },
        register() {
          throw new Error('slot missing')
        },
      },
    })
  } finally {
    console.error = originalError
  }
  assert.ok(errors.some((line) => line.includes('slot registration failed')))
})

// ---------------------------------------------------------------------------
// Pieces / rotations
// ---------------------------------------------------------------------------

test('there are 7 piece types with 4 rotations of 4 cells each', () => {
  assert.deepEqual(api.PIECE_TYPES.slice().sort(), ['I', 'J', 'L', 'O', 'S', 'T', 'Z'])
  for (const type of api.PIECE_TYPES) {
    const def = api.PIECES[type]
    assert.equal(def.matrices.length, 4, type + ' should have 4 rotations')
    assert.equal(def.cellsByRot.length, 4)
    for (let rot = 0; rot < 4; rot += 1) {
      assert.equal(def.cellsByRot[rot].length, 4, type + ' rot ' + rot + ' should have 4 cells')
      assert.equal(cellSet(def.cellsByRot[rot]).size, 4, type + ' rot ' + rot + ' cells must be unique')
      for (const cell of def.cellsByRot[rot]) {
        assert.ok(cell[0] >= 0 && cell[0] < def.size)
        assert.ok(cell[1] >= 0 && cell[1] < def.size)
      }
    }
  }
  assert.equal(api.PIECES.I.size, 4)
  assert.equal(api.PIECES.O.size, 2)
  for (const type of ['T', 'S', 'Z', 'J', 'L']) assert.equal(api.PIECES[type].size, 3)
})

test('rotating a piece four times returns the original state', () => {
  const board = api.createEmptyBoard()
  for (const type of api.PIECE_TYPES) {
    let piece = api.makeSpawnPiece(type)
    const start = { type: piece.type, rot: piece.rot, x: piece.x, y: piece.y }
    for (let step = 0; step < 4; step += 1) {
      piece = api.rotatePiece(board, piece, 1)
      assert.ok(piece, type + ' should rotate on an empty board')
    }
    assert.equal(piece.rot, start.rot)
    assert.equal(piece.x, start.x)
    assert.equal(piece.y, start.y)
    assert.deepEqual(api.PIECES[type].cellsByRot[piece.rot], api.PIECES[type].cellsByRot[start.rot])
  }
})

test('every piece spawns unblocked with its bottom on the first visible row', () => {
  const board = api.createEmptyBoard()
  for (const type of api.PIECE_TYPES) {
    const piece = api.makeSpawnPiece(type)
    assert.equal(piece.rot, 0)
    assert.equal(api.collides(board, piece), false, type + ' spawn must not collide')
    const cells = api.PIECES[type].cellsByRot[0]
    let maxRow = -1
    let minCol = 99
    let maxCol = -1
    for (const cell of cells) {
      maxRow = Math.max(maxRow, piece.y + cell[1])
      minCol = Math.min(minCol, piece.x + cell[0])
      maxCol = Math.max(maxCol, piece.x + cell[0])
    }
    assert.equal(maxRow, api.HIDDEN_ROWS, type + ' bottom should sit on the first visible row')
    assert.ok(minCol >= 0 && maxCol < api.COLS, type + ' spawn must stay inside columns')
  }
})

// ---------------------------------------------------------------------------
// 7-bag
// ---------------------------------------------------------------------------

function takeSequence(seed, count) {
  const rng = makeRng(seed)
  const state = api.freshState(rng)
  const sequence = [state.current.type]
  for (let index = 1; index < count; index += 1) sequence.push(api.takeNext(state, rng))
  return sequence
}

test('7-bag: every group of 7 consecutive pieces contains each type once', () => {
  const sequence = takeSequence(12345, 21)
  const expected = api.PIECE_TYPES.slice().sort().join('')
  for (let group = 0; group < 3; group += 1) {
    const slice = sequence.slice(group * 7, group * 7 + 7)
    assert.equal(slice.slice().sort().join(''), expected, 'bag ' + group)
  }
})

test('7-bag: the same seed produces the same sequence', () => {
  assert.deepEqual(takeSequence(777, 30), takeSequence(777, 30))
})

test('7-bag: no piece is dealt three times before the other six appear', () => {
  const sequence = takeSequence(2024, 70)
  for (let index = 0; index + 7 <= sequence.length; index += 7) {
    const window = sequence.slice(index, index + 7)
    assert.equal(new Set(window).size, 7)
  }
})

// ---------------------------------------------------------------------------
// Collision / movement / ghost
// ---------------------------------------------------------------------------

test('collision detects walls, floor and filled cells', () => {
  const board = api.createEmptyBoard()
  const i = { type: 'I', rot: 0, x: 0, y: 1 }
  assert.equal(api.collides(board, i), false)
  assert.equal(api.collides(board, { type: 'I', rot: 0, x: -1, y: 1 }), true)
  assert.equal(api.collides(board, { type: 'I', rot: 0, x: 7, y: 1 }), true)
  const o = { type: 'O', rot: 0, x: 4, y: 20 }
  assert.equal(api.collides(board, o), false)
  assert.equal(api.collides(board, { type: 'O', rot: 0, x: 4, y: 21 }), true)
  board[20][4] = 3
  assert.equal(api.collides(board, o), true)
  assert.equal(api.canMove(board, { type: 'O', rot: 0, x: 4, y: 19 }, 0, 1), false)
  assert.equal(api.canMove(board, { type: 'O', rot: 0, x: 2, y: 10 }, -1, 0), true)
})

test('ghost row lands on top of the stack', () => {
  const state = fresh(3)
  state.board = api.createEmptyBoard()
  for (let col = 0; col < api.COLS; col += 1) state.board[21][col] = 1
  const o = { type: 'O', rot: 0, x: 4, y: 1 }
  assert.equal(api.ghostRow(state.board, o), 19)

  state.board = api.createEmptyBoard()
  assert.equal(api.ghostRow(state.board, o), 20)
  const i = { type: 'I', rot: 0, x: 3, y: 1 }
  assert.equal(api.ghostRow(state.board, i), 20)
})

test('wall kick: rotate I next to a blocked column shifts left', () => {
  const state = fresh(4)
  state.board = api.createEmptyBoard()
  const piece = { type: 'I', rot: 0, x: 6, y: 1 }
  state.board[1][8] = 4 // vertical I would occupy column 8, rows 1-4
  const rotated = api.rotatePiece(state.board, piece, 1)
  assert.ok(rotated)
  assert.equal(rotated.rot, 1)
  assert.equal(rotated.x, 5)
  assert.equal(rotated.y, 1)
})

test('wall kick: rotate blocked on every candidate returns null', () => {
  const state = fresh(5)
  state.board = api.createEmptyBoard()
  const piece = { type: 'I', rot: 0, x: 3, y: 1 }
  // Surround every prospective vertical I column (box col 2 → columns 5,4,6,3,7)
  // and the floor-adjacent cells so no kick works.
  for (const col of [3, 4, 5, 6, 7]) {
    for (let row = 0; row < api.ROWS; row += 1) state.board[row][col] = 1
  }
  // Make the current horizontal I cells survive: rows 1-2 at columns 3-6 are
  // exactly the vertical candidates, so instead test an O piece: rotations are
  // identical and always possible; use a fully occupied board around a T.
  const t = { type: 'T', rot: 0, x: 3, y: 1 }
  const board = api.createEmptyBoard()
  for (let row = 0; row < api.ROWS; row += 1) {
    for (let col = 0; col < api.COLS; col += 1) board[row][col] = 1
  }
  // Hollow out exactly the spawn cells so the piece exists but every rotation cell
  // is blocked.
  for (let row = 1; row < 3; row += 1) {
    for (let col = 3; col < 6; col += 1) board[row][col] = 0
  }
  assert.equal(api.rotatePiece(board, t, 1), null)
})

test('clearFullLines removes full rows and shifts the stack down', () => {
  const board = api.createEmptyBoard()
  board[19][0] = 3
  for (let col = 0; col < api.COLS; col += 1) board[21][col] = 1
  const cleared = api.clearFullLines(board)
  assert.equal(cleared, 1)
  assert.equal(board[20][0], 3)
  assert.equal(board[21][0], 0)
  assert.equal(board[0][0], 0)
})

test('clearFullLines handles two or more rows at once', () => {
  const board = api.createEmptyBoard()
  board[18][9] = 7
  for (let col = 0; col < api.COLS; col += 1) {
    board[19][col] = 1
    board[20][col] = 2
    board[21][col] = 3
  }
  assert.equal(api.clearFullLines(board), 3)
  assert.equal(board[21][9], 7)
  for (let row = 0; row < 3; row += 1) assert.equal(board[row].every((value) => value === 0), true)
})

test('a line completed inside the hidden spawn rows is still cleared and scored', () => {
  const state = riggedState()
  // O at the very top: cells (4,0) (5,0) (4,1) (5,1). Fill row 1 around it.
  for (let col = 0; col < api.COLS; col += 1) {
    if (col !== 4 && col !== 5) state.board[1][col] = 1
  }
  state.current = { type: 'O', rot: 0, x: 4, y: 0 }
  const result = api.lockCurrent(state, makeRng(14))
  assert.equal(result.cleared, 1)
  assert.equal(result.gained, 100)
  assert.equal(state.lines, 1)
  // The O's lower half filled the hidden row; its upper half falls into the row
  // that was created at the top by the clear.
  assert.equal(state.board.flat().filter((value) => value !== 0).length, 2)
  assert.equal(state.board[1][4], api.TYPE_CODE.O)
  assert.equal(state.board[1][5], api.TYPE_CODE.O)
})

// ---------------------------------------------------------------------------
// Locking / scoring / levels
// ---------------------------------------------------------------------------

test('locking a piece writes it to the board and spawns the next one', () => {
  const state = riggedState()
  state.current = { type: 'O', rot: 0, x: 4, y: 20 }
  const queued = state.queue[0]
  const result = api.lockCurrent(state, makeRng(6))
  assert.equal(result.cleared, 0)
  assert.equal(result.gained, 0)
  assert.equal(state.score, 0)
  assert.equal(state.board[20][4], api.TYPE_CODE.O)
  assert.equal(state.board[21][5], api.TYPE_CODE.O)
  assert.ok(state.current)
  assert.equal(state.current.type, queued)
  assert.equal(state.canHold, true)
})

function craftClear(type, rot, x, y, lines, level) {
  const state = riggedState()
  state.lines = lines === undefined ? 0 : lines
  state.level = level === undefined ? Math.floor(state.lines / api.LINES_PER_LEVEL) + 1 : level
  state.score = 0
  const cells = api.PIECES[type].cellsByRot[rot]
  const touchedRows = new Set()
  const occupied = new Set()
  for (const cell of cells) {
    const row = y + cell[1]
    touchedRows.add(row)
    occupied.add(row + ',' + (x + cell[0]))
  }
  for (const row of touchedRows) {
    for (let col = 0; col < api.COLS; col += 1) {
      if (!occupied.has(row + ',' + col)) state.board[row][col] = 1
    }
  }
  state.current = { type, rot, x, y }
  return { state, rowCount: touchedRows.size }
}

test('1 line = 100 × level', () => {
  const crafted = craftClear('I', 0, 3, 20)
  assert.equal(crafted.rowCount, 1)
  const result = api.lockCurrent(crafted.state, makeRng(7))
  assert.equal(result.cleared, 1)
  assert.equal(result.gained, 100)
  assert.equal(crafted.state.score, 100)
  assert.equal(crafted.state.lines, 1)
  assert.equal(crafted.state.level, 1)
})

test('2 lines = 300 × level', () => {
  const crafted = craftClear('O', 0, 4, 20)
  assert.equal(crafted.rowCount, 2)
  const result = api.lockCurrent(crafted.state, makeRng(8))
  assert.equal(result.cleared, 2)
  assert.equal(result.gained, 300)
  assert.equal(crafted.state.score, 300)
  assert.equal(crafted.state.lines, 2)
})

test('3 lines = 500 × level', () => {
  const crafted = craftClear('T', 3, 4, 19)
  assert.equal(crafted.rowCount, 3)
  const result = api.lockCurrent(crafted.state, makeRng(9))
  assert.equal(result.cleared, 3)
  assert.equal(result.gained, 500)
  assert.equal(crafted.state.score, 500)
  assert.equal(crafted.state.lines, 3)
})

test('4 lines = 800 × level', () => {
  const crafted = craftClear('I', 1, 4, 18)
  assert.equal(crafted.rowCount, 4)
  const result = api.lockCurrent(crafted.state, makeRng(10))
  assert.equal(result.cleared, 4)
  assert.equal(result.gained, 800)
  assert.equal(crafted.state.score, 800)
  assert.equal(crafted.state.lines, 4)
})

test('clear score uses the current level before the level-up', () => {
  const crafted = craftClear('I', 0, 3, 20, 9, 1)
  const result = api.lockCurrent(crafted.state, makeRng(11))
  assert.equal(result.gained, 100) // level 1 at clear time
  assert.equal(crafted.state.lines, 10)
  assert.equal(crafted.state.level, 2)
})

test('level 3 clear scores 3×', () => {
  const crafted = craftClear('I', 0, 3, 20, 20, 3)
  const result = api.lockCurrent(crafted.state, makeRng(12))
  assert.equal(result.gained, 300)
  assert.equal(crafted.state.lines, 21)
  assert.equal(crafted.state.level, 3)
})

test('drop interval follows the requested curve', () => {
  assert.equal(api.dropIntervalMs(1), 800)
  assert.equal(api.dropIntervalMs(2), 740)
  assert.equal(api.dropIntervalMs(3), 680)
  assert.equal(api.dropIntervalMs(10), 260)
  assert.equal(api.dropIntervalMs(12), 140)
  assert.equal(api.dropIntervalMs(13), 80)
  assert.equal(api.dropIntervalMs(30), 80)
  assert.equal(api.dropIntervalMs(0), 800)
  assert.equal(api.dropIntervalMs(-5), 800)
})

test('spawn collision ends the game', () => {
  const state = riggedState()
  for (let col = 0; col < api.COLS; col += 1) state.board[2][col] = 1
  api.spawnNext(state, makeRng(13))
  assert.equal(state.over, true)
  assert.equal(state.current, null)
})

// ---------------------------------------------------------------------------
// Hold
// ---------------------------------------------------------------------------

test('hold stores once per piece, swaps after a lock and refuses while in use', () => {
  const state = fresh(21)
  const first = state.current.type
  const queued = state.queue[0]
  assert.equal(api.holdPiece(state, makeRng(21)), true)
  assert.equal(state.hold, first)
  assert.equal(state.current.type, queued)
  assert.equal(state.canHold, false)
  assert.equal(api.holdPiece(state, makeRng(21)), false)

  state.current = { type: 'O', rot: 0, x: 4, y: 20 }
  api.lockCurrent(state, makeRng(21))
  assert.equal(state.canHold, true)

  const beforeSwap = state.current.type
  assert.equal(api.holdPiece(state, makeRng(21)), true)
  assert.equal(state.hold, beforeSwap)
  assert.equal(state.current.type, first)
  assert.equal(state.canHold, false)
})

// ---------------------------------------------------------------------------
// Save / restore
// ---------------------------------------------------------------------------

function makeSave(overrides) {
  const state = fresh(31)
  const base = api.serializeState(state, false)
  return Object.assign(base, overrides || {})
}

test('serialize/sanitize round-trips a live state', () => {
  const state = fresh(32)
  state.score = 1234
  state.lines = 17
  state.level = 2
  state.playMs = 65432
  state.canHold = false
  state.hold = 'S'
  const saved = api.serializeState(state, true)
  assert.equal(saved.paused, true)
  assert.equal(saved.schemaVersion, 1)
  assert.equal(saved.board.length, api.ROWS)

  const restored = api.sanitizeState(saved)
  assert.ok(restored)
  assert.deepEqual(restored.board, state.board)
  assert.deepEqual(restored.current, state.current)
  assert.deepEqual(restored.queue, state.queue)
  assert.deepEqual(restored.bag, state.bag)
  assert.equal(restored.hold, 'S')
  assert.equal(restored.canHold, false)
  assert.equal(restored.score, 1234)
  assert.equal(restored.lines, 17)
  assert.equal(restored.level, 2)
  assert.equal(restored.playMs, 65432)
  assert.equal(restored.over, false)
  assert.equal(restored.paused, true)
})

test('sanitize recomputes level from lines', () => {
  const saved = makeSave({ lines: 25, level: 99 })
  const restored = api.sanitizeState(saved)
  assert.equal(restored.level, 3)
})

test('sanitize accepts a finished game without a current piece', () => {
  const saved = makeSave({ over: true, current: null })
  const restored = api.sanitizeState(saved)
  assert.ok(restored)
  assert.equal(restored.over, true)
  assert.equal(restored.current, null)
})

test('sanitize rejects corrupt / mismatched saves', () => {
  assert.equal(api.sanitizeState(null), null)
  assert.equal(api.sanitizeState({}), null)
  assert.equal(api.sanitizeState(makeSave({ schemaVersion: 2 })), null)

  const badBoard = api.createEmptyBoard()
  badBoard.pop()
  assert.equal(api.sanitizeState(makeSave({ board: badBoard })), null)

  const badCell = api.createEmptyBoard()
  badCell[5][5] = 8
  assert.equal(api.sanitizeState(makeSave({ board: badCell })), null)

  const fullRow = api.createEmptyBoard()
  for (let col = 0; col < api.COLS; col += 1) fullRow[7][col] = 1
  assert.equal(api.sanitizeState(makeSave({ board: fullRow })), null)

  assert.equal(api.sanitizeState(makeSave({ score: -1 })), null)
  assert.equal(api.sanitizeState(makeSave({ score: 1.5 })), null)
  assert.equal(api.sanitizeState(makeSave({ lines: -2 })), null)
  assert.equal(api.sanitizeState(makeSave({ playMs: 'x' })), null)
  assert.equal(api.sanitizeState(makeSave({ current: null })), null)
  assert.equal(api.sanitizeState(makeSave({ current: { type: 'Q', rot: 0, x: 3, y: 1 } })), null)
  assert.equal(api.sanitizeState(makeSave({ current: { type: 'T', rot: 4, x: 3, y: 1 } })), null)
  assert.equal(api.sanitizeState(makeSave({ queue: ['I', 'Q'] })), null)
  assert.equal(api.sanitizeState(makeSave({ bag: ['I', 'I'] })), null)
  assert.equal(api.sanitizeState(makeSave({ hold: 'Q' })), null)

  const collidingBoard = api.createEmptyBoard()
  collidingBoard[2][4] = 1
  assert.equal(api.sanitizeState(makeSave({ board: collidingBoard })), null)
})

test('hydrate fills the queue and derives the resting flag', () => {
  const save = makeSave()
  const restored = api.sanitizeState(save)
  const state = api.hydrateState(restored, makeRng(33))
  assert.ok(state.queue.length >= api.QUEUE_SHOWN)
  assert.equal(typeof state.resting, 'boolean')
  assert.equal(state.dropAccum, 0)
  assert.equal(state.lockAccum, 0)
})

test('serialize clamps absurd counters so a very long game still round-trips', () => {
  const state = fresh(41)
  state.score = 1000000000000
  state.lines = 1000000000000
  state.level = 100000000000
  state.playMs = 1000000000000
  const saved = api.serializeState(state, false)
  assert.equal(saved.score, 1000000000)
  assert.equal(saved.lines, 1000000)
  assert.equal(saved.playMs, 1000000000)
  const restored = api.sanitizeState(saved)
  assert.ok(restored, 'clamped save must still be restorable')
  assert.equal(restored.score, 1000000000)
  assert.equal(restored.lines, 1000000)
  assert.equal(restored.playMs, 1000000000)
})

test('formatTime renders m:ss', () => {
  assert.equal(api.formatTime(0), '0:00')
  assert.equal(api.formatTime(999), '0:00')
  assert.equal(api.formatTime(1000), '0:01')
  assert.equal(api.formatTime(61000), '1:01')
  assert.equal(api.formatTime(3599000), '59:59')
  assert.equal(api.formatTime(-5), '0:00')
})

test('computeLayout keeps the whole group inside the canvas', () => {
  const layout = api.computeLayout(1000, 700)
  assert.equal(layout.cell, 33)
  assert.equal(layout.board.w, 330)
  assert.equal(layout.board.h, 660)
  assert.ok(layout.side.x > layout.board.x + layout.board.w)
  assert.ok(layout.side.x + layout.side.w <= 1000)
  assert.ok(layout.board.y + layout.board.h <= 700)

  const tiny = api.computeLayout(100, 100)
  assert.equal(tiny.cell, 6)
  assert.ok(Number.isFinite(tiny.board.x))
  assert.ok(Number.isFinite(tiny.side.x))

  const zero = api.computeLayout(0, 0)
  assert.equal(zero.cell, 6)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
