/**
 * lifecycle.mjs — headless lifecycle + registration audit for the solitaire client.
 *
 * Run (repo root): node packages/dsh-game-solitaire/dev/audit/lifecycle.mjs
 * Read-only. Exit 0 = all lifecycle requirements hold.
 *
 * Covers (contract §1/§3/§4/§5/§6/§8 + task 009 acceptance):
 *   - module registration: factory + apply -> exactly one slots.inject('game.stage')
 *     and one slots.register; id/label/select shape; stable frozen matched object.
 *   - createGame mount: layout, no throw, too-small hint, ResizeObserver, dpr tracking.
 *   - timer/moves display: elapsedText/elapsedSeconds advance with the clock.
 *   - document.hidden pause: no time jump after returning; rAF not scheduled while hidden.
 *   - save on unload: destroy() persists the exact state; destroy is idempotent;
 *     a fresh createGame reloads moves/elapsed/piles.
 *   - restart (same deal) vs newGame (new deal).
 *   - win stops the timer; corrupt save falls back to a new game without throwing.
 *   - no global keydown listener; only window resize + document visibilitychange;
 *     no document.body usage; no document.title writes.
 */
import assert from 'node:assert/strict'
import * as ref from './reference-solitaire.mjs'
import {
  seam, env, resetEnv, instantiateClientModule, applyClientModule, makeHost,
  clientPilesToCanonical, canonicalToClientPiles, listenerTypes, countListeners,
  advanceClock, SUIT_ORDER,
} from './harness.mjs'

const STORE_KEY = seam.STORE_KEY
let passed = 0
const failures = []
let currentGame = null
let latestView = null

function test(name, fn) {
  resetEnv()
  latestView = null
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    failures.push({ name, error })
    console.log('not ok - ' + name)
    console.log(error && error.stack ? error.stack : error)
  } finally {
    if (currentGame) {
      try {
        currentGame.destroy()
      } catch (error) {
        failures.push({ name: name + ' (cleanup)', error })
      }
      currentGame = null
    }
  }
}

function mount(rect) {
  const host = makeHost(rect)
  currentGame = seam.createGame(host, {
    onState(view) {
      latestView = view
    },
  })
  return { game: currentGame, host }
}

function fireWindow(type) {
  const listeners = env.windowListeners.get(type)
  if (listeners) for (const listener of [...listeners]) listener({ type })
}

function fireDocument(type) {
  const listeners = env.documentListeners.get(type)
  if (listeners) for (const listener of [...listeners]) listener({ type })
}

/** Run every pending rAF callback once (the client reschedules itself only if it should). */
function flushRaf(limit = 100) {
  let guard = 0
  while (env.rafQueue.size && guard < limit) {
    guard += 1
    const entry = [...env.rafQueue.entries()].shift()
    env.rafQueue.delete(entry[0])
    entry[1](env.clockMs)
  }
  return guard
}

function fireResize() {
  fireWindow('resize')
  if (env.observers.length) env.observers[env.observers.length - 1].trigger()
  // the client defers relayout by one animation frame (ResizeObserver loop safety)
  flushRaf()
}

function refFromClient(state) {
  return ref.importPiles(clientPilesToCanonical(state))
}

function assertPilesEqual(clientState, canonical, label) {
  const diffs = ref.diffPiles(canonical, clientPilesToCanonical(clientState))
  assert.equal(diffs, null, `${label}: ${JSON.stringify(diffs)}`)
}

/* ------------------------------------------------------------------ *
 * 1. module registration (dynamic, not a regex)
 * ------------------------------------------------------------------ */
