/**
 * Headless runtime self test for @local/dsh-game-complexweeper.
 *
 * Run: node dev/test-headless.mjs
 *
 * 不依赖浏览器：在 import client.js 之前装好假 window/document/canvas/
 * localStorage/ResizeObserver/rAF/performance，然后通过测试探针
 * （window.__DSH_GAME_COMPLEXSWEEPER__）的 createGame(host, opts) 驱动真实
 * 游戏实例，覆盖：
 *   - canvas 挂载 / dpr 背板 / ResizeObserver / 窗口 resize / <320x240 提示
 *   - 左键首点开局与首点安全、右键四类旗循环与计数、contextmenu 阻止
 *   - 双击 / 中键展开（判据通过、判据失败提示、失败不改变棋盘）
 *   - 胜利（翻开所有非雷格）/ 踩雷失败 / 复盘计数
 *   - 计时、document.hidden 暂停与恢复不跳时、每次操作落盘
 *   - 存档恢复 / 损坏存档回退 / 难度切换 / destroy 清理与可重复
 *   - 多次挂载卸载无监听器/定时器泄漏、无全局键盘监听
 */
import assert from 'node:assert/strict'

/* ---------------------------------------------------------------------------
 * 假浏览器环境（必须在 import client.js 之前装好）
 * ------------------------------------------------------------------------ */

const storage = new Map()
const rafState = { queue: [], nextId: 1 }
const timeoutState = { timers: new Map(), nextId: 1 }
const docListeners = new Map()
const winListeners = new Map()
let clockMs = 1000
let lastResizeObserver = null
let loadedDefinition = null
let createdCanvas = null

function makeContext() {
  const calls = {
    setTransform: [],
    clearRect: 0,
    fillRect: 0,
    fillText: [],
    fill: 0,
    stroke: 0,
    arc: 0,
    save: 0,
    restore: 0,
  }
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
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
    closePath() {},
    arc() {
      calls.arc += 1
    },
    fill() {
      calls.fill += 1
    },
    stroke() {
      calls.stroke += 1
    },
    fillText(text) {
      calls.fillText.push(String(text))
    },
    save() {
      calls.save += 1
    },
    restore() {
      calls.restore += 1
    },
  }
  return { ctx, calls }
}

function makeCanvas() {
  const { ctx, calls } = makeContext()
  const listeners = new Map()
  const canvas = {
    width: 0,
    height: 0,
    tabIndex: -1,
    tagName: 'CANVAS',
    nodeName: 'CANVAS',
    style: { cssText: '' },
    attrs: {},
    focused: 0,
    removed: false,
    parent: null,
    parentNode: null,
    listeners,
    calls,
    getContext(type) {
      assert.equal(type, '2d')
      return ctx
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
      if (this.parentNode && typeof this.parentNode.removeChild === 'function') this.parentNode.removeChild(this)
      else if (this.parent) this.parent.removeChild(this)
    },
  }
  createdCanvas = canvas
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

/* 注意：故意不提供 document.body —— client.js 一旦访问就会在测试里报错。 */
const documentStub = {
  hidden: false,
  title: 'untitled-dev-title',
  __viewport: { left: 0, top: 0, width: 900, height: 700 },
  createElement(tag) {
    if (String(tag) === 'canvas') return makeCanvas()
    return new FakeElement(tag)
  },
  createTextNode(text) {
    return new FakeTextNode(text)
  },
  addEventListener(type, listener) {
    docListeners.set(type, listener)
  },
  removeEventListener(type, listener) {
    if (docListeners.get(type) === listener) docListeners.delete(type)
  },
}

class FakeTextNode {
  constructor(text) {
    this.nodeValue = String(text)
    this.parentNode = null
    this.tagName = null
    this.children = []
  }

  get nextSibling() {
    if (!this.parentNode) return null
    const siblings = this.parentNode.children
    const index = siblings.indexOf(this)
    return index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null
  }
}

/** 极简宿主元素（只够 dev/fake-react.js 渲染 client.js 组件用）。 */
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeName = this.tagName
    this.children = []
    this.parentNode = null
    this.attributes = {}
    this.__listeners = new Map()
    this.style = { cssText: '' }
  }

  get nextSibling() {
    if (!this.parentNode) return null
    const siblings = this.parentNode.children
    const index = siblings.indexOf(this)
    return index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    this.children.push(node)
    return node
  }

  insertBefore(node, reference) {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    const index = reference ? this.children.indexOf(reference) : -1
    if (index >= 0) this.children.splice(index, 0, node)
    else this.children.push(node)
    return node
  }

  removeChild(node) {
    const index = this.children.indexOf(node)
    if (index >= 0) this.children.splice(index, 1)
    if (node.parentNode === this) node.parentNode = null
    return node
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }

  removeAttribute(name) {
    delete this.attributes[name]
  }

  addEventListener(type, listener) {
    this.__listeners.set(type, listener)
  }

  removeEventListener(type, listener) {
    if (this.__listeners.get(type) === listener) this.__listeners.delete(type)
  }

  dispatchEvent(event) {
    const listener = this.__listeners.get(event && event.type)
    if (typeof listener === 'function') listener(event)
    return !(event && event.defaultPrevented)
  }

  getBoundingClientRect() {
    return documentStub.__viewport
  }

  focus() {}
}

