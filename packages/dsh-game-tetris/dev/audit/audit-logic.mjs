/**
 * Independent read-only audit — pure game logic.
 *
 * Written by the verifier (not the implementer). It builds its own reference
 * implementations (rotation, collision, 7-bag continuation) instead of trusting
 * the package's self-tests. No files are modified.
 *
 * Run: node dev/audit/audit-logic.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

// Minimal browser stub just to import the browser bundle's test seam.
globalThis.window = {
  __DSH_GAME_TETRIS_TEST__: true,
  __ModuleLoader__: { load() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  performance: { now: () => 0 },
}
await import(pathToFileURL(path.join(root, 'client.js')).href)
const api = globalThis.window.__DSH_GAME_TETRIS__
assert.ok(api, 'test seam should be installed')

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    failed += 1
    failures.push(name + ': ' + (error && error.message))
    console.error('not ok - ' + name + ' :: ' + (error && error.message))
  }
}
const stats = {}
function bump(key, n) {
  stats[key] = (stats[key] || 0) + (n === undefined ? 1 : n)
}

// ---------------------------------------------------------------------------
// Independent helpers (reference implementations, not package code)
// ---------------------------------------------------------------------------
function makeRng(seed) {
  const box = { value: seed >>> 0 }
  return {
    next() {
      box.value = (Math.imul(box.value, 1664525) + 1013904223) >>> 0
      return box.value / 4294967296
    },
    clone() {
      const copy = makeRng(0)
      copy.value = box.value
      return copy
    },
    get value() {
      return box.value
    },
    set value(v) {
      box.value = v
    },
  }
}

function rotateCW(matrix) {
  const n = matrix.length
  const out = []
  for (let y = 0; y < n; y += 1) {
    const row = []
    for (let x = 0; x < n; x += 1) row.push(matrix[n - 1 - x][y])
    out.push(row)
  }
  return out
}

function ownCellSets(type) {
  const base = api.PIECES[type].matrices[0]
  const sets = []
  let matrix = base
  for (let rot = 0; rot < 4; rot += 1) {
    const cells = []
    for (let y = 0; y < matrix.length; y += 1) {
      for (let x = 0; x < matrix[y].length; x += 1) {
        if (matrix[y][x] === 1) cells.push([x, y])
      }
    }
    sets.push(cells)
    matrix = rotateCW(matrix)
  }
  return sets
}

function ownCells(type, rot) {
  return ownCellSets(type)[rot]
}

function ownCollides(board, piece) {
  const cells = ownCells(piece.type, piece.rot)
  for (const [dx, dy] of cells) {
    const x = piece.x + dx
    const y = piece.y + dy
    if (x < 0 || x >= api.COLS || y >= api.ROWS) return true
    if (y >= 0 && board[y][x] !== 0) return true
  }
  return false
}

function ownRotate(board, piece, direction) {
  const step = direction < 0 ? 3 : 1
  const nextRot = (piece.rot + step) % 4
  const kicks = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [-2, 0],
    [2, 0],
    [0, -1],
  ]
  for (const [dx, dy] of kicks) {
    const candidate = { type: piece.type, rot: nextRot, x: piece.x + dx, y: piece.y + dy }
    if (candidate.y < 0) continue
    if (!ownCollides(board, candidate)) return candidate
  }
  return null
}

function ownGhostRow(board, piece) {
  let row = piece.y
  while (!ownCollides(board, { type: piece.type, rot: piece.rot, x: piece.x, y: row + 1 })) row += 1
  return row
}

function emptyBoard() {
  return api.createEmptyBoard()
}

function cellSet(cells) {
  return new Set(cells.map(([x, y]) => x + ',' + y))
}

function distinctRotations(type) {
  const sets = ownCellSets(type).map(cellSet)
  const normalized = sets.map((set) => {
    const cells = [...set].map((key) => key.split(',').map(Number))
    const minX = Math.min(...cells.map((cell) => cell[0]))
    const minY = Math.min(...cells.map((cell) => cell[1]))
    return cells
      .map((cell) => cell[0] - minX + ',' + (cell[1] - minY))
      .sort()
      .join('|')
  })
  return new Set(normalized).size
}

function riggedState() {
  const rng = makeRng(99)
  const state = api.freshState(rng.next)
  state.board = emptyBoard()
  state.current = null
  state.score = 0
  state.lines = 0
  state.level = 1
  state.over = false
  state.canHold = true
  state.hold = null
  return state
}

/**
 * Fill every row the piece will occupy except the piece's own cells, so that
 * locking the piece completes exactly `touchedRows` lines.
 */
function craftRows(type, rot, x, y, linesBefore, levelOverride) {
  const state = riggedState()
  state.lines = linesBefore === undefined ? 0 : linesBefore
  state.level = levelOverride === undefined ? Math.floor(state.lines / api.LINES_PER_LEVEL) + 1 : levelOverride
  const cells = ownCells(type, rot)
  const touchedRows = new Set()
  const occupied = new Set()
  for (const [dx, dy] of cells) {
    const row = y + dy
    touchedRows.add(row)
    occupied.add(row + ',' + (x + dx))
  }
  for (const row of touchedRows) {
    for (let col = 0; col < api.COLS; col += 1) {
      if (!occupied.has(row + ',' + col)) state.board[row][col] = 1
    }
  }
  state.current = { type, rot, x, y }
  return { state, touchedRows: touchedRows.size }
}

