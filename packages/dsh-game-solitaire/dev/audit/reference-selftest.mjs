/**
 * reference-selftest.mjs — proves the independent oracle itself is correct.
 *
 * Run: node packages/dsh-game-solitaire/dev/audit/reference-selftest.mjs
 * Read-only. Exit 0 = all oracle self-checks pass.
 *
 * Why this file exists: diff-fuzz only means something if the reference model
 * is trustworthy, so the oracle's deal, move rules, recycle order, auto-flip,
 * win detection, purity and invariants are all asserted here independently.
 */
import assert from 'node:assert/strict'
import {
  SUITS, RANK_LABELS, cardCode, parseCardCode, shuffledDeck, dealFromSeed,
  cloneState, canDrop, applyMove, drawStock, autoMove, isWon, exportPiles,
  importPiles, validateState, validateDeal, createHistory, isValidRun, isRed,
} from './reference-solitaire.mjs'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
    console.error('not ok - ' + name)
    console.error(error && error.stack ? error.stack : error)
  }
}

const sum = (arr) => arr.reduce((a, b) => a + b, 0)

/* ------------------------------------------------------------------ *
 * 1. Deck / deal
 * ------------------------------------------------------------------ */

test('fresh deck: 52 unique cards, one per rank/suit', () => {
  const deck = shuffledDeck(1)
  assert.equal(deck.length, 52)
  const codes = new Set(deck.map(cardCode))
  assert.equal(codes.size, 52)
  for (const s of SUITS) {
    for (let r = 1; r <= 13; r += 1) assert.ok(codes.has(RANK_LABELS[r] + s), `${RANK_LABELS[r]}${s}`)
  }
})

test('card code round-trip for all 52 cards', () => {
  for (const s of SUITS) {
    for (let r = 1; r <= 13; r += 1) {
      const card = parseCardCode(RANK_LABELS[r] + s)
      assert.equal(card.r, r)
      assert.equal(card.s, s)
    }
  }
})

test('deal layout (7 columns 1..7, only tops up, 24 stock) over seeds 1..50', () => {
  for (let seed = 1; seed <= 50; seed += 1) {
    const state = dealFromSeed(seed)
    const problems = validateDeal(state)
    assert.deepEqual(problems, [], `seed ${seed}: ${problems.join(' | ')}`)
    assert.equal(state.tableau.length, 7)
    for (let col = 0; col < 7; col += 1) {
      assert.equal(state.tableau[col].length, col + 1, `seed ${seed} column ${col} length`)
      state.tableau[col].forEach((c, i) => assert.equal(c.up, i === state.tableau[col].length - 1))
    }
    assert.equal(state.stock.length, 24)
    assert.equal(sum(state.tableau.map((p) => p.length)) + state.stock.length, 52)
  }
})

test('deal is deterministic per seed and differs across seeds', () => {
  assert.deepEqual(exportPiles(dealFromSeed(12345)), exportPiles(dealFromSeed(12345)))
  assert.notDeepEqual(exportPiles(dealFromSeed(1)), exportPiles(dealFromSeed(2)))
  const distinct = new Set()
  for (let seed = 0; seed < 50; seed += 1) distinct.add(JSON.stringify(exportPiles(dealFromSeed(seed)).tableau))
  assert.equal(distinct.size, 50)
})

test('deal has no positional bias across seeds (each column sees varied ranks)', () => {
  // Sanity only: not a statistical test, but catches a broken/unshuffled deal
  // (e.g. stock always the tail of an ordered deck, or column 7 always K).
  const topSix = new Set()
  for (let seed = 0; seed < 200; seed += 1) topSix.add(cardCode(dealFromSeed(seed).tableau[6][6]))
  assert.ok(topSix.size > 20, `only ${topSix.size} distinct bottom-right cards across 200 deals`)
})

/* ------------------------------------------------------------------ *
 * 2. Stock / waste
 * ------------------------------------------------------------------ */

