/**
 * diff-fuzz.mjs — differential rules audit: client.js test seam vs independent oracle.
 *
 * Run (repo root):
 *   node packages/dsh-game-solitaire/dev/audit/diff-fuzz.mjs
 *   node packages/dsh-game-solitaire/dev/audit/diff-fuzz.mjs --games 20 --actions 600
 *   node packages/dsh-game-solitaire/dev/audit/diff-fuzz.mjs --seed 12345 --verbose   # single-game repro
 * Read-only. Exit 0 = no divergence, 1 = divergence (first mismatches printed with repro values).
 *
 * What is compared, for every seed:
 *   1. dealFromSeed(seed) — client dealer vs oracle dealer, pile by pile.
 *   2. Random legal AND illegal actions (moves/draws/auto-move/undo), each step:
 *        - canDrop(selection, target).ok  (client) vs canDrop(ref) — identical verdict
 *        - moved card list (ids vs codes) — identical
 *        - applyMove mutation: stock/waste/foundations/tableau/moves/won — identical
 *        - drawStock: ok / draw-vs-recycle / resulting piles — identical
 *        - autoMoveToFoundation: ok, target pile, resulting piles — identical
 *        - undoMove: restored piles/moves vs oracle snapshot stack — identical
 *        - failed actions must not mutate the client state (purity of refusals)
 *   3. Periodic exhaustive canDrop cross-product over ALL selections x ALL targets
 *      (including invalid indices/piles) — a rules table comparison, not just a walk.
 *   4. Oracle invariants (validateState) after every mutation, including 52-card
 *      uniqueness, no face-down above face-up, only tops up, foundation order, win flag.
 *
 * The client state is always seeded from the CLIENT's own deal, so a hypothetical
 * dealing difference can never masquerade as a move-rule difference (deal equality
 * is still asserted separately above).
 */