// ---------------------------------------------------------------------------
// Board / pieces
// ---------------------------------------------------------------------------
check('board is 10 columns x 22 rows (2 hidden + 20 visible)', () => {
  assert.equal(api.COLS, 10)
  assert.equal(api.HIDDEN_ROWS, 2)
  assert.equal(api.VISIBLE_ROWS, 20)
  assert.equal(api.ROWS, 22)
  const board = api.createEmptyBoard()
  assert.equal(board.length, 22)
  for (const row of board) {
    assert.equal(row.length, 10)
    assert.ok(row.every((value) => value === 0))
  }
})
bump('board')

check('7 piece types, each with 4 rotation states of 4 unique cells', () => {
  assert.deepEqual(api.PIECE_TYPES.slice().sort(), ['I', 'J', 'L', 'O', 'S', 'T', 'Z'])
  let rotations = 0
  for (const type of api.PIECE_TYPES) {
    const def = api.PIECES[type]
    assert.equal(def.matrices.length, 4, type + ' matrices')
    assert.equal(def.cellsByRot.length, 4, type + ' rotations')
    for (let rot = 0; rot < 4; rot += 1) {
      assert.equal(def.cellsByRot[rot].length, 4, type + ' rot ' + rot + ' cell count')
      assert.equal(cellSet(def.cellsByRot[rot]).size, 4, type + ' rot ' + rot + ' unique')
      rotations += 1
    }
  }
  bump('piece rotations', rotations)
})

check('package rotation states equal an independent CW matrix rotation', () => {
  let cases = 0
  for (const type of api.PIECE_TYPES) {
    const expected = ownCellSets(type)
    for (let rot = 0; rot < 4; rot += 1) {
      assert.deepEqual(api.PIECES[type].cellsByRot[rot], expected[rot], type + ' rot ' + rot)
      cases += 1
    }
  }
  bump('rotation-state comparisons', cases)
})

check('rotation shape counts: O=1, I=2, S/Z=2, T/J/L=4 distinct orientations', () => {
  const expected = { I: 2, O: 1, T: 4, S: 2, Z: 2, J: 4, L: 4 }
  for (const type of api.PIECE_TYPES) {
    assert.equal(distinctRotations(type), expected[type], type)
    bump('distinct-orientation checks')
  }
})

check('rotating four times returns the same cells (7 types)', () => {
  const board = emptyBoard()
  let cases = 0
  for (const type of api.PIECE_TYPES) {
    let piece = api.makeSpawnPiece(type)
    const start = { type, rot: piece.rot, x: piece.x, y: piece.y }
    for (let step = 0; step < 4; step += 1) {
      piece = api.rotatePiece(board, piece, 1)
      assert.ok(piece, type + ' rotate step ' + step)
      assert.equal(ownCollides(board, piece), false)
    }
    assert.equal(piece.rot, start.rot)
    assert.equal(piece.x, start.x)
    assert.equal(piece.y, start.y)
    assert.deepEqual(api.PIECES[type].cellsByRot[piece.rot], api.PIECES[type].cellsByRot[start.rot])
    cases += 1
  }
  bump('rotation cycles', cases)
})

check('spawn: every piece bottom sits on the first visible row and fits', () => {
  const board = emptyBoard()
  for (const type of api.PIECE_TYPES) {
    const piece = api.makeSpawnPiece(type)
    assert.equal(api.collides(board, piece), false)
    let maxRow = -1
    let minCol = 99
    let maxCol = -1
    for (const [dx, dy] of ownCells(type, 0)) {
      maxRow = Math.max(maxRow, piece.y + dy)
      minCol = Math.min(minCol, piece.x + dx)
      maxCol = Math.max(maxCol, piece.x + dx)
    }
    assert.equal(maxRow, api.HIDDEN_ROWS, type + ' bottom row')
    assert.ok(minCol >= 0 && maxCol < api.COLS, type + ' spawn inside columns')
  }
})

// ---------------------------------------------------------------------------
// 7-bag randomizer
// ---------------------------------------------------------------------------
check('7-bag: 100 seeds x 10 aligned groups of 7 all contain the 7 types exactly once', () => {
  const expected = api.PIECE_TYPES.slice().sort().join('')
  let groups = 0
  let pieces = 0
  for (let seed = 1; seed <= 100; seed += 1) {
    const rng = makeRng(seed)
    const state = api.freshState(rng.next)
    const sequence = [state.current.type]
    for (let i = 1; i < 70; i += 1) sequence.push(api.takeNext(state, rng.next))
    assert.equal(sequence.length, 70)
    pieces += sequence.length
    for (let group = 0; group < 10; group += 1) {
      const slice = sequence.slice(group * 7, group * 7 + 7).slice().sort().join('')
      assert.equal(slice, expected, 'seed ' + seed + ' bag ' + group)
      groups += 1
    }
  }
  bump('7-bag groups', groups)
  bump('7-bag pieces', pieces)
})

