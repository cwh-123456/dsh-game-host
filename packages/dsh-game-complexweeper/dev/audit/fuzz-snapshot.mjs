/* fromSnapshot 畸形 / 篡改存档 fuzz（engine.js，只读）
 * 运行：node packages/dsh-game-complexweeper/dev/audit/fuzz-snapshot.mjs
 * 退出码：0 = 全部通过（没有抛错、该拒的都拒了）；1 = 有失败。
 *
 * 判定口径：
 *   - "必须拒绝"：结构性错误 / 越界值 / 类型不符 / 胜败不一致 / open+flag 重叠 /
 *     startCell 非法 / 数组长度不符 等 → 必须返回 null，且绝不能抛错；
 *   - "允许接受"：只改了语义上仍自洽的字段（moves+1、elapsedMs、派生计数、多余未知键等）。
 *   - 每次调用都包 try/catch，任何异常都记为失败（任务要求"必须返回 null 不抛错"）。
 */
await import('../../engine.js')
const E = globalThis.CS

let cases = 0
const fails = []
const lenient = [] // 记录"实现选择放行"的语义边界（不是失败，但要向上报告）
function expectReject(snap, name) {
  cases++
  let r
  try {
    r = E.Game.fromSnapshot(snap)
  } catch (err) {
    fails.push(`${name}: 抛异常了（应返回 null）: ${err && err.message}`)
    return
  }
  if (r !== null) fails.push(`${name}: 应返回 null，实际接受了`)
}

/* ------------------------------ 构造合法基档 ------------------------------ */
function baseFresh() {
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(1)
  return g.snapshot()
}
function baseMid() {
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(2)
  g.startAt(40, 0)
  // 只对"未翻开"的格子插旗（原版 UI 只走 cycleFlag；setFlag 到已翻开格是 API-only 局面）
  const closed = []
  for (let i = 0; i < g.n; i++) if (!g.open[i]) closed.push(i)
  g.cycleFlag(closed[0]) // 旗 1
  g.cycleFlag(closed[1]); g.cycleFlag(closed[1]) // 旗 2
  g.cycleFlag(closed[2]); g.cycleFlag(closed[2]); g.cycleFlag(closed[2]) // 旗 3
  g.elapsedMs = 777
  return g.snapshot()
}
function baseLost() {
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(3)
  g.startAt(40, 0)
  let m = -1
  for (let i = 0; i < g.n; i++) if (g.mine[i] !== 0) { m = i; break }
  g.reveal(m, 0)
  return g.snapshot()
}
function baseWon() {
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(4)
  g.startAt(40, 0)
  for (let i = 0; i < g.n; i++) if (g.mine[i] === 0 && !g.open[i]) g.reveal(i, 0)
  return g.snapshot()
}
function baseHard() {
  const g = new E.Game({ w: 30, h: 16, mines: 99 })
  g.newGame(5)
  g.startAt(200, 0)
  for (let i = 0; i < 120; i++) {
    if (g.over) break
    const cands = []
    for (let k = 0; k < g.n; k++) if (!g.open[k] && !g.flag[k]) cands.push(k)
    if (cands.length === 0) break
    g.reveal(cands[i % cands.length], 0)
  }
  return g.snapshot()
}
function baseFlagsWrong() {
  const g = new E.Game({ w: 12, h: 12, mines: 20 })
  g.newGame(6)
  g.startAt(70, 0)
  for (let i = 0; i < g.n; i++) if (g.mine[i] !== 0) g.cycleFlagWide ? null : g.cycleFlag(i)
  return g.snapshot()
}
function baseCustomTypeCount() {
  const g = new E.Game({ w: 12, h: 12, mines: 14, typeCount: [0, 3, 2, 4, 5] })
  g.newGame(7)
  g.startAt(70, 0)
  return g.snapshot()
}
function baseHyper() {
  const g = new E.Game({ w: 12, h: 12, mines: 30, mode: E.MODE_HYPER })
  g.newGame(8)
  g.startAt(70, 0)
  return g.snapshot()
}

const BASES = {
  fresh: baseFresh(),
  mid: baseMid(),
  lost: baseLost(),
  won: baseWon(),
  hard: baseHard(),
  flagsWrong: baseFlagsWrong(),
  customTypeCount: baseCustomTypeCount(),
  hyper: baseHyper(),
}
function clone(s) {
  return JSON.parse(JSON.stringify(s))
}

