/**
 * Headless runtime self test for @local/dsh-game-2048.
 *
 * Run: node dev/test-headless.mjs
 *
 * Boots the real `createGame()` from client.js against a fake DOM/canvas, so the
 * lifecycle (mount, resize, dpr, keyboard, swipe, visibility pause, undo, save,
 * destroy) is exercised without the DSH host or a browser.
 */
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// Fake browser environment (installed before client.js is imported)
// ---------------------------------------------------------------------------

const storage = new Map()
const rafState = { queue: [], nextId: 1 }
const docListeners = new Map()
const winListeners = new Map()
let clockMs = 1000
let lastResizeObserver = null
let loadedDefinition = null

function makeContext() {
  const calls = { setTransform: [], clearRect: 0, fillRect: 0, fillText: [] }
  const ctx = {
    fillStyle: '#000',
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
    arcTo() {},
    closePath() {},
    fill() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    fillText(text) {
      calls.fillText.push(String(text))
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
    style: { cssText: '' },
    attrs: {},
    focused: false,
    removed: false,
    parent: null,
    listeners,
    calls,
    getContext(type) {
      assert.equal(type, '2d')
      return ctx
    },
    setAttribute(name, value) {
      this.attrs[name] = value
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
      this.focused = true
    },
    setPointerCapture() {},
    remove() {
      this.removed = true
      if (this.parent) this.parent.removeChild(this)
    },
  }
  return canvas
}

function makeHost(rect) {
  const listeners = new Map()
  const children = []
  const host = {
    rect,
    children,
    listeners,
    appended: null,
    getBoundingClientRect() {
      return this.rect
    },
    appendChild(node) {
      children.push(node)
      node.parent = this
      this.appended = node
    },
    removeChild(node) {
      const index = children.indexOf(node)
      if (index >= 0) children.splice(index, 1)
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
  }
  return host
}

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback
    this.observed = null
    this.disconnected = false
    lastResizeObserver = this
  }

  observe(target) {
    this.observed = target
  }

  disconnect() {
    this.disconnected = true
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
  __DSH_GAME_2048_TEST__: true,
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
  ResizeObserver: FakeResizeObserver,
}

globalThis.document = documentStub
globalThis.window = windowStub

await import(new URL('../client.js', import.meta.url).href)
const api = globalThis.window.__DSH_GAME_2048__
assert.ok(api, 'test seam should be installed')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function resetWorld() {
  storage.clear()
  rafState.queue = []
  docListeners.clear()
  winListeners.clear()
  documentStub.hidden = false
  windowStub.devicePixelRatio = 2
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
    // A failed assertion must not leak a mounted game into the next test.
    try {
      if (currentGame) {
        currentGame.destroy()
        currentGame = null
      }
    } catch (cleanupError) {
      console.error(cleanupError)
    }
  }
}

let currentGame = null

function makeSave(overrides) {
  return Object.assign(
    {
      schemaVersion: 1,
      board: api.createEmptyBoard(),
      score: 0,
      best: 0,
      won: false,
      winAcked: true,
      undo: null,
    },
    overrides,
  )
}

function installSave(overrides) {
  storage.set(api.STORE_KEY, JSON.stringify(makeSave(overrides)))
}

function readSave() {
  const raw = storage.get(api.STORE_KEY)
  assert.ok(raw, 'save entry should exist')
  return JSON.parse(raw)
}

function rows(rowsList) {
  assert.equal(rowsList.length, 4)
  return [].concat(rowsList[0], rowsList[1], rowsList[2], rowsList[3])
}

function boot(rect, options) {
  const host = makeHost(Object.assign({ width: 800, height: 600 }, rect))
  currentGame = api.createGame(host, options || {})
  return { host, game: currentGame, canvas: host.children[0] }
}

function flushFrames(count, step) {
  for (let frame = 0; frame < count; frame += 1) {
    clockMs += step
    const queue = rafState.queue
    rafState.queue = []
    for (const item of queue) item.callback()
  }
}

function countTiles(board) {
  return board.filter((value) => value !== 0).length
}

const EMPTY_ROW = [0, 0, 0, 0]

// ---------------------------------------------------------------------------
// Boot / canvas / dpr
// ---------------------------------------------------------------------------

