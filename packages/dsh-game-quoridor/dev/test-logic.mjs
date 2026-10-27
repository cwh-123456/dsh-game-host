/**
 * Logic / rules self test for @local/dsh-game-quoridor.
 *
 * Run: node dev/test-logic.mjs
 *
 * 只依赖测试 seam（window.__DSH_GAME_QUORIDOR__ 的 Q + sanitizeSave/serializeSave），
 * 不挂载 canvas、不跑游戏实例。覆盖：
 *   - 走子：直跳 / 直跳被墙挡后的斜跳 / 贴边（列边、行边）斜跳
 *   - 墙：重叠 / 交叉 / 首尾相接 / 越界 / 封死拒绝 / 墙数耗尽
 *   - 任意格到目标行获胜、悔棋还原 over/winner
 *   - 界面几何：wallSeg 覆盖的边 == 引擎挡的边；wallAt 128 面墙可指到、不越界、
 *     R 翻转只换朝向；cellAt；computeLayout
 *   - 存档：serializeSave -> JSON -> sanitizeSave round-trip + 各类损坏拒绝
 */
import assert from 'node:assert/strict'

/* ---------------------------------------------------------------------------
 * 最小 fake env：只为让 client.js 的 seam 安装逻辑跑起来
 * ------------------------------------------------------------------------ */

const windowStub = {
  __DSH_GAME_QUORIDOR_TEST__: true,
  __ModuleLoader__: {
    load(definition) {
      windowStub.__definition = definition
    },
  },
  localStorage: {
    getItem() {
      return null
    },
    setItem() {},
    removeItem() {},
  },
  performance: { now: () => Date.now() },
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  ResizeObserver: null,
}

globalThis.window = windowStub
globalThis.document = {
  hidden: false,
  createElement() {
    throw new Error('test-logic: DOM is not expected to be used')
  },
  addEventListener() {},
  removeEventListener() {},
}

await import(new URL('../client.js', import.meta.url).href)

const seam = globalThis.window.__DSH_GAME_QUORIDOR__
assert.ok(seam, 'test seam should be installed')
const Q = seam.Q

/* ---------------------------------------------------------------------------
 * 测试基础设施
 * ------------------------------------------------------------------------ */

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

function idx(r, c) {
  return r * 9 + c
}

function cellIndex(r, c) {
  return Q.idx(r, c)
}

/** 用 move/wall 直接摆一个状态（不校验可玩性，仅用于规则函数测试）。 */
function makeState(pawn, options) {
  const opts = options || {}
  const state = Q.newState()
  state.pawn = pawn.slice()
  if (opts.walls) state.walls = opts.walls.slice()
  if (opts.hw) {
    for (const slot of opts.hw) state.hw[slot] = 1
  }
  if (opts.vw) {
    for (const slot of opts.vw) state.vw[slot] = 1
  }
  if (opts.turn !== undefined) state.turn = opts.turn
  Q.rehash(state)
  return state
}

function sorted(values) {
  return values.slice().sort((a, b) => a - b)
}

function assertMoveSet(actual, expected, message) {
  assert.deepEqual(sorted(actual), sorted(expected), message)
}

