/* 对抗 / 边界审计（engine.js，只读）
 * 运行：node packages/dsh-game-complexweeper/dev/audit/edge.mjs
 * 退出码：0 = 全部通过；1 = 有失败（打印失败项）。
 *
 * 每项都写清楚依据（game.zig 行号 / selftest.zig 用例），并尽量用"独立算出来的期望值"，
 * 而不是读 engine 的实现再照抄。
 */
import {
  RefGame,
  RefRng,
  MSG as RMSG,
  TYPES,
  ACHIEVABLE,
  MAX_CELLS,
  expectedCascadeFlood,
} from './ref.mjs'

await import('../../engine.js')
const E = globalThis.CS

let checks = 0
const fails = []
function ok(cond, name, extra) {
  checks++
  if (!cond) fails.push(extra === undefined ? name : `${name} :: ${extra}`)
}

/* ------------------------- 状态比较（同 diff.mjs 口径） ------------------------- */
function stateDiff(a, b) {
  const out = []
  const chk = (n, x, y) => {
    if (x !== y) out.push(`${n}: engine=${String(x)} ref=${String(y)}`)
  }
  chk('mines', a.mines, b.mines)
  chk('seed', a.seed, b.seed)
  chk('rngA', a.rng.a, b.rng.a)
  chk('started', a.started, b.started)
  chk('over', a.over, b.over)
  chk('win', a.win, b.win)
  chk('boom', a.boom, b.boom)
  chk('startCell', a.startCell, b.startCell)
  chk('moves', a.moves, b.moves)
  chk('msg', a.msg, b.msg)
  chk('msgArg', a.msgArg, b.msgArg)
  chk('flagsTotal', a.flagsTotal(), b.flagsTotal())
  chk('openedCount', a.openedCount(), b.openedCount())
  for (let t = 0; t < 5; t++) {
    chk(`typeTotal[${t}]`, a.typeTotal[t], b.typeTotal[t])
    chk(`flagsOf[${t}]`, a.flagsOf[t], b.flagsOf[t])
  }
  for (let i = 0; i < a.n; i++) {
    if (a.mine[i] !== b.mine[i]) out.push(`mine[${i}]`)
    if (a.clue[i] !== b.clue[i]) out.push(`clue[${i}]: ${a.clue[i]} vs ${b.clue[i]}`)
    if (a.open[i] !== b.open[i]) out.push(`open[${i}]`)
    if (a.flag[i] !== b.flag[i]) out.push(`flag[${i}]`)
  }
  return out
}

const PRESETS = [
  { w: 9, h: 9, mines: 10 },
  { w: 16, h: 16, mines: 40 },
  { w: 30, h: 16, mines: 99 },
]

/* ============ 1. 首点安全区：每一个格子当作首点都成立 ============ */
{
  const shapes = [
    { w: 9, h: 9, mines: 10, cells: null },
    { w: 16, h: 16, mines: 40, cells: 'sample' },
    { w: 40, h: 30, mines: 99, cells: 'corners' },
  ]
  let samples = 0
  for (const sh of shapes) {
    const rng = new RefRng(1) // 只用来选格子
    let cells = []
    if (sh.cells === null) {
      for (let i = 0; i < sh.w * sh.h; i++) cells.push(i)
    } else if (sh.cells === 'sample') {
      for (let i = 0; i < 60; i++) cells.push(Math.floor(rng.next() * sh.w * sh.h))
    } else {
      const n = sh.w * sh.h
      cells = [0, sh.w - 1, (sh.h - 1) * sh.w, n - 1, Math.floor(sh.h / 2) * sh.w + Math.floor(sh.w / 2)]
    }
    for (const seed of [11, 222, 3333]) {
      for (const c of cells) {
        const g = new E.Game({ w: sh.w, h: sh.h, mines: sh.mines })
        const r = new RefGame({ w: sh.w, h: sh.h, mines: sh.mines })
        g.newGame(seed)
        r.newGame(seed)
        g.startAt(c, 5)
        r.startAt(c, 5)
        samples++
        const nbrCount = g.nbrs(c).length
        ok(!g.over, '首点不能立即结束', `w=${sh.w} cell=${c} seed=${seed}`)
        ok(g.isBlank(c), '首点格必须是空白格（邻域零雷）', `w=${sh.w} cell=${c} seed=${seed}`)
        ok(g.open[c] === 1, '首点格必须已翻开', `cell=${c}`)
        // 首点 + 8 邻域内绝不能有雷
        let mineInSafe = 0
        if (g.mine[c] !== 0) mineInSafe++
        for (const j of g.nbrs(c)) if (g.mine[j] !== 0) mineInSafe++
        ok(mineInSafe === 0, '首点安全区内不得有雷', `cell=${c} 有 ${mineInSafe} 颗`)
        // 首点必连片：至少"自己 + 全部邻格"（邻格是数字格就到此为止，是空白格会继续扩散）
        ok(g.openedCount() >= 1 + nbrCount, '开局连片至少 1+邻格数', `cell=${c} opened=${g.openedCount()} min=${1 + nbrCount}`)
        if (nbrCount === 8) ok(g.openedCount() >= 9, '内部首点开局至少翻 9 格', `cell=${c} opened=${g.openedCount()}`)
        let openedMine = 0
        for (let i = 0; i < g.n; i++) if (g.open[i] && g.mine[i]) openedMine++
        ok(openedMine === 0, '开局不得翻开雷')
        ok(g.typeSum() === g.mines, '开局 type_total 合计 = 实际雷数')
        ok(g.mines === sh.mines, '首点安全区足够时雷数不被 clamp', `mines=${g.mines}`)
        ok(g.startCell === c && g.started === true, 'startCell/started 正确')
        ok(g.moves === 1, 'startAt 后 moves = 1（game.zig:343）')
        const d = stateDiff(g, r)
        ok(d.length === 0, '首点局面与参照实现逐字段一致', d.slice(0, 5).join('; '))
      }
    }
  }
  console.log(`[1] 首点安全区样本：${samples}`)
}