const windowStub = {
  __DSH_GAME_COMPLEXSWEEPER_TEST__: true,
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
  addEventListener(type, listener) {
    winListeners.set(type, listener)
  },
  removeEventListener(type, listener) {
    if (winListeners.get(type) === listener) winListeners.delete(type)
  },
  requestAnimationFrame(callback) {
    const id = rafState.nextId
    rafState.nextId += 1
    rafState.queue.push({ id, callback })
    return id
  },
  cancelAnimationFrame(id) {
    rafState.queue = rafState.queue.filter((item) => item.id !== id)
  },
  setTimeout(callback, delay) {
    const id = timeoutState.nextId
    timeoutState.nextId += 1
    timeoutState.timers.set(id, { callback, delay: Math.max(0, delay || 0) })
    return id
  },
  clearTimeout(id) {
    timeoutState.timers.delete(id)
  },
  ResizeObserver: FakeResizeObserver,
}

globalThis.window = windowStub
globalThis.document = documentStub

await import(new URL('../client.js', import.meta.url).href)

const seam = globalThis.window.__DSH_GAME_COMPLEXSWEEPER__
assert.ok(seam, 'test seam window.__DSH_GAME_COMPLEXSWEEPER__ should be installed')

/* dev 预览用的迷你 React，用来在 headless 里渲染真实组件（结局面板交互测试）。 */
await import(new URL('./fake-react.js', import.meta.url).href)
const FakeReact = globalThis.window.FakeReact
assert.ok(FakeReact && typeof FakeReact.render === 'function', 'dev/fake-react.js should expose FakeReact')
assert.equal(seam.STORE_KEY, 'dsh.game.complexweeper.v1')
assert.equal(seam.GAME_ID, 'complexweeper')
assert.ok(loadedDefinition, '__ModuleLoader__.load should capture the module definition')
assert.equal(loadedDefinition.id, '@local/dsh-game-complexweeper')

const STORE_KEY = seam.STORE_KEY
const MSG = seam.MSG

/* ---------------------------------------------------------------------------
 * 测试基础设施
 * ------------------------------------------------------------------------ */

let passed = 0
let failed = 0
let currentGame = null
let currentHost = null

function resetWorld() {
  storage.clear()
  rafState.queue = []
  timeoutState.timers.clear()
  timeoutState.nextId = 1
  docListeners.clear()
  winListeners.clear()
  documentStub.hidden = false
  documentStub.title = 'untitled-dev-title'
  windowStub.devicePixelRatio = 2
  clockMs = 1000
  lastResizeObserver = null
  createdCanvas = null
  currentGame = null
  currentHost = null
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
      if (currentGame) currentGame.destroy()
    } catch (cleanupError) {
      console.error(cleanupError)
    }
    timeoutState.timers.clear()
    currentGame = null
    currentHost = null
  }
}

function boot(rect, options) {
  const host = makeHost(rect || {})
  currentGame = seam.createGame(host, options || {})
  currentHost = host
  const canvas = host.children[0]
  return { host, game: currentGame, canvas }
}

function disposeCurrent() {
  if (currentGame) {
    currentGame.destroy()
    currentGame = null
  }
  currentHost = null
}

function readSave() {
  const raw = storage.get(STORE_KEY)
  assert.ok(raw, 'save entry should exist')
  return JSON.parse(raw)
}

function pendingRaf() {
  return rafState.queue.length
}

function advanceClock(ms) {
  clockMs += ms
}

function runRafOnce() {
  const queue = rafState.queue
  rafState.queue = []
  for (const item of queue) item.callback()
}

function runRafFor(ms, step) {
  const stride = step || 500
  for (let elapsed = 0; elapsed < ms; elapsed += stride) {
    advanceClock(stride)
    runRafOnce()
  }
}

/** 执行当前挂起的 setTimeout 回调（client 的一次性提示自动清除用）。 */
function fireTimers() {
  const entries = Array.from(timeoutState.timers.values())
  timeoutState.timers.clear()
  for (const entry of entries) entry.callback()
}

function pendingTimerCount() {
  return timeoutState.timers.size
}

/* ---------------------------------------------------------------------------
 * 极简 DOM 树工具（结局复盘面板的 headless 交互测试用）
 * ------------------------------------------------------------------------ */

function walkTree(node, visit) {
  if (!node) return
  visit(node)
  const children = node.children || []
  for (const child of children) walkTree(child, visit)
}

function findElement(root, predicate) {
  let found = null
  walkTree(root, function (node) {
    if (!found && node && node.tagName && predicate(node)) found = node
  })
  return found
}

function collectText(root) {
  const parts = []
  walkTree(root, function (node) {
    if (node && typeof node.nodeValue === 'string' && !node.tagName) parts.push(node.nodeValue)
  })
  return parts.join(' ')
}

function clickElement(element) {
  const event = {
    type: 'click',
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
  }
  element.dispatchEvent(event)
  return event
}

function dispatchVisibility(hidden) {
  documentStub.hidden = hidden
  const listener = docListeners.get('visibilitychange')
  assert.ok(listener, 'visibilitychange listener should be registered')
  listener({ type: 'visibilitychange' })
}

function dispatchWindowResize() {
  const listener = winListeners.get('resize')
  assert.ok(listener, 'window resize listener should be registered')
  listener({ type: 'resize' })
}

function pointerEvent(canvas, row, col, button) {
  const point = currentGame.cellPoint(row, col)
  assert.ok(point, 'layout should exist before clicking')
  const event = {
    clientX: point.x,
    clientY: point.y,
    button: button || 0,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
  }
  canvas.dispatch('pointerdown', event)
  return event
}

