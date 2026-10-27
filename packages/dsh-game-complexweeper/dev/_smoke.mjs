/* Lead 引擎快速冒烟测试
 * —— 移植初版时逐条对照 game.zig 写的独立快速检查（含 3100+ 断言），
 *    不是完整回归；完整回归见 dev/selftest.mjs 与 dev/diff-model.mjs。
 * 运行：node dev/_smoke.mjs
 */
import assert from 'node:assert/strict'
import '../engine.js'
const E = globalThis.CS
assert.ok(E, 'engine global CS missing')
const { Game, splitEvenly, MSG } = E

let checks = 0
function ok(cond, msg) {
  checks++
  assert.ok(cond, msg)
}
function eq(a, b, msg) {
  checks++
  assert.deepEqual(a, b, msg)
}

/* ---- 1. 确定性 + 开局 ---- */
{
  const a = new Game({ w: 16, h: 16, mines: 40 })
  a.newGame(12345)
  a.startAt(100, 0)
  const b = new Game({ w: 16, h: 16, mines: 40 })
  b.newGame(12345)
  b.startAt(100, 0)
  eq(a.snapshot().mine, b.snapshot().mine, '同种子同开局格棋盘一致')
  const c = new Game({ w: 16, h: 16, mines: 40 })
  c.newGame(999)
  c.startAt(100, 0)
  ok(a.snapshot().mine.join() !== c.snapshot().mine.join(), '不同种子棋盘不同')
  ok(a.started && !a.over, '开局后 started')
  ok(a.isBlank(100), '首点格必为空白格')
  ok(a.openedCount() >= 9, '开局必连片 >= 9 格')
  ok(a.typeSum() === 40, '类型合计 = 总雷数')
  for (let t = 1; t <= 4; t++) {
    ok(a.unmarked(t) === a.typeTotal[t], '开局未标记数 = 类型总数')
    ok(a.typeTotal[t] > 0, '40 雷时四类都应有雷')
  }
  ok(a.flagsTotal() === 0, '开局无旗')
}

/* ---- 2. 线索计算：手算对照 ---- */
{
  // 5x5，中央格 12 周围摆雷
  const g = new Game({ w: 5, h: 5, mines: 8 })
  g.newGame(1)
  const place = (cell, t) => { g.mine[cell] = t }
  // 12 的 8 邻域：6,7,8,11,13,16,17,18
  place(6, 1); place(7, 1); place(8, 2)   // a=1, b=0 -> clue 1
  g.computeClues()
  ok(g.clue[12] === 1, '两正实一负实 => a=1 => clue 1')
  // +1 与 +i：a=1, b=1 -> 2
  g.mine.fill(0); g.clue.fill(-1)
  place(6, 1); place(7, 3)
  g.computeClues()
  ok(g.clue[12] === 2, '+1 +i => 1+1=2')
  // +1 +(-1)：抵消 -> 0
  g.mine.fill(0); g.clue.fill(-1)
  place(6, 1); place(7, 2)
  g.computeClues()
  ok(g.clue[12] === 0, '抵消对 => 0')
  ok(g.clue[12] !== -1, '非雷格 clue 有效')
  // 全空 => 0 且 isBlank
  g.mine.fill(0); g.clue.fill(-1)
  g.computeClues()
  ok(g.clue[12] === 0 && g.isBlank(12), '全空 => clue 0 且 blank')
  // 雷格 clue 恒 -1
  g.mine[0] = 4
  g.computeClues()
  ok(g.clue[0] === -1, '雷格 clue = -1')
}

