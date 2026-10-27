/* =========================================================================
 * 复扫雷 Complexweeper · 规则层回归自测（node dev/selftest.mjs）
 * -------------------------------------------------------------------------
 * 来源：把 Zig 原版 `正式版/src/selftest.zig` 里适用于 v1（圆复数模式）的规则用例
 * 翻译成 node 断言，并补上 engine.js 作为 JS 库额外承诺的边界（组 0 / 12 / 13）。
 * 权威规则参考：`正式版/src/game.zig`（514 行）。移植对照：`dev/engine-api.md`。
 *
 * 用例分组（组号尽量对齐 selftest.zig）：
 *   0  常量 / API 基本盘（JS 侧补充）
 *   1  随机数确定性                        （Zig 组 1）
 *   2  精确配比 type_count                  （Zig 组 2）
 *   3  纯实 / 纯虚局面线索全是完全平方数    （Zig 组 3）
 *   4  12×12 连片与独立洪水填充逐格一致     （Zig 组 4：不翻雷 / 显示 0 不连片）
 *   4b 40×30 等大盘连片 / 栈边界            （Zig 组 4b）
 *   5  首点安全、连片 ≥9、四类总数已知       （Zig 组 5）
 *   6  展开判据与独立实现逐项一致            （Zig 组 6）
 *   7  插旗不限量 + 循环 1,2,3,4,0,1         （Zig 组 7）
 *   8  旗保护格子（翻不开 / 连片绕开 / 撤旗可翻）（Zig 组 8）
 *   9  胜负（翻完所有非雷格才胜 / 翻雷判负） （Zig 组 9）
 *   10 展开门禁（判据不过棋盘不变 / 通过后行为）（Zig 组 10）
 *   11 圆复数 24 个可达显示值 + 495 种邻域组合（Zig 组 11 的圆复数部分）
 *   12 存档 snapshot → JSON → fromSnapshot 往返 + 坏档拒绝（engine-api.md §4）
 *   13 越界参数安全 / 非玩法边角（engine.js 作为库的额外承诺）
 *
 * 明确跳过的 selftest.zig 组：
 *   · 组 11 的闵可夫斯基模式部分（MODE.HYPER：39 个显示值、judgeLoose 判据、
 *     hnum_by_D 贴图覆盖）——v1 只做圆复数模式，UI 不启用闵可夫斯基玩法；
 *     engine.js 虽保留了 hyper 分支，但不在本次验收范围。
 *   · 组 12（图集贴图表 mine_T / flag_T / boom_T / h*_T 的空洞与复用）——那是
 *     Zig 原版 assets.zig 的精灵图槽位，纯渲染资源；engine.js 没有贴图概念。
 *
 * 依赖：只 import ../engine.js（IIFE，挂到 globalThis.CS），不碰 client.js / DOM。
 *       本脚本只写 stdout，退出码 0 = 全绿。
 * =======================================================================*/

import { fileURLToPath } from 'node:url'

const ENGINE_URL = new URL('../engine.js', import.meta.url)
await import(ENGINE_URL.href)
const E = globalThis.CS
if (!E) {
  console.error('无法加载 engine.js（globalThis.CS 缺失）')
  process.exit(1)
}
const { Game, Rng, MSG, ACHIEVABLE, PRESETS, MODE, TYPES, splitEvenly } = E

const VERBOSE = process.env.CS_SELFTEST_VERBOSE === '1'
const ENGINE_PATH = fileURLToPath(ENGINE_URL)

let checks = 0
let failures = 0
const failedNames = []

/** 断言一条：cond 为真通过；失败打印名字（含期望/实际由调用方拼出）。 */
function check(cond, name) {
  checks++
  if (!cond) {
    failures++
    failedNames.push(name)
    console.log(`  [FAIL] ${name}`)
  } else if (VERBOSE) {
    console.log(`  [ok] ${name}`)
  }
}

/** 深比较（数组 / 普通对象 / 标量），只用于测试数据。 */
function same(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false
    return true
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    if (!same(ka, kb)) return false
    for (const k of ka) if (!same(a[k], b[k])) return false
    return true
  }
  return false
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v)
  try {
    const s = JSON.stringify(v)
    return s.length > 160 ? s.slice(0, 157) + '...' : s
  } catch {
    return String(v)
  }
}

function eq(actual, expected, name) {
  check(same(actual, expected), `${name} [期望 ${fmt(expected)}, 实际 ${fmt(actual)}]`)
}

/** 一个分组包一层 try/catch：单个用例写错不会吞掉后面所有组。 */
function suite(title, fn) {
  console.log(`-- ${title}`)
  try {
    fn()
  } catch (err) {
    checks++
    failures++
    const msg = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)
    failedNames.push(`${title} 抛异常: ${msg}`)
    console.log(`  [FAIL] ${title} 抛异常: ${msg}`)
  }
}

function board(opts, seed, startCell) {
  const g = new Game(opts)
  g.newGame(seed)
  if (startCell !== undefined) g.startAt(startCell, 0)
  return g
}

function snapshotJson(g) {
  return JSON.stringify(g.snapshot())
}

/** 棋盘状态（不含 msg / msgArg）：用于“判据失败时棋盘不变”这类只允许反馈字段变化的断言。 */
function boardStateJson(g) {
  const s = g.snapshot()
  delete s.msg
  delete s.msgArg
  return JSON.stringify(s)
}

function clone(o) {
  return JSON.parse(JSON.stringify(o))
}

/* ========================= 独立参照实现（只用于对比，不是被测对象） ========================= */

/** 独立洪水填充（由 Zig selftest.zig 的 expectedCascade 转写）：
 *  只沿空白格扩散，得到「连通空白格 ∪ 它们的非雷邻居」；不感知旗帜。 */
function referenceCascade(g, start) {
  const n = g.n
  const comp = new Uint8Array(n)
  const stack = [start]
  comp[start] = 1
  while (stack.length > 0) {
    const i = stack.pop()
    for (const j of g.nbrs(i)) {
      if (comp[j] || g.mine[j] !== 0) continue
      if (g.isBlank(j)) {
        comp[j] = 1
        stack.push(j)
      }
    }
  }
  const set = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!comp[i]) continue
    set[i] = 1
    for (const j of g.nbrs(i)) if (g.mine[j] === 0) set[j] = 1
  }
  return set
}

/** 独立线索：a = #(+1)−#(−1)，b = #(+i)−#(−i)，显示值 = a²+b²（圆复数模式）。 */
function referenceClue(g, cell) {
  const SPEC = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  let a = 0
  let b = 0
  for (const j of g.nbrs(cell)) {
    const m = g.mine[j]
    if (m === 0) continue
    const d = SPEC[m - 1]
    a += d[0]
    b += d[1]
  }
  return a * a + b * b
}

/** 独立判据（由 Zig group 6 的 want 公式转写，不调用 engine 的 matchComboTruth）。 */
function referenceJudge(g, cell) {
  const truth = [0, 0, 0, 0]
  const got = [0, 0, 0, 0]
  for (const j of g.nbrs(cell)) {
    if (g.mine[j] !== 0) truth[g.mine[j] - 1] += 1
    if (g.flag[j] !== 0) got[g.flag[j] - 1] += 1
  }
  const P = truth[0] + truth[1]
  const V = truth[2] + truth[3]
  const gp = got[0] + got[1]
  const gv = got[2] + got[3]
  return gp + gv === P + V && ((gp === P && gv === V) || (gp === V && gv === P))
}

/** 一个 5×5 手工小盘（中央格 12，邻域 6,7,8,11,13,16,17,18），清空所有状态。 */
function manual5x5(seed) {
  const g = new Game({ w: 5, h: 5, mines: 0 })
  g.newGame(seed)
  for (let i = 0; i < g.n; i++) {
    g.mine[i] = 0
    g.clue[i] = -1
    g.open[i] = 0
    g.flag[i] = 0
  }
  g.typeTotal.fill(0)
  g.flagsOf.fill(0)
  return g
}

