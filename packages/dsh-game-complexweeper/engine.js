/* =========================================================================
 * 复扫雷 Complexweeper —— 规则引擎（纯逻辑，不碰 DOM）
 * -------------------------------------------------------------------------
 * 1:1 移植自 Zig 参考实现（GPL-3.0）：
 *   参考源码：games_ai\complexweeper\正式版\src\game.zig（514 行，权威参考）
 *   上游仓库：github.com/Yueqing-Chen/complexweeper-A-minesweeper-game
 *   作者：青月晓（Yueqing Chen）
 * 本文件与整个包同样以 GPL-3.0 发布；见包内 LICENSE 与 README「来源与许可」。
 *
 * 规则要点（与 game.zig 逐条对应）：
 *   - 四种雷 +1 / −1 / +i / −i；mine[] 存 1..4，对应 TYPES[0..3]；
 *   - 线索 = 邻域 8 格所有雷之和的模长（源码存平方值）：
 *       a = #(+1) − #(−1)（实部），b = #(+i) − #(−i)（虚部）
 *       圆复数模式 clue = a² + b²（0..64，共 24 种可达值，见 ACHIEVABLE）
 *       闵可夫斯基模式 clue = a² − b²（v1 不启用，引擎保留同源实现）
 *   - 空白格 = 邻域一颗雷都没有 → 只有它会连片扩散；
 *     显示 0 的格子 = 邻域全是抵消对（+1 配 −1 / +i 配 −i）→ 不扩散；
 *   - 首点格 + 它 8 邻域全部安全，布雷在第一次翻开（startAt）时才做；
 *   - 展开（chord）判据：邻域旗数 = 真实雷数，且实部/虚部旗数比例等于真值比例
 *     或其倒数（不要求 ± 符号正确），见 matchComboTruth()；
 *   - 胜利 = 翻开所有非雷格（不是插对全部旗）。
 *
 * 与 Zig 的差异（全部是 JS 侧安全/序列化补充，不改变合法输入下的规则语义）：
 *   - nbrs() 返回数组（Zig 写调用方缓冲区），顺序与 Zig 的 dr/dc 双重循环一致；
 *   - 对外索引参数做边界检查，越界一律视为非法操作、不改变状态；
 *   - 额外提供 snapshot() / Game.fromSnapshot() 供 localStorage 存档往返，
 *     fromSnapshot() 做结构 + 一致性校验（坏档返回 null，由 UI 开新局）；
 *   - 额外提供 recountFlags()（只供存档恢复后重算计数，不参与玩法）。
 *
 * 分发方式：浏览器侧唯一入口是 client.js，包内相对路径同步 require 不可用，
 * 所以本文件会由 dev 脚本要求 **逐字节** 内联进 client.js（锚点定义在
 * dev/verify-inline.mjs）。本文件自己挂到 window/globalThis 的名字是 `CS`，
 * client.js 取走后会还原，不污染全局。
 *
 * 自测：node dev/selftest.mjs
 * =======================================================================*/
