/**
 * Headless lifecycle tests for @local/dsh-game-battleship (dev-only).
 *
 * Runs client.js in a fake browser environment (no React, no real DOM):
 * fake window/document/localStorage, controllable setTimeout timers,
 * requestAnimationFrame, ResizeObserver and a fake host element. It drives the
 * `createGame` controller exactly as the React component does and asserts the
 * contract lifecycle: mount/emit, placement/fire/AI timer, save-on-destroy,
 * restore mid-battle, visibility pause, listener hygiene.
 *
 * Run from the repo root: node packages/dsh-game-battleship/dev/test-headless.mjs
 */

// ---------------------------------------------------------------------------
// Fake browser environment (installed BEFORE importing client.js)
// ---------------------------------------------------------------------------

const store = new Map()
const storageCalls = { get: [], set: [] }

let nextTimerId = 1
const timers = new Map()
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
globalThis.setTimeout = function fakeSetTimeout(fn, ms) {
  const id = nextTimerId
  nextTimerId += 1
  timers.set(id, { fn: fn, ms: Number(ms) || 0, cleared: false })
  return id
}
globalThis.clearTimeout = function fakeClearTimeout(id) {
  const timer = timers.get(id)
  if (timer) timer.cleared = true
  timers.delete(id)
}
function pendingTimers() {
  return Array.from(timers.entries()).filter((entry) => !entry[1].cleared)
}
function runTimersByMs(ms) {
  const matches = pendingTimers().filter((entry) => entry[1].ms === ms)
  let ran = 0
  for (let i = 0; i < matches.length; i += 1) {
    const id = matches[i][0]
    const timer = timers.get(id)
    if (!timer || timer.cleared) continue
    timer.cleared = true
    timers.delete(id)
    ran += 1
    timer.fn()
  }
  return ran
}
function clearAllTimers() {
  for (const entry of timers.values()) entry.cleared = true
  timers.clear()
}

let rafQueue = []
let nextRafId = 1
globalThis.requestAnimationFrame = function fakeRaf(fn) {
  const id = nextRafId
  nextRafId += 1
  rafQueue.push({ id: id, fn: fn })
  return id
}
globalThis.cancelAnimationFrame = function fakeCancelRaf(id) {
  rafQueue = rafQueue.filter((entry) => entry.id !== id)
}
function runRaf() {
  const queue = rafQueue
  rafQueue = []
  for (let i = 0; i < queue.length; i += 1) queue[i].fn()
}

const resizeObservers = []
globalThis.ResizeObserver = class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback
    this.targets = []
    this.disconnected = false
    resizeObservers.push(this)
  }
  observe(target) {
    this.targets.push(target)
  }
  disconnect() {
    this.disconnected = true
  }
  trigger() {
    if (!this.disconnected) this.callback([])
  }
}

const documentListeners = {}
let documentHidden = false
let bodyTouched = false
const bodyProxy = new Proxy(
  {},
  {
    set(target, property, value) {
      bodyTouched = true
      target[property] = value
      return true
    },
    defineProperty(target, property, descriptor) {
      bodyTouched = true
      return Object.defineProperty(target, property, descriptor)
    },
    setPrototypeOf(target, proto) {
      bodyTouched = true
      return Object.setPrototypeOf(target, proto)
    },
  },
)
const documentObj = {
  get hidden() {
    return documentHidden
  },
  get visibilityState() {
    return documentHidden ? 'hidden' : 'visible'
  },
  get body() {
    return bodyProxy
  },
  addEventListener(type, fn) {
    if (!documentListeners[type]) documentListeners[type] = []
    documentListeners[type].push(fn)
  },
  removeEventListener(type, fn) {
    if (!documentListeners[type]) return
    documentListeners[type] = documentListeners[type].filter((entry) => entry !== fn)
  },
}
globalThis.document = documentObj
function fireDocumentEvent(type) {
  const listeners = (documentListeners[type] || []).slice()
  for (let i = 0; i < listeners.length; i += 1) listeners[i]({ type: type })
}