function leftClick(row, col) {
  return pointerEvent(currentGame.getCanvas(), row, col, 0)
}

function rightClick(row, col) {
  return pointerEvent(currentGame.getCanvas(), row, col, 2)
}

function middleClick(row, col) {
  return pointerEvent(currentGame.getCanvas(), row, col, 1)
}

function doubleClick(row, col) {
  const canvas = currentGame.getCanvas()
  const point = currentGame.cellPoint(row, col)
  assert.ok(point, 'layout should exist before double click')
  const event = {
    clientX: point.x,
    clientY: point.y,
    button: 0,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
  }
  canvas.dispatch('dblclick', event)
  return event
}

function contextMenu(row, col) {
  const canvas = currentGame.getCanvas()
  const point = currentGame.cellPoint(row, col)
  const event = {
    clientX: point.x,
    clientY: point.y,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
  }
  canvas.dispatch('contextmenu', event)
  return event
}

function rowColOf(cell, cols) {
  return { row: Math.floor(cell / cols), col: cell % cols }
}

/** 9×9 真开局局面（startAt 中心格），用于构造存档。 */
function startedGame(seed) {
  const game = new seam.Game({ w: 9, h: 9, mines: 10 })
  game.newGame(seed || 701)
  game.startAt(40, 0)
  return game
}

function installSaveFromEngine(game, difficulty, elapsedMs) {
  game.recountFlags()
  const payload = seam.buildSave(game, difficulty || 1, elapsedMs || 0)
  storage.set(STORE_KEY, JSON.stringify(payload))
  return payload
}

/** 找一格「已翻开、邻域有雷、且有未翻开未插旗邻格」的格子，用于展开测试。 */
function findExpandableCell(game) {
  for (let i = 0; i < game.n; i += 1) {
    if (game.open[i] === 0 || game.mine[i] !== 0) continue
    const neighbors = game.nbrs(i)
    const mineNeighbors = neighbors.filter((j) => game.mine[j] !== 0)
    const closedSafes = neighbors.filter(
      (j) => game.mine[j] === 0 && game.open[j] === 0 && game.flag[j] === 0,
    )
    if (mineNeighbors.length > 0 && closedSafes.length > 0) {
      return { cell: i, mineNeighbors, closedSafes }
    }
  }
  return null
}

function setCorrectFlags(game, mineCells) {
  for (const cell of mineCells) game.setFlag(cell, game.mine[cell])
  game.recountFlags()
}

/* =========================================================================
 * 1) 挂载 / 尺寸 / dpr
 * ========================================================================= */

test('mount: canvas attached, listeners registered, ResizeObserver observes host, dpr backing store', () => {
  const { host, game, canvas } = boot()
  assert.ok(canvas, 'canvas should be appended to host')
  assert.equal(host.children.length, 1)
  assert.equal(game.getCanvas(), canvas)
  assert.equal(canvas.tabIndex, 0)
  assert.equal(canvas.attrs.role, 'application')
  assert.ok(canvas.attrs['aria-label'].indexOf('复扫雷') >= 0, 'canvas aria-label')
  assert.ok(lastResizeObserver, 'ResizeObserver should be constructed')
  assert.equal(lastResizeObserver.observed.length, 1)
  assert.equal(lastResizeObserver.observed[0], host)
  assert.ok(docListeners.has('visibilitychange'), 'document visibilitychange listener')
  assert.ok(winListeners.has('resize'), 'window resize listener')
  for (const type of ['pointerdown', 'pointermove', 'pointerleave', 'contextmenu', 'dblclick', 'auxclick']) {
    assert.ok(canvas.listeners.has(type), 'canvas listener ' + type)
  }
  assert.equal(canvas.width, 800 * 2, 'canvas backing width = cssW * dpr')
  assert.equal(canvas.height, 600 * 2, 'canvas backing height = cssH * dpr')
  const transforms = canvas.calls.setTransform
  assert.ok(transforms.length > 0, 'setTransform should be called when painting')
  assert.deepEqual(transforms[transforms.length - 1], [2, 0, 0, 2, 0, 0])
  assert.ok(game.getLayout(), 'layout available at 800x600')
  assert.ok(canvas.calls.fillRect > 0, 'board should be painted')
})

test('resize: ResizeObserver and dpr changes recompute layout + backing store', () => {
  const { host, game, canvas } = boot()
  const layoutBefore = game.getLayout()
  assert.ok(layoutBefore)
  host.rect = { width: 640, height: 480 }
  lastResizeObserver.callback()
  assert.equal(canvas.width, 640 * 2)
  assert.equal(canvas.height, 480 * 2)
  const layoutAfter = game.getLayout()
  assert.ok(layoutAfter && layoutAfter.cell < layoutBefore.cell, 'cell should shrink with the stage')
  windowStub.devicePixelRatio = 3
  dispatchWindowResize()
  assert.equal(canvas.width, 640 * 3, 'dpr change should re-arm backing store')
  assert.equal(canvas.height, 480 * 3)
  const lastTransform = canvas.calls.setTransform[canvas.calls.setTransform.length - 1]
  assert.deepEqual(lastTransform, [3, 0, 0, 3, 0, 0])
})

