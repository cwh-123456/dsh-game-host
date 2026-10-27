/**
 * drag-audit.mjs — independent audit of the pointer-driven drag & drop layer.
 *
 * Run (repo root):
 *   node packages/dsh-game-solitaire/dev/audit/drag-audit.mjs
 *   node packages/dsh-game-solitaire/dev/audit/drag-audit.mjs --verbose
 * Read-only. Exit 0 = all drag requirements hold.
 *
 * Artifact: client.js sha256 d0549f77… (89,639 B, drag build).
 *
 * What is checked, and how (deliberately independent of the implementation):
 *   1. Geometry hit-testing: for random and boundary pointer positions over several
 *      sizes/states, the client's drag.target is compared against an independent
 *      hit-test built from computeLayout() fields (rect margin = max(4, 6% cardW),
 *      foundation order 0..3 then tableau 0..6) combined with the oracle's canDrop
 *      legality — NOT by replaying the client's findDropTarget.
 *   2. Sources: waste top, face-up tableau run (any index), foundation top; card lists,
 *      floating origin offsets, view.drag fields; face-down / stock / no-dataset cards
 *      must not start a drag.
 *   3. Threshold/coexistence: < 6 px does nothing and leaves click-to-select working;
 *      >= 6 px activates, clears selection, sets pointer capture once; the post-drag
 *      click is swallowed exactly once (clickCapture); below-threshold clicks are not.
 *   4. Failed/illegal drop, drop-outside, pointercancel: state piles, moves, undo and
 *      localStorage unchanged; readable message equals the client's canDrop reason.
 *   5. Cleanup: no window/document pointer* listeners ever; host pointer capture is
 *      released on finish; destroy mid-drag leaves the controller inert; no writes after.
 *   6. Static wiring: threshold constant, seam methods, data-dshsol-* attributes only on
 *      movable cards, board-scoped React pointer handlers, touch-action:none, clickCapture
 *      stopPropagation/preventDefault.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as ref from './reference-solitaire.mjs'
import {
  seam, env, resetEnv, makeHost, clientPilesToCanonical, canonicalToClientPiles,
  selectionToRef, targetToRef, listenerTypes,
} from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', '..', 'client.js')
const clientSource = readFileSync(CLIENT_PATH, 'utf8')

const STORE_KEY = seam.STORE_KEY
const DRAG_THRESHOLD = 6
const SUIT_ORDER = ['S', 'H', 'D', 'C']
const argv = process.argv.slice(2)
const VERBOSE = argv.includes('--verbose')

/* ------------------------------------------------------------------ *
 * Counters / test harness
 * ------------------------------------------------------------------ */
let passed = 0
let checks = 0
const failures = []
let currentGame = null
let latestView = null
const stats = {
  geometryPoints: 0,
  geometrySources: 0,
  drops: 0,
  illegalDrops: 0,
  thresholdProbes: 0,
  suppressionProbes: 0,
}