/* ==================================== 组 0：常量 / API 基本盘 ==================================== */
suite('组 0 常量 / API 基本盘', () => {
  eq([E.MAX_W, E.MAX_H, E.MAX_CELLS, E.MAX_MINES], [40, 30, 1200, 999], 'MAX_* 常量同 game.zig')
  eq(TYPES, [[1, 0], [-1, 0], [0, 1], [0, -1]], 'TYPES 四种雷（实部, 虚部）')
  eq(MODE, { COMPLEX: 0, HYPER: 1 }, 'MODE typedef')
  eq(E.MODE_COMPLEX, 0, 'MODE_COMPLEX = 0')
  eq(E.MODE_HYPER, 1, 'MODE_HYPER = 1')
  eq(MSG, { NONE: 0, STARTED: 1, JUDGE_FAIL: 2, EXPAND_OK: 3, WIN: 4, LOSE: 5 }, 'MSG 枚举值同 Zig')
  eq(E.MSG_NAMES, ['none', 'started', 'judge_fail', 'expand_ok', 'win', 'lose'], 'MSG_NAMES 与 MSG 对齐')
  eq(
    ACHIEVABLE.slice().sort((x, y) => x - y),
    [0, 1, 2, 4, 5, 8, 9, 10, 13, 16, 17, 18, 20, 25, 26, 29, 32, 34, 36, 37, 40, 49, 50, 64],
    'ACHIEVABLE 正好 24 个圆复数显示值',
  )
  eq(
    PRESETS.map((p) => [p.id, p.w, p.h, p.mines]),
    [[1, 9, 9, 10], [2, 16, 16, 40], [3, 30, 16, 99]],
    'PRESETS 三档尺寸 / 雷数同 game.zig',
  )
  check(PRESETS.every((p) => typeof p.label === 'string' && p.label.length > 0), '每个 PRESET 都有 label')
  eq(E.ENGINE_INFO.engine, 'complexweeper', 'ENGINE_INFO.engine')
  eq(E.ENGINE_INFO.license, 'GPL-3.0-only', 'ENGINE_INFO.license')
  check(typeof E.ENGINE_INFO.reference === 'string' && E.ENGINE_INFO.reference.includes('game.zig'), 'ENGINE_INFO 指向 game.zig 参考')

  // 默认构造：9×9 / 10 雷 / COMPLEX
  const g = new Game()
  eq([g.w, g.h, g.n, g.mines, g.mode, g.judgeLoose], [9, 9, 81, 10, 0, false], '默认构造 9×9 / 10 雷 / COMPLEX')
  eq([g.mine.length, g.clue.length, g.open.length, g.flag.length], [1200, 1200, 1200, 1200], '内部数组按 MAX_CELLS 分配')
  check(g.clue.subarray(0, g.n).every((v) => v === -1), '未开局时前 n 个 clue 全是 -1')
  eq(g.cellCount(), 81, 'cellCount() = w*h')
  eq([g.started, g.over, g.win, g.boom, g.startCell], [false, false, false, -1, -1], '未开局初始状态')
  eq(Array.from(g.typeTotal), [0, 0, 0, 0, 0], '未开局 typeTotal 全 0')
  eq(Array.from(g.flagsOf), [0, 0, 0, 0, 0], '未开局 flagsOf 全 0')

  // splitEvenly（game.zig 同名函数）
  eq(splitEvenly(0), [0, 0, 0, 0, 0], 'splitEvenly(0)')
  eq(splitEvenly(1), [0, 1, 0, 0, 0], 'splitEvenly(1)')
  eq(splitEvenly(10), [0, 3, 3, 2, 2], 'splitEvenly(10)')
  eq(splitEvenly(99), [0, 25, 25, 25, 24], 'splitEvenly(99)')
  eq(splitEvenly(1000), [0, 250, 250, 250, 250], 'splitEvenly(1000)')

  // 邻域顺序：与 Zig nbrs() 的 dr/dc 双重循环一致（行优先）
  const n5 = new Game({ w: 5, h: 5, mines: 0 })
  n5.newGame(1)
  eq(n5.nbrs(0), [1, 5, 6], 'nbrs(0) 角格：行优先 dr/dc 顺序')
  eq(n5.nbrs(12), [6, 7, 8, 11, 13, 16, 17, 18], 'nbrs(12) 中心 8 邻域顺序')
  eq(n5.nbrs(4), [3, 8, 9], 'nbrs(4) 角格顺序')
  eq(n5.nbrs(24), [18, 19, 23], 'nbrs(24) 右下角顺序')
  eq(n5.nbrs(0).length, 3, '角格邻域数 3')
  eq(n5.nbrs(5).length, 5, '边格邻域数 5')
  eq(n5.nbrs(12).length, 8, '中心邻域数 8')
  check(n5.inb(0, 0) && n5.inb(4, 4), 'inb 合法角')
  check(!n5.inb(-1, 0) && !n5.inb(0, -1) && !n5.inb(5, 0) && !n5.inb(0, 5), 'inb 越界为 false')
  eq(n5.nbrMineCount(12), 0, '全空盘 nbrMineCount = 0')
  check(n5.isBlank(12), '全空盘 isBlank = true')
  eq(n5.flagsTotal(), 0, '全空盘 flagsTotal = 0')
  eq([n5.unmarked(1), n5.unmarked(4)], [0, 0], '全空盘 unmarked = 0')
  eq([n5.flagsTotal(), n5.typeSum(), n5.openedCount(), n5.safeCount(), n5.correctFlags()], [0, 0, 0, 25, 0], '统计函数全空盘基线')

  // Rng（mulberry32）自洽性
  eq(new Rng(0).a, 1, 'Rng(0) 种子被改成 1')
  eq(new Rng(123).a, 123, 'Rng(123).a = 123')
  const r1 = new Rng(2024)
  const r2 = new Rng(2024)
  const seq1 = []
  const seq2 = []
  for (let i = 0; i < 100; i++) {
    seq1.push(r1.next())
    seq2.push(r2.next())
  }
  eq(seq1, seq2, '同种子 Rng 序列一致（100 次）')
  check(seq1.every((v) => v >= 0 && v < 1), 'Rng.next() 落在 [0,1)')
  const r3 = new Rng(2024)
  check(new Rng(2025).next() !== r3.next(), '不同种子 Rng 首个输出不同')
  eq([r3.below(0), r3.below(1)], [0, 0], 'below(0)/below(1) 边界')
  const r4 = new Rng(7)
  check(Array.from({ length: 500 }, () => r4.below(4)).every((v) => v >= 0 && v < 4), 'below(4) 输出在 [0,4)')
})

/* ==================================== 组 1：随机数确定性 ==================================== */
suite('组 1 随机数确定性', () => {
  const a = board({ w: 16, h: 16, mines: 40 }, 12345, 100)
  const b = board({ w: 16, h: 16, mines: 40 }, 12345, 100)
  eq(Array.from(a.mine.subarray(0, a.n)), Array.from(b.mine.subarray(0, b.n)), '同种子 + 同开局格生成完全相同的棋盘')
  eq(Array.from(a.clue.subarray(0, a.n)), Array.from(b.clue.subarray(0, b.n)), '同种子线索也一致')
  eq(Array.from(a.open.subarray(0, a.n)), Array.from(b.open.subarray(0, b.n)), '同种子开局连片也一致')
  eq(a.typeTotal, b.typeTotal, '同种子四类雷数一致')

  const c = board({ w: 16, h: 16, mines: 40 }, 999, 100)
  let mineDiff = 0
  for (let i = 0; i < a.n; i++) if (a.mine[i] !== c.mine[i]) mineDiff++
  check(mineDiff > 0, `不同种子应生成不同棋盘（差异格 ${mineDiff}）`)

  // 同种子、不同开局格：安全区不同，棋盘应不同（固定 seed 下确定性）
  const d = board({ w: 16, h: 16, mines: 40 }, 12345, 0)
  let diffStart = 0
  for (let i = 0; i < a.n; i++) if (a.mine[i] !== d.mine[i]) diffStart++
  check(diffStart > 0, `同种子不同开局格棋盘不同（差异格 ${diffStart}）`)

  // newGame(0) 走 setSeed：种子变 1；同一 seed 重建结果一致
  const e0 = new Game({ w: 9, h: 9, mines: 10 })
  e0.newGame(0)
  eq(e0.seed, 1, 'newGame(0) 种子归一到 1（Rng.init 语义）')
  e0.startAt(40, 0)
  const e1 = board({ w: 9, h: 9, mines: 10 }, 1, 40)
  eq(Array.from(e0.mine.subarray(0, e0.n)), Array.from(e1.mine.subarray(0, e1.n)), 'newGame(0) 与 newGame(1) 生成同一棋盘')
})

