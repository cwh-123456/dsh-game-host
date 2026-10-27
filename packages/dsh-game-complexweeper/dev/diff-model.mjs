/* =========================================================================
 * 复扫雷 Complexweeper · 独立参照实现 × engine.js 逐字段状态差分
 *   node dev/diff-model.mjs
 * -------------------------------------------------------------------------
 * 独立性声明（本文件存在的意义）：
 *   · `RefRng` / `RefGame` 是照着权威规则 `正式版/src/game.zig` **重新写**的朴素参照实现；
 *     编写时只对照 Zig 源码（行号见各方法注释），不 import、不复制 engine.js 的代码结构。
 *   · engine.js 只在本文件后半段作为**被测对象**动态加载（`await import`），
 *     用于逐字段状态差分；参照实现的计算不依赖它。
 *   · 差异为 0 才说明 engine.js 与 Zig 规则一致；出现差异时本脚本不判断谁错，
 *     只打印最小上下文（配置 / 种子 / 步骤 / 操作 / 字段 / 期望(参照) / 实际(engine)）。
 *
 * 覆盖：
 *   · 三档难度（9×9/10、16×16/40、30×16/99）× 多种子；
 *   · 额外局面：12×12 随机、精确配比（type_count）、纯虚配比、40×30 超大连片、40×30/60、
 *     9×9/72 饱和盘；
 *   · 随机操作序列：reveal / cycleFlag / tryExpand / chord（按真值摆旗后展开）/ setFlag / 清旗；
 *   · 结束后继续操作（over 守门）、重开（newGame+startAt）、首点前插旗、同局二次 startAt、
 *     首点四角/边/中央等边角；
 *   · 每步比较：mine / clue / open / flag / typeTotal / flagsOf / started / over / win /
 *     boom / startCell / seed / mines / moves / msg / msgArg / elapsedMs / t0 / rngA；
 *   · 定期比较辅助函数：nbrs / nbrMineCount / nbrFlagCount / isBlank / sumsOf / flagsTotal /
 *     unmarked / openedCount / safeCount / correctFlags / typeSum / matchComboTruth。
 *
 * 退出码 0 = 全绿；stdout 报告比较次数与差异数。
 * =======================================================================*/

import { fileURLToPath } from 'node:url'

/* ======================================================================
 * 第一部分：独立参照实现（只对照 game.zig 写）
 * ====================================================================*/

/** 四种雷 (实部, 虚部)，对应 game.zig:11 TYPES。mine[] 存 1..4。 */
const SPECIES = [
  [1, 0], // 1: +1
  [-1, 0], // 2: −1
  [0, 1], // 3: +i
  [0, -1], // 4: −i
]

/** mulberry32，对应 game.zig:35-51 Rng。 */
class RefRng {
  constructor(seed) {
    this.a = seed === 0 ? 1 : seed >>> 0
  }

  next() {
    this.a = (this.a + 0x6d2b79f5) >>> 0
    let t = this.a
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0
    t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0)) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  below(n) {
    if (n === 0) return 0
    return Math.floor(this.next() * n)
  }
}

/**
 * 朴素参照棋盘（对照 game.zig:53-499 Game 逐方法重写）。
 * 与 engine.js 的差异（刻意为之）：
 *   · 数组只开 w*h，不做 MAX_CELLS 预留；
 *   · 计数用普通 number 数组；
 *   · 不带 snapshot / fromSnapshot（存档不是规则差分范围，由 selftest.mjs 覆盖）。
 */
class RefGame {
  constructor(opts = {}) {
    this.w = Number.isInteger(opts.w) ? opts.w : 9
    this.h = Number.isInteger(opts.h) ? opts.h : 9
    this.n = this.w * this.h
    this.mode = opts.mode === 1 ? 1 : 0 // game.zig:13 Mode
    this.judgeLoose = opts.judgeLoose === true // game.zig:61

    this.mine = new Uint8Array(this.n) // game.zig:62
    this.clue = new Int16Array(this.n) // game.zig:64
    this.clue.fill(-1)
    this.open = new Uint8Array(this.n) // game.zig:65
    this.flag = new Uint8Array(this.n) // game.zig:66

    this.seed = 1 // game.zig:67
    this.rng = new RefRng(1)
    this.mines = Number.isInteger(opts.mines) ? opts.mines : 10 // game.zig:69
    this.typeTotal = [0, 0, 0, 0, 0] // game.zig:71（下标 1..4）
    this.flagsOf = [0, 0, 0, 0, 0] // game.zig:72
    this.typeCount = [0, 0, 0, 0, 0] // game.zig:74
    if (opts.typeCount) {
      for (let t = 1; t <= 4; t++) {
        const v = opts.typeCount[t]
        this.typeCount[t] = Number.isInteger(v) && v > 0 ? v : 0
      }
    }
    this.started = false // game.zig:75
    this.over = false
    this.win = false
    this.boom = -1
    this.startCell = -1
    this.elapsedMs = 0
    this.t0 = 0
    this.moves = 0
    this.msg = 0 // game.zig:83 Msg.none
    this.msgArg = 0
  }

  /* ---- 基础查询 ---- */

  inb(r, c) {
    // game.zig:90
    return r >= 0 && c >= 0 && r < this.h && c < this.w
  }