const windowListeners = {}
const windowObj = {
  __DSH_GAME_BATTLESHIP_TEST__: true,
  devicePixelRatio: 2,
  localStorage: {
    getItem(key) {
      storageCalls.get.push(key)
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      storageCalls.set.push(key)
      store.set(key, String(value))
    },
    removeItem(key) {
      store.delete(key)
    },
  },
  addEventListener(type, fn) {
    if (!windowListeners[type]) windowListeners[type] = []
    windowListeners[type].push(fn)
  },
  removeEventListener(type, fn) {
    if (!windowListeners[type]) return
    windowListeners[type] = windowListeners[type].filter((entry) => entry !== fn)
  },
}
globalThis.window = windowObj

await import('../client.js')
const G = window.__DSH_GAME_BATTLESHIP__
if (!G) throw new Error('test seam missing')

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const results = { pass: 0, fail: 0, failures: [] }
function test(name, fn) {
  try {
    clearAllTimers()
    rafQueue = []
    resizeObservers.length = 0
    for (const key of Object.keys(documentListeners)) delete documentListeners[key]
    for (const key of Object.keys(windowListeners)) delete windowListeners[key]
    documentHidden = false
    bodyTouched = false
    store.clear()
    storageCalls.get.length = 0
    storageCalls.set.length = 0
    fn()
    results.pass += 1
  } catch (error) {
    results.fail += 1
    results.failures.push(name + ': ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : String(error)))
  }
}
function ok(cond, label) {
  if (!cond) throw new Error(label)
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(label + ': expected ' + b + ', got ' + a)
}
function includes(text, part, label) {
  if (String(text).indexOf(part) < 0) throw new Error(label + ': "' + text + '" does not include "' + part + '"')
}

const SAFE_ORIGINS = [0, 20, 40, 60, 80]

function makeHost(width, height) {
  const rootRect = { width: width === undefined ? 900 : width, height: height === undefined ? 560 : height }
  const bodyRect = { width: rootRect.width, height: rootRect.height - 90 }
  const bodyEl = {
    getBoundingClientRect() {
      return { width: bodyRect.width, height: bodyRect.height }
    },
  }
  const host = {
    getBoundingClientRect() {
      return { width: rootRect.width, height: rootRect.height }
    },
    querySelector(selector) {
      return selector === '[data-dsh-body]' ? bodyEl : null
    },
    bodyRect: bodyRect,
    rootRect: rootRect,
  }
  return host
}

function mount(host, extra) {
  const states = []
  const errors = []
  const options = Object.assign(
    {
      onState(view) {
        states.push(view)
      },
      onError(message) {
        errors.push(message)
      },
    },
    extra || {},
  )
  const game = G.createGame(host, options)
  const last = function () {
    return states[states.length - 1]
  }
  return { game: game, states: states, errors: errors, last: last }
}

function placeSafeFleet(game, view) {
  for (let i = 0; i < SAFE_ORIGINS.length; i += 1) {
    game.clickCell(SAFE_ORIGINS[i])
  }
}

function startBattleThroughUi(game) {
  placeSafeFleet(game)
  game.start()
}

function waterCells(state, side) {
  const ships = side === 'enemy' ? state.enemyShips : state.playerShips
  const occupied = new Set()
  for (let i = 0; i < ships.length; i += 1) {
    for (let j = 0; j < ships[i].cells.length; j += 1) occupied.add(ships[i].cells[j])
  }
  const water = []
  for (let cell = 0; cell < 100; cell += 1) if (!occupied.has(cell)) water.push(cell)
  return water
}

function enemyShipCells(state) {
  const cells = []
  for (let i = 0; i < state.enemyShips.length; i += 1) {
    for (let j = 0; j < state.enemyShips[i].cells.length; j += 1) cells.push(state.enemyShips[i].cells[j])
  }
  return cells
}

// A valid battle save that is one shot away from a player win.
function nearWinSave(seed) {
  const state = G.newGameState(seed)
  state.playerShips = [
    { key: 'carrier', cells: G.shipCells(0, 5, true) },
    { key: 'battleship', cells: G.shipCells(20, 4, true) },
    { key: 'cruiser', cells: G.shipCells(40, 3, true) },
    { key: 'submarine', cells: G.shipCells(60, 3, true) },
    { key: 'destroyer', cells: G.shipCells(80, 2, true) },
  ]
  state.enemyShips = [
    { key: 'carrier', cells: G.shipCells(0, 5, true) },
    { key: 'battleship', cells: G.shipCells(20, 4, true) },
    { key: 'cruiser', cells: G.shipCells(40, 3, true) },
    { key: 'submarine', cells: G.shipCells(60, 3, true) },
    { key: 'destroyer', cells: G.shipCells(80, 2, true) },
  ]
  state.phase = 'battle'
  state.turn = 'player'
  state.placementIndex = 5
  state.playerShots = new Array(100).fill(0)
  state.enemyShots = new Array(100).fill(0)
  // Enemy: first four ships fully hit, destroyer cell 80 hit (16 hits).
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < state.enemyShips[i].cells.length; j += 1) state.playerShots[state.enemyShips[i].cells[j]] = 2
  }
  state.playerShots[80] = 2
  // AI fired 16 misses at player water (rows 1 and 3).
  let placed = 0
  for (let cell = 10; cell <= 19 && placed < 16; cell += 1) {
    state.enemyShots[cell] = 1
    placed += 1
  }
  for (let cell = 30; cell <= 39 && placed < 16; cell += 1) {
    state.enemyShots[cell] = 1
    placed += 1
  }
  const serialized = JSON.parse(JSON.stringify(G.serializeState(state)))
  const checked = G.sanitizeState(JSON.parse(JSON.stringify(serialized)))
  if (!checked) throw new Error('nearWinSave is not a valid save')
  return JSON.parse(JSON.stringify(G.serializeState(checked)))
}

