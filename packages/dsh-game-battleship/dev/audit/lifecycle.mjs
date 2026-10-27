/**
 * lifecycle.mjs — headless lifecycle + registration audit for the Battleship client.
 *
 * Run (repo root): node packages/dsh-game-battleship/dev/audit/lifecycle.mjs
 * Read-only. Exit 0 = all lifecycle requirements hold.
 *
 * Covers (contract §1/§3/§4/§5/§6/§8 + task 1 acceptance):
 *   - module registration: factory + apply -> exactly one slots.inject('game.stage')
 *     and one slots.register; id/label/select shape; frozen stable matched.
 *   - constants: game id / save key / schema / min size / ship roster.
 *   - createGame mount: emits a view, ResizeObserver on the host, too-small hint,
 *     resize + devicePixelRatio tracking (rAF-deferred measure).
 *   - placement: clickCell place, rotate, randomize, undo, illegal rejection,
 *     persistence after every action.
 *   - battle: click fire, delayed AI turn via setTimeout (520ms) that never
 *     repeats a cell, message toast timeout, sunk/win status text.
 *   - destroy: persists the exact state, removes window/document listeners,
 *     disconnects ResizeObserver, cancels timers/rAF, is idempotent; a remount
 *     restores place-phase ships and a full mid-battle state/turn.
 *   - document.hidden: AI turn paused while hidden (no move until visible again).
 *   - corrupt save -> fresh valid place-phase game without throwing.
 *   - hygiene: only window resize + document visibilitychange; no global
 *     keydown/keyup/keypress; no document.body touches; no body/html elements.
 */
import assert from 'node:assert/strict'
import * as ref from './reference-battleship.mjs'
import {
  seam, env, resetEnv, instantiateClientModule, applyClientModule, makeHost,
  listenerTypes, countListeners, advanceClock, fireWindow, fireDocument,
  runTimers, flushRaf,
} from './harness.mjs'

const STORE_KEY = seam.STORE_KEY
const AI_DELAY = 520
const MESSAGE_DELAY = 2600
let passed = 0
const failures = []
let currentGame = null

