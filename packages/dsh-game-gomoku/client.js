/**
 * @local/dsh-game-gomoku — DSH `game.stage` client entry.
 *
 * 第十个游戏：五子棋（Gomoku / 连珠自由规则）。
 *
 * 结构（单文件原因：DSH 浏览器侧模块表只服务 client.js 一个入口，包内相对路径同步
 * `require` 拿不到，所以规则与 AI 必须内联；React 从模块表 `require('react')` 拿）：
 *
 *   1. 规则 + AI 引擎（纯函数，无 DOM）：15×15 棋盘、成五判定（横/竖/两斜，含边界）、
 *      候选点限制（已有棋子 2 格内）、经典棋型分值表、三档难度、α-β 搜索。
 *   2. 存档：localStorage['dsh.game.gomoku.v1']，读取时用引擎重放历史逐项校验。
 *   3. createGame：canvas 绘制 + 指针交互 + AI 节奏 + 计时 + 存档 + 清理。
 *   4. React 界面：工具栏 / 状态栏 / 规则弹窗；向宿主 `game.stage` slot 注册。
 *
 * 无禁手（自由规则）：黑棋不禁长连、三三、四四；横竖斜任意方向连成 5 子及以上即胜。
 */
;(function () {
  'use strict'

  const GAME_ID = 'gomoku'
  const GAME_LABEL = '五子棋'
  const STORE_KEY = 'dsh.game.gomoku.v1'
  const SCHEMA_VERSION = 1

  const MODES = ['pve', 'pvp']
  const MODE_META = {
    pve: { label: '人机对战' },
    pvp: { label: '双人对战' },
  }

  /* ======================================================================
   * 1) 规则 + AI 引擎（纯函数，不碰 DOM，可被 Node 自测直接调用）
   * ==================================================================== */

  const SIZE = 15
  const CELLS = SIZE * SIZE
  const EMPTY = 0
  const BLACK = 1
  const WHITE = 2
  const DRAW = 0
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]
  const CENTER = 7 * SIZE + 7

  /* 经典棋型分值（越大越强；成五远高于其它，保证“能赢先赢”） */
  const SHAPES = {
    FIVE: 10000000,
    OPEN_FOUR: 1000000,
    FOUR: 100000,
    OPEN_THREE: 10000,
    THREE: 1000,
    OPEN_TWO: 500,
    TWO: 100,
    ONE: 10,
  }

  /* 三档难度：简单=分数带随机；普通=贪心；困难=前 12 候选 α-β 深度 4 */
  const LEVELS = {
    1: { id: 1, name: '简单', depth: 0, candidates: 8, budgetMs: 40, desc: '在靠前的候选里带权随机' },
    2: { id: 2, name: '普通', depth: 0, candidates: 0, budgetMs: 60, desc: '贪心：我分 + 对手分 × 0.8' },
    3: { id: 3, name: '困难', depth: 4, candidates: 12, budgetMs: 210, desc: '前 12 候选 α-β 搜索 4 层' },
  }
  const HARD_BUDGET_MS = 210
  const MAX_SEARCH_NODES = 20000
  const AI_DELAY_MIN = 200
  const AI_DELAY_MAX = 400
  const WIN_SCORE = 1e9
  const INF = 1e15

  const LEVEL_IDS = [1, 2, 3]

  function nowMs() {
    const perf = typeof performance !== 'undefined' ? performance : null
    return perf && typeof perf.now === 'function' ? perf.now() : Date.now()
  }

  function createBoard() {
    return new Uint8Array(CELLS)
  }

  function cloneBoard(board) {
    return Uint8Array.from(board)
  }

  function rowOf(p) {
    return (p / SIZE) | 0
  }

  function colOf(p) {
    return p % SIZE
  }

  function inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE
  }

  function idx(r, c) {
    return r * SIZE + c
  }

  function otherSide(side) {
    return side === BLACK ? WHITE : BLACK
  }

  function isIntegerBetween(value, min, max) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value &&
      value >= min && value <= max
  }

  /* ---- 成五判定：p 必须是 side 方刚落下的棋子（先落子再调用） ---- */
  function isWin(board, p, side) {
    if (p < 0 || p >= CELLS || board[p] !== side) return false
    for (let d = 0; d < 4; d += 1) {
      const dr = DIRS[d][0]
      const dc = DIRS[d][1]
      const r0 = rowOf(p)
      const c0 = colOf(p)
      let count = 1
      for (let s = 1; s < 5; s += 1) {
        const r = r0 + dr * s
        const c = c0 + dc * s
        if (!inBounds(r, c) || board[idx(r, c)] !== side) break
        count += 1
      }
      for (let s = 1; s < 5; s += 1) {
        const r = r0 - dr * s
        const c = c0 - dc * s
        if (!inBounds(r, c) || board[idx(r, c)] !== side) break
        count += 1
      }
      if (count >= 5) return true
    }
    return false
  }

  /* 返回获胜的那一串连续棋子（有序，可能 >5）；没有返回 null。用于高亮。
   * 与 isWin 相同：p 必须已经是 side 方棋子。 */
  function winningLine(board, p, side) {
    if (p < 0 || p >= CELLS || board[p] !== side) return null
    for (let d = 0; d < 4; d += 1) {
      const dr = DIRS[d][0]
      const dc = DIRS[d][1]
      const r0 = rowOf(p)
      const c0 = colOf(p)
      const forward = [p]
      for (let s = 1; s < SIZE; s += 1) {
        const r = r0 + dr * s
        const c = c0 + dc * s
        if (!inBounds(r, c) || board[idx(r, c)] !== side) break
        forward.push(idx(r, c))
      }
      const backward = []
      for (let s = 1; s < SIZE; s += 1) {
        const r = r0 - dr * s
        const c = c0 - dc * s
        if (!inBounds(r, c) || board[idx(r, c)] !== side) break
        backward.push(idx(r, c))
      }
      if (forward.length + backward.length >= 5) {
        backward.reverse()
        return backward.concat(forward)
      }
    }
    return null
  }

  /* ---- 候选点：只考虑已有棋子 Chebyshev 距离 ≤2 的空点 ---- */
  function getCandidates(board) {
    const mark = new Uint8Array(CELLS)
    const out = []
    let stones = 0
    for (let p = 0; p < CELLS; p += 1) {
      if (board[p] === EMPTY) continue
      stones += 1
      const r = rowOf(p)
      const c = colOf(p)
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          if (dr === 0 && dc === 0) continue
          const rr = r + dr
          const cc = c + dc
          if (!inBounds(rr, cc)) continue
          const q = idx(rr, cc)
          if (board[q] === EMPTY && mark[q] === 0) {
            mark[q] = 1
            out.push(q)
          }
        }
      }
    }
    if (stones === 0) return [CENTER]
    return out
  }

  /* 每个方向的棋型表：先查包含中心的固定串（能识别跳四/跳三），再退回连续棋子兜底 */
  const SHAPE_PATTERNS = [
    [SHAPES.FIVE, ['11111']],
    [SHAPES.OPEN_FOUR, ['011110']],
    [SHAPES.FOUR, ['11110', '01111', '11011', '10111', '11101']],
    [SHAPES.OPEN_THREE, ['01110', '010110', '011010']],
  ]

  /* 单方向棋型分：把落点当成 side 方棋子，取 9 格窗口（-4..+4），
   * 用 '0'=空 '1'=己方 '2'=对方/棋盘外 编码，匹配“包含中心”的棋型。 */
  function scoreDirection(board, p, side, d) {
    const dr = DIRS[d][0]
    const dc = DIRS[d][1]
    const r0 = rowOf(p)
    const c0 = colOf(p)
    let line = ''
    for (let o = -4; o <= 4; o += 1) {
      if (o === 0) {
        line += '1'
        continue
      }
      const r = r0 + dr * o
      const c = c0 + dc * o
      if (!inBounds(r, c)) {
        line += '2'
        continue
      }
      const value = board[idx(r, c)]
      line += value === EMPTY ? '0' : value === side ? '1' : '2'
    }
    for (let g = 0; g < SHAPE_PATTERNS.length; g += 1) {
      const score = SHAPE_PATTERNS[g][0]
      const patterns = SHAPE_PATTERNS[g][1]
      for (let i = 0; i < patterns.length; i += 1) {
        const pattern = patterns[i]
        let at = line.indexOf(pattern)
        while (at !== -1) {
          if (at <= 4 && at + pattern.length > 4) return score
          at = line.indexOf(pattern, at + 1)
        }
      }
    }
    /* 兜底：连续棋子数 + 两端开放数（眠三 / 活二 / 眠二 / 单子） */
    let left = 4
    let right = 4
    while (left > 0 && line[left - 1] === '1') left -= 1
    while (right < 8 && line[right + 1] === '1') right += 1
    const count = right - left + 1
    const openEnds = (left > 0 && line[left - 1] === '0' ? 1 : 0) +
      (right < 8 && line[right + 1] === '0' ? 1 : 0)
    if (count >= 4) return openEnds === 2 ? SHAPES.OPEN_FOUR : openEnds === 1 ? SHAPES.FOUR : 0
    if (count === 3) return openEnds === 2 ? SHAPES.OPEN_THREE : openEnds === 1 ? SHAPES.THREE : 0
    if (count === 2) return openEnds === 2 ? SHAPES.OPEN_TWO : openEnds === 1 ? SHAPES.TWO : 0
    if (count === 1) return openEnds === 2 ? SHAPES.ONE : 0
    return 0
  }

  /* side 方落在 p 的综合棋型分（临时落子后立即还原，不改棋盘） */
  function scorePoint(board, p, side) {
    if (p < 0 || p >= CELLS || board[p] !== EMPTY) return -Infinity
    board[p] = side
    let total = 0
    for (let d = 0; d < 4; d += 1) total += scoreDirection(board, p, side, d)
    board[p] = EMPTY
    return total
  }

  /* ---- 叶子评估：所有 5 格窗口，单色窗口按棋子数给分（能处理断点） ---- */
  const WINDOWS = (function buildWindows() {
    const list = []
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c + 4 < SIZE; c += 1) {
        list.push([idx(r, c), idx(r, c + 1), idx(r, c + 2), idx(r, c + 3), idx(r, c + 4)])
      }
    }
    for (let c = 0; c < SIZE; c += 1) {
      for (let r = 0; r + 4 < SIZE; r += 1) {
        list.push([idx(r, c), idx(r + 1, c), idx(r + 2, c), idx(r + 3, c), idx(r + 4, c)])
      }
    }
    for (let r = 0; r + 4 < SIZE; r += 1) {
      for (let c = 0; c + 4 < SIZE; c += 1) {
        list.push([idx(r, c), idx(r + 1, c + 1), idx(r + 2, c + 2), idx(r + 3, c + 3), idx(r + 4, c + 4)])
      }
    }
    for (let r = 0; r + 4 < SIZE; r += 1) {
      for (let c = 4; c < SIZE; c += 1) {
        list.push([idx(r, c), idx(r + 1, c - 1), idx(r + 2, c - 2), idx(r + 3, c - 3), idx(r + 4, c - 4)])
      }
    }
    return list
  })()
  const WINDOW_SCORE = [0, 2, 20, 300, 20000, 10000000]

  function evaluateBoard(board, side) {
    const opp = otherSide(side)
    let mine = 0
    let theirs = 0
    for (let i = 0; i < WINDOWS.length; i += 1) {
      const window = WINDOWS[i]
      let a = 0
      let b = 0
      for (let k = 0; k < 5; k += 1) {
        const value = board[window[k]]
        if (value === side) a += 1
        else if (value === opp) b += 1
      }
      if (a > 0 && b > 0) continue
      if (a > 0) mine += WINDOW_SCORE[a]
      else if (b > 0) theirs += WINDOW_SCORE[b]
    }
    return mine - theirs * 1.05
  }

  /* 搜索节点内的走法排序：浅层用便宜启发（邻居密度），深层用棋型分 */
  function cheapCandidateScore(board, p, side) {
    const opp = otherSide(side)
    const r = rowOf(p)
    const c = colOf(p)
    let score = 0
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) {
        if (dr === 0 && dc === 0) continue
        const rr = r + dr
        const cc = c + dc
        if (!inBounds(rr, cc)) continue
        const value = board[idx(rr, cc)]
        if (value === EMPTY) continue
        const distance = Math.max(Math.abs(dr), Math.abs(dc))
        const weight = 3 - distance
        score += value === side ? weight * 2 : weight
      }
    }
    return score
  }

  function orderedCandidates(board, side, depth) {
    const moveList = getCandidates(board)
    const limit = depth >= 3 ? 10 : depth === 2 ? 10 : 8
    if (moveList.length <= limit) return moveList
    const opp = otherSide(side)
    const scored = []
    for (let i = 0; i < moveList.length; i += 1) {
      const p = moveList[i]
      let score
      if (depth >= 2) score = scorePoint(board, p, side) + scorePoint(board, p, opp) * 0.8
      else score = cheapCandidateScore(board, p, side)
      scored.push({ p: p, s: score })
    }
    scored.sort(function (x, y) {
      return y.s - x.s || x.p - y.p
    })
    const out = []
    for (let i = 0; i < limit; i += 1) out.push(scored[i].p)
    return out
  }

  function negamax(board, side, depth, alpha, beta, ctx, ply) {
    ctx.nodes += 1
    if ((ctx.nodes & 15) === 0 && (nowMs() > ctx.deadline || ctx.nodes > MAX_SEARCH_NODES)) {
      ctx.aborted = true
      return 0
    }
    if (depth <= 0) return evaluateBoard(board, side)
    const moves = orderedCandidates(board, side, depth)
    if (moves.length === 0) return evaluateBoard(board, side)
    const opp = otherSide(side)
    let best = -INF
    for (let i = 0; i < moves.length; i += 1) {
      const p = moves[i]
      board[p] = side
      let value
      if (isWin(board, p, side)) value = WIN_SCORE - ply
      else value = -negamax(board, opp, depth - 1, -beta, -alpha, ctx, ply + 1)
      board[p] = EMPTY
      if (ctx.aborted) return 0
      if (value > best) best = value
      if (best > alpha) alpha = best
      if (alpha >= beta) break
    }
    return best
  }

  /**
   * 选择一步棋。
   * @param {Uint8Array|number[]} inputBoard 棋盘快照（不会被修改）
   * @param {number} side BLACK / WHITE
   * @param {number} level 1 / 2 / 3
   * @param {object} [options] { budgetMs, maxDepth }
   * @returns {{p:number, reason:string, level:number, thinkMs:number, candidates:number,
   *            depth?:number, nodes?:number, roots?:number, aborted?:boolean}}
   */
  function chooseMove(inputBoard, side, level, options) {
    const started = nowMs()
    const levelId = level === 1 ? 1 : level === 3 ? 3 : 2
    const opts = options || {}
    const budget = typeof opts.budgetMs === 'number'
      ? Math.max(1, opts.budgetMs)
      : LEVELS[levelId].budgetMs
    const board = Uint8Array.from(inputBoard)
    const opp = otherSide(side)
    const candidates = getCandidates(board)
    const stats = { level: levelId, candidates: candidates.length, nodes: 0 }

    function finish(p, reason, extra) {
      const out = {
        p: p,
        reason: reason,
        level: levelId,
        thinkMs: nowMs() - started,
        candidates: candidates.length,
      }
      if (extra) {
        for (const key in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key]
        }
      }
      return out
    }

    if (candidates.length === 0) return finish(-1, 'no-move')

    /* 先算每个候选点的“我下这里 / 对手下这里”棋型分 */
    const scored = []
    let winPoint = -1
    let winScore = -1
    let blockPoint = -1
    let blockScore = -1
    for (let i = 0; i < candidates.length; i += 1) {
      const p = candidates[i]
      const my = scorePoint(board, p, side)
      const op = scorePoint(board, p, opp)
      const total = my + op * 0.8
      scored.push({ p: p, my: my, op: op, total: total })
      if (my >= SHAPES.FIVE && my > winScore) {
        winScore = my
        winPoint = p
      }
      if (op >= SHAPES.FIVE && op > blockScore) {
        blockScore = op
        blockPoint = p
      }
    }

    /* 能赢先赢；否则对手下一手成五必须堵（保证不走出自杀步） */
    if (winPoint >= 0) return finish(winPoint, 'win')
    if (blockPoint >= 0) return finish(blockPoint, 'block')

    scored.sort(function (a, b) {
      return b.total - a.total || b.my - a.my || a.p - b.p
    })

    if (levelId === 1) {
      /* 简单：在分数带最靠前的若干候选里带权随机 */
      const poolSize = Math.min(6, scored.length)
      const weights = []
      let totalWeight = 0
      for (let i = 0; i < poolSize; i += 1) {
        const weight = poolSize - i
        weights.push(weight)
        totalWeight += weight
      }
      let roll = Math.random() * totalWeight
      let pick = scored[0].p
      for (let i = 0; i < poolSize; i += 1) {
        roll -= weights[i]
        if (roll <= 0) {
          pick = scored[i].p
          break
        }
      }
      return finish(pick, 'easy-random')
    }

    if (levelId === 2) return finish(scored[0].p, 'greedy')

    /* 困难：前 N 个候选做 α-β，深度 4；超时/节点超限保留已完成深度结果，
     * 连深度 2 都没完成则降级为贪心。 */
    const rootLimit = Math.min(LEVELS[3].candidates, scored.length)
    const roots = []
    for (let i = 0; i < rootLimit; i += 1) roots.push(scored[i].p)
    const maxDepth = Math.max(2, opts.maxDepth || LEVELS[3].depth)
    const deadline = started + budget
    const ctx = { deadline: deadline, nodes: 0, aborted: false }
    let bestPoint = roots[0]
    let bestScore = -INF
    let completedDepth = 0
    for (let depth = 2; depth <= maxDepth; depth += 2) {
      let alpha = -INF
      let localBest = -1
      let localScore = -INF
      for (let i = 0; i < roots.length; i += 1) {
        if (nowMs() > deadline) {
          ctx.aborted = true
          break
        }
        const p = roots[i]
        board[p] = side
        let value
        if (isWin(board, p, side)) value = WIN_SCORE
        else value = -negamax(board, opp, depth - 1, -INF, -alpha, ctx, 1)
        board[p] = EMPTY
        if (ctx.aborted) break
        if (value > localScore) {
          localScore = value
          localBest = p
        }
        if (value > alpha) alpha = value
      }
      if (ctx.aborted) break
      if (localBest >= 0) {
        bestPoint = localBest
        bestScore = localScore
        completedDepth = depth
      }
      if (bestScore >= WIN_SCORE - 1000) break
      if (nowMs() > deadline) break
    }
    if (ctx.aborted) {
      /* 超过时间预算 / 节点上限：按规格降级为贪心（取综合分最高点）。 */
      return finish(scored[0].p, 'greedy-timeout', {
        depth: completedDepth,
        nodes: ctx.nodes,
        roots: roots.length,
        aborted: true,
      })
    }
    if (completedDepth === 0) {
      return finish(scored[0].p, 'greedy-fallback', {
        depth: 0,
        nodes: ctx.nodes,
        roots: roots.length,
        aborted: false,
      })
    }
    return finish(bestPoint, 'search', {
      depth: completedDepth,
      nodes: ctx.nodes,
      roots: roots.length,
      aborted: ctx.aborted,
    })
  }

  /* ======================================================================
   * 2) 存档：localStorage['dsh.game.gomoku.v1']
   * ==================================================================== */

  function serializeSave(game) {
    return {
      schemaVersion: SCHEMA_VERSION,
      mode: game.mode,
      level: game.level,
      board: Array.from(game.board),
      turn: game.turn,
      history: game.history.map(function (entry) {
        return { p: entry.p, side: entry.side }
      }),
      over: !!game.over,
      winner: game.winner,
      winLine: game.winLine ? game.winLine.slice() : null,
      elapsedMs: Math.max(0, Math.round(game.elapsedMs)),
    }
  }

  /**
   * 解析 + 校验存档。用引擎重放历史：任何非法走法、与 board/turn/over/winner
   * 不一致（损坏、旧版本、被改过）都返回 null，由调用方静默开新局。
   */
  function sanitizeSave(input) {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null
      if (input.schemaVersion !== SCHEMA_VERSION) return null
      if (MODES.indexOf(input.mode) < 0) return null
      if (!isIntegerBetween(input.level, 1, 3)) return null
      if (!Array.isArray(input.board) || input.board.length !== CELLS) return null
      for (let i = 0; i < CELLS; i += 1) {
        const value = input.board[i]
        if (value !== EMPTY && value !== BLACK && value !== WHITE) return null
      }
      if (!Array.isArray(input.history) || input.history.length > CELLS) return null
      let elapsedMs = 0
      if (input.elapsedMs !== undefined) {
        if (typeof input.elapsedMs !== 'number' || !isFinite(input.elapsedMs) || input.elapsedMs < 0) return null
        elapsedMs = Math.min(Math.round(input.elapsedMs), 24 * 3600 * 1000)
      }

      const board = createBoard()
      const history = []
      let turn = BLACK
      let over = false
      let winner = DRAW
      let winLine = null
      for (let i = 0; i < input.history.length; i += 1) {
        const entry = input.history[i]
        if (!entry || typeof entry !== 'object') return null
        if (!isIntegerBetween(entry.p, 0, CELLS - 1)) return null
        if (entry.side !== BLACK && entry.side !== WHITE) return null
        if (entry.side !== turn) return null
        if (over) return null
        if (board[entry.p] !== EMPTY) return null
        board[entry.p] = entry.side
        const line = winningLine(board, entry.p, entry.side)
        if (line) {
          over = true
          winner = entry.side
          winLine = line
        } else if (i === CELLS - 1) {
          over = true
          winner = DRAW
          winLine = null
        }
        history.push({ p: entry.p, side: entry.side })
        turn = entry.side === BLACK ? WHITE : BLACK
      }
      for (let i = 0; i < CELLS; i += 1) {
        if (board[i] !== input.board[i]) return null
      }
      if (input.over !== over) return null
      if (input.winner !== winner) return null
      if (winLine) {
        if (!Array.isArray(input.winLine) || input.winLine.length !== winLine.length) return null
        for (let i = 0; i < winLine.length; i += 1) {
          if (input.winLine[i] !== winLine[i]) return null
        }
      } else if (input.winLine !== null && input.winLine !== undefined) {
        return null
      }
      if (input.turn !== turn) return null
      return {
        mode: input.mode,
        level: input.level,
        board: board,
        turn: turn,
        history: history,
        over: over,
        winner: winner,
        winLine: winLine,
        elapsedMs: elapsedMs,
      }
    } catch (error) {
      return null
    }
  }

  function readSavedState() {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null
      const raw = window.localStorage.getItem(STORE_KEY)
      if (!raw) return null
      return sanitizeSave(JSON.parse(raw))
    } catch (error) {
      return null
    }
  }

  function writeSavedState(payload) {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return
      window.localStorage.setItem(STORE_KEY, JSON.stringify(payload))
    } catch (error) {
      // 配额满 / 隐私模式：存档失败不影响当前对局。
    }
  }

  /* ======================================================================
   * 3) 画布几何
   * ==================================================================== */

  const CELL = 40
  const PAD = 34
  const LOGICAL_SIZE = PAD * 2 + CELL * (SIZE - 1) // 628
  const MIN_STAGE_W = 320
  const MIN_STAGE_H = 240

  function computeLayout(width, height) {
    const w = Math.max(0, Math.floor(width || 0))
    const h = Math.max(0, Math.floor(height || 0))
    const avail = Math.min(w, h)
    const cssSize = Math.max(1, Math.floor(avail))
    return { cssSize: cssSize, scale: cssSize / LOGICAL_SIZE }
  }

  /* 逻辑坐标（棋盘左上角为 0,0） */
  function cellCenter(p) {
    return { x: PAD + colOf(p) * CELL, y: PAD + rowOf(p) * CELL }
  }

  /* 逻辑坐标 -> 最近交叉点；点在棋盘外返回 -1 */
  function cellHit(x, y) {
    const c = Math.round((x - PAD) / CELL)
    const r = Math.round((y - PAD) / CELL)
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return -1
    return idx(r, c)
  }

  /* ======================================================================
   * 4) 游戏实例：canvas + 交互 + AI + 计时 + 存档 + 清理
   * ==================================================================== */

  function createGame(host, options) {
    if (!host) throw new Error('gomoku: missing mount element')
    const opts = options || {}
    const view = typeof window !== 'undefined' ? window : null
    const doc = typeof document !== 'undefined' ? document : (view && view.document) || null
    if (!view) throw new Error('gomoku: window is unavailable')
    if (!doc) throw new Error('gomoku: document is unavailable')

    const onState = typeof opts.onState === 'function' ? opts.onState : null
    const onError = typeof opts.onError === 'function' ? opts.onError : null

    const saved = readSavedState()
    let mode = saved ? saved.mode : 'pve'
    let level = saved ? saved.level : 2
    let board = saved ? saved.board : createBoard()
    let turn = saved ? saved.turn : BLACK
    let history = saved ? saved.history : []
    let over = saved ? saved.over : false
    let winner = saved ? saved.winner : DRAW
    let winLine = saved ? saved.winLine : null
    let elapsedBase = saved ? saved.elapsedMs : 0
    let elapsedRunningSince = 0
    let lastThinkMs = 0

    let destroyed = false
    let failure = null
    let busy = false
    let hidden = doc.hidden === true
    let hover = -1
    let runToken = 0
    let size = { width: 0, height: 0, dpr: 1 }
    let layout = null
    let rafId = 0
    let lastSecond = -1
    let resizeObserver = null
    const timers = new Set()

    /* ---- 定时器：全部经 window，便于统一清理（AI 节奏只用到 setTimeout） ---- */
    function schedule(fn, delay) {
      let id = 0
      try {
        id = view.setTimeout(function () {
          timers.delete(id)
          if (destroyed) return
          try {
            fn()
          } catch (error) {
            fail(error)
          }
        }, Math.max(0, delay || 0))
      } catch (error) {
        return 0
      }
      timers.add(id)
      return id
    }

    function clearTimers() {
      timers.forEach(function (id) {
        try {
          view.clearTimeout(id)
        } catch (error) {
          // ignore
        }
      })
      timers.clear()
    }

    function cancelPending() {
      runToken += 1
      clearTimers()
      busy = false
    }

    /* ---- 错误 ---- */
    function fail(error) {
      if (destroyed) return
      failure = '游戏遇到问题，点「重试」重新开始。'
      cancelPending()
      pauseClock()
      stopTimerLoop()
      try {
        console.error('[dsh-game-gomoku] runtime error', error)
      } catch (logError) {
        // ignore
      }
      if (onError) {
        try {
          onError(failure)
        } catch (listenerError) {
          console.error('[dsh-game-gomoku] error listener failed', listenerError)
        }
      }
      emit()
    }

    /* ---- 计时：只统计“对局进行中且页面可见”的时间 ---- */
    function currentElapsed() {
      const extra = elapsedRunningSince ? nowMs() - elapsedRunningSince : 0
      return Math.max(0, elapsedBase + extra)
    }

    function pauseClock() {
      if (!elapsedRunningSince) return
      elapsedBase = currentElapsed()
      elapsedRunningSince = 0
    }

    function startClock() {
      if (destroyed || over || hidden || elapsedRunningSince) return
      elapsedRunningSince = nowMs()
      startTimerLoop()
    }

    function startTimerLoop() {
      if (destroyed || over || hidden || rafId) return
      const raf = view.requestAnimationFrame
      if (typeof raf !== 'function') return
      const step = function () {
        rafId = 0
        if (destroyed || over || hidden) return
        try {
          const second = Math.floor(currentElapsed() / 1000)
          if (second !== lastSecond) {
            lastSecond = second
            emit()
          }
          rafId = raf(step)
        } catch (error) {
          rafId = 0
        }
      }
      try {
        rafId = raf(step)
      } catch (error) {
        rafId = 0
      }
    }

    function stopTimerLoop() {
      if (!rafId) return
      try {
        if (typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(rafId)
      } catch (error) {
        // ignore
      }
      rafId = 0
    }

    /* ---- 状态快照 / 通知 ---- */
    function snapshot() {
      return {
        mode: mode,
        level: level,
        turn: turn,
        over: !!over,
        winner: winner,
        winLine: winLine ? winLine.slice() : null,
        moves: history.length,
        lastMove: history.length ? history[history.length - 1].p : -1,
        canUndo: !busy && history.length > 0,
        busy: busy,
        hidden: hidden,
        elapsedMs: Math.max(0, Math.round(currentElapsed())),
        lastThinkMs: lastThinkMs,
        tooSmall: size.width < MIN_STAGE_W || size.height < MIN_STAGE_H,
        failure: failure,
      }
    }

    function emit() {
      if (!onState) return
      try {
        onState(snapshot())
      } catch (error) {
        console.error('[dsh-game-gomoku] state listener failed', error)
      }
    }

    function persist() {
      if (destroyed) return
      writeSavedState(serializeSave({
        mode: mode,
        level: level,
        board: board,
        turn: turn,
        history: history,
        over: over,
        winner: winner,
        winLine: winLine,
        elapsedMs: currentElapsed(),
      }))
    }

    /* ---- 对局推进 ---- */
    function isAITurn() {
      return mode === 'pve' && turn === WHITE && !over && !failure
    }

    function humanCanAct() {
      return !destroyed && !failure && !over && !busy && !hidden && !isAITurn()
    }

    function applyMove(p, side) {
      board[p] = side
      history.push({ p: p, side: side })
      const line = winningLine(board, p, side)
      if (line) {
        over = true
        winner = side
        winLine = line
      } else if (history.length >= CELLS) {
        over = true
        winner = DRAW
        winLine = null
      }
      turn = otherSide(side)
      if (over) {
        pauseClock()
        stopTimerLoop()
      }
    }

    function afterChange() {
      persist()
      paint()
      emit()
      pump()
    }

    function playCell(p) {
      if (destroyed || failure || over || busy || hidden) return false
      if (isAITurn()) return false
      if (!isIntegerBetween(p, 0, CELLS - 1)) return false
      if (board[p] !== EMPTY) return false
      applyMove(p, turn)
      hover = -1
      afterChange()
      return true
    }

    function undo() {
      if (destroyed || busy || history.length === 0) return false
      cancelPending()
      let count = 1
      if (mode === 'pve') count = Math.min(2, history.length)
      for (let i = 0; i < count; i += 1) {
        const entry = history.pop()
        board[entry.p] = EMPTY
      }
      over = false
      winner = DRAW
      winLine = null
      turn = history.length === 0
        ? BLACK
        : (history[history.length - 1].side === BLACK ? WHITE : BLACK)
      lastThinkMs = 0
      lastSecond = -1
      if (!hidden) startClock()
      persist()
      paint()
      emit()
      pump()
      return true
    }

    function newGame() {
      if (destroyed) return
      cancelPending()
      board = createBoard()
      turn = BLACK
      history = []
      over = false
      winner = DRAW
      winLine = null
      hover = -1
      elapsedBase = 0
      elapsedRunningSince = 0
      lastSecond = -1
      lastThinkMs = 0
      if (!hidden) startClock()
      persist()
      paint()
      emit()
      pump()
    }

    function setMode(next) {
      if (MODES.indexOf(next) < 0 || next === mode) return
      mode = next
      newGame()
    }

    function setLevel(next) {
      if (LEVELS[next] === undefined || next === level) return
      level = next
      persist()
      emit()
    }

    /* ---- AI 调度：先让出一帧显示「思考中」，算完补足 200~400ms 的落子节奏 ---- */
    function pump() {
      if (destroyed || failure) return
      if (busy && isAITurn()) return
      if (hidden || over || !isAITurn()) {
        if (busy) {
          busy = false
          emit()
        }
        return
      }
      const token = ++runToken
      busy = true
      emit()
      const delay = AI_DELAY_MIN + Math.floor(Math.random() * (AI_DELAY_MAX - AI_DELAY_MIN + 1))
      const startedAt = nowMs()
      schedule(function () {
        think(token, startedAt, delay)
      }, 30)
    }

    function think(token, startedAt, delay) {
      if (destroyed || token !== runToken) return
      let result = null
      try {
        result = chooseMove(board, WHITE, level)
      } catch (error) {
        fail(error)
        return
      }
      if (destroyed || token !== runToken) return
      lastThinkMs = result && typeof result.thinkMs === 'number'
        ? Math.max(0, Math.round(result.thinkMs))
        : 0
      const spent = nowMs() - startedAt
      const rest = Math.max(0, delay - spent)
      if (rest > 0) {
        schedule(function () {
          commit(token, result)
        }, rest)
      } else {
        commit(token, result)
      }
    }

    function commit(token, result) {
      if (destroyed || token !== runToken) return
      busy = false
      if (!result || result.p < 0 || board[result.p] !== EMPTY || turn !== WHITE) {
        emit()
        return
      }
      applyMove(result.p, WHITE)
      afterChange()
    }

    /* ---- 画布：木色棋盘 + 网格 + 星位 + 立体棋子 + 最后一手 / 胜利高亮 ---- */
    function roundRect(c, x, y, w, h, r) {
      c.beginPath()
      c.moveTo(x + r, y)
      c.arcTo(x + w, y, x + w, y + h, r)
      c.arcTo(x + w, y + h, x, y + h, r)
      c.arcTo(x, y + h, x, y, r)
      c.arcTo(x, y, x + w, y, r)
      c.closePath()
    }

    function stoneRadius() {
      return CELL * 0.42
    }

    function drawStone(c, p, side, alpha) {
      const point = cellCenter(p)
      const x = point.x
      const y = point.y
      const r = stoneRadius()
      c.save()
      c.globalAlpha = alpha
      /* 落影 */
      c.beginPath()
      c.arc(x + r * 0.08, y + r * 0.18, r, 0, Math.PI * 2)
      c.fillStyle = 'rgba(0,0,0,.22)'
      c.fill()
      /* 立体渐变 */
      const gradient = c.createRadialGradient(
        x - r * 0.35, y - r * 0.4, r * 0.12,
        x, y, r * 1.08,
      )
      if (side === BLACK) {
        gradient.addColorStop(0, '#80848a')
        gradient.addColorStop(0.42, '#32353a')
        gradient.addColorStop(1, '#08090a')
      } else {
        gradient.addColorStop(0, '#ffffff')
        gradient.addColorStop(0.55, '#f4f5f6')
        gradient.addColorStop(1, '#c6cad0')
      }
      c.beginPath()
      c.arc(x, y, r, 0, Math.PI * 2)
      c.fillStyle = gradient
      c.fill()
      c.lineWidth = Math.max(0.8, r * 0.07)
      c.strokeStyle = side === BLACK ? 'rgba(0,0,0,.5)' : 'rgba(110,116,124,.55)'
      c.stroke()
      /* 高光 */
      c.beginPath()
      c.arc(x - r * 0.32, y - r * 0.36, r * 0.24, 0, Math.PI * 2)
      c.fillStyle = side === BLACK ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.95)'
      c.fill()
      c.restore()
    }

    function drawBoard(c) {
      c.clearRect(0, 0, LOGICAL_SIZE, LOGICAL_SIZE)

      /* 木纹底 */
      const wood = c.createLinearGradient(0, 0, LOGICAL_SIZE, LOGICAL_SIZE)
      wood.addColorStop(0, '#ecd3a0')
      wood.addColorStop(0.45, '#e0bc7d')
      wood.addColorStop(1, '#cf9f58')
      roundRect(c, 0, 0, LOGICAL_SIZE, LOGICAL_SIZE, 12)
      c.fillStyle = wood
      c.fill()
      c.strokeStyle = 'rgba(120,80,30,.55)'
      c.lineWidth = 1
      c.stroke()

      /* 木纹细线 */
      c.save()
      c.strokeStyle = 'rgba(150,100,40,.1)'
      c.lineWidth = 1
      for (let i = 0; i < 9; i += 1) {
        const y = 24 + i * 68
        c.beginPath()
        c.moveTo(6, y)
        c.bezierCurveTo(180, y - 8, 430, y + 9, LOGICAL_SIZE - 6, y - 2)
        c.stroke()
      }
      c.restore()

      /* 网格 */
      const start = PAD
      const end = PAD + (SIZE - 1) * CELL
      c.strokeStyle = 'rgba(92,62,22,.62)'
      c.lineWidth = 1
      for (let i = 0; i < SIZE; i += 1) {
        const pos = PAD + i * CELL
        c.beginPath()
        c.moveTo(start, pos)
        c.lineTo(end, pos)
        c.stroke()
        c.beginPath()
        c.moveTo(pos, start)
        c.lineTo(pos, end)
        c.stroke()
      }
      c.strokeStyle = 'rgba(92,62,22,.85)'
      c.lineWidth = 2
      c.strokeRect(start, start, end - start, end - start)

      /* 星位 */
      const stars = [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]]
      c.fillStyle = 'rgba(70,45,12,.8)'
      for (let i = 0; i < stars.length; i += 1) {
        c.beginPath()
        c.arc(PAD + stars[i][1] * CELL, PAD + stars[i][0] * CELL, Math.max(2.4, CELL * 0.07), 0, Math.PI * 2)
        c.fill()
      }

      /* 坐标（A–O / 1–15） */
      c.fillStyle = 'rgba(70,45,12,.62)'
      c.font = 'bold 10px "Segoe UI", system-ui, -apple-system, sans-serif'
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      for (let i = 0; i < SIZE; i += 1) {
        c.fillText(String.fromCharCode(65 + i), PAD + i * CELL, PAD / 2 + 1)
        c.fillText(String(i + 1), PAD / 2 + 1, PAD + i * CELL)
      }

      /* 棋子 */
      for (let p = 0; p < CELLS; p += 1) {
        if (board[p] !== EMPTY) drawStone(c, p, board[p], 1)
      }

      /* 胜利连线高亮：金色连线 + 每颗胜利子的金色圆环（黑白子上都显眼） */
      if (winLine && winLine.length >= 5) {
        const first = cellCenter(winLine[0])
        const last = cellCenter(winLine[winLine.length - 1])
        c.save()
        c.strokeStyle = 'rgba(255,179,0,.92)'
        c.lineWidth = Math.max(3.5, CELL * 0.1)
        c.lineCap = 'round'
        c.shadowColor = 'rgba(255,179,0,.8)'
        c.shadowBlur = 12
        c.beginPath()
        c.moveTo(first.x, first.y)
        c.lineTo(last.x, last.y)
        c.stroke()
        c.restore()
        c.save()
        c.strokeStyle = '#ffb300'
        c.lineWidth = 2.5
        c.shadowColor = 'rgba(255,179,0,.95)'
        c.shadowBlur = 8
        for (let i = 0; i < winLine.length; i += 1) {
          const point = cellCenter(winLine[i])
          c.beginPath()
          c.arc(point.x, point.y, stoneRadius() + 2.5, 0, Math.PI * 2)
          c.stroke()
        }
        c.restore()
      }

      /* 最后一手标记 */
      if (history.length) {
        const point = cellCenter(history[history.length - 1].p)
        c.save()
        c.strokeStyle = 'rgba(228,87,76,.95)'
        c.lineWidth = 2
        c.beginPath()
        c.arc(point.x, point.y, stoneRadius() * 0.4, 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }

      /* 悬停落点预览 */
      if (hover >= 0 && hover < CELLS && board[hover] === EMPTY && humanCanAct()) {
        drawStone(c, hover, turn, 0.45)
        const point = cellCenter(hover)
        c.save()
        c.strokeStyle = 'rgba(47,129,247,.95)'
        c.lineWidth = 2
        c.beginPath()
        c.arc(point.x, point.y, stoneRadius() + 2, 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }
    }

    function drawTooSmall(c) {
      const width = Math.max(1, size.width)
      const height = Math.max(1, size.height)
      const dpr = size.dpr
      const pixelWidth = Math.max(1, Math.round(width * dpr))
      const pixelHeight = Math.max(1, Math.round(height * dpr))
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight
      canvas.style.width = Math.round(width) + 'px'
      canvas.style.height = Math.round(height) + 'px'
      c.setTransform(dpr, 0, 0, dpr, 0, 0)
      c.clearRect(0, 0, width, height)
      c.fillStyle = 'rgba(150,150,150,.92)'
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.font = '600 14px "Segoe UI", system-ui, -apple-system, sans-serif'
      c.fillText('窗口太小', width / 2, height / 2 - 11)
      c.font = '12px "Segoe UI", system-ui, -apple-system, sans-serif'
      c.fillText('请放大游戏区域', width / 2, height / 2 + 12)
    }

    function paint() {
      if (destroyed) return
      try {
        if (size.width < MIN_STAGE_W || size.height < MIN_STAGE_H) {
          layout = null
          drawTooSmall(context)
        } else {
          const next = computeLayout(size.width, size.height)
          layout = next
          const pixel = Math.max(1, Math.round(next.cssSize * size.dpr))
          if (canvas.width !== pixel) canvas.width = pixel
          if (canvas.height !== pixel) canvas.height = pixel
          canvas.style.width = next.cssSize + 'px'
          canvas.style.height = next.cssSize + 'px'
          const k = pixel / LOGICAL_SIZE
          context.setTransform(k, 0, 0, k, 0, 0)
          drawBoard(context)
        }
        canvas.style.cursor = humanCanAct() && hover >= 0 ? 'pointer' : 'default'
      } catch (error) {
        fail(error)
      }
    }

    /* ---- 指针输入 ---- */
    function localPoint(event) {
      let rect = null
      try {
        rect = typeof canvas.getBoundingClientRect === 'function'
          ? canvas.getBoundingClientRect()
          : null
      } catch (error) {
        rect = null
      }
      if (!rect || !rect.width) return null
      const clientX = event && typeof event.clientX === 'number' ? event.clientX : 0
      const clientY = event && typeof event.clientY === 'number' ? event.clientY : 0
      const left = typeof rect.left === 'number' ? rect.left : 0
      const top = typeof rect.top === 'number' ? rect.top : 0
      return {
        x: (clientX - left) * (LOGICAL_SIZE / rect.width),
        y: (clientY - top) * (LOGICAL_SIZE / rect.width),
      }
    }

    function updateHover(point) {
      hover = -1
      if (!point || !humanCanAct()) return
      const p = cellHit(point.x, point.y)
      if (p >= 0 && board[p] === EMPTY) hover = p
    }

    function onPointerMove(event) {
      if (destroyed || failure) return
      updateHover(localPoint(event))
      paint()
    }

    function onPointerLeave() {
      if (destroyed) return
      hover = -1
      paint()
    }

    function onPointerDown(event) {
      if (destroyed || failure) return
      try {
        canvas.focus({ preventScroll: true })
      } catch (error) {
        try {
          canvas.focus()
        } catch (focusError) {
          // ignore
        }
      }
      if (!humanCanAct()) return
      const point = localPoint(event)
      if (!point) return
      updateHover(point)
      if (hover < 0) {
        paint()
        return
      }
      playCell(hover)
    }

    /* ---- 尺寸 / 可见性 ---- */
    function resize() {
      if (destroyed) return
      let rect = null
      try {
        rect = typeof host.getBoundingClientRect === 'function'
          ? host.getBoundingClientRect()
          : null
      } catch (error) {
        rect = null
      }
      size = {
        width: Math.max(0, Math.floor((rect && rect.width) || 0)),
        height: Math.max(0, Math.floor((rect && rect.height) || 0)),
        dpr: Math.max(1, view.devicePixelRatio || 1),
      }
      paint()
      emit()
    }

    function onWindowResize() {
      if (destroyed) return
      try {
        resize()
      } catch (error) {
        fail(error)
      }
    }

    /* ResizeObserver 回调里直接改 canvas 尺寸会触发 Chromium 的
     * “ResizeObserver loop completed with undelivered notifications” 警告；
     * 延后一帧再量尺寸，代价可以忽略。 */
    function requestResize() {
      if (destroyed) return
      const raf = view.requestAnimationFrame
      if (typeof raf === 'function') {
        try {
          raf(function () {
            if (destroyed) return
            try {
              resize()
            } catch (error) {
              fail(error)
            }
          })
          return
        } catch (error) {
          // 退化为同步 resize
        }
      }
      try {
        resize()
      } catch (error) {
        fail(error)
      }
    }

    function onVisibilityChange() {
      if (destroyed) return
      hidden = doc.hidden === true
      if (hidden) {
        pauseClock()
        stopTimerLoop()
        cancelPending()
        persist()
        paint()
        emit()
        return
      }
      if (!over) startClock()
      paint()
      emit()
      pump()
    }

    /* ---- 生命周期 ---- */
    function teardown() {
      if (destroyed) return
      pauseClock()
      persist()
      destroyed = true
      cancelPending()
      stopTimerLoop()
      if (resizeObserver) {
        try {
          resizeObserver.disconnect()
        } catch (error) {
          // ignore
        }
        resizeObserver = null
      }
      try {
        doc.removeEventListener('visibilitychange', onVisibilityChange)
      } catch (error) {
        // ignore
      }
      try {
        view.removeEventListener('resize', onWindowResize)
      } catch (error) {
        // ignore
      }
      try {
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerleave', onPointerLeave)
      } catch (error) {
        // ignore
      }
      try {
        canvas.remove()
      } catch (error) {
        // ignore
      }
    }

    /* ---- 初始化 ---- */
    const canvas = doc.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('gomoku: 2d canvas context unavailable')
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'application')
    canvas.setAttribute('aria-label', '五子棋棋盘：点击交叉点落子')
    canvas.style.cssText =
      'display:block;outline:none;touch-action:none;-webkit-user-select:none;user-select:none;cursor:pointer'
    canvas.style.width = LOGICAL_SIZE + 'px'
    canvas.style.height = LOGICAL_SIZE + 'px'

    try {
      const ResizeObserverCtor = view.ResizeObserver
      if (typeof ResizeObserverCtor === 'function') {
        resizeObserver = new ResizeObserverCtor(function () {
          requestResize()
        })
        resizeObserver.observe(host)
      }
    } catch (error) {
      // ResizeObserver 不可用也不影响游戏（只是缩放不跟随）。
    }

    try {
      doc.addEventListener('visibilitychange', onVisibilityChange)
      view.addEventListener('resize', onWindowResize)
      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerleave', onPointerLeave)
      host.appendChild(canvas)
      resize()
      persist()
      emit()
      if (!over) {
        startClock()
        if (isAITurn()) pump()
      }
    } catch (error) {
      try {
        teardown()
      } catch (teardownError) {
        // ignore
      }
      throw error
    }

    return {
      destroy: teardown,
      newGame: newGame,
      undo: undo,
      setMode: setMode,
      setLevel: setLevel,
      playCell: playCell,
      getState: snapshot,
      getBoard: function () {
        return Array.from(board)
      },
      getHistory: function () {
        return history.map(function (entry) {
          return { p: entry.p, side: entry.side }
        })
      },
      getWinLine: function () {
        return winLine ? winLine.slice() : null
      },
      getLayout: function () {
        return layout ? { cssSize: layout.cssSize, scale: layout.scale } : null
      },
      getCanvas: function () {
        return canvas
      },
      cellPoint: function (p) {
        const scale = layout ? layout.scale : 1
        const point = cellCenter(p)
        return { x: point.x * scale, y: point.y * scale }
      },
    }
  }

  /* ======================================================================
   * 5) 测试探针：只有 dev 预览页 / 无头测试显式打开时才安装（生产不触发）
   * ==================================================================== */

  const SEAM = {
    GAME_ID: GAME_ID,
    GAME_LABEL: GAME_LABEL,
    STORE_KEY: STORE_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    SIZE: SIZE,
    CELLS: CELLS,
    EMPTY: EMPTY,
    BLACK: BLACK,
    WHITE: WHITE,
    DRAW: DRAW,
    DIRS: DIRS,
    CENTER: CENTER,
    SHAPES: SHAPES,
    LEVELS: LEVELS,
    LEVEL_IDS: LEVEL_IDS,
    MODES: MODES,
    MODE_META: MODE_META,
    CELL: CELL,
    PAD: PAD,
    LOGICAL_SIZE: LOGICAL_SIZE,
    MIN_STAGE_W: MIN_STAGE_W,
    MIN_STAGE_H: MIN_STAGE_H,
    AI_DELAY_MIN: AI_DELAY_MIN,
    AI_DELAY_MAX: AI_DELAY_MAX,
    HARD_BUDGET_MS: HARD_BUDGET_MS,
    createBoard: createBoard,
    cloneBoard: cloneBoard,
    idx: idx,
    rowOf: rowOf,
    colOf: colOf,
    inBounds: inBounds,
    otherSide: otherSide,
    isWin: isWin,
    winningLine: winningLine,
    getCandidates: getCandidates,
    scorePoint: scorePoint,
    scoreDirection: scoreDirection,
    evaluateBoard: evaluateBoard,
    chooseMove: chooseMove,
    computeLayout: computeLayout,
    cellCenter: cellCenter,
    cellHit: cellHit,
    serializeSave: serializeSave,
    sanitizeSave: sanitizeSave,
    readSavedState: readSavedState,
    writeSavedState: writeSavedState,
    createGame: createGame,
  }

  if (typeof window !== 'undefined' && window.__DSH_GAME_GOMOKU_TEST__ === true) {
    try {
      Object.defineProperty(window, '__DSH_GAME_GOMOKU__', {
        configurable: true,
        value: SEAM,
      })
    } catch (error) {
      // 测试探针失败不能影响游戏本身。
    }
  }

  /* ======================================================================
   * 6) React 界面：工具栏 / 状态栏 / 规则弹窗（画布与输入在 createGame 里）
   * ==================================================================== */

  window.__ModuleLoader__.load({
    id: '@local/dsh-game-gomoku',
    factory(require) {
      const React = require('react')
      const h = React.createElement

      const COLOR_BLACK = '#1b1c1e'
      const COLOR_WHITE = '#f4f5f6'

      const MODE_OPTIONS = MODES.map(function (id) {
        return { value: id, label: MODE_META[id].label }
      })
      const LEVEL_OPTIONS = LEVEL_IDS.map(function (id) {
        return { value: id, label: LEVELS[id].name }
      })

      const UI = {
        root: {
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: '"Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif',
        },
        header: {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px 6px',
        },
        titleBlock: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, marginRight: 4 },
        title: { fontSize: 19, fontWeight: 600, lineHeight: '1.15', letterSpacing: '0.02em' },
        subtitle: {
          fontSize: 11,
          lineHeight: '15px',
          color: 'var(--dsw-alias-label-tertiary)',
          whiteSpace: 'nowrap',
        },
        spacer: { flex: 1, minWidth: 8 },
        group: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
        seg: {
          display: 'flex',
          gap: 2,
          padding: 2,
          borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
        },
        segButton: {
          border: 0,
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          fontFamily: 'inherit',
          fontSize: 12,
          lineHeight: '16px',
          padding: '4px 8px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
        segButtonActive: {
          background: 'var(--dsw-alias-interactive-bg-active)',
          color: 'var(--dsw-alias-label-primary)',
          fontWeight: 600,
          boxShadow: 'inset 0 0 0 1px var(--dsw-alias-border-l1)',
        },
        button: {
          border: '0.5px solid var(--dsw-alias-border-l1)',
          borderRadius: 8,
          background: 'var(--dsw-alias-interactive-bg-hover)',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'inherit',
          fontSize: 12.5,
          lineHeight: '17px',
          padding: '5px 10px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
        statusRow: {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '4px 14px',
          padding: '0 12px 8px',
          minHeight: 26,
        },
        turn: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600 },
        dot: {
          width: 11,
          height: 11,
          borderRadius: '50%',
          display: 'inline-block',
          border: '1px solid rgba(120,120,120,.7)',
          boxSizing: 'border-box',
        },
        meta: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
        metaNum: { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary)' },
        thinking: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' },
        banner: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '3px 10px',
          borderRadius: 8,
          fontWeight: 600,
          fontSize: 12.5,
          background: 'var(--dsw-alias-interactive-bg-active)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
        },
        stage: {
          position: 'relative',
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          margin: '0 8px 8px',
          borderRadius: 12,
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
        },
        host: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          outline: 'none',
        },
        overlay: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.38))',
        },
        panel: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          maxWidth: 320,
          padding: '18px 22px',
          textAlign: 'center',
          borderRadius: 12,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          boxShadow: 'var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,0.18))',
        },
        panelTitle: { fontSize: 17, fontWeight: 600 },
        panelSub: { fontSize: 13, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' },
        mask: {
          position: 'absolute',
          inset: 0,
          zIndex: 20,
          padding: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45))',
        },
        modal: {
          width: 'min(600px, 100%)',
          maxHeight: '86%',
          overflow: 'auto',
          borderRadius: 14,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          boxShadow: 'var(--dsw-elevation-panel, 0 12px 40px rgba(0,0,0,0.3))',
        },
        modalHead: {
          position: 'sticky',
          top: 0,
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '13px 18px',
          background: 'var(--dsw-alias-bg-layer-2)',
          borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
        },
        modalTitle: { flex: 1, fontSize: 15, fontWeight: 600 },
        modalClose: {
          border: 0,
          background: 'transparent',
          color: 'var(--dsw-alias-label-tertiary)',
          cursor: 'pointer',
          fontSize: 22,
          lineHeight: 1,
          padding: '0 4px',
          borderRadius: 6,
          fontFamily: 'inherit',
        },
        modalBody: { padding: '2px 18px 20px' },
        h3: {
          fontSize: 12.5,
          letterSpacing: '0.04em',
          color: 'var(--dsw-alias-label-primary)',
          margin: '20px 0 8px',
          paddingBottom: 6,
          borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
        },
        p: { fontSize: 13, lineHeight: '21px', color: 'var(--dsw-alias-label-secondary)', margin: '8px 0' },
        ul: { margin: '8px 0', paddingLeft: 19 },
        li: { fontSize: 13, lineHeight: '21px', color: 'var(--dsw-alias-label-secondary)', margin: '6px 0' },
        tip: {
          fontSize: 12.5,
          lineHeight: '19px',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'var(--dsw-alias-interactive-bg-hover)',
          borderLeft: '2px solid var(--dsw-alias-brand-primary, #2f81f7)',
          borderRadius: '0 7px 7px 0',
          padding: '9px 12px',
          margin: '10px 0',
        },
        crash: {
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          textAlign: 'center',
          fontSize: 13,
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-secondary)',
        },
      }

      const STYLE_TEXT = [
        '.dshgomoku-btn{transition:background-color .12s ease,opacity .12s ease}',
        '.dshgomoku-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)!important}',
        '.dshgomoku-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.dshgomoku-btn:disabled{opacity:.4;cursor:not-allowed}',
      ].join('\n')

      function Segmented(props) {
        return h(
          'div',
          { style: UI.seg, role: 'group', 'aria-label': props.label },
          props.options.map(function (option) {
            const active = option.value === props.value
            return h(
              'button',
              {
                key: String(option.value),
                type: 'button',
                className: 'dshgomoku-btn',
                'aria-pressed': active,
                style: active ? Object.assign({}, UI.segButton, UI.segButtonActive) : UI.segButton,
                onClick: function () {
                  props.onChange(option.value)
                },
              },
              option.label,
            )
          }),
        )
      }

      function formatTime(ms) {
        const total = Math.max(0, Math.floor((ms || 0) / 1000))
        const minutes = Math.floor(total / 60)
        const seconds = total % 60
        return (minutes < 10 ? '0' + minutes : String(minutes)) + ':' +
          (seconds < 10 ? '0' + seconds : String(seconds))
      }

      function sideName(side) {
        return side === BLACK ? '黑子' : '白子'
      }

      function turnText(state) {
        if (state.over) {
          if (state.winner === DRAW) return '和棋（棋盘已满）'
          if (state.mode === 'pve') return state.winner === BLACK ? '你获胜！' : 'AI 获胜'
          return state.winner === BLACK ? '黑方获胜！' : '白方获胜！'
        }
        if (state.mode === 'pve') {
          return state.turn === BLACK ? '轮到你（黑子）' : 'AI（白子）回合'
        }
        return state.turn === BLACK ? '黑方回合' : '白方回合'
      }

      function RulesModal(props) {
        function p(text) {
          return h('p', { style: UI.p }, text)
        }
        function li(key, children) {
          return h('li', { key: key, style: UI.li }, children)
        }
        return h(
          'div',
          {
            style: UI.mask,
            onMouseDown: function (event) {
              if (event.target === event.currentTarget) props.onClose()
            },
          },
          h(
            'div',
            { style: UI.modal, role: 'dialog', 'aria-modal': 'true', 'aria-label': '五子棋规则' },
            h(
              'div',
              { style: UI.modalHead },
              h('div', { style: UI.modalTitle }, '五子棋 · 规则与操作'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshgomoku-btn',
                  style: UI.modalClose,
                  onClick: props.onClose,
                  'aria-label': '关闭',
                },
                '×',
              ),
            ),
            h(
              'div',
              { style: UI.modalBody },
              h('h3', { style: UI.h3 }, '一、棋盘与目标'),
              h(
                'ul',
                { style: UI.ul },
                li('a1', ['棋盘 ', h('b', { key: 'a1a' }, '15×15'), ' 个交叉点，棋子下在交叉点上。']),
                li('a2', [h('b', { key: 'a2a' }, '黑先白后'), '，双方轮流落子，每次一颗。']),
                li('a3', ['横、竖、两条斜线任意方向', h('b', { key: 'a3a' }, '连成 5 子及以上'), '即获胜（长连也算赢）。']),
                li('a4', '棋盘下满仍未连成五子则为和棋（极少见）。'),
                li('a5', ['本游戏采用', h('b', { key: 'a5a' }, '无禁手自由规则'), '：黑棋不禁止长连、三三、四四。']),
              ),
              h('div', { style: UI.tip }, ['先手优势很大：能先做“活三 / 冲四”的一方更容易掌握节奏，别只顾着堵。']),
              h('h3', { style: UI.h3 }, '二、人机对战与难度'),
              h(
                'ul',
                { style: UI.ul },
                li('b1', ['你执', h('b', { key: 'b1a' }, '黑子先行'), '，AI 执白子。']),
                li('b2', [h('b', { key: 'b2a' }, '简单'), '：在靠前的候选里带权随机，能陪你下但会漏防。']),
                li('b3', [h('b', { key: 'b3a' }, '普通'), '：贪心取“我下这里的分 + 对手下这里的分 × 0.8”最高的点。']),
                li('b4', [h('b', { key: 'b4a' }, '困难'), '：对前 12 个候选做 α-β 搜索（深度 4），单步思考控制在 300ms 内。']),
                li('b5', 'AI 只在已有棋子 2 格范围内选点，落子前有 200~400ms 的思考停顿。'),
              ),
              h('h3', { style: UI.h3 }, '三、操作'),
              h(
                'ul',
                { style: UI.ul },
                li('c1', ['点击空交叉点落子；鼠标悬停会显示落点预览。']),
                li('c2', [h('b', { key: 'c2a' }, '最后一手'), '用红圈标记；获胜时高亮连成五子的那一串。']),
                li('c3', [h('b', { key: 'c3a' }, '撤销'), '：人机模式一次退回 2 步（AI + 你），双人模式退 1 步。']),
                li('c4', '「重开」清空棋盘重新开始；「难度」随时切换，影响之后的 AI 落子。'),
                li('c5', '键盘：U 撤销、N 重开（焦点在游戏内时生效，输入框打字不会触发）。'),
                li('c6', '状态栏显示轮到谁、步数与用时；离开页面再回来，棋局与用时都会保留。'),
              ),
              h('h3', { style: UI.h3 }, '四、小提示'),
              h(
                'ul',
                { style: UI.ul },
                li('d1', '看到对手有“活三”，尽量在两端之一堵住，否则下一手会变成活四。'),
                li('d2', '自己的活三比对手的眠三更值得先走；能冲四就冲，先手很关键。'),
                li('d3', '棋盘边缘的连子空间小，做棋时尽量往中间发展。'),
              ),
            ),
          ),
        )
      }

      const INITIAL_SNAPSHOT = {
        mode: 'pve',
        level: 2,
        turn: BLACK,
        over: false,
        winner: DRAW,
        winLine: null,
        moves: 0,
        lastMove: -1,
        canUndo: false,
        busy: false,
        hidden: false,
        elapsedMs: 0,
        lastThinkMs: 0,
        tooSmall: false,
        failure: null,
      }

      function Game(props) {
        const rootRef = React.useRef(null)
        const hostRef = React.useRef(null)
        const gameRef = React.useRef(null)
        const [snapshot, setSnapshot] = React.useState(INITIAL_SNAPSHOT)
        const [error, setError] = React.useState(null)
        const [rulesOpen, setRulesOpen] = React.useState(false)
        const [attempt, setAttempt] = React.useState(0)

        React.useEffect(function () {
          const host = hostRef.current
          if (!host) return undefined
          let instance = null
          try {
            instance = createGame(host, {
              onState: function (next) {
                setSnapshot(next)
                setError(null)
              },
              onError: function (message) {
                setError(message)
              },
            })
            gameRef.current = instance
          } catch (createError) {
            console.error('[dsh-game-gomoku] failed to start', createError)
            setError('游戏启动失败，点「重试」重新开始。')
            return undefined
          }
          return function cleanup() {
            gameRef.current = null
            try {
              instance.destroy()
            } catch (destroyError) {
              console.error('[dsh-game-gomoku] cleanup failed', destroyError)
            }
          }
        }, [attempt])

        const call = React.useCallback(function (method, argument) {
          const instance = gameRef.current
          if (!instance) return
          try {
            instance[method](argument)
          } catch (callError) {
            console.error('[dsh-game-gomoku] action failed:', method, callError)
            setError('游戏遇到问题，点「重试」重新开始。')
          }
        }, [])

        const onNew = React.useCallback(function () {
          call('newGame')
        }, [call])

        const onUndo = React.useCallback(function () {
          call('undo')
        }, [call])

        const onRetry = React.useCallback(function () {
          setError(null)
          setAttempt(function (value) {
            return value + 1
          })
        }, [])

        const onKeyDown = React.useCallback(
          function (event) {
            if (rulesOpen) {
              if (event.key === 'Escape') {
                event.preventDefault()
                setRulesOpen(false)
              }
              return
            }
            const target = event.target
            const tag = target && target.tagName ? String(target.tagName).toLowerCase() : ''
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) {
              return
            }
            const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
            if (key === 'u') {
              event.preventDefault()
              call('undo')
            } else if (key === 'n') {
              event.preventDefault()
              call('newGame')
            }
          },
          [call, rulesOpen],
        )

        const mode = snapshot.mode
        const showLevel = mode === 'pve'
        const turnColor = snapshot.turn === BLACK ? COLOR_BLACK : COLOR_WHITE
        const winnerColor = snapshot.winner === BLACK ? COLOR_BLACK : COLOR_WHITE
        const dotColor = snapshot.over && snapshot.winner !== DRAW ? winnerColor : turnColor

        return h(
          'div',
          {
            ref: rootRef,
            style: UI.root,
            tabIndex: 0,
            onKeyDown: onKeyDown,
            'data-dsh-game': GAME_ID,
          },
          h('style', null, STYLE_TEXT),
          h(
            'div',
            { style: UI.header },
            h(
              'div',
              { style: UI.titleBlock },
              h('div', { style: UI.title }, GAME_LABEL),
              h('div', { style: UI.subtitle }, '15×15 · 黑先白后 · 横竖斜连成五子即胜'),
            ),
            h('div', { style: UI.spacer }),
            h(Segmented, {
              label: '对局模式',
              options: MODE_OPTIONS,
              value: mode,
              onChange: function (value) {
                call('setMode', value)
              },
            }),
            showLevel
              ? h(Segmented, {
                label: '难度',
                options: LEVEL_OPTIONS,
                value: snapshot.level,
                onChange: function (value) {
                  call('setLevel', value)
                },
              })
              : null,
            h(
              'div',
              { style: UI.group },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshgomoku-btn',
                  style: UI.button,
                  disabled: !snapshot.canUndo,
                  onClick: onUndo,
                  title: mode === 'pve' ? '退回 AI + 你各一步' : '退回一步',
                },
                '撤销',
              ),
              h(
                'button',
                { type: 'button', className: 'dshgomoku-btn', style: UI.button, onClick: onNew },
                '重开',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshgomoku-btn',
                  style: UI.button,
                  onClick: function () {
                    setRulesOpen(true)
                  },
                },
                '📖 规则',
              ),
            ),
          ),
          h(
            'div',
            { style: UI.statusRow },
            h(
              'div',
              { style: UI.turn, role: 'status' },
              h('span', {
                style: Object.assign({}, UI.dot, {
                  background: dotColor,
                }),
              }),
              h('span', null, turnText(snapshot)),
            ),
            h('span', { style: UI.meta }, ['步数 ', h('b', { style: UI.metaNum }, String(snapshot.moves))]),
            h('span', { style: UI.meta }, ['用时 ', h('b', { style: UI.metaNum }, formatTime(snapshot.elapsedMs))]),
            h(
              'span',
              { style: UI.thinking },
              snapshot.busy && !snapshot.over
                ? 'AI 思考中…'
                : (snapshot.lastThinkMs > 0 ? 'AI 上步 ' + snapshot.lastThinkMs + ' ms' : ''),
            ),
            snapshot.tooSmall ? h('span', { style: UI.thinking }, '窗口太小，请放大游戏区域') : null,
            snapshot.over
              ? h(
                'div',
                { style: UI.banner },
                snapshot.winner === DRAW
                  ? '和棋'
                  : (mode === 'pve'
                    ? (snapshot.winner === BLACK ? '你获胜！' : 'AI 获胜！')
                    : (snapshot.winner === BLACK ? '黑方获胜！' : '白方获胜！')),
                h(
                  'button',
                  { type: 'button', className: 'dshgomoku-btn', style: UI.button, onClick: onNew },
                  '再来一局',
                ),
              )
              : null,
          ),
          h(
            'div',
            { style: UI.stage },
            h('div', { ref: hostRef, style: UI.host }),
            error
              ? h(
                'div',
                { style: UI.overlay },
                h(
                  'div',
                  { style: UI.panel },
                  h('div', { style: UI.panelTitle }, '游戏出错'),
                  h('div', { style: UI.panelSub }, error),
                  h(
                    'button',
                    { type: 'button', className: 'dshgomoku-btn', style: UI.button, onClick: onRetry },
                    '重试',
                  ),
                ),
              )
              : null,
          ),
          rulesOpen
            ? h(RulesModal, {
              onClose: function () {
                setRulesOpen(false)
              },
            })
            : null,
        )
      }

      class GameBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        static getDerivedStateFromError() {
          return { failed: true }
        }

        componentDidCatch(error, info) {
          console.error('[dsh-game-gomoku] component crashed', error, info)
        }

        render() {
          if (this.state.failed) {
            return h('div', { style: UI.crash }, '五子棋加载失败，请切走再重新进入「游戏」页。')
          }
          return this.props.children
        }
      }

      function GameEntry(props) {
        return h(GameBoundary, null, h(Game, props))
      }

      /* 冻结的稳定 matched 对象：避免 chain 渲染每次看到新引用。 */
      const MATCHED = Object.freeze({})

      return {
        inject: ['slots'],
        apply: function apply(ctx) {
          try {
            ctx.slots.inject('game.stage', function () {
              try {
                return ctx.slots.register(
                  {
                    name: 'game.stage',
                    id: GAME_ID,
                    label: function () {
                      return GAME_LABEL
                    },
                    select: function (ownerProps) {
                      return ownerProps && ownerProps.gameId === GAME_ID ? MATCHED : null
                    },
                  },
                  GameEntry,
                )
              } catch (error) {
                console.error('[dsh-game-gomoku] slot registration failed', error)
                return function () {}
              }
            })
          } catch (error) {
            console.error('[dsh-game-gomoku] slot inject failed', error)
          }
        },
      }
    },
  })
})()
