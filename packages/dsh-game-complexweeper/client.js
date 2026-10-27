/**
 * @local/dsh-game-complexweeper — browser half.
 *
 * Registers Complexweeper (复扫雷) into the host's `game.stage` chain slot
 * (contract v1):
 *   - `select({ gameId })` returns the frozen `MATCHED` object only when the
 *     host selected `complexweeper`, otherwise `null`;
 *   - the component only relies on the `matched` prop, never on host internals;
 *   - pure mouse: no keyboard listeners are registered anywhere;
 *   - React comes from the loader module table (`require('react')`), no
 *     third-party libraries, no network.
 *
 * Why everything lives in this one file: `client.js` is the only browser entry
 * the module loader serves. The loader's `require` resolves entries from the
 * module table (react, ...) and cannot load package-relative modules
 * synchronously, so the rules engine (`engine.js`) is copied **verbatim** into
 * this file between two anchors (see `dev/engine-api.md` §5 and
 * `dev/verify-inline.mjs`). The engine briefly publishes itself as `window.CS`;
 * this file takes it over and restores the previous global value so nothing is
 * polluted. Only when `window.__DSH_GAME_COMPLEXSWEEPER_TEST__ === true` are
 * dev probes installed on `window.__DSH_GAME_COMPLEXSWEEPER__`.
 *
 * Rules ported 1:1 from the GPL-3.0 Zig reference implementation
 * (`github.com/Yueqing-Chen/complexweeper-A-minesweeper-game`); the whole
 * package is GPL-3.0-only. See README "来源与许可" and LICENSE.
 *
 * Save key: localStorage['dsh.game.complexweeper.v1'] (schemaVersion: 1).
 * Other games' save keys are never read or written here.
 */