  nbrs(cell) {
    // game.zig:95-113：行优先双重循环 dr = −1..1, dc = −1..1
    const r = Math.floor(cell / this.w)
    const c = cell - r * this.w
    const out = []
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue
        const rr = r + dr
        const cc = c + dc
        if (rr < 0 || cc < 0 || rr >= this.h || cc >= this.w) continue
        out.push(rr * this.w + cc)
      }
    }
    return out
  }

  nbrMineCount(cell) {
    // game.zig:115-123
    let count = 0
    for (const j of this.nbrs(cell)) if (this.mine[j] !== 0) count++
    return count
  }

  isBlank(cell) {
    // game.zig:126-128
    return this.mine[cell] === 0 && this.nbrMineCount(cell) === 0
  }

  flagsTotal() {
    // game.zig:130-134
    let sum = 0
    for (let t = 1; t <= 4; t++) sum += this.flagsOf[t]
    return sum
  }

  unmarked(t) {
    // game.zig:137-139
    return this.typeTotal[t] - this.flagsOf[t]
  }

  nbrFlagCount(cell) {
    // game.zig:280-288
    let count = 0
    for (const j of this.nbrs(cell)) if (this.flag[j] !== 0) count++
    return count
  }

  openedCount() {
    // game.zig:469-475
    let count = 0
    for (let i = 0; i < this.n; i++) if (this.open[i] !== 0) count++
    return count
  }

  safeCount() {
    // game.zig:477-483
    let count = 0
    for (let i = 0; i < this.n; i++) if (this.mine[i] === 0) count++
    return count
  }

  correctFlags() {
    // game.zig:485-491
    let count = 0
    for (let i = 0; i < this.n; i++) if (this.mine[i] !== 0 && this.flag[i] === this.mine[i]) count++
    return count
  }

  typeSum() {
    // game.zig:494-498
    let sum = 0
    for (let t = 1; t <= 4; t++) sum += this.typeTotal[t]
    return sum
  }

  /* ---- 状态迁移 ---- */

  setMsg(m) {
    // game.zig:141-144
    this.msg = m
    this.msgArg = 0
  }

  setSeed(s) {
    // game.zig:146-149
    this.seed = s === 0 ? 1 : s >>> 0
    this.rng = new RefRng(this.seed)
  }

  newGame(seed) {
    // game.zig:152-172
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
    this.setMsg(0)
  }

  genBoard(startCell) {
    // game.zig:175-239
    for (let i = 0; i < this.n; i++) {
      this.mine[i] = 0
      this.clue[i] = -1
      this.open[i] = 0
      // 注意：Zig 不在这里清 flag（首点前插的旗会带进新棋盘）
    }

    const safe = new Uint8Array(this.n)
    safe[startCell] = 1
    for (const j of this.nbrs(startCell)) safe[j] = 1

    // 可布雷位置池
    const pool = []
    for (let i = 0; i < this.n; i++) if (safe[i] === 0) pool.push(i)

    // Fisher–Yates：i = 池尾 → 1
    for (let i = pool.length - 1; i > 0; i--) {
      const j = this.rng.below(i + 1)
      const tmp = pool[i]
      pool[i] = pool[j]
      pool[j] = tmp
    }

    let want = 0
    for (let t = 1; t <= 4; t++) want += this.typeCount[t]
    const requested = want > 0 ? want : this.mines
    const count = Math.min(requested, pool.length) // game.zig:208 @min(...)

    if (want > 0) {
      // 精确配比：铺类型序列 → 洗前缀 → 按 count 截断（game.zig:210-231）
      const list = []
      for (let t = 1; t <= 4; t++) for (let k = 0; k < this.typeCount[t]; k++) list.push(t)
      let ln = list.length
      if (ln > count) ln = count
      for (let i = ln - 1; i > 0; i--) {
        const j = this.rng.below(i + 1)
        const tmp = list[i]
        list[i] = list[j]
        list[j] = tmp
      }
      for (let k = 0; k < ln; k++) this.mine[pool[k]] = list[k]
    } else {
      // 类型随机撒（game.zig:232-234）
      for (let k = 0; k < count; k++) this.mine[pool[k]] = 1 + this.rng.below(4)
    }

    this.mines = count
    this.computeClues()
    this.countTypes()
    this.cascadeOpen([startCell])
  }

  computeClues() {
    // game.zig:241-260
    for (let i = 0; i < this.n; i++) {
      if (this.mine[i] !== 0) {
        this.clue[i] = -1
        continue
      }
      let a = 0
      let b = 0
      for (const j of this.nbrs(i)) {
        const m = this.mine[j]
        if (m === 0) continue
        a += SPECIES[m - 1][0]
        b += SPECIES[m - 1][1]
      }
      this.clue[i] = this.mode === 1 ? a * a - b * b : a * a + b * b
    }
  }

  sumsOf(cell, useFlag) {
    // game.zig:264-277
    let a = 0
    let b = 0
    for (const j of this.nbrs(cell)) {
      const t = useFlag ? this.flag[j] : this.mine[j]
      if (t === 0) continue
      a += SPECIES[t - 1][0]
      b += SPECIES[t - 1][1]
    }
    return [a, b]
  }

  countTypes() {
    // game.zig:290-295
    this.typeTotal = [0, 0, 0, 0, 0]
    for (let i = 0; i < this.n; i++) if (this.mine[i] !== 0) this.typeTotal[this.mine[i]]++
  }

  cascadeOpen(seeds) {
    // game.zig:298-332
    const stack = []
    const queued = new Uint8Array(this.n)
    for (const s of seeds) {
      if (queued[s] === 0) {
        queued[s] = 1
        stack.push(s)
      }
    }
    let opened = 0
    while (stack.length > 0) {
      const i = stack.pop()
      if (this.open[i] !== 0 || this.mine[i] !== 0 || this.flag[i] !== 0) continue
      this.open[i] = 1
      opened++
      if (this.isBlank(i)) {
        for (const j of this.nbrs(i)) {
          if (queued[j] === 0 && this.open[j] === 0 && this.mine[j] === 0 && this.flag[j] === 0) {
            queued[j] = 1
            stack.push(j)
          }
        }
      }
    }
    return opened
  }

  startAt(cell, nowMs) {
    // game.zig:334-345
    this.setSeed(this.seed)
    this.genBoard(cell)
    this.startCell = cell
    this.started = true
    this.over = false
    this.win = false
    this.elapsedMs = 0
    this.t0 = nowMs
    this.moves = 1
    this.setMsg(0)
  }

  setFlag(cell, t) {
    // game.zig:348-356
    if (t > 4) return false
    const old = this.flag[cell]
    if (old === t) return true
    if (old !== 0) this.flagsOf[old]--
    this.flag[cell] = t
    if (t !== 0) this.flagsOf[t]++
    return true
  }

  cycleFlag(cell) {
    // game.zig:359-365
    if (this.over || this.open[cell] !== 0) return false
    const next = (this.flag[cell] + 1) % 5
    this.setFlag(cell, next)
    this.moves++
    return true
  }

  reveal(cell, nowMs) {
    // game.zig:368-384（now_ms 在 Zig 里未使用）
    void nowMs
    if (this.over || this.open[cell] !== 0 || this.flag[cell] !== 0) return
    if (this.mine[cell] !== 0) {
      this.open[cell] = 1
      this.lose(cell)
      return
    }
    this.open[cell] = 1
    if (this.isBlank(cell)) this.cascadeOpen(this.nbrs(cell))
    this.moves++
    this.checkWin()
  }

  matchComboTruth(cell) {
    // game.zig:390-413
    if (this.nbrMineCount(cell) !== this.nbrFlagCount(cell)) return false
    if (this.mode === 1) {
      const t = this.sumsOf(cell, false)
      const f = this.sumsOf(cell, true)
      if (this.judgeLoose) return t[0] * t[0] - t[1] * t[1] === f[0] * f[0] - f[1] * f[1]
      return Math.abs(f[0]) === Math.abs(t[0]) && Math.abs(f[1]) === Math.abs(t[1])
    }
    const truth = [0, 0, 0, 0]
    const got = [0, 0, 0, 0]
    for (const j of this.nbrs(cell)) {
      if (this.mine[j] !== 0) truth[this.mine[j] - 1]++
      if (this.flag[j] !== 0) got[this.flag[j] - 1]++
    }
    const P = truth[0] + truth[1]
    const V = truth[2] + truth[3]
    const gp = got[0] + got[1]
    const gv = got[2] + got[3]
    return gp + gv === P + V && ((gp === P && gv === V) || (gp === V && gv === P))
  }

  tryExpand(cell) {
    // game.zig:416-451
    if (this.over || this.open[cell] === 0 || this.mine[cell] !== 0) return
    const uns = []
    for (const j of this.nbrs(cell)) if (this.open[j] === 0 && this.flag[j] === 0) uns.push(j)
    if (uns.length === 0) return
    if (!this.matchComboTruth(cell)) {
      this.setMsg(2) // Msg.judge_fail
      return
    }
    let boom = -1
    for (const j of uns) {
      if (this.mine[j] !== 0) {
        boom = j
        break
      }
    }
    if (boom >= 0) {
      this.open[boom] = 1
      this.lose(boom)
      return
    }
    this.cascadeOpen(uns)
    this.moves++
    this.msgArg = uns.length
    this.setMsg(3) // Msg.expand_ok（注意 setMsg 会把 msg_arg 清零，Zig 同）
    this.checkWin()
  }

  checkWin() {
    // game.zig:453-460
    for (let i = 0; i < this.n; i++) {
      if (this.mine[i] === 0 && this.open[i] === 0) return
    }
    this.over = true
    this.win = true
    this.setMsg(4) // Msg.win
  }

  lose(cell) {
    // game.zig:462-467
    this.over = true
    this.win = false
    this.boom = cell
    this.setMsg(5) // Msg.lose
  }
}

