/**
 * @local/dsh-game-gomoku — 自对弈 sanity / 性能回归（dev-only）。
 *
 * 运行：node dev/selfplay.mjs [--games 6]
 *
 * 目的：test-ai.mjs 的随机局面只到 ~50 子；这里让 AI 自己下完整局，覆盖中后盘
 * 候选点变多、搜索更深的情况，验证：
 *   - 每步落点合法（空点 + 2 格内）
 *   - 任何一步思考 < 300ms（困难预算 210ms）
 *   - 对局一定在 225 步内结束（成五或和棋），不会卡死
 *   - 困难档对普通/简单档的胜率符合预期（棋力 sanity，不是严格证明）
 */
import assert from 'node:assert/strict'

const windowStub = {
  __DSH_GAME_GOMOKU_TEST__: true,
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
  },
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = windowStub
globalThis.document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
}
await import(new URL('../client.js', import.meta.url).href)
const S = windowStub.__DSH_GAME_GOMOKU__
assert.ok(S, 'test seam expected')

const BLACK = S.BLACK
const WHITE = S.WHITE
const EMPTY = S.EMPTY

function hasStoneNear(board, point) {
  const r = S.rowOf(point)
  const c = S.colOf(point)
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const rr = r + dr
      const cc = c + dc
      if (rr < 0 || rr >= S.SIZE || cc < 0 || cc >= S.SIZE) continue
      if (board[S.idx(rr, cc)] !== EMPTY) return true
    }
  }
  return false
}

function playGame(blackLevel, whiteLevel, label) {
  const board = S.createBoard()
  let side = BLACK
  const moves = []
  let maxMs = 0
  let maxAt = -1
  let totalMs = 0
  let maxNodes = 0
  let hardDepth = 0
  while (moves.length < S.CELLS) {
    const level = side === BLACK ? blackLevel : whiteLevel
    const started = performance.now()
    const result = S.chooseMove(board, side, level)
    const spent = performance.now() - started
    assert.ok(result && result.p >= 0 && result.p < S.CELLS, label + ': invalid point')
    assert.equal(board[result.p], EMPTY, label + ': AI chose an occupied point')
    if (moves.length > 0) {
      assert.equal(hasStoneNear(board, result.p), true, label + ': AI chose a point beyond 2 cells')
    }
    assert.ok(spent < 300, label + ': step ' + moves.length + ' took ' + spent.toFixed(1) + 'ms')
    if (spent > maxMs) {
      maxMs = spent
      maxAt = moves.length
    }
    totalMs += spent
    if (typeof result.nodes === 'number' && result.nodes > maxNodes) maxNodes = result.nodes
    if (level === 3 && result.reason === 'search' && result.depth > hardDepth) hardDepth = result.depth
    board[result.p] = side
    moves.push(result.p)
    if (S.isWin(board, result.p, side)) {
      return {
        label: label,
        blackLevel: blackLevel,
        whiteLevel: whiteLevel,
        winner: side,
        plies: moves.length,
        maxMs: maxMs,
        maxAt: maxAt,
        totalMs: totalMs,
        maxNodes: maxNodes,
        hardDepth: hardDepth,
      }
    }
    side = side === BLACK ? WHITE : BLACK
  }
  return {
    label: label,
    blackLevel: blackLevel,
    whiteLevel: whiteLevel,
    winner: 0,
    plies: moves.length,
    maxMs: maxMs,
    maxAt: maxAt,
    totalMs: totalMs,
    maxNodes: maxNodes,
    hardDepth: hardDepth,
  }
}

function levelName(level) {
  return S.LEVELS[level].name
}

/* 预热 JIT */
for (let i = 0; i < 4; i += 1) {
  const board = S.createBoard()
  board[S.idx(7, 7)] = BLACK
  board[S.idx(7, 8)] = WHITE
  S.chooseMove(board, BLACK, 3)
}

const matchups = [
  { black: 3, white: 3, label: '困难 vs 困难' },
  { black: 3, white: 2, label: '困难(黑) vs 普通(白)' },
  { black: 2, white: 3, label: '普通(黑) vs 困难(白)' },
  { black: 2, white: 2, label: '普通 vs 普通' },
  { black: 3, white: 1, label: '困难(黑) vs 简单(白)' },
  { black: 1, white: 3, label: '简单(黑) vs 困难(白)' },
]

const results = []
for (const matchup of matchups) {
  const result = playGame(matchup.black, matchup.white, matchup.label)
  results.push(result)
  const winnerText = result.winner === BLACK
    ? '黑(' + levelName(matchup.black) + ')胜'
    : result.winner === WHITE
      ? '白(' + levelName(matchup.white) + ')胜'
      : '和棋'
  console.log(
    matchup.label.padEnd(26, ' ') +
    ' -> ' + winnerText.padEnd(14, ' ') +
    ' 手数 ' + String(result.plies).padStart(3, ' ') +
    ' | 单步 max ' + result.maxMs.toFixed(1) + 'ms @#' + result.maxAt +
    ' | 总 ' + result.totalMs.toFixed(0) + 'ms' +
    ' | maxNodes ' + result.maxNodes +
    ' | hardDepth ' + result.hardDepth,
  )
}

/* ---- 断言：全部结束、全部 <300ms、困难档棋力 sanity ---- */
for (const result of results) {
  assert.ok(result.winner === BLACK || result.winner === WHITE, result.label + ': must end with a win')
  assert.ok(result.plies <= S.CELLS, result.label + ': too many plies')
  assert.ok(result.maxMs < 300, result.label + ': max step ' + result.maxMs.toFixed(1) + 'ms exceeds 300ms')
}
const hardAsBlack = results.find(function (item) {
  return item.label === '困难(黑) vs 普通(白)'
})
const hardAsWhite = results.find(function (item) {
  return item.label === '普通(黑) vs 困难(白)'
})
assert.equal(hardAsBlack.winner, BLACK, '困难执黑应战胜普通')
assert.equal(hardAsWhite.winner, WHITE, '困难执白应战胜普通')
const hardVsEasyBlack = results.find(function (item) {
  return item.label === '困难(黑) vs 简单(白)'
})
const hardVsEasyWhite = results.find(function (item) {
  return item.label === '简单(黑) vs 困难(白)'
})
assert.equal(hardVsEasyBlack.winner, BLACK, '困难执黑应战胜简单')
assert.equal(hardVsEasyWhite.winner, WHITE, '困难执白应战胜简单')

const globalMax = Math.max.apply(null, results.map(function (item) {
  return item.maxMs
}))
console.log('')
console.log('selfplay: ' + results.length + ' games, all finished, max single think ' + globalMax.toFixed(1) + 'ms (<300ms)')
