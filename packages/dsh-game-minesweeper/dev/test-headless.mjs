/**
 * Headless runtime self test for @local/dsh-game-minesweeper.
 *
 * Run: node dev/test-headless.mjs
 *
 * Boots the real `createGame()` from client.js against a fake DOM/canvas, so the
 * lifecycle (mount, resize, dpr, pointer reveal/flag/chord, timer, visibility
 * pause, persistence, destroy) is exercised without the DSH host or a browser.
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
  const calls = { setTransform: [], clearRect: 0, fillRect: 0, fillText: [], stroke: 0, fill: 0 }
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
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
    arc() {},
    closePath() {},
    fill() {
      calls.fill += 1
    },
    stroke() {
      calls.stroke += 1
    },
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
    remove() {
      this.removed = true
      if (this.parent) this.parent.removeChild(this)
    },
  }
  return canvas
}

function makeHost(rect) {
  const children = []
  const host = {
    rect,
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
  __DSH_GAME_MINESWEEPER_TEST__: true,
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
const api = globalThis.window.__DSH_GAME_MINESWEEPER__
assert.ok(api, 'test seam should be installed')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
let currentGame = null

function resetWorld() {
  storage.clear()
  rafState.queue = []
  docListeners.clear()
  winListeners.clear()
  documentStub.hidden = false
  windowStub.devicePixelRatio = 2
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
  }
}

const BEGINNER_MINES = [0, 8, 72, 80, 13, 22, 31, 40, 58, 67]

/** Real preset state with a valid mine count, ready to be persisted. */
function levelState(difficulty, mineIndices) {
  const state = api.freshState(difficulty)
  for (const index of mineIndices) state.mine[index] = 1
  state.adjacent = api.computeAdjacent(state.rows, state.cols, state.mine)
  state.started = true
  state.status = 'playing'
  return state
}

function installSave(state) {
  storage.set(api.STORE_KEY, JSON.stringify(api.serializeState(state)))
}

function readSave() {
  const raw = storage.get(api.STORE_KEY)
  assert.ok(raw, 'save entry should exist')
  return JSON.parse(raw)
}

function boot(rect, options) {
  const host = makeHost(Object.assign({ width: 800, height: 600 }, rect))
  currentGame = api.createGame(host, options || {})
  return { host, game: currentGame, canvas: host.children[0] }
}

function cellCenter(game, index) {
  const layout = game.getLayout()
  assert.ok(layout, 'layout should exist for a normal-sized stage')
  const row = Math.floor(index / layout.cols)
  const col = index % layout.cols
  return {
    clientX: layout.x + col * layout.cell + layout.cell / 2,
    clientY: layout.y + row * layout.cell + layout.cell / 2,
  }
}

function click(game, canvas, index, button) {
  const point = cellCenter(game, index)
  canvas.dispatch('pointerdown', { button: button || 0, clientX: point.clientX, clientY: point.clientY })
}

function flushFrames(count, step) {
  for (let frame = 0; frame < count; frame += 1) {
    clockMs += step
    const queue = rafState.queue
    rafState.queue = []
    for (const item of queue) item.callback()
  }
}

/** All safe cells except `last` already revealed, for one-click wins. */
function almostWonState() {
  const state = levelState('beginner', BEGINNER_MINES)
  const last = 2
  for (let index = 0; index < state.rows * state.cols; index += 1) {
    if (!state.mine[index] && index !== last) state.revealed[index] = 1
  }
  return { state, last }
}

// ---------------------------------------------------------------------------
// Boot / canvas / dpr
// ---------------------------------------------------------------------------

