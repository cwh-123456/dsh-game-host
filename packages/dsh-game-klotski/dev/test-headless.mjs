/**
 * dev/test-headless.mjs — controller / lifecycle self test on a fake DOM.
 *
 *   node dev/test-headless.mjs
 *
 * Uses dev/fake-dom.mjs (no dependencies, no browser) and the client.js test
 * seam to exercise `createGame`:
 *   mount, layout, click select/move, illegal move rejection, keyboard, timer,
 *   visibility pause, undo, restart, level switch, win + overlay, best record,
 *   destroy save + idempotency + DOM cleanup, restore progress, bad save
 *   fallback, resize / too-small, save key hygiene.
 *
 * Exits non-zero on failure.
 */
import assert from 'node:assert/strict'
import { createEnvironment } from './fake-dom.mjs'

// ---------------------------------------------------------------------------
// Load client.js through its test seam (no React needed for createGame)
// ---------------------------------------------------------------------------

const preStorage = new Map()
globalThis.window = {
  __DSH_GAME_KLOTSKI_TEST__: true,
  __ModuleLoader__: { load() {} },
  localStorage: {
    getItem: (key) => (preStorage.has(key) ? preStorage.get(key) : null),
    setItem: (key, value) => preStorage.set(key, String(value)),
    removeItem: (key) => preStorage.delete(key),
    clear: () => preStorage.clear(),
  },
  performance: { now: () => 0 },
}

await import(new URL('../client.js', import.meta.url).href)
const api = globalThis.window.__DSH_GAME_KLOTSKI__
assert.ok(api, 'test seam should exist')

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.error('not ok - ' + name)
    console.error(error && error.stack ? error.stack : error)
  }
}

function pieceIndex(levelIndex, id) {
  return api.LEVELS[levelIndex].pieces.findIndex((piece) => piece.id === id)
}

function makeEnv(options) {
  const env = createEnvironment(
    Object.assign(
      {
        width: 720,
        height: 600,
      },
      options || {},
    ),
  )
  env.storage.clear()
  return env
}

function mountGame(env) {
  const game = api.createGame(env.host)
  env.setBoardRect(game)
  return game
}

/** A valid level-1 layout with Cao Cao at (1,2) -> one slide down wins. */
function nearWinState() {
  const state = api.createState(0)
  const layout = {
    zhang: [0, 0],
    zhao: [3, 0],
    ma: [0, 2],
    huang: [3, 2],
    guan: [1, 0],
    cao: [1, 2],
    bing1: [0, 4],
    bing2: [3, 4],
    bing3: [1, 1],
    bing4: [2, 1],
  }
  for (const piece of state.pieces) {
    piece.x = layout[piece.id][0]
    piece.y = layout[piece.id][1]
  }
  return state
}

/** A valid level-1 layout with Cao Cao already at the exit. */
function wonState() {
  const state = api.createState(0)
  const layout = {
    zhang: [0, 0],
    cao: [1, 3],
    zhao: [3, 0],
    ma: [0, 2],
    guan: [1, 0],
    huang: [3, 2],
    bing1: [1, 1],
    bing2: [2, 1],
    bing3: [1, 2],
    bing4: [2, 2],
  }
  for (const piece of state.pieces) {
    piece.x = layout[piece.id][0]
    piece.y = layout[piece.id][1]
  }
  return state
}

function seedSave(env, state) {
  env.storage.setItem(api.STORE_KEY, JSON.stringify(api.serializeState(state)))
}

function savedState(env) {
  const raw = env.storage.getItem(api.STORE_KEY)
  if (!raw) return null
  return JSON.parse(raw)
}

function storageKeys(env) {
  return Array.from(env.storage.__map.keys())
}

// ---------------------------------------------------------------------------
// Mount / layout / selection / moves
// ---------------------------------------------------------------------------

test('mount renders the root, board and 4 level chips', () => {
  const env = makeEnv()
  const game = mountGame(env)
  try {
    const view = game.getView()
    assert.equal(view.levelIndex, 0)
    assert.equal(view.moves, 0)
    assert.equal(view.won, false)
    assert.ok(view.layout && view.layout.cell > 20)
    assert.equal(game.__test.board.children.length >= 4, true)
    assert.equal(game.__test.levelChips.length, 4)
    assert.equal(game.__test.root.parentNode, env.host)
    assert.equal(game.__test.undoButton.disabled, true, 'undo disabled at start')
    assert.deepEqual(storageKeys(env), [], 'no save written before any action')
  } finally {
    game.destroy()
  }
})