test('boot mounts a hidpi canvas and persists a two-tile initial state', () => {
  const { host, game, canvas } = boot({}, { random: () => 0.5 })
  assert.equal(host.children.length, 1)
  assert.ok(canvas)
  assert.equal(canvas.width, 1600)
  assert.equal(canvas.height, 1200)
  assert.equal(canvas.tabIndex, 0)
  assert.equal(canvas.attrs.role, 'application')
  assert.equal(canvas.focused, true)
  assert.ok(canvas.calls.setTransform.some((args) => args[0] === 2 && args[3] === 2))
  assert.deepEqual(game.getState(), {
    score: 0,
    best: 0,
    over: false,
    won: false,
    winAcked: true,
    canUndo: false,
  })
  const saved = readSave()
  assert.equal(saved.schemaVersion, 1)
  assert.equal(countTiles(saved.board), 2)
  assert.equal(saved.board[7], 2)
  assert.equal(saved.board[8], 2)
})

test('boot reports the state through onState', () => {
  const snapshots = []
  boot({}, {
    random: () => 0.5,
    onState(snapshot) {
      snapshots.push(snapshot)
    },
  })
  assert.ok(snapshots.length >= 1)
  assert.equal(snapshots[snapshots.length - 1].score, 0)
})

test('dpr and size are recomputed on ResizeObserver callbacks', () => {
  const { host, canvas } = boot({ width: 400, height: 300 })
  assert.equal(canvas.width, 800)
  assert.equal(canvas.height, 600)
  host.rect = { width: 600, height: 400 }
  lastResizeObserver.callback()
  assert.equal(canvas.width, 1200)
  assert.equal(canvas.height, 800)
  windowStub.devicePixelRatio = 3
  lastResizeObserver.callback()
  assert.equal(canvas.width, 1800)
  assert.equal(canvas.height, 1200)
  const lastTransform = canvas.calls.setTransform[canvas.calls.setTransform.length - 1]
  assert.equal(lastTransform[0], 3)
  assert.equal(lastTransform[3], 3)
})

test('dpr changes without a host resize are re-applied on window resize', () => {
  const { canvas } = boot({ width: 400, height: 300 })
  assert.equal(canvas.width, 800)
  assert.equal(canvas.height, 600)
  windowStub.devicePixelRatio = 3
  winListeners.get('resize')()
  assert.equal(canvas.width, 1200)
  assert.equal(canvas.height, 900)
  assert.equal(canvas.calls.setTransform[canvas.calls.setTransform.length - 1][0], 3)
})

test('tiny stages draw a readable hint instead of a squashed board', () => {
  const { host, canvas } = boot({ width: 300, height: 260 })
  canvas.calls.fillText.length = 0
  host.rect = { width: 200, height: 150 }
  lastResizeObserver.callback()
  assert.equal(canvas.width, 400)
  assert.ok(canvas.calls.fillText.includes('窗口太小'))
  assert.ok(canvas.calls.fillText.includes('请放大游戏区域'))
})

test('a zero-sized host does not crash', () => {
  const { canvas } = boot({ width: 0, height: 0 })
  assert.ok(canvas)
  assert.equal(canvas.width, 1)
  assert.equal(canvas.height, 1)
})

// ---------------------------------------------------------------------------
// Keyboard moves, animation, undo
// ---------------------------------------------------------------------------

test('ArrowLeft merges, scores, animates and persists', () => {
  installSave({ board: rows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]) })
  const { host, game, canvas } = boot({}, { random: () => 0.5 })
  let prevented = false
  host.dispatch('keydown', {
    key: 'ArrowLeft',
    preventDefault() {
      prevented = true
    },
  })
  assert.equal(prevented, true)
  assert.equal(game.getState().score, 4)
  assert.equal(game.getState().canUndo, true)
  const saved = readSave()
  assert.equal(saved.score, 4)
  assert.equal(saved.board[0], 4)
  assert.ok(saved.undo, 'undo snapshot should be persisted')
  assert.equal(saved.undo.score, 0)
  assert.equal(rafState.queue.length, 1, 'a slide animation frame should be queued')
  flushFrames(3, 150)
  assert.ok(canvas.calls.fillText.includes('4'), 'merged tile should be drawn')
  assert.equal(rafState.queue.length, 0, 'animation should stop by itself')
})