function pairs(flat) {
  const out = []
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

/* 与 dev/test-headless.mjs 相同的确定性封死局面（[mv, me] 历史） */
const SEALED_HISTORY = [
  67, 0, 5, 1, 58, 0, 104, 1, 166, 0, 6, 1, 57, 0, 5, 1, 58, 0, 190, 1, 160, 0, 14, 1,
  59, 0, 13, 1, 68, 0, 202, 1, 69, 0, 22, 1, 78, 0, 31, 1, 79, 0, 192, 1, 80, 0, 196, 1,
  71, 0, 32, 1, 70, 0, 99, 1, 61, 0, 110, 1, 60, 0, 113, 1, 61, 0, 150, 1, 70, 0, 23, 1,
  71, 0, 123, 1, 161, 0, 22, 1, 70, 0, 31, 1, 108, 0, 30, 1, 79, 0, 31, 1, 80, 0, 22, 1,
  71, 0, 31, 1, 80, 0, 22, 1, 101, 0, 21, 1,
]

function replay(history) {
  const game = new Q.Game()
  for (const entry of history) {
    assert.equal(game.st.turn, entry[1], 'history turn mismatch')
    assert.equal(game.play(entry[0]), true, 'history move should be legal: ' + entry[0])
  }
  return game
}

/* ---------------------------------------------------------------------------
 * 1) seam / 引擎元数据
 * ------------------------------------------------------------------------ */

test('seam metadata and engine exports are intact', () => {
  assert.equal(seam.GAME_ID, 'quoridor')
  assert.equal(seam.STORE_KEY, 'dsh.game.quoridor.v1')
  assert.equal(seam.SCHEMA_VERSION, 1)
  assert.equal(seam.LOGICAL_SIZE, 610)
  assert.equal(seam.CELL, 58)
  assert.equal(seam.PAD, 44)
  assert.equal(seam.WALL_THICKNESS, 10)
  assert.equal(Q.N, 9)
  assert.equal(Q.NW, 8)
  assert.equal(Q.MAX_WALLS, 10)
  assert.equal(Q.INF, 1e9)
  assert.deepEqual(Q.GOAL_ROW, [0, 8])
  assert.deepEqual(Q.START, [76, 4])
  for (const name of [
    'newState', 'cloneState', 'legalMoves', 'pawnMoves', 'canStepIn', 'wallFits',
    'tryPlaceWall', 'fillDist', 'distOf', 'distanceToGoal', 'blockedBetween',
    'applyMove', 'undoMove', 'rehash', 'encodeWall', 'decodeMove', 'chooseMove', 'Game',
  ]) {
    assert.equal(typeof Q[name], 'function', 'Q.' + name)
  }
})

test('newState starts from the documented position', () => {
  const state = Q.newState()
  assert.deepEqual(state.pawn, [76, 4])
  assert.deepEqual(state.walls, [10, 10])
  assert.equal(state.turn, Q.RED)
  assert.equal(state.hw.length, 64)
  assert.equal(state.vw.length, 64)
  assert.equal(state.hw.reduce((sum, value) => sum + value, 0), 0)
  assert.equal(Q.distanceToGoal(state, Q.RED), 8)
  assert.equal(Q.distanceToGoal(state, Q.BLUE), 8)
  assertMoveSet(Q.legalMoves(state, Q.RED), [idx(7, 4), idx(8, 3), idx(8, 5)])
  assertMoveSet(Q.legalMoves(state, Q.BLUE), [idx(1, 4), idx(0, 3), idx(0, 5)])
  assert.equal(Q.canStepIn(state, Q.RED), false)
  assert.equal(Q.canStepIn(state, Q.BLUE), false)
})

/* ---------------------------------------------------------------------------
 * 2) 走子细则：直跳 / 斜跳 / 贴边斜跳
 * ------------------------------------------------------------------------ */

test('straight jump: a pawn may leap over the adjacent opponent', () => {
  // 红 (4,4) 往上撞蓝 (3,4) -> 直跳到 (2,4)
  const state = makeState([idx(4, 4), idx(3, 4)])
  assertMoveSet(Q.legalMoves(state, Q.RED), [idx(2, 4), idx(5, 4), idx(4, 3), idx(4, 5)])
  assert.ok(Q.legalMoves(state, Q.RED).indexOf(idx(2, 4)) >= 0)
  // 蓝 (4,4) 往下撞红 (5,4) -> 直跳到 (6,4)
  const state2 = makeState([idx(5, 4), idx(4, 4)], { turn: Q.BLUE })
  assert.ok(Q.legalMoves(state2, Q.BLUE).indexOf(idx(6, 4)) >= 0)
})

test('straight jump blocked by a wall falls back to diagonals', () => {
  // 红 (4,4) 撞蓝 (3,4)；直跳落点 (2,4) 与蓝之间放横墙 H(2,4) 挡住
  const state = makeState([idx(4, 4), idx(3, 4)], { hw: [2 * 8 + 4] })
  assert.equal(Q.blockedBetween(state, idx(3, 4), idx(2, 4)), true, 'precondition: the straight landing is walled off')
  const moves = Q.legalMoves(state, Q.RED)
  assert.equal(moves.indexOf(idx(2, 4)), -1, 'straight jump must be illegal when walled')
  assert.ok(moves.indexOf(idx(3, 3)) >= 0, 'diagonal left is legal')
  assert.ok(moves.indexOf(idx(3, 5)) >= 0, 'diagonal right is legal')
})

test('edge diagonal jump: opponent on the right column edge', () => {
  // 红 (3,7) 往右撞蓝 (3,8)：直跳 (3,9) 越界，只能斜跳 (2,8)/(4,8)
  const state = makeState([idx(3, 7), idx(3, 8)])
  const moves = Q.legalMoves(state, Q.RED)
  assert.ok(moves.indexOf(idx(2, 8)) >= 0, 'diagonal up-right')
  assert.ok(moves.indexOf(idx(4, 8)) >= 0, 'diagonal down-right')
  assert.equal(moves.indexOf(idx(3, 8)), -1, 'opponent cell itself is not a legal landing')
})

test('edge diagonal jump: opponent on the bottom row edge', () => {
  // 红 (7,4) 往下撞蓝 (8,4)：直跳 (9,4) 越界，只能斜跳 (8,3)/(8,5)
  const state = makeState([idx(7, 4), idx(8, 4)])
  const moves = Q.legalMoves(state, Q.RED)
  assert.ok(moves.indexOf(idx(8, 3)) >= 0)
  assert.ok(moves.indexOf(idx(8, 5)) >= 0)
})

test('diagonal jump is rejected when a wall sits between opponent and landing', () => {
  // 红 (3,7) 撞蓝 (3,8)；斜跳 (2,8) 需要蓝与 (2,8) 之间无墙。
  // (3,8)-(2,8) 是竖边，用 H(2,8)... c 最大 7，边界列 8 只能靠 hw[2*8+7]。
  const state = makeState([idx(3, 7), idx(3, 8)], { hw: [2 * 8 + 7] })
  assert.equal(Q.blockedBetween(state, idx(3, 8), idx(2, 8)), true)
  const moves = Q.legalMoves(state, Q.RED)
  assert.equal(moves.indexOf(idx(2, 8)), -1, 'blocked diagonal must not be offered')
  assert.ok(moves.indexOf(idx(4, 8)) >= 0, 'the unblocked diagonal stays legal')
})

test('normal step is blocked by a wall between the cells', () => {
  const state = makeState([idx(8, 4), idx(0, 4)])
  // hw[7*8+4] 挡住 (8,4)-(7,4) 这条竖边
  const blockedState = makeState([idx(8, 4), idx(0, 4)], { hw: [7 * 8 + 4] })
  assert.equal(Q.blockedBetween(blockedState, idx(8, 4), idx(7, 4)), true)
  assert.equal(Q.legalMoves(blockedState, Q.RED).indexOf(idx(7, 4)), -1)
  assert.ok(Q.legalMoves(state, Q.RED).indexOf(idx(7, 4)) >= 0)
})

/* ---------------------------------------------------------------------------
 * 3) 墙细则：重叠 / 交叉 / 首尾相接 / 封死 / 耗尽
 * ------------------------------------------------------------------------ */

test('wall overlap is rejected (same slot and adjacent same-row slots)', () => {
  const state = makeState([idx(8, 4), idx(0, 4)])
  assert.equal(Q.wallFits(state, Q.H, 2, 2), true)
  state.hw[2 * 8 + 2] = 1
  assert.equal(Q.wallFits(state, Q.H, 2, 2), false, 'exact overlap')
  assert.equal(Q.wallFits(state, Q.H, 2, 3), false, 'horizontal overlap (spans two cells)')
  assert.equal(Q.wallFits(state, Q.H, 2, 1), false, 'horizontal overlap on the left')
  assert.equal(Q.wallFits(state, Q.V, 2, 2), false, 'crossing wall')
  assert.equal(Q.wallFits(state, Q.V, 3, 2), true, 'a vertical wall one row down does not overlap')
})

test('crossing walls are rejected from both orientations', () => {
  const withH = makeState([idx(8, 4), idx(0, 4)], { hw: [3 * 8 + 3] })
  assert.equal(Q.wallFits(withH, Q.V, 3, 3), false, 'V over H is illegal')
  const withV = makeState([idx(8, 4), idx(0, 4)], { vw: [3 * 8 + 3] })
  assert.equal(Q.wallFits(withV, Q.H, 3, 3), false, 'H over V is illegal')
})

test('butt-jointed walls are allowed (no overlap / no cross)', () => {
  const state = makeState([idx(8, 4), idx(0, 4)], { hw: [2 * 8 + 2] })
  assert.equal(Q.wallFits(state, Q.H, 2, 4), true, 'H at c+2 continues the same line')
  assert.equal(Q.wallFits(state, Q.V, 2, 4), true, 'V at the far anchor does not cross')
  assert.equal(Q.wallFits(state, Q.H, 3, 2), true, 'another row is free')
  const state2 = makeState([idx(8, 4), idx(0, 4)], { vw: [2 * 8 + 2] })
  assert.equal(Q.wallFits(state2, Q.V, 4, 2), true, 'V two rows down continues the line')
  assert.equal(Q.wallFits(state2, Q.V, 3, 2), false, 'V one row down overlaps')
  assert.equal(Q.wallFits(state2, Q.H, 2, 2), false, 'H crosses the V')
})

test('walls outside 0..7 are rejected', () => {
  const state = makeState([idx(8, 4), idx(0, 4)])
  assert.equal(Q.wallFits(state, Q.H, -1, 0), false)
  assert.equal(Q.wallFits(state, Q.H, 8, 0), false)
  assert.equal(Q.wallFits(state, Q.H, 0, -1), false)
  assert.equal(Q.wallFits(state, Q.V, 0, 8), false)
})

test('tryPlaceWall rejects a wall that seals any player', () => {
  const game = replay(pairs(SEALED_HISTORY))
  const state = game.st
  const wall = { o: Q.V, r: 3, c: 1 }
  assert.equal(Q.wallFits(state, wall.o, wall.r, wall.c), true, 'geometrically legal')
  const before = { hw: Array.from(state.hw), vw: Array.from(state.vw) }
  assert.equal(Q.tryPlaceWall(state, wall.o, wall.r, wall.c, state.turn), false, 'sealing wall is illegal')
  assert.deepEqual(Array.from(state.hw), before.hw, 'tryPlaceWall must not mutate the board')
  assert.deepEqual(Array.from(state.vw), before.vw, 'tryPlaceWall must not mutate the board')
  // 同一局面下普通墙仍然可放
  let placed = 0
  for (let r = 0; r < 8 && placed === 0; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      if (Q.wallFits(state, Q.H, r, c) && Q.tryPlaceWall(state, Q.H, r, c, state.turn)) {
        placed += 1
        break
      }
    }
  }
  assert.ok(placed >= 1, 'there must be at least one legal wall in this position')
})