/* ============ 2. 雷数 clamp：雷比安全区还多 ============ */
{
  // 9×9 中央首点 → 安全区 9 格 → 池 72；角落首点 → 安全区 4 格 → 池 77
  for (const [startCell, expectMines] of [[40, 72], [0, 77]]) {
    const g = new E.Game({ w: 9, h: 9, mines: 999 })
    const r = new RefGame({ w: 9, h: 9, mines: 999 })
    g.newGame(1234)
    r.newGame(1234)
    g.startAt(startCell, 0)
    r.startAt(startCell, 0)
    ok(g.mines === expectMines, `mines=999 9×9 首点${startCell} 应 clamp 到 ${expectMines}`, `实际 ${g.mines}`)
    ok(g.typeSum() === g.mines, 'clamp 后 type_total 合计一致')
    let mineCount = 0
    for (let i = 0; i < g.n; i++) if (g.mine[i] !== 0) mineCount++
    ok(mineCount === g.mines, '实际布雷数 = clamp 后雷数')
    ok(stateDiff(g, r).length === 0, 'clamp 局面与参照实现一致')
  }
  // 精确配比 want > 池 → 全部铺满安全区外
  const g = new E.Game({ w: 9, h: 9, mines: 0, typeCount: [0, 40, 40, 40, 40] })
  const r = new RefGame({ w: 9, h: 9, mines: 0, typeCount: [0, 40, 40, 40, 40] })
  g.newGame(77)
  r.newGame(77)
  g.startAt(40, 0)
  r.startAt(40, 0)
  ok(g.mines === 72, 'typeCount 总量超池时 clamp 到 72', `实际 ${g.mines}`)
  ok(g.typeSum() === 72, 'typeCount clamp 后类型合计 = 72')
  ok(stateDiff(g, r).length === 0, 'typeCount clamp 局面与参照一致')
}

/* ============ 3. 抵消对整区：显示 0 不连片 ============ */
{
  // 5×5 中央 12：邻域放 +1/−1 和 +i/−i 各一对 → a=0,b=0 → clue 0；且邻域有雷 → 非空白
  const g = new E.Game({ w: 5, h: 5, mines: 4 })
  const r = new RefGame({ w: 5, h: 5, mines: 4 })
  for (const gm of [g, r]) {
    gm.newGame(1)
    gm.mine.fill(0)
    gm.clue.fill(-1)
    gm.open.fill(0)
    gm.flag.fill(0)
    gm.mine[6] = 1
    gm.mine[7] = 2
    gm.mine[8] = 3
    gm.mine[11] = 4
    gm.computeClues()
    gm.countTypes()
    gm.open[12] = 1
  }
  ok(g.clue[12] === 0, '抵消对整区显示值应为 0', `实际 ${g.clue[12]}`)
  ok(g.isBlank(12) === false, '显示 0 不等于空白格')
  const before = Array.from(g.open.subarray(0, g.n))
  g.reveal(12, 0)
  r.reveal(12, 0)
  let opened = 0
  for (let i = 0; i < g.n; i++) if (g.open[i] && !before[i]) opened++
  ok(opened === 0, '已翻开的 0 格 reveal 无副作用（本来就开着）', `opened=${opened}`)
  // 未翻开的 0 格：只翻自己，不扩散
  for (const gm of [g, r]) gm.open[12] = 0
  g.reveal(12, 0)
  r.reveal(12, 0)
  opened = 0
  for (let i = 0; i < g.n; i++) if (g.open[i]) opened++
  ok(opened === 1, '显示 0 的格子绝不连片（只翻开自己）', `opened=${opened}`)
  ok(stateDiff(g, r).length === 0, '0 格局面与参照一致')

  // 相邻的两个 0 格（各自都不是空白）：翻开一个不许把另一个带开
  // 12 与 13 的邻域交集包含 7、8；在 7 放 +1、8 放 −1 → 两格的 a、b 都是 0
  const g2 = new E.Game({ w: 5, h: 5, mines: 2 })
  const r2 = new RefGame({ w: 5, h: 5, mines: 2 })
  for (const gm of [g2, r2]) {
    gm.newGame(2)
    gm.mine.fill(0)
    gm.clue.fill(-1)
    gm.open.fill(0)
    gm.flag.fill(0)
    gm.mine[7] = 1
    gm.mine[8] = 2
    gm.computeClues()
    gm.countTypes()
  }
  ok(g2.clue[12] === 0 && g2.clue[13] === 0, '相邻两格显示值都是 0', `12=${g2.clue[12]} 13=${g2.clue[13]}`)
  ok(g2.isBlank(12) === false && g2.isBlank(13) === false, '两格都不是空白格')
  g2.reveal(12, 0)
  r2.reveal(12, 0)
  ok(g2.open[12] === 1 && g2.open[13] === 0, '0 格不会把相邻的 0 格带开')
  ok(stateDiff(g2, r2).length === 0, '相邻 0 格局面与参照一致')
}