/* ==================================== 组 2：精确配比 type_count ==================================== */
suite('组 2 精确配比 type_count', () => {
  const cases = [
    [0, 3, 2, 4, 1],
    [0, 0, 0, 0, 6],
    [0, 7, 0, 0, 0],
    [0, 5, 5, 0, 0],
    [0, 0, 0, 4, 4],
  ]
  let bad = 0
  for (const tc of cases) {
    const sum = tc.reduce((s, v) => s + v, 0)
    for (const seed of [11, 22, 33]) {
      const g = board({ w: 12, h: 12, mines: sum, typeCount: tc }, seed, 70)
      for (let t = 1; t <= 4; t++) if (g.typeTotal[t] !== tc[t]) bad++
      if (g.typeSum() !== sum) bad++
      if (g.mines !== sum) bad++
    }
  }
  eq(bad, 0, '指定配比必须被精确执行（5 种配比 × 3 种子，逐类核对 typeTotal/typeSum/mines）')
  check(cases.reduce((s, c) => s + c.reduce((x, y) => x + y, 0), 0) > 0, '配比用例非空')

  // 全 0 = 随机撒：类型随机，但总数守恒
  const rnd = board({ w: 12, h: 12, mines: 24 }, 44, 70)
  eq([rnd.mines, rnd.typeSum()], [24, 24], 'typeCount 全 0 时按 mines 随机撒且总数守恒')
  check(rnd.typeTotal[1] + rnd.typeTotal[2] + rnd.typeTotal[3] + rnd.typeTotal[4] === 24, '四类计数合计 = 24')

  // 非法/非正配比被钳到 0：constructor 只接受正整数
  const clamped = new Game({ w: 9, h: 9, typeCount: [0, -3, 0, 0, 0] })
  eq(Array.from(clamped.typeCount), [0, 0, 0, 0, 0], '负配比被钳成 0（全 0 = 随机）')

  // 配比总数超过首点安全区剩余格：count 被 clamp 到 pool 大小（Zig genBoard 的 @min）
  const over = board({ w: 9, h: 9, mines: 10, typeCount: [0, 100, 0, 0, 0] }, 55, 40)
  eq([over.mines, over.typeSum(), over.typeTotal[1]], [72, 72, 72], '配比 100 > 可用 72 格：clamp 到 72 且全是 +1')
  // 雷数本身超过 pool：count 同样 clamp
  const dense = board({ w: 9, h: 9, mines: 100 }, 56, 40)
  eq([dense.mines, dense.typeSum(), dense.safeCount()], [72, 72, 9], 'mines=100 在 9×9 中央开局被 clamp 到 72（pool=81−9）')

  // newGame 不清 typeCount（Zig newGame 不动 type_count）
  const keep = new Game({ w: 9, h: 9, mines: 5, typeCount: [0, 1, 1, 1, 1] })
  keep.newGame(1)
  eq(Array.from(keep.typeCount), [0, 1, 1, 1, 1], 'newGame 不清 typeCount')
  keep.startAt(40, 0)
  eq(keep.typeSum(), 4, 'newGame 后仍按 typeCount 布雷（合计 4）')
})

/* ==================================== 组 3：纯实 / 纯虚线索 ==================================== */
suite('组 3 纯实 / 纯虚局面线索全是完全平方数', () => {
  const pureCases = [
    [0, 5, 5, 0, 0], // 只有 +1 / −1（纯实）
    [0, 0, 0, 4, 4], // 只有 +i / −i（纯虚）
  ]
  let bad = 0
  let checkedCells = 0
  for (const tc of pureCases) {
    const sum = tc.reduce((s, v) => s + v, 0)
    for (const seed of [7, 8, 9]) {
      const g = board({ w: 12, h: 12, mines: sum, typeCount: tc }, seed, 70)
      for (let i = 0; i < g.n; i++) {
        if (g.mine[i] !== 0) continue
        checkedCells++
        const D = g.clue[i]
        const r = Math.round(Math.sqrt(D))
        if (r * r !== D) bad++
      }
    }
  }
  eq(bad, 0, `纯实/纯虚局面里所有显示值都必须是完全平方数（共核对 ${checkedCells} 格）`)
  check(checkedCells >= 500, '纯实/纯虚核对格数足够')
  const squares = new Set([0, 1, 4, 9, 16, 25, 36, 49, 64])
  let nonSquare = 0
  for (const tc of pureCases) {
    const sum = tc.reduce((s, v) => s + v, 0)
    for (const seed of [17, 18]) {
      const g = board({ w: 12, h: 12, mines: sum, typeCount: tc }, seed, 70)
      for (let i = 0; i < g.n; i++) if (g.mine[i] === 0 && !squares.has(g.clue[i])) nonSquare++
    }
  }
  eq(nonSquare, 0, '纯实/纯虚线索值只落在 {0,1,4,9,16,25,36,49,64}')

  // 对照：随机四类配比下会出现非平方值（确认上面的“平方”不是真空成立）
  const mixed = board({ w: 12, h: 12, mines: 24 }, 301, 70)
  let nonSquareMixed = 0
  for (let i = 0; i < mixed.n; i++) if (mixed.mine[i] === 0 && !squares.has(mixed.clue[i])) nonSquareMixed++
  check(nonSquareMixed > 0, `随机四类局确实出现非平方显示值（${nonSquareMixed} 格），平方不变量非真空`)
})

/* ==================================== 组 4：12×12 连片 ==================================== */
suite('组 4 连片与独立洪水填充逐格一致（12×12）', () => {
  let samples = 0
  let mismatch = 0
  let mineOpened = 0
  const seedList = [301, 302, 303, 304, 305]
  for (const seed of seedList) {
    const probe = board({ w: 12, h: 12, mines: 24 }, seed, 70)
    const candidates = []
    for (let i = 0; i < probe.n; i++) {
      if (probe.mine[i] !== 0 || probe.open[i] !== 0 || !probe.isBlank(i)) continue
      candidates.push(i)
    }
    for (const i of candidates) {
      if (samples >= 40) break
      const g = board({ w: 12, h: 12, mines: 24 }, seed, 70)
      if (g.open[i] !== 0) continue
      const before = Array.from(g.open.subarray(0, g.n), (v) => v !== 0)
      g.reveal(i, 0)
      const want = referenceCascade(g, i)
      samples++
      for (let k = 0; k < g.n; k++) {
        const got = g.open[k] !== 0 && !before[k]
        const exp = want[k] !== 0 && !before[k]
        if (got !== exp) mismatch++
        if (got && g.mine[k] !== 0) mineOpened++
      }
    }
  }
  check(samples >= 20, `空白格连片样本数足够（${samples} ≥ 20）`)
  eq(mismatch, 0, '连片结果必须与独立洪水填充逐格一致')
  eq(mineOpened, 0, '连片绝不能翻开雷')

  // 显示 0 绝不连片（0 = 邻域全是抵消对，不是空白）
  let zeroSamples = 0
  let zeroCascaded = 0
  for (const seed of seedList) {
    const probe = board({ w: 12, h: 12, mines: 24 }, seed, 70)
    const zeros = []
    for (let k = 0; k < probe.n; k++) {
      if (probe.mine[k] !== 0 || probe.open[k] !== 0) continue
      if (probe.clue[k] !== 0 || probe.nbrMineCount(k) === 0) continue
      zeros.push(k)
    }
    for (const k of zeros) {
      const g = board({ w: 12, h: 12, mines: 24 }, seed, 70)
      const before = Array.from(g.open.subarray(0, g.n), (v) => v !== 0)
      g.reveal(k, 0)
      let openedNow = 0
      for (let m = 0; m < g.n; m++) if (g.open[m] !== 0 && !before[m]) openedNow++
      zeroSamples++
      if (openedNow !== 1) zeroCascaded++
    }
  }
  check(zeroSamples >= 5, `显示 0 的样本数足够（${zeroSamples} ≥ 5）`)
  eq(zeroCascaded, 0, '显示 0 的格子绝不能连片（只翻开自己）')

  // 空白格定义 = 邻域零雷；显示 0 但不是空白（邻域有抵消对）应存在
  const probe = board({ w: 12, h: 12, mines: 24 }, 301, 70)
  let zeroNonBlank = 0
  let blankWithZero = 0
  for (let i = 0; i < probe.n; i++) {
    if (probe.mine[i] !== 0) continue
    if (probe.clue[i] === 0 && probe.nbrMineCount(i) > 0) zeroNonBlank++
    if (probe.isBlank(i) && probe.clue[i] === 0) blankWithZero++
  }
  check(zeroNonBlank > 0, `12×12 局面存在“显示 0 但非空白”的格子（${zeroNonBlank} 格）`)
  check(blankWithZero > 0, '空白格的显示值一定是 0（邻域零雷 ⇒ 平方和 0）')
})