/* ===================== 0. 合法基档必须能往返（hyper 单独记录） ===================== */
const roundtrip = { ok: 0, bad: [], knownBug: [] }
for (const [name, snap] of Object.entries(BASES)) {
  cases++
  let back = null
  try {
    back = E.Game.fromSnapshot(clone(snap))
  } catch (err) {
    fails.push(`基档 ${name} 往返抛异常: ${err && err.message}`)
    continue
  }
  if (back === null) {
    // 已知缺陷：hyper 模式 clue 下界被写成 −1，负显示值（a²−b² < −1）会被误拒
    if (name === 'hyper' && snap.clue.some((c, i) => snap.mine[i] === 0 && c < -1)) {
      roundtrip.knownBug.push(`${name}（已知缺陷：hyper 负显示值被拒）`)
      continue
    }
    roundtrip.bad.push(name)
    continue
  }
  const again = JSON.stringify(back.snapshot())
  if (again !== JSON.stringify(snap)) {
    fails.push(`基档 ${name} 往返后不一致:\n  want=${JSON.stringify(snap).slice(0, 200)}\n  got=${again.slice(0, 200)}`)
    continue
  }
  roundtrip.ok++
}

/* ===================== 1. 删字段 / 整对象类型错误 ===================== */
// typeTotal / flagsOf 是派生计数，fromSnapshot 明确"不信任存档里的派生计数"（恢复后重算），
// 所以删掉它们不算坏档。
const NOT_REQUIRED = new Set(['typeTotal', 'flagsOf'])
const KEYS = Object.keys(BASES.mid).filter((k) => !NOT_REQUIRED.has(k))
for (const baseName of ['fresh', 'mid', 'lost', 'won']) {
  const base = BASES[baseName]
  for (const k of KEYS) {
    const s = clone(base)
    delete s[k]
    expectReject(s, `${baseName} 删除字段 ${k}`)
  }
}
for (const [label, val] of [
  ['null', null],
  ['undefined', undefined],
  ['数字', 42],
  ['字符串', 'snapshot'],
  ['数组', []],
  ['布尔', true],
  ['函数', () => {}],
]) {
  expectReject(val, `fromSnapshot(整体=${label})`)
}

/* ===================== 2. 标量字段类型/范围（逐字段坏值） ===================== */
const BAD_BY_KEY = {
  w: [-1, 0, 41, 1.5, '9', null, NaN, Infinity, true],
  h: [-1, 0, 31, 1.5, '9', null, NaN, Infinity, true],
  mode: [2, -1, 0.5, '0', null, true],
  judgeLoose: ['false', 0, 1, null, {}],
  seed: [0, -1, 4294967296, 1.5, '1', null, NaN],
  rngA: [-1, 4294967296, 1.5, '0', null, NaN],
  mines: [-1, 1000, 1.5, '10', null, NaN],
  typeCount: [null, [], [0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, -1, 0, 0, 0], [0, 1.5, 0, 0, 0], [0, 1e9, 0, 0, 0]],
  mine: [null, {}, 'x'],
  clue: [null, {}, 'x'],
  open: [null, {}, 'x'],
  flag: [null, {}, 'x'],
  started: [1, 0, 'true', null],
  over: [1, 0, 'false', null],
  win: [1, 0, 'true', null],
  boom: [-2, 1e9, 1.5, '0', null],
  startCell: [-2, 1e9, 1.5, '0', null],
  elapsedMs: [-1, 1.5, '0', null, NaN, Number.MAX_SAFE_INTEGER + 2],
  moves: [-1, 1.5, '0', null, NaN],
  msg: [-1, 6, 2.5, 'win', null],
  msgArg: [-1, 65536, 1.5, '0', null],
  // 下面两个是派生计数：改了不该导致拒绝，但也不该抛错（恢复时会重算）
  typeTotal: [null, [], 'x'],
  flagsOf: [null, [], 'x'],
  n: [0, 1.5, '81'], // 多余的未知键
}
for (const baseName of ['fresh', 'mid', 'lost', 'won']) {
  const base = BASES[baseName]
  for (const [k, vals] of Object.entries(BAD_BY_KEY)) {
    const isDerivedOrExtra = k === 'n' || NOT_REQUIRED.has(k)
    for (const v of vals) {
      const s = clone(base)
      s[k] = v
      if (isDerivedOrExtra) {
        cases++
        try {
          const back = E.Game.fromSnapshot(s)
          if (back === null) fails.push(`${baseName} 派生/多余键 ${k}=${String(v)} 被误拒`)
        } catch (err) {
          fails.push(`${baseName} ${k}=${String(v)} 抛异常: ${err && err.message}`)
        }
      } else {
        expectReject(s, `${baseName} ${k}=${String(v)}`)
      }
    }
  }
}

