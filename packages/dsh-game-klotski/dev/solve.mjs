/**
 * dev/solve.mjs — Klotski level BFS solver + regression test (no dependencies).
 *
 *   node dev/solve.mjs
 *
 * What it proves:
 *
 *   1. Every level is a legal 4x5 Klotski layout: 10 pieces (one 2x2 Cao Cao,
 *      one 2x1 Guan Yu, four 1x2 vertical generals, four 1x1 soldiers), inside
 *      the board, no overlap, exactly two empty cells.
 *   2. Level 1 is exactly the "横刀立马" layout from the task spec.
 *   3. A from-scratch BFS (identical-shape pieces merged into one position
 *      multiset, so the quotient graph is small) finds a shortest solution for
 *      every level under the game rule "slide one piece 1 or 2 cells along a
 *      clear path". The distance must equal the level's declared `par`.
 *   4. The shortest canonical solution is expanded back to concrete piece
 *      moves and replayed through the shipped engine (`applySlide` from
 *      client.js): every move must be legal and the last one must win.
 *
 * The BFS here is deliberately implemented independently of client.js (client
 * only supplies the level data through its Node test seam); the shipped solver
 * state space is the quotient graph, which preserves shortest distances because
 * identical-shape pieces are interchangeable.
 *
 * Exits non-zero on any failure.
 */
import assert from 'node:assert/strict'

const W = 4
const H = 5
const EXIT = { x: 1, y: 3 }
const GOAL_POS = EXIT.y * W + EXIT.x

// ---------------------------------------------------------------------------
// Load the client module through its test seam (window stub, no React needed)
// ---------------------------------------------------------------------------