/* ==================================== 组 4b：大盘连片 / 栈边界 ==================================== */
suite('组 4b 大盘开局连片 / 栈边界', () => {
  const shapes = [
    { w: 40, h: 30, mines: 1 },
    { w: 40, h: 30, mines: 5 },
    { w: 40, h: 30, mines: 20 },
    { w: 40, h: 30, mines: 60 },
    { w: 40, h: 20, mines: 40 },
    { w: 30, h: 30, mines: 60 },
  ]
  const seeds = [4111, 4127, 4133, 4139, 4153, 4159]
  let samples = 0
  let mismatch = 0
  let openedMine = 0
  let big = 0
  let worst = 0
  for (const sh of shapes) {
    const starts = [0, Math.floor(sh.w / 2), Math.floor(sh.h / 2) * sh.w + Math.floor(sh.w / 2), sh.w * sh.h - 1]
    for (const seed of seeds) {
      for (const st of starts) {
        const g = board({ w: sh.w, h: sh.h, mines: sh.mines }, seed, st)
        const want = referenceCascade(g, st)
        for (let k = 0; k < g.n; k++) {
          if ((g.open[k] !== 0) !== (want[k] !== 0)) mismatch++
          if (g.open[k] !== 0 && g.mine[k] !== 0) openedMine++
        }
        const oc = g.openedCount()
        if (oc > worst) worst = oc
        if (oc >= 400) big++
        samples++
      }
    }
  }
  check(samples >= 72, `大盘连片样本数足够（${samples} 组 ≥ 72）`)
  check(big >= 8, `大盘样本里应有真正的大连片（≥400 格：${big} 次）`)
  eq(mismatch, 0, '大盘开局连片必须与独立洪水填充逐格一致（栈吃满也不许漏格）')
  eq(openedMine, 0, '大盘连片也绝不能翻开雷')
  check(worst >= 1000, `栈边界压力足够：一次连片最多翻开 ${worst} 格（固定种子下应 ≥1000）`)

  // 直接调 cascadeOpen：返回新翻开数，且与实际变化一致
  const fresh = board({ w: 12, h: 12, mines: 24 }, 301, 70)
  let seedCell = -1
  for (let i = 0; i < fresh.n; i++) {
    if (fresh.open[i] === 0 && fresh.mine[i] === 0) {
      seedCell = i
      break
    }
  }
  check(seedCell >= 0, '找到一个未翻开的安全格作 cascadeOpen 种子')
  const before = Array.from(fresh.open.subarray(0, fresh.n), (v) => v !== 0)
  const openedCount = fresh.cascadeOpen([seedCell])
  let delta = 0
  for (let i = 0; i < fresh.n; i++) if (fresh.open[i] !== 0 && !before[i]) delta++
  eq(openedCount, delta, 'cascadeOpen 返回值 = 实际新翻开格数')
  check(openedCount > 0, 'cascadeOpen 种子有效时真的翻开格子')
  eq(fresh.cascadeOpen([seedCell]), 0, 'cascadeOpen 对已翻开格重复调用返回 0')
})

/* ==================================== 组 5：首点安全 ==================================== */
suite('组 5 首点安全 / 分类计数', () => {
  let bad = 0
  const checksDetail = {}
  for (const seed of [501, 502, 503, 504, 505]) {
    const g = new Game({ w: 16, h: 16, mines: 40 })
    g.newGame(seed)
    const start = 16 * 8 + 8
    g.startAt(start, 0)
    if (g.over) bad++
    if (g.openedCount() < 9) bad++
    if (!g.isBlank(start)) bad++
    if (g.mine[start] !== 0) bad++
    for (const j of g.nbrs(start)) if (g.mine[j] !== 0) bad++
    if (g.typeSum() !== 40) bad++
    if (g.flagsTotal() !== 0) bad++
    for (let t = 1; t <= 4; t++) {
      if (g.typeTotal[t] === 0) bad++
      if (g.unmarked(t) !== g.typeTotal[t]) bad++
    }
    checksDetail[seed] = [g.openedCount(), g.typeTotal.slice(1, 5).join('/')]
  }
  eq(bad, 0, '开局格必为空白格、必连片（≥9 格）且不踩雷；四类雷数已知（5 种子）')
  check(Object.keys(checksDetail).length === 5, '首点安全 5 个种子都执行')

  // 三个预设都要满足首点 ≥9 且不踩雷；首点可在角/边/中央
  for (const p of PRESETS) {
    for (const st of [0, Math.floor(p.w / 2), Math.floor(p.h / 2) * p.w + Math.floor(p.w / 2)]) {
      const g = board({ w: p.w, h: p.h, mines: p.mines }, p.id * 1000 + st, st)
      let safe = g.mine[st] === 0 && g.nbrs(st).every((j) => g.mine[j] === 0)
      check(!g.over && safe && g.isBlank(st) && g.openedCount() >= 9, `预设 ${p.id} 开局格 ${st}：首点 + 8 邻域安全且连片 ≥9`)
    }
  }

  // 开局后类型总数已知且合计 = 实际雷数；flagsOf 仍全 0
  const g30 = board({ w: 30, h: 16, mines: 99 }, 777, 30 * 8 + 15)
  eq([g30.mines, g30.typeSum()], [99, 99], '高级档开局后 mines / typeSum = 99')
  eq(Array.from(g30.flagsOf), [0, 0, 0, 0, 0], '开局未插旗')
  check([1, 2, 3, 4].every((t) => g30.typeTotal[t] > 0), '99 雷时四类都至少有一颗')
})

/* ==================================== 组 6：判据 ==================================== */
suite('组 6 展开判据（与独立实现逐项一致）', () => {
  let mismatch = 0
  let pass = 0
  let total = 0
  for (const seed of [601, 602, 603]) {
    const g = board({ w: 12, h: 12, mines: 24 }, seed, 70)
    for (let i = 0; i < g.n; i++) {
      if (g.mine[i] !== 0 || g.open[i] === 0) continue
      for (const j of g.nbrs(i)) {
        if (g.open[j] !== 0) continue
        g.setFlag(j, 1 + ((i + j) % 4))
      }
      const want = referenceJudge(g, i)
      const got = g.matchComboTruth(i)
      total++
      if (want !== got) mismatch++
      if (want) pass++
    }
    for (let j = 0; j < g.n; j++) g.setFlag(j, 0)
  }
  check(total > 50, `判据样本数足够（${total} 格）`)
  eq(mismatch, 0, '判据结果必须与独立实现逐项一致')
  check(pass > 0, `判据应至少放行一部分组合（放行 ${pass} 次）`)

  // 手工精确用例：真值 +1 与 +i（P=1,V=1，总 2）
  const mk = () => {
    const g = manual5x5(5)
    g.mine[6] = 1 // +1
    g.mine[7] = 3 // +i
    g.computeClues()
    g.countTypes()
    g.open[12] = 1
    return g
  }
  {
    const g = mk()
    g.setFlag(6, 1)
    g.setFlag(7, 3)
    check(g.matchComboTruth(12), '旗与真值同型 ⇒ 通过')
    eq([g.nbrMineCount(12), g.nbrFlagCount(12)], [2, 2], '邻域雷数 = 旗数 = 2')
  }
  {
    const g = mk()
    g.setFlag(6, 3) // 实/虚互换
    g.setFlag(7, 1)
    check(g.matchComboTruth(12), '实虚比例倒置 ⇒ 放行（显示值分辨不出交换）')
  }
  {
    const g = mk()
    g.setFlag(6, 1)
    g.setFlag(8, 2) // 两面都算实部 => gp=2, gv=0
    check(!g.matchComboTruth(12), '总旗数对但实虚比例错（2:0 vs 1:1）⇒ 拒绝')
  }
  {
    const g = mk()
    g.setFlag(6, 1) // 只插一面
    check(!g.matchComboTruth(12), '总旗数不对（1 vs 2）⇒ 拒绝')
  }
  {
    const g = manual5x5(6)
    g.mine[6] = 1 // 真值纯实 P=2, V=0
    g.mine[7] = 1
    g.computeClues()
    g.countTypes()
    g.open[12] = 1
    g.setFlag(6, 3) // 旗纯虚 gp=0, gv=2（比例 0:2 = 倒置的 2:0）
    g.setFlag(7, 3)
    check(g.matchComboTruth(12), '纯实真值 / 纯虚旗：比例倒置（0:2 vs 2:0）⇒ 放行')
  }
  {
    const g = manual5x5(7)
    for (const c of [6, 7, 8, 11]) g.mine[c] = 1 // P=4, V=0
    g.computeClues()
    g.countTypes()
    g.open[12] = 1
    g.setFlag(6, 1)
    g.setFlag(7, 1)
    g.setFlag(8, 3)
    g.setFlag(11, 3) // gp=2, gv=2
    check(!g.matchComboTruth(12), '总旗数 4 对但比例错（2:2 vs 4:0）⇒ 拒绝')
  }
  {
    const g = manual5x5(8)
    g.open[12] = 1
    g.setFlag(6, 1) // 邻域无雷却插旗：旗数 ≠ 雷数
    check(!g.matchComboTruth(12), '旗数 ≠ 邻域真实雷数 ⇒ 拒绝（即使雷数为 0）')
  }
  {
    // matchComboTruth 是纯函数：调用不改变任何状态
    const g = board({ w: 9, h: 9, mines: 10 }, 611, 40)
    for (let i = 0; i < g.n; i++) if (!g.open[i]) g.setFlag(i, 1 + (i % 4))
    const before = snapshotJson(g)
    for (let i = 0; i < g.n; i++) g.matchComboTruth(i)
    eq(snapshotJson(g), before, 'matchComboTruth 是纯函数（不改变棋盘 / 计数 / msg）')
  }
})