check('7-bag: same seed reproduces the same 70-piece sequence', () => {
  const seq = (seed) => {
    const rng = makeRng(seed)
    const state = api.freshState(rng.next)
    const out = [state.current.type]
    for (let i = 1; i < 70; i += 1) out.push(api.takeNext(state, rng.next))
    return out
  }
  for (const seed of [1, 777, 424242]) assert.deepEqual(seq(seed), seq(seed))
})

check('7-bag survives a fresh start (restart path freshState) on 50 seeds', () => {
  const expected = api.PIECE_TYPES.slice().sort().join('')
  let groups = 0
  for (let seed = 1; seed <= 50; seed += 1) {
    const rng = makeRng(seed)
    const state = api.freshState(rng.next)
    const first7 = [state.current.type]
    for (let i = 1; i < 7; i += 1) first7.push(api.takeNext(state, rng.next))
    assert.equal(first7.slice().sort().join(''), expected, 'seed ' + seed)
    groups += 1
  }
  bump('restart bags', groups)
})

check('save/restore keeps the 7-bag sequence continuous (40 seeds x 12 cut points)', () => {
  let cases = 0
  let pieces = 0
  const cuts = [1, 3, 7, 11, 15, 19, 23, 29, 35, 41, 47, 53]
  for (let seed = 1; seed <= 40; seed += 1) {
    for (const cut of cuts) {
      const rngA = makeRng(seed)
      const stateA = api.freshState(rngA.next)
      for (let i = 1; i < cut; i += 1) api.takeNext(stateA, rngA.next)
      const expectedQueue = stateA.queue.slice()
      const expectedBag = (stateA.bag || []).slice()
      const saved = api.serializeState(stateA, false)
      const clean = api.sanitizeState(saved)
      assert.ok(clean, 'seed ' + seed + ' cut ' + cut + ' should sanitize')
      const rngB = rngA.clone()
      const stateB = api.hydrateState(clean, rngB.next)
      assert.deepEqual(stateB.queue, expectedQueue, 'queue preserved')
      assert.deepEqual(stateB.bag, expectedBag, 'bag preserved')
      for (let i = 0; i < 20; i += 1) {
        assert.equal(api.takeNext(stateB, rngB.next), api.takeNext(stateA, rngA.next), 'piece ' + i)
        pieces += 1
      }
      cases += 1
    }
  }
  bump('save/restore continuity cases', cases)
  bump('save/restore compared pieces', pieces)
})

check('hold does not disturb the 7-bag order', () => {
  const expected = api.PIECE_TYPES.slice().sort().join('')
  for (let seed = 1; seed <= 20; seed += 1) {
    const rng = makeRng(seed)
    const state = api.freshState(rng.next)
    const observed = [state.current.type]
    assert.equal(api.holdPiece(state, rng.next), true)
    observed.push(state.current.type)
    for (let i = 0; i < 40; i += 1) {
      // Park the current piece low so the stack never blocks the spawn area.
      const size = api.PIECES[state.current.type].size
      state.current = { type: state.current.type, rot: 0, x: Math.floor((api.COLS - size) / 2), y: 18 }
      state.board = emptyBoard() // keep the stack empty; only the spawn order matters
      api.lockCurrent(state, rng.next)
      assert.ok(state.current, 'spawn should succeed')
      observed.push(state.current.type)
    }
    assert.equal(observed.length, 42)
    for (let group = 0; group < 6; group += 1) {
      assert.equal(observed.slice(group * 7, group * 7 + 7).slice().sort().join(''), expected, 'seed ' + seed)
    }
  }
})

check('7-bag: every sliding window of 13 consecutive pieces contains all 7 types', () => {
  const all = api.PIECE_TYPES.slice().sort().join('')
  let windows = 0
  for (let seed = 1; seed <= 100; seed += 1) {
    const rng = makeRng(seed)
    const state = api.freshState(rng.next)
    const sequence = [state.current.type]
    for (let i = 1; i < 70; i += 1) sequence.push(api.takeNext(state, rng.next))
    for (let start = 0; start + 13 <= sequence.length; start += 1) {
      assert.equal(sequence.slice(start, start + 13).slice().sort().filter((v, i, a) => a.indexOf(v) === i).join(''), all, 'seed ' + seed + ' window ' + start)
      windows += 1
    }
  }
  bump('sliding 13-windows', windows)
})

check('hold swap does not consume a new piece from the bag', () => {
  const rng = makeRng(55)
  const state = api.freshState(rng.next)
  assert.equal(api.holdPiece(state, rng.next), true) // first hold: consumes next piece
  assert.equal(state.canHold, false)
  state.board = emptyBoard()
  state.current = { type: 'O', rot: 0, x: 4, y: 20 }
  api.lockCurrent(state, rng.next) // new piece -> hold available again
  assert.equal(state.canHold, true)
  const queueBefore = state.queue.slice()
  const bagBefore = (state.bag || []).slice()
  const heldType = state.hold
  const currentType = state.current.type
  assert.equal(api.holdPiece(state, rng.next), true)
  assert.deepEqual(state.queue, queueBefore, 'swap must not shift the queue')
  assert.deepEqual(state.bag, bagBefore, 'swap must not consume the bag')
  assert.equal(state.hold, currentType)
  assert.equal(state.current.type, heldType)
})