// ---------------------------------------------------------------------------
// Mount / initial state
// ---------------------------------------------------------------------------

test('mount emits a playable placement view and persists a fresh save', function () {
  const host = makeHost()
  const session = mount(host)
  ok(session.states.length >= 1, 'onState fired')
  const view = session.last()
  eq(view.phase, 'place', 'phase place')
  eq(view.turn, 'player', 'player turn')
  eq(view.winner, null, 'no winner')
  eq(view.tooSmall, false, 'not too small')
  ok(view.layout.boardPx >= 90, 'board sized')
  eq(view.placedCount, 0, 'nothing placed')
  eq(view.playerShips.length, 0, 'no ships')
  eq(view.canStart, false, 'cannot start')
  eq(view.currentShip.key, 'carrier', 'carrier first')
  eq(view.playerCells.length, 100, '100 player cells')
  eq(view.enemyCells.length, 100, '100 enemy cells')
  eq(view.enemyCells.every((cell) => cell.shot === 'none'), true, 'enemy board unknown')
  eq(store.has('dsh.game.battleship.v1'), true, 'fresh save written')
  eq(storageCalls.set.every((key) => key === 'dsh.game.battleship.v1'), true, 'only our key written')
  session.game.destroy()
})

test('ResizeObserver remeasures the layout', function () {
  const host = makeHost(900, 560)
  const session = mount(host)
  const first = session.last().layout.boardPx
  host.bodyRect.width = 600
  host.bodyRect.height = 420
  eq(resizeObservers.length >= 1, true, 'observer created')
  resizeObservers[0].trigger()
  runRaf()
  const second = session.last().layout.boardPx
  ok(second !== first, 'layout changed: ' + first + ' -> ' + second)
  ok(second >= 90, 'still playable')
  session.game.destroy()
})

test('too-small stage shows the prompt view', function () {
  const host = makeHost(300, 220)
  const session = mount(host)
  eq(session.last().tooSmall, true, 'too small')
  session.game.destroy()
})