/* ==================================== 组 7：插旗不限量 + 循环 ==================================== */
suite('组 7 插旗不限量 + 右键循环', () => {
  const g = board({ w: 9, h: 9, mines: 10 }, 701, 40)
  let placed = 0
  for (let i = 0; i < g.n; i++) {
    if (g.open[i] !== 0) continue
    if (g.setFlag(i, 1)) placed++
  }
  check(placed > 0, `所有未翻开格都能插旗（${placed} 格）`)
  eq(g.flagsOf[1], placed, '计数与实际插旗数一致')
  check(g.unmarked(1) < 0, '插超后未标记数为负数（旗不限量）')
  eq(g.flagsTotal(), placed, 'flagsTotal = 已插旗总数')

  // 所有类型的旗都能插，且 flagsOf 分类计数正确
  const multi = board({ w: 9, h: 9, mines: 10 }, 702, 40)
  const perType = [0, 0, 0, 0, 0]
  let idx = 0
  for (let i = 0; i < multi.n; i++) {
    if (multi.open[i] !== 0) continue
    const t = 1 + (idx % 4)
    multi.setFlag(i, t)
    perType[t]++
    idx++
  }
  eq([multi.flagsOf[1], multi.flagsOf[2], multi.flagsOf[3], multi.flagsOf[4]], perType.slice(1), '四类旗分类计数正确')
  eq(multi.flagsTotal(), idx, '四类旗合计 = 插旗格数')
  for (let t = 1; t <= 4; t++) eq(multi.unmarked(t), multi.typeTotal[t] - perType[t], `unmarked(${t}) = 类型总数 − 该类旗数`)

  // 覆盖插旗：换类型时旧类型计数归还
  const one = board({ w: 9, h: 9, mines: 10 }, 703, 40)
  let cell = -1
  for (let i = 0; i < one.n; i++) if (!one.open[i]) { cell = i; break }
  one.setFlag(cell, 1)
  one.setFlag(cell, 2)
  eq([one.flag[cell], one.flagsOf[1], one.flagsOf[2]], [2, 0, 1], '改旗类型：旧计数归还、新计数 +1')
  one.setFlag(cell, 0)
  eq([one.flag[cell], one.flagsOf[2]], [0, 0], '清旗归还计数')

  // 循环顺序 空 → 1 → 2 → 3 → 4 → 空 → 1
  one.setFlag(cell, 0)
  const seq = []
  const movesBefore = one.moves
  for (let k = 0; k < 6; k++) {
    check(one.cycleFlag(cell) === true, `cycleFlag 第 ${k + 1} 次返回 true`)
    seq.push(one.flag[cell])
  }
  eq(seq, [1, 2, 3, 4, 0, 1], '右键循环必须是 1,2,3,4,0,1')
  eq(one.moves, movesBefore + 6, '每次成功 cycleFlag 计一步（Zig moves += 1）')

  // 已翻开的格子不能插旗（cycleFlag 守门；setFlag 本身无守门，与 Zig 一致）
  const openedCell = 40
  check(one.open[openedCell] !== 0, '选中的格子已翻开')
  check(one.cycleFlag(openedCell) === false, '已翻开的格子 cycleFlag 返回 false')
  eq(one.flag[openedCell], 0, '已翻开格子不会被插旗')
  eq(one.setFlag(openedCell, 2), true, 'setFlag 无“已翻开”守门（与 Zig setFlag 一致）')
  eq(one.flagsOf[2] >= 1, true, 'setFlag 在已翻开格上也维护 counts')
  one.setFlag(openedCell, 0)

  // 越界 / 非法类型
  check(one.cycleFlag(-1) === false && one.cycleFlag(one.n) === false, 'cycleFlag 越界返回 false')
  check(one.setFlag(-1, 1) === false && one.setFlag(one.n, 1) === false, 'setFlag 越界返回 false')
  check(one.setFlag(cell, 5) === false && one.setFlag(cell, -1) === false, 'setFlag 非法类型返回 false')
  eq(one.flag[cell], 1, '非法 setFlag 不改变旗帜（此前循环停在 1）')
})

/* ==================================== 组 8：旗保护格子 ==================================== */
suite('组 8 旗保护格子（翻不开 / 连片绕开 / 撤旗可翻）', () => {
  const g = board({ w: 9, h: 9, mines: 10 }, 801, 40)
  let cell = -1
  for (let i = 0; i < g.n; i++) {
    if (g.open[i] === 0 && g.mine[i] === 0) {
      cell = i
      break
    }
  }
  check(cell >= 0, '找到未翻开的非雷格')
  g.setFlag(cell, 3)
  eq(g.flagsOf[3], 1, '插旗后计数为 1')
  const movesBefore = g.moves
  g.reveal(cell, 0)
  eq(g.open[cell], 0, '插旗的格子翻不开')
  eq(g.flag[cell], 3, '翻不开时旗帜原样保留')
  eq(g.flagsOf[3], 1, '翻不开时计数不动')
  eq(g.moves, movesBefore, '翻不开时不计步')

  // 连片也要绕开旗帜
  let blank = -1
  let flaggedNbr = -1
  for (let i = 0; i < g.n && blank < 0; i++) {
    if (g.open[i] !== 0 || g.mine[i] !== 0 || !g.isBlank(i)) continue
    for (const j of g.nbrs(i)) {
      if (g.open[j] === 0 && g.mine[j] === 0 && g.flag[j] === 0) {
        blank = i
        flaggedNbr = j
        break
      }
    }
  }
  check(blank >= 0 && flaggedNbr >= 0, '找到“空白格 + 未翻开未插旗邻格”')
  if (blank >= 0 && flaggedNbr >= 0) {
    g.setFlag(flaggedNbr, 1)
    g.reveal(blank, 0)
    eq(g.open[blank], 1, '空白格应能翻开')
    eq(g.open[flaggedNbr], 0, '连片展开不该翻开插了旗的格子')
    eq(g.flag[flaggedNbr], 1, '连片展开不该清掉旗子')
    eq(g.flagsOf[1] >= 1, true, '连片后旗计数保持')
  }

  // 撤旗之后才翻得开
  g.setFlag(cell, 0)
  g.reveal(cell, 0)
  eq(g.open[cell], 1, '撤旗后应能翻开')
  eq(g.flagsOf[3], 0, '撤旗后计数归还')

  // 旗保护也覆盖 cascadeOpen 的直接种子
  const h = board({ w: 9, h: 9, mines: 10 }, 802, 40)
  let seedCell = -1
  for (let i = 0; i < h.n; i++) if (h.open[i] === 0 && h.isBlank(i)) { seedCell = i; break }
  check(seedCell >= 0, '找到未翻开的空白格（cascadeOpen 直用）')
  const nb = h.nbrs(seedCell).find((j) => h.open[j] === 0 && h.mine[j] === 0)
  if (nb !== undefined) {
    h.setFlag(nb, 2)
    const opened = h.cascadeOpen([seedCell])
    check(opened > 0, `cascadeOpen 真的翻开空白区域（${opened} 格）`)
    eq(h.open[nb], 0, 'cascadeOpen 直接种子也不翻开旗格')
    eq(h.flag[nb], 2, 'cascadeOpen 不清旗')
  }
})