test('registration: one game.stage inject + one register with correct shape', () => {
  resetEnv()
  const { definition, module } = instantiateClientModule()
  assert.equal(definition.id, '@local/dsh-game-solitaire', 'loader id must equal package name')
  const records = applyClientModule(module)
  assert.deepEqual(records.injects, ['game.stage'])
  assert.equal(records.registers.length, 1)
  assert.equal(records.provides.length, 0, 'must not provide services')
  const { definition: slot, component } = records.registers[0]
  assert.equal(slot.name, 'game.stage')
  assert.equal(slot.id, 'solitaire')
  assert.equal(typeof slot.label, 'function')
  assert.equal(slot.label(), '接龙')
  assert.equal(typeof slot.select, 'function')
  assert.equal(typeof component, 'function')
  const matched = slot.select({ gameId: 'solitaire' })
  assert.ok(matched && typeof matched === 'object')
  assert.ok(Object.isFrozen(matched), 'matched payload should be frozen/stable')
  assert.equal(slot.select({ gameId: 'solitaire' }), matched, 'same matched object on repeat select')
  assert.equal(slot.select({ gameId: 'other' }), null)
  assert.equal(slot.select({}), null)
  assert.equal(slot.select(null), null)
  assert.equal(definition.factory.length, 1, 'factory(require) signature')
})

/* ------------------------------------------------------------------ *
 * 2. mount + layout + too-small + dpr
 * ------------------------------------------------------------------ */
test('mount: layout at 1024x700, 00:00 timer, 0 moves, no error', () => {
  const { game, host } = mount()
  assert.ok(env.observers.length >= 1, 'ResizeObserver should be used')
  assert.ok(env.observers[0].targets.includes(host), 'observer must observe its own host')
  const state = game.getState()
  assert.equal(state.moves, 0)
  assert.equal(state.started, false)
  assert.equal(state.elapsedMs, 0)
  const view = game.snapshot()
  assert.equal(view.tooSmall, false)
  assert.ok(view.layout, 'layout must exist at 1024x700')
  assert.equal(view.elapsedText, '00:00')
  assert.equal(view.moves, 0)
  assert.equal(view.won, false)
  assert.equal(view.undoCount, 0)
  assert.equal(view.stock.length + view.waste.length + view.foundations.flat().length + view.tableau.flat().length, 52)
})

test('layout: null below 320x240; responsive numbers; observer-driven relayout', () => {
  assert.equal(seam.computeLayout(300, 200, []), null)
  assert.equal(seam.computeLayout(319, 700, []), null)
  assert.equal(seam.computeLayout(1024, 239, []), null)
  for (const [w, h] of [[320, 240], [480, 360], [720, 600], [1024, 700], [1600, 1000], [2560, 1440]]) {
    for (let trial = 0; trial < 5; trial += 1) {
      const tableau = Array.from({ length: 7 }, () => [])
      const layout = seam.computeLayout(w, h, tableau)
      assert.ok(layout, `layout null at ${w}x${h}`)
      for (const key of ['width', 'height', 'margin', 'colGap', 'cardW', 'cardH', 'cardRadius', 'offsetX', 'topY', 'tableauTop', 'tableauH', 'stockX', 'wasteX', 'foundationGap']) {
        assert.ok(Number.isFinite(layout[key]), `${key} not finite at ${w}x${h}: ${layout[key]}`)
      }
      assert.ok(layout.cardW > 0 && layout.cardH > layout.cardW)
      for (let col = 1; col < 7; col += 1) assert.ok(layout.colX[col] > layout.colX[col - 1], 'colX must increase')
      assert.ok(layout.colX[0] >= 0 && layout.colX[6] + layout.cardW <= w + 0.001, 'columns stay in width')
      assert.ok(layout.foundationX[3] + layout.cardW <= w + 0.001 && layout.foundationX[0] >= 0, 'foundations stay in width')
      assert.equal(layout.colOffsets.length, 7)
    }
  }
  // deep column shrinks fan offsets to fit the tableau height
  const longColumn = Array.from({ length: 30 }, (_, i) => ({ id: i, up: true }))
  const tableau = [longColumn, [], [], [], [], [], []]
  const smallLayout = seam.computeLayout(360, 520, tableau)
  assert.ok(smallLayout, 'layout at 360x520')
  const lastY = smallLayout.colOffsets[0][smallLayout.colOffsets[0].length - 1]
  assert.ok(lastY + smallLayout.cardH <= smallLayout.height, `fan overflows: ${lastY + smallLayout.cardH} > ${smallLayout.height}`)
  assert.equal(smallLayout.colOffsets[0].length, 30)

  const rect = { width: 300, height: 200 }
  const { game } = mount(rect)
  assert.equal(game.snapshot().tooSmall, true)
  assert.equal(game.snapshot().layout, null)
  rect.width = 900
  rect.height = 640
  fireResize()
  assert.equal(game.snapshot().tooSmall, false)
  assert.ok(game.snapshot().layout)
  env.devicePixelRatio = 3
  fireResize()
  assert.equal(game.snapshot().dpr, 3, 'dpr changes must be observed')
  env.devicePixelRatio = 2
})