test('boot mounts a hidpi canvas and persists a fresh ready save', () => {
  const { host, game, canvas } = boot({})
  assert.equal(host.children.length, 1)
  assert.ok(canvas)
  assert.equal(canvas.width, 1600)
  assert.equal(canvas.height, 1200)
  assert.equal(canvas.tabIndex, 0)
  assert.equal(canvas.attrs.role, 'application')
  const saved = readSave()
  assert.equal(saved.schemaVersion, 1)
  assert.equal(saved.difficulty, 'beginner')
  assert.equal(saved.status, 'ready')
  assert.equal(saved.started, false)
  assert.equal(saved.mine.filter((value) => value === 1).length, 0)
  assert.deepEqual(game.getState(), {
    difficulty: 'beginner',
    status: 'ready',
    rows: 9,
    cols: 9,
    mines: 10,
    flags: 0,
    remaining: 10,
    elapsed: 0,
    best: null,
  })
  assert.equal(rafState.queue.length, 0, 'a ready board has no animation/timer frame')
})

test('boot reports the state through onState', () => {
  const snapshots = []
  boot({}, {
    onState(snapshot) {
      snapshots.push(snapshot)
    },
  })
  assert.ok(snapshots.length >= 1)
  assert.equal(snapshots[snapshots.length - 1].status, 'ready')
  assert.equal(snapshots[snapshots.length - 1].remaining, 10)
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
// Pointer input
// ---------------------------------------------------------------------------

test('left click starts the game, places mines and persists', () => {
  const { game, canvas } = boot({})
  click(game, canvas, 40)
  const state = game.getState()
  assert.equal(state.status, 'playing')
  assert.equal(state.elapsed, 0)
  const saved = readSave()
  assert.equal(saved.started, true)
  assert.equal(saved.status, 'playing')
  assert.equal(saved.mine.filter((value) => value === 1).length, 10)
  assert.equal(saved.mine[40], 0, 'the first click is safe')
  assert.equal(saved.revealed[40], 1)
  assert.ok(rafState.queue.length >= 1, 'the play timer should be running')
})

test('right click toggles a flag, updates the counter and prevents the context menu', () => {
  const { game, canvas } = boot({})
  click(game, canvas, 0, 2)
  assert.equal(game.getState().remaining, 9)
  assert.equal(game.getState().flags, 1)
  assert.equal(readSave().flagged[0], 1)
  let prevented = false
  canvas.dispatch('contextmenu', {
    preventDefault() {
      prevented = true
    },
  })
  assert.equal(prevented, true)
  click(game, canvas, 0, 2)
  assert.equal(game.getState().remaining, 10)
  assert.equal(readSave().flagged[0], 0)
})

test('a left click on a flagged cell does not reveal it', () => {
  const { game, canvas } = boot({})
  click(game, canvas, 0, 2)
  click(game, canvas, 0, 0)
  assert.equal(readSave().revealed[0], 0)
  assert.equal(game.getState().remaining, 9)
})

test('double-click chords a revealed number once flags match', () => {
  const state = levelState('beginner', BEGINNER_MINES)
  state.revealed[1] = 1
  state.flagged[0] = 1
  installSave(state)
  const { game, canvas } = boot({})
  const point = cellCenter(game, 1)
  let opened = false
  try {
    canvas.dispatch('dblclick', point)
    opened = true
  } catch (error) {
    opened = false
  }
  assert.equal(opened, true)
  const saved = readSave()
  assert.equal(saved.status, 'playing')
  assert.equal(saved.revealed[1], 1)
  assert.equal(saved.revealed[2], 1, 'unflagged neighbour should open')
  assert.equal(saved.flagged[0], 1)
})

test('middle click chords as well', () => {
  const state = levelState('beginner', BEGINNER_MINES)
  state.revealed[1] = 1
  state.flagged[0] = 1
  installSave(state)
  const { game, canvas } = boot({})
  click(game, canvas, 1, 1)
  const saved = readSave()
  assert.equal(saved.revealed[2], 1)
})

test('a chord with a wrong flag can lose the game', () => {
  const state = levelState('beginner', BEGINNER_MINES)
  state.revealed[1] = 1
  state.flagged[2] = 1 // safe cell flagged by mistake
  installSave(state)
  const { game, canvas } = boot({})
  const point = cellCenter(game, 1)
  canvas.dispatch('dblclick', point)
  const saved = readSave()
  assert.equal(saved.status, 'lost')
  assert.equal(saved.exploded, 0)
  assert.equal(game.getState().status, 'lost')
})

test('pointer input outside the board is ignored', () => {
  const { game, canvas } = boot({})
  const layout = game.getLayout()
  const marginX = Math.max(1, Math.floor(layout.x / 2))
  canvas.dispatch('pointerdown', { button: 0, clientX: marginX, clientY: layout.y + 2 })
  assert.equal(game.getState().status, 'ready')
  assert.equal(readSave().started, false)
})

test('hovering hidden cells redraws without crashing and clears on leave', () => {
  const { game, canvas } = boot({})
  const point = cellCenter(game, 0)
  const before = canvas.calls.fillRect
  canvas.dispatch('pointermove', point)
  assert.ok(canvas.calls.fillRect > before, 'hover should repaint')
  canvas.dispatch('pointerleave', {})
  assert.ok(canvas.calls.fillRect > before)
  assert.equal(game.getState().status, 'ready')
})

// ---------------------------------------------------------------------------
// Timer / visibility
// ---------------------------------------------------------------------------

test('the timer advances while playing and persists on destroy', () => {
  const { game, canvas } = boot({})
  const snapshots = []
  game.destroy()
  currentGame = null
  const again = boot({}, {
    onState(snapshot) {
      snapshots.push(snapshot)
    },
  })
  click(again.game, again.canvas, 40)
  flushFrames(2, 1000)
  const state = again.game.getState()
  assert.ok(state.elapsed >= 1, 'timer should have advanced, got ' + state.elapsed)
  assert.ok(snapshots.length > 0)
  assert.ok(snapshots[snapshots.length - 1].elapsed >= 1)
  canvas // keep the unused binding explicit for readers
})

test('hiding the document pauses the timer and showing resumes without a jump', () => {
  const { game, canvas } = boot({})
  click(game, canvas, 40)
  flushFrames(2, 1000)
  const beforeHide = game.getState().elapsed
  assert.ok(beforeHide >= 1)
  documentStub.hidden = true
  docListeners.get('visibilitychange')()
  assert.equal(rafState.queue.length, 0, 'hidden game must not keep a frame')
  const savedHidden = readSave()
  assert.ok(savedHidden.elapsedMs >= 1000, 'hidden commit should persist elapsed time')
  clockMs += 5000
  documentStub.hidden = false
  docListeners.get('visibilitychange')()
  assert.equal(game.getState().elapsed, Math.floor(savedHidden.elapsedMs / 1000), 'no jump over hidden time')
  flushFrames(2, 1000)
  assert.equal(game.getState().elapsed, Math.floor(savedHidden.elapsedMs / 1000) + 2)
})

test('mounting while the document is hidden does not run the timer', () => {
  const state = levelState('beginner', BEGINNER_MINES)
  state.elapsedMs = 7000
  installSave(state)
  documentStub.hidden = true
  const { game } = boot({})
  assert.equal(rafState.queue.length, 0, 'no frame while hidden')
  assert.equal(game.getState().elapsed, 7)
  clockMs += 5000
  assert.equal(game.getState().elapsed, 7, 'hidden time must not be counted')
  documentStub.hidden = false
  docListeners.get('visibilitychange')()
  assert.equal(rafState.queue.length, 1, 'the timer starts when the page becomes visible')
  flushFrames(1, 1000)
  assert.equal(game.getState().elapsed, 8)
})

test('destroy commits the timer and saves the final state', () => {
  const { game, canvas } = boot({})
  click(game, canvas, 40)
  flushFrames(3, 1000)
  game.destroy()
  currentGame = null
  assert.ok(readSave().elapsedMs >= 3000)
})

// ---------------------------------------------------------------------------
// Loss / win / reset
// ---------------------------------------------------------------------------

test('revealing a mine loses, stops the timer and persists the exploded cell', () => {
  installSave(levelState('beginner', BEGINNER_MINES))
  const { game, canvas } = boot({})
  clockMs += 3000
  click(game, canvas, 0)
  assert.equal(game.getState().status, 'lost')
  const saved = readSave()
  assert.equal(saved.status, 'lost')
  assert.equal(saved.exploded, 0)
  assert.equal(saved.revealed[0], 0, 'the exploded mine is not marked revealed')
  assert.ok(saved.elapsedMs >= 3000)
  flushFrames(3, 1000)
  assert.equal(rafState.queue.length, 0, 'a lost game keeps no frame')
  assert.equal(readSave().elapsedMs, saved.elapsedMs, 'timer stopped')
})

test('a lost save reloads as lost and reveals the mines again', () => {
  const state = levelState('beginner', BEGINNER_MINES)
  state.status = 'lost'
  state.exploded = 0
  state.elapsedMs = 12000
  installSave(state)
  const { game, canvas } = boot({})
  assert.equal(game.getState().status, 'lost')
  assert.equal(game.getState().elapsed, 12)
  assert.ok(canvas.calls.fill > 0, 'mines are drawn')
  assert.equal(rafState.queue.length, 0)
})

test('revealing the last safe cell wins, updates the best time and stops the timer', () => {
  const { state, last } = almostWonState()
  state.elapsedMs = 4000
  installSave(state)
  const { game, canvas } = boot({})
  clockMs += 2000
  click(game, canvas, last)
  assert.equal(game.getState().status, 'won')
  const saved = readSave()
  assert.equal(saved.status, 'won')
  assert.equal(saved.flagged.filter((value) => value === 1).length, 10, 'mines auto-flag on win')
  assert.equal(saved.best.beginner, 6000)
  assert.equal(game.getState().best, 6000)
  assert.equal(game.getState().elapsed, 6)
  flushFrames(2, 1000)
  assert.equal(rafState.queue.length, 0, 'a won game keeps no frame')
})

test('a won save keeps its best time and does not restart the timer', () => {
  const { state } = almostWonState()
  const won = levelState('beginner', BEGINNER_MINES)
  for (let index = 0; index < won.rows * won.cols; index += 1) {
    if (!won.mine[index]) won.revealed[index] = 1
  }
  won.status = 'won'
  won.elapsedMs = 6000
  won.best.beginner = 6000
  for (const index of BEGINNER_MINES) won.flagged[index] = 1
  installSave(won)
  const { game } = boot({})
  assert.equal(game.getState().status, 'won')
  assert.equal(game.getState().best, 6000)
  assert.equal(rafState.queue.length, 0)
  assert.equal(state.status, 'playing')
})

test('newGame resets the board but keeps the best time', () => {
  const { state } = almostWonState()
  state.elapsedMs = 4000
  state.best.beginner = 5000
  installSave(state)
  const { game } = boot({})
  game.newGame()
  assert.equal(game.getState().status, 'ready')
  assert.equal(game.getState().elapsed, 0)
  assert.equal(game.getState().best, 5000, 'best time survives a restart')
  const saved = readSave()
  assert.equal(saved.status, 'ready')
  assert.equal(saved.elapsedMs, 0)
  assert.equal(saved.started, false)
  assert.equal(saved.best.beginner, 5000)
})

test('setDifficulty switches the preset and persists it', () => {
  const { game } = boot({})
  assert.equal(game.setDifficulty('expert'), true)
  const state = game.getState()
  assert.equal(state.difficulty, 'expert')
  assert.equal(state.rows, 16)
  assert.equal(state.cols, 30)
  assert.equal(state.mines, 99)
  assert.equal(state.remaining, 99)
  const saved = readSave()
  assert.equal(saved.difficulty, 'expert')
  assert.equal(saved.rows, 16)
  assert.equal(saved.cols, 30)
  assert.equal(saved.mines, 99)
  assert.equal(game.setDifficulty('space'), false)
})

test('a playing save restores the board, elapsed time and resumes the timer', () => {
  const state = levelState('beginner', BEGINNER_MINES)
  state.revealed[1] = 1
  state.flagged[2] = 1
  state.elapsedMs = 7000
  installSave(state)
  const { game, canvas } = boot({})
  assert.equal(game.getState().status, 'playing')
  assert.equal(game.getState().elapsed, 7)
  assert.equal(game.getState().remaining, 9)
  assert.ok(canvas.calls.fillText.includes('1'), 'saved numbers are redrawn')
  assert.ok(rafState.queue.length >= 1, 'timer resumes')
  flushFrames(1, 1000)
  assert.equal(game.getState().elapsed, 8)
})

// ---------------------------------------------------------------------------
// Corrupt storage / lifecycle cleanup
// ---------------------------------------------------------------------------

test('corrupt JSON storage falls back to a fresh game', () => {
  storage.set(api.STORE_KEY, '{ not json')
  const { game } = boot({})
  assert.equal(game.getState().status, 'ready')
  assert.equal(readSave().status, 'ready')
})

test('unknown schema version storage falls back to a fresh game', () => {
  const state = levelState('beginner', BEGINNER_MINES)
  const raw = api.serializeState(state)
  raw.schemaVersion = 2
  storage.set(api.STORE_KEY, JSON.stringify(raw))
  const { game } = boot({})
  assert.equal(game.getState().status, 'ready')
  assert.equal(readSave().status, 'ready')
})

test('another game\'s save key is never touched', () => {
  storage.set('dsh.game.2048.v1', '{"schemaVersion":1,"legacy":true}')
  const { game, canvas } = boot({})
  click(game, canvas, 40)
  game.newGame()
  game.destroy()
  currentGame = null
  assert.equal(storage.get('dsh.game.2048.v1'), '{"schemaVersion":1,"legacy":true}')
  assert.ok(storage.has('dsh.game.minesweeper.v1'))
})

test('destroy removes the canvas, listeners and observer; it is idempotent', () => {
  installSave(levelState('beginner', BEGINNER_MINES))
  const { host, game, canvas } = boot({})
  click(game, canvas, 1)
  const savedBeforeDestroy = readSave()
  game.destroy()
  currentGame = null
  assert.equal(canvas.removed, true)
  assert.equal(host.children.length, 0)
  assert.equal(canvas.listeners.size, 0)
  assert.equal(winListeners.size, 0)
  assert.equal(docListeners.size, 0)
  assert.equal(rafState.queue.length, 0)
  assert.ok(lastResizeObserver.disconnected)
  assert.deepEqual(readSave(), savedBeforeDestroy)
  game.destroy() // idempotent
})

test('mount/destroy cycles leave no document or window listeners behind', () => {
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const { game } = boot({})
    assert.deepEqual([...docListeners.keys()], ['visibilitychange'])
    assert.deepEqual([...winListeners.keys()], ['resize'])
    game.destroy()
    currentGame = null
    assert.equal(docListeners.size, 0)
    assert.equal(winListeners.size, 0)
  }
})

test('no keyboard listeners are registered anywhere', () => {
  const { game } = boot({})
  for (const key of winListeners.keys()) assert.notEqual(key, 'keydown')
  for (const key of docListeners.keys()) assert.notEqual(key, 'keydown')
  assert.equal(windowStub.document, undefined)
  assert.equal(documentStub.body, undefined)
  game.destroy()
  currentGame = null
})

test('a canvas without a 2d context fails fast and cleans up', () => {
  const badCanvas = makeCanvas()
  badCanvas.getContext = () => null
  const originalCreateElement = documentStub.createElement
  documentStub.createElement = () => badCanvas
  try {
    assert.throws(() => {
      api.createGame(makeHost({ width: 800, height: 600 }))
    }, /2d canvas context unavailable/)
  } finally {
    documentStub.createElement = originalCreateElement
  }
  assert.equal(badCanvas.removed, false, 'nothing was appended')
  assert.equal(docListeners.size, 0)
  assert.equal(winListeners.size, 0)
})

test('the loader entry is stable and uses the package name', () => {
  assert.equal(loadedDefinition.id, '@local/dsh-game-minesweeper')
  assert.equal(typeof loadedDefinition.factory, 'function')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log('headless tests: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