test('host without querySelector still measures', function () {
  const host = {
    getBoundingClientRect() {
      return { width: 800, height: 600 }
    },
  }
  const session = mount(host)
  eq(session.last().tooSmall, false, 'usable')
  ok(session.last().layout.boardPx >= 90, 'board sized')
  session.game.destroy()
})

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

test('placement: place, reject illegal, undo, rotate, randomize', function () {
  const session = mount(makeHost())
  const game = session.game
  game.clickCell(0)
  eq(session.last().placedCount, 1, 'carrier placed')
  eq(session.last().playerCells[0].ship, 'carrier', 'cell 0 shows carrier')
  includes(session.last().message, '已放置', 'placement toast')

  game.clickCell(10) // directly below carrier -> adjacent
  eq(session.last().placedCount, 1, 'adjacent rejected')
  includes(session.last().message, '相邻', 'adjacent message')

  game.clickCell(20)
  eq(session.last().placedCount, 2, 'battleship placed')

  game.clickCell(1) // overlap-ish? current ship cruiser at origin 1
  eq(session.last().placedCount, 2, 'overlap rejected')

  game.undoPlacement()
  eq(session.last().placedCount, 1, 'undo works')

  game.rotate()
  eq(session.last().orientation, 'v', 'rotate to vertical')
  game.clickCell(30) // battleship vertical at 30,40,50,60 -> cell 60 is submarine row 6? no ship placed yet
  eq(session.last().placedCount, 2, 'vertical placement works')
  game.rotate()

  game.randomize()
  eq(session.last().placedCount, 5, 'randomized five ships')
  eq(session.last().canStart, true, 'can start')
  eq(session.last().currentShip, null, 'no current ship')
  const fleet = game.getState().playerShips
  eq(G.fleetCompleteOk(fleet, false), true, 'randomized fleet legal')
  game.destroy()
})

test('placement: start requires five ships', function () {
  const session = mount(makeHost())
  session.game.clickCell(0)
  session.game.start()
  eq(session.last().phase, 'place', 'still placing')
  includes(session.last().message, '尚未', 'incomplete message')
  session.game.destroy()
})

// ---------------------------------------------------------------------------
// Battle + AI timer
// ---------------------------------------------------------------------------

test('battle: player fires, AI replies on its timer, no repeats', function () {
  const session = mount(makeHost())
  const game = session.game
  startBattleThroughUi(game)
  const view = session.last()
  eq(view.phase, 'battle', 'battle started')
  eq(view.turn, 'player', 'player first')
  eq(view.canFire, true, 'can fire')
  eq(view.playerShips.length, 5, 'own fleet visible')
  eq(view.enemyShips.length, 5, 'enemy fleet tracked')
  eq(view.stats.enemySunk, 0, 'nothing sunk')

  const state = game.getState()
  const water = waterCells(state, 'enemy')
  const missCell = water[0]
  game.clickCell(missCell)
  eq(state.playerShots[missCell], 1, 'miss recorded')
  eq(session.last().turn, 'enemy', 'AI turn')
  eq(session.last().message, '未命中…', 'miss toast')
  const aiTimers = pendingTimers().filter((entry) => entry[1].ms === 520)
  eq(aiTimers.length, 1, 'AI timer scheduled')
  runTimersByMs(520)
  eq(session.last().turn, 'player', 'AI replied')
  eq(session.last().stats.enemyFired, 1, 'AI fired once')

  // Re-firing the same cell is rejected.
  game.clickCell(missCell)
  includes(session.last().message, '已经打过', 'fired cell message')

  // A few more full turns: the AI never repeats a cell.
  for (let round = 0; round < 8; round += 1) {
    const live = game.getState()
    const unknown = waterCells(live, 'enemy')
    game.clickCell(unknown[0])
    runTimersByMs(520)
  }
  const live = game.getState()
  const aiShots = live.enemyShots.filter((value) => value !== 0)
  eq(aiShots.length, new Set(live.enemyShots.map((value, cell) => (value ? cell : -1)).filter((cell) => cell >= 0)).size, 'AI shots unique')
  eq(live.enemyShots.length, 100, 'board intact')
  game.destroy()
})