/* ======================================================================
 * 第二部分：加载被测引擎（放在参照实现之后；参照实现没有读它）
 * ====================================================================*/

const ENGINE_URL = new URL('../engine.js', import.meta.url)
await import(ENGINE_URL.href)
const ENGINE_PATH = fileURLToPath(ENGINE_URL)
const E = globalThis.CS
if (!E) {
  console.error('无法加载 engine.js（globalThis.CS 缺失）')
  process.exit(1)
}
const EngineGame = E.Game
const EngineRng = E.Rng

/* ======================================================================
 * 第三部分：差分工具
 * ====================================================================*/

const ENGINE_INFO = {
  engine: 'complexweeper',
  ref: 'RefGame / RefRng（按 正式版/src/game.zig 逐方法重写，不依赖 engine.js）',
  enginePath: ENGINE_PATH,
}
const stats = {
  states: 0, // 逐字段状态快照比较次数
  fieldValues: 0, // 标量 / 数组元素的逐值比较次数
  helperChecks: 0, // 辅助函数比较次数
  ops: 0, // 随机玩法操作次数
  sessions: 0, // 独立对局数（含重开）
  restarts: 0, // newGame+startAt 重开次数
  overNoops: 0, // 结束后继续操作次数
  edgeComparisons: 0, // 边角场景比较次数
  rngValues: 0, // RNG 输出逐值比较次数
}
const opCounts = { reveal: 0, cycleFlag: 0, tryExpand: 0, chord: 0, setFlag: 0, clearFlag: 0 }
const failures = []
const MAX_REPORTED_DIFFS = 8