test('draw one card at a time; stock 24 then empty', () => {
  let state = dealFromSeed(99)
  const drawOrder = exportPiles(state).stock.slice()
  for (let i = 0; i < 24; i += 1) {
    const step = drawStock(state)
    assert.ok(step.ok)
    assert.equal(step.drawn && cardCode(step.drawn), drawOrder[i])
    state = step.state
    assert.equal(state.stock.length, 23 - i)
    assert.equal(state.waste.length, i + 1)
    assert.deepEqual(validateState(state), [], `after draw ${i}`)
  }
  // drawing an empty stock+waste pair is a no-op refusal
  assert.equal(drawStock(position({ stock: [], waste: [] })).ok, false)
  // stock empty but waste full -> the next tap recycles (ok:true, recycled)
  assert.equal(drawStock(state).recycled, true)
})

test('recycle returns the whole waste and repeats the same draw order (classic rule)', () => {
  let state = dealFromSeed(99)
  const drawOrder = exportPiles(state).stock.slice()
  for (let i = 0; i < 24; i += 1) state = drawStock(state).state
  const recycled = drawStock(state)
  assert.ok(recycled.ok && recycled.recycled === true)
  state = recycled.state
  assert.equal(state.waste.length, 0)
  assert.equal(state.stock.length, 24)
  const secondOrder = exportPiles(state).stock.slice()
  assert.deepEqual(secondOrder, drawOrder, 'after recycle the draw order must repeat')
  const again = drawStock(state)
  assert.ok(again.ok)
  assert.equal(cardCode(again.drawn), drawOrder[0])
  assert.equal(again.state.waste.length, 1)
})

/* ------------------------------------------------------------------ *
 * 3. Move rules on hand-crafted positions
 * ------------------------------------------------------------------ */

// helper: build a model state from readable card lists (canonical export shape
// is what importPiles consumes, so convert cards to codes / {c, up} entries)
function position({ tableau = [], foundations = { S: [], H: [], D: [], C: [] }, stock = [], waste = [] } = {}) {
  const cols = []
  for (let i = 0; i < 7; i += 1) cols.push(tableau[i] || [])
  const code = (entry) => (typeof entry === 'string' ? entry : cardCode(entry))
  return importPiles({
    stock: stock.map(code),
    waste: waste.map(code),
    tableau: cols.map((pile) => pile.map((c) => ({ c: cardCode(c), up: !!c.up }))),
    foundations: {
      S: foundations.S.map(code),
      H: foundations.H.map(code),
      D: foundations.D.map(code),
      C: foundations.C.map(code),
    },
    moves: 0,
  })
}
const card = (code) => ({ ...parseCardCode(code), up: true })
const down = (code) => ({ ...parseCardCode(code), up: false })

test('tableau: legal drop of 9H on 10S; same-color and wrong-rank rejected', () => {
  const state = position({
    tableau: [[card('9H')], [card('10S')], [card('10H')], [], [], [], []],
  })
  assert.deepEqual(canDrop(state, { zone: 'tableau', col: 0, index: 0 }, { zone: 'tableau', col: 1 }), { ok: true, run: [card('9H')] })
  assert.equal(canDrop(state, { zone: 'tableau', col: 0, index: 0 }, { zone: 'tableau', col: 2 }).ok, false) // same color
  assert.equal(canDrop(state, { zone: 'tableau', col: 0, index: 0 }, { zone: 'tableau', col: 3 }).ok, false) // empty needs king
  assert.equal(canDrop(state, { zone: 'tableau', col: 1, index: 0 }, { zone: 'tableau', col: 0 }).ok, false) // ascending
})

test('tableau: whole run moves when it is itself a legal sequence', () => {
  const state = position({
    tableau: [[card('10C')], [card('9H'), card('8S')], [], [], [], [], []],
  })
  const verdict = canDrop(state, { zone: 'tableau', col: 1, index: 0 }, { zone: 'tableau', col: 0 })
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.run.map(cardCode), ['9H', '8S'])
  const moved = applyMove(state, { zone: 'tableau', col: 1, index: 0 }, { zone: 'tableau', col: 0 })
  assert.equal(moved.ok, true)
  assert.deepEqual(moved.state.tableau[0].map(cardCode), ['10C', '9H', '8S'])
  assert.equal(moved.state.tableau[1].length, 0)
})

