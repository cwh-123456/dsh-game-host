/**
 * Headless lifecycle self test for @local/dsh-game-solitaire.
 *
 * Run: node dev/test-headless.mjs
 *
 * 不依赖浏览器与 React：在 import client.js 之前装好假 window / document /
 * localStorage / ResizeObserver / rAF / 时钟，然后通过测试 seam 的
 * createGame(host, opts) 驱动真实控制器，覆盖：
 *   - 初始挂载 / ResizeObserver 尺寸与 dpr / 窗口太小
 *   - 点牌堆翻牌、弃牌堆回收、选中与放置、双击自动进基座、自动翻牌
 *   - 撤销 / 重开（同一副牌）/ 新游戏（指定种子）
 *   - 计时器启动、暂停（document.hidden）、恢复不跳时、销毁落盘
 *   - 存档恢复 / 坏档回退 / onState 监听器异常不炸游戏
 *   - destroy 幂等、监听器与观察器清理
 */
import assert from 'node:assert/strict'

/* ---------------------------------------------------------------------------
 * 假浏览器环境（必须在 import client.js 之前装好）
 * ------------------------------------------------------------------------ */

const storage = new Map()
const docListeners = new Map()
const winListeners = new Map()
let clockMs = 1000
let rafIdSeq = 1
const rafQueue = new Map()
const resizeObservers = []
let loadedDefinition = null

function addListener(map, type, fn) {
  if (!map.has(type)) map.set(type, [])
  map.get(type).push(fn)
}
function removeListener(map, type, fn) {
  const list = map.get(type)
  if (!list) return
  const index = list.indexOf(fn)
  if (index >= 0) list.splice(index, 1)
}
function dispatch(map, type, event) {
  const list = (map.get(type) || []).slice()
  for (const fn of list) fn(event)
}

const hostRect = { width: 720, height: 600 }
const host = {
  getBoundingClientRect() {
    return { width: hostRect.width, height: hostRect.height, left: 0, top: 0, right: hostRect.width, bottom: hostRect.height }
  },
  clientWidth: 720,
  clientHeight: 600,
}

const doc = {
  hidden: false,
  addEventListener(type, fn) {
    addListener(docListeners, type, fn)
  },
  removeEventListener(type, fn) {
    removeListener(docListeners, type, fn)
  },
}

globalThis.document = doc
globalThis.window = {
  __DSH_GAME_SOLITAIRE_TEST__: true,
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
    clear() {
      storage.clear()
    },
  },
  devicePixelRatio: 1,
  performance: { now: () => clockMs },
  requestAnimationFrame(callback) {
    const id = rafIdSeq
    rafIdSeq += 1
    rafQueue.set(id, callback)
    return id
  },
  cancelAnimationFrame(id) {
    rafQueue.delete(id)
  },
  ResizeObserver: class FakeResizeObserver {
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
  },
  addEventListener(type, fn) {
    addListener(winListeners, type, fn)
  },
  removeEventListener(type, fn) {
    removeListener(winListeners, type, fn)
  },
}

await import(new URL('../client.js', import.meta.url).href)

const api = globalThis.window.__DSH_GAME_SOLITAIRE__
assert.ok(api, 'test seam should be installed')
assert.equal(loadedDefinition && loadedDefinition.id, '@local/dsh-game-solitaire')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    failed += 1
    console.error('not ok - ' + name)
    console.error(error)
  }
}

/* ---------------------------------------------------------------------------
 * 小工具
 * ------------------------------------------------------------------------ */

function resetWorld() {
  storage.clear()
  clockMs = 1000
  rafQueue.clear()
  doc.hidden = false
  hostRect.width = 720
  hostRect.height = 600
  globalThis.window.devicePixelRatio = 1
  resizeObservers.length = 0
}

function runFrames(count) {
  let ran = 0
  let guard = 0
  while (rafQueue.size && ran < count && guard < 10000) {
    const ids = Array.from(rafQueue.keys())
    for (const id of ids) {
      const callback = rafQueue.get(id)
      rafQueue.delete(id)
      if (callback) callback(clockMs)
      ran += 1
      if (ran >= count) break
    }
    guard += 1
  }
  return ran
}

function settle() {
  // allow any setTimeout/promise-free work to run (not needed by controller,
  // but keeps tests robust against future scheduling)
}