test('battle: sunk ship name is announced and board shows sunk cells', function () {
  const session = mount(makeHost())
  const game = session.game
  // Load a near-win save and sink the destroyer's last cell.
  store.set('dsh.game.battleship.v1', JSON.stringify(nearWinSave(90210)))
  const host = makeHost()
  const restored = mount(host)
  const restoredGame = restored.game
  eq(restored.last().phase, 'battle', 'restored battle')
  restoredGame.clickCell(81)
  const view = restored.last()
  eq(view.phase, 'over', 'game over')
  eq(view.winner, 'player', 'player won')
  includes(view.message, '击沉', 'sunk message')
  includes(view.message, '驱逐舰', 'sunk ship name')
  includes(view.message, '赢', 'win message')
  const cell = view.enemyCells[81]
  eq(cell.shot, 'sunk', 'sunk cell state')
  eq(cell.sunk, true, 'sunk flag')
  eq(view.stats.enemySunk, 5, 'five sunk')
  const saved = JSON.parse(store.get('dsh.game.battleship.v1'))
  eq(saved.winner, 'player', 'winner persisted')
  eq(saved.phase, 'over', 'phase persisted')
  restoredGame.destroy()
  session.game.destroy()
})

test('battle: restart and surrender', function () {
  const session = mount(makeHost())
  const game = session.game
  startBattleThroughUi(game)
  const state = game.getState()
  const missCell = waterCells(state, 'enemy')[0]
  game.clickCell(missCell)
  runTimersByMs(520)
  game.restart()
  eq(game.getState().phase, 'battle', 'restart phase')
  eq(game.getState().turn, 'player', 'restart player turn')
  eq(G.countShotCells(game.getState().playerShots), 0, 'restart cleared shots')
  eq(game.getState().playerShips.length, 5, 'restart keeps fleet')

  game.surrender()
  eq(session.last().phase, 'over', 'surrender ends game')
  eq(session.last().winner, 'enemy', 'enemy wins')
  eq(session.last().endReason, 'surrender', 'surrender reason')
  includes(session.last().message, '投降', 'surrender message')
  game.destroy()
})

// ---------------------------------------------------------------------------
// Persistence / restore / destroy
// ---------------------------------------------------------------------------

test('destroy saves and is idempotent; listeners and observers are cleaned', function () {
  const session = mount(makeHost())
  const game = session.game
  startBattleThroughUi(game)
  const state = game.getState()
  game.clickCell(waterCells(state, 'enemy')[0])
  eq(pendingTimers().filter((entry) => entry[1].ms === 520).length, 1, 'AI timer alive')
  const errorListenersBefore = (documentListeners.visibilitychange || []).length
  ok(errorListenersBefore >= 1, 'visibility listener registered')
  eq((documentListeners.keydown || []).length, 0, 'no document keydown')
  eq((windowListeners.keydown || []).length, 0, 'no window keydown')
  ok((windowListeners.resize || []).length >= 1, 'resize fallback registered')
  eq(bodyTouched, false, 'document.body untouched')

  game.destroy()
  eq(pendingTimers().length, 0, 'timers cleared')
  eq((documentListeners.visibilitychange || []).length, 0, 'visibility listener removed')
  eq((windowListeners.resize || []).length, 0, 'resize listener removed')
  ok(resizeObservers.length > 0 && resizeObservers.every((observer) => observer.disconnected), 'observers disconnected')
  eq(store.has('dsh.game.battleship.v1'), true, 'state saved on destroy')
  const saved = JSON.parse(store.get('dsh.game.battleship.v1'))
  eq(saved.phase, 'battle', 'battle saved')
  eq(G.countShotCells(saved.playerShots), 1, 'shots saved')
  game.destroy() // idempotent
  eq(bodyTouched, false, 'body still untouched')
})