test('tableau: an invalid run cannot be moved (9H on 8H is not a sequence)', () => {
  const state = position({ tableau: [[card('10C')], [card('9H'), card('8H')], [], [], [], [], []] })
  const verdict = canDrop(state, { zone: 'tableau', col: 1, index: 0 }, { zone: 'tableau', col: 0 })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'run-not-a-valid-sequence')
})

test('tableau: face-down card can never be grabbed', () => {
  const state = position({ tableau: [[down('5C'), card('9H')], [], [], [], [], [], []] })
  assert.equal(canDrop(state, { zone: 'tableau', col: 0, index: 0 }, { zone: 'tableau', col: 1 }).ok, false)
  assert.equal(canDrop(state, { zone: 'tableau', col: 0, index: 1 }, { zone: 'tableau', col: 1 }).ok, false) // empty needs king
})

test('empty column only accepts K / K-headed run', () => {
  const state = position({
    tableau: [[card('KS')], [card('KH'), card('QS')], [card('QH')], [], [], [], []],
  })
  assert.equal(canDrop(state, { zone: 'tableau', col: 0, index: 0 }, { zone: 'tableau', col: 3 }).ok, true)
  assert.equal(canDrop(state, { zone: 'tableau', col: 1, index: 0 }, { zone: 'tableau', col: 3 }).ok, true)
  assert.equal(canDrop(state, { zone: 'tableau', col: 2, index: 0 }, { zone: 'tableau', col: 3 }).ok, false)
})

test('auto-flip: newly exposed tableau top card turns face up', () => {
  const state = position({
    tableau: [[down('5C'), card('9H'), card('8S')], [card('10C')], [], [], [], [], []],
  })
  const moved = applyMove(state, { zone: 'tableau', col: 0, index: 1 }, { zone: 'tableau', col: 1 })
  assert.equal(moved.ok, true)
  assert.equal(moved.state.tableau[0].length, 1)
  assert.equal(moved.state.tableau[0][0].up, true, '5C must be flipped automatically')
  // (validateState is a full-deck invariant; crafted partial positions are not 52 cards)
})

test('auto-flip: emptying a column leaves it empty (no phantom cards)', () => {
  const state = position({ tableau: [[card('KS')], [], [], [], [], [], []] })
  const moved = applyMove(state, { zone: 'tableau', col: 0, index: 0 }, { zone: 'tableau', col: 1 })
  assert.equal(moved.ok, true)
  assert.equal(moved.state.tableau[0].length, 0)
  assert.equal(moved.state.tableau[1].length, 1)
})

/* ------------------------------------------------------------------ *
 * 4. Foundations
 * ------------------------------------------------------------------ */

test('foundation: builds A -> K by suit, one rank at a time', () => {
  let state = position({ tableau: [[card('AS')], [card('2S')], [card('3H')], [card('KS')], [], [], []] })
  state = applyMove(state, { zone: 'tableau', col: 0, index: 0 }, { zone: 'foundation', suit: 'S' }).state
  assert.deepEqual(state.foundations.S.map(cardCode), ['AS'])
  const wrongSuit = applyMove(state, { zone: 'tableau', col: 2, index: 0 }, { zone: 'foundation', suit: 'S' })
  assert.equal(wrongSuit.ok, false)
  const wrongRank = applyMove(state, { zone: 'tableau', col: 3, index: 0 }, { zone: 'foundation', suit: 'S' })
  assert.equal(wrongRank.ok, false)
  const next = applyMove(state, { zone: 'tableau', col: 1, index: 0 }, { zone: 'foundation', suit: 'S' })
  assert.equal(next.ok, true)
  assert.deepEqual(next.state.foundations.S.map(cardCode), ['AS', '2S'])
})

test('foundation: only a single card can go to a foundation (never a run)', () => {
  const state = position({
    foundations: { S: ['AS'], H: [], D: [], C: [] },
    tableau: [[card('2S'), card('AH')], [], [], [], [], [], []],
  })
  // [2S, AH] is itself a valid descending alternating run, and 2S is the next
  // foundation card -- but a foundation can only ever receive ONE card.
  assert.equal(isValidRun([card('2S'), card('AH')]), true)
  const runToFoundation = canDrop(state, { zone: 'tableau', col: 0, index: 0 }, { zone: 'foundation', suit: 'S' })
  assert.equal(runToFoundation.ok, false)
  assert.equal(runToFoundation.reason, 'foundation-needs-single-card')
})