function test(name, fn) {
  resetEnv()
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

function mount(rect, options) {
  const host = makeHost(rect)
  currentGame = seam.createGame(host, options || {})
  return { game: currentGame, host }
}

function placeRandomFleet(game) {
  game.randomize()
  assert.equal(game.getState().playerShips.length, 5)
  assert.equal(game.getState().phase, 'place')
}

/** Get to battle with a fresh (or restored) controller: randomize + start. */
function enterBattle(game) {
  placeRandomFleet(game)
  game.start()
  assert.equal(game.getState().phase, 'battle')
  assert.equal(game.getState().turn, 'player')
}

function flushMeasure() {
  flushRaf()
  if (env.observers.length) env.observers[env.observers.length - 1].trigger()
  flushRaf()
}

/* ------------------------------------------------------------------ *
 * 1. module registration (dynamic, not a regex)
 * ------------------------------------------------------------------ */
test('registration: one game.stage inject + one register with correct shape', () => {
  const { definition, module } = instantiateClientModule()
  assert.equal(definition.id, '@local/dsh-game-battleship', 'loader id must equal package name')
  const records = applyClientModule(module)
  assert.deepEqual(records.injects, ['game.stage'])
  assert.equal(records.registers.length, 1)
  assert.equal(records.provides.length, 0, 'must not provide services')
  const { definition: slot, component } = records.registers[0]
  assert.equal(slot.name, 'game.stage')
  assert.equal(slot.id, 'battleship')
  assert.equal(typeof slot.label, 'function')
  assert.equal(slot.label(), '海战棋')
  assert.equal(typeof slot.select, 'function')
  assert.equal(typeof component, 'function')
  const matched = slot.select({ gameId: 'battleship' })
  assert.ok(matched && typeof matched === 'object')
  assert.ok(Object.isFrozen(matched), 'matched payload should be frozen/stable')
  assert.equal(slot.select({ gameId: 'battleship' }), matched, 'same matched object on repeat select')
  assert.equal(slot.select({ gameId: 'other' }), null)
  assert.equal(slot.select({}), null)
  assert.equal(slot.select(null), null)
  assert.equal(slot.select(undefined), null)
  assert.equal(definition.factory.length, 1, 'factory(require) signature')
  assert.equal(env.consoleErrors.length, 0, 'registration must not log errors')
})

test('constants: game id, save key, schema, min size, ship roster', () => {
  assert.equal(seam.GAME_ID, 'battleship')
  assert.equal(seam.STORE_KEY, 'dsh.game.battleship.v1')
  assert.equal(seam.SCHEMA_VERSION, 1)
  assert.equal(seam.MIN_WIDTH, 320)
  assert.equal(seam.MIN_HEIGHT, 240)
  assert.deepEqual(seam.SHIPS.map((ship) => ship.len), [5, 4, 3, 3, 2])
  assert.deepEqual(seam.SHIPS.map((ship) => ship.key), ['carrier', 'battleship', 'cruiser', 'submarine', 'destroyer'])
})

/* ------------------------------------------------------------------ *
 * 2. mount + layout + too-small + resize/dpr
 * ------------------------------------------------------------------ */
test('mount: emits a place-phase view, observes host, persists a fresh game', () => {
  const rect = { width: 1024, height: 700 }
  const views = []
  const { game } = mount(rect, { onState: (view) => views.push(view) })
  assert.ok(views.length >= 1, 'createGame must emit at least one view')
  assert.ok(env.observers.length >= 1, 'ResizeObserver should be used')
  assert.ok(env.observers[0].targets.includes(env.observers[0].targets[0]), 'observer has a target')
  const view = game.getView()
  assert.equal(view.phase, 'place')
  assert.equal(view.turn, 'player')
  assert.equal(view.tooSmall, false)
  assert.equal(view.placedCount, 0)
  assert.equal(view.totalShips, 5)
  assert.equal(view.playerCells.length, 100)
  assert.equal(view.enemyCells.length, 100)
  assert.equal(view.canFire, false)
  assert.equal(view.canStart, false)
  assert.equal(game.getState().phase, 'place')
  assert.ok(env.storage.has(STORE_KEY), 'fresh game must be persisted immediately')
  assert.equal(env.consoleErrors.length, 0)
})

test('layout: too-small hint under 320x240; resize and dpr are observed', () => {
  assert.equal(seam.computeLayout(300, 200).tooSmall, true)
  assert.equal(seam.computeLayout(319, 700).tooSmall, true)
  assert.equal(seam.computeLayout(1024, 239).tooSmall, true)
  assert.equal(seam.computeLayout(320, 240).tooSmall, true, '320x240 is still below the 90px board minimum')
  assert.equal(seam.computeLayout(720, 600).tooSmall, false)
  const layout = seam.computeLayout(1024, 700)
  for (const key of ['width', 'height', 'boardPx', 'cellPx']) assert.ok(Number.isFinite(layout[key]), key + ' must be finite')
  assert.ok(layout.boardPx > 0 && layout.cellPx * 10 === layout.boardPx)
  assert.equal(seam.computeLayout(NaN, 700).tooSmall, true)

  const rect = { width: 300, height: 220 }
  const { game } = mount(rect)
  assert.equal(game.getView().tooSmall, true)
  assert.match(game.getView().statusText, /窗口太小/)
  rect.width = 900
  rect.height = 680
  fireWindow('resize')
  flushMeasure()
  assert.equal(game.getView().tooSmall, false)
  env.devicePixelRatio = 3
  fireWindow('resize')
  flushMeasure()
  assert.equal(game.getView().dpr, 3, 'dpr changes must be observed')
  assert.equal(env.consoleErrors.length, 0)
})

/* ------------------------------------------------------------------ *
 * 3. placement via the controller
 * ------------------------------------------------------------------ */
test('placement: click places, illegal is refused, rotate/randomize/undo work', () => {
  const { game } = mount()
  game.clickCell(0) // carrier horizontal at 0 -> 0..4
  let state = game.getState()
  assert.equal(state.playerShips.length, 1)
  assert.deepEqual(state.playerShips[0], { key: 'carrier', cells: [0, 1, 2, 3, 4] })
  assert.equal(game.getView().placedCount, 1)
  assert.ok(env.storage.has(STORE_KEY))
  const savedAfterPlace = JSON.parse(env.storage.get(STORE_KEY))
  assert.equal(savedAfterPlace.playerShips.length, 1)

  // illegal placement is refused with a readable message and no mutation
  const beforeShots = JSON.stringify(game.getState().playerShips)
  game.clickCell(10) // row 1 is adjacent to the carrier
  assert.equal(JSON.stringify(game.getState().playerShips), beforeShots)
  assert.ok(game.getView().message.length > 0, 'illegal placement must show a message')

  game.rotate()
  assert.equal(game.getState().orientation, 'v')
  game.clickCell(23) // battleship vertical at 23 -> 23,33,43,53 (not adjacent to row 0)
  assert.equal(game.getState().playerShips.length, 2)
  game.undoPlacement()
  assert.equal(game.getState().playerShips.length, 1)
  game.randomize()
  state = game.getState()
  assert.equal(state.playerShips.length, 5)
  assert.deepEqual(ref.validateFleet(state.playerShips, state.allowAdjacent), [])
  assert.equal(game.getView().canStart, true)
  const saved = JSON.parse(env.storage.get(STORE_KEY))
  assert.equal(saved.playerShips.length, 5, 'every action persists')
  assert.equal(env.consoleErrors.length, 0)
})

/* ------------------------------------------------------------------ *
 * 4. battle: player fire + delayed AI turn
 * ------------------------------------------------------------------ */
test('battle: player fires first, AI replies after the 520ms delay and never repeats', () => {
  const { game } = mount()
  enterBattle(game)
  const state = game.getState()
  const enemyShips = state.enemyShips
  const enemyShipCells = new Set(enemyShips.flatMap((ship) => ship.cells))
  const water = []
  for (let cell = 0; cell < 100; cell += 1) if (!enemyShipCells.has(cell)) water.push(cell)
  game.clickCell(water[0])
  assert.equal(game.getState().turn, 'enemy')
  assert.equal(game.getView().aiThinking, true)
  const aiTimers = [...env.timers.values()].filter((timer) => timer.delay === AI_DELAY)
  assert.equal(aiTimers.length, 1, 'exactly one AI timer scheduled')
  const shotsBefore = game.getState().enemyShots.filter((shot) => shot !== 0).length
  assert.equal(shotsBefore, 0, 'AI must not move before the delay')
  const runs = runTimers({ maxDelay: 600 })
  assert.ok(runs >= 1, 'AI timer should run')
  const after = game.getState()
  assert.equal(after.enemyShots.filter((shot) => shot !== 0).length, 1, 'AI fired exactly once')
  assert.equal(after.turn, 'player')
  assert.equal(game.getView().aiThinking, false)
  assert.equal(new Set(after.enemyShots.map((shot, cell) => (shot ? cell : null)).filter((cell) => cell !== null)).size, 1, 'AI cell recorded once')
  const viewAfterAI = game.getView()
  assert.equal(viewAfterAI.stats.enemyFired, 1, 'view must reflect the AI shot')
  assert.ok(viewAfterAI.playerCells.some((cell) => cell.shotCode !== 0), 'player board view must mark the AI shot')
  assert.equal(env.consoleErrors.length, 0)
})

test('battle: repeated/illegal fire is refused; sunk message includes the ship name', () => {
  const { game } = mount()
  enterBattle(game)
  const state = game.getState()
  const targetShip = state.enemyShips[0]
  let sunkMessage = null
  // fire every cell of the first enemy ship; between shots let the AI reply.
  // Capture the message immediately after the player's shot, before the AI reply.
  for (const cell of targetShip.cells) {
    if (game.getState().phase !== 'battle' || game.getState().turn !== 'player') break
    game.clickCell(cell)
    const afterShot = game.getView()
    if (afterShot.message.includes('击沉') || afterShot.message.includes('全灭') || afterShot.message.includes('胜利')) {
      sunkMessage = afterShot.message
    }
    if (game.getState().turn === 'enemy') runTimers({ maxDelay: 600 })
    if (game.getState().phase !== 'battle') break
  }
  const view = game.getView()
  assert.ok(sunkMessage, 'sinking a ship must produce a 击沉/win message: ' + view.message)
  assert.ok(sunkMessage.includes(ref.SHIP_BY_KEY.get(targetShip.key).name), 'sunk message should include the ship name: ' + sunkMessage)
  const shots = game.getState().playerShots
  const firedCell = targetShip.cells[0]
  assert.equal(shots[firedCell], 2)
  const before = JSON.stringify(game.getState().playerShots)
  if (game.getState().turn === 'player') {
    game.clickCell(firedCell)
    assert.equal(JSON.stringify(game.getState().playerShots), before, 'repeated fire must not change anything')
  }
  assert.equal(env.consoleErrors.length, 0)
})

test('view.shipDock reflects placement progress (view-only field)', () => {
  const { game } = mount()
  let dock = game.getView().shipDock
  assert.ok(Array.isArray(dock), 'shipDock must be an array in the place phase')
  assert.deepEqual(dock.map((ship) => ship.key), seam.SHIPS.map((ship) => ship.key))
  assert.deepEqual(dock.map((ship) => ship.placed), [false, false, false, false, false])
  assert.deepEqual(dock.map((ship) => ship.current), [true, false, false, false, false])
  game.clickCell(0) // carrier placed
  dock = game.getView().shipDock
  assert.deepEqual(dock.map((ship) => ship.placed), [true, false, false, false, false])
  assert.deepEqual(dock.map((ship) => ship.current), [false, true, false, false, false])
  game.randomize()
  dock = game.getView().shipDock
  assert.deepEqual(dock.map((ship) => ship.placed), [true, true, true, true, true])
  assert.deepEqual(dock.map((ship) => ship.current), [false, false, false, false, false])
  game.start()
  assert.deepEqual(game.getView().shipDock, [], 'shipDock is only populated for placement')
  assert.equal(env.consoleErrors.length, 0)
})

/* ------------------------------------------------------------------ *
 * 5. destroy: persist + cleanup + idempotency + reload
 * ------------------------------------------------------------------ */
test('destroy: persists, removes listeners/observer/timers, is idempotent', () => {
  const { game } = mount()
  enterBattle(game)
  // fire so the AI turn is pending, then destroy mid-turn
  const enemyCells = ref.unfiredCells(game.getState().playerShots)
  game.clickCell(enemyCells[0])
  advanceClock(1234)
  assert.ok(countListeners(env.windowListeners) >= 1)
  assert.ok(countListeners(env.documentListeners) >= 1)
  const observer = env.observers[env.observers.length - 1]
  const state = game.getState()
  const savedState = JSON.stringify(seam.serializeState(state))
  game.destroy()
  currentGame = null
  assert.equal(countListeners(env.windowListeners), 0, 'window listeners must be removed')
  assert.equal(countListeners(env.documentListeners), 0, 'document listeners must be removed')
  assert.equal(observer.disconnected, true, 'ResizeObserver must be disconnected')
  assert.equal(env.timers.size, 0, 'pending AI/message timers must be cleared')
  const saved = env.storage.get(STORE_KEY)
  assert.ok(saved, 'destroy must persist the game')
  assert.equal(saved, savedState, 'destroy must save the exact live state')
  // idempotent second destroy: no throw, no extra write
  const before = env.storage.get(STORE_KEY)
  game.destroy()
  assert.equal(env.storage.get(STORE_KEY), before)
  // clickCell after destroy is inert
  const storageBefore = env.storage.get(STORE_KEY)
  game.clickCell(0)
  assert.equal(env.storage.get(STORE_KEY), storageBefore, 'post-destroy actions must not write')
  assert.equal(env.consoleErrors.length, 0)
})

test('reload: place-phase ships and a full mid-battle state/turn are restored', () => {
  // place phase
  const rect = { width: 960, height: 680 }
  const { host } = mount(rect)
  currentGame.rotate()
  currentGame.clickCell(0)
  assert.equal(currentGame.getState().playerShips.length, 1)
  const placedShips = JSON.stringify(currentGame.getState().playerShips)
  currentGame.destroy()
  currentGame = null
  currentGame = seam.createGame(host, {})
  assert.equal(currentGame.getState().phase, 'place')
  assert.equal(JSON.stringify(currentGame.getState().playerShips), placedShips, 'placed ships restored')

  // battle: play a couple of full turns, then destroy on the player's turn
  enterBattle(currentGame)
  const unfired = ref.unfiredCells(currentGame.getState().playerShots)
  currentGame.clickCell(unfired[0])
  runTimers({ maxDelay: 600 }) // AI reply -> turn player again
  const battleState = currentGame.getState()
  assert.equal(battleState.phase, 'battle')
  assert.equal(battleState.turn, 'player')
  const before = JSON.stringify(seam.serializeState(battleState))
  currentGame.destroy()
  currentGame = null
  currentGame = seam.createGame(host, {})
  const reloaded = currentGame.getState()
  assert.equal(reloaded.phase, 'battle')
  assert.equal(reloaded.turn, 'player')
  assert.equal(JSON.stringify(seam.serializeState(reloaded)), before, 'mid-battle state restored exactly')
  assert.equal(currentGame.getView().phase, 'battle')
})

test('reload mid-AI-turn: restored enemy turn resumes the AI after the delay', () => {
  const rect = { width: 960, height: 680 }
  const { host } = mount(rect)
  enterBattle(currentGame)
  const unfired = ref.unfiredCells(currentGame.getState().playerShots)
  currentGame.clickCell(unfired[0])
  assert.equal(currentGame.getState().turn, 'enemy')
  const shotsBefore = currentGame.getState().enemyShots.filter((shot) => shot !== 0).length
  currentGame.destroy()
  currentGame = null
  currentGame = seam.createGame(host, {})
  assert.equal(currentGame.getState().turn, 'enemy')
  assert.equal(currentGame.getView().aiThinking, true)
  runTimers({ maxDelay: 600 })
  assert.equal(currentGame.getState().turn, 'player')
  assert.equal(currentGame.getState().enemyShots.filter((shot) => shot !== 0).length, shotsBefore + 1)
})

/* ------------------------------------------------------------------ *
 * 6. visibility pause
 * ------------------------------------------------------------------ */
test('document.hidden pauses a pending AI turn; returning resumes exactly once', () => {
  const { game } = mount()
  enterBattle(game)
  const unfired = ref.unfiredCells(game.getState().playerShots)
  game.clickCell(unfired[0])
  assert.equal(game.getState().turn, 'enemy')
  const shotsBefore = game.getState().enemyShots.filter((shot) => shot !== 0).length
  env.documentHidden = true
  fireDocument('visibilitychange')
  assert.equal([...env.timers.values()].filter((timer) => timer.delay === AI_DELAY).length, 0, 'AI timer paused while hidden')
  advanceClock(60000)
  fireWindow('resize')
  flushMeasure()
  assert.equal(game.getState().enemyShots.filter((shot) => shot !== 0).length, shotsBefore, 'no AI move while hidden')
  const persisted = env.storage.get(STORE_KEY)
  assert.ok(persisted, 'hiding persists the state')
  assert.equal(JSON.parse(persisted).turn, 'enemy')

  env.documentHidden = false
  fireDocument('visibilitychange')
  assert.equal([...env.timers.values()].filter((timer) => timer.delay === AI_DELAY).length, 1, 'AI resumed on visibility')
  runTimers({ maxDelay: 600 })
  assert.equal(game.getState().enemyShots.filter((shot) => shot !== 0).length, shotsBefore + 1, 'exactly one AI move after resume')
  assert.equal(game.getState().turn, 'player')
  assert.equal(env.consoleErrors.length, 0)
})

/* ------------------------------------------------------------------ *
 * 7. restart / new game / difficulty / adjacent / surrender
 * ------------------------------------------------------------------ */
test('restart keeps fleets and clears shots; new-game starts a fresh placement', () => {
  const { game } = mount()
  enterBattle(game)
  const ships = JSON.stringify(game.getState().playerShips)
  const enemyShips = JSON.stringify(game.getState().enemyShips)
  const cell = ref.unfiredCells(game.getState().playerShots)[0]
  game.clickCell(cell)
  runTimers({ maxDelay: 600 })
  assert.ok(game.getState().playerShots.filter((shot) => shot !== 0).length > 0)
  game.restart()
  const state = game.getState()
  assert.equal(state.phase, 'battle')
  assert.equal(state.turn, 'player')
  assert.equal(JSON.stringify(state.playerShips), ships)
  assert.equal(JSON.stringify(state.enemyShips), enemyShips)
  assert.equal(state.playerShots.filter((shot) => shot !== 0).length, 0)
  assert.equal(state.enemyShots.filter((shot) => shot !== 0).length, 0)

  const oldSeed = state.seed
  game.newGame()
  const fresh = game.getState()
  assert.equal(fresh.phase, 'place')
  assert.equal(fresh.playerShips.length, 0)
  assert.equal(fresh.enemyShips.length, 0)
  assert.notEqual(fresh.seed, oldSeed, 'newGame should reseed')
})

test('difficulty and allow-adjacent settings persist and reach the view', () => {
  const { game } = mount()
  for (const difficulty of ['easy', 'normal', 'hard']) {
    game.setDifficulty(difficulty)
    assert.equal(game.getState().difficulty, difficulty)
    assert.equal(game.getView().difficulty, difficulty)
  }
  assert.equal(game.getState().allowAdjacent, false)
  game.toggleAdjacent()
  assert.equal(game.getState().allowAdjacent, true)
  assert.equal(game.getView().allowAdjacent, true)
  game.toggleAdjacent()
  assert.equal(game.getState().allowAdjacent, false)
  const saved = JSON.parse(env.storage.get(STORE_KEY))
  assert.equal(saved.difficulty, 'hard')
  assert.equal(saved.allowAdjacent, false)
})

test('surrender ends the game in the player\'s loss with endReason=surrender', () => {
  const { game } = mount()
  enterBattle(game)
  game.surrender()
  const state = game.getState()
  assert.equal(state.phase, 'over')
  assert.equal(state.winner, 'enemy')
  assert.equal(state.endReason, 'surrender')
  const view = game.getView()
  assert.equal(view.winner, 'enemy')
  assert.match(view.statusText, /投降/)
  const saved = JSON.parse(env.storage.get(STORE_KEY))
  assert.equal(saved.endReason, 'surrender')
  // still valid per the independent validator
  assert.deepEqual(ref.validateState(seam.sanitizeState(saved)), [])
})

/* ------------------------------------------------------------------ *
 * 8. corrupt save fallback
 * ------------------------------------------------------------------ */
test('corrupt save: createGame starts a fresh valid place game without throwing', () => {
  const garbage = [
    '{not json', 'null', '[]',
    JSON.stringify({ schemaVersion: 2, seed: 1 }),
    JSON.stringify({ schemaVersion: 1, seed: 1, phase: 'battle' }),
    JSON.stringify({ schemaVersion: 1, seed: 1, rng: 1, phase: 'place', allowAdjacent: false, difficulty: 'normal', orientation: 'h', placementIndex: 2, playerShips: [], enemyShips: [], playerShots: new Array(100).fill(0), enemyShots: new Array(100).fill(0), turn: 'player', winner: null }),
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
    currentGame = game
    const state = game.getState()
    assert.equal(state.phase, 'place')
    assert.equal(state.playerShips.length, 0)
    assert.deepEqual(ref.validateState(state), [])
    assert.equal(game.getView().tooSmall, false)
    currentGame.destroy()
    currentGame = null
  }
})

/* ------------------------------------------------------------------ *
 * 9. listener / DOM hygiene
 * ------------------------------------------------------------------ */
test('no global keyboard listeners; only resize + visibilitychange; no document.body', () => {
  const { game } = mount()
  enterBattle(game)
  const windowTypes = listenerTypes(env.windowListeners)
  const documentTypes = listenerTypes(env.documentListeners)
  for (const type of ['keydown', 'keyup', 'keypress']) {
    assert.ok(!windowTypes.includes(type), 'window must not listen to ' + type)
    assert.ok(!documentTypes.includes(type), 'document must not listen to ' + type)
  }
  assert.deepEqual([...windowTypes].sort(), ['resize'])
  assert.deepEqual([...documentTypes].sort(), ['visibilitychange'])
  assert.equal(env.bodyTouches, 0, 'document.body must never be touched')
  assert.deepEqual([...env.createElementCalls].filter((tag) => tag === 'body' || tag === 'html'), [], 'must not create body/html elements')
  game.fire(5)
  assert.equal(env.bodyTouches, 0)
  assert.equal(env.consoleErrors.length, 0)
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
