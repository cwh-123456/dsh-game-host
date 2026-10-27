/**
 * dev/debug-strength.mjs — 临时诊断：困难 AI 的战术失误（不随包发布）。
 */
import assert from 'node:assert/strict'

const windowStub = {
  __DSH_GAME_GOMOKU_TEST__: true,
  __ModuleLoader__: { load(definition) { windowStub.__definition = definition } },
  localStorage: { getItem() { return null }, setItem() {} },
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = windowStub
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} }
await import(new URL('../client.js', import.meta.url).href)
const S = windowStub.__DSH_GAME_GOMOKU__
const BLACK = S.BLACK
const WHITE = S.WHITE

function winningPoints(board, side) {
  const out = []
  const candidates = S.getCandidates(board)
  for (const p of candidates) {
    if (board[p] !== S.EMPTY) continue
    board[p] = side
    if (S.isWin(board, p, side)) out.push(p)
    board[p] = S.EMPTY
  }
  return out
}

function findBlunders(blackLevel, whiteLevel) {
  const board = S.createBoard()
  let side = BLACK
  const moves = []
  const blunders = []
  while (moves.length < S.CELLS) {
    const level = side === BLACK ? blackLevel : whiteLevel
    const before = {
      myWins: winningPoints(board, side),
      oppWins: winningPoints(board, side === BLACK ? WHITE : BLACK),
    }
    const result = S.chooseMove(board, side, level)
    const point = result.p
    // 战术检查：自己有成五必须走；对手只有唯一成五必须堵（多于一处的必输局面不算）
    if (before.myWins.length > 0 && before.myWins.indexOf(point) < 0) {
      blunders.push({ move: moves.length + 1, side, kind: 'miss-own-win', point, myWins: before.myWins, level, reason: result.reason })
    }
    if (before.myWins.length === 0 && before.oppWins.length === 1 && before.oppWins[0] !== point) {
      blunders.push({ move: moves.length + 1, side, kind: 'miss-block-five', point, oppWins: before.oppWins, level, reason: result.reason })
    }
    board[point] = side
    moves.push({ p: point, side, level, reason: result.reason })
    if (S.isWin(board, point, side)) break
    side = side === BLACK ? WHITE : BLACK
  }
  return { winner: moves[moves.length - 1].side, moves, blunders }
}

function ascii(board) {
  const lines = []
  for (let r = 0; r < S.SIZE; r += 1) {
    let line = String(r + 1).padStart(2, ' ') + ' '
    for (let c = 0; c < S.SIZE; c += 1) {
      const v = board[S.idx(r, c)]
      line += v === BLACK ? 'X' : v === WHITE ? 'O' : '.'
    }
    lines.push(line)
  }
  return lines.join('\n')
}

const game = findBlunders(3, 2)
console.log('winner:', game.winner === BLACK ? 'black' : 'white', 'moves:', game.moves.length, 'blunders:', game.blunders.length)
for (const blunder of game.blunders) console.log(blunder)
const final = S.createBoard()
for (const move of game.moves) final[move.p] = move.side
console.log(ascii(final))
const last = game.moves.slice(-14)
console.log('last moves:', last.map(function (m) {
  return (m.side === BLACK ? 'B' : 'W') + '(' + S.rowOf(m.p) + ',' + S.colOf(m.p) + ')[' + m.reason + ']'
}).join(' '))
assert.ok(true)