/* ---- 3. 展开判据 ---- */
{
  const g = new Game({ w: 5, h: 5, mines: 8 })
  g.newGame(2)
  const clear = () => {
    g.mine.fill(0); g.flag.fill(0); g.open.fill(0); g.clue.fill(-1)
    g.typeTotal.fill(0); g.flagsOf.fill(0)
  }
  // 真值：+1 +i => P=1 V=1（总数 2）
  clear(); g.mine[6] = 1; g.mine[7] = 3; g.computeClues(); g.countTypes()
  g.flag[6] = 1; g.flag[7] = 3; g.recountFlags()
  ok(g.matchComboTruth(12) === true, '实虚比例一致 => 通过')
  g.flag[6] = 3; g.flag[7] = 1; g.recountFlags()
  ok(g.matchComboTruth(12) === true, '实虚比例倒置 => 通过（符号/交换不要求）')
  g.flag[6] = 1; g.flag[7] = 2; g.recountFlags() // 总旗数 2，实部 2、虚部 0
  ok(g.matchComboTruth(12) === false, '总旗数对但比例错 => 拒绝')
  g.flag[7] = 0; g.recountFlags() // 只插 1 面
  ok(g.matchComboTruth(12) === false, '总旗数不对 => 拒绝')
  // truth: +1 +1 => P=2 V=0；旗: +i +i => gp=0 gv=2 => 通过（比例 0:2 vs 2:0 视为倒置）
  clear(); g.mine[6] = 1; g.mine[7] = 1; g.computeClues(); g.countTypes()
  g.flag[6] = 3; g.flag[7] = 3; g.recountFlags()
  ok(g.matchComboTruth(12) === true, '纯实真值 / 纯虚旗（总旗数相同）=> 通过')
  // truth: 4 颗实雷 P=4 V=0；旗: 2 实 2 虚 => gp=2 gv=2，总数 4，比例不符 => 拒绝
  clear(); g.mine[6] = 1; g.mine[7] = 1; g.mine[8] = 1; g.mine[11] = 1; g.computeClues(); g.countTypes()
  g.flag[6] = 1; g.flag[7] = 1; g.flag[8] = 3; g.flag[11] = 3; g.recountFlags()
  ok(g.matchComboTruth(12) === false, '总旗数对但实虚比例错 => 拒绝')
}

/* ---- 4. 展开行为 ---- */
{
  const g = new Game({ w: 9, h: 9, mines: 10 })
  g.newGame(701); g.startAt(40, 0)
  // 找一个已翻开的非雷格，邻域有未翻开格
  let cell = -1
  for (let i = 0; i < g.n; i++) {
    if (g.open[i] && g.mine[i] === 0) {
      const uns = g.nbrs(i).filter((j) => g.open[j] === 0 && g.flag[j] === 0)
      if (uns.length > 0) { cell = i; break }
    }
  }
  ok(cell >= 0, '找得到可展开的数字格')
  const before = Array.from(g.open.subarray(0, g.n))
  g.tryExpand(cell)
  if (g.matchComboTruth(cell)) {
    ok(true, '判据通过')
  } else {
    ok(g.msg === MSG.JUDGE_FAIL, '判据不过 => judge_fail')
    eq(Array.from(g.open.subarray(0, g.n)), before, '判据不过棋盘不变')
  }
  // 插满正确旗 + 正确类型 => 展开成功且不踩雷
  const g2 = new Game({ w: 9, h: 9, mines: 10 })
  g2.newGame(701); g2.startAt(40, 0)
  let target = -1
  for (let i = 0; i < g2.n; i++) {
    if (!g2.open[i] && g2.mine[i] !== 0) { target = i; break }
  }
  ok(target >= 0, '找得到雷格')
  // 直接构造一个已翻开格，其邻域刚好只有这一颗雷，并用正确类型插旗
  const gg = new Game({ w: 5, h: 5, mines: 1 })
  gg.newGame(3)
  gg.mine.fill(0); gg.flag.fill(0); gg.open.fill(0); gg.clue.fill(-1)
  gg.mine[6] = 3; gg.computeClues(); gg.countTypes()
  gg.open[12] = 1
  gg.setFlag(6, 3)
  gg.tryExpand(12)
  ok(gg.msg === MSG.EXPAND_OK || gg.win, '判据通过后展开报 expand_ok')
  ok(gg.boom === -1, '旗标对了展开不该踩雷')
  ok(gg.open[7] === 1 || gg.open[8] === 1 || gg.win, '判据通过后真的翻开邻格')
  // 判据通过但旗标错类型/位置 => 踩雷
  const gb = new Game({ w: 5, h: 5, mines: 1 })
  gb.newGame(3)
  gb.mine.fill(0); gb.flag.fill(0); gb.open.fill(0); gb.clue.fill(-1)
  gb.mine[6] = 3; gb.computeClues(); gb.countTypes()
  gb.open[12] = 1
  gb.setFlag(7, 3) // 旗数对、实虚比例对（纯虚），但旗插在安全格上
  ok(gb.matchComboTruth(12) === true, '棘手的通过判据')
  gb.tryExpand(12)
  ok(gb.over && !gb.win && gb.boom === 6, '判据通过但邻域有雷 => 踩雷判负')
}