check('tuning constants match the spec', () => {
  assert.ok(api.QUEUE_SHOWN >= 3, 'next queue at least 3')
  assert.deepEqual(api.CLEAR_POINTS, [0, 100, 300, 500, 800])
  assert.equal(api.LOCK_DELAY_MS, 400)
  assert.equal(api.MAX_LOCK_RESETS, 15)
  assert.equal(api.LINES_PER_LEVEL, 10)
  assert.equal(api.SOFT_DROP_POINTS, 1)
  assert.equal(api.HARD_DROP_POINTS, 2)
})

// ---------------------------------------------------------------------------
// Collision / ghost
// ---------------------------------------------------------------------------
check('collision detects walls, floor and filled cells (hand cases)', () => {
  const board = emptyBoard()
  const i = { type: 'I', rot: 0, x: 0, y: 1 }
  assert.equal(api.collides(board, i), false)
  assert.equal(api.collides(board, { type: 'I', rot: 0, x: -1, y: 1 }), true)
  assert.equal(api.collides(board, { type: 'I', rot: 0, x: 7, y: 1 }), true)
  const o = { type: 'O', rot: 0, x: 4, y: 20 }
  assert.equal(api.collides(board, o), false)
  assert.equal(api.collides(board, { type: 'O', rot: 0, x: 4, y: 21 }), true)
  board[20][4] = 3
  assert.equal(api.collides(board, o), true)
  assert.equal(api.canMove(board, { type: 'O', rot: 0, x: 4, y: 18 }, 0, 1), false)
  assert.equal(api.canMove(board, { type: 'O', rot: 0, x: 4, y: 10 }, -1, 0), true)
  bump('collision hand cases', 9)
})

check('collision matches independent reference over 2000 random boards/pieces', () => {
  const rng = makeRng(1234)
  let cases = 0
  let positive = 0
  for (let trial = 0; trial < 2000; trial += 1) {
    const board = emptyBoard()
    for (let row = 0; row < api.ROWS; row += 1) {
      for (let col = 0; col < api.COLS; col += 1) {
        if (rng.next() < 0.12) board[row][col] = 1 + Math.floor(rng.next() * 7)
      }
    }
    const piece = {
      type: api.PIECE_TYPES[Math.floor(rng.next() * 7)],
      rot: Math.floor(rng.next() * 4),
      x: Math.floor(rng.next() * (api.COLS + 8)) - 4,
      y: Math.floor(rng.next() * (api.ROWS + 2)),
    }
    const got = api.collides(board, piece)
    const want = ownCollides(board, piece)
    assert.equal(got, want, 'trial ' + trial)
    if (got) positive += 1
    cases += 1
  }
  bump('collision comparisons', cases)
  bump('collision positives', positive)
})

check('ghost row matches independent reference (200 random cases + hand cases)', () => {
  const rng = makeRng(4321)
  let cases = 0
  for (let trial = 0; trial < 200; trial += 1) {
    const board = emptyBoard()
    for (let row = 0; row < api.ROWS; row += 1) {
      for (let col = 0; col < api.COLS; col += 1) {
        if (rng.next() < 0.15) board[row][col] = 1
      }
    }
    const piece = {
      type: api.PIECE_TYPES[Math.floor(rng.next() * 7)],
      rot: Math.floor(rng.next() * 4),
      x: Math.floor(rng.next() * 8),
      y: 1,
    }
    if (api.collides(board, piece)) continue
    assert.equal(api.ghostRow(board, piece), ownGhostRow(board, piece), 'trial ' + trial)
    cases += 1
  }
  const board = emptyBoard()
  assert.equal(api.ghostRow(board, { type: 'O', rot: 0, x: 4, y: 1 }), 20)
  assert.equal(api.ghostRow(board, { type: 'I', rot: 0, x: 3, y: 1 }), 20)
  board[21][0] = 1
  for (let col = 0; col < api.COLS; col += 1) board[20][col] = 1
  assert.equal(api.ghostRow(board, { type: 'O', rot: 0, x: 4, y: 1 }), 18)
  bump('ghost comparisons', cases)
})

// ---------------------------------------------------------------------------
// Rotation / wall kicks
// ---------------------------------------------------------------------------
check('wall-kick order: in place -> +/-1 -> +/-2 -> up 1 (handcrafted I cases)', () => {
  // I rot0 at x=3,y=5: rotating CW creates a vertical I in column x+2.
  const columnBlock = (board, col) => {
    for (let row = 5; row <= 8; row += 1) board[row][col] = 1
  }
  const piece = { type: 'I', rot: 0, x: 3, y: 5 }
  // in place blocked -> kick left (-1)
  let board = emptyBoard()
  columnBlock(board, 5)
  let result = api.rotatePiece(board, piece, 1)
  assert.deepEqual(result, { type: 'I', rot: 1, x: 2, y: 5 })
  // in place + left blocked -> kick right (+1)
  board = emptyBoard()
  columnBlock(board, 5)
  columnBlock(board, 4)
  result = api.rotatePiece(board, piece, 1)
  assert.deepEqual(result, { type: 'I', rot: 1, x: 4, y: 5 })
  // left/right blocked -> kick -2
  board = emptyBoard()
  for (const col of [5, 4, 6]) columnBlock(board, col)
  result = api.rotatePiece(board, piece, 1)
  assert.deepEqual(result, { type: 'I', rot: 1, x: 1, y: 5 })
  // -2 blocked too -> kick +2
  board = emptyBoard()
  for (const col of [5, 4, 6, 3]) columnBlock(board, col)
  result = api.rotatePiece(board, piece, 1)
  assert.deepEqual(result, { type: 'I', rot: 1, x: 5, y: 5 })
  bump('handcrafted kick cases', 4)
})