async function test(name, fn) {
  resetEnv()
  latestView = null
  try {
    await fn()
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

function check(condition, message) {
  checks += 1
  assert.ok(condition, message)
}

/* ------------------------------------------------------------------ *
 * Fake host (with pointer capture tracking)
 * ------------------------------------------------------------------ */
function mount(rect) {
  const host = makeHost(rect || env.hostRect)
  host.captures = { set: [], released: [] }
  host.setPointerCapture = function (id) {
    host.captures.set.push(id)
  }
  host.releasePointerCapture = function (id) {
    host.captures.released.push(id)
  }
  currentGame = seam.createGame(host, {
    onState(view) {
      latestView = view
    },
  })
  return { game: currentGame, host }
}

function stateOf(game) {
  return game.getState()
}

function canonicalOf(game) {
  return clientPilesToCanonical(game.getState())
}

function oracleOf(game) {
  return ref.importPiles(canonicalOf(game))
}

/* ------------------------------------------------------------------ *
 * Event / DOM stubs
 * ------------------------------------------------------------------ */
function cardElement(source) {
  const dataset = { dshsolCard: '1' }
  if (source.kind === 'tableau') {
    dataset.dshsolKind = 'tableau'
    dataset.dshsolCol = String(source.col)
    dataset.dshsolIndex = String(source.index)
  } else if (source.kind === 'waste') {
    dataset.dshsolKind = 'waste'
  } else if (source.kind === 'foundation') {
    dataset.dshsolKind = 'foundation'
    dataset.dshsolPile = String(source.pile)
  }
  return {
    dataset,
    closest(selector) {
      return selector === '[data-dshsol-card]' ? this : null
    },
  }
}

function plainElement() {
  return {
    closest() {
      return null
    },
  }
}

function makeEvent(target, x, y, extra) {
  const event = {
    target,
    clientX: x,
    clientY: y,
    button: 0,
    isPrimary: true,
    pointerId: 1,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      event.defaultPrevented = true
    },
    stopPropagation() {
      event.propagationStopped = true
    },
  }
  return Object.assign(event, extra || {})
}

function pointerDown(game, source, x, y, extra) {
  game.pointerDown(makeEvent(cardElement(source), x, y, extra))
}

function pointerMove(game, x, y, extra) {
  game.pointerMove(makeEvent(plainElement(), x, y, extra))
}

function pointerUp(game, x, y, extra) {
  game.pointerUp(makeEvent(plainElement(), x, y, extra))
}

function pointerCancel(game, extra) {
  game.pointerCancel(makeEvent(plainElement(), 0, 0, extra))
}

/* ------------------------------------------------------------------ *
 * Independent geometry: layout fields -> hit rects -> validity via oracle
 * ------------------------------------------------------------------ */
function layoutOf(game) {
  return game.snapshot().layout
}

function independentOrigin(layout, clientState, source) {
  if (source.kind === 'tableau') {
    const offsets = layout.colOffsets[source.col] || []
    return {
      left: layout.colX[source.col],
      top: layout.tableauTop + (offsets[source.index] || 0),
    }
  }
  if (source.kind === 'waste') {
    const visible = Math.min(3, clientState.waste.length)
    return {
      left: layout.wasteX + Math.max(0, visible - 1) * layout.wasteFanStep,
      top: layout.topY,
    }
  }
  return { left: layout.foundationX[source.pile], top: layout.topY }
}

function expectedCards(clientState, source) {
  if (source.kind === 'waste') return [clientState.waste[clientState.waste.length - 1]]
  if (source.kind === 'foundation') {
    const pile = clientState.foundations[source.pile]
    return [pile[pile.length - 1]]
  }
  return clientState.tableau[source.col].slice(source.index).map((card) => card.id)
}

/** Legal drop targets for `source`, judged by the independent oracle only. */
function legalKeys(oracleState, source) {
  const keys = new Set()
  const refSource = selectionToRef(source)
  for (let pile = 0; pile < 4; pile += 1) {
    if (ref.canDrop(oracleState, refSource, { zone: 'foundation', suit: SUIT_ORDER[pile] }, { allowFromFoundation: true }).ok) {
      keys.add('foundation:' + pile)
    }
  }
  for (let col = 0; col < 7; col += 1) {
    if (ref.canDrop(oracleState, refSource, { zone: 'tableau', col }, { allowFromFoundation: true }).ok) keys.add('tableau:' + col)
  }
  return keys
}

function keyOfTarget(target) {
  if (!target) return null
  return target.kind === 'foundation' ? 'foundation:' + target.pile : 'tableau:' + target.col
}

/**
 * Independent hit-test, derived only from layout fields:
 *   pad = max(4, cardW * 6%) ; foundations (pile 0..3) first, then tableau (col 0..6);
 *   first geometrically hit AND legally droppable target wins; otherwise the first
 *   geometrically hit but illegal target is the hovered (message) target.
 */
function independentHit(layout, x, y, legal) {
  const pad = Math.max(4, layout.cardW * 0.06)
  let hovered = null
  for (let pile = 0; pile < 4; pile += 1) {
    const left = layout.foundationX[pile]
    const top = layout.topY
    if (x >= left - pad && x <= left + layout.cardW + pad && y >= top - pad && y <= top + layout.cardH + pad) {
      if (legal.has('foundation:' + pile)) return { valid: { kind: 'foundation', pile }, hovered: null }
      if (!hovered) hovered = { kind: 'foundation', pile }
    }
  }
  const tableauBottom = layout.tableauTop + layout.tableauH
  for (let col = 0; col < 7; col += 1) {
    const left = layout.colX[col]
    if (x < left - pad || x > left + layout.cardW + pad) continue
    if (y < layout.tableauTop - pad || y > tableauBottom + pad) continue
    if (legal.has('tableau:' + col)) return { valid: { kind: 'tableau', col }, hovered: null }
    if (!hovered) hovered = { kind: 'tableau', col }
  }
  return { valid: null, hovered }
}

/* ------------------------------------------------------------------ *
 * Drag driving helpers
 * ------------------------------------------------------------------ */
function startDrag(game, source) {
  const layout = layoutOf(game)
  const origin = independentOrigin(layout, stateOf(game), source)
  const startX = origin.left + layout.cardW * 0.5
  const startY = origin.top + layout.cardH * 0.35
  pointerDown(game, source, startX, startY)
  const drag = game.getDrag()
  return { layout, origin, startX, startY, dragAfterDown: drag }
}

function activateDrag(game, start) {
  pointerMove(game, start.startX + 10, start.startY + 10)
  return game.getDrag()
}

function finishAt(game, x, y) {
  pointerMove(game, x, y)
  const target = game.getDrag() ? game.getDrag().target : null
  pointerUp(game, x, y)
  return target
}

/* ------------------------------------------------------------------ *
 * Constructed full-deck states
 * ------------------------------------------------------------------ */
function allCodes() {
  const codes = []
  for (const suit of ref.SUITS) {
    for (let rank = 1; rank <= 13; rank += 1) codes.push(ref.RANK_LABELS[rank] + suit)
  }
  return codes
}

function fullCanonical(spec) {
  const used = new Set()
  const foundations = {}
  for (const suit of ref.SUITS) {
    foundations[suit] = (spec.foundations && spec.foundations[suit]) || []
    for (const code of foundations[suit]) used.add(code)
  }
  const tableau = []
  for (let col = 0; col < 7; col += 1) {
    const source = (spec.tableau && spec.tableau[col]) || []
    tableau.push(source.map((entry) => {
      const code = typeof entry === 'string' ? entry : entry.c
      used.add(code)
      return { c: code, up: typeof entry === 'string' ? true : !!entry.up }
    }))
  }
  const waste = (spec.waste || []).map((code) => {
    used.add(code)
    return code
  })
  const stock = spec.stock || allCodes().filter((code) => !used.has(code))
  for (const code of stock) used.add(code)
  if (used.size !== 52) throw new Error(`state places ${used.size} cards`)
  return { stock, waste, tableau, foundations, moves: 0, won: false }
}

function stateFromCanonical(canonical, meta) {
  const piles = canonicalToClientPiles(canonical)
  return Object.assign({
    seed: 777,
    started: true,
    won: false,
    moves: 0,
    elapsedMs: 0,
    undo: [],
  }, piles, meta || {})
}

function saveJson(canonical, meta) {
  return JSON.stringify(seam.serializeState(stateFromCanonical(canonical, meta)))
}

function mountState(canonical, rect, meta) {
  env.storage.set(STORE_KEY, saveJson(canonical, meta))
  return mount(rect)
}

/* ------------------------------------------------------------------ *
 * 1. Static wiring checks
 * ------------------------------------------------------------------ */
async function staticChecks() {
  await test('static: drag wiring is board-scoped and gated to movable cards', () => {
    check(/const DRAG_THRESHOLD = 6\b/.test(clientSource), 'DRAG_THRESHOLD constant missing')
    check(/if \(dx \* dx \+ dy \* dy < DRAG_THRESHOLD \* DRAG_THRESHOLD\) return/.test(clientSource), 'threshold comparison missing')
    check(/pointerDown: pointerDown,\s*pointerMove: pointerMove,\s*pointerUp: pointerUp,\s*pointerCancel: pointerCancel,\s*clickCapture: clickCapture,/.test(clientSource), 'createGame pointer API missing')
    check(/getDrag: function \(\) \{/.test(clientSource), 'getDrag missing')
    check(
      !/(?:window|document|globalThis)\s*\.\s*addEventListener\s*\(\s*['"](?:pointerdown|pointermove|pointerup|pointercancel|pointerenter|pointerleave)['"]/.test(clientSource),
      'global pointer listener must not exist',
    )
    check(/touch-action:none/.test(clientSource), 'touch-action:none missing on board')
    check(/onClickCapture: onClickCapture/.test(clientSource), 'clickCapture not wired as React capture handler')
    check(/onPointerDown: onPointerDown/.test(clientSource), 'pointer handlers not wired on board')
    check(/const boardRef = React\.useRef\(null\)/.test(clientSource), 'board ref missing')
    check(/host\.setPointerCapture\(drag\.pointerId\)/.test(clientSource), 'pointer capture not set after threshold')
    check(/host\.releasePointerCapture\(finished\.pointerId\)/.test(clientSource), 'pointer capture not released on finish')
    check(/target\.closest\(\s*['"]\[data-dshsol-card\]['"]\s*\)/.test(clientSource), 'pointerDown source lookup by data attribute missing')
    // data attributes only when spec.dragSource
    const dragSourceIndex = clientSource.indexOf('if (spec.dragSource) {')
    const dragSourceBlock = dragSourceIndex >= 0 ? clientSource.slice(dragSourceIndex, clientSource.indexOf('return h(', dragSourceIndex)) : ''
    check(/data-dshsol-card/.test(dragSourceBlock), 'data-dshsol-card not gated by spec.dragSource')
    // waste: only top card; foundation: only the top card node; tableau: face-up cards
    check(/dragSource: isTop/.test(clientSource), 'waste dragSource must be top-only')
    check(/dragSource: card\.up/.test(clientSource), 'tableau dragSource must be face-up only')
    const foundationBlock = clientSource.slice(clientSource.indexOf('topCard >= 0'), clientSource.indexOf('topCard >= 0') + 1400)
    check(/dragSource: true/.test(foundationBlock), 'foundation dragSource missing on its top card')
    // stock is not draggable: no dragSource between the StockSlot and WasteSlot definitions
    const stockStart = clientSource.indexOf('function StockSlot')
    const wasteStart = clientSource.indexOf('function WasteSlot')
    check(!/dragSource:/.test(clientSource.slice(stockStart, wasteStart)), 'stock must not be draggable')
    check(/suppressClick = true/.test(clientSource) && /suppressClick = false/.test(clientSource), 'click suppression flag missing')
  })
}

/* ------------------------------------------------------------------ *
 * 2. Threshold / activation semantics
 * ------------------------------------------------------------------ */
async function thresholdChecks() {
  await test('threshold: 5px inert, 6px boundary activates, 7px activates; below-threshold keeps click path', () => {
    const source = { kind: 'waste' }

    for (const [dx, dy, expected] of [[5, 0, false], [0, 5, false], [6, 0, true], [0, 7, true], [7, 7, true]]) {
      resetEnv()
      env.storage.set(STORE_KEY, saveJson(fullCanonical({ foundations: {}, tableau: [['2H'], [], [], [], [], [], []] })))
      const mounted = mount({ width: 1024, height: 700 })
      const g = mounted.game
      const start = startDrag(g, { kind: 'tableau', col: 0, index: 0 })
      pointerMove(g, start.startX + dx, start.startY + dy)
      const drag = g.getDrag()
      stats.thresholdProbes += 1
      check(!!drag, 'a pending drag object should exist right after pointerdown')
      check(drag.active === expected, `threshold ${dx},${dy}: active=${drag.active}, expected ${expected}`)
      if (expected) {
        check(g.getSelection() === null, 'activation must clear selection')
        check(mounted.host.captures.set.length === 1, 'activation must set pointer capture once')
      } else {
        check(mounted.host.captures.set.length === 0, 'below-threshold must not capture')
        pointerUp(g, start.startX + dx, start.startY + dy)
        check(g.getDrag() === null, 'below-threshold pointerup clears the pending drag')
      }
      g.destroy()
      currentGame = null
    }

    // below-threshold pointerup leaves state untouched and does not swallow the click
    resetEnv()
    const m2 = mount({ width: 1024, height: 700 })
    const g2 = m2.game
    g2.newGame(11)
    g2.drawFromStock()
    const before2 = JSON.stringify(canonicalOf(g2))
    const start2 = startDrag(g2, source)
    pointerMove(g2, start2.startX + 3, start2.startY + 3)
    pointerUp(g2, start2.startX + 3, start2.startY + 3)
    check(g2.getDrag() === null, 'no leftover drag after below-threshold up')
    check(JSON.stringify(canonicalOf(g2)) === before2, 'below-threshold must not change state')
    const clickEvent = makeEvent(plainElement(), 0, 0)
    g2.clickCapture(clickEvent)
    stats.suppressionProbes += 1
    check(!clickEvent.defaultPrevented && !clickEvent.propagationStopped, 'below-threshold click must NOT be swallowed')
    g2.onWasteClick()
    check(g2.getSelection() && g2.getSelection().kind === 'waste', 'click-to-select must still work after a below-threshold pointerup')
  })
}

/* ------------------------------------------------------------------ *
 * 3. Sources: cards, origins, offsets, view.drag fields
 * ------------------------------------------------------------------ */
async function sourceChecks() {
  await test('sources: waste top / tableau run / foundation top; face-down & no-dataset start nothing', () => {
    const { game, host } = mount({ width: 1024, height: 700 })
    game.newGame(7)
    game.drawFromStock()
    game.drawFromStock()
    let state = stateOf(game)
    check(state.waste.length === 2, 'expected 2 waste cards')
    check(latestView && latestView.drag === null, 'view.drag must be null when idle')

    // waste source
    const wasteStart = startDrag(game, { kind: 'waste' })
    const wasteDrag = activateDrag(game, wasteStart)
    check(wasteDrag.active === true, 'waste drag did not activate')
    check(JSON.stringify(wasteDrag.cards) === JSON.stringify(expectedCards(state, { kind: 'waste' })), 'waste drag cards wrong')
    check(
      Math.abs(wasteDrag.x - (wasteStart.startX + 10)) < 1e-9 && Math.abs(wasteDrag.y - (wasteStart.startY + 10)) < 1e-9,
      'drag x/y must follow the pointer',
    )
    // getDrag() exposes x/y only; offsets live on view.drag (floating-stack origin)
    check(latestView && latestView.drag, 'view.drag must exist while dragging')
    check(
      Math.abs(latestView.drag.offsetX - (wasteStart.startX - wasteStart.origin.left)) < 1e-6,
      `waste offsetX wrong: ${latestView.drag.offsetX} vs ${wasteStart.startX - wasteStart.origin.left}`,
    )
    check(
      Math.abs(latestView.drag.offsetY - (wasteStart.startY - wasteStart.origin.top)) < 1e-6,
      `waste offsetY wrong: ${latestView.drag.offsetY} vs ${wasteStart.startY - wasteStart.origin.top}`,
    )
    const layout = layoutOf(game)
    check(latestView && latestView.drag, 'view.drag must exist while dragging')
    check(latestView.drag.step === Math.max(6, layout.faceUpBase), 'view.drag.step mismatch')
    check(JSON.stringify(latestView.drag.cards) === JSON.stringify(wasteDrag.cards), 'view.drag.cards mismatch')
    check(JSON.stringify(latestView.drag.source) === JSON.stringify(wasteDrag.source), 'view.drag.source mismatch')
    check(keyOfTarget(latestView.drag.target) === keyOfTarget(wasteDrag.target), 'view.drag.target mismatch')
    pointerCancel(game)

    // capture is set exactly once per activated drag and many pointermoves do not duplicate it
    const captureBefore = host.captures.set.length
    const captureStart = startDrag(game, { kind: 'waste' })
    activateDrag(game, captureStart)
    for (let i = 0; i < 20; i += 1) pointerMove(game, 100 + i * 7, 300 + i * 5)
    check(host.captures.set.length === captureBefore + 1, `pointer capture must be set once per drag, got ${host.captures.set.length - captureBefore}`)
    pointerCancel(game)

    // defensive: pointerup/cancel with no drag and a click event without methods never throw
    let threw = false
    try {
      game.pointerUp(makeEvent(plainElement(), 0, 0))
      game.pointerCancel(makeEvent(plainElement(), 0, 0))
      game.clickCapture({})
    } catch (error) {
      threw = true
    }
    check(!threw, 'pointer/click handlers must tolerate missing drag/event methods')

    // too-small stage: no layout -> drag origin missing -> no drag starts
    resetEnv()
    const tiny = mount({ width: 300, height: 200 })
    check(tiny.game.snapshot().tooSmall === true, 'tiny stage should be too small')
    const tinyState = stateOf(tiny.game)
    let tinySource = null
    for (let col = 0; col < 7 && !tinySource; col += 1) {
      const index = tinyState.tableau[col].findIndex((card) => card.up)
      if (index >= 0) tinySource = { kind: 'tableau', col, index }
    }
    tiny.game.pointerDown(makeEvent(cardElement(tinySource), 100, 160))
    check(tiny.game.getDrag() === null, 'no drag can start while the stage is too small (no layout)')
    tiny.game.destroy()
    currentGame = null

    // tableau run source: find a column with a face-up run length >= 2 if possible
    state = stateOf(game)
    let runSource = null
    for (let col = 0; col < 7 && !runSource; col += 1) {
      const column = state.tableau[col]
      for (let index = 0; index < column.length; index += 1) {
        if (column[index].up && column.length - index >= 2) {
          runSource = { kind: 'tableau', col, index }
          break
        }
      }
    }
    if (!runSource) {
      for (let col = 0; col < 7 && !runSource; col += 1) {
        const column = state.tableau[col]
        const index = column.findIndex((card) => card.up)
        if (index >= 0) runSource = { kind: 'tableau', col, index }
      }
    }
    check(!!runSource, 'no face-up tableau card to drag')
    {
      const start = startDrag(game, runSource)
      const drag = activateDrag(game, start)
      check(drag.active, 'tableau drag did not activate')
      check(JSON.stringify(drag.cards) === JSON.stringify(expectedCards(state, runSource)), 'tableau drag cards wrong')
      pointerCancel(game)
    }

    // foundation top source (constructed: spade foundation has AS)
    resetEnv()
    const constructed = fullCanonical({ foundations: { S: ['AS'] }, tableau: [['2H'], [], [], [], [], [], []] })
    const m2 = mountState(constructed, { width: 900, height: 640 })
    const g2 = m2.game
    const finalState = stateOf(g2)
    check(finalState.foundations[0].length === 1, 'constructed foundation not loaded')
    const fStart = startDrag(g2, { kind: 'foundation', pile: 0 })
    const fDrag = activateDrag(g2, fStart)
    check(fDrag.active, 'foundation drag did not activate')
    check(JSON.stringify(fDrag.cards) === JSON.stringify(expectedCards(finalState, { kind: 'foundation', pile: 0 })), 'foundation drag cards wrong')
    pointerCancel(g2)

    // face-down card: no data-* -> no drag (the rendering only sets data attrs for up cards)
    resetEnv()
    const m3 = mountState(fullCanonical({ tableau: [[{ c: '5H', up: false }, '4S'], [], [], [], [], [], []] }), { width: 900, height: 640 })
    const g3 = m3.game
    g3.pointerDown(makeEvent({ closest: () => null, dataset: {} }, 100, 300))
    check(g3.getDrag() === null, 'face-down / no-dataset pointerdown must not start a drag')
    // stock is not draggable: same, but make sure a fake stock element (no dataset) does nothing
    g3.pointerDown(makeEvent({ closest: () => null, dataset: {} }, 100, 100))
    check(g3.getDrag() === null, 'stock pointerdown must not start a drag')

    // non-primary button / non-primary pointer ignored
    g3.pointerDown(makeEvent(cardElement({ kind: 'tableau', col: 0, index: 1 }), 100, 300, { button: 2 }))
    check(g3.getDrag() === null, 'right button must not start a drag')
    g3.pointerDown(makeEvent(cardElement({ kind: 'tableau', col: 0, index: 1 }), 100, 300, { isPrimary: false }))
    check(g3.getDrag() === null, 'non-primary pointer must not start a drag')

    // second pointerDown while dragging is ignored
    const start3 = startDrag(g3, { kind: 'tableau', col: 0, index: 1 })
    const firstSource = JSON.stringify(g3.getDrag().source)
    g3.pointerDown(makeEvent(cardElement({ kind: 'waste' }), 500, 500))
    check(JSON.stringify(g3.getDrag().source) === firstSource, 're-entrant pointerDown must keep the first drag')
    // wrong pointerId move/up ignored
    pointerMove(g3, start3.startX + 40, start3.startY + 40, { pointerId: 99 })
    check(g3.getDrag().active === false, 'move with a different pointerId must be ignored')
    pointerUp(g3, start3.startX + 40, start3.startY + 40, { pointerId: 99 })
    check(g3.getDrag() !== null, 'up with a different pointerId must be ignored')
    pointerCancel(g3)
    check(g3.getDrag() === null, 'pointercancel clears drag')
  })
}

/* ------------------------------------------------------------------ *
 * 4. Geometry hit-testing fuzz
 * ------------------------------------------------------------------ */
async function geometryChecks() {
  await test('geometry: drag.target vs independent hit-test (random + boundary points)', () => {
    const sizes = [
      { width: 360, height: 520 },
      { width: 480, height: 640 },
      { width: 720, height: 600 },
      { width: 1024, height: 700 },
      { width: 1600, height: 1000 },
    ]
    const stateDefs = [
      {
        name: 'deal-1',
        build(size) {
          const m = mount(size)
          m.game.newGame(1)
          return m
        },
      },
      {
        name: 'waste-3',
        build(size) {
          const m = mount(size)
          m.game.newGame(3)
          for (let i = 0; i < 3; i += 1) m.game.drawFromStock()
          return m
        },
      },
      {
        name: 'k-run',
        build(size) {
          return mountState(fullCanonical({ tableau: [['KH', 'QS'], ['9D'], [], [], [], [], []] }), size)
        },
      },
      {
        name: 'foundation',
        build(size) {
          return mountState(fullCanonical({ foundations: { S: ['AS', '2S'] }, tableau: [['3H'], ['10C'], [], [], [], [], []] }), size)
        },
      },
    ]

    let mismatchCount = 0
    const firstMismatches = []
    let dragSourcesCount = 0
    const coverage = { validHits: 0, invalidHovers: 0, empty: 0, uniqueTargets: new Set() }

    stateDefs.forEach((stateDef, stateIndex) => {
      sizes.forEach((size, sizeIndex) => {
        resetEnv()
        const { game } = stateDef.build(size)
        const clientState = stateOf(game)
        const layout = layoutOf(game)
        check(!!layout, `no layout at ${size.width}x${size.height}`)

        // collect the drag sources this board actually offers
        const sources = []
        if (clientState.waste.length) sources.push({ kind: 'waste' })
        for (let pile = 0; pile < 4; pile += 1) {
          if (clientState.foundations[pile].length) sources.push({ kind: 'foundation', pile })
        }
        clientState.tableau.forEach((column, col) => {
          column.forEach((card, index) => {
            if (card.up) sources.push({ kind: 'tableau', col, index })
          })
        })
        const sampled = sources.filter((source, index) => index % Math.max(1, Math.floor(sources.length / 5)) === 0).slice(0, 6)
        if (!sampled.length) sampled.push({ kind: 'waste' })

        const pad = Math.max(4, layout.cardW * 0.06)
        const points = []
        const rng = ref.makeRng((stateIndex * 1000 + sizeIndex * 37 + 5) >>> 0)
        for (let i = 0; i < 30; i += 1) {
          points.push({
            x: -pad + rng() * (layout.width + 2 * pad),
            y: -pad + rng() * (layout.height + 2 * pad),
            kind: 'random',
          })
        }
        // systematic boundary probes around every foundation and column rect
        for (let pile = 0; pile < 4; pile += 1) {
          const left = layout.foundationX[pile]
          const top = layout.topY
          for (const [dx, dy] of [[-pad - 1, 0], [pad + 1, 0], [0, -pad - 1], [0, pad + 1], [layout.cardW / 2, layout.cardH / 2]]) {
            points.push({ x: left + dx, y: top + dy, kind: 'foundation-boundary:' + pile })
          }
        }
        const tableauBottom = layout.tableauTop + layout.tableauH
        for (let col = 0; col < 7; col += 1) {
          const left = layout.colX[col]
          for (const [dx, dy] of [[-pad - 1, 0], [pad + 1, 0], [0, -pad - 1], [0, pad + 1], [layout.cardW / 2, layout.tableauH / 2]]) {
            points.push({ x: left + dx, y: layout.tableauTop + dy, kind: 'column-boundary:' + col })
          }
        }
        points.push({ x: -pad - 30, y: layout.height / 2, kind: 'left-outside' })
        points.push({ x: layout.width + pad + 30, y: layout.height / 2, kind: 'right-outside' })
        points.push({ x: layout.width / 2, y: -pad - 30, kind: 'top-outside' })
        points.push({ x: layout.width / 2, y: layout.height + pad + 30, kind: 'bottom-outside' })

        for (const source of sampled) {
          dragSourcesCount += 1
          const start = startDrag(game, source)
          activateDrag(game, start)
          const legal = legalKeys(oracleOf(game), source)
          const drag = game.getDrag()
          check(!!drag && drag.active, `drag not active for ${JSON.stringify(source)}`)

          for (const point of points) {
            pointerMove(game, point.x, point.y)
            const expected = independentHit(layout, point.x, point.y, legal)
            const actual = game.getDrag().target
            stats.geometryPoints += 1
            const actualKey = keyOfTarget(actual)
            const expectedKey = keyOfTarget(expected.valid)
            if (expectedKey) {
              coverage.validHits += 1
              coverage.uniqueTargets.add(expectedKey)
            } else if (expected.hovered) {
              coverage.invalidHovers += 1
            } else {
              coverage.empty += 1
            }
            if (actualKey !== expectedKey) {
              mismatchCount += 1
              if (firstMismatches.length < 8) {
                firstMismatches.push({
                  state: stateDef.name,
                  size: size.width + 'x' + size.height,
                  source,
                  point,
                  expected: expectedKey,
                  expectedHovered: keyOfTarget(expected.hovered),
                  actual: actualKey,
                  actualHovered: keyOfTarget(game.getDrag().hoverTarget || null),
                  layout: {
                    cardW: layout.cardW,
                    cardH: layout.cardH,
                    pad,
                    tableauTop: layout.tableauTop,
                    tableauH: layout.tableauH,
                    wasteX: layout.wasteX,
                    foundationX: layout.foundationX,
                    colX: layout.colX,
                  },
                })
              }
            }
            checks += 1
            if (latestView && latestView.drag) {
              const viewKey = keyOfTarget(latestView.drag.target)
              if (viewKey !== actualKey) {
                mismatchCount += 1
                if (firstMismatches.length < 8) firstMismatches.push({ state: stateDef.name, size: size.width + 'x' + size.height, source, point, viewTarget: viewKey, actual: actualKey })
              }
            }
          }
          pointerCancel(game)
        }
        if (VERBOSE) console.log(`  geometry ${stateDef.name} @ ${size.width}x${size.height}: ${sampled.length} sources, ${points.length} points`)
        game.destroy()
        currentGame = null
      })
    })

    if (mismatchCount) {
      console.log('  first geometry mismatches: ' + JSON.stringify(firstMismatches, null, 2))
    }
    stats.geometrySources = dragSourcesCount
    check(mismatchCount === 0, `${mismatchCount} geometry hit-test mismatches (see stdout)`)
    // non-vacuity: the sweep really exercised valid drops, invalid hovers and empty space
    check(coverage.validHits > 0 && coverage.invalidHovers > 0 && coverage.empty > 0,
      `geometry sweep vacuous: valid=${coverage.validHits}, hover=${coverage.invalidHovers}, empty=${coverage.empty}`)
    check(coverage.uniqueTargets.size >= 3,
      `geometry sweep hit only ${coverage.uniqueTargets.size} distinct targets: ${[...coverage.uniqueTargets].join(',')}`)
    console.log(`  geometry coverage: ${coverage.validHits} legal-target hits (${coverage.uniqueTargets.size} distinct: ${[...coverage.uniqueTargets].sort().join(' ')}), ${coverage.invalidHovers} invalid hovers, ${coverage.empty} empty-space points`)
  })
}

/* ------------------------------------------------------------------ *
 * 5. Successful drops
 * ------------------------------------------------------------------ */
async function dropChecks() {
  await test('drop: waste top -> tableau applies exactly the oracle move (moves/undo/persist)', () => {
    const { game } = mount({ width: 1024, height: 700 })
    game.newGame(5)
    // draw until the waste top has at least one legal tableau/foundation target
    let target = null
    for (let i = 0; i < 24 && !target; i += 1) {
      game.drawFromStock()
      const oracle = oracleOf(game)
      for (let col = 0; col < 7 && !target; col += 1) {
        if (ref.canDrop(oracle, { zone: 'waste' }, { zone: 'tableau', col }).ok) target = { kind: 'tableau', col }
      }
      for (let pile = 0; pile < 4 && !target; pile += 1) {
        if (ref.canDrop(oracle, { zone: 'waste' }, { zone: 'foundation', suit: SUIT_ORDER[pile] }).ok) target = { kind: 'foundation', pile }
      }
    }
    check(!!target, 'no legal waste move found in this deal')
    const oracleBefore = oracleOf(game)
    const expected = ref.applyMove(oracleBefore, { zone: 'waste' }, targetToRef(target))
    check(expected.ok, 'oracle says the target is legal')
    const movesBefore = stateOf(game).moves
    const undoBefore = stateOf(game).undo.length
    const layout = layoutOf(game)
    const point = target.kind === 'tableau'
      ? { x: layout.colX[target.col] + layout.cardW / 2, y: layout.tableauTop + 20 }
      : { x: layout.foundationX[target.pile] + layout.cardW / 2, y: layout.topY + layout.cardH / 2 }
    const start = startDrag(game, { kind: 'waste' })
    activateDrag(game, start)
    const dropTarget = finishAt(game, point.x, point.y)
    stats.drops += 1
    check(keyOfTarget(dropTarget) === keyOfTarget(target), 'drag target should be the legal target')
    check(game.getDrag() === null, 'drag state must be cleared after drop')
    check(latestView && latestView.drag === null, 'view.drag must be cleared after drop')
    const after = canonicalOf(game)
    const diffs = ref.diffPiles(ref.exportPiles(expected.state), after)
    check(diffs === null, 'pile mismatch after drop: ' + JSON.stringify(diffs))
    check(stateOf(game).moves === movesBefore + 1, 'moves must increment once')
    check(stateOf(game).undo.length === undoBefore + 1, 'undo must get exactly one snapshot')
    check(env.storage.has(STORE_KEY), 'successful drop must persist')
    const clickEvent = makeEvent(plainElement(), 0, 0)
    game.clickCapture(clickEvent)
    stats.suppressionProbes += 1
    check(clickEvent.defaultPrevented && clickEvent.propagationStopped, 'click after a drag must be swallowed')
  })

  await test('drop: K-headed run -> empty column', () => {
    const m = mountState(fullCanonical({ tableau: [['KH', 'QS'], ['9D'], [], [], [], [], []] }), { width: 1024, height: 700 })
    const { game } = m
    const oracleBefore = oracleOf(game)
    const expected = ref.applyMove(oracleBefore, { zone: 'tableau', col: 0, index: 0 }, { zone: 'tableau', col: 6 })
    check(expected.ok, 'oracle: K-run onto empty column must be legal')
    const layout = layoutOf(game)
    const start = startDrag(game, { kind: 'tableau', col: 0, index: 0 })
    activateDrag(game, start)
    const target = finishAt(game, layout.colX[6] + layout.cardW / 2, layout.tableauTop + 30)
    stats.drops += 1
    check(keyOfTarget(target) === 'tableau:6', 'expected empty column 6 as target')
    check(ref.diffPiles(ref.exportPiles(expected.state), canonicalOf(game)) === null, 'piles after K-run drop')
    check(stateOf(game).tableau[0].length === 0 && stateOf(game).tableau[6].length === 2, 'K-run must move whole run')
  })

  await test('drop: foundation top -> tableau (documented convenience)', () => {
    const m = mountState(fullCanonical({ foundations: { S: ['AS', '2S'] }, tableau: [['3H'], [], [], [], [], [], []] }), { width: 1024, height: 700 })
    const { game } = m
    const oracleBefore = oracleOf(game)
    const expected = ref.applyMove(oracleBefore, { zone: 'foundation', suit: 'S' }, { zone: 'tableau', col: 0 }, { allowFromFoundation: true })
    check(expected.ok, 'oracle: foundation 2S onto 3H must be legal (classic option)')
    const layout = layoutOf(game)
    const start = startDrag(game, { kind: 'foundation', pile: 0 })
    activateDrag(game, start)
    const target = finishAt(game, layout.colX[0] + layout.cardW / 2, layout.tableauTop + 40)
    stats.drops += 1
    check(keyOfTarget(target) === 'tableau:0', 'expected column 0 as target')
    check(ref.diffPiles(ref.exportPiles(expected.state), canonicalOf(game)) === null, 'piles after foundation->tableau drop')
    check(stateOf(game).foundations[0].length === 1 && stateOf(game).tableau[0].length === 2, 'foundation card must move')
  })
}

/* ------------------------------------------------------------------ *
 * 6. Failed drop / outside / cancel purity
 * ------------------------------------------------------------------ */
async function failureChecks() {
  await test('failed drop: no state/undo/moves/storage change, message = canDrop reason', () => {
    // waste 2H cannot go to the empty spade foundation (needs A)
    const m = mountState(fullCanonical({ waste: ['2H'], foundations: {} }), { width: 1024, height: 700 })
    const { game } = m
    const layout = layoutOf(game)
    const before = JSON.stringify(canonicalOf(game))
    const storageBefore = env.storage.get(STORE_KEY)
    const movesBefore = stateOf(game).moves
    const undoBefore = stateOf(game).undo.length
    const reason = seam.canDrop(stateOf(game), { kind: 'waste' }, { kind: 'foundation', pile: 0 }).reason
    check(typeof reason === 'string' && reason.length > 0, 'expected a readable refusal reason')
    const start = startDrag(game, { kind: 'waste' })
    activateDrag(game, start)
    const target = finishAt(game, layout.foundationX[0] + layout.cardW / 2, layout.topY + layout.cardH / 2)
    stats.illegalDrops += 1
    check(target === null, 'illegal hover must not expose a valid drag.target')
    check(JSON.stringify(canonicalOf(game)) === before, 'failed drop must not mutate piles')
    check(stateOf(game).moves === movesBefore, 'failed drop must not change moves')
    check(stateOf(game).undo.length === undoBefore, 'failed drop must not push undo')
    check(env.storage.get(STORE_KEY) === storageBefore, 'failed drop must not write storage')
    check(latestView && latestView.message === reason, `message should equal canDrop reason: ${JSON.stringify(latestView && latestView.message)} vs ${JSON.stringify(reason)}`)
    check(game.getDrag() === null && latestView.drag === null, 'failed drop must clear drag state')
    const clickEvent = makeEvent(plainElement(), 0, 0)
    game.clickCapture(clickEvent)
    check(clickEvent.defaultPrevented, 'click after a failed drag must be swallowed')
  })

  await test('failed drop: Q onto empty column (rule reason surfaced)', () => {
    const m = mountState(fullCanonical({ tableau: [['QS'], [], [], [], [], [], []] }), { width: 1024, height: 700 })
    const { game } = m
    const layout = layoutOf(game)
    const before = JSON.stringify(canonicalOf(game))
    const reason = seam.canDrop(stateOf(game), { kind: 'tableau', col: 0, index: 0 }, { kind: 'tableau', col: 5 }).reason
    check(/K/.test(reason), 'reason should mention the King requirement: ' + reason)
    const start = startDrag(game, { kind: 'tableau', col: 0, index: 0 })
    activateDrag(game, start)
    finishAt(game, layout.colX[5] + layout.cardW / 2, layout.tableauTop + 30)
    stats.illegalDrops += 1
    check(JSON.stringify(canonicalOf(game)) === before, 'Q->empty column must not mutate state')
    check(latestView.message === reason, 'message should equal canDrop reason')
  })

  await test('hover plumbing: independent invalid-hover points surface the matching canDrop reason', () => {
    const m = mountState(fullCanonical({ tableau: [['KH', 'QS'], [], [], [], [], [], []] }), { width: 1024, height: 700 })
    const { game } = m
    const layout = layoutOf(game)
    const pad = Math.max(4, layout.cardW * 0.06)
    const source = { kind: 'tableau', col: 0, index: 0 }
    const legal = legalKeys(oracleOf(game), source)
    const before = JSON.stringify(canonicalOf(game))
    let probes = 0
    let mismatches = 0
    for (let gx = 0; gx < 18 && probes < 6; gx += 1) {
      for (let gy = 0; gy < 12 && probes < 6; gy += 1) {
        const x = -pad + (gx / 17) * (layout.width + 2 * pad)
        const y = -pad + (gy / 11) * (layout.height + 2 * pad)
        const expected = independentHit(layout, x, y, legal)
        if (expected.valid || !expected.hovered) continue
        const start = startDrag(game, source)
        activateDrag(game, start)
        finishAt(game, x, y)
        const reason = seam.canDrop(stateOf(game), source, expected.hovered).reason
        stats.illegalDrops += 1
        probes += 1
        if (latestView.message !== reason) mismatches += 1
        if (JSON.stringify(canonicalOf(game)) !== before) mismatches += 1
      }
    }
    check(probes > 0, 'no invalid-hover points found for the hover-reason sweep')
    check(mismatches === 0, `${mismatches} hover-reason mismatches across ${probes} probes`)
  })

  await test('drop outside any target: no state change, no message, no undo', () => {
    const m = mountState(fullCanonical({ tableau: [['QS'], [], [], [], [], [], []] }), { width: 1024, height: 700 })
    const { game } = m
    const layout = layoutOf(game)
    const before = JSON.stringify(canonicalOf(game))
    const start = startDrag(game, { kind: 'tableau', col: 0, index: 0 })
    activateDrag(game, start)
    // find a point where the independent hit-test sees nothing at all
    const pad = Math.max(4, layout.cardW * 0.06)
    let outside = null
    for (const candidate of [
      { x: -pad - 20, y: layout.height / 2 },
      { x: layout.width + pad + 20, y: layout.height / 2 },
      { x: layout.width / 2, y: -pad - 20 },
      { x: layout.width / 2, y: layout.height + pad + 20 },
    ]) {
      const hit = independentHit(layout, candidate.x, candidate.y, new Set())
      if (!hit.valid && !hit.hovered) {
        outside = candidate
        break
      }
    }
    check(!!outside, 'no outside point found')
    finishAt(game, outside.x, outside.y)
    stats.drops += 1
    check(JSON.stringify(canonicalOf(game)) === before, 'drop outside must not mutate state')
    check(stateOf(game).undo.length === 0, 'drop outside must not push undo')
    check(game.getDrag() === null, 'drop outside must clear drag')
    check(latestView.message === '', 'drop outside must not set a message')
  })

  await test('pointercancel mid-drag: no state change, drag cleared', () => {
    const m = mountState(fullCanonical({ tableau: [['KH', 'QS'], [], [], [], [], [], []] }), { width: 1024, height: 700 })
    const { game } = m
    const layout = layoutOf(game)
    const before = JSON.stringify(canonicalOf(game))
    const start = startDrag(game, { kind: 'tableau', col: 0, index: 0 })
    activateDrag(game, start)
    pointerMove(game, layout.colX[6] + layout.cardW / 2, layout.tableauTop + 30)
    check(keyOfTarget(game.getDrag().target) === 'tableau:6', 'expected a legal hover target before cancel')
    pointerCancel(game)
    stats.drops += 1
    check(game.getDrag() === null && latestView.drag === null, 'pointercancel must clear drag state')
    check(JSON.stringify(canonicalOf(game)) === before, 'pointercancel must not mutate state')
    check(stateOf(game).undo.length === 0 && stateOf(game).moves === 0, 'pointercancel must not change move counters')
  })
}

/* ------------------------------------------------------------------ *
 * 7. Click suppression edge cases
 * ------------------------------------------------------------------ */
async function suppressionChecks() {
  await test('clickCapture: one post-drag click swallowed, then normal clicks pass; timer resets flag', async () => {
    const { game } = mount({ width: 1024, height: 700 })
    game.newGame(21)
    const layout = layoutOf(game)

    // produce an active drag that ends without a move (drop outside)
    let source = null
    const state = stateOf(game)
    for (let col = 0; col < 7 && !source; col += 1) {
      const index = state.tableau[col].findIndex((card) => card.up)
      if (index >= 0) source = { kind: 'tableau', col, index }
    }
    check(!!source, 'no face-up card for suppression test')
    const start2 = startDrag(game, source)
    activateDrag(game, start2)
    finishAt(game, -50, layout.height / 2)
    stats.suppressionProbes += 1
    const first = makeEvent(plainElement(), 0, 0)
    game.clickCapture(first)
    check(first.defaultPrevented && first.propagationStopped, 'first click after drag must be swallowed')
    const second = makeEvent(plainElement(), 0, 0)
    game.clickCapture(second)
    check(!second.defaultPrevented && !second.propagationStopped, 'only one click may be swallowed')
    // after the 0ms timer fires, a later click is not swallowed either
    await new Promise((resolve) => setTimeout(resolve, 5))
    const third = makeEvent(plainElement(), 0, 0)
    game.clickCapture(third)
    check(!third.defaultPrevented && !third.propagationStopped, 'timer must clear the suppression flag')
  })

  await test('click-to-select still works normally; drag activation clears an existing selection', () => {
    const m = mountState(fullCanonical({ tableau: [['KH', 'QS'], ['9D'], [], [], [], [], []] }), { width: 900, height: 640 })
    const { game } = m
    // plain click path selects (no drag involved)
    game.onTableauCardClick(0, 0)
    check(JSON.stringify(game.getSelection()) === JSON.stringify({ kind: 'tableau', col: 0, index: 0 }), 'click-to-select broken')
    // now start a drag from the same card: selection must be cleared on activation
    const start = startDrag(game, { kind: 'tableau', col: 0, index: 0 })
    check(JSON.stringify(game.getSelection()) === JSON.stringify({ kind: 'tableau', col: 0, index: 0 }), 'selection should still exist below threshold')
    pointerMove(game, start.startX + 2, start.startY + 2)
    check(JSON.stringify(game.getSelection()) === JSON.stringify({ kind: 'tableau', col: 0, index: 0 }), 'selection must survive sub-threshold move')
    pointerMove(game, start.startX + 12, start.startY + 12)
    check(game.getSelection() === null, 'selection must be cleared on drag activation')
    pointerCancel(game)
    // after cancel, a real click still selects
    game.onTableauCardClick(1, 0)
    check(JSON.stringify(game.getSelection()) === JSON.stringify({ kind: 'tableau', col: 1, index: 0 }), 'click-to-select must still work after a cancelled drag')
  })
}

/* ------------------------------------------------------------------ *
 * 8. Listener / capture / destroy cleanup
 * ------------------------------------------------------------------ */
async function cleanupChecks() {
  await test('no global pointer listeners; destroy mid-drag is inert and keeps state', () => {
    const { game, host } = mount({ width: 1024, height: 700 })
    game.newGame(31)
    const windowTypes = listenerTypes(env.windowListeners)
    const documentTypes = listenerTypes(env.documentListeners)
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerenter', 'pointerleave']) {
      check(!windowTypes.includes(type), 'window must not listen to ' + type)
      check(!documentTypes.includes(type), 'document must not listen to ' + type)
    }
    check(env.bodyTouches === 0, 'drag activity must not touch document.body')
    // start an active drag; capture set once
    let source = null
    const state = stateOf(game)
    for (let col = 0; col < 7 && !source; col += 1) {
      const index = state.tableau[col].findIndex((card) => card.up)
      if (index >= 0) source = { kind: 'tableau', col, index }
    }
    check(!!source, 'no source for cleanup test')
    const start = startDrag(game, source)
    activateDrag(game, start)
    check(host.captures.set.length === 1, 'capture should be set once after activation')
    check(host.captures.released.length === 0, 'capture not released yet')
    const stateBefore = JSON.stringify(canonicalOf(game))
    game.destroy()
    currentGame = null
    // post-destroy pointer activity must not throw, mutate state, or write
    const storageAfterDestroy = env.storage.get(STORE_KEY)
    game.pointerMove(makeEvent(plainElement(), 500, 300))
    game.pointerUp(makeEvent(plainElement(), 500, 300))
    game.pointerDown(makeEvent(cardElement(source), 500, 300))
    check(JSON.stringify(canonicalOf(game)) === stateBefore, 'destroyed game must ignore pointer events for state')
    check(env.storage.get(STORE_KEY) === storageAfterDestroy, 'destroyed game must not write on pointer events')
    // capture must have been released by the finishing pointerup (or left to the browser on unmount)
    console.log(`  note: destroy mid-drag -> capture released via finishing pointerup: ${host.captures.released.length === 1}; destroy itself does not release (browser releases on DOM removal)`)
    check(host.captures.released.length === 1, 'a finishing pointerup after destroy should release the capture')
  })

  await test('capture is released on successful, failed and cancelled drops', () => {
    // successful
    const m = mountState(fullCanonical({ tableau: [['KH', 'QS'], [], [], [], [], [], []] }), { width: 1024, height: 700 })
    const layout = layoutOf(m.game)
    let start = startDrag(m.game, { kind: 'tableau', col: 0, index: 0 })
    activateDrag(m.game, start)
    check(m.host.captures.set.length === 1)
    finishAt(m.game, layout.colX[6] + layout.cardW / 2, layout.tableauTop + 30)
    check(m.host.captures.released.length === 1, 'successful drop must release capture')
    m.game.destroy()
    currentGame = null

    // cancelled
    resetEnv()
    const m2 = mountState(fullCanonical({ tableau: [['KH', 'QS'], [], [], [], [], [], []] }), { width: 1024, height: 700 })
    start = startDrag(m2.game, { kind: 'tableau', col: 0, index: 0 })
    activateDrag(m2.game, start)
    pointerCancel(m2.game)
    check(m2.host.captures.released.length === 1, 'pointercancel must release capture')
    m2.game.destroy()
    currentGame = null

    // failed drop
    resetEnv()
    const m3 = mountState(fullCanonical({ waste: ['2H'], foundations: {} }), { width: 1024, height: 700 })
    const layout3 = layoutOf(m3.game)
    start = startDrag(m3.game, { kind: 'waste' })
    activateDrag(m3.game, start)
    finishAt(m3.game, layout3.foundationX[0] + layout3.cardW / 2, layout3.topY + layout3.cardH / 2)
    check(m3.host.captures.released.length === 1, 'failed drop must release capture')
    m3.game.destroy()
    currentGame = null
  })
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
console.log('drag-audit — client.js sha256 ' + createHash('sha256').update(clientSource).digest('hex') + ' (' + Buffer.byteLength(clientSource) + ' bytes)')

await staticChecks()
await thresholdChecks()
await sourceChecks()
await geometryChecks()
await dropChecks()
await failureChecks()
await suppressionChecks()
await cleanupChecks()

console.log('\n=== drag-audit summary ===')
console.log(`tests: ${passed} passed, ${failures.length} failed`)
console.log(`checks: ${checks}`)
console.log(`geometry points compared: ${stats.geometryPoints} (sources: ${stats.geometrySources})`)
console.log(`drop scenarios: ${stats.drops} (illegal: ${stats.illegalDrops}), threshold probes: ${stats.thresholdProbes}, suppression probes: ${stats.suppressionProbes}`)
if (failures.length) {
  console.error('DRAG-AUDIT FAILED')
  for (const failure of failures) console.error(' - ' + failure.name + ' :: ' + (failure.error && failure.error.message))
  process.exit(1)
}
console.log('DRAG-AUDIT OK')