test('undo restores board, score and the persisted snapshot', () => {
  installSave({ board: rows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]) })
  const { host, game } = boot({}, { random: () => 0.5 })
  host.dispatch('keydown', { key: 'ArrowLeft' })
  assert.equal(game.getState().score, 4)
  const undone = game.undo()
  assert.equal(undone, true)
  assert.deepEqual(game.getState(), {
    score: 0,
    best: 4,
    over: false,
    won: false,
    winAcked: true,
    canUndo: false,
  })
  const saved = readSave()
  assert.equal(saved.score, 0)
  assert.equal(saved.board[0], 2)
  assert.equal(saved.board[1], 2)
})

test('WASD and arrow aliases both move, modified keys are ignored', () => {
  installSave({ board: rows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]) })
  const { host, game } = boot({}, { random: () => 0.5 })
  host.dispatch('keydown', { key: 'a', ctrlKey: true })
  assert.equal(game.getState().score, 0, 'ctrl+a must not move the board')
  host.dispatch('keydown', { key: 'a' })
  assert.equal(game.getState().score, 4)
  host.dispatch('keydown', { key: 'U' })
  assert.equal(game.getState().score, 0)
})

test('a move that changes nothing does not spawn, animate or rescore', () => {
  installSave({
    board: rows([
      [2, 4, 8, 16],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]),
  })
  const { host, game } = boot({}, { random: () => 0.5 })
  const before = storage.get(api.STORE_KEY)
  host.dispatch('keydown', { key: 'ArrowLeft' })
  assert.equal(game.getState().score, 0)
  assert.equal(rafState.queue.length, 0)
  assert.equal(storage.get(api.STORE_KEY), before)
})

// ---------------------------------------------------------------------------
// Swipe input
// ---------------------------------------------------------------------------

test('pointer swipe moves the board', () => {
  installSave({ board: rows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]) })
  const { canvas, game } = boot({}, { random: () => 0.5 })
  canvas.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
  canvas.dispatch('pointerup', { clientX: 180, clientY: 103 })
  assert.equal(game.getState().score, 4)
  assert.equal(readSave().board[3], 4)
})

test('a short tap is not treated as a swipe', () => {
  installSave({ board: rows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]) })
  const { canvas, game } = boot({}, { random: () => 0.5 })
  canvas.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
  canvas.dispatch('pointerup', { clientX: 106, clientY: 104 })
  assert.equal(game.getState().score, 0)
})

test('keyTarget keeps arrow keys working when focus sits on a toolbar button', () => {
  installSave({ board: rows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]) })
  const host = makeHost({ width: 800, height: 600 })
  const root = makeHost({ width: 800, height: 600 })
  root.appendChild(host)
  currentGame = api.createGame(host, { keyTarget: root, random: () => 0.5 })
  // A click on 撤销/新游戏 leaves focus on the button; the keydown still
  // bubbles to the component root where the game listens.
  root.dispatch('keydown', { key: 'ArrowLeft' })
  assert.equal(currentGame.getState().score, 4)
  currentGame.destroy()
  currentGame = null
  assert.equal(root.listeners.has('keydown'), false)
  assert.equal(winListeners.has('resize'), false)
})

// ---------------------------------------------------------------------------
// Win / game over
// ---------------------------------------------------------------------------

test('reaching 2048 flags the win once and acknowledgeWin persists', () => {
  installSave({
    board: rows([[1024, 1024, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]),
    score: 100,
    best: 100,
  })
  const { host, game, canvas } = boot({}, { random: () => 0.5 })
  host.dispatch('keydown', { key: 'ArrowLeft' })
  assert.equal(game.getState().score, 2148)
  assert.equal(game.getState().won, true)
  assert.equal(game.getState().winAcked, false)
  flushFrames(3, 150)
  assert.ok(canvas.calls.fillText.includes('2048'))
  const acknowledged = game.acknowledgeWin()
  assert.equal(acknowledged, true)
  assert.equal(game.getState().winAcked, true)
  assert.equal(readSave().winAcked, true)
})

test('a dead board loads as game over and a new game recovers while keeping best', () => {
  const dead = rows([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ])
  installSave({ board: dead, score: 88, best: 88 })
  const { host, game } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().over, true)
  host.dispatch('keydown', { key: 'ArrowLeft' })
  assert.equal(game.getState().over, true)
  assert.equal(rafState.queue.length, 0)
  game.newGame()
  assert.equal(game.getState().over, false)
  assert.equal(game.getState().score, 0)
  assert.equal(game.getState().best, 88)
  assert.equal(countTiles(readSave().board), 2)
})