/* ============ 4. 24 个可达显示值 / 纯实纯虚 / 显示值范围 ============ */
{
  // 4a. 独立枚举 495 种邻域组合
  const seenC = new Set()
  const seenH = new Set()
  let combos = 0
  for (let n1 = 0; n1 <= 8; n1++)
    for (let n2 = 0; n1 + n2 <= 8; n2++)
      for (let n3 = 0; n1 + n2 + n3 <= 8; n3++)
        for (let n4 = 0; n1 + n2 + n3 + n4 <= 8; n4++) {
          combos++
          const a = n1 - n2
          const b = n3 - n4
          seenC.add(a * a + b * b)
          seenH.add(a * a - b * b)
        }
  ok(combos === 495, '邻域组合独立枚举 = 495', `实际 ${combos}`)
  ok(seenC.size === 24, '圆复数可达显示值 = 24', `实际 ${seenC.size}`)
  ok(JSON.stringify([...seenC].sort((x, y) => x - y)) === JSON.stringify([...E.ACHIEVABLE].sort((x, y) => x - y)), '24 值与引擎 ACHIEVABLE 完全一致')
  ok(seenH.size === 39, 'hyper 可达显示值 = 39', `实际 ${seenH.size}`)

  // 4b. 随机盘面：所有非雷格显示值必须落在可达集合内
  const hyperSet = new Set(seenH)
  let clueSamples = 0
  for (const cfg of PRESETS.concat([{ w: 40, h: 30, mines: 99 }])) {
    for (const seed of [7, 77, 777, 7777]) {
      const g = new E.Game(cfg)
      g.newGame(seed)
      g.startAt((g.n >> 1), 0)
      for (let i = 0; i < g.n; i++) {
        if (g.mine[i] !== 0) {
          ok(g.clue[i] === -1, '雷格 clue 必须是 −1')
          continue
        }
        clueSamples++
        ok(seenC.has(g.clue[i]), '圆复数显示值必须在 24 值集合内', `clue=${g.clue[i]} cell=${i}`)
        ok(g.clue[i] >= 0 && g.clue[i] <= 64, '圆复数显示值范围 0..64')
      }
    }
  }
  const gh = new E.Game({ w: 12, h: 12, mines: 40, mode: E.MODE_HYPER })
  gh.newGame(99)
  gh.startAt(70, 0)
  for (let i = 0; i < gh.n; i++) {
    if (gh.mine[i] !== 0) continue
    clueSamples++
    ok(hyperSet.has(gh.clue[i]), 'hyper 显示值必须在独立枚举的 39 值内', `clue=${gh.clue[i]}`)
    ok(gh.clue[i] >= -64 && gh.clue[i] <= 64, 'hyper 显示值范围 −64..64')
  }
  console.log(`[4] 显示值样本：${clueSamples} 格`)

  // 4c. 纯实 / 纯虚：所有显示值是完全平方数
  for (const tc of [[0, 5, 5, 0, 0], [0, 0, 0, 4, 4], [0, 12, 0, 0, 0], [0, 0, 0, 12, 0]]) {
    for (const seed of [3, 33, 333]) {
      const sum = tc[1] + tc[2] + tc[3] + tc[4]
      const g = new E.Game({ w: 12, h: 12, mines: sum, typeCount: tc })
      g.newGame(seed)
      g.startAt(70, 0)
      let bad = 0
      for (let i = 0; i < g.n; i++) {
        if (g.mine[i] !== 0) continue
        const r = Math.round(Math.sqrt(g.clue[i]))
        if (r * r !== g.clue[i]) bad++
      }
      ok(bad === 0, '纯实/纯虚局面所有显示值必须是完全平方数', `配比 ${tc.join('/')} seed=${seed} 坏格 ${bad}`)
      ok(g.typeSum() === sum, '精确配比：type_total 合计 = 请求', `配比 ${tc.join('/')}`)
      for (let t = 1; t <= 4; t++) ok(g.typeTotal[t] === tc[t], `精确配比恰好命中第 ${t} 类`, `want=${tc[t]} got=${g.typeTotal[t]}`)
    }
  }
}

/* ============ 5. 40×30 大连片（栈边界）：与独立洪水填充逐格一致 ============ */
{
  const shapes = [
    { w: 40, h: 30, m: 1 },
    { w: 40, h: 30, m: 5 },
    { w: 40, h: 30, m: 20 },
    { w: 40, h: 30, m: 60 },
    { w: 30, h: 30, m: 60 },
  ]
  let samples = 0
  let big = 0
  let worst = 0
  let mismatch = 0
  for (const sh of shapes) {
    const starts = [
      0,
      (sh.h - 1) * sh.w,
      sh.w - 1,
      sh.w * sh.h - 1,
      Math.floor(sh.h / 2) * sh.w + Math.floor(sh.w / 2),
    ]
    for (const seed of [4111, 4127, 4133, 4139]) {
      for (const st of starts) {
        const g = new E.Game({ w: sh.w, h: sh.h, mines: sh.m })
        g.newGame(seed)
        g.startAt(st, 0)
        const want = expectedCascadeFlood(g, st)
        samples++
        for (let i = 0; i < g.n; i++) {
          if ((g.open[i] !== 0) !== (want[i] === 1)) mismatch++
          if (g.open[i] && g.mine[i]) mismatch++
        }
        const oc = g.openedCount()
        if (oc > worst) worst = oc
        if (oc >= 400) big++
      }
    }
  }
  ok(samples >= 72, '大盘连片样本数足够', `实际 ${samples}`)
  ok(mismatch === 0, '大盘开局连片与独立洪水填充逐格一致', `不一致 ${mismatch}`)
  ok(big >= 8, '样本里应有真正的大连片（≥400 格）', `实际 ${big}`)
  console.log(`[5] 大盘连片：${samples} 样本，≥400 格 ${big} 次，最多翻开 ${worst} 格`)
}