test('too small (<320x240): 窗口太小 prompt and no layout', () => {
  const { game, canvas } = boot({ width: 300, height: 200 })
  assert.equal(game.getLayout(), null, 'tiny stage should not expose a layout')
  assert.ok(canvas.calls.fillText.indexOf('窗口太小') >= 0, 'should draw 窗口太小')
  assert.ok(canvas.calls.fillText.indexOf('请放大游戏区域') >= 0, 'should draw 请放大游戏区域')
  /* 放大后恢复棋盘 */
  currentHost.rect = { width: 800, height: 600 }
  lastResizeObserver.callback()
  assert.ok(game.getLayout(), 'layout should come back after enlarging')
})

test('onSize callback reports viewport and tooSmall (React collapses toolbar in compact mode)', () => {
  const reports = []
  const host = makeHost({ width: 800, height: 600 })
  currentHost = host
  currentGame = seam.createGame(host, {
    onSize: function (next) {
      reports.push(next)
    },
  })
  assert.ok(reports.length >= 1, 'onSize should fire on mount')
  const first = reports[reports.length - 1]
  assert.deepEqual(
    { width: first.width, height: first.height, tooSmall: first.tooSmall },
    { width: 800, height: 600, tooSmall: false },
  )
  host.rect = { width: 300, height: 200 }
  lastResizeObserver.callback()
  const tiny = reports[reports.length - 1]
  assert.deepEqual(
    { width: tiny.width, height: tiny.height, tooSmall: tiny.tooSmall },
    { width: 300, height: 200, tooSmall: true },
  )
  host.rect = { width: 900, height: 640 }
  lastResizeObserver.callback()
  const restored = reports[reports.length - 1]
  assert.equal(restored.tooSmall, false, 'tooSmall should clear after enlarging')
})

/* =========================================================================
 * 2) 左键 / 右键 / 双击 / 中键
 * ========================================================================= */

test('left click: first reveal starts game, first cell + ring are safe, timer runs', () => {
  const { game, canvas } = boot()
  const stateBefore = game.getState()
  assert.equal(stateBefore.started, false)
  assert.equal(stateBefore.status.indexOf('左键'), 0)
  leftClick(4, 4)
  const state = game.getState()
  assert.equal(state.started, true, 'first click should start the game')
  assert.ok(state.opened >= 9, 'first click should cascade at least the 3x3 ring')
  const engine = game.getGame()
  assert.equal(engine.startCell, 4 * 9 + 4, 'startCell recorded')
  assert.equal(engine.mine[engine.startCell], 0, 'first cell is safe')
  for (const neighbor of engine.nbrs(engine.startCell)) {
    assert.equal(engine.mine[neighbor], 0, 'first-click ring is safe')
  }
  assert.equal(canvas.focused > 0, true, 'canvas should be focused on click')
  advanceClock(5000)
  runRafFor(1000)
  assert.ok(game.getState().elapsedMs >= 5000, 'timer should run while playing')
  game.persistNow()
  const saved = readSave()
  assert.equal(saved.schemaVersion, 1)
  assert.equal(saved.difficulty, 1)
  assert.equal(saved.state.started, true)
  assert.ok(saved.state.elapsedMs >= 5000, 'save should contain elapsed time')
  assert.ok(pendingRaf() > 0, 'timer loop keeps a rAF pending while playing')
})

test('right click: four-type flag cycle + counts; contextmenu prevented; flagged cell cannot open', () => {
  const { game, canvas } = boot()
  const events = []
  for (let step = 1; step <= 5; step += 1) {
    events.push(rightClick(0, 0))
    const state = game.getState()
    assert.equal(state.flags, step === 5 ? 0 : 1, 'exactly one flag during the cycle (step ' + step + ')')
    if (step <= 4) {
      assert.equal(state.flagsOf[step], 1, 'flag type ' + step + ' counted')
    } else {
      for (let type = 1; type <= 4; type += 1) assert.equal(state.flagsOf[type], 0, 'cycle returns to empty')
    }
    assert.equal(events[step - 1].defaultPrevented, true, 'right button pointerdown should preventDefault')
  }
  const menu = contextMenu(0, 0)
  assert.equal(menu.defaultPrevented, true, 'contextmenu should be prevented')
  /* 已翻开格不能插旗 */
  leftClick(4, 4)
  const flagsBefore = game.getState().flags
  rightClick(4, 4)
  assert.equal(game.getState().flags, flagsBefore, 'revealed cell cannot be flagged')
  /* 有旗格翻不开（挑一个首点连片后仍未翻开的格子） */
  const engineAfterFirstClick = game.getGame()
  let closedCell = -1
  for (let i = 0; i < engineAfterFirstClick.n; i += 1) {
    if (engineAfterFirstClick.open[i] === 0 && engineAfterFirstClick.flag[i] === 0) {
      closedCell = i
      break
    }
  }
  assert.ok(closedCell >= 0, 'there should be a closed cell after the first click')
  const closedInfo = rowColOf(closedCell, 9)
  rightClick(closedInfo.row, closedInfo.col)
  assert.equal(game.getState().flags, 1)
  const openedBefore = game.getGame().openedCount()
  leftClick(closedInfo.row, closedInfo.col)
  assert.equal(game.getGame().openedCount(), openedBefore, 'flagged cell cannot be revealed')
  assert.equal(game.getGame().flag[closedCell], 1, 'flag stays until cycled back')
})

