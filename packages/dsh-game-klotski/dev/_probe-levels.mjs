/**
 * TEMPORARY dev probe (canonical BFS): candidate Klotski levels.
 * Merge identical-shape pieces (same w,h) into a position multiset so the
 * search runs on the quotient graph (identical pieces are interchangeable).
 * Min move count is unchanged; goal = cao top-left at (1,3).
 */
const W = 4
const H = 5
const GOAL_POS = 3 * W + 1 // (x=1, y=3)

function piece(id, type, w, h, x, y) {
  return { id, type, w, h, x, y }
}
const L = (id, name, pieces) => ({ id, name, pieces })

const LEVELS = [
  L('hengdao', '横刀立马', [
    piece('zhang', 'zhang', 1, 2, 0, 0), piece('cao', 'cao', 2, 2, 1, 0), piece('zhao', 'zhao', 1, 2, 3, 0),
    piece('ma', 'ma', 1, 2, 0, 2), piece('guan', 'guan', 2, 1, 1, 2), piece('huang', 'huang', 1, 2, 3, 2),
    piece('s1', 'bing', 1, 1, 1, 3), piece('s2', 'bing', 1, 1, 2, 3), piece('s3', 'bing', 1, 1, 0, 4), piece('s4', 'bing', 1, 1, 3, 4),
  ]),
  L('zhihui', '指挥若定', [
    piece('zhang', 'zhang', 1, 2, 0, 0), piece('cao', 'cao', 2, 2, 1, 0), piece('zhao', 'zhao', 1, 2, 3, 0),
    piece('ma', 'ma', 1, 2, 0, 2), piece('guan', 'guan', 2, 1, 1, 2), piece('huang', 'huang', 1, 2, 3, 2),
    piece('s1', 'bing', 1, 1, 1, 3), piece('s2', 'bing', 1, 1, 2, 3), piece('s3', 'bing', 1, 1, 1, 4), piece('s4', 'bing', 1, 1, 2, 4),
  ]),
  L('qitou', '齐头并进', [
    piece('zhang', 'zhang', 1, 2, 0, 0), piece('cao', 'cao', 2, 2, 1, 0), piece('zhao', 'zhao', 1, 2, 3, 0),
    piece('ma', 'ma', 1, 2, 0, 2), piece('s1', 'bing', 1, 1, 1, 2), piece('s2', 'bing', 1, 1, 2, 2),
    piece('huang', 'huang', 1, 2, 3, 2), piece('guan', 'guan', 2, 1, 1, 3),
    piece('s3', 'bing', 1, 1, 0, 4), piece('s4', 'bing', 1, 1, 3, 4),
  ]),
  L('cengceng', '层层设防', [
    piece('s1', 'bing', 1, 1, 0, 0), piece('cao', 'cao', 2, 2, 1, 0), piece('s2', 'bing', 1, 1, 3, 0),
    piece('zhang', 'zhang', 1, 2, 0, 1), piece('zhao', 'zhao', 1, 2, 3, 1), piece('guan', 'guan', 2, 1, 1, 2),
    piece('ma', 'ma', 1, 2, 0, 3), piece('s3', 'bing', 1, 1, 1, 3), piece('s4', 'bing', 1, 1, 2, 3),
    piece('huang', 'huang', 1, 2, 3, 3),
  ]),
]

function buildModel(level) {
  const groups = []
  const bySig = new Map()
  for (const p of level.pieces) {
    const sig = p.w + 'x' + p.h
    let g = bySig.get(sig)
    if (!g) {
      g = { sig, w: p.w, h: p.h, positions: [], pieceIds: [] }
      bySig.set(sig, g)
      groups.push(g)
    }
    g.positions.push(p.y * W + p.x)
    g.pieceIds.push(p.id)
  }
  for (const g of groups) g.positions.sort((a, b) => a - b)
  const caoGroup = groups.findIndex((g) => g.pieceIds.includes('cao'))
  const cao = level.pieces.find((p) => p.id === 'cao')
  const caoSlot = groups[caoGroup].positions.indexOf(cao.y * W + cao.x)
  return { groups, caoGroup, caoSlot }
}

function pack(groupLists) {
  let key = 0
  let shift = 0
  for (const positions of groupLists) {
    for (const pos of positions) {
      key += pos * 2 ** shift
      shift += 5
    }
  }
  return key
}

function unpack(model, key) {
  const lists = []
  let shift = 0
  for (const g of model.groups) {
    const arr = []
    for (let i = 0; i < g.positions.length; i += 1) {
      arr.push(Math.floor(key / 2 ** shift) % 32)
      shift += 5
    }
    arr.sort((a, b) => a - b)
    lists.push(arr)
  }
  return lists
}

