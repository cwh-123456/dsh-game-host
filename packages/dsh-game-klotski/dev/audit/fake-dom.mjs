/**
 * Suite 6 (bonus) — minimal fake DOM: exercise createGame's full lifecycle.
 *
 *   node packages/dsh-game-klotski/dev/audit/fake-dom.mjs
 *
 * A deliberately tiny DOM/ResizeObserver/rAF/localStorage stub (no jsdom, no
 * third-party deps) is enough because client.js only uses a narrow DOM surface.
 * Covered: mount, saved-state restore, select + click move, illegal move
 * rejection, undo, restart, level switch, document.hidden timer pause/resume,
 * auto-save on destroy, idempotent destroy, <320x240 too-small hint, winning
 * state overlay, restore-after-remount, and "no document.body usage".
 *
 * The React <Game> wrapper mount is NOT re-implemented here (no React runtime in
 * Node); static factory/registration checks live in contract-audit.mjs.
 */
import assert from 'node:assert/strict'
import { api, storage, storageMap } from './harness.mjs'
import * as oracle from './oracle.mjs'

/* -------------------------------------------------------------- fake DOM */

class FakeStyle {
  constructor() {
    this._map = new Map()
  }
  setProperty(name, value) {
    this._map.set(String(name), String(value))
    this[name] = String(value)
  }
  getPropertyValue(name) {
    return this._map.get(String(name)) || ''
  }
}

class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = new FakeStyle()
    this._classes = new Set()
    this._attrs = new Map()
    this._listeners = new Map()
    this._text = ''
    this._rect = { left: 0, top: 0, width: 0, height: 0 }
    this.clientWidth = 0
    this.clientHeight = 0
    this.disabled = false
  }
  get className() {
    return Array.from(this._classes).join(' ')
  }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean))
  }
  get classList() {
    const el = this
    return {
      add(...names) {
        for (const name of names) el._classes.add(name)
      },
      remove(...names) {
        for (const name of names) el._classes.delete(name)
      },
      contains(name) {
        return el._classes.has(name)
      },
      toggle(name, force) {
        const on = force === undefined ? !el._classes.has(name) : !!force
        if (on) el._classes.add(name)
        else el._classes.delete(name)
        return on
      },
    }
  }
  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('')
    return this._text
  }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    this._text = String(value)
  }
  get firstChild() {
    return this.children[0] || null
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
  setAttribute(name, value) {
    this._attrs.set(String(name), String(value))
  }
  getAttribute(name) {
    return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null
  }
  addEventListener(type, fn) {
    const list = this._listeners.get(type) || []
    list.push(fn)
    this._listeners.set(type, list)
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type) || []
    this._listeners.set(type, list.filter((item) => item !== fn))
  }
  dispatch(type, extra) {
    const event = Object.assign({ type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }, extra)
    for (const fn of (this._listeners.get(type) || []).slice()) fn(event)
    return event
  }
  focus() {
    this.focused = true
  }
  getBoundingClientRect() {
    return Object.assign({}, this._rect)
  }
  setRect(rect) {
    this._rect = Object.assign({}, rect)
  }
  /** Test helper: descendants matching a predicate. */
  find(predicate, out = []) {
    for (const child of this.children) {
      if (predicate(child)) out.push(child)
      child.find(predicate, out)
    }
    return out
  }
  byAttr(name) {
    return this.find((el) => el.getAttribute(name) !== null)
  }
}

class FakeDocument {
  constructor() {
    this.hidden = false
    this.visibilityState = 'visible'
    this._listeners = new Map()
    this.body = new FakeElement(this, 'body')
    this.documentElement = new FakeElement(this, 'html')
  }
  createElement(tag) {
    return new FakeElement(this, tag)
  }
  addEventListener(type, fn) {
    const list = this._listeners.get(type) || []
    list.push(fn)
    this._listeners.set(type, list)
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type) || []
    this._listeners.set(type, list.filter((item) => item !== fn))
  }
  setHidden(value) {
    this.hidden = value
    this.visibilityState = value ? 'hidden' : 'visible'
    for (const fn of (this._listeners.get('visibilitychange') || []).slice()) fn({ type: 'visibilitychange', target: this })
  }
  listenerCount(type) {
    return (this._listeners.get(type) || []).length
  }
}

/* --------------------------------------------- fake timers / ResizeObserver */

const rafQueue = new Map()
let rafSeq = 1
let roInstances = []
let storedRaf = globalThis.requestAnimationFrame
let storedCaf = globalThis.cancelAnimationFrame
let storedRO = globalThis.ResizeObserver