test('click piece -> destination marker -> click empty cell moves it', () => {
  const env = makeEnv()
  const game = mountGame(env)
  try {
    const bing1 = pieceIndex(0, 'bing1')
    game.__test.clickCell(1, 3) // bing1 at (1,3)
    assert.equal(game.getView().selected, bing1)
    assert.equal(game.__test.markersLayer.children.length, 1, 'one legal destination (down)')
    game.__test.clickCell(1, 4)
    const view = game.getView()
    assert.equal(view.moves, 1)
    assert.equal(view.selected, null)
    assert.equal(view.started, true, 'timer starts on the first move')
    assert.equal(game.getState().pieces[bing1].y, 4)
    assert.deepEqual(storageKeys(env), [api.STORE_KEY])
    const saved = savedState(env)
    assert.equal(saved.moves, 1)
    assert.equal(saved.schemaVersion, 1)
    assert.equal(game.__test.undoButton.disabled, false)
  } finally {
    game.destroy()
  }
})

test('clicking the selected piece deselects it; clicking empty non-destination deselects', () => {
  const env = makeEnv()
  const game = mountGame(env)
  try {
    game.__test.clickCell(1, 3)
    assert.notEqual(game.getView().selected, null)
    game.__test.clickCell(1, 3)
    assert.equal(game.getView().selected, null)
    game.__test.clickCell(1, 3)
    assert.notEqual(game.getView().selected, null)
    game.__test.clickCell(2, 4) // empty but not a destination of bing1
    assert.equal(game.getView().selected, null)
    assert.equal(game.getView().moves, 0)
  } finally {
    game.destroy()
  }
})

test('illegal slide is rejected (no move, no save, toast)', () => {
  const env = makeEnv()
  const game = mountGame(env)
  try {
    const cao = pieceIndex(0, 'cao')
    assert.equal(game.__test.doMove(cao, 0, 1, 1), false)
    assert.equal(game.getView().moves, 0)
    assert.deepEqual(storageKeys(env), [], 'rejected move must not persist')
    assert.equal(game.__test.doMove(pieceIndex(0, 'bing1'), 0, 1, 2), false, '2-cell slide out of bounds')
    const toast = game.__test.root.children.find((child) => String(child.className).indexOf('dshklt-toast') >= 0)
    assert.ok(toast)
    assert.equal(toast.textContent, '这个方向走不通')
  } finally {
    game.destroy()
  }
})

test('keyboard: arrows move the selected piece, Escape deselects, Ctrl+Z undoes', () => {
  const env = makeEnv()
  const game = mountGame(env)
  try {
    const root = game.__test.root
    game.__test.clickCell(1, 3) // bing1
    root.dispatchEvent({ type: 'keydown', key: 'ArrowDown' })
    assert.equal(game.getView().moves, 1)
    assert.equal(game.getState().pieces[pieceIndex(0, 'bing1')].y, 4)
    root.dispatchEvent({ type: 'keydown', key: 'z', ctrlKey: true })
    assert.equal(game.getView().moves, 0)
    game.__test.clickCell(1, 3)
    assert.notEqual(game.getView().selected, null)
    root.dispatchEvent({ type: 'keydown', key: 'Escape' })
    assert.equal(game.getView().selected, null)
  } finally {
    game.destroy()
  }
})

// ---------------------------------------------------------------------------
// Timer / visibility
// ---------------------------------------------------------------------------

test('timer runs after the first move and pauses while hidden', () => {
  const env = makeEnv()
  const game = mountGame(env)
  try {
    game.__test.clickCell(1, 3)
    game.__test.clickCell(1, 4) // first move starts the clock
    env.advance(2000)
    env.flushRaf()
    const afterTwoSeconds = game.getView().elapsedMs
    assert.ok(afterTwoSeconds >= 1900 && afterTwoSeconds <= 2200, 'elapsed ~2s, got ' + afterTwoSeconds)
    env.setHidden(true)
    const paused = game.getView().elapsedMs
    assert.ok(paused >= 1900)
    env.advance(60000)
    env.flushRaf()
    assert.equal(game.getView().elapsedMs, paused, 'elapsed frozen while hidden')
    env.setHidden(false)
    env.advance(1000)
    env.flushRaf()
    const resumed = game.getView().elapsedMs
    assert.ok(resumed >= paused + 900, 'elapsed resumes after visible, got ' + resumed)
    game.destroy()
    const persisted = savedState(env)
    assert.ok(persisted.elapsedMs >= paused + 900)
  } finally {
    game.destroy()
  }
})

test('restored started timer resumes without jumping', () => {
  const env = makeEnv()
  const state = api.createState(0)
  state.started = true
  state.elapsedMs = 5000
  state.moves = 1
  state.pieces[pieceIndex(0, 'bing1')].y = 4
  seedSave(env, state)
  env.clock.now = 0
  const game = mountGame(env)
  try {
    assert.equal(game.getView().elapsedMs, 5000)
    env.advance(1500)
    env.flushRaf()
    assert.ok(game.getView().elapsedMs >= 6400 && game.getView().elapsedMs <= 6600)
  } finally {
    game.destroy()
  }
})