function create(overrides) {
  const options = Object.assign({ clock: () => clockMs }, overrides || {})
  let latest = null
  let errorMessage = null
  const game = api.createGame(host, {
    clock: options.clock,
    onState(next) {
      latest = next
    },
    onError(message) {
      errorMessage = message
    },
  })
  return {
    game,
    snapshot() {
      return latest || game.snapshot()
    },
    error() {
      return errorMessage
    },
  }
}

function readSaved() {
  const raw = storage.get(api.STORE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    return null
  }
}

function savedState() {
  const raw = readSaved()
  return raw ? api.sanitizeState(raw) : null
}

function cardId(suit, rank) {
  return suit * 13 + (rank - 1)
}

/** Build a valid save raw object from a compact spec; unlisted cards -> stock. */
function rawState(spec) {
  const options = spec || {}
  const foundations = [[], [], [], []]
  for (const key of Object.keys(options.foundations || {})) {
    foundations[Number(key)] = options.foundations[key].slice()
  }
  const waste = (options.waste || []).slice()
  const tableauSpec = options.tableau || [[], [], [], [], [], [], []]
  const tableau = tableauSpec.map((column) =>
    column.map((entry) => (entry && typeof entry === 'object' ? { id: entry.id, up: entry.up !== false } : { id: entry, up: true })),
  )
  while (tableau.length < 7) tableau.push([])
  const used = new Set()
  function use(id) {
    assert.ok(Number.isInteger(id) && id >= 0 && id < 52, 'bad card id')
    assert.ok(!used.has(id), 'duplicate card id ' + id)
    used.add(id)
  }
  foundations.forEach((pile) => pile.forEach(use))
  waste.forEach(use)
  tableau.forEach((column) => column.forEach((card) => use(card.id)))
  const stock = []
  for (let id = 0; id < 52; id += 1) if (!used.has(id)) stock.push(id)
  return {
    schemaVersion: 1,
    seed: options.seed === undefined ? 7 : options.seed,
    started: options.started !== false,
    won: options.won === true,
    moves: options.moves || 0,
    elapsedMs: options.elapsedMs || 0,
    undo: [],
    stock,
    waste,
    foundations,
    tableau: tableau.map((column) => column.map((card) => (card.up ? card.id : card.id + 52))),
  }
}

function injectSave(raw) {
  const state = api.sanitizeState(raw)
  assert.ok(state, 'crafted save must be valid')
  storage.set(api.STORE_KEY, JSON.stringify(api.serializeState(state)))
}

function assertSavedPiles(expected) {
  const state = savedState()
  assert.ok(state, 'a save should exist')
  if (expected.stock !== undefined) assert.equal(state.stock.length, expected.stock)
  if (expected.waste !== undefined) assert.equal(state.waste.length, expected.waste)
  if (expected.moves !== undefined) assert.equal(state.moves, expected.moves)
  if (expected.started !== undefined) assert.equal(state.started, expected.started)
  if (expected.won !== undefined) assert.equal(state.won, expected.won)
  if (expected.tableau) {
    expected.tableau.forEach((column, index) => {
      const wanted = typeof column === 'number' ? column : column.length
      assert.equal(state.tableau[index].length, wanted, 'tableau column ' + index + ' length')
    })
  }
  if (expected.foundations) {
    expected.foundations.forEach((length, index) => {
      assert.equal(state.foundations[index].length, length, 'foundation ' + index + ' length')
    })
  }
  return state
}

/* ---------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------ */

test('mount: initial view, layout, deal and emitted snapshot', function () {
  resetWorld()
  const world = create()
  try {
    const view = world.snapshot()
    assert.ok(view, 'onState should receive an initial view')
    assert.equal(view.width, 720)
    assert.equal(view.height, 600)
    assert.equal(view.dpr, 1)
    assert.equal(view.tooSmall, false)
    assert.ok(view.layout && view.layout.cardW > 0)
    assert.equal(view.stock.length, 24)
    assert.equal(view.waste.length, 0)
    assert.deepEqual(view.foundations, [[], [], [], []])
    assert.deepEqual(view.tableau.map((column) => column.length), [1, 2, 3, 4, 5, 6, 7])
    assert.equal(view.tableau[6][6].up, true)
    assert.equal(view.started, false)
    assert.equal(view.moves, 0)
    assert.equal(view.undoCount, 0)
    assert.equal(view.elapsedText, '00:00')
    assert.equal(view.selection, null)
    assert.ok(resizeObservers.length >= 1, 'ResizeObserver should observe the board')
    assert.ok(docListeners.get('visibilitychange') && docListeners.get('visibilitychange').length === 1)
    assert.ok(winListeners.get('resize') && winListeners.get('resize').length === 1)
  } finally {
    world.game.destroy()
  }
})

