/**
 * Randomised invariant / fuzz self test for @local/dsh-game-tetris.
 *
 * Run: node dev/fuzz.mjs [games] [actionsPerGame]
 *
 * Uses the same opt-in test seam as dev/test-logic.mjs (no DOM, no React):
 *   - 7-bag over 70,000 dealt pieces
 *   - random moves/rotations/soft+hard drops/hold with board invariants
 *   - corrupt-save fuzz (sanitize must never throw and must be idempotent)
 */
import assert from 'node:assert/strict'

const GAMES = Number(process.argv[2] || 300)
const STEPS_PER_GAME = Number(process.argv[3] || 400)

const storage = new Map()
const loaded = { definition: null }

globalThis.window = {
  __DSH_GAME_TETRIS_TEST__: true,
  __ModuleLoader__: {
    load(definition) {
      loaded.definition = definition
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

function makeRng(seed) {
  let state = seed >>> 0
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length]
}

function assertBoardInvariants(state, label) {
  assert.equal(state.board.length, api.ROWS, label + ': board rows')
  for (let row = 0; row < api.ROWS; row += 1) {
    assert.equal(state.board[row].length, api.COLS, label + ': board cols')
    let full = true
    for (let col = 0; col < api.COLS; col += 1) {
      const value = state.board[row][col]
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 7, label + ': cell value')
      if (value === 0) full = false
    }
    assert.equal(full, false, label + ': no full row may remain after a lock')
  }
  assert.equal(state.level, Math.floor(state.lines / api.LINES_PER_LEVEL) + 1, label + ': level from lines')
  assert.ok(state.score >= 0, label + ': score non-negative')
  assert.ok(state.lines >= 0, label + ': lines non-negative')
  assert.equal(state.queue.length >= api.QUEUE_SHOWN, true, label + ': queue length')
  for (const type of state.queue) assert.ok(api.PIECE_TYPES.includes(type), label + ': queue type')
  for (const type of state.bag) assert.ok(api.PIECE_TYPES.includes(type), label + ': bag type')
  assert.equal(new Set(state.bag).size, state.bag.length, label + ': bag duplicates')
  assert.equal(typeof state.canHold, 'boolean', label + ': canHold')
  if (state.current) {
    assert.equal(api.collides(state.board, state.current), false, label + ': current piece collides')
    const cells = api.PIECES[state.current.type].cellsByRot[state.current.rot]
    for (const cell of cells) {
      const row = state.current.y + cell[1]
      const col = state.current.x + cell[0]
      assert.ok(row >= 0 && row < api.ROWS, label + ': current row in board')
      assert.ok(col >= 0 && col < api.COLS, label + ': current col in board')
    }
  }
}

// ---------------------------------------------------------------------------
// 1. 7-bag over a large sample
// ---------------------------------------------------------------------------

{
  const rng = makeRng(0x5eed)
  const state = api.freshState(rng)
  const seen = [state.current.type]
  const total = 70000
  for (let index = 1; index < total; index += 1) seen.push(api.takeNext(state, rng))
  const expected = api.PIECE_TYPES.slice().sort().join('')
  for (let start = 0; start + 7 <= seen.length; start += 7) {
    const group = seen.slice(start, start + 7).sort().join('')
    assert.equal(group, expected, '7-bag group at ' + start)
  }
  console.log('ok - 7-bag: ' + Math.floor(total / 7) + ' full bags, every bag is a permutation')
}

// ---------------------------------------------------------------------------
// 2. Two independent runs with the same seed are identical
// ---------------------------------------------------------------------------

{
  const a = makeRng(123)
  const b = makeRng(123)
  for (let index = 0; index < 1000; index += 1) {
    assert.equal(a(), b(), 'rng determinism')
  }
  const stateA = api.freshState(makeRng(999))
  const stateB = api.freshState(makeRng(999))
  const seqA = [stateA.current.type]
  const seqB = [stateB.current.type]
  const rngA = makeRng(999)
  const rngB = makeRng(999)
  for (let index = 0; index < 500; index += 1) {
    seqA.push(api.takeNext(stateA, rngA))
    seqB.push(api.takeNext(stateB, rngB))
  }
  assert.deepEqual(seqA, seqB)
  console.log('ok - deterministic sequences for the same seed')
}

// ---------------------------------------------------------------------------
// 3. Random play invariants
// ---------------------------------------------------------------------------

const ACTIONS = ['left', 'right', 'left', 'right', 'rotateCW', 'rotateCCW', 'soft', 'soft', 'hard', 'gravity', 'hold', 'gravity']

let games = 0
let actions = 0
let clears = 0
let gameOvers = 0
let holds = 0

for (let game = 0; game < GAMES; game += 1) {
  const rng = makeRng(1000 + game * 7)
  let state = api.freshState(rng)
  let guard = 0
  let steps = 0
  while (steps < STEPS_PER_GAME && guard < STEPS_PER_GAME * 20) {
    guard += 1
    if (state.over) {
      gameOvers += 1
      state = api.freshState(rng)
      assertBoardInvariants(state, 'game ' + game + ' after reset')
      continue
    }
    const action = pick(rng, ACTIONS)
    steps += 1
    actions += 1
    if (action === 'left' || action === 'right') {
      const dx = action === 'left' ? -1 : 1
      if (state.current && api.canMove(state.board, state.current, dx, 0)) {
        state.current.x += dx
      }
    } else if (action === 'rotateCW' || action === 'rotateCCW') {
      if (state.current) {
        const rotated = api.rotatePiece(state.board, state.current, action === 'rotateCW' ? 1 : -1)
        if (rotated) state.current = rotated
      }
    } else if (action === 'soft') {
      if (state.current && api.canMove(state.board, state.current, 0, 1)) {
        state.current.y += 1
        state.score += api.SOFT_DROP_POINTS
      }
    } else if (action === 'hard') {
      if (state.current) {
        let distance = 0
        while (api.canMove(state.board, state.current, 0, 1)) {
          state.current.y += 1
          distance += 1
        }
        state.score += distance * api.HARD_DROP_POINTS
        const result = api.lockCurrent(state, rng)
        clears += result.cleared
      }
    } else if (action === 'gravity') {
      if (state.current && api.canMove(state.board, state.current, 0, 1)) {
        state.current.y += 1
      } else if (state.current) {
        const result = api.lockCurrent(state, rng)
        clears += result.cleared
      }
    } else if (action === 'hold') {
      if (api.holdPiece(state, rng)) holds += 1
    }
    assertBoardInvariants(state, 'game ' + game + ' step ' + steps)
  }
  games += 1
}

console.log(
  'ok - random play: ' +
    games +
    ' games / ' +
    actions +
    ' actions, ' +
    clears +
    ' lines cleared, ' +
    gameOvers +
    ' game-overs, ' +
    holds +
    ' holds, invariants held',
)

// ---------------------------------------------------------------------------
// 4. Corrupt-save fuzz: sanitize never throws, idempotent when accepted
// ---------------------------------------------------------------------------

const baseState = api.freshState(makeRng(4242))
baseState.score = 3456
baseState.lines = 23
baseState.level = 3
baseState.hold = 'S'
baseState.canHold = false
const baseSave = api.serializeState(baseState, false)

const corruptors = [
  function (copy) {
    copy.schemaVersion = pick(makeRng(1), [0, 1, 2, '1', null])
  },
  function (copy) {
    copy.board = pick(makeRng(2), [null, [], {}, 'board', new Array(3)])
  },
  function (copy) {
    copy.board[pick(makeRng(3), [0, 5, 21, 99])] = pick(makeRng(4), [null, {}, 'x', [1, 2], new Array(3)])
  },
  function (copy) {
    copy.current = pick(makeRng(5), [null, {}, { type: 'Q' }, { type: 'T', rot: 9, x: 0, y: 0 }])
  },
  function (copy) {
    copy.queue = pick(makeRng(6), [null, {}, ['I', 'I'], new Array(60).fill('I')])
  },
  function (copy) {
    copy.bag = pick(makeRng(7), [null, ['X'], ['I', 'I'], new Array(9).fill('O')])
  },
  function (copy) {
    copy.score = pick(makeRng(8), [-1, 1.5, 'x', null, Number.MAX_SAFE_INTEGER])
  },
  function (copy) {
    copy.lines = pick(makeRng(9), [-1, 2.5, null])
  },
  function (copy) {
    copy.playMs = pick(makeRng(10), [-1, 'x', null])
  },
  function (copy) {
    copy.paused = pick(makeRng(11), [true, 'yes', 1])
  },
  function (copy) {
    copy.extra = { huge: new Array(1000).fill('x') }
  },
]

let fuzzRuns = 0
let accepted = 0
const random = makeRng(0xc0ffee)
for (let index = 0; index < 20000; index += 1) {
  let copy
  try {
    copy = JSON.parse(JSON.stringify(baseSave))
  } catch (error) {
    throw new Error('base save must be JSON-serialisable')
  }
  const corruptor = corruptors[Math.floor(random() * corruptors.length) % corruptors.length]
  corruptor(copy)
  fuzzRuns += 1
  let restored = null
  try {
    restored = api.sanitizeState(copy)
  } catch (error) {
    throw new Error('sanitizeState threw on corrupt save: ' + error.stack)
  }
  if (restored) {
    accepted += 1
    const roundTrip = api.sanitizeState(JSON.parse(JSON.stringify(api.serializeState(restored, false))))
    assert.ok(roundTrip, 'accepted save must round-trip')
    assert.deepEqual(roundTrip.board, restored.board)
    assert.deepEqual(roundTrip.current, restored.current)
    assert.equal(roundTrip.score, restored.score)
    assert.equal(roundTrip.lines, restored.lines)
  }
}
console.log('ok - corrupt-save fuzz: ' + fuzzRuns + ' mutations, 0 throws, ' + accepted + ' round-tripped')

// ---------------------------------------------------------------------------
// 5. Wall-kick candidates are always collision-free
// ---------------------------------------------------------------------------

{
  const rng = makeRng(0xabcd)
  let cases = 0
  for (let boardCase = 0; boardCase < 400; boardCase += 1) {
    const board = api.createEmptyBoard()
    const fill = Math.floor(rng() * 120)
    for (let block = 0; block < fill; block += 1) {
      const row = api.HIDDEN_ROWS + Math.floor(rng() * (api.ROWS - api.HIDDEN_ROWS))
      const col = Math.floor(rng() * api.COLS)
      board[row][col] = 1 + Math.floor(rng() * 7)
    }
    for (const type of api.PIECE_TYPES) {
      for (let rot = 0; rot < 4; rot += 1) {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const piece = {
            type,
            rot,
            x: Math.floor(rng() * 12) - 2,
            y: Math.floor(rng() * 20),
          }
          if (api.collides(board, piece)) continue
          for (const direction of [1, -1]) {
            const rotated = api.rotatePiece(board, piece, direction)
            cases += 1
            if (rotated) {
              assert.equal(api.collides(board, rotated), false, 'kick result must be legal')
              assert.ok(rotated.y >= 0, 'kick must not go above the board')
            }
          }
        }
      }
    }
  }
  console.log('ok - wall kicks on random boards: ' + cases + ' rotations, all accepted candidates legal')
}