/* ============ 6. 插旗后首点：旗保留、被旗保护的首点不翻开 ============ */
{
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  const r = new RefGame({ w: 9, h: 9, mines: 10 })
  for (const gm of [g, r]) {
    gm.newGame(5)
    gm.cycleFlag(0) // 开局前插旗（原版 main.zig:1374 注明允许）
    gm.cycleFlag(10)
  }
  ok(g.flagsTotal() === 2, '开局前可以插旗（不限量）')
  g.startAt(40, 0)
  r.startAt(40, 0)
  ok(g.flag[0] === 1 && g.flag[10] === 1, '首点后旗帜保留（genBoard 不清 flag，同 game.zig:175-181）', `flag0=${g.flag[0]} flag10=${g.flag[10]}`)
  ok(stateDiff(g, r).length === 0, '带旗开局局面与参照一致')
  ok(g.flagsTotal() === 2, '带旗开局 flagsOf 计数正确')

  // 对带旗格 startAt：Zig 会生成棋盘但 cascadeOpen 跳过该格（只可能由 API 直接调用造成）
  const gf = new E.Game({ w: 9, h: 9, mines: 10 })
  const rf = new RefGame({ w: 9, h: 9, mines: 10 })
  for (const gm of [gf, rf]) {
    gm.newGame(5)
    gm.setFlag(40, 1)
    gm.startAt(40, 0)
  }
  ok(gf.started === true && gf.open[40] === 0, '对已插旗格 startAt：棋盘生成但首点格不被 cascadeOpen 翻开（同 Zig）')
  ok(stateDiff(gf, rf).length === 0, 'API-only 带旗首点局面与参照一致')
}

/* ============ 7. 判据通过但旗插错位置 → 踩雷判负 ============ */
{
  // 5×5 中央 12：真值只有 6 号格是 +i（a=0,b=1），显示值 1
  // 旗：一面 +i 插在 7 号（安全格）→ 总旗数 1 = 雷数 1，旗的 (gp,gv)=(0,1) 与真值 (P,V)=(0,1) 一致 → 判据通过
  const g = new E.Game({ w: 5, h: 5, mines: 1 })
  const r = new RefGame({ w: 5, h: 5, mines: 1 })
  for (const gm of [g, r]) {
    gm.newGame(3)
    gm.mine.fill(0)
    gm.clue.fill(-1)
    gm.open.fill(0)
    gm.flag.fill(0)
    gm.mine[6] = 3
    gm.computeClues()
    gm.countTypes()
    gm.open[12] = 1
    gm.setFlag(7, 3)
  }
  ok(g.clue[12] === 1, '真值 a=0,b=1 → 显示值 1')
  ok(g.matchComboTruth(12) === true, '旗数对、实虚比例对（虽然插在错误格）→ 判据必须通过')
  g.tryExpand(12)
  r.tryExpand(12)
  ok(g.over === true && g.win === false, '判据通过但邻域有雷 → 必须判负')
  ok(g.boom === 6, 'boom 应记录真实踩中的雷格 6', `实际 ${g.boom}`)
  ok(g.msg === E.MSG.LOSE, 'msg = lose')
  ok(g.open[6] === 1, '踩中的雷格被翻开')
  ok(g.moves === 0, '踩雷路径不增加 moves（game.zig:440-445 提前 return；本局面是手工构造的 moves=0）', `moves=${g.moves}`)
  ok(stateDiff(g, r).length === 0, '踩雷局面与参照一致')

  // 判据不过：棋盘完全不变 + msg = judge_fail（这是 Zig 给的反馈信号）
  // 真值：6 放 +1、7 放 +i → (P,V)=(1,1)，共 2 颗；旗：8、11 各插一面 +1 → (gp,gv)=(2,0)
  // 总数 2=2，但 2:0 既不是 1:1 也不是它的倒置 → 拒绝
  const g2 = new E.Game({ w: 5, h: 5, mines: 2 })
  const r2 = new RefGame({ w: 5, h: 5, mines: 2 })
  for (const gm of [g2, r2]) {
    gm.newGame(4)
    gm.mine.fill(0)
    gm.clue.fill(-1)
    gm.open.fill(0)
    gm.flag.fill(0)
    gm.mine[6] = 1
    gm.mine[7] = 3
    gm.computeClues()
    gm.countTypes()
    gm.open[12] = 1
    gm.setFlag(8, 1)
    gm.setFlag(11, 1)
  }
  ok(g2.matchComboTruth(12) === false, '旗数对但实虚比例错 → 判据不通过')
  const openBefore = Array.from(g2.open.subarray(0, g2.n))
  const flagBefore = Array.from(g2.flag.subarray(0, g2.n))
  g2.tryExpand(12)
  r2.tryExpand(12)
  let changed = false
  for (let i = 0; i < g2.n; i++) if (g2.open[i] !== openBefore[i] || g2.flag[i] !== flagBefore[i]) changed = true
  ok(!changed, '判据不通过时棋盘（open/flag）完全不变')
  ok(g2.msg === E.MSG.JUDGE_FAIL, '判据不通过必须给 judge_fail 反馈（UI 要显示）')
  ok(g2.moves === 0, '判据不通过不增加 moves（Zig tryExpand 提前 return）', `moves=${g2.moves}`)
  ok(stateDiff(g2, r2).length === 0, '判据失败局面与参照一致')
}

