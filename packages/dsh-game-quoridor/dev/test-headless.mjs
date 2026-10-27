/**
 * Headless runtime self test for @local/dsh-game-quoridor.
 *
 * Run: node dev/test-headless.mjs
 *
 * 不依赖浏览器：在 import client.js 之前装好假 window/document/canvas/
 * localStorage/ResizeObserver/定时器，然后通过测试 seam（window.__DSH_GAME_QUORIDOR__）
 * 的 createGame(host, opts) 驱动真实游戏实例，覆盖：
 *   - canvas 挂载 / dpr 背板 / 尺寸与 ResizeObserver
 *   - 指针走子 / 放墙 / 非法墙（重叠、封死）
 *   - 直跳 / 贴边斜跳 / 任意格到目标行获胜（用引擎重放出确定性局面存档）
 *   - 悔棋（pvp 一步 / pve 整回合）/ 重开 / 模式与设置
 *   - pve AI 应手、eve 暂停、document.hidden 暂停/恢复
 *   - 存档写入 / 恢复 / 损坏存档回退 / destroy 清理监听器与定时器
 */
import assert from 'node:assert/strict'

/* ---------------------------------------------------------------------------
 * 假浏览器环境（必须在 import client.js 之前装好）
 * ------------------------------------------------------------------------ */

const storage = new Map()
const docListeners = new Map()
const winListeners = new Map()
let clockMs = 1000
let lastResizeObserver = null
let loadedDefinition = null
let nextTimerId = 1
const timers = new Map() // id -> { fn, delay }

function makeContext() {
  const calls = {
    setTransform: [],
    clearRect: 0,
    fill: 0,
    stroke: 0,
    fillRect: 0,
    fillText: [],
    save: 0,
    restore: 0,
    arc: 0,
  }
  const context = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
    setTransform(...args) {
      calls.setTransform.push(args)
    },
    clearRect() {
      calls.clearRect += 1
    },
    fillRect() {
      calls.fillRect += 1
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    arc() {
      calls.arc += 1
    },
    closePath() {},
    fill() {
      calls.fill += 1
    },
    stroke() {
      calls.stroke += 1
    },
    save() {
      calls.save += 1
    },
    restore() {
      calls.restore += 1
    },
    fillText(text) {
      calls.fillText.push(String(text))
    },
  }
  return { context, calls }
}

function makeCanvas() {
  const { context, calls } = makeContext()
  const listeners = new Map()
  const canvas = {
    width: 0,
    height: 0,
    tabIndex: -1,
    style: { cssText: '', width: '', height: '' },
    attrs: {},
    focused: 0,
    removed: false,
    parent: null,
    listeners,
    calls,
    getContext(type) {
      assert.equal(type, '2d')
      return context
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
    },
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
    dispatch(type, event) {
      const listener = listeners.get(type)
      if (listener) listener(event)
    },
    focus() {
      this.focused += 1
    },
    remove() {
      this.removed = true
      if (this.parent) this.parent.removeChild(this)
    },
    getBoundingClientRect() {
      const width = Number.parseFloat(this.style.width) || 0
      const height = Number.parseFloat(this.style.height) || 0
      return { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 }
    },
  }
  return canvas
}

function makeHost(rect) {
  const children = []
  const host = {
    rect: Object.assign({ width: 800, height: 600 }, rect),
    children,
    getBoundingClientRect() {
      return this.rect
    },
    appendChild(node) {
      children.push(node)
      node.parent = this
    },
    removeChild(node) {
      const index = children.indexOf(node)
      if (index >= 0) children.splice(index, 1)
      if (node.parent === this) node.parent = null
    },
  }
  return host
}

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback
    this.observed = []
    this.disconnected = false
    lastResizeObserver = this
  }
  observe(target) {
    this.observed.push(target)
  }
  unobserve(target) {
    this.observed = this.observed.filter((item) => item !== target)
  }
  disconnect() {
    this.disconnected = true
    this.observed = []
  }
}

const documentStub = {
  hidden: false,
  createElement(tag) {
    assert.equal(tag, 'canvas')
    return makeCanvas()
  },
  addEventListener(type, listener) {
    docListeners.set(type, listener)
  },
  removeEventListener(type, listener) {
    if (docListeners.get(type) === listener) docListeners.delete(type)
  },
}

const windowStub = {
  __DSH_GAME_QUORIDOR_TEST__: true,
  __ModuleLoader__: {
    load(definition) {
      loadedDefinition = definition
    },
  },
  localStorage: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null
    },
    setItem(key, value) {
      storage.set(key, String(value))
    },
    removeItem(key) {
      storage.delete(key)
    },
  },
  performance: { now: () => clockMs },
  devicePixelRatio: 2,
  setTimeout(fn, delay) {
    const id = nextTimerId
    nextTimerId += 1
    timers.set(id, { fn, delay: Math.max(0, delay || 0) })
    return id
  },
  clearTimeout(id) {
    timers.delete(id)
  },
  addEventListener(type, listener) {
    winListeners.set(type, listener)
  },
  removeEventListener(type, listener) {
    if (winListeners.get(type) === listener) winListeners.delete(type)
  },
  ResizeObserver: FakeResizeObserver,
}

globalThis.window = windowStub
globalThis.document = documentStub
try {
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    writable: true,
    value: windowStub.performance,
  })
} catch (error) {
  /* 老 Node 不允许覆盖 performance：client.js 会退回真实时间，测试依然可跑 */
}