test('a wall is rejected when the player has no walls left', () => {
  const state = makeState([idx(8, 4), idx(0, 4)], { walls: [0, 10] })
  assert.equal(Q.tryPlaceWall(state, Q.H, 3, 3, Q.RED), false)
  const game = new Q.Game()
  game.st.walls[Q.RED] = 0
  assert.equal(game.canWall(Q.H, 3, 3), false)
})

test('placing a wall consumes the wall and can be undone exactly', () => {
  const game = new Q.Game()
  const hashBefore = [game.st.h1, game.st.h2]
  const stateBefore = Array.from(game.st.hw)
  assert.equal(game.play(Q.encodeWall(Q.H, 2, 2)), true)
  assert.equal(game.st.walls[Q.RED], 9)
  assert.equal(game.st.hw[2 * 8 + 2], 1)
  assert.equal(game.st.turn, Q.BLUE)
  assert.equal(game.last(), Q.encodeWall(Q.H, 2, 2))
  assert.equal(game.undo(), true)
  assert.equal(game.st.walls[Q.RED], 10)
  assert.equal(game.st.hw[2 * 8 + 2], 0)
  assert.equal(game.st.turn, Q.RED)
  assert.deepEqual([game.st.h1, game.st.h2], hashBefore)
  assert.deepEqual(Array.from(game.st.hw), stateBefore)
  assert.equal(game.last(), -1)
  assert.equal(game.undo(), false)
})