/* ------------------------------------------------------------------ *
 * 3. timer / moves display, draw, undo
 * ------------------------------------------------------------------ */
test('timer+moves: draw starts the clock; elapsedText advances', () => {
  const { game } = mount()
  game.drawFromStock()
  let state = game.getState()
  assert.equal(state.moves, 1)
  assert.equal(state.started, true)
  assert.equal(state.stock.length, 23)
  assert.equal(state.waste.length, 1)
  assert.equal(game.snapshot().moves, 1)
  assert.ok(env.rafQueue.size >= 1, 'a frame must be scheduled once the game starts')
  flushRaf()
  assert.equal(game.snapshot().elapsedSeconds, 0)
  advanceClock(4200)
  assert.ok(env.rafQueue.size >= 1, 'tick must reschedule itself')
  flushRaf()
  const view = game.snapshot()
  assert.equal(view.elapsedSeconds, 4)
  assert.equal(view.elapsedText, '00:04')
  assert.equal(view.moves, 1)
  // undo restores the pre-draw state and the counter
  game.undo()
  state = game.getState()
  assert.equal(state.moves, 0)
  assert.equal(state.stock.length, 24)
  assert.equal(state.waste.length, 0)
  assert.equal(game.snapshot().undoCount, 0)
  assert.equal(game.snapshot().moves, 0)
})

test('undo: click-move then undo restores piles exactly', () => {
  const { game } = mount()
  game.newGame(4242)
  const initial = clientPilesToCanonical(game.getState())
  // find one legal waste->tableau/foundation move by scanning the dealt state
  game.drawFromStock()
  const state = game.getState()
  game.onWasteClick()
  assert.equal(game.getSelection().kind, 'waste')
  let applied = false
  for (let col = 0; col < 7; col += 1) {
    if (!applied && seam.canDrop(state, { kind: 'waste' }, { kind: 'tableau', col }).ok) {
      game.onColumnClick(col)
      applied = true
    }
  }
  if (!applied) {
    for (let pile = 0; pile < 4; pile += 1) {
      if (!applied && seam.canDrop(state, { kind: 'waste' }, { kind: 'foundation', pile }).ok) {
        game.onFoundationClick(pile)
        applied = true
      }
    }
  }
  if (applied) {
    assert.equal(game.getState().moves, 2)
    game.undo()
    assert.equal(game.getState().moves, 1)
  }
  game.undo()
  assertPilesEqual(game.getState(), initial, 'undo back to the deal')
  assert.equal(game.getState().moves, 0)
})

/* ------------------------------------------------------------------ *
 * 4. visibility pause: no time jump
 * ------------------------------------------------------------------ */
test('document.hidden pauses the timer; returning does not jump forward', () => {
  const { game } = mount()
  game.drawFromStock()
  advanceClock(4200)
  flushRaf()
  assert.equal(game.snapshot().elapsedSeconds, 4)
  // the live view is authoritative while running; pausing settles it into state
  assert.equal(game.getState().elapsedMs, 0, 'state.elapsedMs settles only on pause/persist')

  env.documentHidden = true
  fireDocument('visibilitychange')
  assert.equal(game.getState().elapsedMs, 4200, 'pausing settles elapsed without losing it')
  advanceClock(60000)
  flushRaf() // hidden: nothing scheduled; must not accumulate 60s of play time
  assert.equal(game.getState().elapsedMs, 4200)
  assert.equal(game.snapshot().elapsedSeconds, 4)

  env.documentHidden = false
  fireDocument('visibilitychange')
  assert.equal(game.snapshot().elapsedSeconds, 4, 'unhide must resume, not jump')
  advanceClock(2600)
  flushRaf()
  assert.equal(game.snapshot().elapsedSeconds, 6, 'only post-resume time accrues (4s + 2.6s)')
  assert.ok(env.rafQueue.size >= 1)
})