test('double click on revealed number with over-flagged neighbours expands when judgement passes', () => {
  const engine = startedGame(701)
  const target = findExpandableCell(engine)
  assert.ok(target, 'constructed board should contain an expandable number cell')
  setCorrectFlags(engine, target.mineNeighbors)
  const openedBefore = engine.openedCount()
  installSaveFromEngine(engine, 1, 0)
  const { game } = boot()
  const info = rowColOf(target.cell, 9)
  const event = doubleClick(info.row, info.col)
  assert.equal(event.defaultPrevented, true, 'double click should preventDefault')
  const after = game.getGame()
  assert.equal(after.msg, MSG.EXPAND_OK, 'judgement should pass => EXPAND_OK (or WIN)')
  assert.ok(after.openedCount() > openedBefore, 'neighbours should be opened')
  /* 一次性提示（EXPAND_OK）应安排自动清除，清除后回到「进行中」 */
  assert.equal(pendingTimerCount(), 1, 'transient EXPAND_OK message should schedule an auto-clear timer')
  fireTimers()
  assert.equal(after.msg, MSG.NONE, 'EXPAND_OK should clear after ~1.8s')
  assert.equal(game.getState().status.indexOf('展开成功'), -1, 'status text should fall back to 进行中')
})

test('middle click expands (pointerdown button 1) and prevents default', () => {
  const engine = startedGame(902)
  const target = findExpandableCell(engine)
  assert.ok(target)
  setCorrectFlags(engine, target.mineNeighbors)
  const openedBefore = engine.openedCount()
  installSaveFromEngine(engine, 1, 0)
  const { game } = boot()
  const info = rowColOf(target.cell, 9)
  const event = middleClick(info.row, info.col)
  assert.equal(event.defaultPrevented, true, 'middle pointerdown should preventDefault')
  const after = game.getGame()
  assert.ok(after.openedCount() > openedBefore, 'middle click should open neighbours')
  assert.ok(after.msg === MSG.EXPAND_OK || after.msg === MSG.WIN, 'middle click uses tryExpand')
})

test('judge failure: explicit 判定不通过 feedback, board unchanged, flash painted', () => {
  const engine = startedGame(701)
  const target = findExpandableCell(engine)
  assert.ok(target)
  /* 邻域有雷但不插旗 → 总旗数不对 → 判据失败 */
  const openedBefore = engine.openedCount()
  installSaveFromEngine(engine, 1, 0)
  const { game, canvas } = boot()
  const paintCountBefore = canvas.calls.fillRect
  const info = rowColOf(target.cell, 9)
  leftClick(info.row, info.col) // 已翻开格：无副作用
  doubleClick(info.row, info.col)
  const after = game.getGame()
  assert.equal(after.msg, MSG.JUDGE_FAIL, 'msg should be JUDGE_FAIL')
  assert.equal(after.openedCount(), openedBefore, 'failed judgement must not change the board')
  const state = game.getState()
  assert.ok(state.status.indexOf('判定不通过') >= 0, 'status text should say 判定不通过')
  assert.equal(state.msg, MSG.JUDGE_FAIL)
  assert.ok(canvas.calls.fillRect > paintCountBefore, 'flash overlay should repaint the canvas')
  /* 判定失败提示自动清除（约 1.8s），且 destroy 会清掉挂起的 timer */
  assert.equal(pendingTimerCount(), 1, 'JUDGE_FAIL should schedule an auto-clear timer')
  game.destroy()
  assert.equal(pendingTimerCount(), 0, 'destroy() must clear the pending message timer')
})

test('judge failure status auto-clears after ~1.8s (no stale red badge)', () => {
  const engine = startedGame(701)
  const target = findExpandableCell(engine)
  assert.ok(target)
  installSaveFromEngine(engine, 1, 0)
  const { game } = boot()
  const info = rowColOf(target.cell, 9)
  doubleClick(info.row, info.col)
  assert.equal(game.getGame().msg, MSG.JUDGE_FAIL)
  assert.equal(pendingTimerCount(), 1)
  fireTimers()
  assert.equal(pendingTimerCount(), 0)
  assert.equal(game.getGame().msg, MSG.NONE, 'JUDGE_FAIL should be cleared automatically')
  assert.equal(game.getState().status.indexOf('判定不通过'), -1, 'red badge text should be gone')
  assert.equal(readSave().state.msg, MSG.NONE, 'cleared message should be persisted')
})

/* =========================================================================
 * 3) 胜负 / 复盘
 * ========================================================================= */

test('win: revealing the last safe cell ends the game with win=true', () => {
  const engine = startedGame(701)
  const closedSafes = []
  for (let i = 0; i < engine.n; i += 1) {
    if (engine.mine[i] === 0 && engine.open[i] === 0) closedSafes.push(i)
  }
  assert.ok(closedSafes.length >= 2, 'need at least two closed safe cells')
  for (let k = 0; k < closedSafes.length - 1; k += 1) engine.reveal(closedSafes[k], 0)
  const last = closedSafes[closedSafes.length - 1]
  assert.equal(engine.win, false, 'still playing before the last safe cell')
  installSaveFromEngine(engine, 1, 3210)
  const { game } = boot()
  assert.equal(game.getState().started, true)
  const info = rowColOf(last, 9)
  leftClick(info.row, info.col)
  const state = game.getState()
  assert.equal(state.over, true, 'win should set over')
  assert.equal(state.win, true, 'all safe cells opened => win')
  assert.ok(state.status.indexOf('胜利') >= 0, 'status should say 胜利')
  assert.equal(game.getGame().openedCount(), game.getGame().safeCount(), 'every safe cell revealed')
  assert.equal(readSave().state.win, true, 'win state persisted')
})