test('Zobrist rehash is deterministic for the same position', () => {
  const game = new Q.Game()
  game.play(Q.idx(7, 4))
  game.play(Q.encodeWall(Q.V, 3, 3))
  game.play(Q.idx(6, 4))
  const clone = Q.cloneState(game.st)
  Q.rehash(game.st)
  Q.rehash(clone)
  assert.deepEqual([game.st.h1, game.st.h2], [clone.h1, clone.h2])
  const before = [game.st.h1, game.st.h2]
  const token = Q.applyMove(game.st, Q.idx(4, 4), game.st.turn)
  Q.undoMove(game.st, Q.idx(4, 4), game.st.turn ^ 1, token)
  assert.deepEqual([game.st.h1, game.st.h2], before, 'applyMove + undoMove must restore the hash')
})

/* ---------------------------------------------------------------------------
 * 4) 获胜 / 距离 / 封死距离
 * ------------------------------------------------------------------------ */

test('winning by stepping onto any cell of the goal row', () => {
  for (const col of [0, 4, 8]) {
    const game = new Q.Game()
    game.st.pawn[Q.BLUE] = idx(8, 0) // 把蓝方挪开，避免挡住红方的落点
    game.st.pawn[Q.RED] = idx(1, col)
    game.st.turn = Q.RED
    assert.equal(game.play(idx(0, col)), true)
    assert.equal(game.over, true)
    assert.equal(game.winner, Q.RED)
    assert.equal(game.undo(), true)
    assert.equal(game.over, false)
    assert.equal(game.winner, -1)
    assert.equal(game.st.pawn[Q.RED], idx(1, col))
  }
  for (const col of [0, 4, 8]) {
    const game = new Q.Game()
    game.st.pawn[Q.RED] = idx(0, 0) // 把红方挪开，避免挡住蓝方的落点
    game.st.pawn[Q.BLUE] = idx(7, col)
    game.st.turn = Q.BLUE
    assert.equal(game.play(idx(8, col)), true)
    assert.equal(game.over, true)
    assert.equal(game.winner, Q.BLUE)
  }
})