/* ============ 8. msgArg 怪癖（Zig 的 setMsg 清零） ============ */
{
  const g = new E.Game({ w: 5, h: 5, mines: 1 })
  g.newGame(6)
  g.mine.fill(0); g.clue.fill(-1); g.open.fill(0); g.flag.fill(0)
  g.mine[6] = 1
  g.computeClues(); g.countTypes()
  g.open[12] = 1
  g.setFlag(6, 1)
  g.tryExpand(12)
  ok(g.msg === E.MSG.EXPAND_OK || g.win, '判据通过 → expand_ok（或直接判胜）')
  ok(g.msgArg === 0, 'Zig 里 setMsg(.expand_ok) 会把 msg_arg 清零 → msgArg 恒为 0（忠实移植，不是 bug）', `msgArg=${g.msgArg}`)
}

/* ============ 9. 胜利判定：翻开所有非雷格（与旗无关） ============ */
{
  for (const cfg of PRESETS) {
    const g = new E.Game(cfg)
    g.newGame(901)
    g.startAt(40 < g.n ? 40 : 0, 0)
    // 给所有雷插"错类型"的旗：旗不参与胜利判定，但也不能挡住非雷格
    for (let i = 0; i < g.n; i++) if (g.mine[i] !== 0) g.setFlag(i, (g.mine[i] % 4) + 1)
    const allWrong = () => {
      for (let i = 0; i < g.n; i++) if (g.mine[i] !== 0 && g.flag[i] === g.mine[i]) return false
      return true
    }
    ok(allWrong(), '测试前提：所有旗都是错类型')
    for (let i = 0; i < g.n; i++) if (g.mine[i] === 0 && !g.open[i]) g.reveal(i, 0)
    ok(g.win === true && g.over === true, '翻开全部非雷格 → 胜利（旗全错也算赢）', `cfg=${JSON.stringify(cfg)}`)
    ok(g.msg === E.MSG.WIN, '胜利 msg = win')
    ok(g.boom === -1, '胜利时 boom = −1')
    ok(g.correctFlags() === 0, '复盘：全错旗时 correctFlags = 0')
    // 少翻一格不判胜
    const g2 = new E.Game(cfg)
    g2.newGame(902)
    g2.startAt(40 < g2.n ? 40 : 0, 0)
    let left = -1
    for (let i = 0; i < g2.n; i++) if (g2.mine[i] === 0 && !g2.open[i]) { left = i; break }
    for (let i = 0; i < g2.n; i++) if (i !== left && g2.mine[i] === 0 && !g2.open[i]) g2.reveal(i, 0)
    ok(g2.win === false && g2.over === false, '还剩非雷格未翻开 → 不能判胜')
    ok(g2.msg !== E.MSG.WIN, '未判胜时 msg 不是 win')
  }
}

/* ============ 10. lose 之后继续操作无副作用（over 后的门禁） ============ */
{
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(903)
  g.startAt(40, 0)
  let mine = -1
  for (let i = 0; i < g.n; i++) if (g.mine[i] !== 0) { mine = i; break }
  g.reveal(mine, 0)
  ok(g.over === true && g.boom === mine, '翻雷判负')
  const snap = JSON.stringify(g.snapshot())
  const beforeOpened = g.openedCount()
  const beforeMoves = g.moves
  for (let i = 0; i < g.n; i++) {
    g.reveal(i, 0)
    g.tryExpand(i)
    g.cycleFlag(i)
  }
  ok(g.openedCount() === beforeOpened, 'over 后 reveal/tryExpand 不改变棋盘')
  ok(g.moves === beforeMoves, 'over 后这些操作不增加 moves')
  ok(g.msg === E.MSG.LOSE, 'over 后 msg 仍是 lose')
  ok(JSON.stringify(g.snapshot()) === snap, '连续 over 后操作后快照不变（除 setFlag 外）')
  // setFlag 在 Zig 里没有 over 检查 → 仍然生效（忠实移植，记 NOTE）
  ok(g.setFlag(0, 2) === true, 'setFlag 在 over 后仍生效（game.zig:348-356 没有 over 检查）')
  ok(g.flagsOf[2] === 1, 'over 后 setFlag 的计数仍然维护')
}

/* ============ 11. 插旗不限量 / 循环顺序 / 旗保护 ============ */
{
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(701)
  g.startAt(40, 0)
  let placed = 0
  for (let i = 0; i < g.n; i++) {
    if (g.open[i]) continue
    if (g.setFlag(i, 1)) placed++
  }
  ok(g.flagsTotal() === placed, '插旗不限量且 flagsTotal 计数正确', `placed=${placed} flagsTotal=${g.flagsTotal()}`)
  ok(g.unmarked(1) < 0, '插超后 unmarked 为负', `unmarked=${g.unmarked(1)}`)
  // 循环顺序
  let cell = -1
  for (let i = 0; i < g.n; i++) if (!g.open[i]) { cell = i; break }
  g.setFlag(cell, 0)
  const seq = []
  for (let k = 0; k < 6; k++) { g.cycleFlag(cell); seq.push(g.flag[cell]) }
  ok(JSON.stringify(seq) === JSON.stringify([1, 2, 3, 4, 0, 1]), '右键循环 空→+1→−1→+i→−i→空', `实际 ${seq.join(',')}`)
  // 旗保护：插旗格不能 reveal，cascade 也不碰
  g.setFlag(cell, 3)
  const oc = g.open[cell]
  g.reveal(cell, 0)
  ok(g.open[cell] === oc && g.flag[cell] === 3, '插旗格 reveal 无效且旗保留')
  ok(g.flagsOf[3] >= 1, 'flagsOf 计数正确')
  // 已翻开格 cycleFlag 无效
  let openedSafe = -1
  for (let i = 0; i < g.n; i++) if (g.open[i] && g.mine[i] === 0) { openedSafe = i; break }
  const f0 = g.flag[openedSafe]
  ok(g.cycleFlag(openedSafe) === false && g.flag[openedSafe] === f0, '已翻开格不能插旗')
  // setFlag 边界值
  ok(g.setFlag(0, 5) === false, 'setFlag t=5 拒绝')
  ok(g.setFlag(-1, 1) === false, 'setFlag 负索引安全拒绝')
  ok(g.setFlag(g.n, 1) === false, 'setFlag 越界安全拒绝')
  ok(g.setFlag(0, -1) === false, 'setFlag t=−1 拒绝（JS 侧扩展；Zig 参数是 u8）')
  ok(g.setFlag(0, 2.5) === false, 'setFlag 非整数 t 拒绝（JS 侧扩展）')
  ok(g.setFlag(0, 1.0) === true, 'setFlag t=1.0（整数值）接受')
}