class Divergence extends Error {
  constructor(ctx, diffs) {
    super(`状态差分：${JSON.stringify(ctx)}`)
    this.ctx = ctx
    this.diffs = diffs
  }
}

function recordDivergence(err, cfgName) {
  failures.push({ cfg: cfgName, ctx: err.ctx, diffs: err.diffs })
  if (failures.length <= MAX_REPORTED_DIFFS) {
    console.log(`  [DIFF] ${cfgName} ${JSON.stringify(err.ctx)}`)
    for (const d of err.diffs) console.log(`         · ${d}`)
  }
}

/**
 * 全状态逐字段比较：engine（被测）vs ref（参照）。
 * 数组只比较前 n 个有效格（engine.js 约定 mine/clue/open/flag 只有前 n 个有效）。
 */
function compareAll(engine, ref, ctx) {
  stats.states++
  const diffs = []
  const addDiff = (field, refVal, engVal) => {
    if (diffs.length < 12) {
      diffs.push(`${field}: 参照=${JSON.stringify(refVal)} engine=${JSON.stringify(engVal)}`)
    }
  }
  const scalar = (name, refVal, engVal) => {
    stats.fieldValues++
    if (!Object.is(refVal, engVal)) addDiff(name, refVal, engVal)
  }
  const array = (name, refArr, engArr) => {
    for (let i = 0; i < ref.n; i++) {
      stats.fieldValues++
      if (refArr[i] !== engArr[i]) {
        addDiff(`${name}[${i}]`, refArr[i], engArr[i])
        return
      }
    }
  }

  scalar('n', ref.n, engine.n)
  scalar('w', ref.w, engine.w)
  scalar('h', ref.h, engine.h)
  scalar('mode', ref.mode, engine.mode)
  scalar('judgeLoose', ref.judgeLoose, engine.judgeLoose)
  scalar('seed', ref.seed, engine.seed)
  scalar('mines', ref.mines, engine.mines)
  scalar('started', ref.started, engine.started)
  scalar('over', ref.over, engine.over)
  scalar('win', ref.win, engine.win)
  scalar('boom', ref.boom, engine.boom)
  scalar('startCell', ref.startCell, engine.startCell)
  scalar('elapsedMs', ref.elapsedMs, engine.elapsedMs)
  scalar('t0', ref.t0, engine.t0)
  scalar('moves', ref.moves, engine.moves)
  scalar('msg', ref.msg, engine.msg)
  scalar('msgArg', ref.msgArg, engine.msgArg)
  scalar('rng.a', ref.rng.a >>> 0, engine.rng.a >>> 0)

  array('mine', ref.mine, engine.mine)
  array('clue', ref.clue, engine.clue)
  array('open', ref.open, engine.open)
  array('flag', ref.flag, engine.flag)

  for (let t = 0; t <= 4; t++) {
    stats.fieldValues++
    if (ref.typeTotal[t] !== engine.typeTotal[t]) addDiff(`typeTotal[${t}]`, ref.typeTotal[t], engine.typeTotal[t])
    stats.fieldValues++
    if (ref.flagsOf[t] !== engine.flagsOf[t]) addDiff(`flagsOf[${t}]`, ref.flagsOf[t], engine.flagsOf[t])
  }

  if (diffs.length > 0) throw new Divergence(ctx, diffs)
}