test('a won game refuses further moves', () => {
  const game = new Q.Game()
  game.st.pawn[Q.BLUE] = idx(8, 8)
  game.st.pawn[Q.RED] = idx(1, 4)
  game.st.turn = Q.RED
  assert.equal(game.play(idx(0, 4)), true)
  assert.equal(game.play(idx(0, 5)), false)
  assert.equal(game.play(Q.encodeWall(Q.H, 0, 0)), false)
})

test('distanceToGoal / distOf / INF for unreachable cells', () => {
  const state = Q.newState()
  assert.equal(Q.distanceToGoal(state, Q.RED), 8)
  assert.equal(Q.distanceToGoal(state, Q.BLUE), 8)
  assert.equal(Q.distOf(state, Q.GOAL_ROW[Q.RED], state.pawn[Q.RED]), 8)
  // 把红方整行入口封住（直接改数组，仅测 BFS）：hw[7*8+c] 覆盖 8 列 -> 9 条竖边全封
  const walled = Q.newState()
  for (let c = 0; c < 8; c += 1) walled.hw[7 * 8 + c] = 1
  assert.equal(Q.distOf(walled, Q.GOAL_ROW[Q.RED], walled.pawn[Q.RED]), Q.INF)
  assert.equal(Q.distanceToGoal(walled, Q.RED), Q.INF)
  // 整行封条会把双方都挡在目标行外
  assert.equal(Q.distanceToGoal(walled, Q.BLUE), Q.INF)
})

test('canStepIn only reports moves that reach the goal row', () => {
  assert.equal(Q.canStepIn(makeState([idx(1, 4), idx(0, 4)]), Q.RED), true)
  assert.equal(Q.canStepIn(makeState([idx(2, 4), idx(0, 4)]), Q.RED), false)
  // 蓝方在 (7,4)，下方 (8,4) 属于蓝方目标行
  assert.equal(Q.canStepIn(makeState([idx(0, 4), idx(7, 4)], { turn: Q.BLUE }), Q.BLUE), true)
})

/* ---------------------------------------------------------------------------
 * 5) 走法编码 / Game 基础
 * ------------------------------------------------------------------------ */

test('encodeMove / decodeMove round-trip for all 209 moves', () => {
  for (let move = 0; move < 81; move += 1) {
    const decoded = Q.decodeMove(move)
    assert.equal(decoded.t, 'move')
    assert.equal(decoded.to, move)
    assert.equal(decoded.r, Q.rOf(move))
    assert.equal(decoded.c, Q.cOf(move))
  }
  for (let o = 0; o < 2; o += 1) {
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const encoded = Q.encodeWall(o, r, c)
        assert.ok(encoded >= 81 && encoded <= 208)
        const decoded = Q.decodeMove(encoded)
        assert.deepEqual(decoded, { t: 'wall', o, r, c })
        assert.equal(Q.encodeWall(decoded.o, decoded.r, decoded.c), encoded)
      }
    }
  }
})

test('Game rejects illegal moves without mutating the state', () => {
  const game = new Q.Game()
  assert.equal(game.play(idx(7, 4)), true) // 红方合法一步
  assert.equal(game.play(Q.encodeWall(Q.H, 2, 2)), true) // 蓝方合法放墙
  const before = JSON.stringify({ pawn: game.st.pawn, walls: game.st.walls, hw: Array.from(game.st.hw), turn: game.st.turn })
  assert.equal(game.play(idx(0, 0)), false, 'not a legal red pawn move')
  assert.equal(game.play(Q.encodeWall(Q.H, 2, 2)), false, 'overlapping wall must be rejected')
  assert.equal(JSON.stringify({ pawn: game.st.pawn, walls: game.st.walls, hw: Array.from(game.st.hw), turn: game.st.turn }), before)
  assert.equal(game.hist.length, 2)
})

test('chooseMove returns a legal move', () => {
  const game = new Q.Game()
  game.play(Q.idx(7, 4))
  const result = Q.chooseMove(game.st, { timeMs: 1e9, maxDepth: 1, wallLimit: 4, blunder: 0, noise: 0 })
  assert.ok(result && typeof result.mv === 'number')
  const legal = game.legalMoves().concat()
  // 墙候选也必须是引擎认可的合法墙
  if (result.mv < 81) {
    assert.ok(legal.indexOf(result.mv) >= 0, 'chosen pawn move must be legal')
  } else {
    const decoded = Q.decodeMove(result.mv)
    assert.equal(game.canWall(decoded.o, decoded.r, decoded.c), true, 'chosen wall must be legal')
  }
  assert.equal(typeof Q.DIFFICULTY[1].timeMs, 'number')
  assert.equal(Q.DIFFICULTY[3].name, '困难')
})