await import(new URL('../client.js', import.meta.url).href)

const seam = globalThis.window.__DSH_GAME_QUORIDOR__
assert.ok(seam, 'test seam window.__DSH_GAME_QUORIDOR__ should be installed')
const Q = seam.Q
const STORE_KEY = seam.STORE_KEY

/* ---------------------------------------------------------------------------
 * 测试基础设施
 * ------------------------------------------------------------------------ */

let passed = 0
let failed = 0
let currentGame = null

function resetWorld() {
  storage.clear()
  docListeners.clear()
  winListeners.clear()
  timers.clear()
  documentStub.hidden = false
  windowStub.devicePixelRatio = 2
  windowStub.performance.now = () => clockMs
  clockMs = 1000
  lastResizeObserver = null
}

function test(name, fn) {
  resetWorld()
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    failed += 1
    console.error('not ok - ' + name)
    console.error(error)
  } finally {
    try {
      if (currentGame) {
        currentGame.destroy()
        currentGame = null
      }
    } catch (cleanupError) {
      console.error(cleanupError)
    }
    timers.clear()
  }
}

function boot(rect, options) {
  const host = makeHost(rect || {})
  currentGame = seam.createGame(host, options || {})
  const canvas = host.children[0]
  return { host, game: currentGame, canvas }
}

function readSave() {
  const raw = storage.get(STORE_KEY)
  assert.ok(raw, 'save entry should exist')
  return JSON.parse(raw)
}

function saveGame(game, ui) {
  return seam.serializeSave(game, Object.assign({ mode: 'pvp', mySide: 0, level: 2, speed: 400 }, ui || {}))
}

function installSaveState(game, ui) {
  storage.set(STORE_KEY, JSON.stringify(saveGame(game, ui)))
}

/** 用 [mv, me] 历史重放，返回引擎 Game（同时校验每步合法）。 */
function replayHistory(history) {
  const game = new Q.Game()
  for (const entry of history) {
    const mv = entry[0]
    const me = entry[1]
    assert.equal(game.st.turn, me, 'history turn mismatch at move ' + mv)
    assert.equal(game.play(mv), true, 'history move should be legal: ' + mv)
  }
  return game
}

function installHistory(history, ui) {
  const game = replayHistory(history)
  installSaveState(game, ui)
  return game
}

function cellClick(row, col) {
  const point = currentGame.cellPoint(row, col)
  currentGame.getCanvas().dispatch('pointerdown', { clientX: point.x, clientY: point.y, button: 0 })
}

function wallClick(o, r, c) {
  const layout = currentGame.getLayout()
  assert.ok(layout, 'layout should exist when clicking the board')
  const point = currentGame.wallPoint(o, r, c)
  const offset = seam.CELL * 0.25 * layout.scale
  const clientX = o === Q.H ? point.x + offset : point.x
  const clientY = o === Q.V ? point.y + offset : point.y
  currentGame.getCanvas().dispatch('pointerdown', { clientX, clientY, button: 0 })
}

function engineStateToQ(engineState) {
  const state = Q.newState()
  state.pawn = engineState.pawn.slice()
  state.walls = engineState.walls.slice()
  state.hw = Uint8Array.from(engineState.hw)
  state.vw = Uint8Array.from(engineState.vw)
  state.turn = engineState.turn
  return state
}

function runTimerRounds(rounds) {
  for (let round = 0; round < rounds; round += 1) {
    if (timers.size === 0) return
    const entries = Array.from(timers.entries())
    timers.clear()
    for (const entry of entries) {
      clockMs += entry[1].delay
      entry[1].fn()
    }
  }
}

function pendingTimerCount() {
  return timers.size
}

/* 确定性局面（由 dev 期间的引擎随机对局搜索得出，纯 [mv, me] 历史，可复现） */

/** 直跳局面：红 (4,6)、蓝 (4,5)，红往左撞蓝后可跳到 (4,4)。 */
const JUMP_HISTORY = [
  67, 0, 3, 1, 180, 0, 2, 1, 68, 0, 11, 1, 77, 0, 2, 1, 68, 0, 1, 1, 59, 0, 2, 1,
  60, 0, 11, 1, 69, 0, 12, 1, 70, 0, 13, 1, 69, 0, 14, 1, 168, 0, 23, 1, 70, 0, 14, 1,
  61, 0, 141, 1, 52, 0, 15, 1, 43, 0, 14, 1, 52, 0, 5, 1, 43, 0, 4, 1, 34, 0, 13, 1,
  106, 0, 4, 1, 25, 0, 5, 1, 34, 0, 130, 1, 33, 0, 4, 1, 34, 0, 13, 1, 33, 0, 22, 1,
  42, 0, 23, 1, 43, 0, 32, 1, 42, 0, 41, 1,
]

/** 贴边斜跳局面：红 (3,7)、蓝贴右边缘 (3,8)，红往右直跳越界，只能斜跳到 (2,8)/(4,8)。 */
const DIAGONAL_EDGE_HISTORY = [
  77, 0, 13, 1, 68, 0, 22, 1, 77, 0, 21, 1, 76, 0, 30, 1, 67, 0, 31, 1, 58, 0, 32, 1,
  57, 0, 33, 1, 58, 0, 42, 1, 134, 0, 33, 1, 59, 0, 24, 1, 50, 0, 15, 1, 51, 0, 16, 1,
  50, 0, 25, 1, 41, 0, 16, 1, 50, 0, 17, 1, 41, 0, 8, 1, 50, 0, 17, 1, 41, 0, 202, 1,
  50, 0, 8, 1, 59, 0, 17, 1, 50, 0, 26, 1, 41, 0, 17, 1, 42, 0, 8, 1, 43, 0, 17, 1,
  130, 0, 16, 1, 34, 0, 17, 1, 43, 0, 26, 1, 34, 0, 35, 1,
]