/* ------------------------------------------------------------------ *
 * 5. destroy: persist + idempotent cleanup + reload
 * ------------------------------------------------------------------ */
test('destroy persists exactly, cleans listeners/observer/timers, is idempotent', () => {
  const { game } = mount()
  game.drawFromStock()
  advanceClock(3000)
  flushRaf()
  assert.ok(countListeners(env.windowListeners) >= 1)
  assert.ok(countListeners(env.documentListeners) >= 1)
  const observer = env.observers[env.observers.length - 1]
  const state = game.getState()
  game.destroy()
  currentGame = null
  assert.equal(countListeners(env.windowListeners), 0, 'window listeners must be removed')
  assert.equal(countListeners(env.documentListeners), 0, 'document listeners must be removed')
  assert.equal(observer.disconnected, true, 'ResizeObserver must be disconnected')
  assert.equal(env.rafQueue.size, 0, 'pending rAF must be cancelled')
  const saved = env.storage.get(STORE_KEY)
  assert.ok(saved, 'destroy must persist the game')
  const savedObject = JSON.parse(saved)
  assert.equal(savedObject.schemaVersion, 1)
  assert.equal(savedObject.moves, 1)
  assert.ok(savedObject.elapsedMs >= 3000)
  // saved piles equal the in-memory state (after the timer settle in destroy)
  const savedDecoded = {
    stock: savedObject.stock,
    waste: savedObject.waste,
    foundations: savedObject.foundations,
    tableau: seam.decodeTableau(savedObject.tableau),
  }
  const savedCanonical = clientPilesToCanonical(savedDecoded)
  assertPilesEqual(state, savedCanonical, 'saved state equals live state')
  // idempotent second destroy: no throw, no duplicate writes
  const before = env.storage.get(STORE_KEY)
  game.destroy()
  assert.equal(env.storage.get(STORE_KEY), before)
  assert.equal(countListeners(env.windowListeners), 0)
  assert.equal(countListeners(env.documentListeners), 0)
  // methods after destroy must be inert
  game.drawFromStock()
  game.undo()
  game.newGame(1)
  assert.equal(env.storage.get(STORE_KEY), before, 'post-destroy calls must not write')
})

test('reload: createGame restores moves, elapsed and piles from localStorage', () => {
  const { game, host } = mount()
  game.newGame(31337)
  game.drawFromStock()
  game.drawFromStock()
  advanceClock(5000)
  flushRaf()
  const beforePiles = clientPilesToCanonical(game.getState())
  const beforeState = game.getState()
  const beforeMoves = beforeState.moves
  const beforeSeconds = game.snapshot().elapsedSeconds
  assert.equal(beforeSeconds, 5)
  game.destroy()
  currentGame = null

  currentGame = seam.createGame(host, { onState(view) { latestView = view } })
  const reloaded = currentGame.getState()
  assert.equal(reloaded.moves, beforeMoves)
  assert.equal(reloaded.seed, 31337)
  assert.ok(Math.abs(reloaded.elapsedMs - beforeSeconds * 1000) <= 1000, `elapsed ${reloaded.elapsedMs} vs ~${beforeSeconds * 1000}`)
  assertPilesEqual(reloaded, beforePiles, 'reloaded piles')
  assert.equal(currentGame.snapshot().moves, beforeMoves)
  assert.equal(currentGame.snapshot().won, false)
})

/* ------------------------------------------------------------------ *
 * 6. restart (same deal) / new game (new deal)
 * ------------------------------------------------------------------ */
