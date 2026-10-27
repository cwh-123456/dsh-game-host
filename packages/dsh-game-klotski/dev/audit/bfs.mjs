/**
 * Suite 1 — INDEPENDENT BFS for the four Klotski levels.
 *
 *   node packages/dsh-game-klotski/dev/audit/bfs.mjs
 *
 * Independent means:
 *   - the board/state/legality/win rules below are re-derived from
 *     handoff/to-sub/011-add-klotski.md (4x5, 10 pieces, slide 1-2 cells,
 *     no rotation, no overlap, Cao Cao's top-left at (1,3));
 *   - the BFS state graph is encoded as a 4x5 occupancy string of shape codes
 *     (shape-identical pieces are interchangeable, which preserves the
 *     shortest-path distance), i.e. a different representation from both
 *     client.js and dev/solve.mjs;
 *   - no client.js canSlide/applySlide/isWon is used, and dev/solve.mjs is
 *     never imported. Only `LEVELS` layout data is read through the test seam.
 *
 * It also checks the level data against the task book: piece army composition,
 * 2 empty cells, no overlap, and level 1 equals the "横刀立马" coordinates
 * cell-by-cell and anchor-by-anchor.
 */
import assert from 'node:assert/strict'
import { api } from './harness.mjs'

const W = 4
const H = 5
const EMPTY = 0
const CAO = 1 // 2x2
const GUAN = 2 // 2x1 horizontal
const VGEN = 3 // 1x2 vertical
const SOLDIER = 4 // 1x1
const SHAPES = {
  [CAO]: { w: 2, h: 2, label: '2x2' },
  [GUAN]: { w: 2, h: 1, label: '2x1' },
  [VGEN]: { w: 1, h: 2, label: '1x2' },
  [SOLDIER]: { w: 1, h: 1, label: '1x1' },
}
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]
const WIN = { x: 1, y: 3 }
const ARMY = { 1: 1, 2: 1, 3: 4, 4: 4 } // code -> expected count (task book)

const failures = []
function fail(scope, message, detail) {
  failures.push({ scope, message, detail })
  console.error('FAIL [' + scope + '] ' + message + (detail ? ' — ' + JSON.stringify(detail) : ''))
}

function shapeCode(def) {
  const key = def.w + 'x' + def.h
  if (key === '2x2') return CAO
  if (key === '2x1') return GUAN
  if (key === '1x2') return VGEN
  if (key === '1x1') return SOLDIER
  return -1
}

/** Spec-level validation of one LEVELS entry (rules from the task book). */
function validateLevel(level, index) {
  const scope = 'layout-L' + (index + 1)
  const grid = new Int8Array(W * H).fill(EMPTY)
  const counts = Object.create(null)
  let area = 0
  for (const def of level.pieces) {
    const code = shapeCode(def)
    if (code < 0) {
      fail(scope, 'piece has a shape not in the task book: ' + def.id)
      continue
    }
    counts[code] = (counts[code] || 0) + 1
    area += def.w * def.h
    for (let dy = 0; dy < def.h; dy += 1) {
      for (let dx = 0; dx < def.w; dx += 1) {
        const x = def.x + dx
        const y = def.y + dy
        if (x < 0 || y < 0 || x >= W || y >= H) {
          fail(scope, 'piece out of bounds: ' + def.id)
          continue
        }
        const cell = y * W + x
        if (grid[cell] !== EMPTY) fail(scope, 'pieces overlap at ' + x + ',' + y + ' (' + def.id + ')')
        grid[cell] = code
      }
    }
  }
  if (level.pieces.length !== 10) fail(scope, 'expected exactly 10 pieces, got ' + level.pieces.length)
  for (const code of Object.keys(ARMY)) {
    if ((counts[code] || 0) !== ARMY[code]) {
      fail(scope, 'army composition wrong for ' + SHAPES[code].label + ': expected ' + ARMY[code] + ', got ' + (counts[code] || 0))
    }
  }
  if (area !== 18) fail(scope, 'pieces must cover 18 of 20 cells, got ' + area)
  let empty = 0
  for (let i = 0; i < grid.length; i += 1) if (grid[i] === EMPTY) empty += 1
  if (empty !== 2) fail(scope, 'expected exactly 2 empty cells, got ' + empty)
  if (!Number.isInteger(level.par) || level.par <= 0) fail(scope, 'par must be a positive integer, got ' + level.par)
  const caoIndex = level.pieces.findIndex((def) => def.kind === 'cao')
  if (caoIndex < 0) fail(scope, 'level needs a piece with kind "cao"')
  else if (shapeCode(level.pieces[caoIndex]) !== CAO) fail(scope, 'Cao Cao must be the 2x2 piece')
  return { grid, empty }
}