// ---------------------------------------------------------------------------
// Undo / restart / level switch
// ---------------------------------------------------------------------------

test('undo restores the previous position, move count and clock', () => {
  const env = makeEnv()
  const game = mountGame(env)
  try {
    game.__test.clickCell(1, 3)
    game.__test.clickCell(1, 4)
    assert.equal(game.getView().moves, 1)
    game.__test.doUndo()
    const view = game.getView()
    assert.equal(view.moves, 0)
    assert.equal(view.started, false)
    assert.equal(view.elapsedMs, 0)
    assert.equal(game.getState().pieces[pieceIndex(0, 'bing1')].y, 3)
    assert.equal(game.__test.undoButton.disabled, true)
    assert.equal(game.__test.doUndo(), undefined) // no throw on empty undo
  } finally {
    game.destroy()
  }
})

test('restart resets the current level but keeps best records', () => {
  const env = makeEnv()
  const game = mountGame(env)
  try {
    game.getState().best = { hengdao: { moves: 100, elapsedMs: 5000 } }
    game.__test.clickCell(1, 3)
    game.__test.clickCell(1, 4)
    game.__test.doRestart()
    const view = game.getView()
    assert.equal(view.moves, 0)
    assert.equal(view.elapsedMs, 0)
    assert.equal(view.won, false)
    assert.deepEqual(view.best, { hengdao: { moves: 100, elapsedMs: 5000 } })
    assert.deepEqual(game.getState().pieces, api.createState(0).pieces)
  } finally {
    game.destroy()
  }
})

test('level switch loads the target level fresh and persists it', () => {
  const env = makeEnv()
  const game = mountGame(env)
  try {
    game.__test.doSetLevel(2)
    let view = game.getView()
    assert.equal(view.levelIndex, 2)
    assert.equal(view.moves, 0)
    assert.deepEqual(game.getState().pieces, api.createState(2).pieces)
    const saved = savedState(env)
    assert.equal(saved.levelIndex, 2)
    // Clicking the active level chip only toasts, does not reset.
    game.__test.clickCell(1, 3) // not part of the level switch semantics; reset it first
    game.__test.doRestart()
    game.__test.levelChips[2].dispatchEvent({ type: 'click' })
    view = game.getView()
    assert.equal(view.levelIndex, 2)
    game.__test.levelChips[1].dispatchEvent({ type: 'click' })
    view = game.getView()
    assert.equal(view.levelIndex, 1)
    assert.deepEqual(game.getState().pieces, api.createState(1).pieces)
  } finally {
    game.destroy()
  }
})

// ---------------------------------------------------------------------------
// Win / overlay / best
// ---------------------------------------------------------------------------

test('sliding Cao Cao into the exit wins, shows the overlay and records the best', () => {
  const env = makeEnv()
  seedSave(env, nearWinState())
  const game = mountGame(env)
  try {
    game.__test.clickCell(1, 2) // Cao Cao at (1,2)
    assert.notEqual(game.getView().selected, null)
    const markerCells = game.__test.markersLayer.children
      .map((marker) => marker.getAttribute('data-cell'))
      .sort()
    assert.deepEqual(markerCells, ['1,4', '2,4'], 'markers sit on the two empty cells the block would enter')
    game.__test.clickCell(1, 4) // click the empty bottom cell it would enter -> slide down
    const view = game.getView()
    assert.equal(view.won, true)
    assert.equal(game.getState().pieces[pieceIndex(0, 'cao')].y, 3)
    assert.ok(String(game.__test.winOverlay.className).includes('dshklt-win--show'))
    assert.ok(String(game.__test.board.className).includes('dshklt-board--won'))
    const saved = savedState(env)
    assert.equal(saved.won, true)
    assert.ok(saved.best.hengdao, 'best record written')
    assert.equal(saved.best.hengdao.moves, 1)
    // Replay button restarts the level and hides the overlay.
    const replay = game.__test.winOverlay.children[0].children[2].children[1]
    replay.dispatchEvent({ type: 'click' })
    assert.equal(game.getView().won, false)
    assert.equal(game.getView().moves, 0)
    assert.equal(String(game.__test.winOverlay.className).includes('dshklt-win--show'), false)
  } finally {
    game.destroy()
  }
})

test('restoring a winning save shows the win overlay immediately', () => {
  const env = makeEnv()
  const state = wonState()
  state.won = true
  state.moves = 80
  state.started = true
  state.elapsedMs = 123000
  seedSave(env, state)
  const game = mountGame(env)
  try {
    assert.equal(game.getView().won, true)
    assert.ok(String(game.__test.winOverlay.className).includes('dshklt-win--show'))
    assert.equal(game.getView().timing, false, 'winning state has a stopped clock')
  } finally {
    game.destroy()
  }
})