function installFakeGlobals() {
  globalThis.requestAnimationFrame = function (fn) {
    const id = rafSeq++
    rafQueue.set(id, fn)
    return id
  }
  globalThis.cancelAnimationFrame = function (id) {
    rafQueue.delete(id)
  }
  globalThis.ResizeObserver = class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback
      this.observed = []
      this.disconnected = false
      roInstances.push(this)
    }
    observe(element) {
      this.observed.push(element)
    }
    disconnect() {
      this.disconnected = true
    }
    trigger() {
      this.callback([{ target: this.observed[0] }])
    }
  }
}

function uninstallFakeGlobals() {
  globalThis.requestAnimationFrame = storedRaf
  globalThis.cancelAnimationFrame = storedCaf
  globalThis.ResizeObserver = storedRO
  rafQueue.clear()
}

function flushFrames(rounds = 3) {
  for (let r = 0; r < rounds; r += 1) {
    const pending = Array.from(rafQueue.entries())
    rafQueue.clear()
    for (const [, fn] of pending) fn()
  }
}

/* ---------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let checks = 0
const failures = []
const notes = []
function check(name, fn) {
  checks += 1
  try {
    fn()
  } catch (error) {
    failures.push({ name, message: String(error && error.message) })
    console.error('FAIL ' + name + ': ' + (error && error.message))
  }
}
function ok(value, message) {
  assert.ok(value, message)
}

function makeHost(doc, width, height) {
  const host = doc.createElement('div')
  host.clientWidth = width
  host.clientHeight = height
  return host
}

function savedState(levelIndex, moveCount) {
  let state = api.createState(levelIndex)
  for (let step = 0; step < moveCount; step += 1) {
    const moves = []
    for (let i = 0; i < state.pieces.length; i += 1) moves.push(...api.listMoves(state, i))
    if (!moves.length) break
    state = api.applySlide(state, moves[0].pieceIndex, moves[0].dx, moves[0].dy, moves[0].step)
  }
  return state
}

function winningSave() {
  const level = api.LEVELS[0]
  const slots = { '2x2': [[1, 3]], '2x1': [[0, 2]], '1x2': [[0, 0], [3, 0], [0, 3], [3, 3]], '1x1': [[1, 0], [2, 0], [1, 1], [2, 1]] }
  const pieces = level.pieces.map((def) => {
    const [x, y] = slots[def.w + 'x' + def.h].shift()
    return { id: def.id, x, y }
  })
  return { schemaVersion: 1, levelIndex: 0, pieces, moves: 17, elapsedMs: 1000, started: true, won: true, undo: [], best: {} }
}

function recordState(game) {
  try {
    return JSON.parse(JSON.stringify(api.serializeState(game.getState())))
  } catch (ignored) {
    return null
  }
}

/* ------------------------------------------------------------------- run */