/** 辅助函数比较（比全状态便宜，定期抽样）。 */
function compareHelpers(engine, ref, ctx) {
  const scalar = (name, refVal, engVal) => {
    stats.helperChecks++
    if (!Object.is(refVal, engVal)) {
      throw new Divergence(ctx, [`${name}: 参照=${JSON.stringify(refVal)} engine=${JSON.stringify(engVal)}`])
    }
  }
  const array = (name, refArr, engArr) => {
    stats.helperChecks++
    if (refArr.length !== engArr.length) throw new Divergence(ctx, [`${name}.length: 参照=${refArr.length} engine=${engArr.length}`])
    for (let i = 0; i < refArr.length; i++) {
      if (refArr[i] !== engArr[i]) throw new Divergence(ctx, [`${name}[${i}]: 参照=${refArr[i]} engine=${engArr[i]}`])
    }
  }

  scalar('flagsTotal', ref.flagsTotal(), engine.flagsTotal())
  for (let t = 1; t <= 4; t++) scalar(`unmarked(${t})`, ref.unmarked(t), engine.unmarked(t))
  scalar('openedCount', ref.openedCount(), engine.openedCount())
  scalar('safeCount', ref.safeCount(), engine.safeCount())
  scalar('correctFlags', ref.correctFlags(), engine.correctFlags())
  scalar('typeSum', ref.typeSum(), engine.typeSum())

  // 抽样格：固定角/边/中央 + 伪随机若干
  const cells = new Set([0, ref.n - 1, ref.n >> 1, ref.w - 1, (ref.h - 1) * ref.w])
  const pickRng = new OpRandom((ctx.seed ^ 0x51ed270b) >>> 0)
  for (let k = 0; k < 6; k++) cells.add(pickRng.below(ref.n))
  for (const cell of cells) {
    if (cell < 0 || cell >= ref.n) continue
    array(`nbrs(${cell})`, ref.nbrs(cell), engine.nbrs(cell))
    scalar(`nbrMineCount(${cell})`, ref.nbrMineCount(cell), engine.nbrMineCount(cell))
    scalar(`nbrFlagCount(${cell})`, ref.nbrFlagCount(cell), engine.nbrFlagCount(cell))
    scalar(`isBlank(${cell})`, ref.isBlank(cell), engine.isBlank(cell))
    scalar(`sumsOf(${cell},false).a`, ref.sumsOf(cell, false)[0], engine.sumsOf(cell, false)[0])
    scalar(`sumsOf(${cell},false).b`, ref.sumsOf(cell, false)[1], engine.sumsOf(cell, false)[1])
    scalar(`sumsOf(${cell},true).a`, ref.sumsOf(cell, true)[0], engine.sumsOf(cell, true)[0])
    scalar(`sumsOf(${cell},true).b`, ref.sumsOf(cell, true)[1], engine.sumsOf(cell, true)[1])
    scalar(`matchComboTruth(${cell})`, ref.matchComboTruth(cell), engine.matchComboTruth(cell))
    // inb 边角
    const r = Math.floor(cell / ref.w)
    const c = cell - r * ref.w
    scalar(`inb(${r},${c})`, ref.inb(r, c), engine.inb(r, c))
    scalar(`inb(${r - 1},${c - 1})`, ref.inb(r - 1, c - 1), engine.inb(r - 1, c - 1))
  }
}

/* ------------------------------ 操作序列生成 ------------------------------ */

/** 操作序列用的独立 LCG（与玩法 RNG 无关，避免和 mulberry32 意外同源）。 */
class OpRandom {
  constructor(seed) {
    this.s = (seed === 0 ? 1 : seed) >>> 0
  }

  next() {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0
    return this.s / 4294967296
  }

  below(n) {
    if (n <= 0) return 0
    return Math.floor(this.next() * n)
  }
}

function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd.below(i + 1)
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

function pickUnopenedCell(engine, rnd) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const cell = rnd.below(engine.n)
    if (engine.open[cell] === 0) return cell
  }
  const start = rnd.below(engine.n)
  for (let k = 0; k < engine.n; k++) {
    const cell = (start + k) % engine.n
    if (engine.open[cell] === 0) return cell
  }
  return rnd.below(engine.n) // 全开：任意格（reveal/cycleFlag 会 no-op）
}

function collectOpenedSafeCells(engine) {
  const cells = []
  for (let i = 0; i < engine.n; i++) if (engine.open[i] !== 0 && engine.mine[i] === 0) cells.push(i)
  return cells
}

/** 按真值摆旗后展开：覆盖判据通过 + 翻开 / 判据通过但踩雷两条路径。 */
function applyChord(engine, ref, rnd) {
  const candidates = []
  for (let i = 0; i < engine.n; i++) {
    if (engine.open[i] === 0 || engine.mine[i] !== 0) continue
    let unopened = 0
    let mines = 0
    for (const j of engine.nbrs(i)) {
      if (engine.open[j] === 0 && engine.flag[j] === 0) {
        unopened++
        if (engine.mine[j] !== 0) mines++
      }
    }
    if (unopened > 0 && mines > 0) candidates.push(i)
  }
  if (candidates.length === 0) {
    const cell = rnd.below(engine.n)
    engine.reveal(cell, 0)
    ref.reveal(cell, 0)
    opCounts.reveal++
    return `reveal(${cell}) [chord fallback]`
  }
  const cell = candidates[rnd.below(candidates.length)]

  // 双方先清掉该格邻域的所有旗（旗不影响 mine/open）
  for (const j of engine.nbrs(cell)) {
    engine.setFlag(j, 0)
    ref.setFlag(j, 0)
  }

  // 真值（用 engine 的 mine 读；镜像到 ref 的 mine 上，两边状态此刻应相同）
  const truth = [0, 0, 0, 0]
  for (const j of engine.nbrs(cell)) if (engine.mine[j] !== 0) truth[engine.mine[j] - 1]++
  const P = truth[0] + truth[1]
  const V = truth[2] + truth[3]

  const uns = []
  for (const j of engine.nbrs(cell)) if (engine.open[j] === 0) uns.push(j)
  if (uns.length < P + V) {
    // 邻格不够插满真值旗数：退化成普通 reveal（保证步骤有进展）
    const fallback = rnd.below(engine.n)
    engine.reveal(fallback, 0)
    ref.reveal(fallback, 0)
    opCounts.reveal++
    return `reveal(${fallback}) [chord skip]`
  }

  // 随机选 P+V 个邻格插旗，实/虚数量按真值或其倒置（两种都能通过判据）
  const chosen = shuffle(uns.slice(), rnd).slice(0, P + V)
  const swapped = rnd.below(2) === 1
  const realFlags = swapped ? V : P
  const imagFlags = swapped ? P : V
  const types = []
  for (let k = 0; k < realFlags; k++) types.push(1 + rnd.below(2)) // ±1（实部）
  for (let k = 0; k < imagFlags; k++) types.push(3 + rnd.below(2)) // ±i（虚部）
  shuffle(types, rnd)
  for (let k = 0; k < chosen.length; k++) {
    engine.setFlag(chosen[k], types[k])
    ref.setFlag(chosen[k], types[k])
  }

  engine.tryExpand(cell)
  ref.tryExpand(cell)
  opCounts.chord++
  return `chord(${cell},P=${P},V=${V},${swapped ? 'swap' : 'same'},flags=${chosen.length})`
}