import * as ref from './reference-solitaire.mjs'
import {
  seam, clientPilesToCanonical, canonicalToClientPiles, selectionToRef, targetToRef,
  describeAction, idToCode, SUIT_ORDER,
} from './harness.mjs'

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2)
function arg(name, fallback) {
  const index = argv.indexOf('--' + name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}
const GAMES = Math.max(1, Number(arg('games', 12)))
const ACTIONS = Math.max(1, Number(arg('actions', 400)))
const ONLY_SEED = arg('seed', null)
const VERBOSE = argv.includes('--verbose')
const CHECK_EVERY = 25

const seeds = ONLY_SEED !== null
  ? [Number(ONLY_SEED) >>> 0]
  : [0, 0xffffffff, ...Array.from({ length: Math.max(0, GAMES - 2) }, (_, i) => i + 1)]

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */
let checks = 0
const counts = { deal: 0, canDrop: 0, apply: 0, draw: 0, auto: 0, undo: 0, invariant: 0, purity: 0 }
const mismatches = []
const MAX_PRINTED = 12

function record(kind, context, detail) {
  mismatches.push({ kind, context, detail })
  if (mismatches.length <= MAX_PRINTED) {
    console.log(`\nMISMATCH #${mismatches.length} [${kind}]`)
    console.log('  context: ' + JSON.stringify(context))
    console.log('  detail : ' + JSON.stringify(detail))
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function canonicalNow(state) {
  return clientPilesToCanonical(state)
}

function comparePiles(kind, context, expectedRefState, clientState) {
  const expected = ref.exportPiles(expectedRefState)
  const actual = canonicalNow(clientState)
  checks += 1
  counts.apply += 1
  const diffs = ref.diffPiles(expected, actual)
  if (expected.moves !== actual.moves) {
    diffs && diffs.push({ field: 'moves', expected: expected.moves, actual: actual.moves })
  }
  if (diffs) {
    record(kind, context, { fields: diffs, expectedPiles: expected, actualPiles: actual })
    return false
  }
  return true
}

function compareCanDrop(src, dst, clientState, refState, context) {
  const c = seam.canDrop(clientState, src, dst)
  const m = ref.canDrop(refState, selectionToRef(src), targetToRef(dst), { allowFromFoundation: true })
  checks += 1
  counts.canDrop += 1
  if (!!c.ok !== !!m.ok) {
    record('canDrop', context, {
      selection: src,
      target: dst,
      clientOk: !!c.ok,
      clientReason: c.reason,
      refOk: !!m.ok,
      refReason: m.reason,
      refPiles: ref.exportPiles(refState),
      clientPiles: canonicalNow(clientState),
    })
    return { verdict: null, client: c, oracle: m }
  }
  return { verdict: !!c.ok, client: c, oracle: m }
}

/** Every selection variant the UI can produce, plus malformed ones. */
function buildSelectionCandidates(clientState) {
  const list = [{ kind: 'waste' }]
  for (let col = 0; col < 7; col += 1) {
    const column = clientState.tableau[col]
    if (column.length === 0) {
      list.push({ kind: 'tableau', col, index: 0 })
      list.push({ kind: 'tableau', col, index: -1 })
      continue
    }
    for (let index = 0; index < column.length; index += 1) list.push({ kind: 'tableau', col, index })
    list.push({ kind: 'tableau', col, index: column.length })
    list.push({ kind: 'tableau', col, index: -1 })
    list.push({ kind: 'tableau', col: col - 1, index: 0 })
  }
  for (let pile = 0; pile < 4; pile += 1) list.push({ kind: 'foundation', pile })
  list.push({ kind: 'foundation', pile: -1 })
  list.push({ kind: 'foundation', pile: 4 })
  list.push({ kind: 'bogus' })
  list.push(null)
  return list
}

const TARGET_CANDIDATES = []
for (let col = -1; col <= 7; col += 1) TARGET_CANDIDATES.push({ kind: 'tableau', col })
for (let pile = -1; pile <= 4; pile += 1) TARGET_CANDIDATES.push({ kind: 'foundation', pile })
TARGET_CANDIDATES.push({ kind: 'bogus' })
TARGET_CANDIDATES.push(null)

function exhaustiveCanDrop(seed, step, clientState, refState, actionLog) {
  const selections = buildSelectionCandidates(clientState)
  let localChecks = 0
  for (const src of selections) {
    for (const dst of TARGET_CANDIDATES) {
      const result = compareCanDrop(src, dst, clientState, refState, { seed, step, phase: 'exhaustive', actionLog: actionLog.slice(-4) })
      localChecks += 1
      if (result.verdict === null) return { ok: false, checks: localChecks }
    }
  }
  return { ok: true, checks: localChecks }
}

function legalPairs(clientState) {
  const pairs = []
  const selections = buildSelectionCandidates(clientState)
  const targets = []
  for (let col = 0; col < 7; col += 1) targets.push({ kind: 'tableau', col })
  for (let pile = 0; pile < 4; pile += 1) targets.push({ kind: 'foundation', pile })
  for (const src of selections) {
    if (src && (src.kind === 'bogus' || src.index < 0 || src.col < 0)) continue
    for (const dst of targets) {
      if (seam.canDrop(clientState, src, dst).ok) pairs.push({ src, dst })
    }
  }
  return pairs
}

/* ------------------------------------------------------------------ *
 * Deterministic constructed edge positions (random play rarely reaches
 * wins / foundation recycling / auto-flip corner cases)
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
  if (used.size !== 52) throw new Error(`scenario places ${used.size} cards, expected 52`)
  return { stock, waste, tableau, foundations, moves: 0, won: false }
}

function clientStateFromCanonical(canonical) {
  return Object.assign({
    seed: 1234,
    started: false,
    won: false,
    moves: 0,
    elapsedMs: 0,
    undo: [],
  }, canonicalToClientPiles(canonical))
}

const scenarioResults = []

function runScenario(name, canonical, steps) {
  const clientState = clientStateFromCanonical(canonical)
  let refState = ref.importPiles(canonical)
  const before = mismatches.length
  const initialProblems = ref.validateState(refState)
  if (initialProblems.length) {
    record('scenario-invariant', { scenario: name }, { problems: initialProblems })
  }
  const exhaustive = exhaustiveCanDrop('scenario:' + name, -1, clientState, refState, [])
  if (!exhaustive.ok) {
    scenarioResults.push({ name, ok: false })
    return
  }
  let failed = false
  steps.forEach((step, index) => {
    if (failed) return
    const context = { scenario: name, step: index, action: describeAction(step) }
    if (step.type === 'move') {
      const verdict = compareCanDrop(step.src, step.dst, clientState, refState, context)
      if (verdict.verdict === null) { failed = true; return }
      if (verdict.verdict !== step.expectOk) {
        record('scenario-expectation', context, { expectedOk: step.expectOk, oracleOk: verdict.verdict })
        failed = true
        return
      }
      if (verdict.verdict) {
        seam.pushUndo(clientState)
        const cResult = seam.applyMove(clientState, step.src, step.dst)
        const mResult = ref.applyMove(refState, selectionToRef(step.src), targetToRef(step.dst), { allowFromFoundation: true })
        if (!cResult.ok || !mResult.ok) {
          record('scenario-apply-refused', context, { clientResult: cResult, refOk: mResult.ok })
          failed = true
          return
        }
        refState = mResult.state
        if (!comparePiles('scenario-move-piles', context, refState, clientState)) failed = true
      } else {
        const snapshotBefore = JSON.stringify(canonicalNow(clientState))
        const cResult = seam.applyMove(clientState, step.src, step.dst)
        if (cResult.ok) {
          record('scenario-refusal-apply', context, { reason: 'canDrop refused but applyMove accepted' })
          failed = true
        }
        if (JSON.stringify(canonicalNow(clientState)) !== snapshotBefore) {
          record('scenario-refusal-mutated', context, {})
          failed = true
        }
      }
    } else if (step.type === 'draw') {
      seam.pushUndo(clientState)
      const cResult = seam.drawStock(clientState)
      const mResult = ref.drawStock(refState)
      if (!!cResult.ok !== !!mResult.ok) {
        record('scenario-draw-ok', context, { clientResult: cResult, refOk: mResult.ok })
        failed = true
        return
      }
      if (step.expectKind && cResult.kind !== step.expectKind) {
        record('scenario-draw-kind', context, { expectedKind: step.expectKind, clientKind: cResult.kind })
        failed = true
        return
      }
      refState = mResult.state
      if (!comparePiles('scenario-draw-piles', context, refState, clientState)) failed = true
    } else if (step.type === 'auto') {
      const cAuto = seam.autoMoveToFoundation(clientState, step.src)
      const mAuto = ref.autoMove(refState, selectionToRef(step.src))
      if (!!cAuto.ok !== !!mAuto.ok) {
        record('scenario-auto-ok', context, { clientOk: !!cAuto.ok, clientReason: cAuto.reason, refOk: !!mAuto.ok, refReason: mAuto.reason })
        failed = true
        return
      }
      if (!!cAuto.ok !== step.expectOk) {
        record('scenario-auto-expectation', context, { expectedOk: step.expectOk, clientOk: !!cAuto.ok })
        failed = true
        return
      }
      if (cAuto.ok) {
        seam.pushUndo(clientState)
        const cApply = seam.applyMove(clientState, cAuto.selection, cAuto.target)
        refState = mAuto.state
        if (!cApply.ok) {
          record('scenario-auto-apply', context, {})
          failed = true
          return
        }
        if (!comparePiles('scenario-auto-piles', context, refState, clientState)) failed = true
      }
    }
    if (step.expectWon !== undefined) {
      const problems = ref.validateState(refState)
      if (problems.length) {
        record('scenario-invariant-after', context, { problems })
        failed = true
        return
      }
      if (seam.hasWon(clientState) !== step.expectWon || ref.isWon(refState) !== step.expectWon) {
        record('scenario-won', context, {
          expectedWon: step.expectWon,
          clientHasWon: seam.hasWon(clientState),
          oracleWon: ref.isWon(refState),
          clientWonFlag: clientState.won,
        })
        failed = true
      }
    }
  })
  const ok = !failed && mismatches.length === before
  scenarioResults.push({ name, ok })
}

function runScenarios() {
  const aeToQueen = (suit) => Array.from({ length: 12 }, (_, i) => ref.RANK_LABELS[i + 1] + suit)

  // 1) four foundations one card short: finish them and win (also covers draw-to-waste).
  runScenario('win-after-foundation-and-draw', fullCanonical({
    foundations: { S: aeToQueen('S'), H: aeToQueen('H'), D: aeToQueen('D'), C: aeToQueen('C') },
    tableau: [['KS'], ['KH'], ['KD']],
    stock: ['KC'],
  }), [
    { type: 'move', src: { kind: 'tableau', col: 0, index: 0 }, dst: { kind: 'foundation', pile: 0 }, expectOk: true },
    { type: 'move', src: { kind: 'tableau', col: 1, index: 0 }, dst: { kind: 'foundation', pile: 1 }, expectOk: true },
    { type: 'move', src: { kind: 'tableau', col: 2, index: 0 }, dst: { kind: 'foundation', pile: 2 }, expectOk: true },
    { type: 'draw', expectKind: 'draw' },
    { type: 'move', src: { kind: 'waste' }, dst: { kind: 'foundation', pile: 3 }, expectOk: true, expectWon: true },
  ])

  // 2) classic extension: moving a card back OFF a foundation onto the tableau.
  runScenario('foundation-to-tableau-extension', fullCanonical({
    foundations: { S: ['AS', '2S'] },
    tableau: [['3H']],
  }), [
    { type: 'move', src: { kind: 'foundation', pile: 0 }, dst: { kind: 'tableau', col: 0 }, expectOk: true },
    { type: 'move', src: { kind: 'tableau', col: 0, index: 1 }, dst: { kind: 'foundation', pile: 0 }, expectOk: true },
    { type: 'move', src: { kind: 'tableau', col: 0, index: 0 }, dst: { kind: 'tableau', col: 1 }, expectOk: false },
  ])

  // 3) run move exposes a face-down card -> auto-flip; grabbing a face-down card refused.
  runScenario('auto-flip-and-run-move', fullCanonical({
    tableau: [[{ c: '5C', up: false }, '9H', '8S'], ['10C']],
  }), [
    { type: 'move', src: { kind: 'tableau', col: 0, index: 1 }, dst: { kind: 'tableau', col: 1 }, expectOk: true },
    { type: 'move', src: { kind: 'tableau', col: 0, index: 0 }, dst: { kind: 'tableau', col: 2 }, expectOk: false },
    { type: 'auto', src: { kind: 'tableau', col: 1, index: 2 }, expectOk: false },
  ])

  // 4) double-click auto-move: A then 2 accepted, off-rank refused.
  runScenario('auto-move-double-click', fullCanonical({
    tableau: [['AS'], ['2S'], ['7S']],
  }), [
    { type: 'auto', src: { kind: 'tableau', col: 0, index: 0 }, expectOk: true },
    { type: 'auto', src: { kind: 'tableau', col: 1, index: 0 }, expectOk: true },
    { type: 'auto', src: { kind: 'tableau', col: 2, index: 0 }, expectOk: false },
  ])

  // 5) win detection on a finished position (no actions).
  runScenario('win-detection', fullCanonical({
    foundations: {
      S: Array.from({ length: 13 }, (_, i) => ref.RANK_LABELS[i + 1] + 'S'),
      H: Array.from({ length: 13 }, (_, i) => ref.RANK_LABELS[i + 1] + 'H'),
      D: Array.from({ length: 13 }, (_, i) => ref.RANK_LABELS[i + 1] + 'D'),
      C: Array.from({ length: 13 }, (_, i) => ref.RANK_LABELS[i + 1] + 'C'),
    },
  }), [])

  // 6) stock recycle: draw all 24 stock cards, recycle, repeat order, recycle again.
  const recycleDraws = []
  for (let i = 0; i < 24; i += 1) recycleDraws.push({ type: 'draw', expectKind: 'draw' })
  recycleDraws.push({ type: 'draw', expectKind: 'recycle' })
  for (let i = 0; i < 24; i += 1) recycleDraws.push({ type: 'draw', expectKind: 'draw' })
  recycleDraws.push({ type: 'draw', expectKind: 'recycle' })
  for (let i = 0; i < 6; i += 1) recycleDraws.push({ type: 'draw', expectKind: 'draw' })
  runScenario('stock-recycle-order', fullCanonical({
    foundations: {
      S: Array.from({ length: 13 }, (_, i) => ref.RANK_LABELS[i + 1] + 'S'),
      H: Array.from({ length: 13 }, (_, i) => ref.RANK_LABELS[i + 1] + 'H'),
    },
    tableau: [['AD'], ['AC']],
  }), recycleDraws)
}


/* ------------------------------------------------------------------ *
 * Main differential loop
 * ------------------------------------------------------------------ */
let totalSteps = 0
let gamesFinished = 0
let gamesWithWin = 0
const startedAt = Date.now()

for (const seed of seeds) {
  if (VERBOSE) console.log(`\n--- seed ${seed} ---`)
  const rng = ref.makeRng((seed ^ 0x9e3779b9) >>> 0)

  /* 1. deal equality */
  const clientDeal = seam.dealFromSeed(seed)
  const oracleDeal = ref.dealFromSeed(seed)
  counts.deal += 1
  checks += 1
  const dealDiffs = ref.diffPiles(ref.exportPiles(oracleDeal), clientPilesToCanonical(clientDeal))
  if (dealDiffs) {
    record('deal', { seed }, { fields: dealDiffs, expectedPiles: ref.exportPiles(oracleDeal), actualPiles: clientPilesToCanonical(clientDeal) })
    continue
  }

  /* 2. state seeded from the CLIENT's deal (deal equality already asserted) */
  const clientState = seam.emptyState(seed)
  let refState = ref.importPiles(clientPilesToCanonical(clientState))
  const oracleSnapshots = [] // mirrors client's undo stack
  const actionLog = []
  let gameDiverged = false
  let steps = 0

  const oracleProblems = ref.validateState(refState)
  if (oracleProblems.length) {
    record('invariant-initial', { seed }, { problems: oracleProblems })
    continue
  }

  for (let step = 0; step < ACTIONS; step += 1) {
    steps += 1
    totalSteps += 1

    /* 2a. exhaustive rules-table comparison (periodic) */
    if (step % CHECK_EVERY === 0 || step === ACTIONS - 1) {
      const result = exhaustiveCanDrop(seed, step, clientState, refState, actionLog)
      if (!result.ok) { gameDiverged = true; break }
    }

    /* 2b. pick an action: mostly legal, sometimes deliberately invalid */
    const wantDraw = rng() < 0.16
    let action
    if (wantDraw) {
      action = { type: 'draw' }
    } else if (rng() < 0.65) {
      const pairs = legalPairs(clientState)
      if (pairs.length) {
        const pair = pairs[Math.floor(rng() * pairs.length)]
        action = { type: 'move', src: pair.src, dst: pair.dst }
      } else {
        action = { type: 'draw' }
      }
    } else {
      const srcs = buildSelectionCandidates(clientState).filter((s) => s && s.kind !== 'bogus')
      const src = srcs[Math.floor(rng() * srcs.length)]
      const dst = TARGET_CANDIDATES[Math.floor(rng() * TARGET_CANDIDATES.length)]
      action = { type: 'move', src, dst }
    }
    actionLog.push(describeAction(action))
    if (actionLog.length > 60) actionLog.shift()
    const context = { seed, step, action: describeAction(action), actionLog: actionLog.slice(-6) }

    if (VERBOSE) console.log(`  step ${step} ${context.action}`)

    /* 2c. draw */
    if (action.type === 'draw') {
      seam.pushUndo(clientState)
      oracleSnapshots.push(ref.cloneState(refState))
      const cResult = seam.drawStock(clientState)
      const mResult = ref.drawStock(refState)
      checks += 1
      counts.draw += 1
      if (!!cResult.ok !== !!mResult.ok) {
        record('draw-ok', context, { clientResult: cResult, refOk: mResult.ok, refReason: mResult.reason })
        gameDiverged = true
        break
      }
      if (cResult.ok) {
        const refKind = mResult.recycled ? 'recycle' : 'draw'
        if (cResult.kind !== refKind) {
          record('draw-kind', context, { clientKind: cResult.kind, refKind })
          gameDiverged = true
          break
        }
        refState = mResult.state
        if (!comparePiles('draw-piles', context, refState, clientState)) { gameDiverged = true; break }
        if (oracleSnapshots.length > seam.MAX_UNDO_KEEP) oracleSnapshots.shift()
      } else {
        // both refused: undo bookkeeping must be unwound on both sides
        seam.undoMove(clientState)
        oracleSnapshots.pop()
      }
    } else {
      /* 2d. move: rules verdict first */
      const verdict = compareCanDrop(action.src, action.dst, clientState, refState, context)
      if (verdict.verdict === null) { gameDiverged = true; break }

      if (verdict.verdict) {
        const clientCards = verdict.client.cards.map(idToCode)
        const oracleCards = verdict.oracle.run.map(ref.cardCode)
        if (JSON.stringify(clientCards) !== JSON.stringify(oracleCards)) {
          record('moved-cards', context, { clientCards, oracleCards, selection: action.src, target: action.dst })
          gameDiverged = true
          break
        }
        seam.pushUndo(clientState)
        oracleSnapshots.push(ref.cloneState(refState))
        const cResult = seam.applyMove(clientState, action.src, action.dst)
        const mResult = ref.applyMove(refState, selectionToRef(action.src), targetToRef(action.dst), { allowFromFoundation: true })
        checks += 1
        counts.apply += 1
        if (!cResult.ok || !mResult.ok) {
          record('apply-refused', context, { clientResult: cResult, refOk: mResult.ok, refReason: mResult.reason })
          gameDiverged = true
          break
        }
        if (cResult.moved !== oracleCards.length) {
          record('moved-count', context, { clientMoved: cResult.moved, oracleMoved: oracleCards.length })
          gameDiverged = true
          break
        }
        if (!!cResult.won !== ref.isWon(mResult.state)) {
          record('won-flag-move', context, { clientWon: cResult.won, oracleWon: ref.isWon(mResult.state) })
          gameDiverged = true
          break
        }
        refState = mResult.state
        if (!comparePiles('move-piles', context, refState, clientState)) { gameDiverged = true; break }
        if (oracleSnapshots.length > seam.MAX_UNDO_KEEP) oracleSnapshots.shift()
      } else {
        /* both refused: applyMove must also refuse and must not mutate */
        const before = JSON.stringify(canonicalNow(clientState))
        const cResult = seam.applyMove(clientState, action.src, action.dst)
        const after = JSON.stringify(canonicalNow(clientState))
        checks += 2
        counts.purity += 1
        if (cResult.ok) {
          record('refusal-apply-mismatch', context, { reason: 'canDrop=false but applyMove.ok=true' })
          gameDiverged = true
          break
        }
        if (before !== after) {
          record('refusal-mutated-state', context, { before: JSON.parse(before), after: JSON.parse(after) })
          gameDiverged = true
          break
        }
      }
    }

    /* 2e. auto-move (double-click) probe */
    if (!gameDiverged && step % 11 === 0) {
      const autoSources = [{ kind: 'waste' }]
      clientState.tableau.forEach((column, col) => {
        if (column.length) autoSources.push({ kind: 'tableau', col, index: column.length - 1 })
      })
      const src = autoSources[Math.floor(rng() * autoSources.length)]
      const cAuto = seam.autoMoveToFoundation(clientState, src)
      const mAuto = ref.autoMove(refState, selectionToRef(src))
      checks += 1
      counts.auto += 1
      const autoContext = Object.assign({}, context, { phase: 'auto', source: src })
      if (!!cAuto.ok !== !!mAuto.ok) {
        record('auto-ok', autoContext, {
          clientOk: !!cAuto.ok,
          clientReason: cAuto.reason,
          refOk: !!mAuto.ok,
          refReason: mAuto.reason,
        })
        gameDiverged = true
      } else if (cAuto.ok) {
        const movedCard = src.kind === 'waste'
          ? clientState.waste[clientState.waste.length - 1]
          : clientState.tableau[src.col][src.index].id
        const expectedPile = Math.floor(movedCard / 13)
        const oracleSuit = SUIT_ORDER[expectedPile]
        if (cAuto.target.pile !== expectedPile || cAuto.pile !== expectedPile) {
          record('auto-target', autoContext, {
            card: idToCode(movedCard),
            expectedPile,
            oracleSuit,
            clientTarget: cAuto.target,
            clientPile: cAuto.pile,
          })
          gameDiverged = true
        } else {
          seam.pushUndo(clientState)
          oracleSnapshots.push(ref.cloneState(refState))
          const cApply = seam.applyMove(clientState, cAuto.selection, cAuto.target)
          refState = mAuto.state
          checks += 1
          if (!cApply.ok) {
            record('auto-apply', autoContext, { clientResult: cApply })
            gameDiverged = true
          } else if (!comparePiles('auto-piles', autoContext, refState, clientState)) {
            gameDiverged = true
          } else if (oracleSnapshots.length > seam.MAX_UNDO_KEEP) {
            oracleSnapshots.shift()
          }
        }
      }
    }

    /* 2f. undo probe */
    if (!gameDiverged && step % 13 === 0 && clientState.undo.length > 0 && oracleSnapshots.length > 0) {
      const cUndo = seam.undoMove(clientState)
      const oracleBefore = oracleSnapshots.pop()
      checks += 1
      counts.undo += 1
      const undoContext = Object.assign({}, context, { phase: 'undo' })
      if (!cUndo.ok) {
        record('undo-refused', undoContext, { undoLength: clientState.undo.length })
        gameDiverged = true
      } else {
        refState = oracleBefore
        if (!comparePiles('undo-piles', undoContext, refState, clientState)) gameDiverged = true
      }
    }

    /* 2g. existing-state invariants */
    if (!gameDiverged) {
      checks += 1
      counts.invariant += 1
      const problems = ref.validateState(refState)
      if (problems.length) {
        record('invariant', context, { problems, piles: ref.exportPiles(refState) })
        gameDiverged = true
      }
      if (seam.hasWon(clientState) !== ref.isWon(refState)) {
        record('won-flag', context, { clientHasWon: seam.hasWon(clientState), oracleWon: ref.isWon(refState) })
        gameDiverged = true
      }
    }

    if (gameDiverged) break
    if (ref.isWon(refState)) {
      gamesWithWin += 1
      break
    }
  }

  if (!gameDiverged) {
    /* 3. final exhaustive comparison for this game */
    const finalResult = exhaustiveCanDrop(seed, steps, clientState, refState, actionLog)
    if (finalResult.ok) {
      gamesFinished += 1
      if (VERBOSE) console.log(`  seed ${seed}: ${steps} steps, final state OK (win=${ref.isWon(refState)})`)
    } else {
      record('final-exhaustive', { seed, steps }, {})
    }
  }
}

/* ------------------------------------------------------------------ *
 * Deterministic edge scenarios (constructed positions, not random play)
 * ------------------------------------------------------------------ */
runScenarios()
const scenarioFails = scenarioResults.filter((result) => !result.ok)

/* ------------------------------------------------------------------ *
 * Deal sweep: many more seeds than the random-game seeds, cheap and exact
 * ------------------------------------------------------------------ */
function dealSweep() {
  const total = Number(arg('deal-seeds', 512))
  let sweepFails = 0
  for (let index = 0; index < total; index += 1) {
    const seed = index < 4
      ? [0, 1, 0xffffffff, 0x7fffffff][index]
      : ((index + 1) * 2654435761) >>> 0
    const clientPiles = clientPilesToCanonical(seam.dealFromSeed(seed))
    const oraclePiles = ref.exportPiles(ref.dealFromSeed(seed))
    counts.deal += 1
    checks += 1
    const diffs = ref.diffPiles(oraclePiles, clientPiles)
    if (diffs) {
      sweepFails += 1
      if (sweepFails <= MAX_PRINTED) {
        record('deal-sweep', { seed }, { fields: diffs })
      }
    }
  }
  console.log(`deal sweep: ${total - sweepFails}/${total} seeds produce identical deals` +
    (sweepFails ? ` — ${sweepFails} differ` : ''))
  if (sweepFails === 0) sweepChecked = total
}
let sweepChecked = 0
dealSweep()

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
console.log('\n=== diff-fuzz summary ===')
console.log(`games: ${seeds.length} (${gamesFinished} completed cleanly, ${gamesWithWin} reached a win, ${mismatches.length ? 'divergences: ' + mismatches.length : '0 divergences'})`)
console.log(`deal sweep: ${sweepChecked} seeds compared (numeric seed -> identical 7-column deal + stock)`)
console.log(`edge scenarios: ${scenarioResults.length - scenarioFails.length}/${scenarioResults.length} passed`)
for (const result of scenarioResults) console.log(`  ${result.ok ? 'PASS' : 'FAIL'} ${result.name}`)
for (const result of scenarioFails) if (!mismatches.some((m) => m.context && m.context.scenario === result.name)) record('scenario-failed', { scenario: result.name }, {})
console.log(`actions executed: ${totalSteps}, elapsed ${elapsed}s`)
console.log(`comparisons: ${checks} total`)
for (const [key, value] of Object.entries(counts)) console.log(`  ${key.padEnd(10)} ${value}`)
console.log('mismatch kinds: ' + (mismatches.length ? mismatches.map((m) => m.kind).join(', ') : 'none'))
if (mismatches.length) {
  console.error('\nDIFF-FUZZ FAILED — first mismatch repro:')
  const first = mismatches[0]
  console.error('  seed=' + first.context.seed + ' step=' + first.context.step + ' action=' + first.context.action)
  console.error('  ' + JSON.stringify(first.detail, null, 2).slice(0, 4000))
  console.error('\nReplay that game: node packages/dsh-game-solitaire/dev/audit/diff-fuzz.mjs --seed ' + first.context.seed + ' --actions ' + (first.context.step + 1) + ' --verbose')
  process.exit(1)
}
console.log('\nDIFF-FUZZ OK')