/* ------------------------------------------------------------------------- */
/* Level 1 = task book "横刀立马" (rows 0..4 top->bottom, cols 0..3 left->right)*/
/* ------------------------------------------------------------------------- */

const SPEC_GRID = [
  ['张', '曹', '曹', '赵'],
  ['张', '曹', '曹', '赵'],
  ['马', '关', '关', '黄'],
  ['马', '兵', '兵', '黄'],
  ['兵', '空', '空', '兵'],
]
const SPEC_ANCHORS = [
  { name: '张飞', row: 0, col: 0 },
  { name: '曹操', row: 0, col: 1 },
  { name: '赵云', row: 0, col: 3 },
  { name: '马超', row: 2, col: 0 },
  { name: '关羽', row: 2, col: 1 },
  { name: '黄忠', row: 2, col: 3 },
]
const SPEC_SOLDIERS = [
  [1, 3], // (col,row) -> see conversion below
  [2, 3],
  [0, 4],
  [3, 4],
]

function checkLevelOneSpec(level) {
  const scope = 'L1-spec'
  const nameChar = { 张飞: '张', 曹操: '曹', 赵云: '赵', 马超: '马', 关羽: '关', 黄忠: '黄', 兵: '兵' }
  const actual = Array.from({ length: H }, () => Array(W).fill('空'))
  for (const def of level.pieces) {
    const ch = nameChar[def.name]
    if (!ch) {
      fail(scope, 'unexpected piece name in L1: ' + def.name)
      continue
    }
    for (let dy = 0; dy < def.h; dy += 1) {
      for (let dx = 0; dx < def.w; dx += 1) actual[def.y + dy][def.x + dx] = ch
    }
  }
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (actual[y][x] !== SPEC_GRID[y][x]) {
        fail(scope, 'cell (' + x + ',' + y + ') expected ' + SPEC_GRID[y][x] + ' got ' + actual[y][x], { row: y, col: x })
      }
    }
  }
  for (const expected of SPEC_ANCHORS) {
    const found = level.pieces.filter((def) => def.name === expected.name)
    if (found.length !== 1) {
      fail(scope, 'expected one piece named ' + expected.name + ', found ' + found.length)
      continue
    }
    if (found[0].x !== expected.col || found[0].y !== expected.row) {
      fail(scope, expected.name + ' anchor expected (col ' + expected.col + ', row ' + expected.row + '), got (col ' + found[0].x + ', row ' + found[0].y + ')')
    }
  }
  const soldiers = level.pieces
    .filter((def) => def.name === '兵')
    .map((def) => def.x + ',' + def.y)
    .sort()
  const specSoldiers = SPEC_SOLDIERS.map(([col, row]) => col + ',' + row).sort()
  if (JSON.stringify(soldiers) !== JSON.stringify(specSoldiers)) {
    fail(scope, 'soldier cells expected ' + JSON.stringify(specSoldiers) + ', got ' + JSON.stringify(soldiers))
  }
  // The task book says the exit is the bottom-middle 2x2, i.e. cols 1-2 rows 3-4.
  const exit = api.EXIT
  if (!exit || exit.x !== 1 || exit.y !== 3 || exit.w !== 2 || exit.h !== 2) {
    fail(scope, 'seam EXIT expected {x:1,y:3,w:2,h:2}, got ' + JSON.stringify(exit))
  }
}