test('draw: one card per click, moves/started/timer update and save persists', function () {
  resetWorld()
  const world = create()
  try {
    world.game.onStockClick()
    let view = world.snapshot()
    assert.equal(view.stock.length, 23)
    assert.equal(view.waste.length, 1)
    assert.equal(view.moves, 1)
    assert.equal(view.started, true)
    assert.ok(savedState(), 'action should persist')
    assertSavedPiles({ stock: 23, waste: 1, moves: 1, started: true })

    clockMs += 3000
    runFrames(5)
    view = world.snapshot()
    assert.equal(view.elapsedSeconds, 3, 'timer should tick after starting')

    world.game.onStockClick()
    assert.equal(world.snapshot().stock.length, 22)
    assert.equal(world.snapshot().waste.length, 2)
  } finally {
    world.game.destroy()
  }
})

test('select and place: waste top onto a valid tableau column', function () {
  resetWorld()
  injectSave(rawState({ waste: [cardId(2, 4), cardId(1, 7)], tableau: [[cardId(0, 8)], []] }))
  const world = create()
  try {
    world.game.onWasteClick()
    let view = world.snapshot()
    assert.equal(view.selection && view.selection.kind, 'waste')
    assert.equal(view.valid.tableau[0], true, 'red 7 can go onto black 8')
    world.game.onColumnClick(0)
    view = world.snapshot()
    assert.equal(view.selection, null)
    assert.equal(view.tableau[0].length, 2)
    assert.equal(view.waste.length, 1)
    assert.equal(view.moves, 1)
    const state = assertSavedPiles({ waste: 1, moves: 1, tableau: [2, 0, 0, 0, 0, 0, 0] })
    assert.equal(state.tableau[0][1].id, cardId(1, 7))
  } finally {
    world.game.destroy()
  }
})

test('select: clicking a card selects the whole run and highlights legal targets', function () {
  resetWorld()
  injectSave(rawState({
    tableau: [[cardId(0, 8)], [cardId(3, 13), cardId(1, 12), cardId(3, 11)], []],
  }))
  const world = create()
  try {
    world.game.onTableauCardClick(1, 0)
    let view = world.snapshot()
    assert.equal(view.selection.kind, 'tableau')
    assert.equal(view.selection.col, 1)
    assert.equal(view.selection.index, 0)
    assert.deepEqual(view.selectedCards, [cardId(3, 13), cardId(1, 12), cardId(3, 11)])
    assert.equal(view.valid.tableau[2], true, 'empty column accepts the K-headed run')
    assert.equal(view.valid.tableau[0], false, 'K cannot go onto 8')
    world.game.onColumnClick(2)
    view = world.snapshot()
    assert.equal(view.tableau[1].length, 0)
    assert.equal(view.tableau[2].length, 3)
    assert.equal(view.selection, null)
    assertSavedPiles({ moves: 1, tableau: [1, 0, 3, 0, 0, 0, 0] })
  } finally {
    world.game.destroy()
  }
})

test('invalid placement is rejected without mutating the game', function () {
  resetWorld()
  injectSave(rawState({ tableau: [[cardId(0, 8)], [cardId(1, 7)], [cardId(0, 6)]] }))
  const world = create()
  try {
    world.game.onTableauCardClick(1, 0)
    world.game.onColumnClick(2) // 7♥ onto 6♠: wrong rank
    let view = world.snapshot()
    assert.equal(view.selection && view.selection.kind, 'tableau')
    assert.equal(view.tableau[1].length, 1)
    assert.ok(view.message.length > 0, 'should explain the rule')
    const before = savedState()
    assert.equal(before.tableau[1].length, 1)
    assert.equal(before.moves, 0)
  } finally {
    world.game.destroy()
  }
})

