/* 分类统计：哪些"引擎合法局面"被 fromSnapshot 拒绝 */
await import('../../engine.js')
const E = globalThis.CS

class TestRng {
  constructor(seed) { this.s = seed >>> 0 }
  u32() { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s }
  int(n) { return n <= 0 ? 0 : Math.floor((this.u32() / 4294967296) * n) }
  pick(a) { return a.length === 0 ? -1 : a[this.int(a.length)] }
}

function classify(g) {
  const n = g.n
  let openFlagOverlap = -1
  let mineCount = 0
  for (let i = 0; i < n; i++) {
    if (g.mine[i] !== 0) mineCount++
    if (g.open[i] !== 0 && g.flag[i] !== 0 && openFlagOverlap < 0) openFlagOverlap = i
  }
  const startUnopened = g.started && g.open[g.startCell] !== 1
  const mineMismatch = g.started && mineCount !== g.mines
  let badClue = 0
  for (let i = 0; i < n; i++) {
    if (g.mine[i] !== 0) { if (g.clue[i] !== -1) badClue++ } else if (g.started && g.clue[i] < 0) badClue++
  }
  let openedMine = 0
  for (let i = 0; i < n; i++) if (g.mine[i] !== 0 && g.open[i] !== 0) openedMine++
  return { openFlagOverlap, startUnopened, mineMismatch, badClue, openedMine }
}

const counts = { total: 0, null: 0, A_startUnopened: 0, B_openFlagOverlap: 0, C_other: 0 }
const otherSamples = []
const PRESETS = [{ w: 9, h: 9, mines: 10 }, { w: 16, h: 16, mines: 40 }, { w: 30, h: 16, mines: 99 }]
const rng = new TestRng(0xa11ce)
for (let s = 0; s < 120; s++) {
  const p = PRESETS[s % 3]
  const eng = new E.Game({ w: p.w, h: p.h, mines: p.mines })
  const preFlags = rng.int(6)
  for (let k = 0; k < preFlags; k++) eng.cycleFlag(rng.int(eng.n))
  const start = rng.int(eng.n)
  const seed = (rng.u32() % 100000) + 1
  eng.newGame(seed)
  eng.startAt(start, 999)
  for (let step = 0; step < 180; step++) {
    if (eng.over || !eng.started) {
      const sd = (rng.u32() % 100000) + 1
      eng.newGame(sd)
      eng.startAt(rng.int(eng.n), 777)
    } else {
      const r = rng.int(100)
      if (r < 8) { eng.reveal(rng.int(eng.n), 1234) }
      else if (r < 52) {
        const cands = []
        for (let i = 0; i < eng.n; i++) if (!eng.open[i] && !eng.flag[i]) cands.push(i)
        const c = rng.pick(cands)
        if (c < 0) eng.tryExpand(rng.int(eng.n))
        else eng.reveal(c, 1234)
      } else if (r < 72) {
        const cands = []
        for (let i = 0; i < eng.n; i++) if (!eng.open[i]) cands.push(i)
        eng.cycleFlag(rng.pick(cands))
      } else if (r < 80) {
        eng.setFlag(rng.int(eng.n), rng.int(6))
      } else if (r < 94) {
        const cands = []
        for (let i = 0; i < eng.n; i++) if (eng.open[i] && eng.mine[i] === 0) cands.push(i)
        eng.tryExpand(rng.pick(cands))
      } else if (r < 97) {
        eng.tryExpand(rng.int(eng.n))
      } else {
        const sd = (rng.u32() % 100000) + 1
        eng.newGame(sd)
        eng.startAt(rng.int(eng.n), 777)
      }
    }
    if (step % 11 !== 0) continue
    counts.total++
    const back = E.Game.fromSnapshot(JSON.parse(JSON.stringify(eng.snapshot())))
    if (back !== null) continue
    counts.null++
    const c = classify(eng)
    if (c.openFlagOverlap >= 0) counts.B_openFlagOverlap++
    else if (c.startUnopened) counts.A_startUnopened++
    else {
      counts.C_other++
      if (otherSamples.length < 5) {
        otherSamples.push({ ...c, w: eng.w, h: eng.h, mines: eng.mines, over: eng.over, win: eng.win, boom: eng.boom, startCell: eng.startCell, started: eng.started, moves: eng.moves, msg: eng.msg })
      }
    }
  }
}
console.log(JSON.stringify({ counts, otherSamples }, null, 2))
