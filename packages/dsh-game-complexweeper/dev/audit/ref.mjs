/* 独立参照实现（审计用，不随包发布）
 * ---------------------------------------------------------------------------
 * 逐行直译 D:\...\games_ai\complexweeper\正式版\src\game.zig（514 行）。
 * 不 import engine.js、不复制其代码；只以 game.zig 为唯一依据。
 * 写法故意"笨"：普通 Array、显式下标循环，便于逐条对照 Zig 行号。
 *
 * 与 Zig 的已知取舍（都是 JS 语言差异，不是规则差异）：
 *   - Zig 用 u8/u16/i16 定宽整数；这里用普通 number，但所有输入都保持在
 *     Zig 类型的合法范围内（差分用例不触发溢出），因此不模拟 u16 回绕。
 *   - Zig 越界索引会 panic；这里的调用方保证索引合法（对照用例里没有越界）。
 *
 * 行号注释格式：`zig:123` 指 game.zig 第 123 行。
 */

export const MAX_W = 40 // zig:4
export const MAX_H = 30 // zig:5
export const MAX_CELLS = MAX_W * MAX_H // zig:6
export const MAX_MINES = 999 // zig:7

// zig:11
export const TYPES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

// zig:13
export const MODE_COMPLEX = 0
export const MODE_HYPER = 1

// zig:15
export const ACHIEVABLE = [0, 1, 2, 4, 5, 8, 9, 10, 13, 16, 17, 18, 20, 25, 26, 29, 32, 34, 36, 37, 40, 49, 50, 64]

// zig:18-22
export const PRESETS = [
  { w: 9, h: 9, mines: 10 },
  { w: 16, h: 16, mines: 40 },
  { w: 30, h: 16, mines: 99 },
]

// zig:25-32
export const MSG = { NONE: 0, STARTED: 1, JUDGE_FAIL: 2, EXPAND_OK: 3, WIN: 4, LOSE: 5 }

/** zig:35-51 的 Rng（mulberry32）。种子 0 会变成 1。 */
export class RefRng {
  constructor(seed) {
    this.a = seed === 0 ? 1 : seed >>> 0 // zig:38
  }

  next() {
    // zig:41 self.a +%= 0x6D2B79F5
    this.a = (this.a + 0x6d2b79f5) >>> 0
    let t = this.a // zig:42
    // zig:43 t = (t ^ (t >> 15)) *% (t | 1)
    t = Math.imul((t ^ (t >>> 15)) >>> 0, t | 1) >>> 0
    // zig:44 t ^= t +% ((t ^ (t >> 7)) *% (t | 61))
    const add = (t + Math.imul((t ^ (t >>> 7)) >>> 0, t | 61)) >>> 0
    t = (t ^ add) >>> 0
    // zig:45 (t ^ (t >> 14)) / 4294967296.0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  below(n) {
    // zig:47-50
    if (n === 0) return 0
    return Math.floor(this.next() * n)
  }
}

/**
 * 朴素参照局面。
 * opts: { w, h, mines, typeCount: [_, t1, t2, t3, t4], mode, judgeLoose }
 */
export class RefGame {
  constructor(opts) {
    const o = opts || {}
    this.w = o.w === undefined ? 9 : o.w // zig:54
    this.h = o.h === undefined ? 9 : o.h // zig:55
    this.n = this.w * this.h // zig:56
    this.mode = o.mode === undefined ? MODE_COMPLEX : o.mode // zig:58
    this.judgeLoose = o.judgeLoose === undefined ? false : o.judgeLoose // zig:61

    // zig:62-66：Zig 固定 MAX_CELLS，只有前 n 个有效
    this.mine = new Array(MAX_CELLS).fill(0)
    this.clue = new Array(MAX_CELLS).fill(-1)
    this.open = new Array(MAX_CELLS).fill(0)
    this.flag = new Array(MAX_CELLS).fill(0)

    this.seed = 1 // zig:67
    this.rng = new RefRng(1) // zig:68
    this.mines = o.mines === undefined ? 10 : o.mines // zig:69

    this.typeTotal = [0, 0, 0, 0, 0] // zig:71
    this.flagsOf = [0, 0, 0, 0, 0] // zig:72

    this.typeCount = [0, 0, 0, 0, 0] // zig:74
    if (o.typeCount) {
      for (let t = 0; t < 5; t++) this.typeCount[t] = o.typeCount[t] || 0
    }

    this.started = false // zig:75
    this.over = false // zig:76
    this.win = false // zig:77
    this.boom = -1 // zig:78
    this.startCell = -1 // zig:79
    this.elapsedMs = 0 // zig:80
    this.t0 = 0 // zig:81
    this.moves = 0 // zig:82
    this.msg = MSG.NONE // zig:83
    this.msgArg = 0 // zig:84
  }