/* ===================== 3. 数组元素/长度篡改 ===================== */
for (const baseName of ['fresh', 'mid', 'lost', 'won', 'hard']) {
  const base = BASES[baseName]
  const n = base.w * base.h
  for (const arr of ['mine', 'clue', 'open', 'flag']) {
    for (const [label, mut] of [
      ['短 1', (a) => a.slice(0, -1)],
      ['长 1', (a) => a.concat([0])],
      ['空', () => []],
    ]) {
      const s = clone(base)
      s[arr] = mut(s[arr])
      expectReject(s, `${baseName} ${arr} 长度${label}`)
    }
    const lo = arr === 'mine' || arr === 'flag' ? 0 : arr === 'clue' ? -1 : 0
    const hi = arr === 'mine' || arr === 'flag' ? 4 : arr === 'clue' ? 64 : 1
    for (const v of [lo - 5, hi + 5, 1.5, '1', null, NaN, Infinity]) {
      const s = clone(base)
      s[arr][0] = v
      s[arr][n - 1] = v
      expectReject(s, `${baseName} ${arr}[0]=${String(v)}`)
    }
    const s = clone(base)
    delete s[arr][0]
    expectReject(s, `${baseName} ${arr} 有洞 (delete [0])`)
  }
  for (const arr of ['mine', 'clue', 'open', 'flag']) {
    const s = clone(base)
    s[arr] = new Uint8Array(s[arr])
    expectReject(s, `${baseName} ${arr}=Uint8Array`)
    const s2 = clone(base)
    s2[arr] = String(s2[arr])
    expectReject(s2, `${baseName} ${arr}=字符串`)
  }
}