/** 封死候选：红 (8,8)、蓝 (2,3)，红方放 V(3,1) 会封死蓝方（wallFits 通过、tryPlaceWall 拒绝）。 */
const SEALED_HISTORY = [
  67, 0, 5, 1, 58, 0, 104, 1, 166, 0, 6, 1, 57, 0, 5, 1, 58, 0, 190, 1, 160, 0, 14, 1,
  59, 0, 13, 1, 68, 0, 202, 1, 69, 0, 22, 1, 78, 0, 31, 1, 79, 0, 192, 1, 80, 0, 196, 1,
  71, 0, 32, 1, 70, 0, 99, 1, 61, 0, 110, 1, 60, 0, 113, 1, 61, 0, 150, 1, 70, 0, 23, 1,
  71, 0, 123, 1, 161, 0, 22, 1, 70, 0, 31, 1, 108, 0, 30, 1, 79, 0, 31, 1, 80, 0, 22, 1,
  71, 0, 31, 1, 80, 0, 22, 1, 101, 0, 21, 1,
]
const SEALED_WALL = { o: Q.V, r: 3, c: 1 }

/** 一步获胜：红 (1,5)、蓝 (0,2)，红点 (0,5) 即踏上目标行任意格获胜。 */
const WIN_HISTORY = [
  67, 0, 3, 1, 58, 0, 4, 1, 49, 0, 13, 1, 40, 0, 12, 1, 31, 0, 13, 1, 22, 0, 4, 1,
  13, 0, 3, 1, 14, 0, 2, 1,
]