// ---------------------------------------------------------------------------
// 6. Lock/clear accounting: crafted 1–4 line clears conserve cells and score
// ---------------------------------------------------------------------------

{
  const rng = makeRng(0x77)
  const clears = [
    { type: 'I', rot: 0, rows: 1, width: 4 },
    { type: 'O', rot: 0, rows: 2, width: 2 },
    { type: 'T', rot: 3, rows: 3, width: 2 },
    { type: 'I', rot: 1, rows: 4, width: 1 },
  ]
  let checks = 0
  for (let trial = 0; trial < 4000; trial += 1) {
    const shape = clears[Math.floor(rng() * clears.length) % clears.length]
    const state = api.freshState(rng)
    state.board = api.createEmptyBoard()
    state.current = null
    const cells = api.PIECES[shape.type].cellsByRot[shape.rot]
    let minRow = 99
    let maxRow = -1
    let minCol = 99
    let maxCol = -1
    for (const cell of cells) {
      if (cell[1] < minRow) minRow = cell[1]
      if (cell[1] > maxRow) maxRow = cell[1]
      if (cell[0] < minCol) minCol = cell[0]
      if (cell[0] > maxCol) maxCol = cell[0]
    }
    assert.equal(maxRow - minRow + 1, shape.rows)
    const y = api.ROWS - 1 - maxRow
    const width = maxCol - minCol + 1
    assert.equal(width, shape.width)
    const x = -minCol + Math.floor(rng() * (api.COLS - width + 1))
    const touchedRows = new Set()
    const occupied = new Set()
    for (const cell of cells) {
      const row = y + cell[1]
      touchedRows.add(row)
      occupied.add(row + ',' + (x + cell[0]))
    }
    for (const row of touchedRows) {
      for (let col = 0; col < api.COLS; col += 1) {
        if (!occupied.has(row + ',' + col)) state.board[row][col] = 1 + (col % 7)
      }
    }
    const linesBefore = Math.floor(rng() * 60)
    state.lines = linesBefore
    state.level = Math.floor(linesBefore / api.LINES_PER_LEVEL) + 1
    const levelBefore = state.level
    state.score = 0
    state.current = { type: shape.type, rot: shape.rot, x, y }
    const result = api.lockCurrent(state, rng)
    assert.equal(result.cleared, touchedRows.size, 'crafted lines cleared')
    assert.equal(result.gained, api.CLEAR_POINTS[touchedRows.size] * levelBefore, 'clear score')
    assert.equal(state.score, result.gained)
    assert.equal(state.lines, linesBefore + touchedRows.size, 'lines accounting')
    assert.equal(state.level, Math.floor(state.lines / api.LINES_PER_LEVEL) + 1, 'level after clear')
    assert.equal(state.board.flat().filter((value) => value !== 0).length, 0, 'crafted board is empty after clear')
    checks += 1
  }
  console.log('ok - crafted lock/clear accounting: ' + checks + ' clears of 1/2/3/4 rows, score and cells conserved')
}

console.log('\nfuzz complete')
