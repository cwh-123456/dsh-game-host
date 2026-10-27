/* 验证 hyper 模式负显示值（a²−b² < −1）导致 fromSnapshot 拒绝 */
await import('../../engine.js')
const E = globalThis.CS

// 5x5，中央格 12 的邻域按 game.zig 的 TYPES 摆 2 颗 +i（a=0,b=2）→ clue = -4
const g = new E.Game({ w: 5, h: 5, mines: 2, mode: E.MODE_HYPER })
g.newGame(1)
g.mine.fill(0)
g.clue.fill(-1)
g.open.fill(0)
g.flag.fill(0)
g.mine[6] = 3
g.mine[7] = 3
g.computeClues()
g.countTypes()
g.startAt = undefined // 不做开局，直接手工造合法快照字段
g.started = true
g.startCell = 12
g.open[12] = 1
const snap = g.snapshot()
console.log('clue[12] =', g.clue[12], '（应为 −4：两颗 +i 的 a=0,b=2 → 0²−2²）')
const back = E.Game.fromSnapshot(JSON.parse(JSON.stringify(snap)))
console.log('fromSnapshot(hyper, clue[12]=-4):', back === null ? 'null（拒绝）' : 'OK')

// 对照：把 -4 改成 -1（唯一被允许的负值）再试
{
  const s2 = JSON.parse(JSON.stringify(snap))
  for (let i = 0; i < s2.clue.length; i++) if (s2.clue[i] < -1) s2.clue[i] = -1
  const b2 = E.Game.fromSnapshot(s2)
  console.log('fromSnapshot(hyper, 所有 clue ≥ -1):', b2 === null ? 'null' : 'OK')
}

// 对照：圆复数模式同样局面 clue=+4
{
  const c = new E.Game({ w: 5, h: 5, mines: 2 })
  c.newGame(1)
  c.mine.fill(0); c.clue.fill(-1); c.open.fill(0); c.flag.fill(0)
  c.mine[6] = 3; c.mine[7] = 3
  c.computeClues(); c.countTypes()
  c.started = true; c.startCell = 12; c.open[12] = 1
  const cb = E.Game.fromSnapshot(JSON.parse(JSON.stringify(c.snapshot())))
  console.log('complex 同局面 clue=', c.clue[12], 'fromSnapshot:', cb === null ? 'null' : 'OK')
}
