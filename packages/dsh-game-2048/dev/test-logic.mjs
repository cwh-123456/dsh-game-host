/**
 * Pure-logic self test for @local/dsh-game-2048.
 *
 * Run: node dev/test-logic.mjs
 *
 * The browser bundle is the only entry, so the test imports client.js with a
 * minimal `window` stub and uses the opt-in test seam
 * (`window.__DSH_GAME_2048_TEST__ = true`). No React, canvas or host needed.
 */
import assert from 'node:assert/strict'

const storage = new Map()
let loadedDefinition = null

globalThis.window = {
  __DSH_GAME_2048_TEST__: true,
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

const api = globalThis.window.__DSH_GAME_2048__
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

function b(rows) {
  assert.equal(rows.length, 4, 'board helper expects 4 rows')
  return [].concat(rows[0], rows[1], rows[2], rows[3])
}

function zeros() {
  return api.createEmptyBoard()
}

function seq(values) {
  let index = 0
  return function next() {
    const value = values[Math.min(index, values.length - 1)]
    index += 1
    return value
  }
}

function makeRng(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function boardSum(board) {
  return board.reduce((total, value) => total + value, 0)
}

function countTiles(board) {
  return board.filter((value) => value !== 0).length
}

const DIRECTIONS = ['left', 'right', 'up', 'down']

// ---------------------------------------------------------------------------
// Registration / contract shape
// ---------------------------------------------------------------------------

test('module loader id equals the package name', () => {
  assert.equal(loadedDefinition.id, '@local/dsh-game-2048')
  assert.equal(typeof loadedDefinition.factory, 'function')
})

test('factory registers only into game.stage with contract v1 shape', () => {
  function FakeComponent() {}
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
  assert.equal(options.id, '2048')
  assert.equal(options.label(), '2048')
  assert.deepEqual(options.select({ gameId: '2048' }), {})
  assert.equal(options.select({ gameId: 'snake' }), null)
  assert.equal(options.select({}), null)
  assert.equal(typeof component, 'function')
})

// ---------------------------------------------------------------------------
// Spawning / initial state
// ---------------------------------------------------------------------------

test('new board starts with two tiles and empty cells', () => {
  const board = api.createInitialBoard(seq([0.5, 0.5, 0.5, 0.5]))
  assert.equal(board.length, 16)
  assert.equal(countTiles(board), 2)
  assert.equal(board[7], 2)
  assert.equal(board[8], 2)
  assert.ok(board.every((value) => value === 0 || value === 2 || value === 4))
})

test('spawn is deterministic and places 4 on the 10% roll', () => {
  const spawn = api.spawnTile(zeros(), seq([0, 0.95]))
  assert.equal(spawn.index, 0)
  assert.equal(spawn.value, 4)
  assert.equal(spawn.board[0], 4)
  assert.equal(countTiles(spawn.board), 1)
})

test('spawn returns null on a full board', () => {
  const full = new Array(16).fill(2)
  assert.equal(api.spawnTile(full, () => 0), null)
})

test('freshState starts a clean game and keeps the provided best', () => {
  const state = api.freshState(seq([0.5, 0.5, 0.5, 0.5]), 123)
  assert.equal(state.score, 0)
  assert.equal(state.best, 123)
  assert.equal(state.won, false)
  assert.equal(state.undo, null)
  assert.equal(state.over, false)
  assert.equal(countTiles(state.board), 2)
})

// ---------------------------------------------------------------------------
// Move / merge vectors
// ---------------------------------------------------------------------------

test('left merges a pair and reports gained points', () => {
  const result = api.moveBoard(b([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), 'left')
  assert.equal(result.moved, true)
  assert.equal(result.gained, 4)
  assert.deepEqual(result.board.slice(0, 4), [4, 0, 0, 0])
  assert.deepEqual(result.mergedTargets, [0])
  assert.equal(result.movements.length, 2)
  assert.ok(result.movements.every((movement) => movement.value === 2))
})

test('left merges two pairs in one line independently', () => {
  const result = api.moveBoard(b([[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), 'left')
  assert.equal(result.gained, 8)
  assert.deepEqual(result.board.slice(0, 4), [4, 4, 0, 0])
})

test('left does not chain-merge a newly created tile', () => {
  const result = api.moveBoard(b([[2, 2, 4, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), 'left')
  assert.deepEqual(result.board.slice(0, 4), [4, 4, 0, 0])
  assert.equal(result.gained, 4)
})

test('left merges 4+4 and 8+8 separately', () => {
  const result = api.moveBoard(b([[4, 4, 8, 8], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), 'left')
  assert.deepEqual(result.board.slice(0, 4), [8, 16, 0, 0])
  assert.equal(result.gained, 24)
})

test('a line that cannot move reports moved = false and keeps the board', () => {
  const board = b([[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
  const result = api.moveBoard(board, 'left')
  assert.equal(result.moved, false)
  assert.deepEqual(result.board, board)
  assert.equal(result.gained, 0)
})

test('right compacts toward the right edge', () => {
  const result = api.moveBoard(b([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), 'right')
  assert.deepEqual(result.board.slice(0, 4), [0, 0, 0, 4])
  assert.equal(result.gained, 4)
})

test('up compacts a column toward the top', () => {
  const result = api.moveBoard(b([[2, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), 'up')
  assert.equal(result.board[0], 4)
  assert.equal(result.board[4], 0)
  assert.equal(result.gained, 4)
})

test('down compacts a column toward the bottom', () => {
  const result = api.moveBoard(b([[2, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), 'down')
  assert.equal(result.board[12], 4)
  assert.equal(result.gained, 4)
})

test('a merge over a gap still lands on the correct edge cell', () => {
  const result = api.moveBoard(b([[2, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), 'left')
  assert.equal(result.board[0], 4)
  assert.equal(result.gained, 4)
  const movements = result.movements
  assert.equal(movements.length, 2)
  assert.equal(movements[0].from, 0)
  assert.equal(movements[1].from, 3)
  assert.equal(movements[1].to, 0)
})

test('invalid direction is a no-op', () => {
  const board = b([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
  const result = api.moveBoard(board, 'diagonal')
  assert.equal(result.moved, false)
  assert.deepEqual(result.board, board)
})

// ---------------------------------------------------------------------------
// Invariants over random boards
// ---------------------------------------------------------------------------

test('random boards preserve tile sum and movement consistency', () => {
  for (let run = 0; run < 300; run += 1) {
    const rng = makeRng(run + 1)
    const board = api.createEmptyBoard().map(() => {
      const roll = rng()
      if (roll < 0.35) return 0
      if (roll < 0.65) return 2
      if (roll < 0.85) return 4
      return 8
    })
    for (const direction of DIRECTIONS) {
      const result = api.moveBoard(board, direction)
      assert.equal(result.board.length, 16)
      assert.equal(boardSum(result.board), boardSum(board), 'move must not lose points')
      assert.ok(
        result.board.every((value) => value === 0 || (value >= 2 && (value & (value - 1)) === 0)),
        'all tiles stay powers of two',
      )
      if (!result.moved) {
        assert.deepEqual(result.board, board)
      }
      const grouped = new Map()
      for (const movement of result.movements) {
        assert.equal(board[movement.from], movement.value, 'movement remembers its source tile')
        grouped.set(movement.to, (grouped.get(movement.to) || 0) + movement.value)
      }
      for (const [target, summed] of grouped) {
        assert.equal(result.board[target], summed, 'target cell equals the sum of arrivals')
      }
      // Every non-zero tile of the source board is represented exactly once.
      assert.equal(result.movements.length, countTiles(board))
      assert.equal(
        result.movements.reduce((total, movement) => total + movement.value, 0),
        boardSum(board),
      )
    }
  }
})

// ---------------------------------------------------------------------------
// Win / game over detection
// ---------------------------------------------------------------------------

test('hasMoves detects empties, equal neighbours and dead boards', () => {
  assert.equal(api.hasMoves(zeros()), true)
  const dead = b([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ])
  assert.equal(api.hasMoves(dead), false)
  const horizontallyEqual = dead.slice()
  horizontallyEqual[1] = horizontallyEqual[0]
  assert.equal(api.hasMoves(horizontallyEqual), true)
  const verticallyEqual = dead.slice()
  verticallyEqual[4] = verticallyEqual[0]
  assert.equal(api.hasMoves(verticallyEqual), true)
})

test('hasWon is true at 2048 and above', () => {
  assert.equal(api.hasWon(zeros()), false)
  const near = zeros()
  near[0] = 1024
  assert.equal(api.hasWon(near), false)
  near[1] = 1024
  const result = api.moveBoard(near, 'left')
  assert.equal(result.board[0], 2048)
  assert.equal(api.hasWon(result.board), true)
  const bigger = zeros()
  bigger[0] = 4096
  assert.equal(api.hasWon(bigger), true)
})

// ---------------------------------------------------------------------------
// Persistence validation
// ---------------------------------------------------------------------------

test('serialize -> sanitize round-trips a state including undo', () => {
  const state = {
    board: b([[2, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]),
    score: 12,
    best: 30,
    won: false,
    winAcked: true,
    undo: {
      board: b([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]),
      score: 4,
      won: false,
      winAcked: true,
    },
    over: false,
  }
  const raw = api.serializeState(state)
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.board.length, 16)
  const restored = api.sanitizeState(raw)
  assert.ok(restored)
  assert.deepEqual(restored.board, state.board)
  assert.equal(restored.score, 12)
  assert.equal(restored.best, 30)
  assert.ok(restored.undo)
  assert.deepEqual(restored.undo.board, state.undo.board)
  assert.equal(restored.undo.score, 4)
})

test('sanitize rejects wrong schema, bad boards and bad scores', () => {
  const good = api.serializeState({
    board: zeros(),
    score: 0,
    best: 0,
    won: false,
    winAcked: true,
    undo: null,
  })
  assert.ok(api.sanitizeState(good))
  assert.equal(api.sanitizeState(null), null)
  assert.equal(api.sanitizeState({}), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { schemaVersion: 2 })), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { board: good.board.slice(0, 15) })), null)
  const badTile = good.board.slice()
  badTile[0] = 3
  assert.equal(api.sanitizeState(Object.assign({}, good, { board: badTile })), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { score: -1 })), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { score: '12' })), null)
  assert.equal(api.sanitizeState(Object.assign({}, good, { best: -3 })).best, 0)
})

test('sanitize clamps best up to score and drops invalid undo only', () => {
  const raw = {
    schemaVersion: 1,
    board: b([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]),
    score: 40,
    best: 10,
    won: false,
    winAcked: true,
    undo: { board: [1, 2], score: 0 },
  }
  const state = api.sanitizeState(raw)
  assert.ok(state)
  assert.equal(state.best, 40)
  assert.equal(state.undo, null)
})

test('sanitize marks a dead loaded board as game over', () => {
  const raw = {
    schemaVersion: 1,
    board: b([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]),
    score: 99,
    best: 99,
    won: false,
    winAcked: true,
    undo: null,
  }
  const state = api.sanitizeState(raw)
  assert.ok(state)
  assert.equal(state.over, true)
})

test('legacy win-aware state: missing winAcked defaults to acknowledged', () => {
  const raw = {
    schemaVersion: 1,
    board: b([[2048, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]),
    score: 20000,
    best: 20000,
    won: true,
  }
  const state = api.sanitizeState(raw)
  assert.ok(state)
  assert.equal(state.won, true)
  assert.equal(state.winAcked, true)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log('logic tests: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