function applyOp(engine, ref, rnd, kind) {
  switch (kind) {
    case 'reveal': {
      const cell = pickUnopenedCell(engine, rnd)
      engine.reveal(cell, 0)
      ref.reveal(cell, 0)
      opCounts.reveal++
      return `reveal(${cell})`
    }
    case 'cycleFlag': {
      const cell = pickUnopenedCell(engine, rnd)
      engine.cycleFlag(cell)
      ref.cycleFlag(cell)
      opCounts.cycleFlag++
      return `cycleFlag(${cell})`
    }
    case 'tryExpand': {
      const opened = collectOpenedSafeCells(engine)
      const cell = opened.length > 0 ? opened[rnd.below(opened.length)] : rnd.below(engine.n)
      engine.tryExpand(cell)
      ref.tryExpand(cell)
      opCounts.tryExpand++
      return `tryExpand(${cell})`
    }
    case 'chord':
      return applyChord(engine, ref, rnd)
    case 'setFlag': {
      const cell = pickUnopenedCell(engine, rnd)
      const t = 1 + rnd.below(4)
      engine.setFlag(cell, t)
      ref.setFlag(cell, t)
      opCounts.setFlag++
      return `setFlag(${cell},${t})`
    }
    case 'clearFlag': {
      const cell = pickUnopenedCell(engine, rnd)
      engine.setFlag(cell, 0)
      ref.setFlag(cell, 0)
      opCounts.clearFlag++
      return `clearFlag(${cell})`
    }
    default:
      throw new Error(`未知操作 ${kind}`)
  }
}

function pickKind(rnd) {
  const x = rnd.below(100)
  if (x < 38) return 'reveal'
  if (x < 56) return 'cycleFlag'
  if (x < 68) return 'tryExpand'
  if (x < 84) return 'chord'
  if (x < 94) return 'setFlag'
  return 'clearFlag'
}

/* ------------------------------ 单局差分 ------------------------------ */

function mix32(v) {
  let x = v >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b) >>> 0
  x ^= x >>> 16
  return x >>> 0
}

function startFor(seed, cfg) {
  // 开局格：轮流覆盖角 / 边 / 中央
  const variants = [0, Math.floor(cfg.w / 2), Math.floor(cfg.h / 2) * cfg.w + Math.floor(cfg.w / 2), cfg.w * cfg.h - 1]
  return variants[seed % variants.length]
}

function engineOptsOf(cfg) {
  const opts = { w: cfg.w, h: cfg.h, mines: cfg.mines }
  if (cfg.typeCount) opts.typeCount = cfg.typeCount
  return opts
}

function refOptsOf(cfg) {
  const opts = { w: cfg.w, h: cfg.h, mines: cfg.mines }
  if (cfg.typeCount) opts.typeCount = cfg.typeCount
  return opts
}