check('wall-kick order: up-1 is tried last (handcrafted T case)', () => {
  // T rot0 at x=3,y=5 -> CW rot1 occupies (4,5),(4,6),(5,6),(4,7).
  // Block row 7 cols 2..6: every horizontal candidate collides, up-1 is free.
  const board = emptyBoard()
  for (let col = 2; col <= 6; col += 1) board[7][col] = 1
  const result = api.rotatePiece(board, { type: 'T', rot: 0, x: 3, y: 5 }, 1)
  assert.deepEqual(result, { type: 'T', rot: 1, x: 3, y: 4 })
})

check('wall-kick returns null when every candidate is blocked', () => {
  // Fully occupied board with only the current T cells hollowed out.
  const board = emptyBoard()
  for (let row = 0; row < api.ROWS; row += 1) {
    for (let col = 0; col < api.COLS; col += 1) board[row][col] = 1
  }
  for (const [dx, dy] of ownCells('T', 0)) board[1 + dy][3 + dx] = 0
  assert.equal(api.rotatePiece(board, { type: 'T', rot: 0, x: 3, y: 1 }, 1), null)
})

check('rotation/kick matches independent reference on 4000 random boards (CW + CCW)', () => {
  const rng = makeRng(777)
  let cases = 0
  let kicked = 0
  let refused = 0
  for (let trial = 0; trial < 4000; trial += 1) {
    const board = emptyBoard()
    for (let row = 0; row < api.ROWS; row += 1) {
      for (let col = 0; col < api.COLS; col += 1) {
        if (rng.next() < 0.12) board[row][col] = 1
      }
    }
    const piece = {
      type: api.PIECE_TYPES[Math.floor(rng.next() * 7)],
      rot: Math.floor(rng.next() * 4),
      x: Math.floor(rng.next() * (api.COLS + 8)) - 4,
      y: Math.floor(rng.next() * (api.ROWS + 1)),
    }
    const direction = rng.next() < 0.5 ? 1 : -1
    const got = api.rotatePiece(board, piece, direction)
    const want = ownRotate(board, piece, direction)
    assert.deepEqual(got, want, 'trial ' + trial)
    if (got) {
      assert.equal(ownCollides(board, got), false)
      if (got.x !== piece.x || got.y !== piece.y) kicked += 1
    } else {
      refused += 1
    }
    cases += 1
  }
  bump('rotation/kick comparisons', cases)
  bump('kick successes (moved)', kicked)
  bump('blocked rotations', refused)
})

check('no wall penetration: all accepted rotations keep every cell inside the board', () => {
  let accepted = 0
  let refused = 0
  for (const type of api.PIECE_TYPES) {
    for (let rot = 0; rot < 4; rot += 1) {
      for (let y = 0; y <= 20; y += 1) {
        for (let x = -4; x <= api.COLS + 4; x += 1) {
          const piece = { type, rot, x, y }
          if (api.collides(emptyBoard(), piece)) continue // only start from legal placements
          for (const direction of [1, -1]) {
            const got = api.rotatePiece(emptyBoard(), piece, direction)
            if (!got) {
              refused += 1
              continue
            }
            for (const [dx, dy] of ownCells(got.type, got.rot)) {
              const ax = got.x + dx
              const ay = got.y + dy
              assert.ok(ax >= 0 && ax < api.COLS, type + ' x [' + ax + ']')
              assert.ok(ay >= 0 && ay < api.ROWS, type + ' y [' + ay + ']')
            }
            accepted += 1
          }
        }
      }
    }
  }
  bump('empty-board accepted rotations', accepted)
  bump('empty-board refused rotations', refused)
})

check('I hugs/rotates at both side walls without escaping', () => {
  const board = emptyBoard()
  let cases = 0
  for (const x of [0, 6]) {
    for (const direction of [1, -1]) {
      const piece = { type: 'I', rot: 0, x, y: 1 }
      const got = api.rotatePiece(board, piece, direction)
      assert.ok(got, 'I at x=' + x + ' dir ' + direction + ' should rotate')
      for (const [dx, dy] of ownCells('I', got.rot)) {
        assert.ok(got.x + dx >= 0 && got.x + dx < api.COLS)
        assert.ok(got.y + dy >= 0 && got.y + dy < api.ROWS)
      }
      cases += 1
    }
  }
  bump('I wall rotations', cases)
})