/* ============ 12. 越界 API 安全（JS 扩展：Zig 会越界 panic） ============ */
{
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(1)
  g.startAt(40, 0)
  const snap = JSON.stringify(g.snapshot())
  g.reveal(-1, 0); g.reveal(9999, 0)
  g.tryExpand(-5); g.tryExpand(9999)
  g.cycleFlag(-1); g.cycleFlag(9999)
  g.setFlag(-1, 1); g.setFlag(9999, 1)
  ok(g.cascadeOpen([-1, 9999]) === 0, 'cascadeOpen 越界种子安全忽略')
  ok(JSON.stringify(g.snapshot()) === snap, '越界调用后状态完全不变')
  ok(g.inb(0, 0) === true && g.inb(-1, 0) === false && g.inb(0, 9) === false, 'inb 边界正确')
}

/* ============ 13. 确定性：同种子同首点 = 同棋盘；不同种子不同 ============ */
{
  const a = new E.Game({ w: 16, h: 16, mines: 40 })
  const b = new E.Game({ w: 16, h: 16, mines: 40 })
  const c = new E.Game({ w: 16, h: 16, mines: 40 })
  for (const [g, seed] of [[a, 12345], [b, 12345], [c, 999]]) {
    g.newGame(seed)
    g.startAt(100, 0)
  }
  ok(JSON.stringify(a.snapshot().mine) === JSON.stringify(b.snapshot().mine), '同种子 + 同首点 → 完全相同棋盘')
  ok(JSON.stringify(a.snapshot().mine) !== JSON.stringify(c.snapshot().mine), '不同种子 → 不同棋盘')
  // startAt 会 setSeed(seed) 重置 rng：连续两次 startAt 同格 → 同棋盘
  const d = new E.Game({ w: 16, h: 16, mines: 40 })
  d.newGame(12345)
  d.startAt(100, 0)
  const first = JSON.stringify(d.snapshot().mine)
  d.startAt(100, 0)
  ok(JSON.stringify(d.snapshot().mine) === first, 'startAt 每次都 setSeed(seed)（game.zig:335）→ 重开同格棋盘一致')
  // 种子 0 → 1
  const e0 = new E.Game({ w: 9, h: 9, mines: 10 })
  e0.newGame(0)
  ok(e0.seed === 1, '种子 0 被改成 1（game.zig:147）')
}

/* ============ 14. 判据矩阵：engine vs 从 game.zig 独立推导的公式 ============ */
{
  // 5×5 中央 12 的 8 个邻格（顺序同 nbrs(12)）
  const g = new E.Game({ w: 5, h: 5, mines: 0 })
  const NB = g.nbrs(12)
  ok(NB.length === 8, '中央格有 8 个邻格')
  ok(JSON.stringify(NB) === JSON.stringify([6, 7, 8, 11, 13, 16, 17, 18]), '邻格顺序（行优先 dr/dc）', NB.join(','))

  // 枚举 0..8 颗雷分四类的所有组合
  const truthCombos = []
  for (let n1 = 0; n1 <= 8; n1++)
    for (let n2 = 0; n1 + n2 <= 8; n2++)
      for (let n3 = 0; n1 + n2 + n3 <= 8; n3++)
        for (let n4 = 0; n1 + n2 + n3 + n4 <= 8; n4++) truthCombos.push([n1, n2, n3, n4])
  ok(truthCombos.length === 495, '真值组合数 = 495')

  // 独立公式（直接照 game.zig:390-413 写，不 import 任何引擎代码）
  function judge(mode, loose, truth, got) {
    const nbMine = truth[0] + truth[1] + truth[2] + truth[3]
    const nbFlag = got[0] + got[1] + got[2] + got[3]
    if (nbMine !== nbFlag) return false
    let ta = 0, tb = 0, fa = 0, fb = 0
    for (let t = 1; t <= 4; t++) {
      ta += truth[t - 1] * TYPES[t - 1][0]
      tb += truth[t - 1] * TYPES[t - 1][1]
      fa += got[t - 1] * TYPES[t - 1][0]
      fb += got[t - 1] * TYPES[t - 1][1]
    }
    if (mode === 1) {
      if (loose) return ta * ta - tb * tb === fa * fa - fb * fb
      return Math.abs(fa) === Math.abs(ta) && Math.abs(fb) === Math.abs(tb)
    }
    const P = truth[0] + truth[1]
    const V = truth[2] + truth[3]
    const gp = got[0] + got[1]
    const gv = got[2] + got[3]
    return gp + gv === P + V && ((gp === P && gv === V) || (gp === V && gv === P))
  }

  function place(gm, truth, got) {
    for (let i = 0; i < 25; i++) { gm.mine[i] = 0; gm.flag[i] = 0; gm.open[i] = 0; gm.clue[i] = -1 }
    let slot = 0
    for (let t = 1; t <= 4; t++) for (let k = 0; k < truth[t - 1]; k++) gm.mine[NB[slot++]] = t
    slot = 0
    for (let t = 1; t <= 4; t++) for (let k = 0; k < got[t - 1]; k++) gm.flag[NB[slot++]] = t
  }

  let comparisons = 0
  let passed = 0
  // 真值固定 → 只枚举总旗数相同的旗组合（正例路径）；再加少量总旗数不同的（负例）
  for (const truth of truthCombos) {
    const total = truth[0] + truth[1] + truth[2] + truth[3]
    place(g, truth, [0, 0, 0, 0])
    for (const got of truthCombos) {
      const gt = got[0] + got[1] + got[2] + got[3]
      if (gt !== total) continue
      place(g, truth, got)
      for (const [mode, loose] of [[0, false], [1, false], [1, true]]) {
        g.mode = mode
        g.judgeLoose = loose
        const want = judge(mode, loose, truth, got)
        const real = g.matchComboTruth(12)
        comparisons++
        if (want !== real) fails.push(`判据矩阵不一致 truth=${truth} got=${got} mode=${mode} loose=${loose} want=${want} got=${real}`)
        if (want) passed++
      }
    }
    // 总旗数不同的负例（各取 8 个）
    for (let k = 0; k < 8; k++) {
      const got = truthCombos[(total * 97 + k * 13 + 5) % truthCombos.length]
      place(g, truth, got)
      for (const [mode, loose] of [[0, false], [1, false], [1, true]]) {
        g.mode = mode
        g.judgeLoose = loose
        const want = judge(mode, loose, truth, got)
        const real = g.matchComboTruth(12)
        comparisons++
        if (want !== real) fails.push(`判据矩阵（不同旗数）不一致 truth=${truth} got=${got} mode=${mode}`)
      }
    }
  }
  ok(comparisons >= 50000, '判据矩阵对照次数足够', `实际 ${comparisons}`)
  ok(passed > 0, '判据矩阵里应有放行的组合（否则判据全拒）', `放行 ${passed}`)
  console.log(`[14] 判据矩阵：${comparisons} 次对照（模式 complex/hyper/loose）`)
}