/* ------------------------------------------------------------------------- */
/* Independent grid-string BFS                                               */
/* ------------------------------------------------------------------------- */

function piecesOf(grid) {
  const assigned = new Uint8Array(W * H)
  const out = []
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const cell = y * W + x
      const code = grid[cell]
      if (code === EMPTY || assigned[cell]) continue
      const shape = SHAPES[code]
      if (!shape) throw new Error('grid decode: unknown shape code ' + code + ' at ' + x + ',' + y)
      if (x + shape.w > W || y + shape.h > H) {
        throw new Error('grid decode: malformed ' + shape.label + ' at ' + x + ',' + y)
      }
      for (let dy = 0; dy < shape.h; dy += 1) {
        for (let dx = 0; dx < shape.w; dx += 1) {
          const c = (y + dy) * W + (x + dx)
          if (grid[c] !== code || assigned[c]) {
            throw new Error('grid decode: malformed ' + shape.label + ' at ' + x + ',' + y)
          }
        }
      }
      for (let dy = 0; dy < shape.h; dy += 1) {
        for (let dx = 0; dx < shape.w; dx += 1) assigned[(y + dy) * W + (x + dx)] = 1
      }
      out.push({ code, x, y, w: shape.w, h: shape.h })
    }
  }
  return out
}

function encode(grid) {
  let key = ''
  for (let i = 0; i < grid.length; i += 1) key += grid[i]
  return key
}

function decode(key) {
  const grid = new Int8Array(W * H)
  for (let i = 0; i < W * H; i += 1) grid[i] = key.charCodeAt(i) - 48
  return grid
}

function isWinGrid(grid) {
  const cao = piecesOf(grid).find((piece) => piece.code === CAO)
  return !!cao && cao.x === WIN.x && cao.y === WIN.y
}

/** All legal successor grids (1- and 2-cell slides, path must be clear). */
function successors(grid) {
  const out = []
  const pieces = piecesOf(grid)
  for (const piece of pieces) {
    for (const [dx, dy] of DIRS) {
      for (let step = 1; step <= 2; step += 1) {
        const nx = piece.x + dx * step
        const ny = piece.y + dy * step
        if (nx < 0 || ny < 0 || nx + piece.w > W || ny + piece.h > H) break
        let blocked = false
        for (let t = 1; t <= step && !blocked; t += 1) {
          for (let oy = 0; oy < piece.h && !blocked; oy += 1) {
            for (let ox = 0; ox < piece.w; ox += 1) {
              const cx = piece.x + dx * t + ox
              const cy = piece.y + dy * t + oy
              // Cells the piece itself still covers are not blockers; only cells
              // it newly enters must be empty (spec: "path must be clear").
              const own = cx >= piece.x && cx < piece.x + piece.w && cy >= piece.y && cy < piece.y + piece.h
              if (!own && grid[cy * W + cx] !== EMPTY) {
                blocked = true
                break
              }
            }
          }
        }
        if (blocked) break
        const next = grid.slice()
        for (let oy = 0; oy < piece.h; oy += 1) {
          for (let ox = 0; ox < piece.w; ox += 1) next[(piece.y + oy) * W + (piece.x + ox)] = EMPTY
        }
        for (let oy = 0; oy < piece.h; oy += 1) {
          for (let ox = 0; ox < piece.w; ox += 1) next[(ny + oy) * W + (nx + ox)] = piece.code
        }
        out.push(next)
      }
    }
  }
  return out
}