const storage = new Map()
globalThis.window = {
  __DSH_GAME_KLOTSKI_TEST__: true,
  __ModuleLoader__: {
    load(definition) {
      globalThis.window.__loadedDefinition = definition
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

await import(new URL('../client.js', import.meta.url).href)

const api = globalThis.window.__DSH_GAME_KLOTSKI__
assert.ok(api, 'client.js should install the window.__DSH_GAME_KLOTSKI__ test seam')
assert.ok(globalThis.window.__loadedDefinition, 'client.js should register a module-loader definition')
assert.equal(globalThis.window.__loadedDefinition.id, '@local/dsh-game-klotski')
assert.equal(api.GAME_ID, 'klotski')
assert.equal(api.STORE_KEY, 'dsh.game.klotski.v1')
assert.equal(api.COLS, W)
assert.equal(api.ROWS, H)
assert.deepEqual(api.EXIT, { x: 1, y: 3, w: 2, h: 2 })
assert.ok(Array.isArray(api.LEVELS) && api.LEVELS.length >= 3, 'at least 3 levels are required')

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures = []

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

// ---------------------------------------------------------------------------
// Layout validation
// ---------------------------------------------------------------------------

const ARMY_SPEC = [
  { kind: 'cao', count: 1, w: 2, h: 2 },
  { kind: 'guan', count: 1, w: 2, h: 1 },
  { kind: 'general', count: 4, w: 1, h: 2 },
  { kind: 'soldier', count: 4, w: 1, h: 1 },
]

function validateLayout(level, index) {
  assert.ok(level && typeof level.id === 'string', 'level ' + index + ' needs an id')
  assert.ok(typeof level.name === 'string' && level.name.length > 0, 'level ' + index + ' needs a name')
  assert.ok(Number.isInteger(level.par) && level.par > 0, 'level ' + index + ' needs a positive par')
  assert.ok(Array.isArray(level.pieces), 'level ' + index + ' needs pieces')

  const grid = new Int8Array(W * H).fill(-1)
  const byKind = Object.create(null)
  const ids = new Set()
  for (const piece of level.pieces) {
    assert.ok(typeof piece.id === 'string' && !ids.has(piece.id), 'unique piece id')
    ids.add(piece.id)
    byKind[piece.kind] = (byKind[piece.kind] || 0) + 1
    assert.ok(Number.isInteger(piece.x) && Number.isInteger(piece.y), 'integer coordinates')
    assert.ok(piece.x >= 0 && piece.y >= 0 && piece.x + piece.w <= W && piece.y + piece.h <= H, 'piece in bounds')
    for (let dy = 0; dy < piece.h; dy += 1) {
      for (let dx = 0; dx < piece.w; dx += 1) {
        const cell = (piece.y + dy) * W + (piece.x + dx)
        assert.equal(grid[cell], -1, 'pieces do not overlap')
        grid[cell] = 1
      }
    }
  }
  for (const spec of ARMY_SPEC) {
    assert.equal(byKind[spec.kind] || 0, spec.count, 'army composition: ' + spec.kind)
  }
  let empties = 0
  for (let i = 0; i < grid.length; i += 1) if (grid[i] === -1) empties += 1
  assert.equal(empties, W * H - level.pieces.reduce((sum, p) => sum + p.w * p.h, 0), 'areas add up')
  assert.equal(empties, 2, 'exactly two empty cells')
  assert.equal(level.pieces.find((p) => p.kind === 'cao').w, 2)
  assert.equal(level.pieces.find((p) => p.kind === 'cao').h, 2)
}

// Level 1 must be the task-book "横刀立马" position.
const HENGDAO_EXPECTED = {
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

function checkLevelOne() {
  const level = api.LEVELS[0]
  assert.equal(level.name, '横刀立马')
  const seen = Object.create(null)
  for (const piece of level.pieces) {
    const expected = HENGDAO_EXPECTED[piece.id]
    assert.ok(expected, 'unexpected piece in level 1: ' + piece.id)
    assert.deepEqual([piece.x, piece.y], expected, 'level 1 coordinate of ' + piece.id)
    seen[piece.id] = true
  }
  assert.equal(Object.keys(seen).length, Object.keys(HENGDAO_EXPECTED).length)
  // The two empty cells must be (1,4) and (2,4).
  const grid = new Int8Array(W * H)
  for (const piece of level.pieces) {
    for (let dy = 0; dy < piece.h; dy += 1) {
      for (let dx = 0; dx < piece.w; dx += 1) grid[(piece.y + dy) * W + piece.x + dx] = 1
    }
  }
  const emptyCells = []
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) if (!grid[y * W + x]) emptyCells.push(x + ',' + y)
  }
  assert.deepEqual(emptyCells, ['1,4', '2,4'])
}

// ---------------------------------------------------------------------------
// Independent canonical BFS
// ---------------------------------------------------------------------------

function buildModel(level) {
  const groups = []
  const bySig = new Map()
  level.pieces.forEach((piece) => {
    const sig = piece.w + 'x' + piece.h
    let group = bySig.get(sig)
    if (!group) {
      group = { sig, w: piece.w, h: piece.h, positions: [], ids: [] }
      bySig.set(sig, group)
      groups.push(group)
    }
    group.positions.push(piece.y * W + piece.x)
    group.ids.push(piece.id)
  })
  groups.forEach((group) => group.positions.sort((a, b) => a - b))
  const cao = level.pieces.find((p) => p.kind === 'cao')
  const caoGroup = groups.findIndex((group) => group.ids.includes(cao.id))
  const caoSlot = groups[caoGroup].positions.indexOf(cao.y * W + cao.x)
  assert.ok(caoGroup >= 0 && caoSlot >= 0 && caoSlot < groups[caoGroup].positions.length)
  return { groups, caoGroup, caoSlot }
}

function packPositions(groups, positionsByGroup) {
  let key = 0
  let shift = 0
  for (let g = 0; g < positionsByGroup.length; g += 1) {
    void groups
    for (const position of positionsByGroup[g]) {
      key += position * 2 ** shift
      shift += 5
    }
  }
  return key
}

function unpackPositions(model, key) {
  const lists = []
  let shift = 0
  for (const group of model.groups) {
    const list = []
    for (let i = 0; i < group.positions.length; i += 1) {
      list.push(Math.floor(key / 2 ** shift) % 32)
      shift += 5
    }
    list.sort((a, b) => a - b)
    lists.push(list)
  }
  return lists
}

function occupancy(lists, model) {
  const grid = new Int8Array(W * H).fill(-1)
  const offsets = []
  let counter = 0
  for (let g = 0; g < lists.length; g += 1) {
    offsets.push(counter)
    counter += lists[g].length
  }
  for (let g = 0; g < lists.length; g += 1) {
    for (let pi = 0; pi < lists[g].length; pi += 1) {
      const position = lists[g][pi]
      const px = position % W
      const py = Math.floor(position / W)
      for (let dy = 0; dy < model.groups[g].h; dy += 1) {
        for (let dx = 0; dx < model.groups[g].w; dx += 1) {
          const cell = (py + dy) * W + (px + dx)
          assert.equal(grid[cell], -1, 'canonical BFS produced an overlapping state')
          grid[cell] = offsets[g] + pi
        }
      }
    }
  }
  return { grid, offsets }
}

const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

function solveLevel(level, levelIndex) {
  const model = buildModel(level)
  const startLists = model.groups.map((group) => group.positions.slice())
  const startKey = packPositions(model.groups, startLists)
  const queue = [startKey]
  const depth = new Map([[startKey, 0]])
  const parent = new Map()
  let head = 0
  let edges = 0
  let goalKey = -1

  while (head < queue.length) {
    const key = queue[head]
    head += 1
    const currentDepth = depth.get(key)
    const lists = unpackPositions(model, key)
    if (lists[model.caoGroup][model.caoSlot] === GOAL_POS) {
      goalKey = key
      break
    }
    const { grid, offsets } = occupancy(lists, model)
    for (let g = 0; g < lists.length; g += 1) {
      const gw = model.groups[g].w
      const gh = model.groups[g].h
      for (let pi = 0; pi < lists[g].length; pi += 1) {
        const position = lists[g][pi]
        const px = position % W
        const py = Math.floor(position / W)
        const own = offsets[g] + pi
        for (const [dx, dy] of DIRECTIONS) {
          for (let step = 1; step <= 2; step += 1) {
            const nx = px + dx * step
            const ny = py + dy * step
            if (nx < 0 || ny < 0 || nx + gw > W || ny + gh > H) break
            let blocked = false
            for (let t = 1; t <= step && !blocked; t += 1) {
              for (let oy = 0; oy < gh && !blocked; oy += 1) {
                for (let ox = 0; ox < gw; ox += 1) {
                  const owner = grid[(py + dy * t + oy) * W + (px + dx * t + ox)]
                  if (owner !== -1 && owner !== own) {
                    blocked = true
                    break
                  }
                }
              }
            }
            if (blocked) break
            edges += 1
            const nextLists = lists.map((list) => list.slice())
            nextLists[g][pi] = ny * W + nx
            nextLists[g].sort((a, b) => a - b)
            const nextKey = packPositions(model.groups, nextLists)
            if (!depth.has(nextKey)) {
              depth.set(nextKey, currentDepth + 1)
              parent.set(nextKey, { prev: key, group: g, from: position, to: ny * W + nx })
              queue.push(nextKey)
            }
          }
        }
      }
    }
  }

  if (goalKey < 0) return { solvable: false, moves: -1, visited: depth.size, edges }

  // Reconstruct the canonical move list (start -> goal).
  const path = []
  let cursor = goalKey
  while (parent.has(cursor)) {
    const step = parent.get(cursor)
    path.push(step)
    cursor = step.prev
  }
  path.reverse()

  // Expand to concrete piece moves and replay through the shipped engine.
  let state = api.createState(levelIndex)
  for (const step of path) {
    const group = model.groups[step.group]
    const fromX = step.from % W
    const fromY = Math.floor(step.from / W)
    const toX = step.to % W
    const toY = Math.floor(step.to / W)
    let pieceIndex = -1
    for (let i = 0; i < level.pieces.length; i += 1) {
      const def = level.pieces[i]
      if (def.w !== group.w || def.h !== group.h) continue
      if (state.pieces[i].x === fromX && state.pieces[i].y === fromY) {
        pieceIndex = i
        break
      }
    }
    assert.ok(pieceIndex >= 0, 'canonical move must map to a concrete piece')
    const dx = Math.sign(toX - fromX)
    const dy = Math.sign(toY - fromY)
    const distance = Math.abs(toX - fromX) + Math.abs(toY - fromY)
    assert.ok(distance === 1 || distance === 2, 'canonical move is a 1- or 2-cell slide')
    assert.ok(api.canSlide(state, pieceIndex, dx, dy, distance), 'replayed move must be legal')
    const next = api.applySlide(state, pieceIndex, dx, dy, distance)
    assert.ok(next, 'applySlide should accept the replayed move')
    state = next
  }
  assert.ok(api.isWon(state), 'replayed solution must win')
  assert.equal(state.moves, path.length)

  return {
    solvable: true,
    moves: path.length,
    visited: depth.size,
    edges,
    replayed: state.moves,
    won: true,
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('Klotski level solver / regression — ' + api.LEVELS.length + ' levels\n')

test('store key and schema', () => {
  assert.equal(api.SCHEMA_VERSION, 1)
  assert.equal(api.STORE_KEY, 'dsh.game.klotski.v1')
})

test('at least 3 levels and unique level ids', () => {
  assert.ok(api.LEVELS.length >= 3)
  const ids = new Set(api.LEVELS.map((level) => level.id))
  assert.equal(ids.size, api.LEVELS.length)
})

api.LEVELS.forEach((level, index) => {
  test('level ' + (index + 1) + ' "' + level.name + '" is a legal layout', () => {
    validateLayout(level, index)
  })
})

test('level 1 is the task-spec "横刀立马" layout', checkLevelOne)

const results = []
for (let index = 0; index < api.LEVELS.length; index += 1) {
  const level = api.LEVELS[index]
  let result = null
  test('BFS solves level ' + (index + 1) + ' "' + level.name + '" in par ' + level.par + ' moves', () => {
    const startedAt = Date.now()
    result = solveLevel(level, index)
    const elapsedMs = Date.now() - startedAt
    assert.equal(result.solvable, true, 'level must be solvable')
    assert.equal(result.moves, level.par, 'shortest solution must equal the declared par')
    assert.equal(result.replayed, result.moves, 'every solution move must replay')
    assert.equal(result.won, true)
    results.push({
      index,
      name: level.name,
      par: level.par,
      moves: result.moves,
      visited: result.visited,
      edges: result.edges,
      replay: result.replayed,
      solvedInMs: elapsedMs,
    })
    console.log(
      '     ' +
        level.name +
        ': par ' +
        result.moves +
        ' | quotient states ' +
        result.visited +
        ' | edges ' +
        result.edges +
        ' | replay ' +
        result.replayed +
        '/' +
        result.moves +
        ' legal, win | ' +
        elapsedMs +
        'ms',
    )
  })
}

test('par values match the independently recomputed BFS distances', () => {
  assert.equal(results.length, api.LEVELS.length)
  for (const row of results) assert.equal(row.par, row.moves)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\nSummary')
console.log('-------')
for (const row of results) {
  console.log(
    '  L' + (row.index + 1) + ' ' + row.name.padEnd(6, ' ') + '  par=' + String(row.par).padStart(2, ' ') + '  quotient states=' + row.visited + '  replay=' + row.replay + '  ' + row.solvedInMs + 'ms',
  )
}
console.log('\n' + passed + ' passed, ' + failed + ' failed')

if (failed > 0) {
  console.error('\nFAILED')
  for (const failure of failures) console.error('- ' + failure.name + ': ' + failure.error.message)
  process.exit(1)
}
console.log('ALL LEVELS SOLVABLE — regression OK')