/* ============ 15. 「实虚比例倒置也放行」专项 ============ */
{
  const g = new E.Game({ w: 5, h: 5, mines: 2 })
  function setup(truth, got) {
    for (let i = 0; i < 25; i++) { g.mine[i] = 0; g.flag[i] = 0; g.open[i] = 0; g.clue[i] = -1 }
    const nb = g.nbrs(12)
    let s = 0
    for (let t = 1; t <= 4; t++) for (let k = 0; k < truth[t - 1]; k++) g.mine[nb[s++]] = t
    s = 0
    for (let t = 1; t <= 4; t++) for (let k = 0; k < got[t - 1]; k++) g.flag[nb[s++]] = t
  }
  // 真值 P=1,V=1（+1 与 +i）；旗：+1 旗 + (−i) 旗 → 仍是 gp=1,gv=1 但符号不同
  setup([1, 0, 1, 0], [1, 0, 0, 1])
  ok(g.matchComboTruth(12) === true, '符号不要求：真值(+1,+i)，旗(+1,−i) → 通过')
  // 真值 P=2,V=1；旗：实部 1 虚部 2（比例倒置）→ 通过
  setup([2, 0, 1, 0], [1, 0, 2, 0])
  ok(g.matchComboTruth(12) === true, '实虚比例倒置（2:1 vs 1:2）→ 必须放行')
  // 真值 P=2,V=1；旗：实部 2 虚部 1（一致）→ 通过
  setup([2, 0, 1, 0], [2, 0, 1, 0])
  ok(g.matchComboTruth(12) === true, '比例一致 → 放行')
  // 真值 P=2,V=1；旗：实部 3 虚部 0（总数同 3，比例 3:0）→ 拒绝
  setup([2, 0, 1, 0], [3, 0, 0, 0])
  ok(g.matchComboTruth(12) === false, '总数对但比例既非正也非倒置 → 拒绝')
  // 纯实真值 / 纯虚旗（0:2 vs 2:0 视为倒置）→ 放行
  setup([1, 1, 0, 0], [0, 0, 1, 1])
  ok(g.matchComboTruth(12) === true, '纯实真值 / 纯虚旗（0:2 vs 2:0）→ 放行')
  // 总数不同 → 拒绝（即使比例相同）
  setup([2, 0, 1, 0], [2, 0, 0, 0])
  ok(g.matchComboTruth(12) === false, '总旗数 ≠ 真实雷数 → 拒绝')
}