/* ==================================== 组 9：胜负判定 ==================================== */
suite('组 9 胜负判定', () => {
  // 胜利：翻开全部非雷格即可，旗帜不参与；标对全部旗也照样胜
  const win = board({ w: 9, h: 9, mines: 10 }, 901, 40)
  for (let i = 0; i < win.n; i++) if (win.mine[i] !== 0) win.setFlag(i, win.mine[i])
  eq(win.correctFlags(), win.mines, '胜利前先把 10 颗雷都标对')
  for (let i = 0; i < win.n; i++) if (win.mine[i] === 0 && win.open[i] === 0) win.reveal(i, 0)
  check(win.win && win.over, '翻开所有非雷格必须判胜')
  eq(win.msg, MSG.WIN, '胜利时 msg = WIN')
  eq(win.boom, -1, '胜利时 boom = -1')
  eq([win.openedCount(), win.safeCount()], [win.safeCount(), 81 - win.mines], '胜利时翻开数 = 非雷格数')
  eq([win.correctFlags(), win.flagsTotal()], [win.mines, win.mines], '胜利判定与旗无关（全标对时仍胜）')

  // 少一个非雷格未翻开：不能判胜
  const almost = board({ w: 9, h: 9, mines: 10 }, 902, 40)
  let left = -1
  for (let i = 0; i < almost.n; i++) {
    if (almost.mine[i] === 0 && almost.open[i] === 0) {
      left = i
      break
    }
  }
  check(left >= 0, '找到一个剩余非雷格')
  for (let i = 0; i < almost.n; i++) {
    if (i !== left && almost.mine[i] === 0 && almost.open[i] === 0) almost.reveal(i, 0)
  }
  check(!almost.win, '还剩非雷格未翻开时不能判胜')
  check(!almost.over, '未胜利也未失败时 over 保持 false')
  eq(almost.open[left], 0, '剩余非雷格确实未翻开')

  // 翻雷判负并记录 boom
  const lose = board({ w: 9, h: 9, mines: 10 }, 903, 40)
  let m = -1
  for (let i = 0; i < lose.n; i++) {
    if (lose.mine[i] !== 0) {
      m = i
      break
    }
  }
  check(m >= 0, '找到一个雷格')
  lose.reveal(m, 0)
  check(lose.over && !lose.win, '翻开雷必须判负')
  eq(lose.boom, m, '记录踩中的格子')
  eq(lose.open[m], 1, '踩中的雷格标记为已翻开（用于爆炸渲染）')
  eq(lose.msg, MSG.LOSE, '失败时 msg = LOSE')

  // 结束后继续操作无副作用（reveal/cycleFlag/tryExpand 都有 over 守门）
  const afterOver = boardStateJson(lose)
  lose.reveal(40, 0)
  lose.reveal(m, 0)
  lose.cycleFlag(m, 0)
  lose.tryExpand(40)
  eq(boardStateJson(lose), afterOver, 'lose 后 reveal/cycleFlag/tryExpand 不再改变状态')
  eq(lose.cycleFlag(m), false, 'lose 后 cycleFlag 返回 false')
  eq(lose.over && !lose.win && lose.boom === m, true, 'lose 后 over/win/boom 保持')
  // setFlag 在 Zig 里没有 over 守门（UI 不会在结束时调用）；这里只核对忠实语义
  lose.setFlag(m, 1)
  eq(lose.flag[m], 1, 'setFlag 无 over 守门（与 Zig setFlag 一致；UI 不得在结束时调用）')

  // tryExpand 踩雷也判负（判据伪造通过的场景见组 10，这里只核对 msg/boom）
  const exp = manual5x5(9)
  exp.mine[6] = 3
  exp.computeClues()
  exp.countTypes()
  exp.open[12] = 1
  exp.setFlag(7, 3)
  exp.tryExpand(12)
  check(exp.over && !exp.win, '展开踩雷也判负')
  eq([exp.boom, exp.msg], [6, MSG.LOSE], '展开踩雷记录 boom 与 msg=LOSE')
})

/* ==================================== 组 10：展开门禁 ==================================== */
suite('组 10 展开门禁（判据不过棋盘不变）', () => {
  // Zig 组 10：12×12 随机局，找一个已翻开且邻域有未插旗未翻开格的数字格
  const g = board({ w: 12, h: 12, mines: 24 }, 1001, 70)
  let cell = -1
  for (let i = 0; i < g.n; i++) {
    if (g.open[i] === 0 || g.mine[i] !== 0) continue
    const uns = g.nbrs(i).filter((j) => g.open[j] === 0 && g.flag[j] === 0)
    if (uns.length > 0) {
      cell = i
      break
    }
  }
  check(cell >= 0, '找到可发起展开的已翻开数字格')
  const before = boardStateJson(g)
  g.tryExpand(cell)
  eq(g.matchComboTruth(cell), false, '随机局该格判据本就不通过（邻域有雷但无旗）')
  eq(boardStateJson(g), before, '判据不通过时展开不能改变棋盘（msg 反馈字段除外）')
  eq(g.msg, MSG.JUDGE_FAIL, '判据不通过时 msg = JUDGE_FAIL（UI 必须给出可见反馈）')
  eq(g.msgArg, 0, 'setMsg 清零 msgArg（Zig 忠实移植）')

  // 判据不过：总旗数对但实虚比例错 → 棋盘完全不变
  const wrong = manual5x5(10)
  wrong.mine[6] = 1
  wrong.mine[7] = 3
  wrong.computeClues()
  wrong.countTypes()
  wrong.open[12] = 1
  wrong.setFlag(6, 1)
  wrong.setFlag(8, 1) // 两面实部 => gp=2, gv=0，与真值 (1,1) 比例不符
  const wrongBefore = boardStateJson(wrong)
  const wrongMoves = wrong.moves
  wrong.tryExpand(12)
  eq(wrong.matchComboTruth(12), false, '比例错的手工盘判据不通过')
  eq(boardStateJson(wrong), wrongBefore, '比例错时展开棋盘/计数完全不变（只允许 msg 变化）')
  eq([wrong.moves, wrong.msg], [wrongMoves, MSG.JUDGE_FAIL], '比例错时不推进步数，只报 JUDGE_FAIL')

  // 判据通过：翻开未插旗邻格、msg=EXPAND_OK、msgArg 恒 0（引擎注释里的忠实怪癖）
  const ok = manual5x5(11)
  ok.mine[6] = 1
  ok.mine[7] = 3
  ok.computeClues()
  ok.countTypes()
  ok.open[12] = 1
  ok.setFlag(6, 1)
  ok.setFlag(7, 3)
  const okMoves = ok.moves
  const flagsBefore = snapshotJson(ok)
  ok.tryExpand(12)
  eq(ok.msg, MSG.EXPAND_OK, '判据通过后 msg = EXPAND_OK')
  eq(ok.msgArg, 0, 'tryExpand 紧随的 msgArg 恒为 0（不要“修”）')
  eq(ok.moves, okMoves + 1, '展开成功计一步')
  eq(ok.boom, -1, '邻域雷都已插旗，展开不踩雷')
  eq(ok.flag[6], 1, '展开不清旗（+1 旗保留）')
  eq(ok.flag[7], 3, '展开不清旗（+i 旗保留）')
  check([8, 11, 13, 16, 17, 18].every((j) => ok.open[j] === 1), '判据通过后邻域未插旗安全格全部翻开')
  check(ok.flagsOf[1] === 1 && ok.flagsOf[3] === 1, '展开前后旗计数不变')
  check(snapshotJson(ok) !== flagsBefore, '展开成功确实改变了棋盘')

  // 判据通过但邻域里还有雷：踩雷判负
  const boom = manual5x5(12)
  boom.mine[6] = 3
  boom.computeClues()
  boom.countTypes()
  boom.open[12] = 1
  boom.setFlag(7, 3) // 旗数 1 = 雷数 1，实虚比例也“对”（纯虚），但旗插在安全格上
  check(boom.matchComboTruth(12) === true, '踩雷用例的判据确实通过（考验实现是否真的检查邻域雷）')
  boom.tryExpand(12)
  check(boom.over && !boom.win, '判据通过但邻域有雷 ⇒ 踩雷判负')
  eq([boom.boom, boom.msg], [6, MSG.LOSE], '踩雷记录 boom=6、msg=LOSE')

  // 邻域无可翻开格：直接 return，不改 msg
  const closed = manual5x5(13)
  closed.open[12] = 1
  for (const j of closed.nbrs(12)) closed.open[j] = 1
  const closedBefore = snapshotJson(closed)
  closed.tryExpand(12)
  eq(snapshotJson(closed), closedBefore, '邻域没有未插旗未翻开格时 tryExpand 无副作用')
  eq(closed.msg, MSG.NONE, '邻域没有可展开格时不改 msg')

  // 非法目标：未翻开格 / 雷格 / 旗格 / 越界 / 已结束
  const guard = board({ w: 9, h: 9, mines: 10 }, 1002, 40)
  let unopenedSafe = -1
  let aMine = -1
  for (let i = 0; i < guard.n; i++) {
    if (unopenedSafe < 0 && guard.open[i] === 0 && guard.mine[i] === 0) unopenedSafe = i
    if (aMine < 0 && guard.mine[i] !== 0) aMine = i
  }
  const guardBefore = snapshotJson(guard)
  guard.tryExpand(unopenedSafe)
  guard.tryExpand(aMine)
  guard.tryExpand(-1)
  guard.tryExpand(guard.n)
  eq(snapshotJson(guard), guardBefore, 'tryExpand 未翻开格/雷格/越界一律 no-op')
})