/* ---------------------------------------------------------------------------
 * 6) 界面几何（对照 verify_wallseg.js / verify_ui.js 的规则）
 * ------------------------------------------------------------------------ */

test('wallSeg covers exactly the edges the engine blocks (all 128 walls)', () => {
  function segEdges(o, r, c) {
    const seg = seam.wallSeg(o, r, c)
    const x1 = Math.round((seg[0] - seam.PAD) / seam.CELL)
    const y1 = Math.round((seg[1] - seam.PAD) / seam.CELL)
    const x2 = Math.round((seg[2] - seam.PAD) / seam.CELL)
    const y2 = Math.round((seg[3] - seam.PAD) / seam.CELL)
    const out = []
    if (o === Q.H) {
      for (let x = x1; x < x2; x += 1) out.push('vert@' + y1 + ':' + x + '-' + (x + 1))
    } else {
      for (let y = y1; y < y2; y += 1) out.push('horz@' + x1 + ':' + y + '-' + (y + 1))
    }
    return out.sort()
  }
  function engineEdges(o, r, c) {
    const state = Q.newState()
    const arr = o === Q.H ? state.hw : state.vw
    arr[r * 8 + c] = 1
    const out = []
    for (let rr = 0; rr < 9; rr += 1) {
      for (let cc = 0; cc < 9; cc += 1) {
        const p = Q.idx(rr, cc)
        if (rr < 8 && Q.blockedBetween(state, p, Q.idx(rr + 1, cc))) out.push('vert@' + (rr + 1) + ':' + cc + '-' + (cc + 1))
        if (cc < 8 && Q.blockedBetween(state, p, Q.idx(rr, cc + 1))) out.push('horz@' + (cc + 1) + ':' + rr + '-' + (rr + 1))
      }
    }
    return out.sort()
  }
  let checked = 0
  for (const o of [Q.H, Q.V]) {
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        assert.deepEqual(segEdges(o, r, c), engineEdges(o, r, c), 'wallSeg coverage mismatch for ' + (o === Q.H ? 'H' : 'V') + '(' + r + ',' + c + ')')
        checked += 1
      }
    }
  }
  assert.equal(checked, 128)
})

test('wallAt resolves all 128 walls and never goes out of bounds', () => {
  let seen = 0
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      const centerX = seam.PAD + (c + 1) * seam.CELL
      const centerY = seam.PAD + (r + 1) * seam.CELL
      const vHit = seam.wallAt(centerX, centerY + seam.CELL * 0.25, false)
      assert.deepEqual(vHit, { o: Q.V, r, c }, 'V(' + r + ',' + c + ')')
      const hHit = seam.wallAt(centerX + seam.CELL * 0.25, centerY, false)
      assert.deepEqual(hHit, { o: Q.H, r, c }, 'H(' + r + ',' + c + ')')
      seen += 2
    }
  }
  assert.equal(seen, 128, '64 个墙位 × H/V 两种朝向 = 128 面墙')
  // 全平面扫描：返回的墙位必须合法
  for (let mx = -1; mx <= 10; mx += 0.25) {
    for (let my = -1; my <= 10; my += 0.25) {
      for (const flipped of [false, true]) {
        const wall = seam.wallAt(mx, my, flipped)
        if (!wall) continue
        assert.ok(wall.r >= 0 && wall.r <= 7 && wall.c >= 0 && wall.c <= 7, 'out-of-bounds wall')
        assert.ok(wall.o === Q.H || wall.o === Q.V)
      }
    }
  }
})

test('wallAt preview covers the pointer and R-flip only swaps orientation', () => {
  for (let mx = 0; mx <= 9; mx += 0.25) {
    for (let my = 0; my <= 9; my += 0.25) {
      const wall = seam.wallAt(0, 0, false)
      assert.ok(wall === null || (wall.r >= 0 && wall.r <= 7))
      const found = seam.wallAt(
        seam.PAD + mx * seam.CELL,
        seam.PAD + my * seam.CELL,
        false,
      )
      if (!found) continue
      if (found.o === Q.H) {
        assert.ok(mx >= found.c && mx <= found.c + 2)
        assert.ok(Math.abs(my - (found.r + 1)) < 0.3)
      } else {
        assert.ok(my >= found.r && my <= found.r + 2)
        assert.ok(Math.abs(mx - (found.c + 1)) < 0.3)
      }
      const flipped = seam.wallAt(seam.PAD + mx * seam.CELL, seam.PAD + my * seam.CELL, true)
      // 恰好落在网格线交点上时翻转只换朝向；否则可能返回 null 或另一面相邻墙
      if (flipped && found) {
        assert.equal(flipped.r, found.r)
        assert.equal(flipped.c, found.c)
        assert.notEqual(flipped.o, found.o)
      }
    }
  }
})