/* ---- 5. 连片与 0 格不扩散 ---- */
{
  const g = new Game({ w: 12, h: 12, mines: 24 })
  g.newGame(301); g.startAt(70, 0)
  // 独立洪水填充参照
  function expected(gm, start) {
    const comp = new Uint8Array(gm.n)
    const stack = [start]
    comp[start] = 1
    while (stack.length) {
      const i = stack.pop()
      for (const j of gm.nbrs(i)) {
        if (comp[j] || gm.mine[j] !== 0) continue
        if (gm.isBlank(j)) { comp[j] = 1; stack.push(j) }
      }
    }
    const set = new Uint8Array(gm.n)
    for (let i = 0; i < gm.n; i++) {
      if (!comp[i]) continue
      set[i] = 1
      for (const j of gm.nbrs(i)) if (gm.mine[j] === 0) set[j] = 1
    }
    return set
  }
  let samples = 0
  for (let i = 0; i < g.n && samples < 20; i++) {
    if (g.mine[i] !== 0 || g.open[i] !== 0 || !g.isBlank(i)) continue
    // 在留出 i 的局面里逐个验证：用同种子重建后对 i 做 reveal
    const h = new Game({ w: 12, h: 12, mines: 24 })
    h.newGame(301); h.startAt(70, 0)
    if (h.open[i] !== 0) continue
    const before = Array.from(h.open.subarray(0, h.n))
    h.reveal(i, 0)
    const want = expected(h, i)
    for (let k = 0; k < h.n; k++) {
      const got = h.open[k] !== 0 && !before[k]
      const exp = want[k] === 1 && !before[k]
      ok(got === exp, `连片逐格一致 (#${k})`)
      if (got) ok(h.mine[k] === 0, '连片不翻雷')
    }
    samples++
  }
  ok(samples >= 10, '空白连片样本足够')
  // 显示 0 不连片
  const z = new Game({ w: 12, h: 12, mines: 24 })
  z.newGame(305); z.startAt(70, 0)
  let zeroSamples = 0
  for (let k = 0; k < z.n && zeroSamples < 5; k++) {
    if (z.mine[k] !== 0 || z.open[k] !== 0) continue
    if (z.clue[k] !== 0 || z.nbrMineCount(k) === 0) continue
    const before = Array.from(z.open.subarray(0, z.n))
    z.reveal(k, 0)
    let opened = 0
    for (let m = 0; m < z.n; m++) if (z.open[m] !== 0 && !before[m]) opened++
    ok(opened === 1, '显示 0 的格子绝不连片')
    zeroSamples++
  }
  ok(zeroSamples >= 3, '显示 0 样本足够')
}