  cellCount() {
    return this.n // zig:86-88
  }

  inb(r, c) {
    return r >= 0 && c >= 0 && r < this.h && c < this.w // zig:90-92
  }

  /** zig:95-113：8 邻域，dr=−1..1、dc=−1..1，行优先顺序。 */
  nbrs(cell) {
    const w = this.w
    const r = Math.floor(cell / w)
    const c = cell % w
    const out = []
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue
        const rr = r + dr
        const cc = c + dc
        if (rr < 0 || cc < 0 || rr >= this.h || cc >= w) continue
        out.push(rr * w + cc)
      }
    }
    return out
  }

  nbrMineCount(cell) {
    let n = 0 // zig:115-123
    for (const j of this.nbrs(cell)) if (this.mine[j] !== 0) n++
    return n
  }

  isBlank(cell) {
    return this.mine[cell] === 0 && this.nbrMineCount(cell) === 0 // zig:126-128
  }

  flagsTotal() {
    let s = 0 // zig:130-134
    for (let t = 1; t <= 4; t++) s += this.flagsOf[t]
    return s
  }

  unmarked(t) {
    return this.typeTotal[t] - this.flagsOf[t] // zig:137-139
  }

  setMsg(m) {
    this.msg = m // zig:141-144
    this.msgArg = 0
  }

  setSeed(s) {
    this.seed = s === 0 ? 1 : s >>> 0 // zig:146-149
    this.rng = new RefRng(this.seed)
  }

  /** zig:152-172 */
  newGame(seed) {
    this.n = this.w * this.h
    for (let i = 0; i < this.n; i++) {
      this.mine[i] = 0
      this.clue[i] = -1
      this.open[i] = 0
      this.flag[i] = 0
    }
    this.started = false
    this.over = false
    this.win = false
    this.boom = -1
    this.startCell = -1
    this.elapsedMs = 0
    this.t0 = 0
    this.moves = 0
    this.typeTotal = [0, 0, 0, 0, 0]
    this.flagsOf = [0, 0, 0, 0, 0]
    this.setSeed(seed)
    this.setMsg(MSG.NONE)
  }

  /** zig:175-239 */
  genBoard(startCell) {
    const N = this.n
    for (let i = 0; i < N; i++) {
      this.mine[i] = 0
      this.clue[i] = -1
      this.open[i] = 0
    }
    const isSafe = new Array(N).fill(false) // zig:182-183
    isSafe[startCell] = true
    for (const j of this.nbrs(startCell)) isSafe[j] = true // zig:184-186

    const pool = [] // zig:188-195
    for (let i = 0; i < N; i++) if (!isSafe[i]) pool.push(i)
    const m = pool.length

    // zig:197-205 洗位置
    if (m > 1) {
      let i = m - 1
      while (i > 0) {
        const j = this.rng.below(i + 1)
        const t = pool[i]
        pool[i] = pool[j]
        pool[j] = t
        i -= 1
      }
    }

    let want = 0 // zig:206-207
    for (let t = 1; t <= 4; t++) want += this.typeCount[t]
    const count = Math.min(want > 0 ? want : this.mines, m) // zig:208

    if (want > 0) {
      // zig:210-231 精确配比
      const list = []
      for (let t = 1; t <= 4; t++) {
        for (let k = 0; k < this.typeCount[t]; k++) list.push(t)
      }
      let ln = list.length
      if (ln > count) ln = count // zig:221
      if (ln > 1) {
        // zig:222-230
        let i = ln - 1
        while (i > 0) {
          const j = this.rng.below(i + 1)
          const t = list[i]
          list[i] = list[j]
          list[j] = t
          i -= 1
        }
      }
      for (let k = 0; k < ln; k++) this.mine[pool[k]] = list[k] // zig:231
    } else {
      // zig:232-234
      for (let k = 0; k < count; k++) this.mine[pool[k]] = 1 + this.rng.below(4)
    }

    this.mines = count // zig:235
    this.computeClues() // zig:236
    this.countTypes() // zig:237
    this.cascadeOpen([startCell]) // zig:238
  }

  /** zig:241-260 */
  computeClues() {
    for (let i = 0; i < this.n; i++) {
      if (this.mine[i] !== 0) {
        this.clue[i] = -1
        continue
      }
      let a = 0
      let b = 0
      for (const j of this.nbrs(i)) {
        if (this.mine[j] === 0) continue // zig:252-253 跳过空邻居
        const t = TYPES[this.mine[j] - 1]
        a += t[0]
        b += t[1]
      }
      this.clue[i] = this.mode === MODE_HYPER ? a * a - b * b : a * a + b * b // zig:258
    }
  }

  /** zig:264-277 */
  sumsOf(cell, useFlag) {
    let a = 0
    let b = 0
    for (const j of this.nbrs(cell)) {
      const t = useFlag ? this.flag[j] : this.mine[j]
      if (t === 0) continue
      const d = TYPES[t - 1]
      a += d[0]
      b += d[1]
    }
    return [a, b]
  }

  nbrFlagCount(cell) {
    let n = 0 // zig:280-288
    for (const j of this.nbrs(cell)) if (this.flag[j] !== 0) n++
    return n
  }

  /** zig:290-295 */
  countTypes() {
    this.typeTotal = [0, 0, 0, 0, 0]
    for (let i = 0; i < this.n; i++) {
      if (this.mine[i] !== 0) this.typeTotal[this.mine[i]] += 1
    }
  }

  /** zig:298-332 */
  cascadeOpen(seeds) {
    const stack = []
    const queued = new Array(MAX_CELLS).fill(false) // zig:300（Zig 是 MAX_CELLS 定长）
    for (const s of seeds) {
      if (!queued[s]) {
        queued[s] = true
        stack.push(s)
      }
    }
    let opened = 0
    while (stack.length > 0) {
      const i = stack.pop() // zig:310-311（后进先出）
      if (this.open[i] !== 0 || this.mine[i] !== 0 || this.flag[i] !== 0) continue // zig:314
      this.open[i] = 1
      opened += 1
      if (this.isBlank(i)) {
        // zig:317
        for (const j of this.nbrs(i)) {
          // zig:320-328：压栈时查重
          if (!queued[j] && this.open[j] === 0 && this.mine[j] === 0 && this.flag[j] === 0) {
            queued[j] = true
            stack.push(j)
          }
        }
      }
    }
    return opened // zig:331
  }

  /** zig:334-345 */
  startAt(cell, nowMs) {
    this.setSeed(this.seed)
    this.genBoard(cell)
    this.startCell = cell
    this.started = true
    this.over = false
    this.win = false
    this.elapsedMs = 0
    this.t0 = nowMs
    this.moves = 1
    this.setMsg(MSG.NONE)
  }

  /** zig:348-356 */
  setFlag(cell, t) {
    if (t > 4) return false
    const old = this.flag[cell]
    if (old === t) return true
    if (old !== 0) this.flagsOf[old] -= 1
    this.flag[cell] = t
    if (t !== 0) this.flagsOf[t] += 1
    return true
  }

  /** zig:359-365 */
  cycleFlag(cell) {
    if (this.over || this.open[cell] !== 0) return false
    const next = (this.flag[cell] + 1) % 5
    this.setFlag(cell, next)
    this.moves += 1
    return true
  }

  /** zig:368-384 */
  reveal(cell, nowMs) {
    void nowMs
    if (this.over || this.open[cell] !== 0 || this.flag[cell] !== 0) return
    if (this.mine[cell] !== 0) {
      this.open[cell] = 1
      this.lose(cell)
      return
    }
    this.open[cell] = 1
    if (this.isBlank(cell)) {
      this.cascadeOpen(this.nbrs(cell))
    }
    this.moves += 1
    this.checkWin()
  }

  /** zig:390-413 */
  matchComboTruth(cell) {
    if (this.nbrMineCount(cell) !== this.nbrFlagCount(cell)) return false // zig:391
    if (this.mode === MODE_HYPER) {
      // zig:392-399
      const t = this.sumsOf(cell, false)
      const f = this.sumsOf(cell, true)
      if (this.judgeLoose) {
        return t[0] * t[0] - t[1] * t[1] === f[0] * f[0] - f[1] * f[1]
      }
      return Math.abs(f[0]) === Math.abs(t[0]) && Math.abs(f[1]) === Math.abs(t[1])
    }
    const truth = [0, 0, 0, 0] // zig:400-412
    const got = [0, 0, 0, 0]
    for (const j of this.nbrs(cell)) {
      if (this.mine[j] !== 0) truth[this.mine[j] - 1] += 1
      if (this.flag[j] !== 0) got[this.flag[j] - 1] += 1
    }
    const P = truth[0] + truth[1]
    const V = truth[2] + truth[3]
    const gp = got[0] + got[1]
    const gv = got[2] + got[3]
    return gp + gv === P + V && ((gp === P && gv === V) || (gp === V && gv === P))
  }

  /** zig:416-451 */
  tryExpand(cell) {
    if (this.over || this.open[cell] === 0 || this.mine[cell] !== 0) return
    const uns = []
    for (const j of this.nbrs(cell)) {
      if (this.open[j] === 0 && this.flag[j] === 0) uns.push(j)
    }
    if (uns.length === 0) return // zig:428
    if (!this.matchComboTruth(cell)) {
      this.setMsg(MSG.JUDGE_FAIL) // zig:429-431
      return
    }
    let boom = -1 // zig:433-439
    for (const j of uns) {
      if (this.mine[j] !== 0) {
        boom = j
        break
      }
    }
    if (boom >= 0) {
      this.open[boom] = 1 // zig:441-444
      this.lose(boom)
      return
    }
    this.cascadeOpen(uns) // zig:446
    this.moves += 1
    this.msgArg = uns.length // zig:448
    this.setMsg(MSG.EXPAND_OK) // zig:449（注意：setMsg 会把 msgArg 清零）
    this.checkWin()
  }

  /** zig:453-460 */
  checkWin() {
    for (let i = 0; i < this.n; i++) {
      if (this.mine[i] === 0 && this.open[i] === 0) return
    }
    this.over = true
    this.win = true
    this.setMsg(MSG.WIN)
  }

  /** zig:462-467 */
  lose(cell) {
    this.over = true
    this.win = false
    this.boom = cell
    this.setMsg(MSG.LOSE)
  }

  openedCount() {
    let k = 0 // zig:469-475
    for (let i = 0; i < this.n; i++) if (this.open[i] !== 0) k++
    return k
  }

  safeCount() {
    let k = 0 // zig:477-483
    for (let i = 0; i < this.n; i++) if (this.mine[i] === 0) k++
    return k
  }

  correctFlags() {
    let k = 0 // zig:485-491
    for (let i = 0; i < this.n; i++) {
      if (this.mine[i] !== 0 && this.flag[i] === this.mine[i]) k++
    }
    return k
  }

  typeSum() {
    let s = 0 // zig:494-498
    for (let t = 1; t <= 4; t++) s += this.typeTotal[t]
    return s
  }
}