test('auto flip: exposed face-down card turns face up after a move', function () {
  resetWorld()
  injectSave(rawState({
    tableau: [[{ id: cardId(2, 5), up: false }, cardId(1, 7)], [cardId(0, 8)]],
  }))
  const world = create()
  try {
    const initial = savedState()
    assert.equal(initial.tableau[0][0].up, false, 'crafted card starts face down')
    world.game.onTableauCardClick(0, 1)
    world.game.onColumnClick(1)
    const view = world.snapshot()
    assert.equal(view.tableau[0].length, 1)
    assert.equal(view.tableau[0][0].up, true, 'exposed card auto-flips')
    const saved = savedState()
    assert.equal(saved.tableau[0][0].up, true, 'face-up state persisted')
  } finally {
    world.game.destroy()
  }
})

test('double click: sends the top card to its foundation', function () {
  resetWorld()
  injectSave(rawState({ tableau: [[cardId(0, 1)], [cardId(1, 1)]] }))
  const world = create()
  try {
    world.game.onDoubleClick({ kind: 'tableau', col: 0, index: 0 })
    let view = world.snapshot()
    assert.equal(view.foundations[0].length, 1)
    assert.equal(view.tableau[0].length, 0)
    assert.equal(view.moves, 1)
    assert.equal(view.message, '')
    // second click on the other ace
    world.game.onDoubleClick({ kind: 'tableau', col: 1, index: 0 })
    view = world.snapshot()
    assert.equal(view.foundations[1].length, 1)
    assertSavedPiles({ moves: 2, foundations: [1, 1, 0, 0], tableau: [0, 0, 0, 0, 0, 0, 0] })
  } finally {
    world.game.destroy()
  }
})

test('double click: covered card is refused with a readable message', function () {
  resetWorld()
  injectSave(rawState({ tableau: [[cardId(2, 9), cardId(3, 8)], [cardId(0, 1)]] }))
  const world = create()
  try {
    world.game.onDoubleClick({ kind: 'tableau', col: 0, index: 0 })
    const view = world.snapshot()
    assert.equal(view.moves, 0)
    assert.equal(view.tableau[0].length, 2)
    assert.ok(view.message.length > 0)
  } finally {
    world.game.destroy()
  }
})

test('waste can go to a foundation and win is detected', function () {
  resetWorld()
  const foundations = [[], [], [], []]
  for (let suit = 0; suit < 4; suit += 1) {
    for (let rank = 1; rank <= 12; rank += 1) foundations[suit].push(cardId(suit, rank))
  }
  injectSave(rawState({
    foundations: { 0: foundations[0], 1: foundations[1], 2: foundations[2], 3: foundations[3] },
    tableau: [[cardId(0, 13)], [cardId(1, 13)], [cardId(2, 13)], [cardId(3, 13)]],
  }))
  const world = create()
  try {
    for (let suit = 0; suit < 4; suit += 1) {
      world.game.onTableauCardClick(suit, 0)
      world.game.onFoundationClick(suit)
    }
    const view = world.snapshot()
    assert.equal(view.won, true)
    assert.equal(view.foundations.every((pile) => pile.length === 13), true)
    const saved = savedState()
    assert.equal(saved.won, true)
    assert.equal(saved.foundations[3].length, 13)
  } finally {
    world.game.destroy()
  }
})

test('undo: restores the previous position, stack and button count', function () {
  resetWorld()
  injectSave(rawState({ tableau: [[cardId(0, 8)], [cardId(1, 7)]] }))
  const world = create()
  try {
    world.game.onTableauCardClick(1, 0)
    world.game.onColumnClick(0)
    let view = world.snapshot()
    assert.equal(view.moves, 1)
    assert.equal(view.undoCount, 1)
    assert.equal(view.tableau[0].length, 2)
    world.game.undo()
    view = world.snapshot()
    assert.equal(view.moves, 0)
    assert.equal(view.undoCount, 0)
    assert.equal(view.tableau[0].length, 1)
    assert.equal(view.tableau[1].length, 1)
    assert.equal(view.message, '已撤销上一步')
    assertSavedPiles({ moves: 0, tableau: [1, 1, 0, 0, 0, 0, 0] })
    world.game.undo()
    assert.equal(world.snapshot().message, '没有可撤销的步骤')
  } finally {
    world.game.destroy()
  }
})