check('rotation on the floor: T kicks up, I refuses (cannot rotate in place)', () => {
  const board = emptyBoard()
  const t = api.rotatePiece(board, { type: 'T', rot: 0, x: 3, y: 20 }, 1)
  assert.deepEqual(t, { type: 'T', rot: 1, x: 3, y: 19 })
  const i = api.rotatePiece(board, { type: 'I', rot: 0, x: 3, y: 20 }, 1)
  assert.equal(i, null)
})

// ---------------------------------------------------------------------------
// Line clears / scoring / levels
// ---------------------------------------------------------------------------
check('clearFullLines: 0/1/2/3/4 full rows, hidden rows included', () => {
  let board = emptyBoard()
  assert.equal(api.clearFullLines(board), 0)
  board = emptyBoard()
  for (let col = 0; col < 10; col += 1) board[21][col] = 1
  board[20][3] = 2
  assert.equal(api.clearFullLines(board), 1)
  assert.equal(board[21][3], 2)
  assert.equal(board[21][0], 0)
  board = emptyBoard()
  for (let row = 0; row <= 1; row += 1) for (let col = 0; col < 10; col += 1) board[row][col] = 7
  board[21][1] = 3
  assert.equal(api.clearFullLines(board), 2)
  assert.equal(board[21][1], 3)
  board = emptyBoard()
  for (let col = 0; col < 10; col += 1) {
    board[19][col] = 1
    board[20][col] = 1
    board[21][col] = 1
  }
  assert.equal(api.clearFullLines(board), 3)
  board = emptyBoard()
  for (let row = 18; row <= 21; row += 1) for (let col = 0; col < 10; col += 1) board[row][col] = 1
  assert.equal(api.clearFullLines(board), 4)
  for (const row of board) assert.ok(row.every((value) => value === 0))
  bump('clearFullLines cases', 6)
})

check('line-clear scoring: 1/2/3/4 rows = 100/300/500/800 x level (level before up)', () => {
  const points = [0, 100, 300, 500, 800]
  const specs = [
    ['I', 0, 3, 20, 1],
    ['O', 0, 4, 20, 2],
    ['T', 1, 4, 19, 3],
    ['I', 1, 4, 18, 4],
  ]
  let cases = 0
  for (const [type, rot, x, y, lines] of specs) {
    for (const level of [1, 2, 3]) {
      const linesBefore = (level - 1) * 10
      const crafted = craftRows(type, rot, x, y, linesBefore)
      assert.equal(crafted.touchedRows, lines)
      const beforeScore = 777
      crafted.state.score = beforeScore
      const result = api.lockCurrent(crafted.state, makeRng(5).next)
      assert.equal(result.cleared, lines, type + ' ' + lines)
      assert.equal(result.gained, points[lines] * level)
      assert.equal(crafted.state.score, beforeScore + points[lines] * level)
      assert.equal(crafted.state.lines, linesBefore + lines)
      assert.equal(crafted.state.level, Math.floor((linesBefore + lines) / 10) + 1)
      cases += 1
    }
  }
  bump('scoring cases', cases)
})

check('level-up boundary: clear uses the pre-clear level (9 -> 10, 8 -> 10, 19 -> 20)', () => {
  const cases = [
    { linesBefore: 9, type: 'I', rot: 0, x: 3, y: 20, cleared: 1, level: 1 },
    { linesBefore: 8, type: 'O', rot: 0, x: 4, y: 20, cleared: 2, level: 1 },
    { linesBefore: 8, type: 'I', rot: 1, x: 4, y: 18, cleared: 4, level: 1 },
    { linesBefore: 19, type: 'I', rot: 1, x: 4, y: 18, cleared: 4, level: 2 },
    { linesBefore: 18, type: 'T', rot: 1, x: 4, y: 19, cleared: 3, level: 2 },
  ]
  const points = [0, 100, 300, 500, 800]
  for (const item of cases) {
    const crafted = craftRows(item.type, item.rot, item.x, item.y, item.linesBefore)
    assert.equal(crafted.touchedRows, item.cleared)
    const result = api.lockCurrent(crafted.state, makeRng(6).next)
    assert.equal(result.cleared, item.cleared)
    assert.equal(result.gained, points[item.cleared] * item.level, 'level before up')
    assert.equal(crafted.state.lines, item.linesBefore + item.cleared)
    assert.equal(crafted.state.level, Math.floor((item.linesBefore + item.cleared) / 10) + 1)
  }
  bump('level-boundary cases', cases.length)
})

check('level = floor(lines / 10) + 1 for every lines value', () => {
  for (let lines = 0; lines <= 100; lines += 1) {
    const state = riggedState()
    state.current = { type: 'T', rot: 0, x: 3, y: 1 }
    state.lines = lines
    state.level = Math.floor(lines / 10) + 1
    // round-trip through the save validator recomputes level
    const clean = api.sanitizeState(api.serializeState(state, false))
    assert.ok(clean, 'lines ' + lines)
    assert.equal(clean.level, Math.floor(lines / 10) + 1)
  }
})