test('the win overlay flag survives a reload of its own save', () => {
  installSave({
    board: rows([[2048, 0, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]),
    score: 5000,
    best: 5000,
    won: true,
    winAcked: false,
  })
  const { game } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().won, true)
  assert.equal(game.getState().winAcked, false)
})

// ---------------------------------------------------------------------------
// Visibility / lifecycle
// ---------------------------------------------------------------------------

test('hiding the document cancels the animation frame; showing redraws', () => {
  installSave({ board: rows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]) })
  const { host, game, canvas } = boot({}, { random: () => 0.5 })
  host.dispatch('keydown', { key: 'ArrowLeft' })
  assert.equal(rafState.queue.length, 1)
  const before = game.getState().score
  documentStub.hidden = true
  docListeners.get('visibilitychange')()
  assert.equal(rafState.queue.length, 0)
  assert.equal(game.getState().score, before, 'state must not change while hidden')
  canvas.calls.fillText.length = 0
  documentStub.hidden = false
  docListeners.get('visibilitychange')()
  assert.ok(canvas.calls.fillText.includes('4'), 'final board should be redrawn on return')
})

test('destroy cancels frames, removes listeners/canvas and saves the final state', () => {
  installSave({ board: rows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]) })
  const { host, game, canvas } = boot({}, { random: () => 0.5 })
  host.dispatch('keydown', { key: 'ArrowLeft' })
  const savedBeforeDestroy = readSave()
  game.destroy()
  currentGame = null
  assert.equal(canvas.removed, true)
  assert.equal(host.children.length, 0)
  assert.equal(host.listeners.size, 0)
  assert.equal(winListeners.size, 0)
  assert.equal(docListeners.size, 0)
  assert.equal(rafState.queue.length, 0)
  assert.ok(lastResizeObserver.disconnected)
  assert.deepEqual(readSave(), savedBeforeDestroy)
  game.destroy() // idempotent
})

test('mount/destroy cycles leave no document listeners behind', () => {
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const { game } = boot({}, { random: () => 0.5 })
    assert.equal(docListeners.size, 1)
    game.destroy()
    currentGame = null
    assert.equal(docListeners.size, 0)
  }
})

test('CSS/JS boot does not require a canary flag to expose a loader entry', () => {
  assert.equal(loadedDefinition.id, '@local/dsh-game-2048')
  assert.equal(typeof loadedDefinition.factory, 'function')
})

// ---------------------------------------------------------------------------
// Corrupt storage / startup failures
// ---------------------------------------------------------------------------

test('corrupt JSON storage falls back to a new game', () => {
  storage.set(api.STORE_KEY, '{ not json')
  const { game } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().score, 0)
  assert.equal(countTiles(readSave().board), 2)
})

test('unknown schema version storage falls back to a new game', () => {
  storage.set(
    api.STORE_KEY,
    JSON.stringify(makeSave({ schemaVersion: 2, score: 12345, board: rows([[2, 0, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]) })),
  )
  const { game } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().score, 0)
  assert.equal(countTiles(readSave().board), 2)
})

test('a canvas without a 2d context fails fast and cleans up', () => {
  const badCanvas = makeCanvas()
  badCanvas.getContext = () => null
  const originalCreateElement = documentStub.createElement
  documentStub.createElement = () => badCanvas
  try {
    assert.throws(() => {
      api.createGame(makeHost({ width: 800, height: 600 }), { random: () => 0.5 })
    }, /2d canvas context unavailable/)
  } finally {
    documentStub.createElement = originalCreateElement
  }
  assert.equal(badCanvas.removed, true)
  assert.equal(docListeners.size, 0)
})

test('a full board save with a valid undo snapshot restores undo', () => {
  installSave({
    board: rows([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]),
    score: 50,
    undo: {
      board: rows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]),
      score: 46,
      won: false,
      winAcked: true,
    },
  })
  const { game } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().over, true)
  assert.equal(game.getState().canUndo, true)
  assert.equal(game.undo(), true)
  assert.equal(game.getState().score, 46)
  assert.equal(game.getState().over, false)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log('headless tests: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