function runSession(cfg, seed) {
  stats.sessions++
  const engine = new EngineGame(engineOptsOf(cfg))
  const ref = new RefGame(refOptsOf(cfg))
  const baseCtx = { cfg: cfg.name, seed }

  engine.newGame(seed)
  ref.newGame(seed)
  compareAll(engine, ref, { ...baseCtx, step: 'newGame' })

  const startCell = startFor(seed, cfg)
  engine.startAt(startCell, 0)
  ref.startAt(startCell, 0)
  compareAll(engine, ref, { ...baseCtx, step: 'startAt', startCell })

  const rnd = new OpRandom(mix32(seed ^ 0x9e3779b9))
  const maxRestarts = Math.ceil(cfg.steps / 15) + 8
  let sessionStates = 2
  let step = 0
  let restarts = 0
  let overNoops = 0

  while (sessionStates < cfg.steps) {
    step++
    if (engine.over) {
      if (overNoops < 5) {
        // 结束后继续操作：reveal / cycleFlag / tryExpand 都必须被 over 守门
        overNoops++
        const cell = rnd.below(engine.n)
        const kind = rnd.below(3)
        let desc
        if (kind === 0) {
          engine.reveal(cell, 0)
          ref.reveal(cell, 0)
          desc = `reveal(${cell})`
        } else if (kind === 1) {
          engine.cycleFlag(cell)
          ref.cycleFlag(cell)
          desc = `cycleFlag(${cell})`
        } else {
          engine.tryExpand(cell)
          ref.tryExpand(cell)
          desc = `tryExpand(${cell})`
        }
        stats.overNoops++
        compareAll(engine, ref, { ...baseCtx, step, op: `over:${desc}` })
        sessionStates++
        if (step % 43 === 0) compareHelpers(engine, ref, { ...baseCtx, seed, step })
        continue
      }
      if (restarts >= maxRestarts) break
      restarts++
      stats.restarts++
      const newSeed = mix32(seed ^ (restarts * 0x9e3779b9))
      engine.newGame(newSeed)
      ref.newGame(newSeed)
      compareAll(engine, ref, { ...baseCtx, step, op: 'restart:newGame', newSeed })
      sessionStates++
      const newStart = startFor(newSeed, cfg)
      engine.startAt(newStart, 0)
      ref.startAt(newStart, 0)
      compareAll(engine, ref, { ...baseCtx, step, op: 'restart:startAt', newSeed, newStart })
      sessionStates++
      overNoops = 0
      continue
    }

    stats.ops++
    const kind = pickKind(rnd)
    const desc = applyOp(engine, ref, rnd, kind)
    compareAll(engine, ref, { ...baseCtx, step, op: desc })
    sessionStates++
    if (step % 43 === 0) compareHelpers(engine, ref, { ...baseCtx, seed, step })
  }
}

/* ------------------------------ 边角场景 ------------------------------ */

function runEdgeScenario(cfg, seed, mode) {
  const engine = new EngineGame(engineOptsOf(cfg))
  const ref = new RefGame(refOptsOf(cfg))
  const baseCtx = { cfg: cfg.name, seed, edge: mode }
  engine.newGame(seed)
  ref.newGame(seed)
  compareAll(engine, ref, { ...baseCtx, step: 'newGame' })
  stats.edgeComparisons++

  if (mode === 'preFlag') {
    // 首点前插旗：旗会带进新棋盘（game.zig genBoard 不清 flag）
    const cells = [seed % engine.n, (seed * 7 + 3) % engine.n, (seed * 13 + 11) % engine.n]
    for (const cell of cells) {
      const t = 1 + (cell % 4)
      engine.setFlag(cell, t)
      ref.setFlag(cell, t)
    }
    compareAll(engine, ref, { ...baseCtx, step: 'preFlag' })
    stats.edgeComparisons++
    const startCell = startFor(seed, cfg)
    engine.startAt(startCell, 0)
    ref.startAt(startCell, 0)
    compareAll(engine, ref, { ...baseCtx, step: 'startAfterPreFlag', startCell })
    stats.edgeComparisons++
  } else if (mode === 'restartStartAt') {
    // 同一 Game 上二次 startAt：setSeed + genBoard，但 flag 不清（Zig 行为）
    const firstStart = startFor(seed, cfg)
    engine.startAt(firstStart, 0)
    ref.startAt(firstStart, 0)
    compareAll(engine, ref, { ...baseCtx, step: 'startAt#1', firstStart })
    stats.edgeComparisons++
    const cells = [seed % engine.n, (seed * 5 + 7) % engine.n]
    for (const cell of cells) {
      engine.setFlag(cell, 1 + (cell % 4))
      ref.setFlag(cell, 1 + (cell % 4))
    }
    compareAll(engine, ref, { ...baseCtx, step: 'flagAfterStart' })
    stats.edgeComparisons++
    const secondStart = startFor(mix32(seed), cfg)
    engine.startAt(secondStart, 0)
    ref.startAt(secondStart, 0)
    compareAll(engine, ref, { ...baseCtx, step: 'startAt#2', secondStart })
    stats.edgeComparisons++
  } else if (mode === 'corners') {
    for (const startCell of [0, cfg.w - 1, cfg.w * cfg.h - 1, Math.floor(cfg.h / 2) * cfg.w]) {
      engine.newGame(seed)
      ref.newGame(seed)
      engine.startAt(startCell, 0)
      ref.startAt(startCell, 0)
      compareAll(engine, ref, { ...baseCtx, step: 'cornerStart', startCell })
      stats.edgeComparisons++
    }
  }
}

/* ------------------------------ RNG 差分 ------------------------------ */

function runRngDiff() {
  const seeds = [0, 1, 2, 12345, 0xffffffff]
  const belowNs = [1, 2, 3, 4, 5, 8, 81, 1200]
  for (const seed of seeds) {
    const e = new EngineRng(seed)
    const r = new RefRng(seed)
    for (let k = 0; k < 257; k++) {
      stats.fieldValues++
      stats.rngValues++
      const ev = e.next()
      const rv = r.next()
      if (ev !== rv) {
        failures.push({
          cfg: 'rng',
          ctx: { seed, draw: k },
          diffs: [`next(): 参照=${rv} engine=${ev}`],
        })
        return
      }
    }
    const e2 = new EngineRng(seed)
    const r2 = new RefRng(seed)
    for (const n of belowNs) {
      for (let k = 0; k < 64; k++) {
        stats.fieldValues++
        stats.rngValues++
        const ev = e2.below(n)
        const rv = r2.below(n)
        if (ev !== rv) {
          failures.push({
            cfg: 'rng',
            ctx: { seed, below: n, draw: k },
            diffs: [`below(${n}): 参照=${rv} engine=${ev}`],
          })
          return
        }
      }
    }
  }
}