check('hidden spawn-row line clear: locking above the visible area clears and shifts', () => {
  const state = riggedState()
  // O at y=0 occupies (4,0),(5,0),(4,1),(5,1); fill hidden row 1 around it.
  for (let col = 0; col < 10; col += 1) {
    if (col !== 4 && col !== 5) state.board[1][col] = 2
  }
  state.current = { type: 'O', rot: 0, x: 4, y: 0 }
  const result = api.lockCurrent(state, makeRng(8).next)
  assert.equal(result.cleared, 1)
  assert.equal(result.gained, 100)
  assert.equal(state.board[1][4], api.TYPE_CODE.O, 'old hidden row 0 content shifts down')
  assert.equal(state.board[1][5], api.TYPE_CODE.O)
  assert.ok(state.board[0].every((value) => value === 0), 'new top row is empty')
})

check('locked cells are written with the piece type code', () => {
  const state = riggedState()
  state.current = { type: 'T', rot: 0, x: 3, y: 20 }
  api.lockCurrent(state, makeRng(9).next)
  const codes = state.board.map((row) => row.filter((value) => value !== 0)).flat()
  assert.deepEqual(codes, [api.TYPE_CODE.T, api.TYPE_CODE.T, api.TYPE_CODE.T, api.TYPE_CODE.T])
})

check('spawn collision ends the game for all 7 piece types', () => {
  let cases = 0
  for (const type of api.PIECE_TYPES) {
    const state = riggedState()
    state.queue = [type]
    state.bag = []
    const spawn = api.makeSpawnPiece(type)
    for (const [dx, dy] of ownCells(type, 0)) state.board[spawn.y + dy][spawn.x + dx] = 1
    api.spawnNext(state, makeRng(10).next)
    assert.equal(state.over, true, type)
    assert.equal(state.current, null, type)
    cases += 1
  }
  bump('spawn-fail types', cases)
})

// ---------------------------------------------------------------------------
// Fall speed
// ---------------------------------------------------------------------------
check('dropIntervalMs = max(80, 800 - (level-1)*60)', () => {
  let cases = 0
  for (let level = 1; level <= 60; level += 1) {
    const expected = Math.max(80, 800 - (level - 1) * 60)
    assert.equal(api.dropIntervalMs(level), expected, 'level ' + level)
    cases += 1
  }
  assert.equal(api.dropIntervalMs(0), 800)
  assert.equal(api.dropIntervalMs(-5), 800)
  assert.equal(api.dropIntervalMs(1.9), 800)
  assert.equal(api.dropIntervalMs(2.9), 740)
  assert.equal(api.dropIntervalMs(NaN), 800)
  assert.equal(api.dropIntervalMs(Infinity), 800)
  assert.equal(api.dropIntervalMs(13), 80)
  assert.equal(api.dropIntervalMs(14), 80)
  bump('dropMs cases', cases + 8)
})

// ---------------------------------------------------------------------------
// Hold
// ---------------------------------------------------------------------------
check('hold is allowed once per spawned piece, then swaps after a lock', () => {
  const rng = makeRng(21)
  const state = api.freshState(rng.next)
  const first = state.current.type
  const queued = state.queue[0]
  assert.equal(api.holdPiece(state, rng.next), true)
  assert.equal(state.hold, first)
  assert.equal(state.current.type, queued)
  assert.equal(state.canHold, false)
  assert.equal(api.holdPiece(state, rng.next), false)
  state.current = { type: 'O', rot: 0, x: 4, y: 20 }
  api.lockCurrent(state, rng.next)
  assert.equal(state.canHold, true)
  const before = state.current.type
  assert.equal(api.holdPiece(state, rng.next), true)
  assert.equal(state.hold, before)
  assert.equal(state.current.type, first)
  assert.equal(state.canHold, false)
  assert.equal(api.holdPiece(state, rng.next), false)
  bump('hold invariants', 5)
})

check('hold refuses when over or without a current piece', () => {
  const rng = makeRng(22)
  const state = api.freshState(rng.next)
  state.over = true
  assert.equal(api.holdPiece(state, rng.next), false)
  state.over = false
  state.current = null
  assert.equal(api.holdPiece(state, rng.next), false)
})

// ---------------------------------------------------------------------------
// Save validation (hostile / corrupt data)
// ---------------------------------------------------------------------------
function baseSave() {
  const rng = makeRng(777)
  return api.serializeState(api.freshState(rng.next), false)
}
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}
function withOverride(overrides) {
  return Object.assign(clone(baseSave()), overrides)
}

check('serialize has every contract field and a 22x10 board', () => {
  const saved = baseSave()
  for (const field of ['schemaVersion', 'board', 'current', 'queue', 'bag', 'hold', 'canHold', 'score', 'lines', 'level', 'playMs', 'over', 'paused']) {
    assert.ok(Object.prototype.hasOwnProperty.call(saved, field), field)
  }
  assert.equal(saved.schemaVersion, 1)
  assert.equal(saved.board.length, 22)
  assert.equal(saved.board[0].length, 10)
  assert.ok(Array.isArray(saved.queue))
  assert.ok(Array.isArray(saved.bag))
})

