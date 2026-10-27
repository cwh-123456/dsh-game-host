/**
 * Headless runtime self test for @local/dsh-game-tetris.
 *
 * Run: node dev/test-headless.mjs
 *
 * Boots the real `createGame()` from client.js against a fake DOM/canvas, so the
 * lifecycle (mount, resize, dpr, timestamp gravity, keyboard, hold, lock delay,
 * visibility/blur pause, persistence, destroy) is exercised without the DSH host
 * or a browser.
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
let styleCalls = 0

const TOKENS = {
  '--dsw-alias-bg-base': '#10141c',
  '--dsw-alias-bg-layer-2': '#1b2028',
  '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.16)',
  '--dsw-alias-label-primary': '#eef2f8',
  '--dsw-alias-label-secondary': '#b6c0cf',
  '--dsw-alias-label-tertiary': '#8b95a5',
  '--dsw-alias-brand-primary': '#5b9dff',
}

function makeContext() {
  const calls = { setTransform: [], clearRect: 0, fillRect: 0, fillText: [], clip: 0 }
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
    arcTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    clip() {
      calls.clip += 1
    },
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
      this.dispatch('focus', {})
    },
    blur() {
      this.focused = false
      this.dispatch('blur', {})
    },
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
  __DSH_GAME_TETRIS_TEST__: true,
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
  getComputedStyle() {
    styleCalls += 1
    return {
      getPropertyValue(name) {
        return TOKENS[name] || ''
      },
    }
  },
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
const api = globalThis.window.__DSH_GAME_TETRIS__
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
  lastResizeObserver = null
  clockMs = 1000
  styleCalls = 0
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

function makeSave(overrides) {
  return Object.assign(
    {
      schemaVersion: 1,
      board: api.createEmptyBoard(),
      current: { type: 'T', rot: 0, x: 3, y: 1 },
      queue: ['I', 'O', 'T', 'S', 'Z'],
      bag: [],
      hold: null,
      canHold: true,
      score: 0,
      lines: 0,
      level: 1,
      playMs: 0,
      over: false,
      paused: false,
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

function countBlocks(board) {
  let count = 0
  for (const row of board) for (const value of row) if (value !== 0) count += 1
  return count
}

function boot(rect, options) {
  const host = makeHost(Object.assign({ width: 800, height: 600 }, rect))
  currentGame = api.createGame(host, options || {})
  return { host, game: currentGame, canvas: host.children[0] }
}

function flushFrames(count, step) {
  for (let frame = 0; frame < count; frame += 1) {
    clockMs += step
    const batch = rafState.queue
    rafState.queue = []
    for (const item of batch) item.callback(clockMs)
  }
}

function press(canvas, key, extra) {
  const event = Object.assign(
    {
      key,
      code: '',
      repeat: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true
      },
    },
    extra || {},
  )
  canvas.dispatch('keydown', event)
  return event
}

function pressSpace(canvas, extra) {
  return press(canvas, ' ', Object.assign({ code: 'Space' }, extra || {}))
}

function hideDocument() {
  documentStub.hidden = true
  const listener = docListeners.get('visibilitychange')
  assert.ok(listener, 'visibilitychange listener should be registered')
  listener()
}

function showDocument() {
  documentStub.hidden = false
  const listener = docListeners.get('visibilitychange')
  assert.ok(listener, 'visibilitychange listener should be registered')
  listener()
}

// ---------------------------------------------------------------------------
// Boot / canvas / dpr
// ---------------------------------------------------------------------------

test('boot mounts a HiDPI canvas, starts a game and persists a save', () => {
  const { host, game, canvas } = boot({}, { random: () => 0.5 })
  assert.equal(host.children.length, 1)
  assert.ok(canvas)
  assert.equal(canvas.width, 1600)
  assert.equal(canvas.height, 1200)
  assert.equal(canvas.tabIndex, 0)
  assert.equal(canvas.attrs.role, 'application')
  assert.equal(canvas.focused, true)
  assert.ok(canvas.calls.setTransform.some((args) => args[0] === 2 && args[3] === 2))
  assert.ok(canvas.calls.clearRect > 0)
  assert.ok(canvas.calls.fillText.includes('HOLD'))
  assert.ok(canvas.calls.fillText.includes('NEXT'))

  const state = game.getState()
  assert.equal(state.score, 0)
  assert.equal(state.lines, 0)
  assert.equal(state.level, 1)
  assert.equal(state.over, false)
  assert.equal(state.paused, false)
  assert.equal(state.focused, true)
  assert.ok(state.current)
  assert.equal(state.next.length, 5)
  assert.ok(styleCalls > 0, 'theme tokens should be sampled')

  const saved = readSave()
  assert.equal(saved.schemaVersion, 1)
  assert.equal(saved.board.length, api.ROWS)
  assert.equal(typeof saved.current, 'object')
  assert.equal(saved.over, false)
})

test('onState is called on boot and on gameplay events', () => {
  const snapshots = []
  const { canvas } = boot({}, {
    random: () => 0.5,
    onState(snapshot) {
      snapshots.push(snapshot)
    },
  })
  assert.ok(snapshots.length >= 1)
  assert.equal(snapshots[snapshots.length - 1].score, 0)
  press(canvas, 'ArrowLeft')
  assert.ok(snapshots.length >= 2)
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
// Timestamp-driven gravity
// ---------------------------------------------------------------------------

test('gravity accumulates timestamps: 780ms no drop, 800ms one row', () => {
  installSave()
  const { game } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().piece.y, 1)
  flushFrames(39, 20) // 780 ms
  assert.equal(game.getState().piece.y, 1)
  assert.equal(game.getState().elapsedMs, 780)
  flushFrames(1, 20) // 800 ms
  assert.equal(game.getState().piece.y, 2)
  assert.equal(game.getState().elapsedMs, 800)
})

test('gravity is not frame-counted: zero-dt frames never drop the piece', () => {
  installSave()
  const { game } = boot({}, { random: () => 0.5 })
  flushFrames(300, 0)
  assert.equal(game.getState().piece.y, 1)
  assert.equal(game.getState().elapsedMs, 0)
  flushFrames(4, 200)
  assert.equal(game.getState().piece.y, 2)
})

test('level 2 drops after 740ms', () => {
  installSave({ lines: 10 })
  const { game } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().level, 2)
  flushFrames(36, 20) // 720 ms
  assert.equal(game.getState().piece.y, 1)
  flushFrames(1, 20) // 740 ms
  assert.equal(game.getState().piece.y, 2)
})

test('a long stall is clamped to 250ms so the piece cannot teleport', () => {
  installSave()
  const { game } = boot({}, { random: () => 0.5 })
  flushFrames(1, 10000)
  // 250ms < 800ms: no gravity step yet.
  assert.equal(game.getState().piece.y, 1)
  assert.ok(game.getState().elapsedMs <= 250)
})

// ---------------------------------------------------------------------------
// Keyboard: movement / rotation / drop / hold / pause
// ---------------------------------------------------------------------------

test('ArrowLeft/Right move the piece and preventDefault', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  let event = press(canvas, 'ArrowLeft')
  assert.equal(event.defaultPrevented, true)
  assert.equal(game.getState().piece.x, 2)
  event = press(canvas, 'ArrowRight')
  assert.equal(event.defaultPrevented, true)
  assert.equal(game.getState().piece.x, 3)

  for (let step = 0; step < 20; step += 1) press(canvas, 'ArrowLeft')
  assert.equal(game.getState().piece.x, 0)
  for (let step = 0; step < 20; step += 1) press(canvas, 'ArrowRight')
  assert.equal(game.getState().piece.x, 7)
})

test('Ctrl/Meta/Alt chords are ignored', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  press(canvas, 'ArrowLeft', { ctrlKey: true })
  assert.equal(game.getState().piece.x, 3)
  press(canvas, 'ArrowLeft', { metaKey: true })
  assert.equal(game.getState().piece.x, 3)
})

test('ArrowDown soft-drops one row and scores +1', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  const event = press(canvas, 'ArrowDown')
  assert.equal(event.defaultPrevented, true)
  assert.equal(game.getState().piece.y, 2)
  assert.equal(game.getState().score, 1)
})

test('ArrowUp/X rotate clockwise, Z counter-clockwise', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().piece.rot, 0)
  let event = press(canvas, 'ArrowUp')
  assert.equal(event.defaultPrevented, true)
  assert.equal(game.getState().piece.rot, 1)
  press(canvas, 'z')
  assert.equal(game.getState().piece.rot, 0)
  press(canvas, 'X')
  assert.equal(game.getState().piece.rot, 1)
  press(canvas, 'ArrowUp')
  press(canvas, 'ArrowUp')
  press(canvas, 'ArrowUp')
  assert.equal(game.getState().piece.rot, 0)
})

test('keyboard repeat does not spin, hold or hard-drop repeatedly', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  const before = game.getState().piece
  press(canvas, 'ArrowUp', { repeat: true })
  assert.equal(game.getState().piece.rot, before.rot)
  press(canvas, 'c', { repeat: true })
  assert.equal(game.getState().hold, null)
  pressSpace(canvas, { repeat: true })
  assert.equal(game.getState().score, 0)
  assert.deepEqual(game.getState().piece, before)
})

test('wall kick works through the real keyboard handler', () => {
  const board = api.createEmptyBoard()
  board[1][8] = 4
  installSave({ current: { type: 'I', rot: 0, x: 6, y: 1 }, board })
  const { game, canvas } = boot({}, { random: () => 0.5 })
  press(canvas, 'ArrowUp')
  assert.equal(game.getState().piece.rot, 1)
  assert.equal(game.getState().piece.x, 5)
})

test('Space hard-drops, scores +2 per row, locks and spawns the next piece', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  const before = game.getState()
  const queued = before.next[0]
  const event = pressSpace(canvas)
  assert.equal(event.defaultPrevented, true)
  const state = game.getState()
  // T spawns with its lowest cell at row 2 and can fall to row 21 → 19 rows.
  assert.equal(state.score, 38)
  assert.equal(state.current, queued)
  assert.notEqual(state.piece.type, 'T')
  const saved = readSave()
  assert.equal(countBlocks(saved.board), 4)
  assert.equal(saved.score, 38)
})

test('hold stores once per piece and swaps after a lock', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  const firstType = game.getState().current
  const queued = game.getState().next[0]
  press(canvas, 'c')
  assert.equal(game.getState().hold, firstType)
  assert.equal(game.getState().current, queued)
  assert.equal(game.getState().canHold, false)

  const heldCurrent = game.getState().current
  press(canvas, 'c')
  assert.equal(game.getState().current, heldCurrent)

  pressSpace(canvas)
  assert.equal(game.getState().canHold, true)
  const beforeSwap = game.getState().current
  press(canvas, 'Shift')
  assert.equal(game.getState().hold, beforeSwap)
  assert.equal(game.getState().current, firstType)
})

test('P pauses and resumes; frames stop and elapsed time freezes', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  flushFrames(10, 20) // 200 ms
  assert.equal(game.getState().elapsedMs, 200)
  const yBefore = game.getState().piece.y
  press(canvas, 'p')
  assert.equal(game.getState().paused, true)
  assert.equal(rafState.queue.length, 0, 'pausing must stop the rAF loop')
  flushFrames(20, 250) // 5 s of wall time, but no frames run
  assert.equal(game.getState().elapsedMs, 200)
  assert.equal(game.getState().piece.y, yBefore)

  press(canvas, 'p')
  assert.equal(game.getState().paused, false)
  assert.equal(rafState.queue.length, 1)
  // Resume must not jump: the first resumed frame only advances 20 ms.
  flushFrames(5, 20)
  assert.equal(game.getState().elapsedMs, 300)
  assert.equal(game.getState().piece.y, yBefore)
})

test('P is ignored after game over', () => {
  installSave({ over: true, current: null })
  const { game, canvas } = boot({}, { random: () => 0.5 })
  press(canvas, 'p')
  assert.equal(game.getState().paused, false)
  assert.equal(game.getState().over, true)
})

test('R restarts the game and clears the pause', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  pressSpace(canvas)
  assert.ok(game.getState().score > 0)
  press(canvas, 'p')
  assert.equal(game.getState().paused, true)
  press(canvas, 'r')
  assert.equal(game.getState().paused, false)
  assert.equal(game.getState().score, 0)
  assert.equal(game.getState().lines, 0)
  assert.equal(game.getState().level, 1)
  assert.equal(game.getState().over, false)
  assert.equal(rafState.queue.length, 1)
})

test('paused games ignore gameplay keys', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  press(canvas, 'p')
  const before = game.getState().piece
  press(canvas, 'ArrowLeft')
  press(canvas, 'ArrowDown')
  pressSpace(canvas)
  press(canvas, 'c')
  const after = game.getState().piece
  assert.deepEqual(after, before)
  assert.equal(game.getState().score, 0)
  assert.equal(game.getState().hold, null)
})

// ---------------------------------------------------------------------------
// Lock delay
// ---------------------------------------------------------------------------

test('lock delay: a grounded piece locks after 400ms', () => {
  installSave({ current: { type: 'O', rot: 0, x: 4, y: 20 } })
  const { game } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().current, 'O')
  flushFrames(19, 20) // 380 ms
  assert.equal(game.getState().current, 'O')
  flushFrames(1, 20) // 400 ms
  assert.notEqual(game.getState().current, 'O')
  assert.equal(countBlocks(readSave().board), 4)
})

test('lock delay resets on a successful rotation', () => {
  installSave({ current: { type: 'O', rot: 0, x: 4, y: 20 } })
  const { game, canvas } = boot({}, { random: () => 0.5 })
  flushFrames(15, 20) // 300 ms
  press(canvas, 'ArrowUp') // rotation succeeds, resets lockAccum
  flushFrames(19, 20) // 380 ms more
  assert.equal(game.getState().current, 'O')
  flushFrames(1, 20) // 400 ms after the reset
  assert.notEqual(game.getState().current, 'O')
})

test('lock delay reset is capped at 15 manipulations', () => {
  installSave({ current: { type: 'O', rot: 0, x: 4, y: 20 } })
  const { game, canvas } = boot({}, { random: () => 0.5 })
  for (let step = 0; step < 15; step += 1) press(canvas, 'ArrowUp')
  flushFrames(15, 20) // 300 ms with no reset possible any more
  press(canvas, 'ArrowUp') // cap reached: this must NOT reset the timer
  flushFrames(4, 20) // 380 ms
  assert.equal(game.getState().current, 'O')
  flushFrames(1, 20) // 400 ms
  assert.notEqual(game.getState().current, 'O')
})

test('locking into a blocked spawn ends the game and stops the loop', () => {
  // Every row has a hole so the save is legal; rows 20/21 are completed by the
  // falling O, and after they clear the two empty rows are still not enough for
  // the next piece (rows above the cleared pair stay packed).
  const board = api.createEmptyBoard()
  for (let row = 0; row < 20; row += 1) {
    for (let col = 1; col < api.COLS; col += 1) board[row][col] = 1
  }
  for (let row = 20; row < api.ROWS; row += 1) {
    for (let col = 0; col < api.COLS; col += 1) board[row][col] = 1
  }
  for (const cell of [[4, 20], [5, 20], [4, 21], [5, 21]]) board[cell[1]][cell[0]] = 0
  installSave({ board, current: { type: 'O', rot: 0, x: 4, y: 20 } })
  const { game } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().over, false)
  flushFrames(20, 20) // lock delay 400 ms, then two rows clear and spawn is blocked
  assert.equal(game.getState().over, true)
  assert.equal(game.getState().piece, null)
  assert.equal(rafState.queue.length, 0)
})

// ---------------------------------------------------------------------------
// Pause on hidden document / window blur
// ---------------------------------------------------------------------------

test('document.hidden auto-pauses and visible auto-resumes without a jump', () => {
  installSave()
  const { game } = boot({}, { random: () => 0.5 })
  flushFrames(10, 20)
  assert.equal(game.getState().elapsedMs, 200)
  hideDocument()
  assert.equal(game.getState().paused, true)
  assert.equal(rafState.queue.length, 0)
  flushFrames(10, 500) // wall clock keeps moving; no frames
  assert.equal(game.getState().elapsedMs, 200)
  const yBefore = game.getState().piece.y
  showDocument()
  assert.equal(game.getState().paused, false)
  assert.equal(rafState.queue.length, 1)
  flushFrames(5, 20)
  assert.equal(game.getState().elapsedMs, 300)
  assert.equal(game.getState().piece.y, yBefore)
})

test('window blur auto-pauses and focus auto-resumes', () => {
  installSave()
  const { game } = boot({}, { random: () => 0.5 })
  winListeners.get('blur')()
  assert.equal(game.getState().paused, true)
  assert.equal(rafState.queue.length, 0)
  winListeners.get('focus')()
  assert.equal(game.getState().paused, false)
  assert.equal(rafState.queue.length, 1)
})

test('auto pause does not override a user pause', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  press(canvas, 'p')
  winListeners.get('blur')()
  showDocument()
  showDocument()
  assert.equal(game.getState().paused, true)
  press(canvas, 'p')
  assert.equal(game.getState().paused, false)
})

test('hidden document at a resize keeps the board frozen and does not crash', () => {
  installSave()
  const { game, canvas, host } = boot({}, { random: () => 0.5 })
  hideDocument()
  host.rect = { width: 500, height: 400 }
  lastResizeObserver.callback()
  assert.equal(canvas.width, 1000)
  assert.equal(game.getState().paused, true)
})

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('destroy persists and a re-mount restores the board, piece and score', () => {
  installSave()
  const first = boot({}, { random: () => 0.5 })
  pressSpace(first.canvas)
  const score = first.game.getState().score
  const board = readSave().board
  first.game.destroy()
  currentGame = null

  const second = boot({}, { random: () => 0.5 })
  assert.equal(second.game.getState().score, score)
  assert.deepEqual(readSave().board, board)
  assert.equal(countBlocks(readSave().board), 4)
})

test('a user pause is persisted and restored paused', () => {
  installSave()
  const first = boot({}, { random: () => 0.5 })
  press(first.canvas, 'p')
  first.game.destroy()
  currentGame = null

  const second = boot({}, { random: () => 0.5 })
  assert.equal(second.game.getState().paused, true)
  assert.equal(rafState.queue.length, 0)
  press(second.canvas, 'p')
  assert.equal(second.game.getState().paused, false)
  assert.equal(rafState.queue.length, 1)
})

test('a game-over save restores the game-over state and R restarts', () => {
  const board = api.createEmptyBoard()
  board[21][0] = 1
  installSave({ board, over: true, current: null, score: 4321, lines: 12 })
  const { game, canvas } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().over, true)
  assert.equal(game.getState().score, 4321)
  assert.equal(rafState.queue.length, 0)
  press(canvas, 'r')
  assert.equal(game.getState().over, false)
  assert.equal(game.getState().score, 0)
  assert.equal(rafState.queue.length, 1)
})

test('a corrupt save silently opens a fresh game', () => {
  storage.set(api.STORE_KEY, '{not json')
  const { game } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().score, 0)
  assert.equal(game.getState().over, false)
  assert.ok(game.getState().current)

  currentGame.destroy()
  currentGame = null
  storage.set(api.STORE_KEY, JSON.stringify({ schemaVersion: 99 }))
  const second = boot({}, { random: () => 0.5 })
  assert.equal(second.game.getState().score, 0)
  assert.ok(second.game.getState().current)
})

test('periodic autosave updates the stored elapsed time', () => {
  installSave()
  boot({}, { random: () => 0.5 })
  assert.equal(readSave().playMs, 0)
  flushFrames(210, 20) // 4200 ms
  assert.ok(readSave().playMs >= 4000)
})

// ---------------------------------------------------------------------------
// Focus / listeners / cleanup
// ---------------------------------------------------------------------------

test('an event-handler render failure becomes the in-game error overlay', () => {
  installSave()
  let message = null
  const { game, canvas } = boot({}, {
    random: () => 0.5,
    onError(next) {
      message = next
    },
  })
  const before = game.getState().piece
  canvas.getContext = () => null
  press(canvas, 'ArrowLeft') // safely() must catch the draw failure
  assert.equal(typeof message, 'string')
  assert.ok(message.includes('重试'))
  assert.ok(game.getState().piece.x <= before.x) // the move happens, then the draw fails
  assert.equal(rafState.queue.length, 0)
})

test('keyboard listeners are attached to the canvas only', () => {
  const { canvas } = boot({}, { random: () => 0.5 })
  assert.equal(typeof canvas.listeners.get('keydown'), 'function')
  assert.equal(docListeners.has('keydown'), false)
  assert.equal(winListeners.has('keydown'), false)
})

test('focus/blur updates the snapshot focus flag', () => {
  const { game, canvas } = boot({}, { random: () => 0.5 })
  assert.equal(game.getState().focused, true)
  canvas.blur()
  assert.equal(game.getState().focused, false)
  canvas.focus()
  assert.equal(game.getState().focused, true)
})

test('destroy is idempotent and removes the canvas, listeners and loop', () => {
  const { host, game, canvas } = boot({}, { random: () => 0.5 })
  game.destroy()
  assert.equal(canvas.removed, true)
  assert.equal(host.children.length, 0)
  assert.equal(canvas.listeners.size, 0)
  assert.equal(docListeners.has('visibilitychange'), false)
  assert.equal(winListeners.has('resize'), false)
  assert.equal(winListeners.has('blur'), false)
  assert.equal(winListeners.has('focus'), false)
  assert.equal(rafState.queue.length, 0)
  game.destroy() // must not throw
  assert.equal(lastResizeObserver.disconnected, true)
  currentGame = null
})

test('a resize while paused redraws without restarting the loop', () => {
  installSave()
  const { game, host, canvas } = boot({}, { random: () => 0.5 })
  press(host.children[0], 'p')
  const drawCalls = canvas.calls.clearRect
  host.rect = { width: 640, height: 480 }
  lastResizeObserver.callback()
  assert.equal(canvas.width, 1280)
  assert.ok(canvas.calls.clearRect > drawCalls)
  assert.equal(game.getState().paused, true)
  assert.equal(rafState.queue.length, 0)
})

test('newGame resets score, board and timers', () => {
  installSave()
  const { game, canvas } = boot({}, { random: () => 0.5 })
  pressSpace(canvas)
  flushFrames(50, 20)
  assert.ok(game.getState().score > 0)
  assert.ok(game.getState().lines >= 0)
  game.newGame()
  const state = game.getState()
  assert.equal(state.score, 0)
  assert.equal(state.lines, 0)
  assert.equal(state.level, 1)
  assert.equal(state.over, false)
  assert.equal(state.paused, false)
  assert.equal(state.elapsedMs, 0)
  assert.ok(state.current)
  assert.equal(countBlocks(readSave().board), 0)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