/* ======================================================================
 * 第四部分：配置与主流程
 * ====================================================================*/

const CONFIGS = [
  // 三档难度 × 多种子
  { name: '初级 9×9/10', w: 9, h: 9, mines: 10, seeds: 30, steps: 700 },
  { name: '中级 16×16/40', w: 16, h: 16, mines: 40, seeds: 20, steps: 650 },
  { name: '高级 30×16/99', w: 30, h: 16, mines: 99, seeds: 14, steps: 600 },
  // 额外局面
  { name: '12×12/24 随机类型', w: 12, h: 12, mines: 24, seeds: 8, steps: 500 },
  { name: '精确配比 12×12（7/7/7/7）', w: 12, h: 12, mines: 28, typeCount: [0, 7, 7, 7, 7], seeds: 5, steps: 400 },
  { name: '纯虚配比 12×12（+i/−i 各 4）', w: 12, h: 12, mines: 8, typeCount: [0, 0, 0, 4, 4], seeds: 4, steps: 400 },
  { name: '超大连片 40×30/1', w: 40, h: 30, mines: 1, seeds: 4, steps: 300 },
  { name: '大盘 40×30/60', w: 40, h: 30, mines: 60, seeds: 3, steps: 300 },
  { name: '饱和 9×9/72', w: 9, h: 9, mines: 72, seeds: 3, steps: 300 },
]

function seedListFor(cfg, index) {
  const out = []
  for (let i = 0; i < cfg.seeds; i++) out.push(1000 + i * 7919 + index * 104729 + ((i * 2654435761) >>> 0) % 9973)
  return out
}

console.log('复扫雷 Complexweeper · 独立参照实现 × engine.js 状态差分')
console.log(`参照实现：${ENGINE_INFO.ref}`)
console.log(`被测对象：${ENGINE_INFO.enginePath}`)
console.log('')

runRngDiff()
if (failures.length === 0) console.log('-- RNG（mulberry32）差分：一致')

CONFIGS.forEach((cfg, index) => {
  const statesBefore = stats.states
  const opsBefore = stats.ops
  const seedList = seedListFor(cfg, index)
  for (const seed of seedList) {
    try {
      runSession(cfg, seed)
    } catch (err) {
      if (err instanceof Divergence) recordDivergence(err, cfg.name)
      else throw err
    }
  }
  const states = stats.states - statesBefore
  const ops = stats.ops - opsBefore
  console.log(
    `-- ${cfg.name}: 种子 ${seedList.length}，状态比较 ${states} 次，玩法操作 ${ops} 次` +
      (cfg.typeCount ? `，typeCount=${cfg.typeCount.slice(1).join('/')}` : ''),
  )
})

// 边角场景：首点前插旗 / 二次 startAt / 四角开局（每档难度都跑）
console.log('-- 边角场景（首点前插旗 / 二次 startAt / 四角开局）')
for (const cfg of CONFIGS.slice(0, 3)) {
  for (const mode of ['preFlag', 'restartStartAt', 'corners']) {
    for (let seed = 1; seed <= 3; seed++) {
      try {
        runEdgeScenario(cfg, mix32(seed * 1000003 + cfg.w * 31 + cfg.h), mode)
      } catch (err) {
        if (err instanceof Divergence) recordDivergence(err, `${cfg.name}:${mode}`)
        else throw err
      }
    }
  }
}

/* ------------------------------ 汇总 ------------------------------ */
const totalFieldValues = stats.fieldValues + stats.helperChecks
console.log('')
console.log(`状态快照比较：${stats.states} 次（逐字段：${stats.fieldValues} 项；辅助函数：${stats.helperChecks} 项）`)
console.log(`玩法操作：${stats.ops} 次（reveal ${opCounts.reveal} / cycleFlag ${opCounts.cycleFlag} / tryExpand ${opCounts.tryExpand} / chord ${opCounts.chord} / setFlag ${opCounts.setFlag} / clearFlag ${opCounts.clearFlag}）`)
console.log(`对局 ${stats.sessions} 局，重开 ${stats.restarts} 次，结束后继续操作 ${stats.overNoops} 次，边角场景比较 ${stats.edgeComparisons} 次`)
console.log(`RNG 输出比较：${stats.rngValues} 项`)

if (failures.length > 0) {
  console.log('')
  console.log(`发现 ${failures.length} 处差异：`)
  for (const f of failures.slice(0, MAX_REPORTED_DIFFS)) {
    console.log(`  · [${f.cfg}] ${JSON.stringify(f.ctx)}`)
    for (const d of f.diffs) console.log(`      ${d}`)
  }
  process.exitCode = 1
} else {
  console.log('')
  console.log(`差异 0（共比较 ${stats.states} 个状态快照 / ${totalFieldValues} 项字段值）`)
  console.log('全部一致')
  process.exitCode = 0
}