test('remount restores a mid-battle game (fleet, shots, turn)', function () {
  const host = makeHost()
  const first = mount(host)
  startBattleThroughUi(first.game)
  const state = first.game.getState()
  const water = waterCells(state, 'enemy')
  first.game.clickCell(water[0])
  runTimersByMs(520) // AI replies, back to player turn
  const before = JSON.parse(JSON.stringify(G.serializeState(first.game.getState())))
  first.game.destroy()

  const second = mount(host)
  const view = second.last()
  eq(view.phase, 'battle', 'battle restored')
  eq(view.turn, 'player', 'turn restored')
  eq(view.playerShips.length, 5, 'player fleet restored')
  eq(view.enemyShips.length, 5, 'enemy fleet restored')
  const after = JSON.parse(JSON.stringify(G.serializeState(second.game.getState())))
  eq(after.playerShots, before.playerShots, 'player shots restored')
  eq(after.enemyShots, before.enemyShots, 'enemy shots restored')
  eq(after.playerShips, before.playerShips, 'player fleet identical')
  eq(after.enemyShips, before.enemyShips, 'enemy fleet identical')
  second.game.destroy()
})

test('remount restores a partial placement game', function () {
  const host = makeHost()
  const first = mount(host)
  first.game.clickCell(0)
  first.game.clickCell(20)
  first.game.destroy()

  const second = mount(host)
  const view = second.last()
  eq(view.phase, 'place', 'placement restored')
  eq(view.placedCount, 2, 'two ships restored')
  eq(view.playerCells[0].ship, 'carrier', 'carrier restored')
  eq(view.currentShip.key, 'cruiser', 'next ship cruiser')
  second.game.destroy()
})

test('remount restores a completed placement (randomized, not started)', function () {
  const host = makeHost()
  const first = mount(host)
  first.game.randomize()
  first.game.destroy()

  const second = mount(host)
  const view = second.last()
  eq(view.phase, 'place', 'still placement')
  eq(view.placedCount, 5, 'five ships restored')
  eq(view.canStart, true, 'ready to start')
  second.game.start()
  eq(second.last().phase, 'battle', 'start works after restore')
  second.game.destroy()
})

test('remount during the AI turn reschedules the AI move', function () {
  const host = makeHost()
  const first = mount(host)
  startBattleThroughUi(first.game)
  const state = first.game.getState()
  first.game.clickCell(waterCells(state, 'enemy')[0])
  eq(first.last().turn, 'enemy', 'AI pending')
  first.game.destroy()

  const second = mount(host)
  eq(second.last().turn, 'enemy', 'restored during AI turn')
  eq(pendingTimers().filter((entry) => entry[1].ms === 520).length, 1, 'AI timer rescheduled')
  runTimersByMs(520)
  eq(second.last().turn, 'player', 'AI moved after restore')
  eq(second.last().stats.enemyFired, 1, 'AI shot applied')
  second.game.destroy()
})

// ---------------------------------------------------------------------------
// Visibility + message timers
// ---------------------------------------------------------------------------

test('visibility: AI pauses while hidden and resumes when visible', function () {
  const session = mount(makeHost())
  const game = session.game
  startBattleThroughUi(game)
  const state = game.getState()
  game.clickCell(waterCells(state, 'enemy')[0])
  eq(pendingTimers().filter((entry) => entry[1].ms === 520).length, 1, 'AI timer pending')
  documentHidden = true
  fireDocumentEvent('visibilitychange')
  eq(pendingTimers().filter((entry) => entry[1].ms === 520).length, 0, 'AI timer paused while hidden')
  runTimersByMs(520)
  eq(session.last().turn, 'enemy', 'AI did not move while hidden')
  documentHidden = false
  fireDocumentEvent('visibilitychange')
  eq(pendingTimers().filter((entry) => entry[1].ms === 520).length, 1, 'AI timer resumed')
  runTimersByMs(520)
  eq(session.last().turn, 'player', 'AI moved after visible')
  game.destroy()
})

