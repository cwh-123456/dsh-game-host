/* 定位 fromSnapshot 拒绝合法快照的具体原因 */
import { RefGame } from './ref.mjs'
await import('../../engine.js')
const E = globalThis.CS

function tryWhy(label, snap) {
  const r = E.Game.fromSnapshot(JSON.parse(JSON.stringify(snap)))
  console.log(`${label}: ${r === null ? 'NULL（拒绝）' : 'OK'}`)
  return r
}

/* 假设 1：开局前给"首点格"插旗 → startAt 后该格不会被 cascadeOpen 打开 */
{
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(1)
  g.setFlag(40, 1) // 先插旗
  g.startAt(40, 0) // 首点就是这面旗的格子
  console.log('假设1: started=', g.started, 'open[startCell]=', g.open[40], 'flag=', g.flag[40], 'moves=', g.moves)
  const snap = g.snapshot()
  tryWhy('  假设1 fromSnapshot', snap)
}

/* 假设 2：普通开局 + 踩雷 */
{
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(1)
  g.startAt(40, 0)
  let m = -1
  for (let i = 0; i < g.n; i++) if (g.mine[i] !== 0) { m = i; break }
  g.reveal(m, 0)
  console.log('假设2: over=', g.over, 'boom=', g.boom, 'openMines=', (() => { let k = 0; for (let i = 0; i < g.n; i++) if (g.open[i] && g.mine[i]) k++; return k })())
  tryWhy('  假设2 fromSnapshot', g.snapshot())
}

/* 假设 3：赢了 */
{
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(901)
  g.startAt(40, 0)
  for (let i = 0; i < g.n; i++) if (g.mine[i] === 0 && !g.open[i]) g.reveal(i, 0)
  console.log('假设3: win=', g.win, 'over=', g.over)
  tryWhy('  假设3 fromSnapshot', g.snapshot())
}

/* 假设 4：首点格被旗保护但其余一切正常，且该旗仍在（用 ref 交叉确认这是 Zig 合法态） */
{
  const re = new RefGame({ w: 9, h: 9, mines: 10 })
  re.newGame(1)
  re.setFlag(40, 1)
  re.startAt(40, 0)
  console.log('参考实现同场景:', 'started=', re.started, 'open[40]=', re.open[40], 'moved=', re.moves)
}

/* 假设 5：普通中途局面（已知应 OK） */
{
  const g = new E.Game({ w: 9, h: 9, mines: 10 })
  g.newGame(1)
  g.startAt(40, 0)
  g.cycleFlag(0)
  tryWhy('假设5 普通中途', g.snapshot())
}