test('restart replays the same deal; newGame deals a different one', () => {
  const { game } = mount()
  game.newGame(777001)
  const deal777 = clientPilesToCanonical(seam.emptyState(777001))
  assertPilesEqual(game.getState(), deal777, 'newGame uses the requested seed')
  game.drawFromStock()
  game.drawFromStock()
  game.drawFromStock()
  assert.equal(game.getState().moves, 3)
  game.restart()
  const state = game.getState()
  assertPilesEqual(state, deal777, 'restart replays the same deal')
  assert.equal(state.moves, 0)
  assert.equal(state.elapsedMs, 0)
  assert.equal(state.undo.length, 0)
  assert.equal(state.started, false)
  assert.equal(state.seed, 777001)
  game.newGame(777002)
  const deal777002 = clientPilesToCanonical(seam.emptyState(777002))
  assertPilesEqual(game.getState(), deal777002, 'newGame deals a new seed')
  assert.equal(game.getState().seed, 777002)
  assert.notDeepEqual(deal777, deal777002)
})

/* ------------------------------------------------------------------ *
 * 7. undo depth (>= 20 required) + documented constants
 * ------------------------------------------------------------------ */
test('constants: save key, schema, undo depth, minimum stage size', () => {
  assert.equal(seam.GAME_ID, 'solitaire')
  assert.equal(seam.STORE_KEY, 'dsh.game.solitaire.v1')
  assert.equal(seam.SCHEMA_VERSION, 1)
  assert.ok(seam.MAX_UNDO_KEEP >= 20, `MAX_UNDO_KEEP ${seam.MAX_UNDO_KEEP} must be >= 20`)
  assert.ok(seam.SAVE_UNDO >= 20, `SAVE_UNDO ${seam.SAVE_UNDO} must persist >= 20 steps`)
  assert.equal(seam.MIN_WIDTH, 320)
  assert.equal(seam.MIN_HEIGHT, 240)
})

test('undo stack: 25 consecutive undos walk back to the deal (>= 20 steps)', () => {
  const { game } = mount()
  game.newGame(90909)
  const deal = clientPilesToCanonical(game.getState())
  for (let i = 0; i < 25; i += 1) game.drawFromStock()
  assert.equal(game.getState().moves, 25)
  assert.equal(game.getState().undo.length, 25)
  assert.equal(game.snapshot().undoCount, 25)
  for (let i = 0; i < 25; i += 1) {
    const before = game.getState().moves
    game.undo()
    assert.equal(game.getState().moves, before - 1, `undo ${i} must step back one move`)
  }
  assert.equal(game.getState().undo.length, 0)
  assertPilesEqual(game.getState(), deal, '25 undos restore the original deal')
  assert.equal(game.snapshot().moves, 0)
})

/* ------------------------------------------------------------------ *
 * 8. double-click path (UI handler -> foundation)
 * ------------------------------------------------------------------ */
test('double-click: waste top goes to its foundation and wins', () => {
  env.storage.set(STORE_KEY, nearWinSave())
  const { game } = mount()
  game.onDoubleClick({ kind: 'waste' })
  const view = game.snapshot()
  assert.equal(view.won, true, 'double-click KC must complete the win')
  assert.equal(view.moves, 124)
  assert.equal(game.getState().foundations[3].length, 13)
  assert.equal(game.getState().waste.length, 0)
})

test('double-click: tableau top goes to its foundation', () => {
  const stock = []
  for (const suit of ref.SUITS) {
    for (let rank = 1; rank <= 13; rank += 1) {
      const code = ref.RANK_LABELS[rank] + suit
      if (code !== 'AS') stock.push(code)
    }
  }
  const canonical = {
    stock,
    waste: [],
    tableau: [['AS'], [], [], [], [], [], []],
    foundations: { S: [], H: [], D: [], C: [] },
    moves: 0,
    won: false,
  }
  const clientPiles = canonicalToClientPiles(canonical)
  const state = Object.assign({ seed: 5, started: false, won: false, moves: 0, elapsedMs: 0, undo: [] }, clientPiles)
  env.storage.set(STORE_KEY, JSON.stringify(seam.serializeState(state)))
  const { game } = mount()
  assert.equal(game.getState().tableau[0].length, 1)
  game.onDoubleClick({ kind: 'tableau', col: 0, index: 0 })
  const after = game.getState()
  assert.equal(after.moves, 1)
  assert.deepEqual(after.foundations[0], [0], 'AS (id 0) must land on the spade foundation')
  assert.equal(after.tableau[0].length, 0)
})