test('loss: revealing a mine explodes; review counts correct/wrong flags', () => {
  const engine = startedGame(701)
  const closedMines = []
  const closedSafes = []
  for (let i = 0; i < engine.n; i += 1) {
    if (engine.open[i] !== 0) continue
    if (engine.mine[i] !== 0) closedMines.push(i)
    else closedSafes.push(i)
  }
  assert.ok(closedMines.length >= 2, 'need two closed mines')
  assert.ok(closedSafes.length >= 1, 'need a closed safe cell')
  const correctMine = closedMines[0]
  const boomMine = closedMines[1]
  engine.setFlag(correctMine, engine.mine[correctMine]) // 标对
  engine.setFlag(closedSafes[0], engine.mine[correctMine] === 1 ? 2 : 1) // 标错（安全格）
  engine.recountFlags()
  installSaveFromEngine(engine, 1, 1500)
  const { game } = boot()
  const stateBefore = game.getState()
  assert.equal(stateBefore.correctFlags, 1, 'one correct flag before loss')
  assert.ok(stateBefore.wrongFlags >= 1, 'one wrong flag before loss')
  const info = rowColOf(boomMine, 9)
  leftClick(info.row, info.col)
  const after = game.getGame()
  assert.equal(after.over, true, 'loss sets over')
  assert.equal(after.win, false, 'loss does not win')
  assert.equal(after.boom, boomMine, 'boom records the exploded mine')
  assert.equal(after.correctFlags(), 1, 'review: correct flag still counted')
  const state = game.getState()
  assert.equal(state.correctFlags, 1)
  assert.equal(state.wrongFlags, 1, 'review counts the wrong flag')
  assert.ok(state.status.indexOf('踩到雷') >= 0, 'status should explain the loss')
  assert.equal(readSave().state.over, true, 'loss persisted')
})

/* =========================================================================
 * 4) 计时 / hidden 暂停
 * ========================================================================= */

test('document.hidden pauses timer and saves; resuming does not jump over hidden time', () => {
  const { game } = boot()
  leftClick(4, 4)
  advanceClock(3000)
  runRafFor(500)
  const beforeHide = game.getState().elapsedMs
  assert.ok(beforeHide >= 3000, 'timer before hide')
  dispatchVisibility(true)
  assert.equal(pendingRaf(), 0, 'rAF loop should be cancelled while hidden')
  const savedAtHide = readSave()
  assert.ok(savedAtHide.state.elapsedMs >= 3000, 'hide should persist elapsed time')
  advanceClock(20000)
  assert.equal(game.getState().elapsedMs, savedAtHide.state.elapsedMs,
    'hidden wall-clock time must not be counted')
  dispatchVisibility(false)
  advanceClock(2000)
  runRafFor(500)
  const afterResume = game.getState().elapsedMs
  assert.ok(afterResume >= savedAtHide.state.elapsedMs + 2000,
    'timer resumes from the hidden value without jumping')
  assert.ok(afterResume < savedAtHide.state.elapsedMs + 5000,
    'hidden time (20s) must not be added')
})

/* =========================================================================
 * 5) 存档
 * ========================================================================= */

test('restore: board, flags, elapsed and difficulty survive destroy + remount', () => {
  const first = boot()
  leftClick(4, 4)
  rightClick(0, 0)
  rightClick(0, 1)
  advanceClock(4000)
  const before = first.game.getState()
  const snapshot = JSON.stringify(first.game.getGame().snapshot())
  disposeCurrent()
  const saved = readSave()
  assert.equal(saved.state.started, true)
  const second = boot()
  const after = second.game.getState()
  assert.equal(after.started, true, 'restore keeps started')
  assert.equal(after.difficulty, before.difficulty, 'restore keeps difficulty')
  assert.equal(after.flags, before.flags, 'restore keeps flags')
  assert.equal(after.opened, before.opened, 'restore keeps opened cells')
  assert.equal(JSON.stringify(second.game.getGame().snapshot().open), JSON.stringify(JSON.parse(snapshot).open),
    'restore keeps open array')
  assert.ok(after.elapsedMs >= 4000, 'restore keeps elapsed time')
})

test('bad save (invalid JSON) -> fresh game, no throw, key rewritten', () => {
  storage.set(STORE_KEY, '{not-json')
  const { game } = boot()
  const state = game.getState()
  assert.equal(state.started, false, 'invalid JSON should fall back to a fresh game')
  assert.equal(game.getLayout() !== null, true, 'still renders')
  const rewritten = readSave()
  assert.equal(rewritten.schemaVersion, 1)
  assert.equal(rewritten.state.started, false)
})

test('bad save (schemaVersion mismatch) -> fresh game', () => {
  storage.set(STORE_KEY, JSON.stringify({ schemaVersion: 2, difficulty: 1, state: {} }))
  const { game } = boot()
  assert.equal(game.getState().started, false, 'version mismatch should start fresh')
  assert.equal(readSave().schemaVersion, 1, 'save key is rewritten with schemaVersion 1')
})

test('bad save (state fails fromSnapshot) -> fresh game', () => {
  const engine = startedGame(701)
  const save = seam.buildSave(engine, 1, 1000)
  save.state.open[0] = 9 // 非法值
  storage.set(STORE_KEY, JSON.stringify(save))
  const { game } = boot()
  assert.equal(game.getState().started, false, 'corrupt state should start fresh')
  assert.equal(readSave().state.started, false)
})