check('hostile / corrupt saves: 48 cases behave (reject -> null, accept -> sanitized)', () => {
  const board = () => api.createEmptyBoard()
  const bad = (overrides) => {
    const result = api.sanitizeState(withOverride(overrides))
    assert.equal(result, null, JSON.stringify(overrides).slice(0, 80))
  }
  const good = (overrides) => {
    const result = api.sanitizeState(withOverride(overrides))
    assert.ok(result, 'should accept ' + JSON.stringify(overrides).slice(0, 80))
    return result
  }
  let cases = 0
  // whole-value garbage
  assert.equal(api.sanitizeState(null), null); cases += 1
  assert.equal(api.sanitizeState(undefined), null); cases += 1
  assert.equal(api.sanitizeState([]), null); cases += 1
  assert.equal(api.sanitizeState('x'), null); cases += 1
  assert.equal(api.sanitizeState(42), null); cases += 1
  assert.equal(api.sanitizeState({}), null); cases += 1
  // schema
  bad({ schemaVersion: 2 }); cases += 1
  bad({ schemaVersion: '1' }); cases += 1
  bad({ schemaVersion: null }); cases += 1
  // board
  const rows21 = board(); rows21.pop(); bad({ board: rows21 }); cases += 1
  const rows23 = board(); rows23.push(new Array(10).fill(0)); bad({ board: rows23 }); cases += 1
  const shortRow = board(); shortRow[3].pop(); bad({ board: shortRow }); cases += 1
  const cell8 = board(); cell8[5][5] = 8; bad({ board: cell8 }); cases += 1
  const cellNeg = board(); cellNeg[5][5] = -1; bad({ board: cellNeg }); cases += 1
  const cellFloat = board(); cellFloat[5][5] = 1.5; bad({ board: cellFloat }); cases += 1
  const fullRow = board(); for (let c = 0; c < 10; c += 1) fullRow[7][c] = 1; bad({ board: fullRow }); cases += 1
  const fullHidden = board(); for (let c = 0; c < 10; c += 1) fullHidden[1][c] = 1; bad({ board: fullHidden }); cases += 1
  // scalar bounds
  bad({ score: -1 }); cases += 1
  bad({ score: 1.5 }); cases += 1
  bad({ score: '5' }); cases += 1
  bad({ score: 1000000001 }); cases += 1
  bad({ lines: -1 }); cases += 1
  bad({ lines: 1000001 }); cases += 1
  bad({ lines: 2.5 }); cases += 1
  bad({ playMs: -1 }); cases += 1
  bad({ playMs: 1000000001 }); cases += 1
  bad({ playMs: null }); cases += 1
  // current piece
  bad({ current: null, over: false }); cases += 1
  bad({ current: { type: 'Q', rot: 0, x: 3, y: 1 } }); cases += 1
  bad({ current: { type: 'T', rot: 4, x: 3, y: 1 } }); cases += 1
  bad({ current: { type: 'T', rot: -1, x: 3, y: 1 } }); cases += 1
  bad({ current: { type: 'T', rot: 0, x: -5, y: 1 } }); cases += 1
  bad({ current: { type: 'T', rot: 0, x: 11, y: 1 } }); cases += 1
  bad({ current: { type: 'T', rot: 0, x: 3, y: 23 } }); cases += 1
  const overlap = board(); overlap[2][3] = 1; bad({ current: { type: 'T', rot: 0, x: 3, y: 1 }, board: overlap }); cases += 1
  // queue / bag
  bad({ queue: ['I', 'Q'] }); cases += 1
  bad({ queue: new Array(41).fill('I') }); cases += 1
  bad({ queue: 'I' }); cases += 1
  bad({ bag: ['I', 'I'] }); cases += 1
  bad({ bag: new Array(8).fill('I') }); cases += 1
  bad({ bag: ['Q'] }); cases += 1
  // hold
  bad({ hold: 'Q' }); cases += 1
  bad({ hold: 3 }); cases += 1
  // accepted / sanitized values
  const levelIgnored = good({ lines: 25, level: 99 }); assert.equal(levelIgnored.level, 3); cases += 1
  const overNoCurrent = good({ over: true, current: null }); assert.equal(overNoCurrent.over, true); cases += 1
  const pausedOver = good({ over: true, current: null, paused: true }); assert.equal(pausedOver.paused, false); cases += 1
  const noCurrentOver = good({ current: null, over: true }); assert.equal(noCurrentOver.current, null); cases += 1
  const missingQueue = good({ queue: undefined }); assert.deepEqual(missingQueue.queue, []); cases += 1
  bump('hostile save cases', cases)
})

check('a save whose level disagrees is normalized from lines', () => {
  const restored = api.sanitizeState(withOverride({ lines: 25, level: 99 }))
  assert.equal(restored.level, 3)
})
bump('level/lines mismatch cases', 1)

check('unbounded in-game score above MAX_SCORE is rejected on reload (documented edge)', () => {
  // In-game score has no cap; serialization can persist > 1e9 and sanitize then
  // drops the save. Flagged as a note, not a hard failure.
  const saved = withOverride({ score: 1000000001 })
  assert.equal(api.sanitizeState(saved), null)
})
bump('score-cap edge cases', 1)

// ---------------------------------------------------------------------------
console.log('\nlogic audit: ' + passed + ' passed, ' + failed + ' failed')
console.log('counters: ' + JSON.stringify(stats, null, 2))
if (failed > 0) {
  console.log('failures:\n- ' + failures.join('\n- '))
  process.exitCode = 1
}
