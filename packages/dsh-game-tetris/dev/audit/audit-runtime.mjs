/**
 * Independent read-only audit — real createGame() lifecycle, focus, pause,
 * persistence and adversarial saves, against a fake DOM/canvas built here.
 *
 * Written by the verifier (not the implementer). No package files are modified.
 * Run: node dev/audit/audit-runtime.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const STORE_KEY = 'dsh.game.tetris.v1'

// ---------------------------------------------------------------------------
// Fake browser environment
// ---------------------------------------------------------------------------
const storage = new Map()
const raf = { queue: [], nextId: 1 }
const docListeners = new Map()
const winListeners = new Map()
let clockMs = 1000
let lastResizeObserver = null

const TOKENS = {
  '--dsw-alias-bg-base': '#10141c',
  '--dsw-alias-bg-layer-2': '#1b2028',
  '--dsw-alias-border-l1': 'rgba(255,255,255,0.16)',
  '--dsw-alias-label-primary': '#eef2f8',
  '--dsw-alias-label-secondary': '#b6c0cf',
  '--dsw-alias-label-tertiary': '#8b95a5',
  '--dsw-alias-brand-primary': '#5b9dff',
}

function makeContext() {
  const calls = { setTransform: [], clearRect: 0, fillRect: 0, fillText: [] }
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
    clip() {},
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
  __ModuleLoader__: { load() {} },
  __DSH_GAME_TETRIS_TEST__: true,
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
    const id = raf.nextId
    raf.nextId += 1
    raf.queue.push({ id, callback })
    return id
  },
  cancelAnimationFrame(id) {
    raf.queue = raf.queue.filter((item) => item.id !== id)
  },
  ResizeObserver: FakeResizeObserver,
}

globalThis.document = documentStub
globalThis.window = windowStub

await import(pathToFileURL(path.join(root, 'client.js')).href)
const api = globalThis.window.__DSH_GAME_TETRIS__
assert.ok(api, 'test seam should be installed')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let passed = 0
let failed = 0
const failures = []
const stats = {}
let currentGame = null
let errorLog = []
const realConsoleError = console.error

function bump(key, n) {
  stats[key] = (stats[key] || 0) + (n === undefined ? 1 : n)
}

function resetWorld() {
  storage.clear()
  raf.queue = []
  docListeners.clear()
  winListeners.clear()
  documentStub.hidden = false
  windowStub.devicePixelRatio = 2
  lastResizeObserver = null
  clockMs = 1000
  errorLog = []
  currentGame = null
}

function test(name, fn) {
  resetWorld()
  console.error = (...args) => {
    errorLog.push(args.map(String).join(' '))
  }
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
    if (errorLog.length > 0) {
      failed += 1
      failures.push(name + ': unexpected console.error -> ' + errorLog.join(' | '))
      console.log('not ok - unexpected console.error in: ' + name)
    }
  } catch (error) {
    failed += 1
    failures.push(name + ': ' + (error && error.message))
    console.log('not ok - ' + name + ' :: ' + (error && error.message))
  } finally {
    console.error = realConsoleError
    try {
      if (currentGame) currentGame.destroy()
    } catch (cleanupError) {
      // ignore cleanup noise
    }
    currentGame = null
  }
}

function makeRng(seed) {
  let state = seed >>> 0
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function emptyBoard() {
  return api.createEmptyBoard()
}

function baseSave(overrides) {
  const rng = makeRng(17)
  const saved = api.serializeState(api.freshState(rng), false)
  Object.assign(saved, overrides || {})
  return saved
}

function installSave(overrides) {
  storage.set(STORE_KEY, JSON.stringify(baseSave(overrides)))
}

function installRaw(text) {
  storage.set(STORE_KEY, text)
}

function readSave() {
  const raw = storage.get(STORE_KEY)
  assert.ok(raw, 'save entry should exist')
  return JSON.parse(raw)
}

function countBlocks(board) {
  let count = 0
  for (const row of board) for (const value of row) if (value !== 0) count += 1
  return count
}

function boot(rect, options) {
  const host = makeHost(Object.assign({ width: 800, height: 600 }, rect || {}))
  currentGame = api.createGame(host, options || { random: makeRng(42) })
  return { host, game: currentGame, canvas: host.children[0] }
}

function flushFrames(count, step) {
  for (let frame = 0; frame < count; frame += 1) {
    clockMs += step
    const batch = raf.queue
    raf.queue = []
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
  assert.equal(typeof listener, 'function', 'visibilitychange listener')
  listener()
}

function showDocument() {
  documentStub.hidden = false
  const listener = docListeners.get('visibilitychange')
  assert.equal(typeof listener, 'function', 'visibilitychange listener')
  listener()
}

// ---------------------------------------------------------------------------
// Boot / canvas / listeners
// ---------------------------------------------------------------------------
test('boot: HiDPI canvas, tabIndex 0, focused, save key and fields', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { host, game, canvas } = boot()
  assert.equal(host.children.length, 1)
  assert.equal(canvas.width, 1600)
  assert.equal(canvas.height, 1200)
  assert.equal(canvas.tabIndex, 0)
  assert.equal(canvas.attrs.role, 'application')
  assert.equal(canvas.focused, true)
  assert.ok(canvas.style.cssText.includes('width:100%'))
  assert.ok(canvas.calls.setTransform.some((args) => args[0] === 2 && args[3] === 2))
  assert.ok(canvas.calls.fillText.includes('HOLD'))
  assert.ok(canvas.calls.fillText.includes('NEXT'))
  const snapshot = game.getState()
  assert.equal(snapshot.score, 0)
  assert.equal(snapshot.lines, 0)
  assert.equal(snapshot.level, 1)
  assert.equal(snapshot.over, false)
  assert.equal(snapshot.paused, false)
  assert.equal(snapshot.focused, true)
  assert.ok(snapshot.current)
  assert.equal(snapshot.next.length, 5)
  assert.deepEqual([...storage.keys()], [STORE_KEY])
  const saved = readSave()
  for (const field of ['schemaVersion', 'board', 'current', 'queue', 'bag', 'hold', 'canHold', 'score', 'lines', 'level', 'playMs', 'over', 'paused']) {
    assert.ok(Object.prototype.hasOwnProperty.call(saved, field), field)
  }
  assert.equal(saved.board.length, 22)
  assert.equal(saved.board[0].length, 10)
  bump('boots')
})

test('listeners: keydown only on canvas; document gets visibilitychange only', () => {
  installSave()
  const { canvas } = boot()
  assert.equal(typeof canvas.listeners.get('keydown'), 'function')
  assert.equal(typeof canvas.listeners.get('pointerdown'), 'function')
  assert.equal(typeof canvas.listeners.get('focus'), 'function')
  assert.equal(typeof canvas.listeners.get('blur'), 'function')
  assert.equal(docListeners.has('keydown'), false)
  assert.equal(winListeners.has('keydown'), false)
  assert.equal(docListeners.has('visibilitychange'), true)
  assert.equal(winListeners.has('resize'), true)
  assert.equal(winListeners.has('blur'), true)
  assert.equal(winListeners.has('focus'), true)
  bump('global keydown listeners avoided')
})

test('keyboard: arrows/space preventDefault, movement and soft/hard drop', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game, canvas } = boot()
  let event = press(canvas, 'ArrowLeft')
  assert.equal(event.defaultPrevented, true)
  assert.equal(game.getState().piece.x, 2)
  event = press(canvas, 'ArrowRight')
  assert.equal(event.defaultPrevented, true)
  assert.equal(game.getState().piece.x, 3)
  event = press(canvas, 'ArrowDown')
  assert.equal(event.defaultPrevented, true)
  assert.equal(game.getState().piece.y, 2)
  assert.equal(game.getState().score, 1)
  event = pressSpace(canvas)
  assert.equal(event.defaultPrevented, true)
  const after = game.getState()
  assert.ok(after.score > 1)
  assert.notEqual(after.current, 'T')
  assert.equal(after.canHold, true)
  bump('keyboard events')
})

test('keyboard repeat does not rotate/hold/hard-drop repeatedly', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game, canvas } = boot()
  const before = game.getState()
  press(canvas, 'ArrowUp', { repeat: true })
  assert.equal(game.getState().piece.rot, before.piece.rot)
  press(canvas, 'c', { repeat: true })
  assert.equal(game.getState().hold, null)
  pressSpace(canvas, { repeat: true })
  assert.deepEqual(game.getState().piece, before.piece)
  assert.equal(game.getState().score, before.score)
})

// ---------------------------------------------------------------------------
// Timestamp gravity
// ---------------------------------------------------------------------------
test('gravity is timestamp based: 780ms no drop, 800ms one row', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game } = boot()
  flushFrames(39, 20)
  assert.equal(game.getState().piece.y, 1)
  assert.equal(game.getState().elapsedMs, 780)
  flushFrames(1, 20)
  assert.equal(game.getState().piece.y, 2)
  assert.equal(game.getState().elapsedMs, 800)
})

test('gravity is not frame-counted: 300 zero-dt frames never move the piece', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game } = boot()
  flushFrames(300, 0)
  assert.equal(game.getState().piece.y, 1)
  assert.equal(game.getState().elapsedMs, 0)
})

test('a long stall is clamped to <=250ms (no teleport)', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game } = boot()
  flushFrames(1, 10000)
  assert.equal(game.getState().piece.y, 1)
  assert.ok(game.getState().elapsedMs <= 250)
})

// ---------------------------------------------------------------------------
// Lock delay
// ---------------------------------------------------------------------------
test('lock delay: grounded piece locks after 400ms, not 380ms', () => {
  installSave({ current: { type: 'O', rot: 0, x: 4, y: 20 } })
  const { game } = boot()
  assert.equal(game.getState().current, 'O')
  flushFrames(19, 20)
  assert.equal(game.getState().current, 'O')
  flushFrames(1, 20)
  assert.notEqual(game.getState().current, 'O')
  assert.equal(countBlocks(readSave().board), 4)
})

test('lock delay resets on rotate (600ms total still alive, locks 400ms after reset)', () => {
  installSave({ current: { type: 'O', rot: 0, x: 4, y: 20 } })
  const { game, canvas } = boot()
  flushFrames(15, 20) // 300ms
  press(canvas, 'ArrowUp')
  assert.equal(game.getState().current, 'O')
  flushFrames(15, 20) // 300ms since reset (600ms grounded total)
  assert.equal(game.getState().current, 'O')
  flushFrames(5, 20) // 400ms since reset
  assert.notEqual(game.getState().current, 'O')
})

test('lock reset is capped at 15; the 16th manipulation cannot extend it', () => {
  installSave({ current: { type: 'O', rot: 0, x: 4, y: 20 } })
  const { game, canvas } = boot()
  flushFrames(15, 20) // 300ms
  for (let i = 0; i < 15; i += 1) {
    press(canvas, 'ArrowUp') // successful rotation resets the lock timer
    assert.equal(game.getState().current, 'O', 'reset ' + (i + 1) + ' should keep the piece')
    flushFrames(15, 20) // 300ms < 400ms, so it never locks between resets
  }
  assert.equal(game.getState().current, 'O')
  press(canvas, 'ArrowUp') // 16th: reset budget exhausted
  flushFrames(5, 20) // 100ms -> 400ms since the last allowed reset
  assert.notEqual(game.getState().current, 'O', 'cap should force the lock')
  bump('lock-delay reset-budget rotations', 16)
})

// ---------------------------------------------------------------------------
// Pause / visibility / blur
// ---------------------------------------------------------------------------
test('document.hidden pauses, visible resumes without a time jump', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game } = boot()
  flushFrames(10, 20)
  assert.equal(game.getState().elapsedMs, 200)
  hideDocument()
  assert.equal(game.getState().paused, true)
  assert.equal(raf.queue.length, 0, 'rAF stopped while hidden')
  flushFrames(10, 500)
  assert.equal(game.getState().elapsedMs, 200)
  const yBefore = game.getState().piece.y
  showDocument()
  assert.equal(game.getState().paused, false)
  assert.equal(raf.queue.length, 1, 'rAF restarted when visible')
  flushFrames(5, 20)
  assert.equal(game.getState().elapsedMs, 300)
  assert.equal(game.getState().piece.y, yBefore)
  bump('hidden pause/resume')
})

test('window blur pauses, focus resumes (without overriding a user pause)', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game, canvas } = boot()
  winListeners.get('blur')()
  assert.equal(game.getState().paused, true)
  assert.equal(raf.queue.length, 0)
  winListeners.get('focus')()
  assert.equal(game.getState().paused, false)
  assert.equal(raf.queue.length, 1)
  press(canvas, 'p')
  winListeners.get('blur')()
  winListeners.get('focus')()
  assert.equal(game.getState().paused, true, 'user pause survives focus')
  press(canvas, 'p')
  assert.equal(game.getState().paused, false)
})

test('user pause is persisted; restore is paused; gameplay keys ignored while paused', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const first = boot()
  press(first.canvas, 'p')
  assert.equal(first.game.getState().paused, true)
  const frozen = first.game.getState()
  press(first.canvas, 'ArrowLeft')
  press(first.canvas, 'ArrowDown')
  pressSpace(first.canvas)
  press(first.canvas, 'c')
  assert.deepEqual(first.game.getState().piece, frozen.piece)
  assert.equal(first.game.getState().score, frozen.score)
  assert.equal(first.game.getState().hold, frozen.hold)
  flushFrames(10, 20)
  assert.equal(first.game.getState().elapsedMs, frozen.elapsedMs)
  assert.equal(readSave().paused, true)
  first.game.destroy()
  currentGame = null

  const second = boot()
  assert.equal(second.game.getState().paused, true)
  assert.equal(raf.queue.length, 0, 'restored paused game does not tick')
  press(second.canvas, 'p')
  assert.equal(second.game.getState().paused, false)
  assert.equal(raf.queue.length, 1)
})

test('game-over save restores over state; P ignored; R starts a new game', () => {
  const board = emptyBoard()
  board[19][0] = 1
  installSave({ board, over: true, current: null, score: 4321, lines: 12 })
  const { game, canvas } = boot()
  assert.equal(game.getState().over, true)
  assert.equal(game.getState().score, 4321)
  assert.equal(raf.queue.length, 0, 'no loop after game over')
  press(canvas, 'p')
  assert.equal(game.getState().paused, false)
  assert.equal(game.getState().over, true)
  press(canvas, 'r')
  assert.equal(game.getState().over, false)
  assert.equal(game.getState().score, 0)
  assert.equal(raf.queue.length, 1)
})

test('initial document.hidden boot does not tick until visible', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  documentStub.hidden = true
  const { game } = boot()
  assert.equal(game.getState().paused, false)
  assert.equal(raf.queue.length, 0)
  flushFrames(3, 20)
  assert.equal(game.getState().elapsedMs, 0)
  showDocument()
  assert.equal(raf.queue.length, 1)
  flushFrames(5, 20)
  assert.equal(game.getState().elapsedMs, 100)
})

// ---------------------------------------------------------------------------
// Persistence / destroy
// ---------------------------------------------------------------------------
test('destroy: persists full state, stops rAF, removes canvas and all listeners', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { host, game, canvas } = boot()
  pressSpace(canvas)
  const score = game.getState().score
  assert.ok(score > 0)
  game.destroy()
  currentGame = null
  const saved = readSave()
  assert.equal(saved.board.length, 22)
  assert.equal(countBlocks(saved.board), 4)
  assert.equal(typeof saved.current, 'object')
  assert.equal(saved.score, score)
  assert.ok(Array.isArray(saved.queue))
  assert.ok(Array.isArray(saved.bag))
  assert.equal(typeof saved.playMs, 'number')
  assert.equal(saved.paused, false)
  assert.equal(raf.queue.length, 0)
  assert.equal(canvas.removed, true)
  assert.equal(host.children.length, 0)
  assert.equal(canvas.listeners.size, 0)
  assert.equal(docListeners.has('visibilitychange'), false)
  assert.equal(winListeners.has('resize'), false)
  assert.equal(winListeners.has('blur'), false)
  assert.equal(winListeners.has('focus'), false)
  assert.equal(lastResizeObserver.disconnected, true)
  assert.doesNotThrow(() => game.destroy(), 'destroy is idempotent')
  bump('destroyed instances')
})

test('destroy while document.hidden: saves the frozen board, no crash', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game, canvas } = boot()
  pressSpace(canvas)
  hideDocument()
  assert.equal(game.getState().paused, true)
  assert.doesNotThrow(() => game.destroy())
  currentGame = null
  const saved = readSave()
  assert.equal(countBlocks(saved.board), 4)
  assert.equal(saved.paused, false, 'visibility pause is not persisted as a user pause')
  assert.equal(raf.queue.length, 0)
})

test('destroy then remount restores score/board/piece', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const first = boot()
  pressSpace(first.canvas)
  const score = first.game.getState().score
  const board = readSave().board
  const queue = readSave().queue
  first.game.destroy()
  currentGame = null
  const second = boot()
  assert.equal(second.game.getState().score, score)
  assert.deepEqual(readSave().board, board)
  assert.deepEqual(readSave().queue, queue)
  assert.ok(second.game.getState().current)
})

test('restored game continues the saved 7-bag queue (runtime hard drops)', () => {
  // Build a save mid-bag, then hard-drop through queue+bag in the real game.
  const rng = makeRng(123)
  const state = api.freshState(rng)
  for (let i = 0; i < 9; i += 1) api.takeNext(state, rng)
  const saved = api.serializeState(state, false)
  storage.set(STORE_KEY, JSON.stringify(saved))
  const expected = saved.queue.concat(saved.bag)
  const { game, canvas } = boot()
  assert.deepEqual(game.getState().next, saved.queue)
  for (let i = 0; i < expected.length; i += 1) {
    assert.equal(game.getState().current, i === 0 ? saved.current.type : expected[i - 1])
    pressSpace(canvas)
    if (game.getState().over) break
  }
  bump('restored pieces compared', expected.length)
})

// ---------------------------------------------------------------------------
// Fast input / soft drop
// ---------------------------------------------------------------------------
test('20 consecutive hard drops never crash and keep board/piece consistent', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game, canvas } = boot()
  let lastScore = 0
  let drops = 0
  let overAt = -1
  for (let i = 0; i < 20; i += 1) {
    assert.doesNotThrow(() => pressSpace(canvas))
    const snapshot = game.getState()
    assert.ok(snapshot.score >= lastScore, 'score never decreases')
    lastScore = snapshot.score
    if (!snapshot.over) {
      const board = readSave().board
      assert.equal(api.collides(board, snapshot.piece), false, 'spawned piece must not overlap the board')
      assert.ok(snapshot.current)
    } else if (overAt === -1) {
      overAt = i
    }
    drops += 1
  }
  assert.ok(drops === 20)
  bump('fast hard drops', drops)
})

test('soft drop to the floor: +1 per row, no lock before 400ms, locks after', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game, canvas } = boot()
  let moves = 0
  for (let i = 0; i < 30; i += 1) {
    const beforeY = game.getState().piece.y
    press(canvas, 'ArrowDown')
    if (game.getState().piece.y > beforeY) moves += 1
  }
  const snapshot = game.getState()
  assert.equal(snapshot.piece.y, 20, 'T rot0 rests with origin at row 20')
  assert.equal(snapshot.score, moves)
  assert.equal(moves, 19)
  flushFrames(19, 20)
  assert.equal(game.getState().current, 'T', 'still inside lock delay')
  flushFrames(1, 20)
  assert.notEqual(game.getState().current, 'T')
  bump('soft-drop rows', moves)
})

test('pointerdown focuses the canvas; focus flag tracks canvas focus/blur', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game, canvas } = boot()
  assert.equal(game.getState().focused, true)
  canvas.blur()
  assert.equal(game.getState().focused, false)
  canvas.dispatch('pointerdown', { button: 0 })
  assert.equal(game.getState().focused, true)
  canvas.focus()
  assert.equal(game.getState().focused, true)
})

test('R restart gives a fresh 7-bag (5 seeds)', () => {
  for (let seed = 1; seed <= 5; seed += 1) {
    installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
    const { game, canvas } = boot(undefined, { random: makeRng(seed * 1000) })
    press(canvas, 'r')
    const pieces = [game.getState().current]
    for (let i = 0; i < 6; i += 1) {
      pressSpace(canvas)
      pieces.push(game.getState().current)
    }
    assert.equal(pieces.length, 7)
    assert.equal(new Set(pieces).size, 7, 'seed ' + seed + ' first 7 pieces: ' + pieces.join(','))
    game.destroy()
    currentGame = null
  }
  bump('restart 7-bag checks', 5)
})

// ---------------------------------------------------------------------------
// Hostile / corrupt saves through the real mount path
// ---------------------------------------------------------------------------
test('corrupt JSON save silently opens a fresh game', () => {
  installRaw('{not json')
  const { game } = boot()
  assert.equal(game.getState().score, 0)
  assert.equal(game.getState().over, false)
  assert.ok(game.getState().current)
  assert.equal(countBlocks(readSave().board), 0)
})

test('schema/shape mismatch opens a fresh game', () => {
  installRaw(JSON.stringify({ schemaVersion: 99 }))
  const { game } = boot()
  assert.equal(game.getState().score, 0)
  assert.ok(game.getState().current)
})

test('current overlapping the board is rejected -> fresh game', () => {
  const board = emptyBoard()
  board[2][3] = 1 // T spawn cell
  installSave({ board, current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game } = boot()
  assert.equal(game.getState().score, 0)
  assert.equal(game.getState().over, false)
  assert.ok(game.getState().current)
  assert.equal(countBlocks(readSave().board), 0)
})

test('tampered queue/bag: invalid ones are rejected, duplicate queue accepted (note)', () => {
  installSave({ queue: ['I', 'I', 'I', 'I', 'I'], bag: [] })
  let booted = boot()
  assert.deepEqual(booted.game.getState().next, ['I', 'I', 'I', 'I', 'I'])
  booted.game.destroy()
  currentGame = null
  bump('tampered queue accepted (7-bag continuity not enforced on a tampered save)', 1)

  installSave({ bag: ['I', 'I'] })
  booted = boot()
  assert.equal(booted.game.getState().score, 0)
  assert.equal(countBlocks(readSave().board), 0, 'duplicate bag rejected -> fresh')
  booted.game.destroy()
  currentGame = null

  installSave({ queue: new Array(41).fill('I') })
  booted = boot()
  assert.equal(booted.game.getState().score, 0)
  assert.equal(countBlocks(readSave().board), 0, '41-item queue rejected -> fresh')
})

test('level disagrees with lines: level normalized from lines', () => {
  installSave({ lines: 25, level: 99 })
  const { game } = boot()
  assert.equal(game.getState().level, 3)
  assert.equal(game.getState().lines, 25)
})

test('out-of-range fields are rejected -> fresh game (8 cases)', () => {
  const cases = [
    { score: -1 },
    { score: 1000000001 },
    { playMs: -1 },
    { lines: -1 },
    { hold: 'Q' },
    { current: { type: 'Q', rot: 0, x: 3, y: 1 } },
  ]
  const cellBad = emptyBoard()
  cellBad[5][5] = 8
  cases.push({ board: cellBad })
  const rowsBad = emptyBoard()
  rowsBad.pop()
  cases.push({ board: rowsBad })
  for (const overrides of cases) {
    resetWorld()
    installSave(overrides)
    const { game } = boot()
    assert.equal(game.getState().score, 0, 'fresh for ' + JSON.stringify(overrides).slice(0, 60))
    assert.equal(game.getState().level, 1)
    assert.equal(countBlocks(readSave().board), 0, 'fresh board for ' + JSON.stringify(overrides).slice(0, 60))
    game.destroy()
    currentGame = null
  }
  bump('hostile runtime saves', cases.length)
})

test('full-row save is rejected (impossible legitimate state)', () => {
  const board = emptyBoard()
  for (let col = 0; col < 10; col += 1) board[21][col] = 1
  installSave({ board })
  const { game } = boot()
  assert.equal(countBlocks(readSave().board), 0)
})

test('resize/dpr while running and while paused does not restart the loop', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game, host, canvas } = boot()
  host.rect = { width: 500, height: 400 }
  lastResizeObserver.callback()
  assert.equal(canvas.width, 1000)
  assert.equal(canvas.height, 800)
  windowStub.devicePixelRatio = 3
  lastResizeObserver.callback()
  assert.equal(canvas.width, 1500)
  assert.equal(canvas.calls.setTransform[canvas.calls.setTransform.length - 1][0], 3)
  press(canvas, 'p')
  host.rect = { width: 640, height: 480 }
  lastResizeObserver.callback()
  assert.equal(game.getState().paused, true)
  assert.equal(raf.queue.length, 0)
})

test('tiny host draws the too-small hint instead of a broken board', () => {
  installSave()
  const { host, canvas } = boot({ width: 320, height: 260 })
  canvas.calls.fillText.length = 0
  host.rect = { width: 200, height: 150 }
  lastResizeObserver.callback()
  assert.ok(canvas.calls.fillText.includes('窗口太小'))
  assert.ok(canvas.calls.fillText.includes('请放大游戏区域'))
})

test('hard drop scores +2 per row and locks instantly; 0-distance hard drop locks without score', () => {
  // T spawns at y=1 with its bottom on row 2; it can fall 19 rows.
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  let booted = boot()
  pressSpace(booted.canvas)
  assert.equal(booted.game.getState().score, 38)
  assert.notEqual(booted.game.getState().current, 'T')
  assert.equal(countBlocks(readSave().board), 4)
  booted.game.destroy()
  currentGame = null

  // Grounded O: hard drop has 0 distance, still locks immediately with +0.
  installSave({ current: { type: 'O', rot: 0, x: 4, y: 20 } })
  booted = boot()
  assert.equal(booted.game.getState().current, 'O')
  pressSpace(booted.canvas)
  assert.equal(booted.game.getState().score, 0)
  assert.notEqual(booted.game.getState().current, 'O')
  assert.equal(countBlocks(readSave().board), 4)
})

test('pause freezes the lock delay countdown', () => {
  installSave({ current: { type: 'O', rot: 0, x: 4, y: 20 } })
  const { game, canvas } = boot()
  flushFrames(15, 20) // 300ms of the 400ms lock delay
  press(canvas, 'p')
  flushFrames(50, 20) // no frames run while paused
  assert.equal(game.getState().current, 'O', 'lock countdown must not advance while paused')
  press(canvas, 'p')
  flushFrames(5, 20) // 100ms -> 400ms total
  assert.notEqual(game.getState().current, 'O')
})

test('hidden pause reason survives a window blur and resumes on visible', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  const { game } = boot()
  hideDocument()
  assert.equal(game.getState().paused, true)
  winListeners.get('blur')() // must not overwrite the 'hidden' reason
  showDocument()
  assert.equal(game.getState().paused, false, 'visible auto-resume should still work')
})

test('periodic autosave writes elapsed time every ~4s', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  boot()
  assert.equal(readSave().playMs, 0)
  flushFrames(210, 20) // 4200ms
  assert.ok(readSave().playMs >= 4000)
})

test('fuzz: 2500 random inputs + remounts keep state, board and invariants valid', () => {
  installSave({ current: { type: 'T', rot: 0, x: 3, y: 1 } })
  let booted = boot(undefined, { random: makeRng(77) })
  let game = booted.game
  let canvas = booted.canvas
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'z', 'x', 'c', ' ', 'p', 'r', 'Shift']
  const rng = makeRng(2024)
  let actions = 0
  let restarts = 0
  let overs = 0
  let remounts = 0

  const checkInvariants = (label) => {
    const snapshot = game.getState()
    assert.ok(Number.isFinite(snapshot.score) && snapshot.score >= 0, label + ' score ' + snapshot.score)
    assert.ok(Number.isInteger(snapshot.lines) && snapshot.lines >= 0, label + ' lines')
    assert.ok(Number.isInteger(snapshot.level) && snapshot.level >= 1, label + ' level')
    assert.equal(snapshot.level, Math.floor(snapshot.lines / 10) + 1, label + ' level/lines')
    assert.ok(Number.isFinite(snapshot.elapsedMs) && snapshot.elapsedMs >= 0, label + ' elapsed')
    assert.ok(Array.isArray(snapshot.next) && snapshot.next.length === 5, label + ' next')
    const saved = readSave()
    assert.equal(saved.board.length, 22)
    for (const row of saved.board) {
      assert.equal(row.length, 10)
      for (const value of row) assert.ok(Number.isInteger(value) && value >= 0 && value <= 7)
    }
    assert.ok(!saved.board.some((row) => row.every((value) => value !== 0)), label + ' no full row in save')
    assert.equal(saved.lines, snapshot.lines, label + ' saved lines')
    assert.equal(saved.level, snapshot.level, label + ' saved level')
    if (snapshot.over) {
      assert.equal(snapshot.current, null, label + ' no current when over')
    } else {
      assert.ok(snapshot.current, label + ' current exists')
      assert.equal(api.collides(saved.board, snapshot.piece), false, label + ' current overlaps board')
    }
  }

  checkInvariants('boot')
  for (let step = 0; step < 2500; step += 1) {
    const roll = rng()
    if (roll < 0.7) {
      const key = keys[Math.floor(rng() * keys.length)]
      press(canvas, key, { repeat: rng() < 0.1 })
    } else if (roll < 0.88) {
      flushFrames(1 + Math.floor(rng() * 3), 10 + Math.floor(rng() * 40))
    } else if (roll < 0.92) {
      hideDocument()
    } else if (roll < 0.96) {
      showDocument()
    } else if (roll < 0.98) {
      winListeners.get('blur')()
    } else {
      winListeners.get('focus')()
    }
    actions += 1
    if (game.getState().over) {
      overs += 1
      if (rng() < 0.25) {
        press(canvas, 'r')
        restarts += 1
      }
    }
    if (step % 25 === 0) checkInvariants('step ' + step)
    if (step === 800 || step === 1700) {
      const before = game.getState()
      const savedBefore = readSave()
      game.destroy()
      currentGame = null
      booted = boot(undefined, { random: makeRng(step) })
      game = booted.game
      canvas = booted.canvas
      const after = game.getState()
      assert.equal(after.score, savedBefore.score, 'restored score')
      assert.equal(after.lines, savedBefore.lines, 'restored lines')
      assert.equal(after.level, savedBefore.level, 'restored level')
      assert.deepEqual(readSave().board, savedBefore.board, 'restored board')
      if (savedBefore.current) assert.equal(after.current, savedBefore.current.type, 'restored current type')
      else assert.equal(after.over, true, 'restored game over')
      assert.ok(after.elapsedMs >= 0)
      remounts += 1
    }
  }
  checkInvariants('final')
  bump('fuzz actions', actions)
  bump('fuzz restarts', restarts)
  bump('fuzz over observations', overs)
  bump('fuzz destroy/remount cycles', remounts)
})

// ---------------------------------------------------------------------------
console.log('\nruntime audit: ' + passed + ' passed, ' + failed + ' failed')
console.log('counters: ' + JSON.stringify(stats, null, 2))
if (failed > 0) {
  console.log('failures:\n- ' + failures.join('\n- '))
  process.exitCode = 1
}