/* ============================ 组 11：圆复数 24 值 / 495 组合 ============================ */
suite('组 11 圆复数显示值集合（Zig 组 11 的圆复数部分）', () => {
  // 枚举 4 类雷各取 n1..n4 颗、总数 ≤ 8 的所有邻域组合
  const seen = new Set()
  let combos = 0
  for (let n1 = 0; n1 <= 8; n1++) {
    for (let n2 = 0; n1 + n2 <= 8; n2++) {
      for (let n3 = 0; n1 + n2 + n3 <= 8; n3++) {
        for (let n4 = 0; n1 + n2 + n3 + n4 <= 8; n4++) {
          combos++
          const a = n1 - n2
          const b = n3 - n4
          seen.add(a * a + b * b)
        }
      }
    }
  }
  eq(combos, 495, '邻域组合应枚举出 495 种')
  eq(seen.size, 24, '圆复数模式应正好得到 24 个显示值')
  eq([...seen].sort((x, y) => x - y), ACHIEVABLE.slice().sort((x, y) => x - y), '显示值集合必须正好是 ACHIEVABLE 那 24 个')

  // 随机棋盘上：非雷格 clue ∈ ACHIEVABLE、雷格 clue = -1、clue 与独立 a²+b² 一致
  let checked = 0
  let outOfSet = 0
  let clueBad = 0
  let mineClueBad = 0
  for (const seed of [1201, 1202, 1203]) {
    for (const [w, h] of [[9, 9], [16, 16], [30, 16]]) {
      const g = board({ w, h, mines: Math.floor((w * h) / 6) }, seed + w * 1000, Math.floor(h / 2) * w + Math.floor(w / 2))
      for (let i = 0; i < g.n; i++) {
        if (g.mine[i] !== 0) {
          if (g.clue[i] !== -1) mineClueBad++
          continue
        }
        checked++
        if (!ACHIEVABLE.includes(g.clue[i])) outOfSet++
        if (g.clue[i] !== referenceClue(g, i)) clueBad++
        const [a, b] = g.sumsOf(i, false)
        if (a * a + b * b !== g.clue[i]) clueBad++
      }
    }
  }
  eq(outOfSet, 0, `随机棋盘所有非雷格 clue 都在 24 值集合内（核对 ${checked} 格）`)
  eq(clueBad, 0, 'clue 与独立实现的 a²+b² / sumsOf 逐格一致')
  eq(mineClueBad, 0, '雷格 clue 恒为 -1')
  check(checked > 1000, '圆复数显示值核对格数足够')

  // 显示 0 ≠ 空白：抵消对 → 显示 0 但不连片；sumsOf 核实 a=b=0
  const pair = manual5x5(20)
  pair.mine[6] = 1 // +1
  pair.mine[7] = 2 // −1
  pair.computeClues()
  pair.countTypes()
  eq(pair.clue[12], 0, '抵消对（+1 / −1）=> 显示值 0')
  eq(pair.nbrMineCount(12), 2, '抵消对局面邻域有 2 颗雷')
  eq(pair.isBlank(12), false, '显示 0 但不是空白格（不扩散）')
  eq(pair.sumsOf(12, false), [0, 0], 'sumsOf 真实雷 (a,b) = (0,0)')
  pair.setFlag(6, 1)
  pair.setFlag(7, 2)
  eq(pair.sumsOf(12, true), [0, 0], 'sumsOf 旗 (a,b) = (0,0)')
  eq(pair.matchComboTruth(12), true, '抵消对局面旗数与真值一致 ⇒ 判据通过')

  // 24 个值都真的能由某次邻域配比产生（不是从表里抄的）
  const reachable = new Set()
  for (let n1 = 0; n1 <= 8; n1++)
    for (let n2 = 0; n1 + n2 <= 8; n2++)
      for (let n3 = 0; n1 + n2 + n3 <= 8; n3++)
        for (let n4 = 0; n1 + n2 + n3 + n4 <= 8; n4++) {
          const a = n1 - n2
          const b = n3 - n4
          reachable.add(a * a + b * b)
        }
  eq(ACHIEVABLE.every((v) => reachable.has(v)), true, 'ACHIEVABLE 每个值都能被真实邻域配比产生')
})

/* ==================================== 组 12：存档往返 / 坏档拒绝 ==================================== */
suite('组 12 存档 snapshot → JSON → fromSnapshot', () => {
  // 未开局快照往返
  const fresh = new Game({ w: 9, h: 9, mines: 10 })
  fresh.newGame(4242)
  const freshSnap = clone(fresh.snapshot())
  eq(freshSnap.mine.length, 81, 'snapshot 数组截到 n（不是 MAX_CELLS）')
  check(Array.isArray(freshSnap.mine) && Array.isArray(freshSnap.clue) && !(freshSnap.mine instanceof Uint8Array), 'snapshot 是纯 JSON（普通数组，不是 TypedArray）')
  eq(JSON.parse(JSON.stringify(freshSnap)), freshSnap, 'snapshot 可 JSON 往返')
  const freshRestored = Game.fromSnapshot(clone(freshSnap))
  check(freshRestored !== null && !freshRestored.started, '未开局快照可恢复')
  if (freshRestored) eq(freshRestored.snapshot(), freshSnap, '未开局恢复后 snapshot 逐字段一致')

  // 未开局但已插旗（Zig 允许首点前插旗，旗带进新棋盘）
  const preFlag = new Game({ w: 9, h: 9, mines: 10 })
  preFlag.newGame(4243)
  preFlag.setFlag(0, 2)
  const preSnap = clone(preFlag.snapshot())
  const preRestored = Game.fromSnapshot(preSnap)
  check(preRestored !== null, '未开局 + 已插旗的快照可恢复（Zig 首点前允许插旗）')
  if (preRestored) {
    eq([preRestored.flag[0], preRestored.flagsOf[2]], [2, 1], '恢复后旗与 flagsOf 保留')
    eq(preRestored.snapshot(), preSnap, '恢复后 snapshot 一致')
  }

  // 进行中快照往返 + 恢复后继续操作与原件逐步一致
  const live = board({ w: 9, h: 9, mines: 10 }, 4244, 40)
  for (let i = 0; i < live.n; i++) {
    if (!live.open[i]) {
      live.cycleFlag(i)
      break
    }
  }
  live.elapsedMs = 12345
  const liveSnap = clone(live.snapshot())
  const live2 = Game.fromSnapshot(clone(liveSnap))
  check(live2 !== null, '进行中快照可恢复')
  if (live2) {
    eq(live2.snapshot(), liveSnap, '进行中恢复后 snapshot 逐字段一致')
    let diverged = 0
    const opRng = new Rng(999)
    for (let step = 0; step < 60; step++) {
      const cell = opRng.below(live.n)
      const kind = opRng.below(3)
      if (kind === 0) {
        live.reveal(cell, 0)
        live2.reveal(cell, 0)
      } else if (kind === 1) {
        live.cycleFlag(cell)
        live2.cycleFlag(cell)
      } else {
        const openCells = []
        for (let i = 0; i < live.n; i++) if (live.open[i] !== 0 && live.mine[i] === 0) openCells.push(i)
        const target = openCells.length > 0 ? openCells[opRng.below(openCells.length)] : cell
        live.tryExpand(target)
        live2.tryExpand(target)
      }
      if (!same(live.snapshot(), live2.snapshot())) diverged++
    }
    eq(diverged, 0, '恢复后的游戏继续 60 步随机操作与原件状态逐步一致')
  }

  // 失败快照往返
  const lost = board({ w: 9, h: 9, mines: 10 }, 903, 40)
  let mineCell = -1
  for (let i = 0; i < lost.n; i++) if (lost.mine[i] !== 0) { mineCell = i; break }
  lost.reveal(mineCell, 0)
  const lostSnap = clone(lost.snapshot())
  const lostRestored = Game.fromSnapshot(clone(lostSnap))
  check(lostRestored !== null, '失败局面快照可恢复')
  if (lostRestored) eq(lostRestored.snapshot(), lostSnap, '失败局面恢复后 snapshot 逐字段一致')

  // 胜利快照往返
  const won = board({ w: 9, h: 9, mines: 10 }, 901, 40)
  for (let i = 0; i < won.n; i++) if (won.mine[i] === 0 && won.open[i] === 0) won.reveal(i, 0)
  const wonSnap = clone(won.snapshot())
  const wonRestored = Game.fromSnapshot(clone(wonSnap))
  check(wonRestored !== null, '胜利局面快照可恢复')
  if (wonRestored) eq(wonRestored.snapshot(), wonSnap, '胜利局面恢复后 snapshot 逐字段一致')

  // 派生计数不被信任：typeTotal / flagsOf 从 mine/flag 重算
  const tampered = clone(liveSnap)
  tampered.typeTotal = [0, 9, 9, 9, 9]
  tampered.flagsOf = [0, 7, 7, 7, 7]
  const retyped = Game.fromSnapshot(tampered)
  check(retyped !== null, '派生计数被篡改的快照仍可恢复（按数组重算）')
  if (retyped) {
    const snapMineSum = liveSnap.mine.reduce((s, v) => s + (v !== 0 ? 1 : 0), 0)
    const snapFlagSum = liveSnap.flag.reduce((s, v) => s + (v !== 0 ? 1 : 0), 0)
    eq([retyped.typeSum(), retyped.flagsTotal()], [snapMineSum, snapFlagSum], '恢复时 typeTotal / flagsOf 按 mine/flag 重算')
  }

  // fromSnapshot 不修改入参
  const pristine = clone(liveSnap)
  const inputCopy = clone(pristine)
  Game.fromSnapshot(pristine)
  eq(pristine, inputCopy, 'fromSnapshot 不修改入参对象')

  // 坏档：结构 / 一致性校验必须返回 null 且不抛错
  const base = clone(liveSnap)
  let thrown = 0
  let rejectedCases = 0
  function expectReject(name, makeBad) {
    rejectedCases++
    let bad
    try {
      bad = makeBad ? makeBad(clone(base)) : null
    } catch (err) {
      check(false, `构造坏档 ${name} 时抛异常: ${err && err.message}`)
      return
    }
    let got
    try {
      got = Game.fromSnapshot(bad)
    } catch (err) {
      thrown++
      check(false, `坏档拒绝：${name} 抛异常（应返回 null）: ${err && err.message}`)
      return
    }
    check(got === null, `坏档拒绝：${name}`)
  }
  expectReject('null', () => null)
  expectReject('非对象 42', () => 42)
  expectReject('空对象 {}', () => ({}))
  expectReject('w=0', (s) => ((s.w = 0), s))
  expectReject('w=41 超 MAX_W', (s) => ((s.w = 41), s))
  expectReject('h=31 超 MAX_H', (s) => ((s.h = 31), s))
  expectReject('mode=2 非法', (s) => ((s.mode = 2), s))
  expectReject('judgeLoose 非布尔', (s) => ((s.judgeLoose = 1), s))
  expectReject('mines=1000 超 MAX_MINES', (s) => ((s.mines = 1000), s))
  expectReject('seed=0', (s) => ((s.seed = 0), s))
  expectReject('rngA 越界', (s) => ((s.rngA = -1), s))
  expectReject('mine 值是 5', (s) => ((s.mine[0] = 5), s))
  expectReject('雷格 clue 不是 -1', (s) => {
    const k = s.mine.findIndex((v) => v !== 0)
    s.clue[k] = 3
    return s
  })
  expectReject('同一格既 open 又 flag', (s) => {
    const k = s.open.findIndex((v) => v === 0)
    s.open[k] = 1
    s.flag[k] = 2
    return s
  })
  expectReject('win=true 但 over=false', (s) => ((s.win = true), s))
  expectReject('over=true 但 boom=-1', (s) => ((s.over = true), s))
  expectReject('over 时 boom 指向非雷格', (s) => {
    s.over = true
    s.boom = s.mine.findIndex((v) => v === 0)
    s.open[s.boom] = 1
    return s
  })
  expectReject('over 时同时翻开两颗雷', (s) => {
    const ms = []
    for (let i = 0; i < s.mine.length; i++) if (s.mine[i] !== 0) ms.push(i)
    s.over = true
    s.boom = ms[0]
    s.open[ms[0]] = 1
    s.open[ms[1]] = 1
    return s
  })
  expectReject('started 但 startCell=-1', (s) => ((s.startCell = -1), s))
  expectReject('started 但 startCell 未翻开', (s) => {
    s.startCell = s.open.findIndex((v) => v === 0)
    return s
  })
  expectReject('started=false 但棋盘非空', (s) => ((s.started = false), s))
  expectReject('mine 数组长度不符', (s) => ((s.mine = s.mine.slice(0, 10)), s))
  expectReject('clue 数组长度不符', (s) => ((s.clue = s.clue.slice(0, 10)), s))
  expectReject('elapsedMs 为负', (s) => ((s.elapsedMs = -1), s))
  expectReject('moves 为负', (s) => ((s.moves = -1), s))
  expectReject('msg=6 非法', (s) => ((s.msg = 6), s))
  expectReject('msgArg 超 16 位', (s) => ((s.msgArg = 70000), s))
  expectReject('typeCount 长度不符', (s) => ((s.typeCount = [0, 1, 2]), s))
  expectReject('mines 与实际雷数不符', (s) => ((s.mines = s.mines + 1), s))
  expectReject('open 值非 0/1', (s) => ((s.open[0] = 2), s))
  expectReject('flag 值 5', (s) => {
    const k = s.flag.findIndex((v) => v === 0)
    s.flag[k] = 5
    return s
  })
  eq(thrown, 0, '所有坏档都返回 null、不抛异常')
  check(rejectedCases >= 25, `坏档拒绝用例数足够（${rejectedCases} 组 ≥ 25）`)
})