test('foundation -> tableau is NOT part of the v1 spec (rejected by default)', () => {
  const state = position({
    foundations: { S: ['AS', '2S'], H: [], D: [], C: [] },
    tableau: [[], [card('3H')], [], [], [], [], []],
  })
  // 2S could sit on 3H (black on red), but v1 never moves cards off foundations.
  assert.equal(canDrop(state, { zone: 'foundation', suit: 'S' }, { zone: 'tableau', col: 1 }).ok, false)
  // The oracle can expose the classic variant explicitly when a probe needs it.
  assert.equal(
    canDrop(state, { zone: 'foundation', suit: 'S' }, { zone: 'tableau', col: 1 }, { allowFromFoundation: true }).ok,
    true,
  )
})

/* ------------------------------------------------------------------ *
 * 5. Waste / stock moves
 * ------------------------------------------------------------------ */

test('waste top moves to tableau and foundation', () => {
  let state = position({ tableau: [[card('10C')], [], [], [], [], [], []], waste: [card('9H')] })
  assert.equal(canDrop(state, { zone: 'waste' }, { zone: 'tableau', col: 0 }).ok, true)
  assert.equal(canDrop(state, { zone: 'waste' }, { zone: 'tableau', col: 1 }).ok, false) // empty needs king
  const toTableau = applyMove(state, { zone: 'waste' }, { zone: 'tableau', col: 0 })
  assert.equal(toTableau.ok, true)
  assert.deepEqual(toTableau.state.tableau[0].map(cardCode), ['10C', '9H'])
  assert.equal(toTableau.state.waste.length, 0)
  state = position({ waste: [card('AS')] })
  assert.equal(canDrop(state, { zone: 'waste' }, { zone: 'foundation', suit: 'S' }).ok, true)
  assert.equal(canDrop(state, { zone: 'waste' }, { zone: 'foundation', suit: 'H' }).ok, false)
})

/* ------------------------------------------------------------------ *
 * 6. Auto-move (double-click) and win
 * ------------------------------------------------------------------ */

test('autoMove sends a playable top card to its foundation, refuses otherwise', () => {
  const state = position({ tableau: [[card('AS')], [card('2S')], [], [], [], [], []] })
  const moved = autoMove(state, { zone: 'tableau', col: 0, index: 0 })
  assert.equal(moved.ok, true)
  assert.deepEqual(moved.state.foundations.S.map(cardCode), ['AS'])
  // After AS is home, 2S is now the next foundation card and must auto-move too.
  const second = autoMove(moved.state, { zone: 'tableau', col: 1, index: 0 })
  assert.equal(second.ok, true)
  assert.deepEqual(second.state.foundations.S.map(cardCode), ['AS', '2S'])
  // A card that is not next in rank must be refused.
  assert.equal(autoMove(second.state, { zone: 'waste' }).ok, false)
})

test('autoMove only accepts the top card of a column', () => {
  const state = position({ tableau: [[down('5C'), card('6H'), card('7S')], [], [], [], [], [], []] })
  assert.equal(autoMove(state, { zone: 'tableau', col: 0, index: 1 }).ok, false)
  assert.equal(autoMove(state, { zone: 'tableau', col: 0, index: 2 }).ok, false) // 7S not next
})

test('win detection: all four foundations full', () => {
  const foundations = {}
  for (const s of SUITS) foundations[s] = Array.from({ length: 13 }, (_, i) => RANK_LABELS[i + 1] + s)
  const won = importPiles({ stock: [], waste: [], tableau: [[], [], [], [], [], [], []], foundations, moves: 0 })
  assert.equal(isWon(won), true)
  assert.equal(won.won, true)
  const notYet = cloneState(won)
  notYet.foundations.S.pop()
  assert.equal(isWon(notYet), false)
})