test('restart: same deal, counters reset (同一副牌)', function () {
  resetWorld()
  const world = create()
  try {
    const initial = savedState()
    assert.equal(initial, null, 'nothing saved before the first action')
    const seed = world.game.getState().seed
    world.game.onStockClick()
    world.game.onStockClick()
    clockMs += 4000
    runFrames(3)
    assert.equal(world.snapshot().moves, 2)
    world.game.restart()
    const view = world.snapshot()
    assert.equal(view.seed, seed)
    assert.equal(view.stock.length, 24)
    assert.equal(view.waste.length, 0)
    assert.equal(view.moves, 0)
    assert.equal(view.started, false)
    assert.equal(view.elapsedText, '00:00')
    assert.equal(view.undoCount, 0)
    const restarted = savedState()
    assert.equal(restarted.seed, seed)
    assert.equal(restarted.stock.length, 24)
  } finally {
    world.game.destroy()
  }
})

test('new game: fresh deal with a new seed (or the explicit seed)', function () {
  resetWorld()
  const world = create()
  try {
    const before = world.game.getState().seed
    world.game.newGame()
    const after = world.game.getState().seed
    assert.notEqual(after, before, 'random new game should change the seed')
    assert.equal(world.snapshot().stock.length, 24)
    assert.equal(world.snapshot().moves, 0)
    world.game.newGame(123456789)
    assert.equal(world.game.getState().seed, 123456789)
    const serialized = savedState()
    assert.equal(serialized.seed, 123456789)
    assert.equal(serialized.stock.length, 24)
  } finally {
    world.game.destroy()
  }
})

test('timer: pauses while the document is hidden and resumes without a jump', function () {
  resetWorld()
  const world = create()
  try {
    world.game.onStockClick()
    clockMs += 2000
    runFrames(3)
    assert.equal(world.snapshot().elapsedSeconds, 2)

    doc.hidden = true
    dispatch(docListeners, 'visibilitychange')
    clockMs += 60000 // one minute hidden
    runFrames(3)
    let view = world.snapshot()
    assert.equal(view.elapsedSeconds, 2, 'hidden time must not count')
    const savedWhileHidden = savedState()
    assert.equal(savedWhileHidden.elapsedMs, 2000, 'hidden pause should persist elapsed time')

    doc.hidden = false
    dispatch(docListeners, 'visibilitychange')
    world.game.onStockClick()
    clockMs += 1000
    runFrames(3)
    view = world.snapshot()
    assert.equal(view.elapsedSeconds, 3, 'resumes without a time jump')
    assert.equal(view.moves, 2)
  } finally {
    world.game.destroy()
  }
})

test('destroy: persists elapsed time, cleans listeners/observers, is idempotent', function () {
  resetWorld()
  const world = create()
  world.game.onStockClick()
  clockMs += 5000
  runFrames(3)
  world.game.destroy()
  const saved = savedState()
  assert.ok(saved)
  assert.ok(saved.elapsedMs >= 4900, 'elapsed time written on destroy, got ' + saved.elapsedMs)
  const observer = resizeObservers[resizeObservers.length - 1]
  assert.equal(observer.disconnected, true)
  assert.equal(docListeners.get('visibilitychange').length, 0)
  assert.equal(winListeners.get('resize').length, 0)
  assert.equal(rafQueue.size, 0, 'pending animation frame cancelled')
  world.game.destroy() // idempotent
  world.game.destroy()
})

test('restore: save is loaded on the next mount and the timer resumes', function () {
  resetWorld()
  let world = create()
  world.game.onStockClick()
  world.game.onStockClick()
  world.game.onStockClick()
  clockMs += 7000
  runFrames(3)
  world.game.destroy()
  const before = savedState()
  assert.ok(before)

  const revived = create()
  try {
    const view = revived.snapshot()
    assert.equal(view.stock.length, before.stock.length)
    assert.equal(view.waste.length, before.waste.length)
    assert.equal(view.moves, before.moves)
    assert.equal(view.elapsedSeconds, Math.floor(before.elapsedMs / 1000))
    assert.equal(view.started, true)
    clockMs += 2000
    runFrames(3)
    assert.ok(revived.snapshot().elapsedSeconds >= 9, 'timer resumes after restore')
  } finally {
    revived.game.destroy()
  }
})

test('corrupt save: falls back to a fresh game instead of throwing', function () {
  resetWorld()
  storage.set(api.STORE_KEY, '{not json')
  let world = create()
  let view = world.snapshot()
  assert.equal(view.stock.length, 24)
  assert.equal(view.moves, 0)
  world.game.destroy()

  storage.set(api.STORE_KEY, JSON.stringify({ schemaVersion: 99, stock: [] }))
  world = create()
  view = world.snapshot()
  assert.equal(view.stock.length, 24)
  assert.equal(view.tableau.map((column) => column.length).join(','), '1,2,3,4,5,6,7')
  world.game.destroy()
})