test('toast message clears on its own timer', function () {
  const session = mount(makeHost())
  session.game.clickCell(0)
  includes(session.last().message, '已放置', 'message shown')
  const messageTimers = pendingTimers().filter((entry) => entry[1].ms === 2600)
  eq(messageTimers.length, 1, 'message timer scheduled')
  runTimersByMs(2600)
  eq(session.last().message, '', 'message cleared')
  session.game.destroy()
})

// ---------------------------------------------------------------------------
// Error / robustness
// ---------------------------------------------------------------------------

test('throwing onState does not crash the controller', function () {
  const host = makeHost()
  const errors = []
  let calls = 0
  const originalConsoleError = console.error
  console.error = function silenced() {}
  try {
    const game = G.createGame(host, {
      onState() {
        calls += 1
        throw new Error('consumer boom')
      },
      onError(message) {
        errors.push(message)
      },
    })
    ok(calls >= 1, 'onState called')
    ok(errors.length >= 1, 'onError reported')
    game.clickCell(0)
    game.rotate()
    game.destroy()
  } finally {
    console.error = originalConsoleError
  }
})

test('localStorage failures are survivable', function () {
  const original = window.localStorage
  window.localStorage = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
    removeItem() {},
  }
  try {
    const session = mount(makeHost())
    eq(session.last().phase, 'place', 'game still starts')
    session.game.clickCell(0)
    eq(session.last().placedCount, 1, 'game still playable')
    session.game.destroy()
  } finally {
    window.localStorage = original
  }
})

test('new game resets to placement with a fresh seed', function () {
  const session = mount(makeHost())
  const firstSeed = session.game.getState().seed
  startBattleThroughUi(session.game)
  session.game.newGame()
  const state = session.game.getState()
  eq(state.phase, 'place', 'placement phase')
  eq(state.playerShips.length, 0, 'fleet cleared')
  eq(state.turn, 'player', 'player turn')
  eq(state.playerShots.every((value) => value === 0), true, 'shots cleared')
  ok(state.seed !== firstSeed, 'new seed')
  session.game.destroy()
})

// ---------------------------------------------------------------------------
// Duo mode (same-device hot-seat) driven through the controller
// ---------------------------------------------------------------------------

test('duo: mode switch starts a fresh two-player placement', function () {
  const session = mount(makeHost())
  const game = session.game
  eq(session.last().mode, 'ai', 'starts solo')
  game.setMode('duo')
  const view = session.last()
  eq(view.mode, 'duo', 'duo mode')
  eq(view.phase, 'place', 'placement')
  eq(view.ownLabel, '玩家 A', 'A places first')
  eq(view.showOpponentPanel, false, 'only one board while placing')
  eq(view.handoff, null, 'no curtain yet')
  ok(view.statusText.indexOf('玩家 A') >= 0, 'status names the placer')
  game.destroy()
})

test('duo: A places, hands over, B places, battle starts covered', function () {
  const session = mount(makeHost())
  const game = session.game
  game.setMode('duo')
  placeSafeFleet(game)
  eq(session.last().canStart, true, 'A ready')
  game.start()
  let view = session.last()
  eq(view.phase, 'place', 'still placing')
  eq(view.handoff, 'curtain', 'curtain to B')
  eq(view.handoffLabel, '玩家 B', 'B next')
  eq(view.showOpponentPanel, false, 'still one board')
  game.acknowledge()
  eq(session.last().handoff, null, 'curtain cleared')
  // Player B places the second fleet on the same board position.
  placeSafeFleet(game)
  ok(game.getState().enemyShips.length === 5, 'B fleet placed')
  eq(game.getState().playerShips.length, 5, 'A fleet untouched')
  game.start()
  view = session.last()
  eq(view.phase, 'battle', 'battle')
  eq(view.turn, 'player', 'A first')
  eq(view.handoff, 'curtain', 'A confirms before playing')
  eq(view.canFire, false, 'cannot fire behind the curtain')
  game.destroy()
})