test('difficulty switch: preset size, saved difficulty, invalid id rejected', () => {
  const { game } = boot()
  leftClick(4, 4)
  assert.equal(game.setDifficulty(3), true)
  assert.equal(game.getGame().w, 30, 'expert width')
  assert.equal(game.getGame().h, 16, 'expert height')
  assert.equal(game.getGame().mines, 99, 'expert mine count')
  assert.equal(game.getState().difficulty, 3)
  assert.equal(readSave().difficulty, 3)
  assert.equal(game.getLayout().cols, 30)
  assert.equal(game.setDifficulty(99), false, 'unknown difficulty rejected')
  assert.equal(game.getState().difficulty, 3, 'difficulty unchanged after rejection')
  /* 三档尺寸都对 */
  for (const preset of seam.PRESETS) {
    assert.equal(game.setDifficulty(preset.id), true)
    assert.equal(game.getGame().w, preset.w)
    assert.equal(game.getGame().h, preset.h)
    assert.equal(readSave().difficulty, preset.id)
  }
})

test('persistence: save key isolated, format stable, written on every action', () => {
  storage.set('dsh.game.minesweeper.v1', 'minesweeper-save')
  storage.set('dsh.game.2048.v1', '2048-save')
  storage.set('dsh.game.quoridor.v1', 'quoridor-save')
  const { game } = boot()
  const initial = readSave()
  assert.deepEqual(Object.keys(initial).sort(), ['difficulty', 'schemaVersion', 'state'])
  assert.equal(initial.schemaVersion, 1)
  assert.equal(initial.difficulty, 1)
  assert.ok(Array.isArray(initial.state.mine) && initial.state.mine.length === 81)
  assert.ok(Array.isArray(initial.state.flag) && initial.state.flag.length === 81)
  leftClick(4, 4)
  const afterReveal = readSave()
  assert.equal(afterReveal.state.started, true)
  rightClick(8, 8)
  const afterFlag = readSave()
  assert.equal(afterFlag.state.flag[80], 1, 'flag persisted immediately')
  assert.equal(storage.get('dsh.game.minesweeper.v1'), 'minesweeper-save', 'other save keys untouched')
  assert.equal(storage.get('dsh.game.2048.v1'), '2048-save')
  assert.equal(storage.get('dsh.game.quoridor.v1'), 'quoridor-save')
  assert.equal(storage.size, 4, 'only our key was added')
  assert.equal(game.getState().flags, 1)
})

test('deterministic seed: same options.random + same first click => same board', () => {
  const makeBoard = () => {
    resetWorld()
    const host = makeHost({ width: 800, height: 600 })
    const game = seam.createGame(host, { random: () => 0.42 })
    game.reveal(4 * 9 + 4)
    const snapshot = JSON.stringify(game.getGame().snapshot().mine)
    game.destroy()
    return snapshot
  }
  const first = makeBoard()
  const second = makeBoard()
  assert.equal(first, second, 'same seed must produce the same mine layout')
  resetWorld()
})

/* =========================================================================
 * 6) 清理 / 泄漏 / 键盘
 * ========================================================================= */

test('destroy: cleans listeners/RO/rAF, persists, idempotent', () => {
  const { host, game, canvas } = boot()
  leftClick(4, 4)
  advanceClock(2500)
  const snapshotBefore = JSON.stringify(game.getGame().snapshot())
  game.destroy()
  assert.equal(canvas.removed, true, 'canvas removed from DOM')
  assert.equal(host.children.length, 0, 'host has no children after destroy')
  assert.equal(lastResizeObserver.disconnected, true, 'ResizeObserver disconnected')
  assert.equal(docListeners.size, 0, 'document listeners removed')
  assert.equal(winListeners.size, 0, 'window listeners removed')
  assert.equal(canvas.listeners.size, 0, 'canvas listeners removed')
  assert.equal(pendingRaf(), 0, 'rAF cancelled')
  const saved = readSave()
  assert.equal(saved.state.started, true)
  assert.ok(saved.state.elapsedMs >= 2500, 'destroy persists elapsed time')
  assert.equal(JSON.stringify(saved.state.open), JSON.stringify(JSON.parse(snapshotBefore).open),
    'destroy persists current board')
  /* 可重复调用 */
  game.destroy()
  game.destroy()
  assert.equal(canvas.removed, true)
})

test('repeated mount/unmount: no listener, observer or timer leaks', () => {
  for (let round = 0; round < 15; round += 1) {
    const host = makeHost({ width: 720, height: 560 })
    const game = seam.createGame(host)
    game.reveal(4 * 9 + 4)
    advanceClock(1000)
    runRafFor(500)
    game.destroy()
    assert.equal(docListeners.size, 0, 'no document listener left after round ' + round)
    assert.equal(winListeners.size, 0, 'no window listener left after round ' + round)
    assert.equal(pendingRaf(), 0, 'no rAF left after round ' + round)
    assert.equal(host.children.length, 0, 'canvas removed after round ' + round)
    assert.ok(lastResizeObserver.disconnected, 'ResizeObserver disconnected in round ' + round)
  }
  assert.equal(storage.size, 1, 'only the game save key exists')
  const saved = readSave()
  assert.equal(saved.state.started, true, 'final save keeps the game')
})