test('too small: reports tooSmall and no layout below 320x240', function () {
  resetWorld()
  const world = create()
  try {
    hostRect.width = 300
    hostRect.height = 220
    const observer = resizeObservers[resizeObservers.length - 1]
    observer.callback()
    runFrames(2)
    const view = world.snapshot()
    assert.equal(view.tooSmall, true)
    assert.equal(view.layout, null)
    hostRect.width = 720
    hostRect.height = 600
    observer.callback()
    runFrames(2)
    const back = world.snapshot()
    assert.equal(back.tooSmall, false)
    assert.ok(back.layout)
  } finally {
    world.game.destroy()
  }
})

test('resize + dpr: relayout on resize observer and dpr change', function () {
  resetWorld()
  const world = create()
  try {
    const first = world.snapshot().layout
    hostRect.width = 1100
    hostRect.height = 700
    const observer = resizeObservers[resizeObservers.length - 1]
    observer.callback()
    runFrames(2)
    const second = world.snapshot()
    assert.equal(second.width, 1100)
    assert.ok(second.layout.cardW > first.cardW, 'cards scale up with the stage')
    globalThis.window.devicePixelRatio = 2
    observer.callback()
    runFrames(2)
    assert.equal(world.snapshot().dpr, 2)
  } finally {
    world.game.destroy()
  }
})

test('listener errors: a throwing onState callback does not break the game', function () {
  resetWorld()
  const originalError = console.error
  const logged = []
  console.error = (...args) => logged.push(args)
  try {
    const game = api.createGame(host, {
      clock: () => clockMs,
      onState() {
        throw new Error('listener boom')
      },
      onError() {},
    })
    game.onStockClick()
    assert.equal(game.getState().stock.length, 23)
    game.destroy()
    assert.ok(logged.length >= 1, 'listener failure is logged, not thrown')
  } finally {
    console.error = originalError
  }
})

test('context free: controller never touches document.body or global keydown', function () {
  resetWorld()
  assert.equal(docListeners.has('keydown'), false)
  assert.equal(winListeners.has('keydown'), false)
  const world = create()
  try {
    assert.equal(docListeners.has('keydown'), false)
    assert.equal(winListeners.has('keydown'), false)
  } finally {
    world.game.destroy()
  }
})

/* ---------------------------------------------------------------------------
 * Drag & drop (pointer driven; click-to-select stays available)
 * ------------------------------------------------------------------------ */

function fakeCardElement(kind, col, index, pile) {
  const element = {
    dataset: { dshsolCard: '1', dshsolKind: kind },
    closest(selector) {
      return selector === '[data-dshsol-card]' ? element : null
    },
  }
  if (kind === 'tableau') {
    element.dataset.dshsolCol = String(col)
    element.dataset.dshsolIndex = String(index)
  }
  if (kind === 'foundation') element.dataset.dshsolPile = String(pile)
  return element
}

function pointerEvent(x, y, target) {
  return {
    pointerId: 7,
    button: 0,
    isPrimary: true,
    clientX: x,
    clientY: y,
    target: target || null,
    preventDefault() {},
    stopPropagation() {},
  }
}

function dragPoint(layout, kind, col, pile) {
  if (kind === 'waste') {
    return { x: layout.wasteX, y: layout.topY + layout.cardH / 2 }
  }
  if (kind === 'foundation') {
    return { x: layout.foundationX[pile], y: layout.topY + layout.cardH / 2 }
  }
  return { x: layout.colX[col], y: layout.tableauTop + layout.cardH / 2 }
}