/* ------------------------------------------------------------------ *
 * 7. Purity + invariants + undo history
 * ------------------------------------------------------------------ */

test('illegal actions never mutate the input state (pure API)', () => {
  const state = dealFromSeed(4242)
  const before = JSON.stringify(exportPiles(state))
  const illegal = applyMove(state, { zone: 'tableau', col: 0, index: 0 }, { zone: 'tableau', col: 0 })
  assert.equal(illegal.ok, false)
  const badDraw = applyMove(state, { zone: 'waste' }, { zone: 'foundation', suit: 'S' })
  assert.equal(badDraw.ok, false)
  assert.equal(JSON.stringify(exportPiles(state)), before)
})

test('random self-play keeps all invariants for every step', () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    let state = dealFromSeed(seed * 1000 + 7)
    const rand = mulberry32(seed * 31 + 5)
    let draws = 0
    for (let step = 0; step < 250; step += 1) {
      const actions = enumerateLegalActions(state)
      if (actions.length === 0) break
      const action = actions[Math.floor(rand() * actions.length)]
      const result = action.kind === 'draw' ? drawStock(state) : applyMove(state, action.src, action.dst)
      if (action.kind === 'draw') draws += 1
      assert.equal(result.ok, true, `seed ${seed} step ${step}: legal action refused`)
      state = result.state
      const problems = validateState(state)
      assert.deepEqual(problems, [], `seed ${seed} step ${step}: ${problems.join(' | ')}`)
      if (isWon(state)) break
    }
    assert.ok(draws >= 0)
  }
})

test('history: push/undo restores exact snapshots and honours the limit', () => {
  let state = dealFromSeed(5)
  const history = createHistory(state, 30)
  assert.equal(history.canUndo(), false)
  assert.equal(history.undo(), null)
  const snapshots = [JSON.stringify(exportPiles(state))]
  for (let i = 0; i < 40; i += 1) {
    const step = drawStock(state)
    if (!step.ok) break
    state = step.state
    history.push(state)
    snapshots.push(JSON.stringify(exportPiles(state)))
  }
  assert.ok(history.length <= 31, `history length ${history.length}`)
  const last = snapshots[snapshots.length - 1]
  const previous = snapshots[snapshots.length - 2]
  assert.equal(JSON.stringify(exportPiles(state)), last)
  const undone = history.undo()
  assert.ok(undone)
  assert.equal(JSON.stringify(exportPiles(undone)), previous, 'undo must restore the exact previous snapshot')
  // Repeated undo keeps walking back through the retained snapshots.
  const twice = history.undo()
  assert.ok(twice)
  assert.equal(JSON.stringify(exportPiles(twice)), snapshots[snapshots.length - 3])
})

/* ------------------------------------------------------------------ *
 * local helpers
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function enumerateLegalActions(state) {
  const actions = []
  const dsts = []
  for (let col = 0; col < 7; col += 1) dsts.push({ zone: 'tableau', col })
  for (const suit of SUITS) dsts.push({ zone: 'foundation', suit })
  const srcs = [{ zone: 'waste' }]
  state.tableau.forEach((pile, col) => {
    pile.forEach((card, index) => {
      if (card.up) srcs.push({ zone: 'tableau', col, index })
    })
  })
  for (const src of srcs) {
    for (const dst of dsts) {
      if (canDrop(state, src, dst).ok) actions.push({ kind: 'move', src, dst })
    }
  }
  if (state.stock.length || state.waste.length) actions.push({ kind: 'draw' })
  return actions
}

/* ------------------------------------------------------------------ *
 * summary
 * ------------------------------------------------------------------ */

console.log(`\nreference oracle selftest: ${passed} passed, ${failures.length} failed`)
console.log(`isValidRun sanity: ${isValidRun([{ r: 9, s: 'H' }, { r: 8, s: 'S' }])} / ${isValidRun([{ r: 9, s: 'H' }, { r: 8, s: 'H' }])}`)
console.log(`isRed sanity: H=${isRed('H')} S=${isRed('S')}`)
if (failures.length) {
  console.error('ORACLE SELFTEST FAILED')
  process.exit(1)
}
console.log('ORACLE SELFTEST OK')