;(function () {
  'use strict'

  const GAME_ID = 'complexweeper'
  const STORE_KEY = 'dsh.game.' + GAME_ID + '.v1'
  const SCHEMA_VERSION = 1
  const MIN_WIDTH = 320
  const MIN_HEIGHT = 240
  const MAX_ELAPSED_MS = 7 * 24 * 60 * 60 * 1000
  /* 「判定不通过」状态自动清除时间（格子闪烁保留；避免红色提示长期残留） */
  const JUDGE_FAIL_CLEAR_MS = 1800
  /* 冻结版本指纹：Lead 冻结的 engine.js（内联块逐字节一致，dev/verify-inline.mjs 校验） */
  const CLIENT_REV = 'complexweeper-client v1.0.0 (2026-10-18)'
  const ENGINE_SHA256 = 'A3CAE327CD7B4FDC63C48E8BD5C8672656B2B0DD7EB96B91EB0DC29B43972069'

  /* Stable `matched` payload: the chain renderer compares references. */
  const MATCHED = Object.freeze({})

  /* ======================================================================
   * 内联引擎：本节由 engine.js 原样复制（逐字节），锚点供
   * dev/verify-inline.mjs 抽取比对。执行后通过 globalRoot.CS 取出 API，
   * 并还原调用前的 globalRoot.CS（原本没有就删除），不污染全局。
   * ==================================================================== */
  const E = (function inlineEngine(globalRoot) {
    const previousCS = globalRoot ? globalRoot.CS : undefined;
/* >>> DSH INLINE ENGINE BEGIN (verbatim copy of ./engine.js) >>> */
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
/* <<< DSH INLINE ENGINE END <<< */
    const api = globalRoot ? globalRoot.CS : undefined
    if (globalRoot) {
      try {
        if (previousCS === undefined) delete globalRoot.CS
        else globalRoot.CS = previousCS
      } catch (error) {
        // window.CS 被锁定（极罕见）：保留引擎引用，不打断游戏启动。
      }
    }
    if (!api) throw new Error('complexweeper: inline engine did not initialise')
    return api
  })(typeof window !== 'undefined' ? window : globalThis)

  const PRESETS = E.PRESETS
  const MSG = E.MSG
  const Game = E.Game

  const DIFFICULTY = [
    { id: 1, short: '初级', label: '初级 9×9 · 10 雷' },
    { id: 2, short: '中级', label: '中级 16×16 · 40 雷' },
    { id: 3, short: '高级', label: '高级 30×16 · 99 雷' },
  ]
  const DIFFICULTY_IDS = [1, 2, 3]

  /* 四类旗：+1 红、−1 蓝、+i 绿、−i 紫（深色底上使用高亮色）。 */
  const FLAG_META = [
    null,
    { type: 1, label: '+1', glyph: '+1', name: '正实雷', color: '#ff5252' },
    { type: 2, label: '−1', glyph: '−1', name: '负实雷', color: '#42a5f5' },
    { type: 3, label: '+i', glyph: '+i', name: '正虚雷', color: '#66bb6a' },
    { type: 4, label: '−i', glyph: '−i', name: '负虚雷', color: '#ba68c8' },
  ]

  /* 24 种线索显示值：整数 0..8 直接显示；其余按根式化简（平方值 → 文案）。 */
  const CLUE_TEXT = {
    0: '0', 1: '1', 2: '√2', 4: '2', 5: '√5', 8: '2√2', 9: '3',
    10: '√10', 13: '√13', 16: '4', 17: '√17', 18: '3√2', 20: '2√5',
    25: '5', 26: '√26', 29: '√29', 32: '4√2', 34: '√34', 36: '6',
    37: '√37', 40: '2√10', 49: '7', 50: '5√2', 64: '8',
  }
  const INTEGER_CLUE_COLORS = [
    '#546e7a', '#0b5fce', '#0f6b2f', '#b71c1c',
    '#2d2a8f', '#8a3b00', '#006354', '#222222', '#616161',
  ]
  /* 根式按族配色（深色，落在浅色已翻开格上对比度 >= 4.5:1）。 */
  const ROOT_CLUE_COLORS = {
    2: '#7b1fa2', 5: '#00695c', 8: '#7b1fa2', 10: '#ad1457',
    13: '#4527a0', 17: '#1b5e20', 18: '#7b1fa2', 20: '#00695c',
    26: '#bf360c', 29: '#01579b', 32: '#7b1fa2', 34: '#4e342e',
    37: '#5e4b00', 40: '#ad1457', 50: '#7b1fa2',
  }

  function clueText(square) {
    const text = CLUE_TEXT[square]
    return text === undefined ? String(square) : text
  }

  function clueColor(square) {
    const root = Math.floor(Math.sqrt(square))
    if (root * root === square && root >= 0 && root <= 8) return INTEGER_CLUE_COLORS[root]
    const color = ROOT_CLUE_COLORS[square]
    return color === undefined ? '#37474f' : color
  }

  function presetById(id) {
    for (let i = 0; i < PRESETS.length; i += 1) {
      if (PRESETS[i].id === id) return PRESETS[i]
    }
    return null
  }

  function difficultyById(id) {
    for (let i = 0; i < DIFFICULTY.length; i += 1) {
      if (DIFFICULTY[i].id === id) return DIFFICULTY[i]
    }
    return DIFFICULTY[0]
  }

  function clampInt(value, lo, hi) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return lo
    return Math.max(lo, Math.min(hi, Math.round(value)))
  }

  /** 计时文案：不足一小时显示 m:ss，超过一小时显示 h:mm:ss。 */
  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
    const seconds = total % 60
    const minutes = Math.floor(total / 60) % 60
    const hours = Math.floor(total / 3600)
    const ss = (seconds < 10 ? '0' : '') + seconds
    if (hours > 0) return hours + ':' + (minutes < 10 ? '0' : '') + minutes + ':' + ss
    return minutes + ':' + ss
  }
  /* ======================================================================
   * 视觉常量（canvas 自配色：不依赖宿主主题，所以在明暗主题下都可读）
   * ==================================================================== */
  const COLORS = {
    canvasBg: '#0b1119',
    boardEdge: '#1d2a3a',
    hidden: '#2f3d4f',
    hiddenHover: '#3b4c61',
    hiddenLight: '#4b5f77',
    hiddenDark: '#1b2531',
    revealed: '#dfe6ee',
    grid: '#c3cedb',
    boomBg: '#ff7043',
    boomCore: '#7f1d1d',
    pole: '#c7d2df',
    reviewOk: '#2e7d32',
    reviewWrong: '#d32f2f',
    flash: 'rgba(255, 82, 82, ',
    tooSmallBg: '#0b1119',
    tooSmallText: '#e8eef5',
    tooSmallSub: '#9fb3c7',
  }
  const FONT_STACK = '"Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif'

  /* ======================================================================
   * 布局
   * ==================================================================== */

  function computeLayout(width, height, cols, rows) {
    const inset = Math.max(6, Math.min(18, Math.min(width, height) * 0.03))
    const availWidth = Math.max(1, width - inset * 2)
    const availHeight = Math.max(1, height - inset * 2)
    const cell = Math.max(2, Math.floor(Math.min(availWidth / cols, availHeight / rows)))
    const boardWidth = cell * cols
    const boardHeight = cell * rows
    return {
      x: Math.floor((width - boardWidth) / 2),
      y: Math.floor((height - boardHeight) / 2),
      cell,
      cols,
      rows,
      boardWidth,
      boardHeight,
    }
  }

  function cellIndexAt(layout, x, y) {
    if (!layout) return -1
    const localX = x - layout.x
    const localY = y - layout.y
    if (localX < 0 || localY < 0 || localX >= layout.boardWidth || localY >= layout.boardHeight) {
      return -1
    }
    const col = Math.floor(localX / layout.cell)
    const row = Math.floor(localY / layout.cell)
    if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return -1
    return row * layout.cols + col
  }

  /* ======================================================================
   * 存档（client.js 唯一负责 localStorage）
   * ==================================================================== */

  function buildSave(game, difficulty, elapsedMs) {
    const state = game.snapshot()
    state.elapsedMs = clampInt(elapsedMs, 0, MAX_ELAPSED_MS)
    return { schemaVersion: SCHEMA_VERSION, difficulty, state }
  }

  /**
   * 校验存档。返回 { game, difficulty }，任何一步不合法都返回 null（不抛错）。
   * 难度必须与棋盘尺寸对应，否则视为坏档（任务书要求）。
   */
  function parseSave(raw) {
    try {
      const obj = JSON.parse(raw)
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
      if (obj.schemaVersion !== SCHEMA_VERSION) return null
      const preset = presetById(obj.difficulty)
      if (!preset) return null
      const game = Game.fromSnapshot(obj.state)
      if (!game) return null
      if (game.w !== preset.w || game.h !== preset.h) return null
      return { game, difficulty: preset.id }
    } catch (error) {
      return null
    }
  }

  function readSave(view) {
    try {
      const raw = view.localStorage.getItem(STORE_KEY)
      if (!raw) return null
      return parseSave(raw)
    } catch (error) {
      return null
    }
  }

  function writeSave(view, payload) {
    view.localStorage.setItem(STORE_KEY, JSON.stringify(payload))
  }

  /* ======================================================================
   * 界面快照 / 状态文案（React 工具栏消费）
   * ==================================================================== */

  function statusTextFor(game) {
    if (game.msg === MSG.WIN) return '胜利：所有非雷格都已翻开'
    if (game.msg === MSG.LOSE) return '踩到雷了：棋盘已进入复盘，可点「再来一局」'
    if (game.msg === MSG.JUDGE_FAIL) return '判定不通过：邻域旗数或实/虚比例不对'
    if (game.msg === MSG.EXPAND_OK) return '展开成功：判据通过，邻域已翻开'
    if (!game.started) return '左键点开第一格开始；首点及周围八格必定安全'
    return '进行中：已翻开 ' + game.openedCount() + ' / ' + game.safeCount() + ' 安全格'
  }

  function uiSnapshot(game, difficulty, elapsedMs) {
    const preset = presetById(difficulty) || PRESETS[0]
    const safe = game.started ? game.safeCount() : preset.w * preset.h - preset.mines
    const flags = game.flagsTotal()
    const correct = game.started ? game.correctFlags() : 0
    return {
      difficulty,
      presetLabel: preset.label,
      started: game.started === true,
      over: game.over === true,
      win: game.win === true,
      elapsedMs: clampInt(elapsedMs, 0, MAX_ELAPSED_MS),
      msg: game.msg,
      status: statusTextFor(game),
      mines: game.started ? game.mines : preset.mines,
      typeTotal: [0, game.typeTotal[1], game.typeTotal[2], game.typeTotal[3], game.typeTotal[4]],
      flagsOf: [0, game.flagsOf[1], game.flagsOf[2], game.flagsOf[3], game.flagsOf[4]],
      flags,
      opened: game.openedCount(),
      safe,
      correctFlags: correct,
      wrongFlags: Math.max(0, flags - correct),
      boom: game.boom,
    }
  }

  /* ======================================================================
   * canvas 绘制
   * ==================================================================== */

  function drawBackdrop(ctx, width, height) {
    ctx.fillStyle = COLORS.canvasBg
    ctx.fillRect(0, 0, width, height)
  }

  function drawTooSmall(ctx, width, height) {
    ctx.fillStyle = COLORS.tooSmallBg
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = COLORS.tooSmallText
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '600 15px ' + FONT_STACK
    ctx.fillText('窗口太小', width / 2, height / 2 - 10)
    ctx.font = '13px ' + FONT_STACK
    ctx.fillStyle = COLORS.tooSmallSub
    ctx.fillText('请放大游戏区域', width / 2, height / 2 + 12)
  }

  function drawHiddenCell(ctx, x, y, cell, hover) {
    ctx.fillStyle = hover ? COLORS.hiddenHover : COLORS.hidden
    ctx.fillRect(x, y, cell, cell)
    const bevel = Math.max(1, Math.floor(cell * 0.09))
    ctx.fillStyle = COLORS.hiddenLight
    ctx.fillRect(x, y, cell, bevel)
    ctx.fillRect(x, y, bevel, cell)
    ctx.fillStyle = COLORS.hiddenDark
    ctx.fillRect(x, y + cell - bevel, cell, bevel)
    ctx.fillRect(x + cell - bevel, y, bevel, cell)
  }

  function drawRevealedCell(ctx, x, y, cell) {
    ctx.fillStyle = COLORS.revealed
    ctx.fillRect(x, y, cell, cell)
    if (cell >= 5) {
      ctx.fillStyle = COLORS.grid
      ctx.fillRect(x, y + cell - 1, cell, 1)
      ctx.fillRect(x + cell - 1, y, 1, cell)
    }
  }

  function drawClueText(ctx, x, y, cell, square) {
    const text = clueText(square)
    let scale = 0.64
    if (text.length === 2) scale = 0.5
    else if (text.length === 3) scale = 0.42
    else if (text.length >= 4) scale = 0.32
    const fontPx = Math.max(7, Math.round(cell * scale))
    ctx.fillStyle = clueColor(square)
    ctx.font = '700 ' + fontPx + 'px ' + FONT_STACK
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x + cell / 2, y + cell / 2 + cell * 0.03)
  }

  function drawFlagGlyph(ctx, x, y, cell, type, alpha) {
    const meta = FLAG_META[type]
    if (!meta) return
    ctx.save()
    if (typeof alpha === 'number') ctx.globalAlpha = alpha
    const poleX = x + cell * 0.34
    const top = y + cell * 0.19
    const bottom = y + cell * 0.76
    ctx.strokeStyle = COLORS.pole
    ctx.lineWidth = Math.max(1, cell * 0.075)
    ctx.beginPath()
    ctx.moveTo(poleX, bottom)
    ctx.lineTo(poleX, top)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(poleX, top)
    ctx.lineTo(poleX + cell * 0.4, top + cell * 0.13)
    ctx.lineTo(poleX, top + cell * 0.28)
    ctx.closePath()
    ctx.fillStyle = meta.color
    ctx.fill()
    ctx.fillStyle = COLORS.pole
    ctx.fillRect(x + cell * 0.22, y + cell * 0.76, cell * 0.26, Math.max(1, cell * 0.055))
    if (cell >= 17) {
      ctx.fillStyle = meta.color
      ctx.font = '700 ' + Math.max(7, Math.round(cell * 0.29)) + 'px ' + FONT_STACK
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(meta.glyph, x + cell * 0.53, y + cell * 0.56)
    }
    ctx.restore()
  }

  function drawMineGlyph(ctx, x, y, cell, type, alpha) {
    const meta = FLAG_META[type]
    const color = meta ? meta.color : COLORS.pole
    ctx.save()
    if (typeof alpha === 'number') ctx.globalAlpha = alpha
    const centerX = x + cell / 2
    const centerY = y + cell / 2
    const radius = cell * 0.19
    const spike = cell * 0.33
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1, cell * 0.06)
    for (let i = 0; i < 8; i += 1) {
      const angle = (i * Math.PI) / 4
      ctx.beginPath()
      ctx.moveTo(centerX + Math.cos(angle) * radius * 0.6, centerY + Math.sin(angle) * radius * 0.6)
      ctx.lineTo(centerX + Math.cos(angle) * spike, centerY + Math.sin(angle) * spike)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    if (cell >= 20) {
      ctx.fillStyle = '#f7fbff'
      ctx.font = '700 ' + Math.max(6, Math.round(cell * 0.2)) + 'px ' + FONT_STACK
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(meta ? meta.glyph : '?', centerX, centerY)
    }
    ctx.restore()
  }

  function drawReviewMark(ctx, x, y, cell, kind) {
    ctx.save()
    if (kind === 'ok') {
      ctx.strokeStyle = COLORS.reviewOk
      ctx.lineWidth = Math.max(1.5, cell * 0.075)
      ctx.beginPath()
      ctx.moveTo(x + cell * 0.12, y + cell * 0.36)
      ctx.lineTo(x + cell * 0.24, y + cell * 0.48)
      ctx.lineTo(x + cell * 0.44, y + cell * 0.2)
      ctx.stroke()
    } else {
      ctx.strokeStyle = COLORS.reviewWrong
      ctx.lineWidth = Math.max(1.5, cell * 0.085)
      ctx.beginPath()
      ctx.moveTo(x + cell * 0.2, y + cell * 0.2)
      ctx.lineTo(x + cell * 0.8, y + cell * 0.8)
      ctx.moveTo(x + cell * 0.8, y + cell * 0.2)
      ctx.lineTo(x + cell * 0.2, y + cell * 0.8)
      ctx.stroke()
    }
    ctx.restore()
  }

  function drawBoom(ctx, x, y, cell) {
    const centerX = x + cell / 2
    const centerY = y + cell / 2
    ctx.strokeStyle = COLORS.boomCore
    ctx.lineWidth = Math.max(2, cell * 0.08)
    for (let i = 0; i < 8; i += 1) {
      const angle = (i * Math.PI) / 4
      ctx.beginPath()
      ctx.moveTo(centerX + Math.cos(angle) * cell * 0.18, centerY + Math.sin(angle) * cell * 0.18)
      ctx.lineTo(centerX + Math.cos(angle) * cell * 0.44, centerY + Math.sin(angle) * cell * 0.44)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(centerX, centerY, cell * 0.19, 0, Math.PI * 2)
    ctx.fillStyle = COLORS.boomCore
    ctx.fill()
  }

  function drawBoard(ctx, game, layout, options) {
    const opts = options || {}
    const cell = layout.cell
    ctx.fillStyle = COLORS.boardEdge
    ctx.fillRect(layout.x - 2, layout.y - 2, layout.boardWidth + 4, layout.boardHeight + 4)
    for (let i = 0; i < game.n; i += 1) {
      const row = Math.floor(i / game.w)
      const col = i % game.w
      const x = layout.x + col * cell
      const y = layout.y + row * cell
      const mine = game.mine[i]
      const open = game.open[i] !== 0
      const flag = game.flag[i]
      const review = game.over === true
      if (open && mine !== 0) {
        ctx.fillStyle = COLORS.boomBg
        ctx.fillRect(x, y, cell, cell)
        drawBoom(ctx, x, y, cell)
        continue
      }
      if (open) {
        drawRevealedCell(ctx, x, y, cell)
        if (game.clue[i] >= 0) drawClueText(ctx, x, y, cell, game.clue[i])
        continue
      }
      const hover = !review && opts.hover === i
      drawHiddenCell(ctx, x, y, cell, hover)
      if (flag !== 0) {
        drawFlagGlyph(ctx, x, y, cell, flag, 0.97)
        if (review) {
          drawReviewMark(ctx, x, y, cell, mine !== 0 && mine === flag ? 'ok' : 'wrong')
        }
        continue
      }
      if (review && mine !== 0) drawMineGlyph(ctx, x, y, cell, mine, 0.92)
    }
  }

  function drawFlash(ctx, layout, cells, alpha) {
    ctx.save()
    ctx.fillStyle = COLORS.flash + alpha + ')'
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i]
      if (cell < 0) continue
      const row = Math.floor(cell / layout.cols)
      const col = cell % layout.cols
      ctx.fillRect(layout.x + col * layout.cell, layout.y + row * layout.cell, layout.cell, layout.cell)
    }
    ctx.restore()
  }

  /* 最近一次 createGame 的实例（仅 dev 探针/预览页使用）。 */
  let lastGame = null

  /* ======================================================================
   * 游戏实例：状态 + canvas + 输入 + 计时 + 存档 + 清理
   * ==================================================================== */

  function createGame(host, options) {
    if (!host) throw new Error('complexweeper: missing mount element')
    const opts = options || {}
    const view = window
    const doc = document
    const random = typeof opts.random === 'function' ? opts.random : Math.random
    const onState = typeof opts.onState === 'function' ? opts.onState : null
    const onError = typeof opts.onError === 'function' ? opts.onError : null
    const onSize = typeof opts.onSize === 'function' ? opts.onSize : null

    const canvas = doc.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('complexweeper: 2d canvas context unavailable')
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'application')
    canvas.setAttribute('aria-label', '复扫雷棋盘：左键翻开，右键循环插旗，双击或中键展开')
    canvas.style.cssText =
      'display:block;width:100%;height:100%;outline:none;touch-action:none;-webkit-user-select:none;user-select:none;cursor:default'

    function clock() {
      const perf = view.performance
      if (perf && typeof perf.now === 'function') {
        try {
          return perf.now()
        } catch (error) {
          // fall through to Date.now
        }
      }
      return Date.now()
    }

    function pickSeed() {
      let value
      try {
        value = random()
      } catch (error) {
        value = Math.random()
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
        value = Math.random()
      }
      let seed = Math.floor(value * 0xFFFFFFFE) + 1
      if (seed > 0xFFFFFFFF) seed = 0xFFFFFFFF
      if (seed <= 0) seed = 1
      return seed >>> 0
    }

    function freshGame(difficultyId) {
      const preset = presetById(difficultyId) || PRESETS[0]
      const next = new Game({ w: preset.w, h: preset.h, mines: preset.mines, mode: E.MODE.COMPLEX })
      next.newGame(pickSeed())
      return { game: next, difficulty: preset.id }
    }

    function loadGame() {
      try {
        const raw = view.localStorage.getItem(STORE_KEY)
        if (!raw) return null
        const parsed = parseSave(raw)
        if (parsed) return parsed
        try {
          view.localStorage.removeItem(STORE_KEY)
        } catch (removeError) {
          // ignore
        }
        return null
      } catch (error) {
        return null
      }
    }

    const loaded = loadGame()
    let difficulty = loaded ? loaded.difficulty : PRESETS[0].id
    let game = loaded ? loaded.game : freshGame(difficulty).game

    let alive = true
    let failure = null
    let raf = 0
    let size = { width: 0, height: 0, dpr: 1 }
    let layout = null
    let hoverIndex = -1
    let flash = null
    // Timer: committed milliseconds inside game.elapsedMs plus the wall-clock
    // start of the current run. document.hidden commits and pauses this.
    let runStart = null
    let runBase = 0
    let shownSecond = -1
    // 一次性提示（判定不通过 / 展开成功 / 开局）自动清除计时器
    let msgClearTimer = 0
    let msgClearKind = ''

    function clearTransientMsgTimer() {
      if (!msgClearTimer) return
      try {
        if (msgClearKind === 'view' && typeof view.clearTimeout === 'function') {
          view.clearTimeout(msgClearTimer)
        } else if (typeof clearTimeout === 'function') {
          clearTimeout(msgClearTimer)
        }
      } catch (error) {
        // ignore
      }
      msgClearTimer = 0
      msgClearKind = ''
    }

    function isTransientMsg() {
      return game.msg === MSG.JUDGE_FAIL || game.msg === MSG.EXPAND_OK || game.msg === MSG.STARTED
    }

    /** 让「判定不通过」「展开成功」等一次性提示 ~1.8s 后自动消失。 */
    function scheduleTransientMsgClear() {
      clearTransientMsgTimer()
      if (!isTransientMsg() || game.over) return
      const callback = function () {
        msgClearTimer = 0
        msgClearKind = ''
        if (!alive || failure) return
        if (!isTransientMsg() || game.over) return
        game.setMsg(MSG.NONE)
        persist()
        emit()
        paint()
      }
      try {
        if (typeof view.setTimeout === 'function') {
          msgClearKind = 'view'
          msgClearTimer = view.setTimeout(callback, JUDGE_FAIL_CLEAR_MS)
          return
        }
        if (typeof setTimeout === 'function') {
          msgClearKind = 'global'
          msgClearTimer = setTimeout(callback, JUDGE_FAIL_CLEAR_MS)
        }
      } catch (error) {
        msgClearTimer = 0
        msgClearKind = ''
      }
    }

    function liveElapsed(now) {
      if (runStart === null) return clampInt(game.elapsedMs, 0, MAX_ELAPSED_MS)
      const raw = runBase + Math.max(0, now - runStart)
      return clampInt(raw, 0, MAX_ELAPSED_MS)
    }

    function startClock(now) {
      if (runStart !== null) return
      if (!game.started || game.over) return
      runBase = clampInt(game.elapsedMs, 0, MAX_ELAPSED_MS)
      runStart = now
    }

    function commitElapsed(now) {
      if (runStart === null) return
      game.elapsedMs = liveElapsed(now)
      runStart = null
    }

    function persist() {
      try {
        writeSave(view, buildSave(game, difficulty, liveElapsed(clock())))
      } catch (error) {
        // localStorage may be unavailable; gameplay keeps working in memory.
      }
    }

    function emit() {
      if (!onState) return
      try {
        onState(uiSnapshot(game, difficulty, liveElapsed(clock())))
      } catch (error) {
        console.error('[dsh-game-complexweeper] state listener failed', error)
      }
    }

    function fail(error) {
      if (!alive) return
      failure = '游戏遇到问题，点「重试」重新开始。'
      if (raf) {
        try {
          view.cancelAnimationFrame(raf)
        } catch (cancelError) {
          // ignore
        }
        raf = 0
      }
      if (runStart !== null) commitElapsed(clock())
      try {
        console.error('[dsh-game-complexweeper] runtime error', error)
      } catch (logError) {
        // ignore
      }
      if (onError) {
        try {
          onError(failure)
        } catch (listenerError) {
          console.error('[dsh-game-complexweeper] error listener failed', listenerError)
        }
      }
    }

    function paint() {
      if (!alive) return
      try {
        drawFrame()
      } catch (error) {
        fail(error)
      }
    }

    function drawFrame() {
      const width = size.width
      const height = size.height
      context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
      context.clearRect(0, 0, width, height)
      drawBackdrop(context, width, height)
      if (width < MIN_WIDTH || height < MIN_HEIGHT) {
        layout = null
        drawTooSmall(context, width, height)
        return
      }
      const nextLayout = computeLayout(width, height, game.w, game.h)
      layout = nextLayout
      drawBoard(context, game, nextLayout, { hover: hoverIndex })
      if (flash) {
        const now = clock()
        if (now >= flash.until) {
          flash = null
        } else {
          const phase = Math.abs(Math.sin((now - flash.since) / 80))
          drawFlash(context, nextLayout, flash.cells, 0.18 + 0.22 * phase)
        }
      }
    }

    function cancelFrame() {
      if (!raf) return
      try {
        view.cancelAnimationFrame(raf)
      } catch (error) {
        // ignore
      }
      raf = 0
    }

    function scheduleFrame() {
      if (!alive || failure || raf || doc.hidden) return
      const busy = (game.started && !game.over) || flash !== null
      if (!busy) return
      try {
        raf = view.requestAnimationFrame(tick)
      } catch (error) {
        fail(error)
      }
    }

    function tick() {
      raf = 0
      if (!alive || failure || doc.hidden) return
      const now = clock()
      let dirty = false
      if (flash) {
        if (now >= flash.until) flash = null
        dirty = true
      }
      if (game.started && !game.over) {
        const second = Math.floor(liveElapsed(now) / 1000)
        if (second !== shownSecond) {
          shownSecond = second
          emit()
        }
      }
      if (dirty) paint()
      scheduleFrame()
    }

    function refreshPauseState() {
      const now = clock()
      if (game.started && !game.over && !doc.hidden) startClock(now)
      else if (runStart !== null) commitElapsed(now)
    }

    /**
     * Run one user action and commit its side effects (timer, save, react
     * state, canvas). Every user-facing mutation goes through here so all of
     * them are guarded.
     */
    function act(mutator) {
      if (!alive || failure) return false
      let changed = false
      try {
        changed = mutator() === true
      } catch (error) {
        fail(error)
        return false
      }
      if (!changed) return false
      refreshPauseState()
      persist()
      emit()
      paint()
      /* 「判定不通过 / 展开成功 / 开局」等一次性提示自动清除；胜负不受影响 */
      scheduleTransientMsgClear()
      scheduleFrame()
      return true
    }

    function revealAt(index) {
      if (!alive || failure) return false
      if (!Number.isInteger(index) || index < 0 || index >= game.n) return false
      if (game.over || game.open[index] !== 0 || game.flag[index] !== 0) return false
      return act(function () {
        if (!game.started) game.startAt(index, clock())
        else game.reveal(index, clock())
        return true
      })
    }

    function flagAt(index) {
      if (!alive || failure) return false
      if (!Number.isInteger(index) || index < 0 || index >= game.n) return false
      if (game.over || game.open[index] !== 0) return false
      return act(function () {
        return game.cycleFlag(index)
      })
    }

    function expandAt(index) {
      if (!alive || failure) return false
      if (!Number.isInteger(index) || index < 0 || index >= game.n) return false
      if (!game.started || game.over || game.open[index] === 0 || game.mine[index] !== 0) return false
      let hasTarget = false
      try {
        const neighbors = game.nbrs(index)
        for (let i = 0; i < neighbors.length; i += 1) {
          const j = neighbors[i]
          if (game.open[j] === 0 && game.flag[j] === 0) {
            hasTarget = true
            break
          }
        }
      } catch (error) {
        fail(error)
        return false
      }
      if (!hasTarget) return false
      return act(function () {
        game.tryExpand(index)
        if (game.msg === MSG.JUDGE_FAIL) {
          const now = clock()
          flash = { cells: [index].concat(game.nbrs(index)), since: now, until: now + 720 }
        }
        return true
      })
    }

    function newGame(nextDifficulty) {
      if (!alive || failure) return false
      const target = presetById(nextDifficulty) ? nextDifficulty : difficulty
      if (runStart !== null) commitElapsed(clock())
      clearTransientMsgTimer()
      const fresh = freshGame(target)
      game = fresh.game
      difficulty = fresh.difficulty
      runStart = null
      runBase = 0
      shownSecond = -1
      hoverIndex = -1
      flash = null
      persist()
      emit()
      paint()
      scheduleFrame()
      return true
    }

    function setDifficulty(difficultyId) {
      if (!presetById(difficultyId)) return false
      return newGame(difficultyId)
    }

    function restart() {
      return newGame(difficulty)
    }

    function getState() {
      return uiSnapshot(game, difficulty, liveElapsed(clock()))
    }

    function getLayout() {
      if (!layout) return null
      return {
        x: layout.x,
        y: layout.y,
        cell: layout.cell,
        cols: layout.cols,
        rows: layout.rows,
        boardWidth: layout.boardWidth,
        boardHeight: layout.boardHeight,
      }
    }

    function cellPoint(row, col) {
      if (!layout) return null
      return {
        x: layout.x + col * layout.cell + layout.cell / 2,
        y: layout.y + row * layout.cell + layout.cell / 2,
      }
    }

    function focusCanvas() {
      try {
        canvas.focus({ preventScroll: true })
      } catch (error) {
        try {
          canvas.focus()
        } catch (focusError) {
          // ignore
        }
      }
    }

    function preventEvent(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
    }

    function pointerCell(event) {
      if (!layout) return -1
      let left = 0
      let top = 0
      try {
        if (typeof canvas.getBoundingClientRect === 'function') {
          const rect = canvas.getBoundingClientRect()
          if (rect) {
            left = typeof rect.left === 'number' ? rect.left : 0
            top = typeof rect.top === 'number' ? rect.top : 0
          }
        }
      } catch (error) {
        // Use the canvas origin fallback.
      }
      const clientX = event && typeof event.clientX === 'number' ? event.clientX : 0
      const clientY = event && typeof event.clientY === 'number' ? event.clientY : 0
      return cellIndexAt(layout, clientX - left, clientY - top)
    }

    function onPointerDown(event) {
      if (!alive || failure) return
      focusCanvas()
      const button = event && typeof event.button === 'number' ? event.button : 0
      const index = pointerCell(event)
      if (button === 2) {
        preventEvent(event)
        if (index >= 0) flagAt(index)
        return
      }
      if (button === 1) {
        preventEvent(event)
        if (index >= 0) expandAt(index)
        return
      }
      if (button !== 0) return
      if (index >= 0) revealAt(index)
    }

    function onPointerMove(event) {
      if (!alive || failure) return
      if (game.over) {
        if (hoverIndex !== -1) {
          hoverIndex = -1
          paint()
        }
        return
      }
      const index = pointerCell(event)
      if (index !== hoverIndex) {
        hoverIndex = index
        paint()
      }
    }

    function onPointerLeave() {
      if (hoverIndex === -1) return
      hoverIndex = -1
      paint()
    }

    function onContextMenu(event) {
      preventEvent(event)
    }

    function onDoubleClick(event) {
      if (!alive || failure) return
      preventEvent(event)
      const index = pointerCell(event)
      if (index >= 0) expandAt(index)
    }

    function onAuxClick(event) {
      if (event && typeof event.button === 'number' && event.button === 1) preventEvent(event)
    }

    function onVisibilityChange() {
      if (!alive) return
      if (doc.hidden) {
        if (runStart !== null) commitElapsed(clock())
        cancelFrame()
        persist()
        return
      }
      refreshPauseState()
      emit()
      paint()
      scheduleFrame()
    }

    function onWindowResize() {
      if (!alive) return
      try {
        resize()
      } catch (error) {
        fail(error)
      }
    }

    function resize() {
      if (!alive) return
      let width = 0
      let height = 0
      try {
        const rect = typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null
        width = Math.max(0, Math.floor((rect && rect.width) || 0))
        height = Math.max(0, Math.floor((rect && rect.height) || 0))
      } catch (error) {
        width = 0
        height = 0
      }
      const dpr = Math.max(1, view.devicePixelRatio || 1)
      size = { width, height, dpr }
      if (onSize) {
        try {
          onSize({ width, height, tooSmall: width < MIN_WIDTH || height < MIN_HEIGHT })
        } catch (listenerError) {
          console.error('[dsh-game-complexweeper] size listener failed', listenerError)
        }
      }
      const pixelWidth = Math.max(1, Math.floor(width * dpr))
      const pixelHeight = Math.max(1, Math.floor(height * dpr))
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight
      paint()
    }

    let resizeObserver = null
    const ResizeObserverCtor = view.ResizeObserver
    if (typeof ResizeObserverCtor === 'function') {
      try {
        resizeObserver = new ResizeObserverCtor(function () {
          try {
            resize()
          } catch (error) {
            fail(error)
          }
        })
        resizeObserver.observe(host)
      } catch (error) {
        resizeObserver = null
      }
    }

    doc.addEventListener('visibilitychange', onVisibilityChange)
    view.addEventListener('resize', onWindowResize)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('contextmenu', onContextMenu)
    canvas.addEventListener('dblclick', onDoubleClick)
    canvas.addEventListener('auxclick', onAuxClick)
    host.appendChild(canvas)

    try {
      resize()
      // A page can mount while hidden (panel restored in a background window);
      // never let the timer count hidden wall-clock time.
      refreshPauseState()
      if (isTransientMsg() && !game.over) scheduleTransientMsgClear()
      persist()
      emit()
      paint()
      scheduleFrame()
    } catch (error) {
      try {
        teardown()
      } catch (teardownError) {
        // ignore
      }
      throw error
    }

    function teardown() {
      if (!alive) return
      clearTransientMsgTimer()
      if (runStart !== null) commitElapsed(clock())
      try {
        persist()
      } catch (error) {
        // ignore
      }
      alive = false
      cancelFrame()
      try {
        if (resizeObserver) resizeObserver.disconnect()
      } catch (error) {
        // ignore
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
        canvas.removeEventListener('contextmenu', onContextMenu)
        canvas.removeEventListener('dblclick', onDoubleClick)
        canvas.removeEventListener('auxclick', onAuxClick)
      } catch (error) {
        // ignore
      }
      try {
        canvas.remove()
      } catch (error) {
        // ignore
      }
    }

    const instance = {
      reveal: revealAt,
      flag: flagAt,
      chord: expandAt,
      expand: expandAt,
      newGame,
      restart,
      setDifficulty,
      destroy: teardown,
      getState,
      getLayout,
      getCanvas: function () {
        return canvas
      },
      getGame: function () {
        return game
      },
      cellPoint,
      persistNow: persist,
    }
    lastGame = instance
    return instance
  }
  /* ======================================================================
   * 测试探针：只有 dev 预览页 / 无头测试显式打开时才安装（生产不触发）。
   * ==================================================================== */
  if (typeof window !== 'undefined' && window.__DSH_GAME_COMPLEXSWEEPER_TEST__ === true) {
    try {
      Object.defineProperty(window, '__DSH_GAME_COMPLEXSWEEPER__', {
        configurable: true,
        value: {
          E,
          Game: E.Game,
          GAME_ID,
          STORE_KEY,
          MATCHED,
          createGame,
          SCHEMA_VERSION,
          MIN_WIDTH,
          MIN_HEIGHT,
          MAX_ELAPSED_MS,
          CLIENT_REV,
          ENGINE_SHA256,
          PRESETS,
          MSG,
          DIFFICULTY,
          FLAG_META,
          computeLayout,
          cellIndexAt,
          clueText,
          clueColor,
          buildSave,
          parseSave,
          uiSnapshot,
          statusTextFor,
          getLastGame: function () {
            return lastGame
          },
        },
      })
    } catch (error) {
      // A test seam failure must never affect the game itself.
    }
  }

  /* ======================================================================
   * React 界面：工具栏 / 旗数统计 / 状态栏 / 结局复盘条（画布与输入在
   * createGame 里，React 只负责主题化的文字与按钮）。
   * ==================================================================== */

  window.__ModuleLoader__.load({
    id: '@local/dsh-game-complexweeper',
    factory(require) {
      const React = require('react')
      const h = React.createElement

      const UI = {
        root: {
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '10px 12px 12px',
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
          userSelect: 'none',
        },
        toolbar: {
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          paddingBottom: 6,
        },
        titleBlock: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
        title: { fontSize: 20, fontWeight: 600, lineHeight: '1.1', letterSpacing: '0.02em' },
        hint: {
          fontSize: 11,
          lineHeight: '15px',
          color: 'var(--dsw-alias-label-tertiary)',
          whiteSpace: 'nowrap',
        },
        spacer: { flex: 1, minWidth: 0 },
        levels: { display: 'flex', gap: 4 },
        levelButton: {
          border: '0.5px solid var(--dsw-alias-border-l1)',
          borderRadius: 7,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          fontFamily: 'inherit',
          fontSize: 12,
          lineHeight: '16px',
          padding: '5px 9px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
        levelButtonActive: {
          border: '0.5px solid var(--dsw-alias-brand-primary, var(--dsw-alias-border-l1))',
          background: 'var(--dsw-alias-interactive-bg-active)',
          color: 'var(--dsw-alias-label-primary)',
        },
        scores: { display: 'flex', gap: 8 },
        score: {
          minWidth: 58,
          padding: '3px 10px',
          textAlign: 'center',
          borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
        },
        scoreLabel: {
          fontSize: 10,
          lineHeight: '14px',
          letterSpacing: '0.04em',
          color: 'var(--dsw-alias-label-tertiary)',
        },
        scoreValue: {
          fontSize: 16,
          lineHeight: '20px',
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
        },
        chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
        chip: {
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '2px 8px 2px 6px',
          borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          fontSize: 11,
          lineHeight: '17px',
          whiteSpace: 'nowrap',
        },
        chipDot: {
          width: 9,
          height: 9,
          borderRadius: 2,
          display: 'inline-block',
          flex: '0 0 auto',
        },
        chipLabel: {
          color: 'var(--dsw-alias-label-secondary)',
          fontVariantNumeric: 'tabular-nums',
        },
        chipValue: {
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--dsw-alias-label-primary)',
        },
        statusLine: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          minHeight: 20,
          paddingBottom: 6,
          fontSize: 12,
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-secondary)',
        },
        hiddenRow: { display: 'none' },
        failBadge: {
          display: 'inline-block',
          padding: '1px 9px',
          borderRadius: 999,
          background: '#c62828',
          color: '#ffffff',
          fontWeight: 600,
        },
        button: {
          border: '0.5px solid var(--dsw-alias-border-l1)',
          borderRadius: 8,
          background: 'var(--dsw-alias-interactive-bg-hover)',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'inherit',
          fontSize: 13,
          lineHeight: '18px',
          padding: '6px 12px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
        actions: { display: 'flex', gap: 8 },
        stage: {
          position: 'relative',
          flex: 1,
          minHeight: 120,
          borderRadius: 10,
          overflow: 'hidden',
          background: '#0b1119',
        },
        host: { position: 'absolute', inset: 0, outline: 'none' },
        result: {
          position: 'absolute',
          right: 10,
          bottom: 10,
          maxWidth: 300,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '9px 12px',
          borderRadius: 10,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          boxShadow: 'var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.18))',
        },
        resultText: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
        resultTitle: { fontSize: 14, fontWeight: 600, lineHeight: '20px' },
        resultSub: {
          fontSize: 11,
          lineHeight: '16px',
          color: 'var(--dsw-alias-label-secondary)',
          fontVariantNumeric: 'tabular-nums',
        },
        closeButton: {
          position: 'absolute',
          top: 2,
          right: 4,
          width: 20,
          height: 20,
          padding: 0,
          border: 'none',
          borderRadius: 4,
          background: 'transparent',
          color: 'var(--dsw-alias-label-tertiary)',
          fontFamily: 'inherit',
          fontSize: 15,
          lineHeight: '20px',
          cursor: 'pointer',
        },
        overlay: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.38))',
        },
        panel: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          maxWidth: 320,
          padding: '20px 24px',
          textAlign: 'center',
          borderRadius: 12,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          boxShadow: 'var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.18))',
        },
        panelTitle: { fontSize: 18, fontWeight: 600 },
        panelSub: { fontSize: 13, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' },
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
        '.dshcw-btn{transition:background-color .12s ease,opacity .12s ease}',
        '.dshcw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)!important}',
        '.dshcw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      ].join('\n')

      function ScoreBox(props) {
        return h(
          'div',
          { style: UI.score },
          h('div', { style: UI.scoreLabel }, props.label),
          h('div', { style: UI.scoreValue }, String(props.value)),
        )
      }

      function FlagChip(props) {
        const meta = FLAG_META[props.type]
        const total = props.started ? String(props.total) : '?'
        return h(
          'div',
          {
            style: UI.chip,
            title: meta.name + '：已插 ' + props.count + ' 面 / 开局公开 ' + total + ' 颗',
          },
          h('span', { style: Object.assign({}, UI.chipDot, { background: meta.color }) }),
          h('span', { style: UI.chipLabel }, meta.label),
          h('span', { style: UI.chipValue }, props.count + '/' + total),
        )
      }

      function FlagChips(props) {
        const chips = []
        for (let type = 1; type <= 4; type += 1) {
          chips.push(
            h(FlagChip, {
              key: 'flag-' + type,
              type,
              count: props.snapshot.flagsOf[type],
              total: props.snapshot.typeTotal[type],
              started: props.snapshot.started,
            }),
          )
        }
        return h('div', { style: UI.chips, role: 'group', 'aria-label': '四类雷与已插旗' }, chips)
      }

      function DifficultyButtons(props) {
        return h(
          'div',
          { style: UI.levels, role: 'group', 'aria-label': '难度' },
          DIFFICULTY.map(function (item) {
            const active = props.difficulty === item.id
            return h(
              'button',
              {
                key: 'level-' + item.id,
                type: 'button',
                className: 'dshcw-btn',
                title: item.label,
                'aria-pressed': active,
                style: active ? Object.assign({}, UI.levelButton, UI.levelButtonActive) : UI.levelButton,
                onClick: function () {
                  props.onChoose(item.id)
                },
              },
              item.short,
            )
          }),
        )
      }

      function ResultPanel(props) {
        const snapshot = props.snapshot
        const title = snapshot.win ? '扫雷成功！' : '踩雷了'
        const subtitle =
          '用时 ' + formatElapsed(snapshot.elapsedMs) +
          ' · 标对 ' + snapshot.correctFlags + ' 面 · 标错 ' + snapshot.wrongFlags + ' 面'
        return h(
          'div',
          { style: UI.result, role: 'status' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshcw-btn',
              style: UI.closeButton,
              title: '收起复盘面板（canvas 上的标对/标错标记保留）',
              'aria-label': '关闭复盘面板',
              onClick: props.onClose,
            },
            '×',
          ),
          h(
            'div',
            { style: UI.resultText },
            h('div', { style: UI.resultTitle }, title),
            h('div', { style: UI.resultSub }, subtitle),
          ),
          h(
            'button',
            { type: 'button', className: 'dshcw-btn', style: UI.button, onClick: props.onRestart },
            '再来一局',
          ),
        )
      }

      function ErrorOverlay(props) {
        return h(
          'div',
          { style: UI.overlay, role: 'alert' },
          h(
            'div',
            { style: UI.panel },
            h('div', { style: UI.panelTitle }, '游戏出错了'),
            h('div', { style: UI.panelSub }, props.message),
            h(
              'button',
              { type: 'button', className: 'dshcw-btn', style: UI.button, onClick: props.onRetry },
              '重试',
            ),
          ),
        )
      }

      const INITIAL_SNAPSHOT = {
        difficulty: 1,
        presetLabel: '初级 9×9 · 10 雷',
        started: false,
        over: false,
        win: false,
        elapsedMs: 0,
        msg: MSG.NONE,
        status: '左键点开第一格开始；首点及周围八格必定安全',
        mines: 10,
        typeTotal: [0, 0, 0, 0, 0],
        flagsOf: [0, 0, 0, 0, 0],
        flags: 0,
        opened: 0,
        safe: 71,
        correctFlags: 0,
        wrongFlags: 0,
        boom: -1,
      }

      function Game(props) {
        const rootRef = React.useRef(null)
        const hostRef = React.useRef(null)
        const gameRef = React.useRef(null)
        const [snapshot, setSnapshot] = React.useState(INITIAL_SNAPSHOT)
        const [error, setError] = React.useState(null)
        const [attempt, setAttempt] = React.useState(0)
        const [compact, setCompact] = React.useState(false)
        const [resultClosed, setResultClosed] = React.useState(false)

        /* 新一局开始后重新允许展示结局条 */
        React.useEffect(function () {
          if (!snapshot.over) setResultClosed(false)
        }, [snapshot.over])

        /* 用根元素自身的尺寸决定是否收起工具栏。测量对象不能是 canvas 宿主：
         * 收起工具栏会改变宿主尺寸，用宿主判断会在阈值附近来回抖动。
         * 状态更新推迟到下一帧（rAF），避免在 ResizeObserver 回调里同步改
         * 布局触发 Chrome 的 "ResizeObserver loop" 报错。 */
        React.useEffect(function () {
          const node = rootRef.current
          if (!node) return undefined
          const ResizeObserverCtor = window.ResizeObserver
          let frame = 0
          let frameKind = ''
          let observer = null
          let resizeFallback = false

          function measure() {
            try {
              const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
              const width = rect ? rect.width : 0
              const height = rect ? rect.height : 0
              setCompact(width < MIN_WIDTH || height < MIN_HEIGHT)
            } catch (measureError) {
              /* ignore */
            }
          }

          function schedule() {
            if (frame) return
            try {
              if (typeof window.requestAnimationFrame === 'function') {
                frameKind = 'raf'
                frame = window.requestAnimationFrame(function () {
                  frame = 0
                  measure()
                })
              } else {
                frameKind = 'timeout'
                frame = window.setTimeout(function () {
                  frame = 0
                  measure()
                }, 16)
              }
            } catch (scheduleError) {
              frame = 0
              measure()
            }
          }

          /* 首次测量放在 effect 里（不在 RO 回调中），不会触发循环告警。 */
          measure()
          if (typeof ResizeObserverCtor !== 'function') {
            resizeFallback = true
            window.addEventListener('resize', schedule)
          } else {
            try {
              observer = new ResizeObserverCtor(schedule)
              observer.observe(node)
            } catch (observerError) {
              observer = null
              resizeFallback = true
              window.addEventListener('resize', schedule)
            }
          }
          return function cleanupObserver() {
            if (frame) {
              try {
                if (frameKind === 'raf') window.cancelAnimationFrame(frame)
                else window.clearTimeout(frame)
              } catch (cancelError) {
                /* ignore */
              }
              frame = 0
            }
            try {
              if (observer) observer.disconnect()
              if (resizeFallback) window.removeEventListener('resize', schedule)
            } catch (error) {
              /* ignore */
            }
          }
        }, [])

        React.useEffect(function () {
          const host = hostRef.current
          if (!host) return undefined
          let game = null
          try {
            game = createGame(host, {
              onState: function (next) {
                setSnapshot(next)
                setError(null)
              },
              onError: function (message) {
                setError(message)
              },
            })
            gameRef.current = game
          } catch (createError) {
            console.error('[dsh-game-complexweeper] failed to start', createError)
            setError('游戏启动失败，点「重试」重新开始。')
            return undefined
          }
          return function cleanup() {
            gameRef.current = null
            try {
              game.destroy()
            } catch (destroyError) {
              console.error('[dsh-game-complexweeper] cleanup failed', destroyError)
            }
          }
        }, [attempt])

        const restart = React.useCallback(function () {
          const game = gameRef.current
          if (game) game.restart()
        }, [])

        const chooseDifficulty = React.useCallback(function (difficulty) {
          const game = gameRef.current
          if (game) game.setDifficulty(difficulty)
        }, [])

        const retry = React.useCallback(function () {
          setError(null)
          setAttempt(function (value) {
            return value + 1
          })
        }, [])

        const closeResult = React.useCallback(function () {
          setResultClosed(true)
        }, [])

        const judgeFail = snapshot.msg === MSG.JUDGE_FAIL && !snapshot.over
        /* 舞台小于 320×240 时收起工具栏，把整个区域留给 canvas 画「窗口太小」 */
        const rootStyle = compact ? Object.assign({}, UI.root, { padding: 4 }) : UI.root
        const toolbarStyle = compact ? UI.hiddenRow : UI.toolbar
        const statusStyle = compact ? UI.hiddenRow : UI.statusLine

        return h(
          'div',
          { ref: rootRef, style: rootStyle, tabIndex: 0, 'data-dsh-game': GAME_ID },
          h('style', null, STYLE_TEXT),
          h(
            'div',
            { style: toolbarStyle },
            h(
              'div',
              { style: UI.titleBlock },
              h('div', { style: UI.title }, '复扫雷'),
              h('div', { style: UI.hint }, '左键翻开 · 右键循环插旗（空→+1→−1→+i→−i）· 双击/中键展开'),
            ),
            h('div', { style: UI.spacer }),
            h(DifficultyButtons, { difficulty: snapshot.difficulty, onChoose: chooseDifficulty }),
            h(
              'div',
              { style: UI.actions },
              h(
                'button',
                { type: 'button', className: 'dshcw-btn', style: UI.button, onClick: restart },
                '重开',
              ),
            ),
            h(
              'div',
              { style: UI.scores },
              h(ScoreBox, { label: '用时', value: formatElapsed(snapshot.elapsedMs) }),
              h(ScoreBox, { label: '旗', value: snapshot.flags }),
              h(ScoreBox, { label: '进度', value: snapshot.opened + '/' + snapshot.safe }),
            ),
          ),
          h(
            'div',
            { style: statusStyle },
            h(FlagChips, { snapshot }),
            h('div', { style: UI.spacer }),
          ),
          h(
            'div',
            { style: statusStyle },
            judgeFail
              ? h('span', { style: UI.failBadge, role: 'status' }, snapshot.status)
              : h('span', { role: 'status' }, snapshot.status),
          ),
          h(
            'div',
            { style: UI.stage },
            h('div', { ref: hostRef, style: UI.host }),
            error
              ? h(ErrorOverlay, { message: error, onRetry: retry })
              : snapshot.over && !resultClosed
                ? h(ResultPanel, { snapshot, onRestart: restart, onClose: closeResult })
                : null,
          ),
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
          console.error('[dsh-game-complexweeper] component crashed', error, info)
        }

        render() {
          if (this.state.failed) {
            return h('div', { style: UI.crash }, '复扫雷加载失败，请切走再重新进入「游戏」页。')
          }
          return this.props.children
        }
      }

      function GameEntry(props) {
        return h(GameBoundary, null, h(Game, props))
      }

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
                      return '复扫雷'
                    },
                    select: function (ownerProps) {
                      return ownerProps && ownerProps.gameId === GAME_ID ? MATCHED : null
                    },
                  },
                  GameEntry,
                )
              } catch (error) {
                console.error('[dsh-game-complexweeper] slot registration failed', error)
                return function () {}
              }
            })
          } catch (error) {
            console.error('[dsh-game-complexweeper] slot inject failed', error)
          }
        },
      }
    },
  })
})()