/* ---- 6. 插旗循环 / 旗保护 / 胜负 ---- */
{
  const g = new Game({ w: 9, h: 9, mines: 10 })
  g.newGame(701); g.startAt(40, 0)
  let cell = -1
  for (let i = 0; i < g.n; i++) if (!g.open[i]) { cell = i; break }
  g.setFlag(cell, 0)
  const seq = []
  for (let k = 0; k < 6; k++) { g.cycleFlag(cell); seq.push(g.flag[cell]) }
  eq(seq, [1, 2, 3, 4, 0, 1], '右键循环 1,2,3,4,0,1')
  // 旗保护
  g.setFlag(cell, 3)
  const oc = g.open[cell]
  g.reveal(cell, 0)
  ok(g.open[cell] === oc && g.flag[cell] === 3, '插旗格翻不开且旗保留')
  ok(g.flagsOf[3] === 1, '旗计数正确')
  ok(g.setFlag(cell, 0) && g.flagsOf[3] === 0, '撤旗归还计数')
  // 插超：不限量
  let placed = 0
  for (let i = 0; i < g.n; i++) if (!g.open[i]) { g.setFlag(i, 1); placed++ }
  ok(g.flagsTotal() === placed && placed > g.mines, '旗不限量且计数正确')
  ok(g.unmarked(1) < 0, '插超后未标记数为负')

  // 胜利：翻开所有非雷格
  const w = new Game({ w: 9, h: 9, mines: 10 })
  w.newGame(901); w.startAt(40, 0)
  for (let i = 0; i < w.n; i++) if (w.mine[i] === 0 && w.open[i] === 0) w.reveal(i, 0)
  ok(w.win && w.over && w.msg === MSG.WIN, '翻开所有非雷格判胜')
  // 少一格不判胜
  const w2 = new Game({ w: 9, h: 9, mines: 10 })
  w2.newGame(902); w2.startAt(40, 0)
  let left = -1
  for (let i = 0; i < w2.n; i++) if (w2.mine[i] === 0 && w2.open[i] === 0) { left = i; break }
  for (let i = 0; i < w2.n; i++) {
    if (i !== left && w2.mine[i] === 0 && w2.open[i] === 0) w2.reveal(i, 0)
  }
  ok(!w2.win, '还剩非雷格未翻开不判胜')
  // 翻雷判负
  const l = new Game({ w: 9, h: 9, mines: 10 })
  l.newGame(903); l.startAt(40, 0)
  let m = -1
  for (let i = 0; i < l.n; i++) if (l.mine[i] !== 0) { m = i; break }
  ok(!l.flag[m] && !l.open[m], '选的雷格未翻开未插旗')
  l.reveal(m, 0)
  ok(l.over && !l.win && l.boom === m, '翻雷判负并记录 boom')
}

/* ---- 7. 精确配比 + 纯实纯虚平方数 + 24 值枚举 ---- */
{
  const cases = [
    [0, 3, 2, 4, 1],
    [0, 0, 0, 0, 6],
    [0, 7, 0, 0, 0],
    [0, 5, 5, 0, 0],
    [0, 0, 0, 4, 4],
  ]
  for (const tc of cases) {
    for (const seed of [11, 22, 33]) {
      const sum = tc.reduce((a, b) => a + b, 0)
      const g = new Game({ w: 12, h: 12, mines: sum, typeCount: tc })
      g.newGame(seed); g.startAt(70, 0)
      for (let t = 1; t <= 4; t++) ok(g.typeTotal[t] === tc[t], `配比精确 t=${t} seed=${seed}`)
      ok(g.typeSum() === sum && g.mines === sum, '配比合计正确')
    }
  }
  // 纯实 / 纯虚：所有显示值是完全平方数
  for (const tc of [[0, 5, 5, 0, 0], [0, 0, 0, 4, 4]]) {
    for (const seed of [7, 8, 9]) {
      const sum = tc.reduce((a, b) => a + b, 0)
      const g = new Game({ w: 12, h: 12, mines: sum, typeCount: tc })
      g.newGame(seed); g.startAt(70, 0)
      for (let i = 0; i < g.n; i++) {
        if (g.mine[i] !== 0) continue
        const r = Math.round(Math.sqrt(g.clue[i]))
        ok(r * r === g.clue[i], `纯实/纯虚局所有线索是完全平方数 (${g.clue[i]})`)
      }
    }
  }
  // 24 个可达值
  const seen = new Set()
  let combos = 0
  for (let n1 = 0; n1 <= 8; n1++)
    for (let n2 = 0; n1 + n2 <= 8; n2++)
      for (let n3 = 0; n1 + n2 + n3 <= 8; n3++)
        for (let n4 = 0; n1 + n2 + n3 + n4 <= 8; n4++) {
          combos++
          const a = n1 - n2
          const b = n3 - n4
          seen.add(a * a + b * b)
        }
  ok(combos === 495, '邻域组合 495 种')
  eq([...seen].sort((a, b) => a - b), E.ACHIEVABLE.slice().sort((a, b) => a - b), '24 个可达显示值集合')
}