test('duo: A fires, keeps his view, then passes the device', function () {
  const session = mount(makeHost())
  const game = session.game
  game.setMode('duo')
  placeSafeFleet(game)
  game.start()
  game.acknowledge()
  placeSafeFleet(game)
  game.start()
  game.acknowledge()
  const state = game.getState()
  const target = waterCells(state, 'enemy')[0]
  game.clickCell(target)
  let view = session.last()
  eq(view.handoff, 'pass', 'waiting for the hand-over')
  eq(view.canFire, false, 'nobody fires during the pass')
  eq(view.ownLabel, '玩家 A', 'shooter keeps his own board')
  eq(view.enemyCells[target].shot, 'miss', 'shot visible to the shooter')
  eq(pendingTimers().filter((entry) => entry[1].ms === 520).length, 0, 'no AI timer in duo')
  game.pass()
  view = session.last()
  eq(view.handoff, 'curtain', 'curtain up')
  eq(view.ownLabel, '玩家 B', 'perspective flipped to B')
  eq(view.playerCells[0].ship, G.SHIPS[0].key, 'B sees his own fleet')
  game.destroy()
})

test('duo: B fires after acknowledging, then A gets the device back', function () {
  const session = mount(makeHost())
  const game = session.game
  game.setMode('duo')
  placeSafeFleet(game)
  game.start()
  game.acknowledge()
  placeSafeFleet(game)
  game.start()
  game.acknowledge()
  const state = game.getState()
  game.clickCell(waterCells(state, 'enemy')[0])
  game.pass()
  game.acknowledge()
  eq(session.last().ownLabel, '玩家 B', 'B plays')
  const target = waterCells(state, 'player')[0]
  game.clickCell(target)
  const view = session.last()
  eq(view.handoff, 'pass', 'B passes back')
  eq(view.ownLabel, '玩家 B', 'B keeps his view until he passes')
  eq(view.stats.enemyFired, 1, 'B shot counted')
  game.pass()
  eq(session.last().ownLabel, '玩家 A', 'A perspective restored')
  eq(session.last().handoff, 'curtain', 'A must confirm')
  game.destroy()
})

test('duo: mid-pass state survives a remount', function () {
  const host = makeHost()
  const first = mount(host)
  first.game.setMode('duo')
  placeSafeFleet(first.game)
  first.game.start()
  first.game.acknowledge()
  placeSafeFleet(first.game)
  first.game.start()
  first.game.acknowledge()
  first.game.clickCell(waterCells(first.game.getState(), 'enemy')[0])
  first.game.destroy()

  const second = mount(host)
  const view = second.last()
  eq(view.mode, 'duo', 'mode restored')
  eq(view.handoff, 'pass', 'still waiting for the hand-over')
  eq(view.ownLabel, '玩家 A', 'shooter perspective restored')
  eq(view.stats.playerFired, 1, 'shot restored')
  second.game.destroy()
})

test('duo: AI never fires on its own', function () {
  const session = mount(makeHost())
  const game = session.game
  game.setMode('duo')
  placeSafeFleet(game)
  game.start()
  game.acknowledge()
  placeSafeFleet(game)
  game.start()
  game.acknowledge()
  game.clickCell(waterCells(game.getState(), 'enemy')[0])
  eq(pendingTimers().filter((entry) => entry[1].ms === 520).length, 0, 'no AI move scheduled')
  ok(pendingTimers().every((entry) => entry[1].ms !== 520), 'no pending AI timer of any kind')
  game.destroy()
})

test('duo: switching back to solo restores the AI game', function () {
  const session = mount(makeHost())
  const game = session.game
  game.setMode('duo')
  game.setMode('ai')
  const view = session.last()
  eq(view.mode, 'ai', 'solo again')
  eq(view.phase, 'place', 'fresh placement')
  eq(view.handoff, null, 'no curtain')
  game.destroy()
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const total = results.pass + results.fail
console.log('')
console.log('battleship test-headless: ' + results.pass + '/' + total + ' passed, ' + results.fail + ' failed')
if (results.failures.length > 0) {
  console.log('')
  for (let i = 0; i < results.failures.length; i += 1) console.log('FAIL  ' + results.failures[i])
  process.exitCode = 1
}