(function (root) {
  'use strict'

  /* ---------------------------- 常量（同 game.zig 顶部） ---------------------------- */
  const MAX_W = 40
  const MAX_H = 30
  const MAX_CELLS = MAX_W * MAX_H
  const MAX_MINES = 999

  /* 四种雷：(实部, 虚部)。mine[] 存 1..4，索引 = 值 − 1。 */
  const TYPES = [
    [1, 0],   // 1: +1
    [-1, 0],  // 2: −1
    [0, 1],   // 3: +i（闵可夫斯基模式里是 +j）
    [0, -1],  // 4: −i（闵可夫斯基模式里是 −j）
  ]

  const MODE_COMPLEX = 0 // i² = −1（v1 只做这个）
  const MODE_HYPER = 1   // j² = +1（v1 跳过）

  /* 圆复数模式 24 个可达显示值（已平方；显示时开根号） */
  const ACHIEVABLE = [
    0, 1, 2, 4, 5, 8, 9, 10, 13, 16, 17, 18, 20,
    25, 26, 29, 32, 34, 36, 37, 40, 49, 50, 64,
  ]

  /* 三档难度（同 PRESETS；id 用于存档与界面选择） */
  const PRESETS = [
    { id: 1, w: 9, h: 9, mines: 10, label: '初级 9×9 · 10 雷' },
    { id: 2, w: 16, h: 16, mines: 40, label: '中级 16×16 · 40 雷' },
    { id: 3, w: 30, h: 16, mines: 99, label: '高级 30×16 · 99 雷' },
  ]

  /* 操作反馈（同 game.zig 的 Msg） */
  const MSG = { NONE: 0, STARTED: 1, JUDGE_FAIL: 2, EXPAND_OK: 3, WIN: 4, LOSE: 5 }
  const MSG_NAMES = ['none', 'started', 'judge_fail', 'expand_ok', 'win', 'lose']

  const ENGINE_INFO = {
    engine: 'complexweeper',
    port: 'dsh-game-complexweeper v1',
    reference: 'complexweeper/正式版/src/game.zig',
    upstream: 'github.com/Yueqing-Chen/complexweeper-A-minesweeper-game',
    license: 'GPL-3.0-only',
    modes: 'complex (hyper ported but not wired into v1 UI)',
  }

  /* ============================== 小工具 ============================== */

  /** 无符号 32 位取模（对应 Zig 的 +% / *%）。 */
  function u32(v) {
    return v >>> 0
  }

  function isInt(v, lo, hi) {
    return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
  }

  function isIntArray(a, len, lo, hi) {
    if (!Array.isArray(a) || a.length !== len) return false
    for (let i = 0; i < len; i++) if (!isInt(a[i], lo, hi)) return false
    return true
  }

  /* ============================== 随机数 ============================== */

  /**
   * mulberry32（同 game.zig 的 Rng）。
   * 种子 0 会被改成 1；next() 返回 [0,1) 的 f64。
   */
  class Rng {
    constructor(seed) {
      this.a = seed === 0 ? 1 : (seed >>> 0)
    }

    next() {
      this.a = (this.a + 0x6D2B79F5) >>> 0
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

  /* ============================== 游戏状态 ============================== */

  class Game {
    constructor(opts) {
      const o = opts || {}
      const w = Number.isInteger(o.w) ? o.w : 9
      const h = Number.isInteger(o.h) ? o.h : 9
      this.w = w
      this.h = h
      this.n = w * h
      this.mode = o.mode === MODE_HYPER ? MODE_HYPER : MODE_COMPLEX
      this.judgeLoose = o.judgeLoose === true

      /* 与 game.zig 一样按 MAX_CELLS 固定分配，n 之前的有效 */
      this.mine = new Uint8Array(MAX_CELLS)
      this.clue = new Int16Array(MAX_CELLS)
      this.clue.fill(-1)
      this.open = new Uint8Array(MAX_CELLS)
      this.flag = new Uint8Array(MAX_CELLS)

      this.seed = 1
      this.rng = new Rng(1)
      this.mines = Number.isInteger(o.mines) ? o.mines : 10

      this.typeTotal = new Uint16Array(5) // 下标 1..4；开局公开
      this.flagsOf = new Uint16Array(5)   // 下标 1..4
      this.typeCount = new Uint16Array(5) // 自定义配比；全 0 = 随机撒

      if (o.typeCount) {
        for (let t = 1; t <= 4; t++) {
          const v = o.typeCount[t]
          this.typeCount[t] = Number.isInteger(v) && v > 0 ? v : 0
        }
      }

      this.started = false
      this.over = false
      this.win = false
      this.boom = -1
      this.startCell = -1
      this.elapsedMs = 0
      this.t0 = 0
      this.moves = 0
      this.msg = MSG.NONE
      this.msgArg = 0
    }

    cellCount() {
      return this.n
    }

    inb(r, c) {
      return r >= 0 && c >= 0 && r < this.h && c < this.w
    }

    /** 8 邻域索引数组（按行优先 dr/dc 顺序，与 Zig nbrs() 一致）。 */
    nbrs(cell) {
      const w = this.w
      const h = this.h
      const r = Math.floor(cell / w)
      const c = cell % w
      const out = []
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue
          const rr = r + dr
          const cc = c + dc
          if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue
          out.push(rr * w + cc)
        }
      }
      return out
    }

    nbrMineCount(cell) {
      let n = 0
      for (const j of this.nbrs(cell)) if (this.mine[j] !== 0) n++
      return n
    }

    /** 空白格：邻域无雷。只有它会连片扩散。 */
    isBlank(cell) {
      return this.mine[cell] === 0 && this.nbrMineCount(cell) === 0
    }

    flagsTotal() {
      let s = 0
      for (let t = 1; t <= 4; t++) s += this.flagsOf[t]
      return s
    }

    /** 该类雷还剩几颗没标（可为负，因为旗不限量）。 */
    unmarked(t) {
      if (t < 1 || t > 4) return 0
      return this.typeTotal[t] - this.flagsOf[t]
    }

    setMsg(m) {
      this.msg = m
      this.msgArg = 0
    }

    setSeed(s) {
      const v = u32(s)
      this.seed = v === 0 ? 1 : v
      this.rng = new Rng(this.seed)
    }

    /** 新开一局（棋盘等第一次点击 startAt 再生成）。 */
    newGame(seed) {
      this.n = this.w * this.h
      const n = this.n
      for (let i = 0; i < n; i++) {
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
      this.typeTotal = new Uint16Array(5)
      this.flagsOf = new Uint16Array(5)
      this.setSeed(seed)
      this.setMsg(MSG.NONE)
    }

    /**
     * 布雷 + 算线索 + 从开局格连片（同 genBoard）。
     * 首点格及其 8 邻域不布雷。startCell 必须是合法索引。
     */
    genBoard(startCell) {
      const n = this.n
      for (let i = 0; i < n; i++) {
        this.mine[i] = 0
        this.clue[i] = -1
        this.open[i] = 0
      }

      const isSafe = new Uint8Array(n)
      isSafe[startCell] = 1
      for (const j of this.nbrs(startCell)) isSafe[j] = 1

      const pool = []
      for (let i = 0; i < n; i++) if (!isSafe[i]) pool.push(i)

      /* 洗位置（Fisher–Yates，同 Zig） */
      for (let i = pool.length - 1; i > 0; i--) {
        const j = this.rng.below(i + 1)
        const t = pool[i]
        pool[i] = pool[j]
        pool[j] = t
      }

      let want = 0
      for (let t = 1; t <= 4; t++) want += this.typeCount[t]
      const count = Math.min(want > 0 ? want : this.mines, pool.length)

      if (want > 0) {
        /* 精确配比：先铺类型序列，再洗一遍，再按 count 截断 */
        const list = []
        for (let t = 1; t <= 4; t++) {
          for (let k = 0; k < this.typeCount[t]; k++) list.push(t)
        }
        let ln = list.length
        if (ln > count) ln = count
        for (let i = ln - 1; i > 0; i--) {
          const j = this.rng.below(i + 1)
          const t = list[i]
          list[i] = list[j]
          list[j] = t
        }
        for (let k = 0; k < ln; k++) this.mine[pool[k]] = list[k]
      } else {
        for (let k = 0; k < count; k++) {
          this.mine[pool[k]] = 1 + this.rng.below(4)
        }
      }

      this.mines = count
      this.computeClues()
      this.countTypes()
      this.cascadeOpen([startCell])
    }

    /** 按 species 统计邻域 (a,b) 后求模长平方。 */
    computeClues() {
      const n = this.n
      for (let i = 0; i < n; i++) {
        if (this.mine[i] !== 0) {
          this.clue[i] = -1
          continue
        }
        let a = 0
        let b = 0
        for (const j of this.nbrs(i)) {
          const m = this.mine[j]
          if (m === 0) continue // 跳过空格，等价于 Zig 的越界保护
          const t = TYPES[m - 1]
          a += t[0]
          b += t[1]
        }
        this.clue[i] = this.mode === MODE_HYPER ? a * a - b * b : a * a + b * b
      }
    }

    /**
     * 邻域按类型统计出的 (a, b)：a = 正实 − 负实，b = 正虚 − 负虚。
     * useFlag 为真时统计旗帜，否则统计真雷（同 sumsOf）。
     * 任务书里也叫 sumOf；本引擎只导出 sumsOf（client/测试统一用它）。
     */
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
      let n = 0
      for (const j of this.nbrs(cell)) if (this.flag[j] !== 0) n++
      return n
    }

    countTypes() {
      this.typeTotal = new Uint16Array(5)
      for (let i = 0; i < this.n; i++) {
        if (this.mine[i] !== 0) this.typeTotal[this.mine[i]] += 1
      }
    }

    /** 只供存档恢复：按 flag[] 重算 flagsOf[]。 */
    recountFlags() {
      this.flagsOf = new Uint16Array(5)
      for (let i = 0; i < this.n; i++) {
        if (this.flag[i] !== 0) this.flagsOf[this.flag[i]] += 1
      }
    }

    /**
     * 连片翻开：只在空白格上扩散；插旗格绕开。返回新翻开的格数。
     * seeds 里的格若已翻开 / 是雷 / 有旗，跳过（同 cascadeOpen）。
     */
    cascadeOpen(seeds) {
      const n = this.n
      const stack = []
      const queued = new Uint8Array(n)
      for (const s of seeds) {
        if (s < 0 || s >= n) continue
        if (!queued[s]) {
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
            if (!queued[j] && this.open[j] === 0 && this.mine[j] === 0 && this.flag[j] === 0) {
              queued[j] = 1
              stack.push(j)
            }
          }
        }
      }
      return opened
    }

    /** 首次翻开某格：此刻才布雷（同 startAt）。 */
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

    /** 插 / 改 / 清旗（不限量）。t = 0 表示清旗。 */
    setFlag(cell, t) {
      if (cell < 0 || cell >= this.n) return false
      if (!Number.isInteger(t) || t < 0 || t > 4) return false
      const old = this.flag[cell]
      if (old === t) return true
      if (old !== 0) this.flagsOf[old] -= 1
      this.flag[cell] = t
      if (t !== 0) this.flagsOf[t] += 1
      return true
    }

    /** 右键循环：空 → +1 → −1 → +i → −i → 空（同 cycleFlag）。 */
    cycleFlag(cell) {
      if (cell < 0 || cell >= this.n) return false
      if (this.over || this.open[cell] !== 0) return false
      const next = (this.flag[cell] + 1) % 5
      this.setFlag(cell, next)
      this.moves += 1
      return true
    }

    /** 翻开一格；插了旗的翻不开（同 reveal）。 */
    reveal(cell, nowMs) {
      if (cell < 0 || cell >= this.n) return
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

    /**
     * 展开判据（同 matchComboTruth）：
     *   1) 邻域旗数必须等于邻域真实雷数；
     *   2) 圆复数模式：显示值 a²+b² 看不出整体取负、也看不出实虚交换，
     *      所以允许实/虚旗数比例等于真值比例或其倒数（符号不要求）；
     *   3) 闵可夫斯基模式（v1 不用）：要求 |a|、|b| 分别相符；
     *      judgeLoose 时只要求 a²−b² 相同。
     */
    matchComboTruth(cell) {
      if (this.nbrMineCount(cell) !== this.nbrFlagCount(cell)) return false

      if (this.mode === MODE_HYPER) {
        const t = this.sumsOf(cell, false)
        const f = this.sumsOf(cell, true)
        if (this.judgeLoose) {
          return t[0] * t[0] - t[1] * t[1] === f[0] * f[0] - f[1] * f[1]
        }
        return Math.abs(f[0]) === Math.abs(t[0]) && Math.abs(f[1]) === Math.abs(t[1])
      }

      const truth = [0, 0, 0, 0]
      const got = [0, 0, 0, 0]
      for (const j of this.nbrs(cell)) {
        if (this.mine[j] !== 0) truth[this.mine[j] - 1] += 1
        if (this.flag[j] !== 0) got[this.flag[j] - 1] += 1
      }
      const P = truth[0] + truth[1]   // 真实实部雷数
      const V = truth[2] + truth[3]   // 真实虚部雷数
      const gp = got[0] + got[1]      // 实部旗数
      const gv = got[2] + got[3]      // 虚部旗数
      return (
        gp + gv === P + V &&
        ((gp === P && gv === V) || (gp === V && gv === P))
      )
    }

    /**
     * 展开：判据过了就翻开邻域所有未插旗未翻开的格；其中有雷 → 输。
     * （同 tryExpand。注意 Zig 里 msg_arg 被 setMsg 清零，这里保持同样顺序，
     *  所以 msgArg 恒为 0 —— 忠实移植，不做"修补"。）
     */
    tryExpand(cell) {
      if (cell < 0 || cell >= this.n) return
      if (this.over || this.open[cell] === 0 || this.mine[cell] !== 0) return

      const uns = []
      for (const j of this.nbrs(cell)) {
        if (this.open[j] === 0 && this.flag[j] === 0) uns.push(j)
      }
      if (uns.length === 0) return

      if (!this.matchComboTruth(cell)) {
        this.setMsg(MSG.JUDGE_FAIL)
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
      this.moves += 1
      this.msgArg = uns.length
      this.setMsg(MSG.EXPAND_OK)
      this.checkWin()
    }

    checkWin() {
      for (let i = 0; i < this.n; i++) {
        if (this.mine[i] === 0 && this.open[i] === 0) return
      }
      this.over = true
      this.win = true
      this.setMsg(MSG.WIN)
    }

    lose(cell) {
      this.over = true
      this.win = false
      this.boom = cell
      this.setMsg(MSG.LOSE)
    }

    openedCount() {
      let k = 0
      for (let i = 0; i < this.n; i++) if (this.open[i] !== 0) k++
      return k
    }

    safeCount() {
      let k = 0
      for (let i = 0; i < this.n; i++) if (this.mine[i] === 0) k++
      return k
    }

    /** 标对的旗数（同 correctFlags：旗类型与真雷类型一致才算对）。 */
    correctFlags() {
      let k = 0
      for (let i = 0; i < this.n; i++) {
        if (this.mine[i] !== 0 && this.flag[i] === this.mine[i]) k++
      }
      return k
    }

    typeSum() {
      let s = 0
      for (let t = 1; t <= 4; t++) s += this.typeTotal[t]
      return s
    }

    /* ---------------------- 存档扩展（game.zig 没有） ---------------------- */

    /** 序列化成纯 JSON 对象（数组截到 n；不含 t0 这类墙钟时间）。 */
    snapshot() {
      const n = this.n
      return {
        w: this.w,
        h: this.h,
        mode: this.mode,
        judgeLoose: this.judgeLoose,
        seed: this.seed,
        rngA: this.rng.a,
        mines: this.mines,
        typeCount: Array.from(this.typeCount),
        mine: Array.from(this.mine.subarray(0, n)),
        clue: Array.from(this.clue.subarray(0, n)),
        open: Array.from(this.open.subarray(0, n)),
        flag: Array.from(this.flag.subarray(0, n)),
        started: this.started,
        over: this.over,
        win: this.win,
        boom: this.boom,
        startCell: this.startCell,
        elapsedMs: this.elapsedMs,
        moves: this.moves,
        typeTotal: Array.from(this.typeTotal),
        flagsOf: Array.from(this.flagsOf),
        msg: this.msg,
        msgArg: this.msgArg,
      }
    }

    /**
     * 从 snapshot() 反序列化；结构/一致性不合法一律返回 null（不抛错）。
     * 合法状态下重算 typeTotal / flagsOf（不信任存档里的派生计数）。
     */
    static fromSnapshot(snap) {
      if (!snap || typeof snap !== 'object') return null
      if (!isInt(snap.w, 1, MAX_W) || !isInt(snap.h, 1, MAX_H)) return null
      const n = snap.w * snap.h
      if (n <= 0 || n > MAX_CELLS) return null

      if (snap.mode !== MODE_COMPLEX && snap.mode !== MODE_HYPER) return null
      if (typeof snap.judgeLoose !== 'boolean') return null
      if (!isInt(snap.mines, 0, MAX_MINES)) return null
      if (!isIntArray(snap.typeCount, 5, 0, MAX_MINES)) return null
      let tc = 0
      for (let t = 1; t <= 4; t++) tc += snap.typeCount[t]
      if (tc > MAX_MINES) return null
      if (!isInt(snap.seed, 1, 0xFFFFFFFF)) return null
      if (!isInt(snap.rngA, 0, 0xFFFFFFFF)) return null
      if (!isIntArray(snap.mine, n, 0, 4)) return null
      if (!isIntArray(snap.open, n, 0, 1)) return null
      if (!isIntArray(snap.flag, n, 0, 4)) return null
      if (!Array.isArray(snap.clue) || snap.clue.length !== n) return null
      if (typeof snap.started !== 'boolean') return null
      if (typeof snap.over !== 'boolean') return null
      if (typeof snap.win !== 'boolean') return null
      if (!isInt(snap.boom, -1, n - 1)) return null
      if (!isInt(snap.startCell, -1, n - 1)) return null
      if (!isInt(snap.elapsedMs, 0, Number.MAX_SAFE_INTEGER)) return null
      if (!isInt(snap.moves, 0, Number.MAX_SAFE_INTEGER)) return null
      if (!isInt(snap.msg, 0, MSG.LOSE)) return null
      if (!isInt(snap.msgArg, 0, 0xFFFF)) return null

      const clueLo = snap.mode === MODE_HYPER ? -64 : 0
      for (let i = 0; i < n; i++) {
        /* 雷格 clue = −1；非雷格下限：圆复数 0，闵可夫斯基 −64（a²−b² 可为负） */
        if (!isInt(snap.clue[i], snap.mode === MODE_HYPER ? -64 : -1, 64)) return null
        if (snap.mine[i] !== 0) {
          if (snap.clue[i] !== -1) return null
        } else if (snap.started && snap.clue[i] < clueLo) {
          /* 已开局时非雷格必有线索；未开局时 clue 全是 -1（下面单独校验） */
          return null
        }
        if (snap.open[i] !== 0 && snap.flag[i] !== 0) return null
      }

      /* 开局前：没有棋盘，且不可能已分胜负 */
      let mineCount = 0
      let openedMine = -1
      let openMineCount = 0
      let closedSafe = 0
      for (let i = 0; i < n; i++) {
        if (snap.mine[i] !== 0) mineCount++
        if (snap.mine[i] !== 0 && snap.open[i] !== 0) {
          openMineCount++
          openedMine = i
        }
        if (snap.mine[i] === 0 && snap.open[i] === 0) closedSafe++
      }

      if (snap.started) {
        if (snap.startCell < 0 || snap.open[snap.startCell] !== 1) return null
        if (mineCount !== snap.mines) return null
      } else {
        if (snap.startCell !== -1 || snap.boom !== -1) return null
        if (snap.over || snap.win) return null
        for (let i = 0; i < n; i++) {
          if (snap.mine[i] !== 0 || snap.open[i] !== 0 || snap.clue[i] !== -1) return null
        }
        /* 注意：与 game.zig 一致，首次点击前允许已插旗（旗会带进新棋盘） */
      }

      if (snap.win) {
        if (!snap.over || snap.boom !== -1) return null
        if (openMineCount !== 0 || closedSafe !== 0) return null
      } else if (snap.over) {
        if (snap.boom < 0 || snap.mine[snap.boom] === 0) return null
        if (openedMine !== snap.boom || openMineCount !== 1) return null
      } else {
        if (snap.boom !== -1 || openMineCount !== 0) return null
      }

      let g
      try {
        g = new Game({
          w: snap.w,
          h: snap.h,
          mode: snap.mode,
          judgeLoose: snap.judgeLoose,
          mines: snap.mines,
          typeCount: snap.typeCount,
        })
      } catch (e) {
        return null
      }
      for (let i = 0; i < n; i++) {
        g.mine[i] = snap.mine[i]
        g.clue[i] = snap.clue[i]
        g.open[i] = snap.open[i]
        g.flag[i] = snap.flag[i]
      }
      g.seed = snap.seed
      g.rng = new Rng(snap.seed)
      g.rng.a = snap.rngA >>> 0
      g.started = snap.started
      g.over = snap.over
      g.win = snap.win
      g.boom = snap.boom
      g.startCell = snap.startCell
      g.elapsedMs = snap.elapsedMs
      g.t0 = 0
      g.moves = snap.moves
      g.msg = snap.msg
      g.msgArg = snap.msgArg
      g.countTypes()
      g.recountFlags()
      return g
    }
  }

  /* ============================== 导出 ============================== */

  const API = {
    MAX_W,
    MAX_H,
    MAX_CELLS,
    MAX_MINES,
    TYPES,
    ACHIEVABLE,
    PRESETS,
    MSG,
    MSG_NAMES,
    MODE: { COMPLEX: MODE_COMPLEX, HYPER: MODE_HYPER },
    MODE_COMPLEX,
    MODE_HYPER,
    ENGINE_INFO,
    Rng,
    Game,
    splitEvenly,
  }

  /** 把总雷数尽量均分给四种雷（同 splitEvenly）。 */
  function splitEvenly(total) {
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

  root.CS = API
  if (typeof module !== 'undefined' && module.exports) module.exports = API
})(typeof window !== 'undefined' ? window : globalThis)