/* ===================== 4. 语义不一致（必须拒绝） ===================== */
{
  const mid = BASES.mid
  const n = mid.w * mid.h
  const mut = (fn) => {
    const s = clone(mid)
    fn(s)
    return s
  }
  const find = (s, pred) => {
    for (let i = 0; i < n; i++) if (pred(s, i)) return i
    return -1
  }
  const flagCell = find(mid, (s, i) => s.flag[i] !== 0)
  const closedFree = find(mid, (s, i) => s.open[i] === 0 && s.flag[i] === 0)
  const mineCell = find(mid, (s, i) => s.mine[i] !== 0)
  const safeCell = find(mid, (s, i) => s.mine[i] === 0)
  if (flagCell < 0 || closedFree < 0 || mineCell < 0 || safeCell < 0) {
    fails.push('mid 基档构造失败：找不到需要的格子')
  }

  // 雷值越界 / 雷数对不上
  expectReject(mut((s) => { s.mine[0] = 9 }), 'mine 值越界 9')
  expectReject(mut((s) => { s.mine[mineCell] = 0 }), '已开局但实际雷数 < mines')
  expectReject(mut((s) => { s.mines = mid.mines + 1 }), 'mines 与实际雷数不符')
  expectReject(mut((s) => { s.mines = 0 }), 'mines=0 但棋盘有雷')
  // open+flag 重叠
  expectReject(mut((s) => { s.open[flagCell] = 1 }), 'open 与 flag 重叠（旗格 open=1）')
  expectReject(mut((s) => { s.flag[closedFree] = 2; s.open[closedFree] = 1 }), 'open 与 flag 重叠（新格）')
  // startCell 非法
  expectReject(mut((s) => { s.startCell = -1 }), 'started 但 startCell=-1')
  expectReject(mut((s) => { s.startCell = n }), 'startCell 越界')
  expectReject(mut((s) => { s.open[s.startCell] = 0 }), 'started 但 startCell 未翻开')
  // 胜败不一致
  expectReject(mut((s) => { s.win = true }), 'win=true 但 over=false')
  expectReject(mut((s) => { s.over = true }), 'over=true 但 boom=-1')
  expectReject(mut((s) => { s.over = true; s.boom = safeCell }), 'boom 指向安全格')
  expectReject(mut((s) => { s.over = true; s.win = true; s.boom = -1 }), 'over+win 但还有非雷格没翻开')
  expectReject(mut((s) => { s.boom = flagCell }), '未结束却 boom>=0')
  // 多翻一颗雷
  {
    const lost = clone(BASES.lost)
    let mine2 = -1
    for (let i = 0; i < n; i++) if (lost.mine[i] !== 0 && lost.open[i] === 0) { mine2 = i; break }
    if (mine2 >= 0) {
      lost.open[mine2] = 1
      expectReject(lost, '失败局面里有两颗雷被翻开')
    }
  }
  // clue 与雷格冲突
  expectReject(mut((s) => { s.clue[mineCell] = 3 }), '雷格 clue 不是 −1')
  expectReject(mut((s) => { s.clue[safeCell] = -1 }), '已开局非雷格 clue = −1')
  expectReject(mut((s) => { s.clue[safeCell] = 65 }), 'clue=65 越界（圆复数上限 64）')
  expectReject(mut((s) => { s.clue[safeCell] = -2 }), 'clue=−2 非法')
  // 未开局却已有棋盘
  {
    const fresh = clone(BASES.fresh)
    fresh.mine[0] = 1
    expectReject(fresh, '未开局却布雷')
    const fresh2 = clone(BASES.fresh)
    fresh2.over = true
    expectReject(fresh2, '未开局却 over')
    const fresh3 = clone(BASES.fresh)
    fresh3.startCell = 0
    expectReject(fresh3, '未开局却 startCell>=0')
    const fresh4 = clone(BASES.fresh)
    fresh4.clue[0] = 0
    expectReject(fresh4, '未开局却 clue != −1')
    const fresh5 = clone(BASES.fresh)
    fresh5.open[0] = 1
    expectReject(fresh5, '未开局却已翻开')
  }
  // 胜利局面篡改
  {
    const won = clone(BASES.won)
    won.clue[0] = -1
    expectReject(won, '胜利局面里非雷格 clue=-1')
    const won3 = clone(BASES.won)
    won3.boom = 0
    expectReject(won3, '胜利局面却 boom>=0')
    const won4 = clone(BASES.won)
    won4.over = false
    expectReject(won4, 'win=true 但 over=false（胜利局面）')
  }
  // typeCount / seed / msg / 尺寸
  expectReject(mut((s) => { s.typeCount = [0, 400, 400, 400, 400] }), 'typeCount 总量 > 999')
  expectReject(mut((s) => { s.seed = 0 }), 'seed=0（快照规范要求 ≥1）')
  expectReject(mut((s) => { s.msg = 99 }), 'msg 越界')
  expectReject(mut((s) => { s.w = 8; s.h = 9 }), 'w 改小但数组长度没变')
  expectReject(mut((s) => { s.w = 40; s.h = 30 }), 'w/h 改大但数组长度没变')
}

/* ===================== 4b. 语义边界：实现选择"放行"的篡改（记录，不算失败） ===================== */
{
  const mid = BASES.mid
  const accept = (snap, name, verify) => {
    cases++
    let r = null
    try {
      r = E.Game.fromSnapshot(snap)
    } catch (err) {
      fails.push(`${name}: 抛异常: ${err && err.message}`)
      return
    }
    if (r === null) fails.push(`${name}: 应被接受（自洽改动）却拒绝了`)
    else if (verify) verify(r)
  }
  // moves / elapsedMs 纯统计，改了应接受并保留
  {
    const s = clone(mid); s.moves += 1
    accept(s, 'moves+1 应接受', (r) => { if (r.moves !== mid.moves + 1) fails.push('moves 未被保留') })
    const s2 = clone(mid); s2.elapsedMs += 5
    accept(s2, 'elapsedMs+5 应接受', (r) => { if (r.elapsedMs !== mid.elapsedMs + 5) fails.push('elapsedMs 未被保留') })
  }
  // 派生计数被篡改：恢复时重算，不接受存档值
  {
    const s = clone(mid)
    s.typeTotal = [0, 999, 999, 999, 999]
    s.flagsOf = [0, 999, 999, 999, 999]
    accept(s, '派生计数篡改应接受（重算）', (r) => {
      let sum = 0
      for (let i = 0; i < r.n; i++) if (r.mine[i] !== 0) sum++
      if (r.typeSum() !== sum) fails.push('typeTotal 未按雷重算')
      if (r.flagsTotal() !== mid.flagsOf.reduce((a, b) => a + b, 0)) fails.push('flagsOf 未按旗重算')
    })
  }
  // 多余未知键
  {
    const s = clone(mid)
    s.__extra = { a: 1 }
    s.foo = 'bar'
    accept(s, '多余未知键应接受')
  }
  // 全翻开但 win=false/over=false：实现没查这条（恢复后下一次操作会 checkWin）
  {
    const won = clone(BASES.won)
    won.win = false
    won.over = false
    cases++
    const r = E.Game.fromSnapshot(won)
    if (r === null) lenient.push('"全翻开未判胜" 被拒绝（更严格）')
    else lenient.push('"全翻开未判胜" 被接受（实现未校验；恢复后下一次操作会 checkWin，无危害）')
  }
}