/* ------------------------------------------------------------------ *
 * 9. win stops the timer (loaded near-win save) + corrupt save fallback
 * ------------------------------------------------------------------ */
function nearWinSave() {
  const foundations = { S: [], H: [], D: [], C: [] }
  for (const suit of ref.SUITS) {
    const count = suit === 'C' ? 12 : 13
    for (let rank = 1; rank <= count; rank += 1) foundations[suit].push(ref.RANK_LABELS[rank] + suit)
  }
  const canonical = { stock: [], waste: ['KC'], tableau: [[], [], [], [], [], [], []], foundations, moves: 123, won: false }
  const clientPiles = canonicalToClientPiles(canonical)
  const state = Object.assign({
    seed: 424242,
    started: true,
    won: false,
    moves: 123,
    elapsedMs: 4200,
    undo: [],
  }, clientPiles)
  return JSON.stringify(seam.serializeState(state))
}

test('win: last foundation card sets won and stops the timer', () => {
  env.storage.set(STORE_KEY, nearWinSave())
  const { game } = mount()
  let view = game.snapshot()
  assert.equal(view.moves, 123)
  assert.equal(view.won, false)
  assert.equal(view.elapsedText, '00:04')
  game.onWasteClick()
  assert.equal(game.getSelection().kind, 'waste')
  game.onFoundationClick(3) // KC -> club foundation
  view = game.snapshot()
  assert.equal(view.won, true)
  assert.equal(view.moves, 124)
  assert.equal(game.getState().won, true)
  // no frame is rescheduled after a win; elapsed text freezes
  flushRaf()
  assert.equal(env.rafQueue.size, 0, 'timer must stop after winning')
  const frozenElapsed = game.getState().elapsedMs
  advanceClock(30000)
  flushRaf()
  assert.equal(game.getState().elapsedMs, frozenElapsed, 'elapsed must not advance after winning')
  assert.equal(game.snapshot().won, true)
})

test('corrupt save: createGame starts a fresh valid deal without throwing', () => {
  const garbage = [
    '{not json',
    'null',
    JSON.stringify({ schemaVersion: 1, seed: 1 }),
    JSON.stringify({ schemaVersion: 2, seed: 1, moves: 0 }),
  ]
  for (const raw of garbage) {
    resetEnv()
    env.storage.set(STORE_KEY, raw)
    let game = null
    try {
      game = seam.createGame(makeHost(), {})
    } catch (error) {
      throw new Error('createGame threw on corrupt save: ' + error.message)
    }
    const state = game.getState()
    const oracle = refFromClient(state)
    assert.deepEqual(ref.validateState(oracle), [], 'fresh state must be rules-valid')
    assert.equal(state.moves, 0)
    game.destroy()
    currentGame = null
  }
})

/* ------------------------------------------------------------------ *
 * 8. listener / DOM hygiene
 * ------------------------------------------------------------------ */
test('no global keyboard listeners; only resize + visibilitychange; no document.body use', () => {
  const { game } = mount()
  game.drawFromStock()
  const windowTypes = listenerTypes(env.windowListeners)
  const documentTypes = listenerTypes(env.documentListeners)
  for (const type of ['keydown', 'keyup', 'keypress']) {
    assert.ok(!windowTypes.includes(type), 'window must not listen to ' + type)
    assert.ok(!documentTypes.includes(type), 'document must not listen to ' + type)
  }
  assert.deepEqual([...windowTypes].sort(), ['resize'])
  assert.deepEqual([...documentTypes].sort(), ['visibilitychange'])
  assert.equal(env.bodyTouches, 0, 'document.body must never be touched')
  assert.deepEqual(
    [...env.createElementCalls].filter((tag) => tag === 'body' || tag === 'html'),
    [],
    'must not create body/html elements',
  )
})

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */
console.log(`\nlifecycle: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.error('LIFECYCLE FAILED')
  process.exit(1)
}
console.log('LIFECYCLE OK')