test('cellAt maps cell centers and rejects the margin', () => {
  for (let r = 0; r < 9; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      const x = seam.PAD + c * seam.CELL + seam.CELL / 2
      const y = seam.PAD + r * seam.CELL + seam.CELL / 2
      assert.equal(seam.cellAt(x, y), idx(r, c))
    }
  }
  assert.equal(seam.cellAt(0, 0), -1)
  assert.equal(seam.cellAt(seam.LOGICAL_SIZE, seam.LOGICAL_SIZE), -1)
  assert.equal(seam.cellAt(seam.PAD - 1, seam.PAD - 1), -1)
})

test('computeLayout keeps a square canvas and clamps to a positive size', () => {
  const wide = seam.computeLayout(800, 600)
  assert.equal(wide.cssWidth, 600)
  assert.equal(wide.cssHeight, 600)
  assert.ok(Math.abs(wide.scale - 600 / 610) < 1e-9)
  const tall = seam.computeLayout(360, 520)
  assert.equal(tall.cssWidth, 360)
  assert.equal(tall.cssHeight, 360)
  assert.ok(Math.abs(tall.scale - 360 / 610) < 1e-9)
  const exact = seam.computeLayout(610, 610)
  assert.equal(exact.cssWidth, 610)
  assert.ok(Math.abs(exact.scale - 1) < 1e-9)
  const tiny = seam.computeLayout(0, 0)
  assert.equal(tiny.cssWidth, 1)
  assert.equal(tiny.cssHeight, 1)
  const negative = seam.computeLayout(-50, -50)
  assert.equal(negative.cssWidth, 1)
  const big = seam.computeLayout(2000, 1600)
  assert.equal(big.cssWidth, 1600)
  assert.equal(big.cssHeight, 1600)
  for (const pair of [[800, 600], [360, 520], [1100, 700], [0, 0], [610, 610]]) {
    const layout = seam.computeLayout(pair[0], pair[1])
    assert.equal(layout.cssWidth, layout.cssHeight)
    assert.ok(layout.cssWidth >= 1)
  }
})

/* ---------------------------------------------------------------------------
 * 7) 存档：serialize -> sanitize round-trip 与损坏拒绝
 * ------------------------------------------------------------------------ */

test('save round-trip preserves a fresh game', () => {
  const game = new Q.Game()
  const payload = seam.serializeSave(game, { mode: 'pvp', mySide: 0, level: 2, speed: 400 })
  const sanitized = seam.sanitizeSave(JSON.parse(JSON.stringify(payload)))
  assert.ok(sanitized)
  assert.equal(sanitized.mode, 'pvp')
  assert.equal(sanitized.mySide, 0)
  assert.equal(sanitized.level, 2)
  assert.equal(sanitized.speed, 400)
  assert.deepEqual(sanitized.game.st.pawn, [76, 4])
  assert.deepEqual(sanitized.game.st.walls, [10, 10])
  assert.equal(sanitized.game.st.turn, 0)
  assert.equal(sanitized.game.hist.length, 0)
  assert.equal(sanitized.game.over, false)
  assert.equal(sanitized.game.winner, -1)
})

test('save round-trip preserves a mid-game position (moves + wall + menus)', () => {
  const game = new Q.Game()
  assert.equal(game.play(idx(7, 4)), true)
  assert.equal(game.play(Q.encodeWall(Q.V, 3, 3)), true)
  assert.equal(game.play(idx(6, 4)), true)
  assert.equal(game.play(Q.encodeWall(Q.H, 2, 5)), true)
  const payload = seam.serializeSave(game, { mode: 'pve', mySide: 1, level: 3, speed: 850 })
  const sanitized = seam.sanitizeSave(JSON.parse(JSON.stringify(payload)))
  assert.ok(sanitized)
  assert.equal(sanitized.mode, 'pve')
  assert.equal(sanitized.mySide, 1)
  assert.equal(sanitized.level, 3)
  assert.equal(sanitized.speed, 850)
  assert.deepEqual(sanitized.game.st.pawn, game.st.pawn)
  assert.deepEqual(sanitized.game.st.walls, game.st.walls)
  assert.deepEqual(Array.from(sanitized.game.st.hw), Array.from(game.st.hw))
  assert.deepEqual(Array.from(sanitized.game.st.vw), Array.from(game.st.vw))
  assert.equal(sanitized.game.st.turn, game.st.turn)
  assert.equal(sanitized.game.hist.length, game.hist.length)
  assert.equal(sanitized.game.hist[1].mv, Q.encodeWall(Q.V, 3, 3))
  assert.equal(sanitized.game.over, false)
})