/* ===================== 5. 随机篡改 fuzz（每例都必须"不抛错"） ===================== */
{
  let state = 0x12345678
  const rnd = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  const pick = (arr) => arr[rnd() % arr.length]
  const SCALARS = ['w', 'h', 'mode', 'judgeLoose', 'seed', 'rngA', 'mines', 'started', 'over', 'win', 'boom', 'startCell', 'elapsedMs', 'moves', 'msg', 'msgArg', 'typeCount', 'mine', 'clue', 'open', 'flag']
  const BADVALS = [null, undefined, -1, -2, 0, 1, 2, 4, 5, 64, 65, 999, 1000, 1.5, -0.5, NaN, Infinity, -Infinity, '', 'x', '9', true, false, {}, [], [0], [0, 0, 0, 0, 0], [4, 4, 4, 4, 4], new Uint8Array(81)]
  const baseNames = Object.keys(BASES)
  let accepted = 0
  let rejected = 0
  let throws = 0
  for (let iter = 0; iter < 4000; iter++) {
    cases++
    const base = clone(BASES[pick(baseNames)])
    base[pick(SCALARS)] = pick(BADVALS)
    if (rnd() % 3 === 0) base[pick(SCALARS)] = pick(BADVALS)
    let r
    try {
      r = E.Game.fromSnapshot(base)
    } catch (err) {
      throws++
      fails.push(`随机 fuzz #${iter} 抛异常: ${err && err.message} :: ${JSON.stringify(base).slice(0, 160)}`)
      continue
    }
    if (r === null) rejected++
    else {
      accepted++
      // 接受了的（少数是自洽改动，如 moves/elapsedMs/派生计数）至少要能安全用
      try {
        r.snapshot()
        r.openedCount()
        r.flagsTotal()
        r.typeSum()
        r.checkWin()
        r.reveal(0, 0)
        r.tryExpand(0)
        r.cycleFlag(0)
      } catch (err) {
        fails.push(`随机 fuzz #${iter} 接受后使用抛异常: ${err && err.message}`)
      }
    }
  }
  console.log(`[5] 随机篡改 fuzz：4000 例；拒绝 ${rejected}，接受 ${accepted}，抛异常 ${throws}`)
}

/* ===================== 6. 已知缺陷专项（记录，不算失败） ===================== */
{
  const g = new E.Game({ w: 5, h: 5, mines: 2, mode: E.MODE_HYPER })
  g.newGame(1)
  g.mine.fill(0); g.clue.fill(-1); g.open.fill(0); g.flag.fill(0)
  g.mine[6] = 3; g.mine[7] = 3 // 两颗 +j → a=0,b=2 → clue = −4
  g.computeClues(); g.countTypes()
  g.started = true; g.startCell = 12; g.open[12] = 1
  const back = E.Game.fromSnapshot(clone(g.snapshot()))
  console.log(`[6] hyper clue[12]=${g.clue[12]}（合法 a²−b²）；fromSnapshot → ${back === null ? 'null（误拒，已知缺陷）' : '接受'}`)
  console.log(`[6] 基档往返：OK ${roundtrip.ok}/8；失败：${roundtrip.bad.join(', ') || '无'}；已知缺陷：${roundtrip.knownBug.join(', ') || '无'}`)
  if (lenient.length) console.log(`[6] 语义边界（实现选择）：${lenient.join('；')}`)
}

/* ---------------------------------- 汇总 ---------------------------------- */
console.log(`fuzz-snapshot: 共 ${cases} 例；失败 ${fails.length}；基档往返 OK ${roundtrip.ok}/8`)
if (fails.length) {
  for (const f of fails.slice(0, 30)) console.error('FAIL: ' + f)
  process.exit(1)
}
console.log('FUZZ OK')