function makeGrid(lists) {
  const grid = new Int8Array(W * H).fill(-1)
  const offsets = []
  let next = 0
  for (let gi = 0; gi < lists.length; gi += 1) {
    offsets.push(next)
    next += lists[gi].length
  }
  for (let gi = 0; gi < lists.length; gi += 1) {
    const g = lists[gi]
    for (let pi = 0; pi < g.length; pi += 1) {
      const pos = g[pi]
      const px = pos % W
      const py = Math.floor(pos / W)
      const gw = modelWidth(gi)
      const gh = modelHeight(gi)
      for (let dy = 0; dy < gh; dy += 1) {
        for (let dx = 0; dx < gw; dx += 1) {
          const k = (py + dy) * W + (px + dx)
          if (grid[k] !== -1) throw new Error('overlap at ' + k)
          grid[k] = offsets[gi] + pi
        }
      }
    }
  }
  return { grid, offsets }
}

// filled in per model before makeGrid calls
let modelWidth = () => 1
let modelHeight = () => 1

function bfs(level, limitStates = 5000000) {
  const model = buildModel(level)
  modelWidth = (gi) => model.groups[gi].w
  modelHeight = (gi) => model.groups[gi].h
  const startKey = pack(model.groups.map((g) => g.positions))
  const startRoundtrip = unpack(model, startKey)
  try {
    makeGrid(startRoundtrip)
  } catch (e) {
    throw new Error('START ROUNDTRIP BROKEN key=' + startKey + ' lists=' + JSON.stringify(startRoundtrip) + ' original=' + JSON.stringify(model.groups.map((g) => g.positions)) + ' err=' + e.message)
  }
  const queue = [startKey]
  const depth = new Map([[startKey, 0]])
  const parent = new Map()
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  let head = 0
  let edges = 0
  let goalKey = -1
  while (head < queue.length) {
    const key = queue[head]
    head += 1
    const d = depth.get(key)
    const lists = unpack(model, key)
    if (lists[model.caoGroup][model.caoSlot] === GOAL_POS) {
      goalKey = key
      break
    }
    const gridInfo = (() => {
      try {
        return makeGrid(lists)
      } catch (e) {
        const pm = parent.get(key)
        const prevLists = pm ? unpack(model, pm.prev) : null
        throw new Error('INVALID STATE key=' + key + ' lists=' + JSON.stringify(lists) + ' parent=' + JSON.stringify(pm) + ' prevLists=' + JSON.stringify(prevLists) + ' err=' + e.message)
      }
    })()
    const grid = gridInfo.grid
    const offsets = gridInfo.offsets
    for (let gi = 0; gi < lists.length; gi += 1) {
      const gw = model.groups[gi].w
      const gh = model.groups[gi].h
      for (let pi = 0; pi < lists[gi].length; pi += 1) {
        const pos = lists[gi][pi]
        const own = offsets[gi] + pi
        const px = pos % W
        const py = Math.floor(pos / W)
        for (const [dx, dy] of dirs) {
          for (let step = 1; step <= 2; step += 1) {
            const nx = px + dx * step
            const ny = py + dy * step
            if (nx < 0 || ny < 0 || nx + gw > W || ny + gh > H) break
            let blocked = false
            for (let t = 1; t <= step && !blocked; t += 1) {
              for (let yy = 0; yy < gh && !blocked; yy += 1) {
                for (let xx = 0; xx < gw; xx += 1) {
                  const owner = grid[(py + dy * t + yy) * W + (px + dx * t + xx)]
                  if (owner !== -1 && owner !== own) {
                    blocked = true
                    break
                  }
                }
              }
            }
            if (blocked) break
            edges += 1
            const nextLists = lists.map((arr) => arr.slice())
            nextLists[gi][pi] = ny * W + nx
            nextLists[gi].sort((a, b) => a - b)
            const nextKey = pack(nextLists)
            if (!depth.has(nextKey)) {
              depth.set(nextKey, d + 1)
              parent.set(nextKey, { prev: key, gi, from: pos, to: ny * W + nx })
              queue.push(nextKey)
              if (depth.size > limitStates) throw new Error('state limit exceeded')
            }
          }
        }
      }
    }
  }
  return { goalKey, depth, parent, visited: depth.size, edges }
}

for (const level of LEVELS) {
  const t0 = Date.now()
  const out = bfs(level)
  const ms = Date.now() - t0
  const moves = out.goalKey >= 0 ? out.depth.get(out.goalKey) : -1
  console.log(level.id, level.name, '=>', moves >= 0 ? 'SOLVABLE in ' + moves + ' moves' : 'UNSOLVABLE', '| visited=' + out.visited, '| edges=' + out.edges, '| ' + ms + 'ms')
}