/* ============ 16. hyper 判据：推荐 / 备选两档（对照 selftest.zig §11c） ============ */
{
  const g = new E.Game({ w: 5, h: 5, mines: 2, mode: E.MODE_HYPER })
  function place(truth, got) {
    for (let i = 0; i < 25; i++) { g.mine[i] = 0; g.flag[i] = 0; g.open[i] = 0; g.clue[i] = -1 }
    const nb = g.nbrs(12)
    let s = 0
    for (let t = 1; t <= 4; t++) for (let k = 0; k < truth[t - 1]; k++) g.mine[nb[s++]] = t
    s = 0
    for (let t = 1; t <= 4; t++) for (let k = 0; k < got[t - 1]; k++) g.flag[nb[s++]] = t
    g.computeClues()
    g.countTypes()
  }
  // 真值 {1,0,1,0}：+1 & +j，clue = 1²−1² = 0
  place([1, 0, 1, 0], [1, 0, 1, 0])
  ok(g.clue[12] === 0, 'hyper：+1 与 +j 的显示值 = 0')
  ok(g.matchComboTruth(12) === true, 'hyper 推荐判据：旗与真值一致 → 通过')
  place([1, 0, 1, 0], [0, 1, 0, 1])
  ok(g.matchComboTruth(12) === true, 'hyper 推荐判据：a、b 各自取负（四种符号组合）→ 通过')
  place([1, 0, 1, 0], [1, 1, 0, 0])
  ok(g.matchComboTruth(12) === false, 'hyper 推荐判据：|a|、|b| 不相符 → 拒绝')
  g.judgeLoose = true
  ok(g.matchComboTruth(12) === true, 'hyper 备选判据：同旗数且 a²−b² 相同 → 通过')
  g.judgeLoose = false
  // 真值 2 颗（+1 与 +j），只有 1 面旗 → 旗数不符
  place([1, 0, 1, 0], [1, 0, 0, 0])
  ok(g.matchComboTruth(12) === false, 'hyper：旗数与真实雷数不符 → 拒绝（两档判据都一样）')
  g.judgeLoose = true
  ok(g.matchComboTruth(12) === false, 'hyper 备选判据：旗数不符同样拒绝')
  g.judgeLoose = false
  place([2, 0, 0, 0], [1, 1, 0, 0])
  ok(g.matchComboTruth(12) === false, 'hyper：旗数 2=2 但 |a| 不同（2 vs 0）→ 拒绝')
  // hyper 展开：判据过 → expand_ok / 或直接判胜；不踩雷
  place([1, 0, 1, 0], [1, 0, 1, 0])
  for (let i = 0; i < 25; i++) g.open[i] = 0
  g.open[12] = 1
  g.over = false; g.win = false; g.boom = -1
  g.tryExpand(12)
  ok(g.msg === E.MSG.EXPAND_OK || g.win === true, 'hyper 判据通过后展开应报 expand_ok')
  ok(g.boom < 0, 'hyper 邻域雷都插了旗 → 展开不踩雷')
}

/* ============ 17. 统计函数 / splitEvenly ============ */
{
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(1)
  g.startAt(40, 0)
  ok(g.safeCount() + g.mines === g.n, 'safeCount + mines = n（无重复计数）')
  ok(g.correctFlags() === 0, '未插旗时 correctFlags = 0')
  let correct = 0
  for (let i = 0; i < g.n; i++) if (g.mine[i] !== 0) { g.setFlag(i, g.mine[i]); correct++ }
  ok(g.correctFlags() === correct, 'correctFlags：旗类型与真雷类型一致才算对')
  // 故意把一面旗换成错类型
  let m = -1
  for (let i = 0; i < g.n; i++) if (g.mine[i] !== 0) { m = i; break }
  g.setFlag(m, (g.mine[m] % 4) + 1)
  ok(g.correctFlags() === correct - 1, '旗类型错 → correctFlags 减一')
  for (let total = 0; total <= 1200; total++) {
    const a = E.splitEvenly(total)
    const sum = a[1] + a[2] + a[3] + a[4]
    ok(sum === total, `splitEvenly(${total}) 合计必须等于 total`, `实际 ${sum}`)
    ok(a[1] >= a[2] && a[2] >= a[3] && a[3] >= a[4] && a[1] - a[4] <= 1, `splitEvenly(${total}) 必须尽量均分`, `${a}`)
    ok(a[0] === 0, 'splitEvenly 下标 0 恒为 0')
  }
}

/* ============ 18. 存档 snapshot 的 JSON 安全性 ============ */
{
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(4242)
  g.startAt(40, 0)
  g.elapsedMs = 12345
  g.cycleFlag(0)
  const snap = g.snapshot()
  ok(typeof snap === 'object' && snap !== null, 'snapshot 返回对象')
  for (const k of ['w', 'h', 'mode', 'judgeLoose', 'seed', 'rngA', 'mines', 'typeCount', 'mine', 'clue', 'open', 'flag', 'started', 'over', 'win', 'boom', 'startCell', 'elapsedMs', 'moves', 'typeTotal', 'flagsOf', 'msg', 'msgArg']) {
    ok(Object.prototype.hasOwnProperty.call(snap, k), `snapshot 必须含字段 ${k}`)
  }
  ok(snap.mine.length === g.n && snap.clue.length === g.n && snap.open.length === g.n && snap.flag.length === g.n, 'snapshot 数组按 n 截断')
  const text = JSON.stringify(snap)
  ok(typeof text === 'string' && text.length > 0, 'snapshot 可以 JSON 序列化')
  ok(JSON.parse(text).mine.length === g.n, 'JSON 往返后数组长度不变')
  const back = E.Game.fromSnapshot(JSON.parse(text))
  ok(back !== null, '自己的快照必须能被 fromSnapshot 接受（合法局面）')
  ok(back.mines === g.mines && back.seed === g.seed && back.rng.a === g.rng.a, '往返后 mines/seed/rng 一致')
  ok(back.elapsedMs === 12345, '往返后 elapsedMs 保留')
  ok(back.flagsOf[1] === g.flagsOf[1] && back.flagsTotal() === g.flagsTotal(), '往返后 flagsOf 重算一致')
}

/* ---------------------------------- 汇总 ---------------------------------- */
console.log(`edge: ${checks - fails.length} 项通过 / ${checks} 项；失败 ${fails.length}`)
if (fails.length) {
  for (const f of fails.slice(0, 40)) console.error('FAIL: ' + f)
  process.exit(1)
}
console.log('EDGE OK')