/* ==================================== 组 13：越界 / 非玩法边角 ==================================== */
suite('组 13 越界参数安全 / 库边角', () => {
  const g = board({ w: 9, h: 9, mines: 10 }, 1301, 40)
  const before = snapshotJson(g)
  g.reveal(-1, 0)
  g.reveal(g.n, 0)
  g.reveal(1e9, 0)
  g.tryExpand(-1)
  g.tryExpand(g.n)
  g.cycleFlag(-1)
  g.cycleFlag(g.n)
  g.setFlag(-1, 1)
  g.setFlag(g.n, 1)
  g.setFlag(0, 99)
  eq(snapshotJson(g), before, '越界 / 非法参数操作一律无副作用（已开局）')

  const fresh = new Game({ w: 9, h: 9, mines: 10 })
  fresh.newGame(1302)
  const freshBefore = snapshotJson(fresh)
  fresh.reveal(-1, 0)
  fresh.tryExpand(-1)
  fresh.cycleFlag(-1)
  fresh.setFlag(-1, 1)
  eq(snapshotJson(fresh), freshBefore, '越界操作在未开局时也无副作用')

  // newGame 保持 w/h/typeCount，只清棋盘与状态
  // 注意：精确配比模式下 genBoard 用 typeCount 合计当雷数（Zig: count = min(want, pool)），
  // 所以 startAt 后 mines 会变成 10，而不是构造参数 30 —— 这是权威行为，不是 bug。
  const resize = new Game({ w: 12, h: 12, mines: 30, typeCount: [0, 1, 2, 3, 4] })
  resize.newGame(1303)
  resize.startAt(70, 0)
  eq([resize.mines, resize.typeSum()], [10, 10], '精确配比模式下 mines = typeCount 合计（覆盖构造参数）')
  resize.newGame(1304)
  eq([resize.w, resize.h, resize.n], [12, 12, 144], 'newGame 保持尺寸')
  eq(Array.from(resize.typeCount), [0, 1, 2, 3, 4], 'newGame 保持 typeCount')
  eq([resize.started, resize.over, resize.win, resize.boom, resize.startCell, resize.moves], [false, false, false, -1, -1, 0], 'newGame 复位整局状态')
  eq(resize.snapshot().mine.every((v) => v === 0), true, 'newGame 清空雷')
  eq(resize.snapshot().clue.every((v) => v === -1), true, 'newGame 复位 clue = -1')
  eq(Array.from(resize.typeTotal), [0, 0, 0, 0, 0], 'newGame 清空 typeTotal')

  // 无 typeCount 时 newGame 保持构造参数里的 mines
  const plain = new Game({ w: 12, h: 12, mines: 30 })
  plain.newGame(1303)
  plain.startAt(70, 0)
  eq(plain.mines, 30, '无 typeCount 时开局雷数 = mines=30')
  plain.newGame(1304)
  eq([plain.w, plain.h, plain.mines, plain.n], [12, 12, 30, 144], '无 typeCount 时 newGame 保持尺寸与 mines')

  // 开局前 started=false、startAt 后可重复开局（新模式允许重开）
  const restart = board({ w: 9, h: 9, mines: 10 }, 1305, 40)
  const firstMine = Array.from(restart.mine.subarray(0, restart.n))
  restart.newGame(1305)
  restart.startAt(0, 0)
  check(firstMine.join() !== Array.from(restart.mine.subarray(0, restart.n)).join(), '重开可换开局格并重新布雷')
  eq([restart.started, restart.moves, restart.startCell], [true, 1, 0], 'startAt 设置 started / moves=1 / startCell')

  // elapsedMs / t0：startAt(now) 记录 t0，elapsedMs 归零
  const timed = new Game({ w: 9, h: 9, mines: 10 })
  timed.newGame(1306)
  timed.startAt(40, 987654)
  eq([timed.t0, timed.elapsedMs], [987654, 0], 'startAt 记录 t0 且 elapsedMs 归零')
})

/* ============================================ 汇总 ============================================ */
console.log('')
console.log(`引擎：${ENGINE_PATH}`)
console.log(`共 ${checks} 项断言，通过 ${checks - failures} 项，失败 ${failures} 项`)
if (failures > 0) {
  console.log('失败清单：')
  for (const n of failedNames) console.log(`  · ${n}`)
  process.exitCode = 1
} else {
  console.log('全部通过')
  process.exitCode = 0
}