function solveGrid(startGrid) {
  const startedAt = process.hrtime.bigint()
  const startKey = encode(startGrid)
  const queue = [startKey]
  const distance = new Map([[startKey, 0]])
  const parent = new Map()
  let head = 0
  let edges = 0
  let goalKey = null

  while (head < queue.length) {
    const key = queue[head]
    head += 1
    const grid = decode(key)
    if (isWinGrid(grid)) {
      goalKey = key
      break
    }
    const depth = distance.get(key)
    for (const next of successors(grid)) {
      edges += 1
      const nextKey = encode(next)
      if (!distance.has(nextKey)) {
        distance.set(nextKey, depth + 1)
        parent.set(nextKey, key)
        queue.push(nextKey)
      }
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  if (goalKey === null) {
    return { solvable: false, par: -1, processed: head, discovered: distance.size, edges, elapsedMs }
  }

  // Reconstruct the shortest path and self-check every transition is one legal slide.
  const path = []
  let cursor = goalKey
  while (parent.has(cursor)) {
    path.push(cursor)
    cursor = parent.get(cursor)
  }
  path.push(startKey)
  path.reverse()
  for (let i = 1; i < path.length; i += 1) {
    const legal = successors(decode(path[i - 1])).some((g) => encode(g) === path[i])
    if (!legal) {
      return { solvable: false, par: -1, reason: 'path step ' + i + ' is not a legal slide', processed: head, discovered: distance.size, edges, elapsedMs }
    }
  }
  if (!isWinGrid(decode(goalKey))) {
    return { solvable: false, par: -1, reason: 'goal state is not a win', processed: head, discovered: distance.size, edges, elapsedMs }
  }

  return {
    solvable: true,
    par: path.length - 1,
    processed: head,
    discovered: distance.size,
    edges,
    pathLength: path.length - 1,
    elapsedMs,
  }
}

/* ------------------------------------------------------------------------- */
/* Run                                                                       */
/* ------------------------------------------------------------------------- */

console.log('=== Suite 1: independent BFS, 4x5 Klotski, ' + api.LEVELS.length + ' levels ===\n')

if (api.COLS !== W || api.ROWS !== H) fail('seam', 'COLS/ROWS expected 4x5, got ' + api.COLS + 'x' + api.ROWS)
if (api.LEVELS.length < 3) fail('seam', 'need at least 3 levels, got ' + api.LEVELS.length)

const levelIds = new Set()
const results = []
for (let index = 0; index < api.LEVELS.length; index += 1) {
  const level = api.LEVELS[index]
  if (levelIds.has(level.id)) fail('levels', 'duplicate level id: ' + level.id)
  levelIds.add(level.id)
  const { grid } = validateLevel(level, index)
  const solved = solveGrid(grid)
  results.push({ index, id: level.id, name: level.name, par: level.par, ...solved })
  const status = solved.solvable ? (solved.par === level.par ? 'PASS' : 'PAR-MISMATCH') : 'UNSOLVABLE'
  if (!solved.solvable) fail('bfs-L' + (index + 1), 'level is not solvable', solved)
  else if (solved.par !== level.par) {
    fail('bfs-L' + (index + 1), 'BFS shortest = ' + solved.par + ' but LEVELS.par = ' + level.par, solved)
  }
  console.log(
    'L' + (index + 1) + ' "' + level.name + '"  ' + status +
      '  par(declared)=' + level.par + '  par(bfs)=' + solved.par +
      '  states(processed)=' + solved.processed + '  states(discovered)=' + solved.discovered +
      '  edges=' + solved.edges + '  ' + solved.elapsedMs.toFixed(1) + 'ms',
  )
}

console.log('\n--- L1 task-book coordinate check ("横刀立马", cell by cell) ---')
checkLevelOneSpec(api.LEVELS[0])
if (failures.length === 0) console.log('L1 matches the task book grid, anchors and soldier cells exactly.')

console.log('\n--- Result ---')
console.log(JSON.stringify({ levels: results.map((r) => ({ id: r.id, name: r.name, declaredPar: r.par, bfsPar: r.par, solvable: r.solvable, processed: r.processed, discovered: r.discovered, edges: r.edges, ms: Number(r.elapsedMs.toFixed(2)) })), failures }, null, 2))

if (failures.length > 0) {
  console.error('\nSUITE 1 FAILED: ' + failures.length + ' failure(s)')
  process.exitCode = 1
} else {
  console.log('\nSUITE 1 PASS — all ' + api.LEVELS.length + ' levels solvable, par values match BFS, L1 matches task book.')
}