/* ---- 8. 存档往返 + 坏档拒绝 ---- */
{
  const g = new Game({ w: 9, h: 9, mines: 10 })
  g.newGame(4242); g.startAt(40, 0)
  // 走几步
  for (let i = 0; i < g.n; i++) if (!g.open[i]) { g.cycleFlag(i); break }
  g.elapsedMs = 12345
  const snap = g.snapshot()
  const round = JSON.parse(JSON.stringify(snap))
  const r = Game.fromSnapshot(round)
  ok(r !== null, '合法快照可恢复')
  eq(r.snapshot(), snap, '往返逐字段一致')
  ok(Game.fromSnapshot(null) === null, 'null 拒绝')
  ok(Game.fromSnapshot({}) === null, '空对象拒绝')
  const bad1 = JSON.parse(JSON.stringify(snap)); bad1.mine[0] = 9
  ok(Game.fromSnapshot(bad1) === null, '非法雷类型拒绝')
  const bad2 = JSON.parse(JSON.stringify(snap)); bad2.startCell = -1
  ok(Game.fromSnapshot(bad2) === null, '已开局但 startCell=-1 拒绝')
  const bad3 = JSON.parse(JSON.stringify(snap)); bad3.win = true
  ok(Game.fromSnapshot(bad3) === null, 'win 但没翻完 拒绝')
  const bad4 = JSON.parse(JSON.stringify(snap)); bad4.mine = bad4.mine.slice(0, 10)
  ok(Game.fromSnapshot(bad4) === null, '数组长度不符拒绝')
  const bad5 = JSON.parse(JSON.stringify(snap)); bad5.open[bad5.startCell] = 0
  ok(Game.fromSnapshot(bad5) === null, '首点格未翻开拒绝')
  const bad6 = JSON.parse(JSON.stringify(snap)); bad6.flag[0] = 3; bad6.open[0] = 1
  ok(Game.fromSnapshot(bad6) === null, '同一格既开又插旗拒绝')
  // 新局未开始
  const fresh = new Game({ w: 9, h: 9, mines: 10 })
  fresh.newGame(1)
  const rf = Game.fromSnapshot(JSON.parse(JSON.stringify(fresh.snapshot())))
  ok(rf !== null && !rf.started, '未开局快照可恢复')
}

/* ---- 9. splitEvenly ---- */
{
  eq(splitEvenly(10), [0, 3, 3, 2, 2], 'splitEvenly(10)')
  eq(splitEvenly(99), [0, 25, 25, 25, 24], 'splitEvenly(99)')
  eq(splitEvenly(0), [0, 0, 0, 0, 0], 'splitEvenly(0)')
}

/* ---- 10. 越界安全 ---- */
{
  const g = new Game({ w: 9, h: 9, mines: 10 })
  g.newGame(1)
  ok(g.cycleFlag(-1) === false && g.cycleFlag(999) === false, 'cycleFlag 越界安全')
  g.reveal(-1, 0); g.tryExpand(999); g.setFlag(9999, 1)
  ok(g.openedCount() === 0, '越界 reveal 无副作用')
}

console.log(`engine smoke: ${checks} checks passed`)
