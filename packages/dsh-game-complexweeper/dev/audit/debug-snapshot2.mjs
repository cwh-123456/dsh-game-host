/* 抓一个"合法局面却被 fromSnapshot 拒绝"的具体快照并分析 */
await import('../../engine.js')
const E = globalThis.CS

class TestRng {
  constructor(seed) { this.s = seed >>> 0 }
  u32() { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s }
  int(n) { return n <= 0 ? 0 : Math.floor((this.u32() / 4294967296) * n) }
  pick(a) { return a.length === 0 ? -1 : a[this.int(a.length)] }
}

function analyze(g) {
  const n = g.n
  let mineCount = 0, openMineCount = 0, closedSafe = 0, badClue = 0
  for (let i = 0; i < n; i++) {
    if (g.mine[i] !== 0) mineCount++
    if (g.mine[i] !== 0 && g.open[i] !== 0) openMineCount++
    if (g.mine[i] === 0 && g.open[i] === 0) closedSafe++
    if (g.mine[i] !== 0) { if (g.clue[i] !== -1) badClue++ } else if (g.started && g.clue[i] < 0) badClue++
    if (g.open[i] !== 0 && g.flag[i] !== 0) badClue += 100
  }
  return { n, mineCount, openMineCount, closedSafe, badClue, startCell: g.startCell, openStart: g.startCell >= 0 ? g.open[g.startCell] : null, boom: g.boom, over: g.over, win: g.win, msg: g.msg, moves: g.moves }
}

// 复现 diff.mjs 的 A 组开头：cfg#6 = 9x9x10, groupSeed 0xa11ce
const rng = new TestRng(0xa11ce)
const PRESETS = [{ w: 9, h: 9, mines: 10 }, { w: 16, h: 16, mines: 40 }, { w: 30, h: 16, mines: 99 }]
let found = 0
for (let s = 0; s < 120 && found < 5; s++) {
  const p = PRESETS[s % 3]
  const cfg = { w: p.w, h: p.h, mines: p.mines }
  const eng = new E.Game(cfg)
  const preFlags = rng.int(6)
  for (let k = 0; k < preFlags; k++) eng.cycleFlag(rng.int(eng.n))
  const start = rng.int(eng.n)
  const seed = (rng.u32() % 100000) + 1
  eng.newGame(seed)
  eng.startAt(start, 999)
  console.log(`cfg#${s} start=${start} seed=${seed}`, analyze(eng))
  if (E.Game.fromSnapshot(JSON.parse(JSON.stringify(eng.snapshot()))) === null) {
    found++
    console.log('  >>> 被拒绝！snapshot keys:', JSON.stringify({
      w: eng.w, h: eng.h, mode: eng.mode, judgeLoose: eng.judgeLoose, seed: eng.seed, rngA: eng.rng.a,
      mines: eng.mines, typeCount: Array.from(eng.typeCount), started: eng.started, over: eng.over, win: eng.win,
      boom: eng.boom, startCell: eng.startCell, elapsedMs: eng.elapsedMs, moves: eng.moves, msg: eng.msg, msgArg: eng.msgArg,
    }))
    const snap = eng.snapshot()
    let badMine = 0, badClue = 0
    for (let i = 0; i < eng.n; i++) {
      if (!Number.isInteger(snap.mine[i]) || snap.mine[i] < 0 || snap.mine[i] > 4) badMine++
      if (!Number.isInteger(snap.clue[i]) || snap.clue[i] < -1 || snap.clue[i] > 64) badClue++
    }
    console.log('  mine range bad=', badMine, 'clue range bad=', badClue)
    console.log('  open start=', eng.open[eng.startCell], 'startCell=', eng.startCell)
  }
  // 继续消耗 rng 以对齐后面的序列（先不精确对齐，只为找到至少一个反例）
  for (let step = 0; step < 3; step++) {
    const r = rng.int(100)
    void r
  }
}