// ---------------------------------------------------------------------------
// Persistence / destroy
// ---------------------------------------------------------------------------

test('destroy writes the save, removes the DOM and is idempotent', () => {
  const env = makeEnv()
  const game = mountGame(env)
  game.__test.clickCell(1, 3)
  game.__test.clickCell(1, 4)
  env.advance(3000)
  env.flushRaf()
  game.destroy()
  assert.equal(env.host.children.length, 0, 'root removed from host')
  const saved = savedState(env)
  assert.ok(saved)
  assert.equal(saved.moves, 1)
  assert.ok(saved.elapsedMs >= 2900)
  game.destroy() // second call must not throw
  assert.deepEqual(storageKeys(env), [api.STORE_KEY])
})

test('progress is restored after remount (same storage)', () => {
  const env = makeEnv()
  let game = mountGame(env)
  game.__test.clickCell(1, 3)
  game.__test.clickCell(1, 4)
  const expectedPieces = game.getState().pieces.map((piece) => Object.assign({}, piece))
  game.destroy()
  game = mountGame(env)
  try {
    const view = game.getView()
    assert.equal(view.moves, 1)
    assert.deepEqual(game.getState().pieces, expectedPieces)
    assert.equal(view.levelIndex, 0)
  } finally {
    game.destroy()
  }
})

test('corrupt save falls back to a fresh level-1 game without throwing', () => {
  const env = makeEnv()
  env.storage.setItem(api.STORE_KEY, '{"schemaVersion":1,"levelIndex":99,,,')
  const game = mountGame(env)
  try {
    const view = game.getView()
    assert.equal(view.levelIndex, 0)
    assert.equal(view.moves, 0)
    assert.deepEqual(game.getState().pieces, api.createState(0).pieces)
  } finally {
    game.destroy()
  }
})

test('only the dsh.game.klotski.v1 key is touched', () => {
  const env = makeEnv()
  env.storage.setItem('dsh.game.sudoku.v1', 'other game')
  const game = mountGame(env)
  try {
    game.__test.clickCell(1, 3)
    game.__test.clickCell(1, 4)
    game.destroy()
    assert.deepEqual(
      storageKeys(env).sort(),
      ['dsh.game.klotski.v1', 'dsh.game.sudoku.v1'].sort(),
    )
    assert.equal(env.storage.getItem('dsh.game.sudoku.v1'), 'other game')
  } finally {
    game.destroy()
  }
})

// ---------------------------------------------------------------------------
// Resize / too small
// ---------------------------------------------------------------------------

test('resize recomputes the board layout; <320x240 shows the too-small hint', () => {
  const env = makeEnv({ width: 720, height: 600 })
  const game = mountGame(env)
  try {
    const first = game.getView().layout
    assert.ok(first && first.cell > 40)
    env.setSize(420, 500)
    env.flushRaf()
    const second = game.getView().layout
    assert.ok(second && second.cell < first.cell)
    assert.equal(game.getView().tooSmall, false)
    env.setSize(300, 500)
    env.flushRaf()
    assert.equal(game.getView().tooSmall, true)
    assert.ok(String(game.__test.root.className).includes('dshklt-root--small'))
    env.setSize(320, 240)
    env.flushRaf()
    assert.equal(game.getView().tooSmall, false, '320x240 is the supported minimum')
  } finally {
    game.destroy()
  }
})

// ---------------------------------------------------------------------------
// Modal / misc
// ---------------------------------------------------------------------------

test('win overlay next button advances to the next level', () => {
  const env = makeEnv()
  const state = wonState()
  state.won = true
  state.started = true
  seedSave(env, state)
  const game = mountGame(env)
  try {
    const next = game.__test.winOverlay.children[0].children[2].children[0]
    assert.equal(next.textContent, '下一关')
    next.dispatchEvent({ type: 'click' })
    assert.equal(game.getView().levelIndex, 1)
    assert.equal(game.getView().won, false)
  } finally {
    game.destroy()
  }
})

test('root has no document.body side effects and only one game root', () => {
  const env = makeEnv()
  const game = mountGame(env)
  try {
    assert.equal(env.document.body.children.length, 1, 'only the host element is on body')
    assert.equal(env.host.children.length, 1, 'exactly one game root inside the host')
    assert.equal(game.__test.root.getAttribute('data-game'), 'klotski')
  } finally {
    game.destroy()
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  console.error('\nFAILED')
  for (const failure of failures) console.error('- ' + failure.name + ': ' + failure.error.message)
  process.exit(1)
}
console.log('HEADLESS TESTS OK')