function pairs(flat) {
  const out = []
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

/* ---------------------------------------------------------------------------
 * 1) boot / canvas / dpr / 初始存档
 * ------------------------------------------------------------------------ */

test('boot mounts a hidpi canvas and persists a fresh save', () => {
  const { host, game, canvas } = boot({})
  assert.equal(host.children.length, 1)
  assert.equal(canvas.width, 1200)
  assert.equal(canvas.height, 1200)
  assert.equal(canvas.style.width, '600px')
  assert.equal(canvas.style.height, '600px')
  assert.equal(canvas.tabIndex, 0)
  assert.equal(canvas.attrs.role, 'application')
  assert.ok(String(canvas.attrs['aria-label']).length > 0)
  assert.equal(host.children[0], canvas)

  const saved = readSave()
  assert.equal(saved.schemaVersion, 1)
  assert.equal(saved.mode, 'pvp')
  assert.equal(saved.mySide, 0)
  assert.equal(saved.level, 2)
  assert.equal(saved.speed, seam.SPEED_DEFAULT)
  assert.deepEqual(saved.game.st.pawn, [76, 4])
  assert.equal(saved.game.st.turn, 0)
  assert.deepEqual(saved.game.hist, [])
  assert.equal(saved.game.over, false)
  assert.equal(saved.game.winner, -1)

  assert.deepEqual(game.getState(), {
    mode: 'pvp',
    mySide: 0,
    level: 2,
    speed: seam.SPEED_DEFAULT,
    paused: false,
    busy: false,
    over: false,
    winner: -1,
    turn: 0,
    walls: [10, 10],
    dist: [8, 8],
    histLen: 0,
    canUndo: false,
    tooSmall: false,
    failure: null,
  })
})

test('onState receives the initial snapshot and layout is square', () => {
  const snapshots = []
  const { game } = boot({}, { onState: (snapshot) => snapshots.push(snapshot) })
  assert.ok(snapshots.length >= 1)
  assert.equal(snapshots[snapshots.length - 1].turn, 0)
  assert.equal(snapshots[snapshots.length - 1].histLen, 0)
  const layout = game.getLayout()
  assert.ok(layout)
  assert.equal(layout.cssWidth, 600)
  assert.equal(layout.cssHeight, 600)
  assert.ok(Math.abs(layout.scale - 600 / 610) < 1e-9)
  assert.equal(game.getEngineState().hw.length, 64)
  assert.equal(game.getEngineState().vw.length, 64)
  assert.deepEqual(game.getEngineState().pawn, [76, 4])
})

test('getCanvas / cellPoint / wallPoint match the canvas rect', () => {
  const { game, canvas } = boot({})
  assert.equal(game.getCanvas(), canvas)
  const rect = canvas.getBoundingClientRect()
  assert.equal(rect.width, 600)
  const center = game.cellPoint(0, 0)
  assert.ok(center.x > 0 && center.x < rect.width)
  assert.ok(center.y > 0 && center.y < rect.height)
  const seg = seam.wallSeg(Q.H, 0, 0)
  const point = game.wallPoint(Q.H, 0, 0)
  assert.ok(Math.abs(point.x - ((seg[0] + seg[2]) / 2) * game.getLayout().scale) < 1e-9)
  assert.ok(Math.abs(point.y - ((seg[1] + seg[3]) / 2) * game.getLayout().scale) < 1e-9)
})

/* ---------------------------------------------------------------------------
 * 2) 指针走子 / 放墙 / 非法输入
 * ------------------------------------------------------------------------ */

test('pointer down on a legal cell moves the red pawn and persists', () => {
  const { game, canvas } = boot({})
  cellClick(7, 4)
  const state = game.getState()
  assert.equal(state.histLen, 1)
  assert.equal(state.turn, 1)
  assert.equal(state.canUndo, true)
  assert.deepEqual(game.getEngineState().pawn, [67, 4])
  const saved = readSave()
  assert.equal(saved.game.hist.length, 1)
  assert.deepEqual(saved.game.st.pawn, [67, 4])
  assert.ok(canvas.calls.fill > 0, 'board should repaint after the move')
})

test('illegal cell clicks and out-of-board clicks change nothing', () => {
  const { game, canvas } = boot({})
  cellClick(0, 0) // 红方从 (8,4) 一步到不了 (0,0)
  assert.equal(game.getState().histLen, 0)
  const layout = game.getLayout()
  canvas.dispatch('pointerdown', { clientX: 2, clientY: layout.cssWidth + 5 })
  assert.equal(game.getState().histLen, 0)
  assert.equal(readSave().game.hist.length, 0)
})

test('pointer hover and leave repaint without changing the game', () => {
  const { game, canvas } = boot({})
  const before = canvas.calls.fill
  const point = game.cellPoint(7, 4)
  canvas.dispatch('pointermove', { clientX: point.x, clientY: point.y })
  assert.ok(canvas.calls.fill > before)
  canvas.dispatch('pointerleave', {})
  canvas.dispatch('pointermove', { clientX: point.x, clientY: point.y })
  assert.equal(game.getState().histLen, 0)
})

test('a legal wall drops the wall count and flips the turn', () => {
  const { game } = boot({})
  cellClick(7, 4) // 红走一步 -> 蓝方回合
  wallClick(Q.H, 2, 2)
  const state = game.getState()
  assert.equal(state.histLen, 2)
  assert.equal(state.turn, 0)
  assert.deepEqual(state.walls, [10, 9])
  const engineState = game.getEngineState()
  assert.equal(engineState.hw[2 * 8 + 2], 1)
  assert.equal(engineState.vw[2 * 8 + 2], 0)
  const saved = readSave()
  assert.equal(saved.game.hist[saved.game.hist.length - 1].mv, Q.encodeWall(Q.H, 2, 2))
})

test('overlapping / crossing walls are rejected without changing the board', () => {
  const { game } = boot({})
  cellClick(7, 4)
  wallClick(Q.H, 2, 2)
  const before = JSON.stringify(game.getEngineState())
  wallClick(Q.H, 2, 3) // 与 H(2,2) 重叠
  assert.equal(JSON.stringify(game.getEngineState()), before)
  wallClick(Q.V, 2, 2) // 与 H(2,2) 十字交叉
  assert.equal(JSON.stringify(game.getEngineState()), before)
  assert.equal(game.getState().histLen, 2)
})

test('a wall that would seal a player is rejected through pointer input', () => {
  installHistory(pairs(SEALED_HISTORY))
  const { game } = boot({})
  const engineState = game.getEngineState()
  const state = engineStateToQ(engineState)
  assert.equal(state.turn, 0)
  assert.equal(Q.wallFits(state, SEALED_WALL.o, SEALED_WALL.r, SEALED_WALL.c), true,
    'precondition: wall fits geometrically')
  assert.equal(Q.tryPlaceWall(engineStateToQ(engineState), SEALED_WALL.o, SEALED_WALL.r, SEALED_WALL.c, 0), false,
    'precondition: engine rejects the wall because it seals a player')
  const before = JSON.stringify(engineState)
  wallClick(SEALED_WALL.o, SEALED_WALL.r, SEALED_WALL.c)
  assert.equal(JSON.stringify(game.getEngineState()), before, 'sealed wall must not change the board')
  assert.equal(game.getState().histLen, engineState.histLen)
})

/* ---------------------------------------------------------------------------
 * 3) 跳跃 / 斜跳 / 获胜（由确定性历史重放出的真实局面）
 * ------------------------------------------------------------------------ */

test('straight jump over the opponent is playable via pointer', () => {
  installHistory(pairs(JUMP_HISTORY))
  const { game } = boot({})
  const engineState = game.getEngineState()
  assert.deepEqual(engineState.pawn, [42, 41])
  assert.equal(engineState.turn, 0)
  const legal = Q.legalMoves(engineStateToQ(engineState), 0)
  assert.ok(legal.indexOf(40) >= 0, 'engine says the straight jump to (4,4) is legal')
  const histBefore = engineState.histLen
  cellClick(4, 4)
  const after = game.getEngineState()
  assert.equal(after.pawn[0], 40)
  assert.equal(after.histLen, histBefore + 1)
})

test('edge diagonal jump (straight jump off board) is playable via pointer', () => {
  installHistory(pairs(DIAGONAL_EDGE_HISTORY))
  const { game } = boot({})
  const engineState = game.getEngineState()
  assert.deepEqual(engineState.pawn, [34, 35])
  assert.equal(engineState.turn, 0)
  const legal = Q.legalMoves(engineStateToQ(engineState), 0)
  assert.ok(legal.indexOf(26) >= 0, 'engine says diagonal (2,8) is legal')
  cellClick(2, 8)
  assert.equal(game.getEngineState().pawn[0], 26)
})

test('stepping onto any cell of the goal row wins immediately', () => {
  installHistory(pairs(WIN_HISTORY))
  const { game } = boot({})
  const engineState = game.getEngineState()
  assert.equal(engineState.turn, 0)
  assert.equal(engineState.over, false)
  cellClick(0, 5)
  const state = game.getState()
  assert.equal(state.over, true)
  assert.equal(state.winner, 0)
  const saved = readSave()
  assert.equal(saved.game.over, true)
  assert.equal(saved.game.winner, 0)
  // 已经结束：再点合法格子不应再走
  const before = JSON.stringify(game.getEngineState())
  cellClick(0, 0)
  assert.equal(JSON.stringify(game.getEngineState()), before)
})

/* ---------------------------------------------------------------------------
 * 4) 悔棋 / 重开 / 设置
 * ------------------------------------------------------------------------ */

test('undo steps back one move in pvp', () => {
  const { game } = boot({})
  cellClick(7, 4)
  cellClick(1, 4)
  assert.equal(game.getState().histLen, 2)
  assert.equal(game.undo(), true)
  assert.equal(game.getState().histLen, 1)
  assert.equal(game.getState().turn, 1)
  assert.deepEqual(game.getEngineState().pawn, [67, 4])
  assert.equal(readSave().game.hist.length, 1)
  assert.equal(game.undo(), true)
  assert.equal(game.getState().histLen, 0)
  assert.equal(game.undo(), false)
})

test('undo in pve rewinds the whole human+AI round', () => {
  const snapshots = []
  const { game } = boot({}, { onState: (snapshot) => snapshots.push(snapshot) })
  game.setMode('pve')
  game.setLevel(1)
  cellClick(7, 4) // 人类走
  runTimerRounds(3) // AI 应手
  const afterAI = game.getState()
  assert.equal(afterAI.histLen, 2)
  assert.equal(afterAI.turn, 0)
  game.undo()
  const afterUndo = game.getState()
  assert.equal(afterUndo.histLen, 0)
  assert.equal(afterUndo.turn, 0)
  assert.deepEqual(game.getEngineState().pawn, [76, 4])
  assert.ok(snapshots.length >= 3)
})

test('newGame clears the board but keeps mode / level / speed', () => {
  const { game } = boot({})
  game.setMode('pve')
  game.setLevel(3)
  game.setSpeed(800)
  cellClick(7, 4)
  runTimerRounds(3)
  assert.ok(game.getState().histLen >= 1)
  game.newGame()
  const state = game.getState()
  assert.equal(state.histLen, 0)
  assert.equal(state.turn, 0)
  assert.deepEqual(state.walls, [10, 10])
  assert.equal(state.mode, 'pve')
  assert.equal(state.level, 3)
  assert.equal(state.speed, 800)
  assert.deepEqual(game.getEngineState().pawn, [76, 4])
  assert.deepEqual(readSave().game.hist, [])
})

test('setMode / setSide restart, setLevel / setSpeed do not', () => {
  const { game } = boot({})
  cellClick(7, 4)
  game.setLevel(1)
  game.setSpeed(300)
  assert.equal(game.getState().histLen, 1, 'level/speed must not restart the game')
  assert.equal(game.getState().level, 1)
  assert.equal(game.getState().speed, 300)
  game.setSide(1)
  assert.equal(game.getState().histLen, 0)
  assert.equal(game.getState().mySide, 1)
  game.setMode('pve')
  assert.equal(game.getState().histLen, 0)
  assert.equal(game.getState().mode, 'pve')
  // 非法参数被忽略
  game.setLevel(9)
  game.setSpeed(Number.NaN)
  game.setSide(5)
  game.setMode('nope')
  assert.equal(game.getState().level, 1)
  assert.equal(game.getState().mySide, 1)
  assert.equal(game.getState().mode, 'pve')
})

/* ---------------------------------------------------------------------------
 * 5) AI 节奏 / 暂停 / 可见性
 * ------------------------------------------------------------------------ */

test('pve AI responds after its timers flush and never plays illegally', () => {
  const { game } = boot({})
  game.setMode('pve')
  game.setLevel(1)
  cellClick(7, 4)
  assert.equal(game.getState().busy, true)
  assert.ok(pendingTimerCount() > 0)
  runTimerRounds(3)
  const state = game.getState()
  assert.equal(state.histLen, 2)
  assert.equal(state.turn, 0)
  assert.equal(state.busy, false)
  const saved = readSave()
  const sanitized = seam.sanitizeSave(JSON.parse(JSON.stringify(saved)))
  assert.ok(sanitized, 'AI move must produce a legal history (sanitize round-trip)')
  assert.deepEqual(sanitized.game.st.pawn, saved.game.st.pawn)
  assert.equal(pendingTimerCount(), 0, 'human turn must not leave an AI timer')
})

test('pve on the blue side makes the AI (red) move first', () => {
  const { game } = boot({})
  game.setMode('pve')
  game.setSide(1)
  game.setLevel(1)
  assert.equal(game.getState().mySide, 1)
  assert.equal(game.getState().busy, true)
  runTimerRounds(3)
  const state = game.getState()
  assert.equal(state.histLen, 1)
  assert.equal(state.turn, 1, 'red AI moved, now it is the human blue side')
  assert.equal(state.busy, false)
})

test('eve pause stops the AI and resume continues it', () => {
  const { game } = boot({})
  game.setMode('eve')
  game.setLevel(1)
  assert.equal(game.getState().busy, true)
  runTimerRounds(3)
  const running = game.getState().histLen
  assert.ok(running >= 1)
  game.togglePause()
  assert.equal(game.getState().paused, true)
  assert.equal(pendingTimerCount(), 0)
  runTimerRounds(4)
  assert.equal(game.getState().histLen, running, 'paused eve must not move')
  game.togglePause()
  assert.equal(game.getState().paused, false)
  runTimerRounds(3)
  assert.ok(game.getState().histLen > running, 'resumed eve should move again')
})

test('document.hidden pauses AI and showing resumes it', () => {
  const { game } = boot({})
  game.setMode('pve')
  game.setLevel(1)
  cellClick(7, 4)
  assert.ok(pendingTimerCount() > 0, 'AI turn scheduled')
  documentStub.hidden = true
  docListeners.get('visibilitychange')()
  assert.equal(game.getState().busy, false)
  assert.equal(pendingTimerCount(), 0, 'hidden document cancels AI timers')
  assert.ok(storage.has(STORE_KEY), 'hidden pause persists the board')
  const histHidden = game.getState().histLen
  runTimerRounds(4)
  assert.equal(game.getState().histLen, histHidden, 'no AI move while hidden')
  documentStub.hidden = false
  docListeners.get('visibilitychange')()
  assert.ok(pendingTimerCount() > 0, 'showing resumes the AI')
  runTimerRounds(3)
  assert.equal(game.getState().histLen, histHidden + 1)
})

test('booting while hidden does not start the AI', () => {
  const replay = replayHistory([[67, 0]])
  installSaveState(replay, { mode: 'pve', mySide: 0, level: 1, speed: 400 })
  documentStub.hidden = true
  const { game } = boot({})
  assert.equal(game.getState().histLen, 1)
  assert.equal(game.getState().busy, false)
  assert.equal(pendingTimerCount(), 0, 'hidden boot must not schedule AI')
  documentStub.hidden = false
  docListeners.get('visibilitychange')()
  assert.ok(pendingTimerCount() > 0)
  runTimerRounds(3)
  assert.equal(game.getState().histLen, 2)
})

/* ---------------------------------------------------------------------------
 * 6) 尺寸 / dpr / 过小舞台
 * ------------------------------------------------------------------------ */

test('ResizeObserver recomputes size and dpr backing', () => {
  const { host, canvas } = boot({ width: 400, height: 300 })
  assert.equal(canvas.width, 600)
  assert.equal(canvas.height, 600)
  host.rect = { width: 600, height: 400 }
  lastResizeObserver.callback()
  assert.equal(canvas.width, 800)
  assert.equal(canvas.height, 800)
  windowStub.devicePixelRatio = 3
  lastResizeObserver.callback()
  assert.equal(canvas.width, 1200)
  assert.equal(canvas.height, 1200)
  const lastTransform = canvas.calls.setTransform[canvas.calls.setTransform.length - 1]
  assert.ok(Math.abs(lastTransform[0] - 1200 / 610) < 1e-9)
})

test('dpr changes without a host resize are re-applied on window resize', () => {
  const { canvas } = boot({ width: 400, height: 300 })
  assert.equal(canvas.width, 600)
  windowStub.devicePixelRatio = 3
  winListeners.get('resize')()
  assert.equal(canvas.width, 900)
  assert.equal(canvas.height, 900)
  assert.ok(Math.abs(canvas.calls.setTransform[canvas.calls.setTransform.length - 1][0] - 900 / 610) < 1e-9)
})

test('too-small stage shows a hint and reports tooSmall; enlarging restores the board', () => {
  const { host, game, canvas } = boot({ width: 300, height: 250 })
  assert.equal(game.getState().tooSmall, true)
  assert.equal(game.getLayout(), null)
  assert.ok(canvas.calls.fillText.includes('窗口太小'))
  assert.ok(canvas.calls.fillText.includes('请放大游戏区域'))
  assert.equal(canvas.style.width, '300px')
  assert.equal(canvas.width, 600)
  host.rect = { width: 800, height: 600 }
  lastResizeObserver.callback()
  assert.equal(game.getState().tooSmall, false)
  assert.ok(game.getLayout())
  assert.equal(canvas.style.width, '600px')
})

test('a zero-sized host does not crash and still gives a 1px canvas', () => {
  const { game, canvas } = boot({ width: 0, height: 0 })
  assert.equal(canvas.width, 1)
  assert.equal(canvas.height, 1)
  assert.equal(game.getLayout(), null)
  assert.equal(game.getState().tooSmall, true)
})

test('pointer input is ignored while the stage is too small', () => {
  const { game, canvas } = boot({ width: 300, height: 250 })
  canvas.dispatch('pointerdown', { clientX: 100, clientY: 100, button: 0 })
  assert.equal(game.getState().histLen, 0)
})

/* ---------------------------------------------------------------------------
 * 7) 存档恢复 / 损坏存档
 * ------------------------------------------------------------------------ */

test('destroy persists the board and a reboot restores the same position', () => {
  const first = boot({})
  cellClick(7, 4)
  wallClick(Q.H, 2, 2)
  const before = first.game.getEngineState()
  first.game.destroy()
  currentGame = null
  assert.equal(first.canvas.removed, true)
  const saved = readSave()
  assert.equal(saved.game.hist.length, 2)

  const second = boot({})
  const restored = second.game.getEngineState()
  assert.deepEqual(restored.pawn, before.pawn)
  assert.deepEqual(restored.walls, before.walls)
  assert.deepEqual(restored.hw, before.hw)
  assert.deepEqual(restored.vw, before.vw)
  assert.equal(restored.turn, before.turn)
  assert.equal(restored.histLen, before.histLen)
})

test('corrupt JSON storage silently falls back to a fresh game', () => {
  storage.set(STORE_KEY, '{ not json')
  const { game } = boot({})
  assert.equal(game.getState().histLen, 0)
  assert.equal(readSave().schemaVersion, 1)
})

test('unknown schema version falls back to a fresh game', () => {
  const replay = replayHistory([[67, 0]])
  const payload = saveGame(replay)
  payload.schemaVersion = 2
  storage.set(STORE_KEY, JSON.stringify(payload))
  const { game } = boot({})
  assert.equal(game.getState().histLen, 0)
  assert.equal(readSave().schemaVersion, 1)
})

test('invalid pawn / duplicate pawn saves fall back to a fresh game', () => {
  const replay = replayHistory([[67, 0]])
  const base = saveGame(replay)
  const outOfRange = JSON.parse(JSON.stringify(base))
  outOfRange.game.st.pawn = [999, 4]
  storage.set(STORE_KEY, JSON.stringify(outOfRange))
  assert.equal(boot({}).game.getState().histLen, 0)

  resetWorld()
  const duplicate = JSON.parse(JSON.stringify(base))
  duplicate.game.st.pawn = [5, 5]
  storage.set(STORE_KEY, JSON.stringify(duplicate))
  assert.equal(boot({}).game.getState().histLen, 0)
})

test('wall-count / occupancy mismatch saves fall back to a fresh game', () => {
  const replay = replayHistory([[67, 0]])
  const base = saveGame(replay)
  const badWalls = JSON.parse(JSON.stringify(base))
  badWalls.game.st.walls = [9, 10]
  storage.set(STORE_KEY, JSON.stringify(badWalls))
  assert.equal(boot({}).game.getState().histLen, 0)

  resetWorld()
  const badHw = JSON.parse(JSON.stringify(base))
  badHw.game.st.hw[0] = 1
  storage.set(STORE_KEY, JSON.stringify(badHw))
  assert.equal(boot({}).game.getState().histLen, 0)
})

test('illegal history / over-winner mismatch saves fall back to a fresh game', () => {
  const replay = replayHistory([[67, 0]])
  const base = saveGame(replay)

  const badMove = JSON.parse(JSON.stringify(base))
  badMove.game.hist[0].mv = 3 // 蓝方起点 (0,3)，红方走不到
  storage.set(STORE_KEY, JSON.stringify(badMove))
  assert.equal(boot({}).game.getState().histLen, 0)

  resetWorld()
  const badOver = JSON.parse(JSON.stringify(base))
  badOver.game.over = true
  storage.set(STORE_KEY, JSON.stringify(badOver))
  assert.equal(boot({}).game.getState().histLen, 0)

  resetWorld()
  const badWinner = JSON.parse(JSON.stringify(base))
  badWinner.game.winner = 1
  storage.set(STORE_KEY, JSON.stringify(badWinner))
  assert.equal(boot({}).game.getState().histLen, 0)
})

test('sanitizeSave clamps speed and rejects out-of-range settings', () => {
  const replay = replayHistory([])
  const payload = saveGame(replay, { mode: 'pve', mySide: 1, level: 1, speed: 99999 })
  const sanitized = seam.sanitizeSave(payload)
  assert.ok(sanitized)
  assert.equal(sanitized.speed, seam.SPEED_MAX)
  assert.equal(sanitized.mode, 'pve')
  assert.equal(sanitized.mySide, 1)

  const low = saveGame(replay, { speed: -5 })
  assert.equal(seam.sanitizeSave(low).speed, seam.SPEED_MIN)
  const noSpeed = saveGame(replay)
  delete noSpeed.speed
  assert.equal(seam.sanitizeSave(noSpeed).speed, seam.SPEED_DEFAULT)

  const badMode = saveGame(replay)
  badMode.mode = 'coop'
  assert.equal(seam.sanitizeSave(badMode), null)
  const badSide = saveGame(replay)
  badSide.mySide = 2
  assert.equal(seam.sanitizeSave(badSide), null)
  const badLevel = saveGame(replay)
  badLevel.level = 4
  assert.equal(seam.sanitizeSave(badLevel), null)
  assert.equal(seam.sanitizeSave(null), null)
  assert.equal(seam.sanitizeSave(''), null)
})

test('another game\'s storage key is never touched', () => {
  storage.set('dsh.game.2048.v1', '{"schemaVersion":1,"legacy":true}')
  const { game } = boot({})
  cellClick(7, 4)
  game.newGame()
  game.destroy()
  currentGame = null
  assert.equal(storage.get('dsh.game.2048.v1'), '{"schemaVersion":1,"legacy":true}')
  assert.ok(storage.has(STORE_KEY))
})

/* ---------------------------------------------------------------------------
 * 8) 生命周期清理
 * ------------------------------------------------------------------------ */

test('destroy removes canvas, listeners, observer and pending timers (idempotent)', () => {
  const replay = replayHistory([[67, 0]])
  installSaveState(replay, { mode: 'pve', mySide: 0, level: 1, speed: 400 })
  const { host, game, canvas } = boot({})
  assert.ok(pendingTimerCount() > 0, 'AI turn should have a pending timer at boot')
  const savedBeforeDestroy = readSave()
  game.destroy()
  currentGame = null
  assert.equal(canvas.removed, true)
  assert.equal(host.children.length, 0)
  assert.equal(canvas.listeners.size, 0)
  assert.equal(winListeners.size, 0)
  assert.equal(docListeners.size, 0)
  assert.equal(pendingTimerCount(), 0)
  assert.ok(lastResizeObserver.disconnected)
  assert.deepEqual(readSave(), savedBeforeDestroy)
  game.destroy() // 幂等
})

test('mount/destroy cycles leave no listeners or timers behind', () => {
  for (let cycle = 0; cycle < 10; cycle += 1) {
    const { game } = boot({})
    assert.deepEqual([...docListeners.keys()], ['visibilitychange'])
    assert.deepEqual([...winListeners.keys()], ['resize'])
    game.destroy()
    currentGame = null
    assert.equal(docListeners.size, 0)
    assert.equal(winListeners.size, 0)
    assert.equal(pendingTimerCount(), 0)
  }
})

test('a canvas without a 2d context fails fast and cleans up', () => {
  const badCanvas = makeCanvas()
  badCanvas.getContext = () => null
  const originalCreateElement = documentStub.createElement
  documentStub.createElement = () => badCanvas
  try {
    assert.throws(() => {
      seam.createGame(makeHost({ width: 800, height: 600 }))
    }, /2d canvas context unavailable/)
  } finally {
    documentStub.createElement = originalCreateElement
  }
  assert.equal(badCanvas.removed, false, 'nothing should be appended')
  assert.equal(docListeners.size, 0)
  assert.equal(winListeners.size, 0)
  assert.equal(pendingTimerCount(), 0)
})

/* ---------------------------------------------------------------------------
 * 9) seam 元数据 / 注册形状
 * ------------------------------------------------------------------------ */

test('the test seam exposes the documented constants and helpers', () => {
  assert.equal(seam.GAME_ID, 'quoridor')
  assert.equal(seam.STORE_KEY, 'dsh.game.quoridor.v1')
  assert.equal(seam.SCHEMA_VERSION, 1)
  assert.equal(seam.LOGICAL_SIZE, 610)
  assert.equal(seam.CELL, 58)
  assert.equal(seam.PAD, 44)
  assert.equal(seam.WALL_THICKNESS, 10)
  assert.equal(seam.MIN_STAGE_W, 320)
  assert.equal(seam.MIN_STAGE_H, 240)
  assert.deepEqual(seam.MODES, ['pvp', 'pve', 'eve'])
  assert.equal(seam.MODE_META.pvp.label, '双人对战')
  assert.equal(seam.MODE_META.pve.label, '人机对战')
  assert.equal(seam.MODE_META.eve.label, 'AI 对 AI')
  assert.deepEqual(seam.LEVEL_IDS, [1, 2, 3])
  assert.equal(seam.LEVELS[1].name, '简单')
  assert.equal(seam.SPEED_MIN, 200)
  assert.equal(seam.SPEED_MAX, 1000)
  assert.equal(seam.SPEED_DEFAULT, 400)
  assert.equal(typeof seam.createGame, 'function')
  assert.equal(typeof seam.computeLayout, 'function')
  assert.equal(typeof seam.wallSeg, 'function')
  assert.equal(typeof seam.wallAt, 'function')
  assert.equal(typeof seam.cellAt, 'function')
  assert.equal(typeof seam.sanitizeSave, 'function')
  assert.equal(typeof Q.newState, 'function')
  assert.equal(typeof Q.legalMoves, 'function')
  assert.equal(typeof Q.tryPlaceWall, 'function')
  assert.equal(typeof Q.chooseMove, 'function')
  assert.equal(typeof Q.Game, 'function')
})

test('the loader entry registers one game.stage slot for quoridor only', () => {
  assert.ok(loadedDefinition)
  assert.equal(loadedDefinition.id, '@local/dsh-game-quoridor')
  assert.equal(typeof loadedDefinition.factory, 'function')
  class StubComponent {
    constructor(props) {
      this.props = props
    }
  }
  const module = loadedDefinition.factory((name) => {
    assert.equal(name, 'react')
    return { createElement: () => null, Component: StubComponent }
  })
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.apply, 'function')
  const registrations = []
  let injected = null
  module.apply({
    slots: {
      inject(name, callback) {
        injected = name
        callback()
      },
      register(entry, Component) {
        registrations.push({ entry, Component })
        return function unregister() {}
      },
    },
  })
  assert.equal(injected, 'game.stage')
  assert.equal(registrations.length, 1)
  const entry = registrations[0].entry
  assert.equal(entry.name, 'game.stage')
  assert.equal(entry.id, 'quoridor')
  assert.equal(entry.label(), '墙棋')
  assert.notEqual(entry.select({ gameId: 'quoridor' }), null)
  assert.equal(entry.select({ gameId: '2048' }), null)
  assert.equal(entry.select(null), null)
  assert.equal(typeof registrations[0].Component, 'function')
})

/* ---------------------------------------------------------------------------
 * 汇总
 * ------------------------------------------------------------------------ */

console.log('')
console.log('headless tests: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