/** zig:502-514 */
export function splitEvenly(total) {
  const out = [0, 0, 0, 0, 0]
  const base = Math.floor(total / 4)
  let rest = total - base * 4
  for (let t = 1; t <= 4; t++) {
    out[t] = base
    if (rest > 0) {
      out[t] += 1
      rest -= 1
    }
  }
  return out
}

/**
 * selftest.zig:23-55 的独立洪水填充参照（与主循环算法不同：先求空白连通块，
 * 再补上它们的非雷邻居）。返回 Uint8Array(n)，1 = 应当被连片翻开。
 */
export function expectedCascadeFlood(game, start) {
  const set = new Uint8Array(MAX_CELLS)
  const comp = new Uint8Array(MAX_CELLS)
  const stack = [start]
  comp[start] = 1
  while (stack.length > 0) {
    const i = stack.pop()
    for (const j of game.nbrs(i)) {
      if (comp[j] || game.mine[j] !== 0) continue
      if (game.isBlank(j)) {
        comp[j] = 1
        stack.push(j)
      }
    }
  }
  for (let i = 0; i < game.n; i++) {
    if (!comp[i]) continue
    set[i] = 1
    for (const j of game.nbrs(i)) {
      if (game.mine[j] === 0) set[j] = 1
    }
  }
  return set
}