test('drag: waste top dropped on a valid tableau column', function () {
  resetWorld()
  injectSave(rawState({ waste: [cardId(2, 4), cardId(1, 7)], tableau: [[cardId(0, 8)], []] }))
  const world = create()
  try {
    const layout = world.snapshot().layout
    const start = dragPoint(layout, 'waste')
    world.game.pointerDown(pointerEvent(start.x, start.y, fakeCardElement('waste')))
    assert.ok(world.game.getDrag(), 'drag candidate starts on pointerdown')
    assert.equal(world.game.getDrag().active, false, 'not a drag before the threshold')
    world.game.pointerMove(pointerEvent(start.x + 20, start.y + 4))
    let snap = world.snapshot()
    assert.ok(snap.drag, 'drag becomes active after the threshold')
    assert.equal(snap.drag.source.kind, 'waste')
    assert.equal(snap.drag.cards.length, 1)
    assert.equal(snap.drag.cards[0], cardId(1, 7))

    const target = dragPoint(layout, 'tableau', 0)
    world.game.pointerMove(pointerEvent(target.x, target.y))
    snap = world.snapshot()
    assert.deepEqual(snap.drag.target, { kind: 'tableau', col: 0 })
    world.game.pointerUp(pointerEvent(target.x, target.y))
    snap = world.snapshot()
    assert.equal(snap.drag, null, 'drag is cleared after drop')
    assert.equal(snap.waste.length, 1)
    assert.equal(snap.tableau[0].length, 2)
    assert.equal(snap.moves, 1)
    const saved = assertSavedPiles({ moves: 1, waste: 1, tableau: [2, 0, 0, 0, 0, 0, 0] })
    assert.equal(saved.tableau[0][1].id, cardId(1, 7))
  } finally {
    world.game.destroy()
  }
})

test('drag: a whole K-headed run dropped on an empty column', function () {
  resetWorld()
  injectSave(rawState({
    tableau: [[cardId(3, 13), cardId(1, 12), cardId(3, 11)], []],
  }))
  const world = create()
  try {
    const layout = world.snapshot().layout
    const start = { x: layout.colX[0] + layout.cardW / 2, y: layout.tableauTop + layout.colOffsets[0][0] + layout.cardH / 2 }
    world.game.pointerDown(pointerEvent(start.x, start.y, fakeCardElement('tableau', 0, 0)))
    world.game.pointerMove(pointerEvent(start.x + 10, start.y + 30))
    let snap = world.snapshot()
    assert.ok(snap.drag)
    assert.equal(snap.drag.cards.length, 3, 'whole run is dragged')
    const target = dragPoint(layout, 'tableau', 1)
    world.game.pointerMove(pointerEvent(target.x, target.y))
    snap = world.snapshot()
    assert.deepEqual(snap.drag.target, { kind: 'tableau', col: 1 })
    world.game.pointerUp(pointerEvent(target.x, target.y))
    snap = world.snapshot()
    assert.equal(snap.tableau[0].length, 0)
    assert.equal(snap.tableau[1].length, 3)
    assertSavedPiles({ moves: 1, tableau: [0, 3, 0, 0, 0, 0, 0] })
  } finally {
    world.game.destroy()
  }
})

test('drag: illegal drop returns the cards and explains the rule', function () {
  resetWorld()
  injectSave(rawState({ waste: [cardId(1, 7)], tableau: [[cardId(1, 8)], []] }))
  const world = create()
  try {
    const layout = world.snapshot().layout
    const start = dragPoint(layout, 'waste')
    world.game.pointerDown(pointerEvent(start.x, start.y, fakeCardElement('waste')))
    world.game.pointerMove(pointerEvent(start.x + 20, start.y + 4))
    const target = dragPoint(layout, 'tableau', 0) // 7♥ on 8♥: same colour
    world.game.pointerMove(pointerEvent(target.x, target.y))
    let snap = world.snapshot()
    assert.equal(snap.drag.target, null, 'illegal target is not accepted')
    world.game.pointerUp(pointerEvent(target.x, target.y))
    snap = world.snapshot()
    assert.equal(snap.waste.length, 1)
    assert.equal(snap.tableau[0].length, 1)
    assert.equal(snap.moves, 0)
    assert.ok(snap.message.length > 0, 'should explain why nothing happened')
  } finally {
    world.game.destroy()
  }
})

test('drag: dropping outside the board is a no-op', function () {
  resetWorld()
  injectSave(rawState({ waste: [cardId(1, 7)], tableau: [[cardId(0, 8)]] }))
  const world = create()
  try {
    const layout = world.snapshot().layout
    const start = dragPoint(layout, 'waste')
    world.game.pointerDown(pointerEvent(start.x, start.y, fakeCardElement('waste')))
    world.game.pointerMove(pointerEvent(start.x + 20, start.y + 4))
    world.game.pointerMove(pointerEvent(5000, 5000))
    world.game.pointerUp(pointerEvent(5000, 5000))
    const snap = world.snapshot()
    assert.equal(snap.drag, null)
    assert.equal(snap.moves, 0)
    assertSavedPiles({ moves: 0, waste: 1 })
  } finally {
    world.game.destroy()
  }
})