console.log('=== Suite 6 (bonus): fake-DOM createGame lifecycle ===\n')
installFakeGlobals()
try {
  check('mount: no throw, root installed, 10 pieces, 4 level chips, layout computed', () => {
    storageMap.clear()
    const doc = new FakeDocument()
    const host = makeHost(doc, 900, 700)
    const game = api.createGame(host)
    flushFrames()
    ok(host.children.length === 1, 'host should contain the game root')
    const root = host.children[0]
    ok(root.classList.contains('dshklt-root'), 'root class')
    ok(root.getAttribute('data-game') === 'klotski', 'data-game')
    ok(doc.body.children.length === 0, 'createGame must not touch document.body')
    const view = game.getView()
    ok(view.levelIndex === 0 && view.moves === 0, 'fresh state at level 1')
    ok(view.layout && view.layout.cell > 0, 'layout computed: ' + JSON.stringify(view.layout))
    const pieceEls = root.find((el) => el.getAttribute('data-piece-id') !== null)
    ok(pieceEls.length === 10, 'expected 10 piece elements, got ' + pieceEls.length)
    const chips = root.find((el) => el.getAttribute('data-level-index') !== null)
    ok(chips.length === 4, 'expected 4 level chips, got ' + chips.length)
    ok(roInstances.length === 1 && roInstances[0].observed.length === 2, 'ResizeObserver should observe host + stage')
    game.destroy()
    ok(host.children.length === 0, 'destroy should remove the root')
  })

  check('restore saved state on mount', () => {
    storageMap.clear()
    const state = savedState(1, 3)
    storage.setItem(api.STORE_KEY, JSON.stringify(api.serializeState(state)))
    const doc = new FakeDocument()
    const host = makeHost(doc, 900, 700)
    const game = api.createGame(host)
    flushFrames()
    const view = game.getView()
    ok(view.levelIndex === 1, 'restored level index')
    ok(view.moves === state.moves, 'restored moves ' + view.moves + ' vs ' + state.moves)
    ok(view.started === true, 'started flag restored')
    assert.deepStrictEqual(
      game.getState().pieces.map((p) => p.x + ',' + p.y),
      state.pieces.map((p) => p.x + ',' + p.y),
      'restored arrangement',
    )
    game.destroy()
  })

  check('select piece + click an entered empty cell -> legal move', () => {
    storageMap.clear()
    const doc = new FakeDocument()
    const host = makeHost(doc, 900, 700)
    const game = api.createGame(host)
    flushFrames()
    const state = game.getState()
    const level = api.LEVELS[state.levelIndex]
    // Choose a movable piece and one of its legal moves.
    let chosen = null
    for (let i = 0; i < state.pieces.length && !chosen; i += 1) {
      const moves = api.listMoves(state, i)
      if (moves.length) chosen = { i, move: moves[0] }
    }
    ok(chosen, 'some piece must be movable from the initial position')
    game.__test.selectPiece(chosen.i)
    flushFrames()
    const markers = game.__test.markersLayer.children.length
    ok(markers > 0, 'selecting a movable piece should render destination markers')
    const dest = api.destinations(state, chosen.i)
    const keys = Object.keys(dest)
    ok(keys.length > 0, 'destinations map must not be empty')
    const [tx, ty] = keys[0].split(',').map(Number)
    game.__test.clickCell(tx, ty)
    flushFrames()
    const after = game.getView()
    ok(after.moves === 1, 'one click move should increment moves, got ' + after.moves)
    assert.deepStrictEqual(
      game.getState().pieces.map((p) => p.x + ',' + p.y),
      dest[keys[0]] && (() => {
        const next = oracle.applySlide(
          state.pieces.map((p) => ({ x: p.x, y: p.y })),
          level,
          dest[keys[0]].pieceIndex,
          dest[keys[0]].dx,
          dest[keys[0]].dy,
          dest[keys[0]].step,
        )
        return next.map((p) => p.x + ',' + p.y)
      })(),
      'piece arrangement after click move',
    )
    game.destroy()
  })

  check('illegal move is rejected (toast, no state change)', () => {
    storageMap.clear()
    const doc = new FakeDocument()
    const host = makeHost(doc, 900, 700)
    const game = api.createGame(host)
    flushFrames()
    const before = recordState(game)
    const okMove = game.__test.doMove(1, 1, 0, 1) // Cao Cao right: blocked by Zhao Yun
    flushFrames()
    ok(okMove === false, 'doMove must reject an illegal slide')
    ok(game.getView().moves === 0, 'moves must stay 0 after an illegal move')
    assert.deepStrictEqual(recordState(game).pieces, before.pieces, 'arrangement unchanged after illegal move')
    game.destroy()
  })

  check('undo restores the previous arrangement; undo on empty history is safe', () => {
    storageMap.clear()
    const doc = new FakeDocument()
    const host = makeHost(doc, 900, 700)
    const game = api.createGame(host)
    flushFrames()
    const initial = recordState(game).pieces.map((p) => p.x + ',' + p.y)
    game.__test.doUndo()
    flushFrames()
    ok(game.getView().moves === 0, 'undo on empty history leaves moves at 0')
    const state = game.getState()
    let moved = false
    for (let i = 0; i < state.pieces.length && !moved; i += 1) {
      const moves = api.listMoves(state, i)
      if (moves.length) {
        game.__test.doMove(i, moves[0].dx, moves[0].dy, moves[0].step)
        moved = true
      }
    }
    ok(moved, 'some move must be possible')
    ok(game.getView().moves === 1, 'moves should be 1 after a legal move')
    game.__test.doUndo()
    flushFrames()
    ok(game.getView().moves === 0, 'undo should restore moves to 0')
    assert.deepStrictEqual(game.getState().pieces.map((p) => p.x + ',' + p.y), initial, 'undo should restore initial arrangement')
    game.destroy()
  })

  check('restart resets the current level (moves/timer/started)', () => {
    storageMap.clear()
    const doc = new FakeDocument()
    const host = makeHost(doc, 900, 700)
    const game = api.createGame(host)
    flushFrames()
    const state = game.getState()
    for (let i = 0; i < state.pieces.length; i += 1) {
      const moves = api.listMoves(state, i)
      if (moves.length) {
        game.__test.doMove(i, moves[0].dx, moves[0].dy, moves[0].step)
        break
      }
    }
    game.__test.doRestart()
    flushFrames()
    const view = game.getView()
    ok(view.moves === 0, 'restart resets moves')
    ok(view.started === false, 'restart resets started')
    ok(view.timing === false, 'restart stops the timer')
    ok(view.elapsedMs === 0, 'restart resets elapsed')
    game.destroy()
  })

  check('level switch loads the selected layout and resets progress', () => {
    storageMap.clear()
    const doc = new FakeDocument()
    const host = makeHost(doc, 900, 700)
    const game = api.createGame(host)
    flushFrames()
    game.__test.doSetLevel(2)
    flushFrames()
    const view = game.getView()
    ok(view.levelIndex === 2, 'level index should be 2')
    ok(view.moves === 0 && view.started === false, 'progress reset on level switch')
    assert.deepStrictEqual(
      game.getState().pieces.map((p) => p.x + ',' + p.y),
      api.LEVELS[2].pieces.map((p) => p.x + ',' + p.y),
      'level 3 initial arrangement',
    )
    const active = game.__test.levelChips.filter((chip) => chip.classList.contains('dshklt-chip--active'))
    ok(active.length === 1, 'exactly one active level chip')
    game.destroy()
  })

  check('document.hidden pauses the timer, visible resumes without time jump', () => {
    storageMap.clear()
    const doc = new FakeDocument()
    const host = makeHost(doc, 900, 700)
    const game = api.createGame(host)
    flushFrames()
    const state = game.getState()
    for (let i = 0; i < state.pieces.length; i += 1) {
      const moves = api.listMoves(state, i)
      if (moves.length) {
        game.__test.doMove(i, moves[0].dx, moves[0].dy, moves[0].step)
        break
      }
    }
    flushFrames()
    ok(game.getView().timing === true, 'timer should run after the first move')
    doc.setHidden(true)
    flushFrames()
    const hiddenView = game.getView()
    ok(hiddenView.hidden === true, 'hidden flag')
    ok(hiddenView.timing === false, 'timer must pause while hidden')
    const frozenElapsed = hiddenView.elapsedMs
    ok(storage.getItem(api.STORE_KEY) !== null, 'hiding should persist the state')
    doc.setHidden(false)
    flushFrames()
    const visibleView = game.getView()
    ok(visibleView.hidden === false, 'visible flag')
    ok(visibleView.timing === true, 'timer resumes when visible again')
    ok(Math.abs(visibleView.elapsedMs - frozenElapsed) < 500, 'no time jump on resume: ' + frozenElapsed + ' -> ' + visibleView.elapsedMs)
    game.destroy()
  })

  check('auto-save on destroy: schema v1 + last arrangement persisted; destroy idempotent', () => {
    storageMap.clear()
    const doc = new FakeDocument()
    const host = makeHost(doc, 900, 700)
    const game = api.createGame(host)
    flushFrames()
    const state = game.getState()
    for (let i = 0; i < state.pieces.length; i += 1) {
      const moves = api.listMoves(state, i)
      if (moves.length) {
        game.__test.doMove(i, moves[0].dx, moves[0].dy, moves[0].step)
        break
      }
    }
    const lastState = recordState(game)
    const root = host.children[0]
    game.destroy()
    game.destroy() // idempotent
    ok(host.children.length === 0, 'root removed from host')
    ok(roInstances[roInstances.length - 1].disconnected === true, 'ResizeObserver disconnected')
    const raw = storage.getItem(api.STORE_KEY)
    ok(raw !== null, 'state persisted on destroy')
    const persisted = JSON.parse(raw)
    ok(persisted.schemaVersion === 1, 'persisted schemaVersion must be 1')
    assert.deepStrictEqual(persisted.pieces, lastState.pieces, 'persisted arrangement should be the last arrangement')
    ok(root.parentNode === null, 'detached root parentNode null')
    ok(storageMap.size === 1 && storageMap.has(api.STORE_KEY), 'only the documented key is written')
  })

  check('destroy then remount restores the saved state (return to the game page)', () => {
    const doc = new FakeDocument()
    const hostA = makeHost(doc, 900, 700)
    const gameA = api.createGame(hostA)
    flushFrames()
    gameA.__test.doSetLevel(1)
    flushFrames()
    const stateA = gameA.getState()
    for (let i = 0; i < stateA.pieces.length; i += 1) {
      const moves = api.listMoves(stateA, i)
      if (moves.length) {
        gameA.__test.doMove(i, moves[0].dx, moves[0].dy, moves[0].step)
        break
      }
    }
    const expected = recordState(gameA)
    gameA.destroy()
    const hostB = makeHost(doc, 900, 700)
    const gameB = api.createGame(hostB)
    flushFrames()
    const view = gameB.getView()
    ok(view.levelIndex === expected.levelIndex, 'remount restores the level')
    ok(view.moves === expected.moves, 'remount restores move count')
    assert.deepStrictEqual(recordState(gameB).pieces, expected.pieces, 'remount restores the arrangement')
    gameB.destroy()
  })

  check('<320x240 host shows the too-small hint instead of a broken board', () => {
    storageMap.clear()
    const doc = new FakeDocument()
    const host = makeHost(doc, 200, 150)
    const game = api.createGame(host)
    flushFrames()
    const view = game.getView()
    ok(view.tooSmall === true, 'tooSmall should be true for a 200x150 host')
    ok(view.layout === null, 'layout should be null when too small')
    const root = host.children[0]
    ok(root.classList.contains('dshklt-root--small'), 'too-small class on the root')
    const hint = root.find((el) => el.classList.contains('dshklt-too-small'))
    ok(hint.length === 1 && hint[0].textContent.includes('窗口太小'), 'readable too-small hint text')
    game.destroy()
  })

  check('markers: one marker per entered cell (potential duplicate DOM nodes per move)', () => {
    storageMap.clear()
    const doc = new FakeDocument()
    const host = makeHost(doc, 900, 700)
    const game = api.createGame(host)
    flushFrames()
    // Free the two cells under Guan Yu so it can slide down exactly one cell.
    game.__test.doMove(6, 0, 1, 1) // bing1 (1,3) -> (1,4)
    game.__test.doMove(7, 0, 1, 1) // bing2 (2,3) -> (2,4)
    flushFrames()
    const state = game.getState()
    const guanIndex = state.pieces.findIndex((p) => p.id === 'guan')
    game.__test.selectPiece(guanIndex)
    flushFrames()
    const dest = api.destinations(state, guanIndex)
    const distinctMoves = new Set(Object.values(dest).map((m) => m.pieceIndex + ':' + m.dx + ':' + m.dy + ':' + m.step))
    const markerEls = game.__test.markersLayer.children
    const markerTargets = markerEls.map((el) => el.getAttribute('data-target'))
    const duplicateTargets = markerTargets.filter((target, index) => markerTargets.indexOf(target) !== index)
    // Report (do not fail): a multi-cell piece enters several empty cells for one
    // slide, and renderMarkers draws one marker per key, so identical markers can
    // be stacked at the same destination.
    if (markerEls.length !== distinctMoves.size) {
      notes.push({
        id: 'duplicate-markers',
        severity: 'note',
        text:
          'renderMarkers() draws one marker per destinations() key, but destinations() is keyed by every entered empty cell. ' +
          'A slide of a w>1/h>1 piece therefore stacks duplicate markers at the same final cell (markers=' + markerEls.length + ', distinct moves=' + distinctMoves.size + ', duplicate data-target=' + JSON.stringify(duplicateTargets) + '). ' +
          'Visually harmless (identical stacked markers) and clicks still work; extra DOM nodes only. Repro: this check in dev/audit/fake-dom.mjs.',
      })
    }
    ok(markerEls.length >= distinctMoves.size, 'every move should be reachable through markers')
    game.destroy()
  })

  check('pending winning save mounts with the win overlay, moves blocked', () => {    storageMap.clear()
    storage.setItem(api.STORE_KEY, JSON.stringify(winningSave()))
    const doc = new FakeDocument()
    const host = makeHost(doc, 900, 700)
    const game = api.createGame(host)
    flushFrames()
    const view = game.getView()
    ok(view.won === true, 'won state restored')
    ok(view.timing === false, 'timer must not run for a finished game')
    ok(game.__test.winOverlay.classList.contains('dshklt-win--show'), 'win overlay visible')
    ok(game.__test.undoButton.disabled === true, 'undo disabled after win')
    const before = recordState(game)
    game.__test.doUndo()
    flushFrames()
    assert.deepStrictEqual(recordState(game).pieces, before.pieces, 'undo must be a no-op after a win')
    game.destroy()
  })
} finally {
  uninstallFakeGlobals()
}

/* ---------------------------------------------------------------- results */

console.log('\n--- Result ---')
console.log(JSON.stringify({ checks, failures, notes }, null, 2))
if (failures.length > 0) {
  console.error('\nSUITE 6 FAILED: ' + failures.length + ' check(s)')
  process.exitCode = 1
} else {
  console.log('\nSUITE 6 PASS — ' + checks + ' fake-DOM lifecycle checks.')
}