test('save round-trip preserves a finished game', () => {
  // 用合法历史走到红方获胜：红沿中列连走 7 步，蓝在顶行左右让位。
  const game = new Q.Game()
  const redUp = [idx(7, 4), idx(6, 4), idx(5, 4), idx(4, 4), idx(3, 4), idx(2, 4), idx(1, 4)]
  const blueSide = [idx(0, 3), idx(0, 4), idx(0, 3), idx(0, 4), idx(0, 3), idx(0, 4)]
  for (let i = 0; i < redUp.length; i += 1) {
    assert.equal(game.play(redUp[i]), true, 'red up ' + i)
    if (i < blueSide.length) assert.equal(game.play(blueSide[i]), true, 'blue side ' + i)
  }
  assert.equal(game.play(idx(0, 5)), true, 'blue moves clear of the goal cell')
  assert.equal(game.play(idx(0, 4)), true, 'red steps onto the goal row')
  assert.equal(game.over, true)
  assert.equal(game.winner, Q.RED)
  const payload = seam.serializeSave(game, { mode: 'pvp', mySide: 0, level: 2, speed: 400 })
  const sanitized = seam.sanitizeSave(JSON.parse(JSON.stringify(payload)))
  assert.ok(sanitized)
  assert.equal(sanitized.game.over, true)
  assert.equal(sanitized.game.winner, Q.RED)
  assert.equal(sanitized.game.hist.length, game.hist.length)
})

test('sanitizeSave rejects malformed saves', () => {
  const game = new Q.Game()
  game.play(idx(7, 4))
  const base = seam.serializeSave(game, { mode: 'pvp', mySide: 0, level: 2, speed: 400 })
  function mutated(fn) {
    const copy = JSON.parse(JSON.stringify(base))
    fn(copy)
    return seam.sanitizeSave(copy)
  }
  assert.equal(seam.sanitizeSave(null), null)
  assert.equal(seam.sanitizeSave(undefined), null)
  assert.equal(seam.sanitizeSave('nope'), null)
  assert.equal(seam.sanitizeSave([]), null)
  assert.equal(mutated((copy) => { copy.schemaVersion = 2 }), null)
  assert.equal(mutated((copy) => { copy.mode = 'coop' }), null)
  assert.equal(mutated((copy) => { copy.mySide = 2 }), null)
  assert.equal(mutated((copy) => { copy.level = 0 }), null)
  assert.equal(mutated((copy) => { copy.level = 4 }), null)
  assert.equal(mutated((copy) => { copy.speed = 'fast' }), null)
  assert.equal(mutated((copy) => { copy.speed = Number.NaN }), null)
  assert.equal(mutated((copy) => { copy.game = null }), null)
  assert.equal(mutated((copy) => { copy.game.st = null }), null)
  assert.equal(mutated((copy) => { copy.game.st.pawn = [999, 4] }), null)
  assert.equal(mutated((copy) => { copy.game.st.pawn = [5, 5] }), null)
  assert.equal(mutated((copy) => { copy.game.st.walls = [-1, 10] }), null)
  assert.equal(mutated((copy) => { copy.game.st.hw[0] = 1 }), null)
  assert.equal(mutated((copy) => { copy.game.st.vw[0] = 2 }), null)
  assert.equal(mutated((copy) => { copy.game.st.turn = 2 }), null)
  assert.equal(mutated((copy) => { copy.game.hist = 'nope' }), null)
  assert.equal(mutated((copy) => { copy.game.hist[0].mv = 3 }), null)
  assert.equal(mutated((copy) => { copy.game.hist[0].me = 1 }), null)
  assert.equal(mutated((copy) => { copy.game.hist[0] = null }), null)
  assert.equal(mutated((copy) => { copy.game.over = true }), null)
  assert.equal(mutated((copy) => { copy.game.winner = 1 }), null)
  assert.equal(mutated((copy) => { copy.game.winner = 5 }), null)
})

test('sanitizeSave clamps speed into [SPEED_MIN, SPEED_MAX]', () => {
  const game = new Q.Game()
  const high = seam.serializeSave(game, { mode: 'pvp', mySide: 0, level: 2, speed: 99999 })
  assert.equal(seam.sanitizeSave(high).speed, seam.SPEED_MAX)
  const low = seam.serializeSave(game, { mode: 'pvp', mySide: 0, level: 2, speed: -100 })
  assert.equal(seam.sanitizeSave(low).speed, seam.SPEED_MIN)
  const missing = seam.serializeSave(game, { mode: 'pvp', mySide: 0, level: 2, speed: 400 })
  delete missing.speed
  assert.equal(seam.sanitizeSave(missing).speed, seam.SPEED_DEFAULT)
})

/* ---------------------------------------------------------------------------
 * 汇总
 * ------------------------------------------------------------------------ */

console.log('')
console.log('logic tests: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