test('drag: foundation top can be dragged back to the tableau', function () {
  resetWorld()
  injectSave(rawState({ foundations: { 0: [cardId(0, 1)] }, tableau: [[cardId(1, 2)]] }))
  const world = create()
  try {
    const layout = world.snapshot().layout
    const start = dragPoint(layout, 'foundation', 0, 0)
    world.game.pointerDown(pointerEvent(start.x, start.y, fakeCardElement('foundation', -1, -1, 0)))
    world.game.pointerMove(pointerEvent(start.x + 15, start.y + 10))
    const target = dragPoint(layout, 'tableau', 0)
    world.game.pointerMove(pointerEvent(target.x, target.y))
    world.game.pointerUp(pointerEvent(target.x, target.y))
    const snap = world.snapshot()
    assert.equal(snap.foundations[0].length, 0)
    assert.equal(snap.tableau[0].length, 2)
    assertSavedPiles({ moves: 1, foundations: [0, 0, 0, 0], tableau: [2, 0, 0, 0, 0, 0, 0] })
  } finally {
    world.game.destroy()
  }
})

test('drag: below the threshold behaves like a click (no drag, no mutation)', function () {
  resetWorld()
  injectSave(rawState({ waste: [cardId(1, 7)], tableau: [[cardId(0, 8)]] }))
  const world = create()
  try {
    const layout = world.snapshot().layout
    const start = dragPoint(layout, 'waste')
    world.game.pointerDown(pointerEvent(start.x, start.y, fakeCardElement('waste')))
    world.game.pointerMove(pointerEvent(start.x + 2, start.y + 2))
    world.game.pointerUp(pointerEvent(start.x + 2, start.y + 2))
    assert.equal(world.game.getDrag(), null)
    let snap = world.snapshot()
    assert.equal(snap.moves, 0)
    assert.equal(snap.waste.length, 1)
    // The click handlers still work independently (this is what React calls).
    world.game.onWasteClick()
    snap = world.snapshot()
    assert.equal(snap.selection && snap.selection.kind, 'waste')
  } finally {
    world.game.destroy()
  }
})

test('drag: pointer cancel clears the drag without changing the game', function () {
  resetWorld()
  injectSave(rawState({ waste: [cardId(1, 7)], tableau: [[cardId(0, 8)]] }))
  const world = create()
  try {
    const layout = world.snapshot().layout
    const start = dragPoint(layout, 'waste')
    world.game.pointerDown(pointerEvent(start.x, start.y, fakeCardElement('waste')))
    world.game.pointerMove(pointerEvent(start.x + 20, start.y + 4))
    assert.ok(world.game.getDrag().active)
    world.game.pointerCancel(pointerEvent(start.x + 20, start.y + 4))
    const snap = world.snapshot()
    assert.equal(snap.drag, null)
    assert.equal(snap.moves, 0)
    assertSavedPiles({ moves: 0, waste: 1 })
  } finally {
    world.game.destroy()
  }
})

test('drag: a face-down card cannot start a drag', function () {
  resetWorld()
  injectSave(rawState({
    tableau: [[{ id: cardId(2, 5), up: false }, cardId(1, 7)], [cardId(0, 8)]],
  }))
  const world = create()
  try {
    const layout = world.snapshot().layout
    const start = { x: layout.colX[0] + layout.cardW / 2, y: layout.tableauTop + layout.cardH / 2 }
    world.game.pointerDown(pointerEvent(start.x, start.y, fakeCardElement('tableau', 0, 0)))
    assert.equal(world.game.getDrag(), null)
    world.game.pointerMove(pointerEvent(start.x + 20, start.y + 10))
    world.game.pointerUp(pointerEvent(start.x + 20, start.y + 10))
    const snap = world.snapshot()
    assert.equal(snap.moves, 0)
    assertSavedPiles({ moves: 0, tableau: [2, 1, 0, 0, 0, 0, 0] })
  } finally {
    world.game.destroy()
  }
})

/* ---------------------------------------------------------------------------
 * Summary
 * ------------------------------------------------------------------------ */

console.log('')
console.log('passed: ' + passed + ', failed: ' + failed)
if (failed > 0) process.exit(1)