test('no keyboard listeners anywhere; document.body untouched; title unchanged', () => {
  const { canvas } = boot()
  leftClick(4, 4)
  doubleClick(4, 4)
  const keyboardTypes = ['keydown', 'keyup', 'keypress']
  for (const type of keyboardTypes) {
    assert.equal(docListeners.has(type), false, 'document ' + type + ' listener must not exist')
    assert.equal(winListeners.has(type), false, 'window ' + type + ' listener must not exist')
    assert.equal(canvas.listeners.has(type), false, 'canvas ' + type + ' listener must not exist')
  }
  assert.equal(documentStub.title, 'untitled-dev-title', 'document.title must not change')
  /* documentStub 没有 body 字段，若 client 访问 body 会在测试里抛错 */
  assert.equal('body' in documentStub, false)
  assert.ok(seam.getLastGame(), 'dev probe lastGame should be set (test seam only)')
})

/* =========================================================================
 * 7) 结局复盘面板（fake-react 渲染真实组件）
 * ========================================================================= */

test('result panel: dismiss hides panel, canvas review board stays mounted + painted', () => {
  /* 构造一个合法的「踩雷失败」存档（含一面标对、一面标错的旗） */
  const engine = startedGame(701)
  const closedMines = []
  const closedSafes = []
  for (let i = 0; i < engine.n; i += 1) {
    if (engine.open[i] !== 0) continue
    if (engine.mine[i] !== 0) closedMines.push(i)
    else closedSafes.push(i)
  }
  assert.ok(closedMines.length >= 2 && closedSafes.length >= 1, 'need closed mines + safe cells')
  engine.setFlag(closedMines[0], engine.mine[closedMines[0]])
  engine.setFlag(closedSafes[0], engine.mine[closedMines[0]] === 1 ? 2 : 1)
  engine.recountFlags()
  engine.reveal(closedMines[1], 0)
  assert.equal(engine.over, true)
  assert.equal(engine.win, false)
  installSaveFromEngine(engine, 1, 4321)

  /* 用假宿主契约加载真实 client 组件并渲染 */
  const module = loadedDefinition.factory(function requireShim(name) {
    if (name === 'react') return FakeReact
    throw new Error('unexpected module: ' + name)
  })
  let registered = null
  module.apply({
    slots: {
      inject(name, callback) {
        assert.equal(name, 'game.stage')
        callback()
      },
      register(entry, Component) {
        registered = { entry, Component }
        return function unregister() {}
      },
    },
  })
  assert.ok(registered, 'slots.register should be called')

  const container = documentStub.createElement('section')
  FakeReact.render(
    FakeReact.createElement(registered.Component, {
      matched: registered.entry.select({ gameId: 'complexweeper' }),
    }),
    container,
  )
  const game = seam.getLastGame()
  assert.ok(game, 'component effect should create a game instance')
  currentGame = game
  assert.equal(game.getState().over, true, 'restored game should be over (loss)')

  const canvas = findElement(container, function (el) {
    return el.tagName === 'CANVAS'
  })
  assert.ok(canvas, 'canvas should be mounted inside the component tree')

  const closeButton = findElement(container, function (el) {
    return el.getAttribute && el.getAttribute('aria-label') === '关闭复盘面板'
  })
  assert.ok(closeButton, 'result panel should render a close button (aria-label=关闭复盘面板)')
  const textBefore = collectText(container)
  assert.ok(textBefore.indexOf('踩雷了') >= 0, 'result title should be 踩雷了')
  assert.ok(textBefore.indexOf('标对') >= 0 && textBefore.indexOf('标错') >= 0,
    'result panel should show correct/wrong flag counts')
  assert.ok(textBefore.indexOf('再来一局') >= 0, 'result panel should offer 再来一局')

  /* 关闭面板：面板消失，canvas 复盘棋盘仍在且已绘制 */
  clickElement(closeButton)
  const closeAfter = findElement(container, function (el) {
    return el.getAttribute && el.getAttribute('aria-label') === '关闭复盘面板'
  })
  assert.equal(closeAfter, null, 'result panel should disappear after clicking close')
  const restartButtonAfter = findElement(container, function (el) {
    return el.tagName === 'BUTTON' && collectText(el).trim() === '再来一局'
  })
  assert.equal(restartButtonAfter, null, 'restart button should be gone with the result panel')
  const canvasAfter = findElement(container, function (el) {
    return el.tagName === 'CANVAS'
  })
  assert.ok(canvasAfter === canvas, 'canvas review board must stay mounted after closing the panel')
  assert.equal(game.getState().over, true, 'closing the panel must not change game state')
  assert.ok(canvasAfter.calls.fillRect > 0, 'review board (with ok/wrong flag marks) stays painted')
  assert.ok(canvasAfter.calls.stroke > 0, 'review marks are stroke-drawn on the canvas')

  /* 卸载：destroy 会落盘 */
  FakeReact.unmountComponentAtNode(container)
  assert.equal(canvas.removed, true, 'canvas should be removed on unmount')
  assert.equal(pendingRaf(), 0, 'no rAF left after unmount')
  assert.equal(docListeners.size, 0, 'document listeners removed after unmount')
  assert.equal(winListeners.size, 0, 'window listeners removed after unmount')
  currentGame = null
})

/* =========================================================================
 * 汇总
 * ========================================================================= */

console.log('\n总结果：' + passed + ' 通过，' + failed + ' 失败')
if (failed) {
  console.log('结论：失败')
  process.exitCode = 1
} else {
  console.log('结论：全部通过 —— 真实 createGame 在假 DOM 下行为符合契约')
  process.exitCode = 0
}
