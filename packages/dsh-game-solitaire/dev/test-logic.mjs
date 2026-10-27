/**
 * Pure-logic self test for @local/dsh-game-solitaire.
 *
 * Run: node dev/test-logic.mjs
 *
 * The browser bundle is the only entry, so the test imports client.js with a
 * minimal `window` stub and uses the opt-in test seam
 * (`window.__DSH_GAME_SOLITAIRE_TEST__ = true`). No React, DOM or host needed.
 */
import assert from 'node:assert/strict'

const storage = new Map()
let loadedDefinition = null

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
  },
  performance: { now: () => 0 },
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** card id from suit index (0 spade, 1 heart, 2 diamond, 3 club) + rank 1..13 */
function c(suit, rank) {
  return suit * 13 + (rank - 1)
}

const EMPTY = [[], [], [], [], [], [], []]

/**
 * Build a valid state from a compact spec. Unspecified cards land in the stock
 * (ascending id order) so every state contains exactly the 52 unique cards.
 */
function makeState(spec) {
  const options = spec || {}
  const foundations = [[], [], [], []]
  const foundationSpec = options.foundations || {}
  for (const key of Object.keys(foundationSpec)) {
    foundations[Number(key)] = foundationSpec[key].slice()
  }
  const waste = (options.waste || []).slice()
  const tableauSpec = options.tableau || EMPTY
  const tableau = tableauSpec.map(function (column) {
    return column.map(function (entry) {
      if (entry && typeof entry === 'object') return { id: entry.id, up: entry.up !== false }
      return { id: entry, up: true }
    })
  })
  assert.ok(tableau.length <= 7, 'at most 7 tableau columns')
  while (tableau.length < 7) tableau.push([])
  const used = new Set()
  function use(id) {
    assert.ok(Number.isInteger(id) && id >= 0 && id < 52, 'bad card id ' + id)
    assert.ok(!used.has(id), 'duplicate card id ' + id)
    used.add(id)
  }
  foundations.forEach(function (pile) {
    pile.forEach(use)
  })
  waste.forEach(use)
  tableau.forEach(function (column) {
    column.forEach(function (card) {
      use(card.id)
    })
  })
  const stock = []
  if (Array.isArray(options.stock)) {
    options.stock.forEach(function (id) {
      use(id)
      stock.push(id)
    })
  }
  for (let id = 0; id < 52; id += 1) {
    if (!used.has(id)) stock.push(id)
  }
  const raw = {
    schemaVersion: 1,
    seed: options.seed === undefined ? 7 : options.seed,
    started: options.started !== false,
    won: options.won === true,
    moves: options.moves || 0,
    elapsedMs: options.elapsedMs || 0,
    undo: [],
    stock: stock,
    waste: waste,
    foundations: foundations,
    tableau: tableau.map(function (column) {
      return column.map(function (card) {
        return card.up ? card.id : card.id + 52
      })
    }),
  }
  const state = api.sanitizeState(raw)
  assert.ok(state, 'makeState should produce a valid state: ' + JSON.stringify(options).slice(0, 180))
  return state
}

function assertPilesValid(state) {
  const seen = new Set()
  let total = 0
  function consume(id) {
    assert.ok(Number.isInteger(id) && id >= 0 && id < 52, 'bad id ' + id)
    assert.ok(!seen.has(id), 'duplicate card ' + id)
    seen.add(id)
    total += 1
  }
  state.stock.forEach(consume)
  state.waste.forEach(consume)
  state.foundations.forEach(function (pile, pileIndex) {
    pile.forEach(function (id, rankIndex) {
      assert.equal(api.cardSuit(id), pileIndex, 'foundation suit mismatch')
      assert.equal(api.cardRank(id), rankIndex + 1, 'foundation must start at A and ascend')
      consume(id)
    })
  })
  state.tableau.forEach(function (column) {
    let sawUp = false
    column.forEach(function (card) {
      if (card.up) sawUp = true
      else assert.equal(sawUp, false, 'face-down card below a face-up card')
      consume(card.id)
    })
    if (column.length) assert.equal(column[column.length - 1].up, true, 'top tableau card must be face up')
    const faceUpRun = column.filter(function (card) {
      return card.up
    }).map(function (card) {
      return card.id
    })
    assert.ok(api.isAlternatingRun(faceUpRun), 'face-up tableau run must descend alternating colors')
  })
  assert.equal(total, 52, 'all 52 cards must be present exactly once')
  const allWon = state.foundations.every(function (pile) {
    return pile.length === 13
  })
  assert.equal(state.won, allWon, 'won flag must match full foundations')
}

function clone(state) {
  return JSON.parse(JSON.stringify(state))
}

// ---------------------------------------------------------------------------
// Tests — deal
// ---------------------------------------------------------------------------

test('deal: 7 columns of 1..7 cards, last card face up, 24 stock', function () {
  for (const seed of [0, 1, 42, 123456789, 0xffffffff, 0x9e3779b9]) {
    const state = api.emptyState(seed)
    assert.equal(state.stock.length, 24)
    assert.equal(state.waste.length, 0)
    assert.deepEqual(state.foundations, [[], [], [], []])
    assert.equal(state.tableau.length, 7)
    state.tableau.forEach(function (column, index) {
      assert.equal(column.length, index + 1, 'column ' + index + ' length')
      column.forEach(function (card, cardIndex) {
        assert.equal(card.up, cardIndex === column.length - 1, 'only last card face up')
      })
    })
    assertPilesValid(state)
    assert.equal(state.moves, 0)
    assert.equal(state.elapsedMs, 0)
    assert.equal(state.started, false)
    assert.equal(state.won, false)
    assert.equal(state.undo.length, 0)
  }
})

test('deal: deterministic per seed and different across seeds', function () {
  for (const seed of [0, 1, 7, 999, 0x12345678]) {
    const a = api.emptyState(seed)
    const b = api.emptyState(seed)
    assert.equal(JSON.stringify(api.serializeState(a)), JSON.stringify(api.serializeState(b)))
  }
  const decks = new Set()
  for (let seed = 1; seed <= 24; seed += 1) {
    const state = api.emptyState(seed)
    const signature = state.stock.concat(state.tableau.flat().map((card) => card.id)).join(',')
    decks.add(signature)
  }
  assert.ok(decks.size >= 23, 'seeds should produce distinct deals (got ' + decks.size + '/24)')
})

test('deal: shuffled deck is a permutation of 0..51', function () {
  for (let seed = 0; seed < 20; seed += 1) {
    const deck = api.shuffledDeck(seed)
    assert.equal(deck.length, 52)
    assert.deepEqual(deck.slice().sort((a, b) => a - b), Array.from({ length: 52 }, (_, i) => i))
  }
})

// ---------------------------------------------------------------------------
// Tests — serialization / sanitize
// ---------------------------------------------------------------------------

test('save: serialize → sanitize round trip is lossless', function () {
  for (let seed = 0; seed < 12; seed += 1) {
    const state = api.emptyState(seed)
    const json = JSON.stringify(api.serializeState(state))
    const restored = api.sanitizeState(JSON.parse(json))
    assert.ok(restored)
    assert.equal(JSON.stringify(api.serializeState(restored)), json)
    assertPilesValid(restored)
  }
})

test('save: rejects malformed or inconsistent saves', function () {
  const base = api.serializeState(api.emptyState(3))
  const cases = []

  cases.push(['null', null])
  cases.push(['array', []])
  cases.push(['string', 'nope'])
  cases.push(['wrong schema', Object.assign({}, base, { schemaVersion: 2 })])
  cases.push(['bad seed', Object.assign({}, base, { seed: -1 })])
  cases.push(['bad seed float', Object.assign({}, base, { seed: 1.5 })])

  const duplicate = clone(base)
  duplicate.stock[0] = duplicate.stock[1]
  cases.push(['duplicate card', duplicate])

  const missing = clone(base)
  missing.stock.pop()
  cases.push(['missing card', missing])

  const badId = clone(base)
  badId.waste.push(52)
  cases.push(['out of range id', badId])

  const badFoundation = clone(base)
  badFoundation.foundations[0] = [c(1, 1)]
  cases.push(['foundation wrong suit', badFoundation])

  const skippedFoundation = clone(base)
  skippedFoundation.foundations[0] = [c(0, 2)]
  cases.push(['foundation must start with A', skippedFoundation])

  const badTableauOrder = clone(base)
  badTableauOrder.tableau[0] = [c(0, 7), c(0, 8)]
  cases.push(['tableau run not descending', badTableauOrder])

  const sameColorRun = clone(base)
  sameColorRun.tableau[0] = [c(1, 7), c(0, 6)]
  cases.push(['tableau run same color', sameColorRun])

  const faceDownTop = clone(base)
  faceDownTop.tableau[1] = [c(2, 5) + 52]
  cases.push(['face-down top card', faceDownTop])

  const downUnderUp = clone(base)
  downUnderUp.tableau[2] = [c(0, 9) + 52, c(1, 7), c(0, 6)]
  cases.push(['face-down under face-up', downUnderUp])

  cases.push(['negative elapsed', Object.assign({}, base, { elapsedMs: -5 })])
  cases.push(['huge elapsed', Object.assign({}, base, { elapsedMs: 8 * 24 * 3600 * 1000 })])
  cases.push(['negative moves', Object.assign({}, base, { moves: -1 })])
  cases.push(['won mismatch', Object.assign({}, base, { won: true })])
  cases.push(['won with 12-card foundation', (function () {
    const raw = clone(base)
    raw.won = true
    return raw
  })()])
  cases.push(['tableau not 7 columns', Object.assign({}, base, { tableau: base.tableau.slice(0, 6) })])
  cases.push(['foundations not 4', Object.assign({}, base, { foundations: base.foundations.slice(0, 3) })])

  for (const [label, raw] of cases) {
    assert.equal(api.sanitizeState(raw), null, 'should reject: ' + label)
  }

  // A save with garbage undo entries but a valid board is still accepted, with
  // the garbage dropped.
  const raw = clone(base)
  raw.undo = [{ nope: true }, 'x', null]
  const accepted = api.sanitizeState(raw)
  assert.ok(accepted)
  assert.equal(accepted.undo.length, 0)
})

test('save: undo snapshots survive save/load and stay capped', function () {
  const state = api.emptyState(11)
  for (let i = 0; i < 70; i += 1) {
    api.pushUndo(state)
    state.moves += 1
  }
  assert.equal(state.undo.length, 70)
  const serialized = api.serializeState(state)
  assert.equal(serialized.undo.length, api.SAVE_UNDO)
  const restored = api.sanitizeState(JSON.parse(JSON.stringify(serialized)))
  assert.ok(restored)
  assert.equal(restored.undo.length, api.SAVE_UNDO)
  assertPilesValid(restored)
})

test('save: storage key is dsh.game.solitaire.v1', function () {
  assert.equal(api.STORE_KEY, 'dsh.game.solitaire.v1')
  api.saveStateToStorage(api.emptyState(1))
  assert.ok(storage.has('dsh.game.solitaire.v1'))
  storage.clear()
})

// ---------------------------------------------------------------------------
// Tests — selection
// ---------------------------------------------------------------------------

test('selection: waste top, foundation top and tableau runs', function () {
  const state = makeState({
    foundations: { 0: [c(0, 1), c(0, 2)] },
    waste: [c(1, 4), c(1, 5)],
    tableau: [[c(0, 9), c(1, 8), c(0, 7)]],
  })
  assert.deepEqual(api.selectionCards(state, { kind: 'waste' }), [c(1, 5)])
  assert.deepEqual(api.selectionCards(state, { kind: 'foundation', pile: 0 }), [c(0, 2)])
  assert.deepEqual(api.selectionCards(state, { kind: 'tableau', col: 0, index: 0 }), [c(0, 9), c(1, 8), c(0, 7)])
  assert.deepEqual(api.selectionCards(state, { kind: 'tableau', col: 0, index: 2 }), [c(0, 7)])
  assert.equal(api.selectionCards(state, { kind: 'tableau', col: 0, index: 3 }), null)
  assert.equal(api.selectionCards(state, { kind: 'tableau', col: 0, index: -1 }), null)
  assert.equal(api.selectionCards(state, { kind: 'foundation', pile: 1 }), null)
  assert.equal(api.selectionCards(state, { kind: 'tableau', col: 2, index: 0 }), null)
  assert.equal(api.selectionCards(state, null), null)
})

test('selection: a face-down card inside a run makes the selection invalid', function () {
  const state = makeState({ tableau: [[{ id: c(2, 5), up: false }, { id: c(1, 7), up: true }]] })
  assert.equal(api.selectionCards(state, { kind: 'tableau', col: 0, index: 0 }), null)
  assert.deepEqual(api.selectionCards(state, { kind: 'tableau', col: 0, index: 1 }), [c(1, 7)])
})

// ---------------------------------------------------------------------------
// Tests — tableau move rules
// ---------------------------------------------------------------------------

test('tableau: descending alternating colour moves are legal', function () {
  const state = makeState({
    tableau: [
      [c(0, 8)], // 8♠ black
      [c(1, 7)], // 7♥ red
      [c(3, 6)], // 6♣ black
      [c(2, 5)], // 5♦ red
    ],
  })
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 1, index: 0 }, { kind: 'tableau', col: 0 }).ok, true)
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 2, index: 0 }, { kind: 'tableau', col: 1 }).ok, true)
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 3, index: 0 }, { kind: 'tableau', col: 2 }).ok, true)
})

test('tableau: same colour, wrong rank and same column are rejected', function () {
  const state = makeState({
    tableau: [
      [c(1, 8)], // 8♥ red
      [c(3, 8)], // 8♣ black
      [c(1, 9)], // 9♥ red
      [c(1, 7)], // 7♥ red
      [c(0, 7), c(1, 6)], // 7♠ black on 6♥ red
    ],
  })
  const red7 = { kind: 'tableau', col: 3, index: 0 }
  assert.equal(api.canDrop(state, red7, { kind: 'tableau', col: 0 }).ok, false) // 7♥ on 8♥ same colour
  assert.equal(api.canDrop(state, red7, { kind: 'tableau', col: 1 }).ok, true) // 7♥ on 8♣
  assert.equal(api.canDrop(state, red7, { kind: 'tableau', col: 2 }).ok, false) // 7 on 9 wrong rank
  assert.equal(api.canDrop(state, red7, { kind: 'tableau', col: 3 }).ok, false) // same column
  const black7 = { kind: 'tableau', col: 4, index: 0 }
  assert.equal(api.canDrop(state, black7, { kind: 'tableau', col: 0 }).ok, true) // 7♠ on 8♥
  assert.equal(api.canDrop(state, black7, { kind: 'tableau', col: 1 }).ok, false) // same colour
})

test('tableau: empty column accepts only a K-headed run', function () {
  const state = makeState({
    tableau: [
      [c(3, 13), c(1, 12), c(3, 11)], // K♣ Q♥ J♣
      [c(2, 12), c(0, 11)], // Q♦ J♠
      [],
    ],
  })
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 0, index: 0 }, { kind: 'tableau', col: 2 }).ok, true)
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 0, index: 1 }, { kind: 'tableau', col: 2 }).ok, false)
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 1, index: 0 }, { kind: 'tableau', col: 2 }).ok, false)
  const applied = api.applyMove(state, { kind: 'tableau', col: 0, index: 0 }, { kind: 'tableau', col: 2 })
  assert.equal(applied.ok, true)
  assert.equal(applied.moved, 3)
  assert.equal(state.tableau[0].length, 0)
  assert.deepEqual(state.tableau[2].map((card) => card.id), [c(3, 13), c(1, 12), c(3, 11)])
  assertPilesValid(state)
})

test('tableau: auto-flips a newly exposed top card', function () {
  const state = makeState({
    tableau: [
      [{ id: c(2, 5), up: false }, { id: c(1, 7), up: true }],
      [c(0, 8)],
    ],
  })
  assert.equal(state.tableau[0][0].up, false)
  const result = api.applyMove(state, { kind: 'tableau', col: 0, index: 1 }, { kind: 'tableau', col: 1 })
  assert.equal(result.ok, true)
  assert.equal(state.tableau[0].length, 1)
  assert.equal(state.tableau[0][0].up, true, 'exposed card must auto-flip')
  assertPilesValid(state)
})

test('tableau: moving a run leaves lower cards and flips only the exposed top', function () {
  const state = makeState({
    tableau: [
      [{ id: c(3, 4), up: false }, c(0, 9), c(1, 8), c(0, 7)],
      [c(1, 10)],
      [c(2, 10)],
    ],
  })
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 0, index: 1 }, { kind: 'tableau', col: 2 }).ok, true) // 9♠ on 10♦
  const move = api.applyMove(state, { kind: 'tableau', col: 0, index: 1 }, { kind: 'tableau', col: 2 })
  assert.equal(move.ok, true)
  assert.equal(move.moved, 3)
  assert.equal(state.tableau[0].length, 1)
  assert.equal(state.tableau[0][0].up, true)
  assert.deepEqual(state.tableau[2].map((card) => card.id), [c(2, 10), c(0, 9), c(1, 8), c(0, 7)])
  assertPilesValid(state)
})

test('tableau: invalid moves never mutate the state', function () {
  const state = makeState({
    tableau: [[c(1, 7)], [c(2, 8)], [], [c(0, 5)]],
  })
  const before = JSON.stringify(api.serializeState(state))
  const attempts = [
    api.applyMove(state, { kind: 'tableau', col: 0, index: 0 }, { kind: 'tableau', col: 1 }), // 7♥ on 8♦ same colour
    api.applyMove(state, { kind: 'tableau', col: 0, index: 0 }, { kind: 'tableau', col: 2 }), // 7 not K
    api.applyMove(state, { kind: 'tableau', col: 1, index: 0 }, { kind: 'tableau', col: 0 }), // 8 on 7
    api.applyMove(state, { kind: 'tableau', col: 3, index: 0 }, { kind: 'tableau', col: 3 }), // same col
    api.applyMove(state, { kind: 'waste' }, { kind: 'tableau', col: 0 }), // empty waste
  ]
  attempts.forEach(function (result) {
    assert.equal(result.ok, false)
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
  })
  assert.equal(JSON.stringify(api.serializeState(state)), before)
})

// ---------------------------------------------------------------------------
// Tests — foundation rules
// ---------------------------------------------------------------------------

test('foundation: same suit ascending from A, one card at a time only', function () {
  const state = makeState({
    foundations: { 0: [c(0, 1)], 1: [c(1, 1), c(1, 2)] },
    tableau: [[c(0, 2)], [c(3, 2)], [c(3, 3), c(2, 2)], [c(1, 3)]],
  })
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 0, index: 0 }, { kind: 'foundation', pile: 0 }).ok, true)
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 1, index: 0 }, { kind: 'foundation', pile: 0 }).ok, false) // wrong suit
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 0, index: 0 }, { kind: 'foundation', pile: 1 }).ok, false) // wrong suit
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 2, index: 0 }, { kind: 'foundation', pile: 0 }).ok, false) // two cards
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 2, index: 1 }, { kind: 'foundation', pile: 2 }).ok, false) // 2♦ needs A♦
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 1, index: 0 }, { kind: 'foundation', pile: 3 }).ok, false) // 2♣ needs A♣
  // foundation 1 holds A♥,2♥ so 3♥ is legal:
  assert.equal(api.canDrop(state, { kind: 'tableau', col: 3, index: 0 }, { kind: 'foundation', pile: 1 }).ok, true)
  const applied = api.applyMove(state, { kind: 'tableau', col: 0, index: 0 }, { kind: 'foundation', pile: 0 })
  assert.equal(applied.ok, true)
  assert.deepEqual(state.foundations[0], [c(0, 1), c(0, 2)])
  assertPilesValid(state)
})

test('foundation: a card can be moved back out to the tableau', function () {
  const state = makeState({
    foundations: { 1: [c(1, 1)] },
    tableau: [[c(0, 2)], []],
  })
  const selection = { kind: 'foundation', pile: 1 }
  assert.equal(api.canDrop(state, selection, { kind: 'tableau', col: 0 }).ok, true) // A♥ on 2♠
  assert.equal(api.canDrop(state, selection, { kind: 'tableau', col: 1 }).ok, false) // A is not K
  const applied = api.applyMove(state, selection, { kind: 'tableau', col: 0 })
  assert.equal(applied.ok, true)
  assert.deepEqual(state.foundations[1], [])
  assert.deepEqual(state.tableau[0].map((card) => card.id), [c(0, 2), c(1, 1)])
  assertPilesValid(state)
})

test('foundation: winning when all four foundations reach K', function () {
  const foundations = [[], [], [], []]
  for (let suit = 0; suit < 4; suit += 1) {
    for (let rank = 1; rank <= 12; rank += 1) foundations[suit].push(c(suit, rank))
  }
  const kings = [c(0, 13), c(1, 13), c(2, 13), c(3, 13)]
  const state = makeState({
    foundations: { 0: foundations[0], 1: foundations[1], 2: foundations[2], 3: foundations[3] },
    tableau: [[kings[0]], [kings[1]], [kings[2]], [kings[3]], [], [], []],
  })
  assert.equal(state.won, false)
  for (let suit = 0; suit < 4; suit += 1) {
    api.pushUndo(state)
    const result = api.applyMove(state, { kind: 'tableau', col: suit, index: 0 }, { kind: 'foundation', pile: suit })
    assert.equal(result.ok, true)
    assert.equal(result.won, suit === 3)
  }
  assert.equal(state.won, true)
  assert.equal(api.hasWon(state), true)
  assertPilesValid(state)
  const undone = api.undoMove(state)
  assert.equal(undone.ok, true)
  assert.equal(state.won, false)
  assert.equal(state.foundations[3].length, 12)
  assertPilesValid(state)
})

// ---------------------------------------------------------------------------
// Tests — stock / waste
// ---------------------------------------------------------------------------

test('stock: draws one card at a time onto the waste', function () {
  const state = makeState({ stock: [c(0, 3), c(1, 9)], tableau: [[]] })
  // makeState appends the remaining 50 cards; the explicit ones are at the bottom.
  const topBefore = state.stock[state.stock.length - 1]
  const result = api.drawStock(state)
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'draw')
  assert.equal(state.waste.length, 1)
  assert.equal(state.waste[0], topBefore)
  assert.equal(state.moves, 1)
  assert.equal(state.started, true)
  assertPilesValid(state)
})

test('stock: recycling flips the waste so the first drawn card returns first', function () {
  const state = makeState({
    stock: [],
    waste: [c(0, 1), c(0, 2), c(0, 3)],
    tableau: [[], [], [], [], [], [], []],
  })
  // makeState pushed the explicit stock/waste and the rest into stock; clear it
  // to test the recycle path with only these three cards in the waste.
  state.stock = []
  const result = api.drawStock(state)
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'recycle')
  assert.equal(state.waste.length, 0)
  assert.equal(state.stock.length, 3)
  const drawn = []
  for (let i = 0; i < 3; i += 1) {
    const draw = api.drawStock(state)
    assert.equal(draw.ok, true)
    drawn.push(state.waste[state.waste.length - 1])
  }
  assert.deepEqual(drawn, [c(0, 1), c(0, 2), c(0, 3)])
})

test('stock: empty stock and waste is a no-op with a reason', function () {
  const state = makeState({ stock: [], waste: [], tableau: [[], [], [], [], [], [], []] })
  state.stock = []
  const before = JSON.stringify(api.serializeState(state))
  const result = api.drawStock(state)
  assert.equal(result.ok, false)
  assert.ok(result.reason)
  assert.equal(JSON.stringify(api.serializeState(state)), before)
})

test('waste top can be played to the tableau and to a foundation', function () {
  const state = makeState({
    waste: [c(2, 4), c(1, 7)],
    tableau: [[c(0, 8)], []],
    foundations: { 1: [] },
  })
  assert.equal(api.canDrop(state, { kind: 'waste' }, { kind: 'tableau', col: 0 }).ok, true)
  assert.equal(api.applyMove(state, { kind: 'waste' }, { kind: 'tableau', col: 0 }).ok, true)
  assert.deepEqual(state.tableau[0].map((card) => card.id), [c(0, 8), c(1, 7)])
  assertPilesValid(state)

  const state2 = makeState({ waste: [c(2, 3), c(0, 1)], tableau: [[]] })
  assert.equal(api.applyMove(state2, { kind: 'waste' }, { kind: 'foundation', pile: 0 }).ok, true)
  assert.deepEqual(state2.foundations[0], [c(0, 1)])
  assertPilesValid(state2)
})

// ---------------------------------------------------------------------------
// Tests — double-click auto move
// ---------------------------------------------------------------------------

test('double-click: top cards auto-move to the right foundation', function () {
  const state = makeState({
    foundations: { 0: [c(0, 1)], 1: [c(1, 1)] },
    tableau: [[c(0, 2)], [c(2, 9), c(3, 8)], [c(2, 2)]],
    waste: [c(0, 3)],
  })
  const preview = api.autoMoveToFoundation(state, { kind: 'tableau', col: 0, index: 0 })
  assert.equal(preview.ok, true)
  assert.equal(preview.pile, 0)
  assert.equal(api.applyMove(state, preview.selection, preview.target).ok, true)
  assert.deepEqual(state.foundations[0], [c(0, 1), c(0, 2)])

  const preview2 = api.autoMoveToFoundation(state, { kind: 'waste' })
  assert.equal(preview2.ok, true)
  assert.equal(preview2.pile, 0)
  assert.equal(api.applyMove(state, preview2.selection, preview2.target).ok, true)
  assert.deepEqual(state.foundations[0], [c(0, 1), c(0, 2), c(0, 3)])
  assertPilesValid(state)
})

test('double-click: rejects covered, face-down and unplaceable cards', function () {
  const state = makeState({
    tableau: [
      [c(2, 9), c(3, 8)], // 9♦ covered by 8♣
      [c(3, 9)], // 9♣ has no foundation target
    ],
  })
  assert.equal(api.autoMoveToFoundation(state, { kind: 'tableau', col: 0, index: 0 }).ok, false)
  assert.equal(api.autoMoveToFoundation(state, { kind: 'tableau', col: 1, index: 0 }).ok, false)
  assert.equal(api.autoMoveToFoundation(state, { kind: 'foundation', pile: 0 }).ok, false)
  // A face-down top card is not reachable through a valid save, but the guard
  // must still refuse to move it.
  state.tableau[1][0].up = false
  assert.equal(api.autoMoveToFoundation(state, { kind: 'tableau', col: 1, index: 0 }).ok, false)
})

// ---------------------------------------------------------------------------
// Tests — undo / restart
// ---------------------------------------------------------------------------

test('undo: restores piles, moves and win flag exactly', function () {
  const state = makeState({ tableau: [[c(0, 8)], [c(1, 7)]] })
  api.pushUndo(state)
  api.applyMove(state, { kind: 'tableau', col: 1, index: 0 }, { kind: 'tableau', col: 0 })
  const afterMove = JSON.stringify(api.serializeState(state))
  assert.notEqual(afterMove, JSON.stringify(api.serializeState({ ...state, moves: 0 })))
  const undone = api.undoMove(state)
  assert.equal(undone.ok, true)
  assert.deepEqual(state.tableau[0].map((card) => card.id), [c(0, 8)])
  assert.deepEqual(state.tableau[1].map((card) => card.id), [c(1, 7)])
  assert.equal(state.moves, 0)
  assertPilesValid(state)
  assert.equal(api.undoMove(state).ok, false)
})

test('undo: empty stack reports a reason', function () {
  const state = api.emptyState(1)
  const result = api.undoMove(state)
  assert.equal(result.ok, false)
  assert.ok(result.reason)
})

test('undo: pushUndo caps the in-memory stack', function () {
  const state = api.emptyState(2)
  for (let i = 0; i < api.MAX_UNDO_KEEP + 25; i += 1) api.pushUndo(state)
  assert.equal(state.undo.length, api.MAX_UNDO_KEEP)
})

test('restart: same seed replays the exact deal and resets counters', function () {
  const state = api.emptyState(1234)
  const firstDeal = JSON.stringify(api.serializeState(state))
  api.pushUndo(state)
  api.drawStock(state)
  api.drawStock(state)
  state.elapsedMs = 5000
  state.moves = 9
  const restarted = api.restartState(state)
  assert.equal(JSON.stringify(api.serializeState(restarted)), firstDeal)
  assert.equal(restarted.moves, 0)
  assert.equal(restarted.elapsedMs, 0)
  assert.equal(restarted.started, false)
  assert.equal(restarted.won, false)
  assert.equal(restarted.undo.length, 0)
  assertPilesValid(restarted)
})

// ---------------------------------------------------------------------------
// Tests — layout
// ---------------------------------------------------------------------------

test('layout: rejects tiny stages, scales between 320x240 and 4K', function () {
  const state = api.emptyState(8)
  assert.equal(api.computeLayout(319, 240, state.tableau), null)
  assert.equal(api.computeLayout(320, 239, state.tableau), null)
  assert.equal(api.computeLayout(0, 0, state.tableau), null)
  for (const size of [[320, 240], [360, 520], [720, 600], [1100, 700], [1920, 1080], [3840, 2160]]) {
    const layout = api.computeLayout(size[0], size[1], state.tableau)
    assert.ok(layout, 'layout for ' + size.join('x'))
    assert.ok(layout.cardW > 0)
    assert.ok(Math.abs(layout.cardH / layout.cardW - 1.4) < 1e-6)
    assert.ok(layout.cardW * 7 + layout.colGap * 6 <= size[0] + 1e-6)
    assert.ok(layout.colX[0] >= 0 && layout.colX[6] + layout.cardW <= size[0] + 1e-6)
    assert.ok(layout.stockX >= 0 && layout.wasteX + layout.cardW <= size[0] + 1e-6)
    layout.foundationX.forEach(function (x) {
      assert.ok(x >= 0 && x + layout.cardW <= size[0] + 1e-6)
    })
    assert.ok(layout.topY >= 0 && layout.tableauTop + layout.tableauH <= size[1] + 1e-6)
  }
})

test('layout: column offsets are monotonic and fit the available height', function () {
  const run = [
    c(0, 13), c(1, 12), c(0, 11), c(1, 10), c(0, 9), c(1, 8), c(0, 7),
    c(1, 6), c(0, 5), c(1, 4), c(0, 3), c(1, 2), c(0, 1),
  ]
  const state = makeState({ tableau: [run] })
  for (const size of [[320, 240], [720, 600], [1100, 700]]) {
    const layout = api.computeLayout(size[0], size[1], state.tableau)
    assert.ok(layout)
    assert.equal(layout.colOffsets[0].length, 13)
    for (let i = 1; i < 13; i += 1) {
      assert.ok(layout.colOffsets[0][i] > layout.colOffsets[0][i - 1], 'offsets increase')
    }
    const bottom = layout.colOffsets[0][12] + layout.cardH
    assert.ok(bottom <= layout.tableauH + 0.001, 'column bottom inside tableau area')
    // sanity: 12 gaps are visible (positive)
    assert.ok(layout.colOffsets[0][1] > 0)
  }
})

test('layout: is deterministic and centered', function () {
  const state = api.emptyState(3)
  const a = api.computeLayout(720, 600, state.tableau)
  const b = api.computeLayout(720, 600, state.tableau)
  assert.deepEqual(a, b)
  const usedW = a.cardW * 7 + a.colGap * 6
  assert.ok(Math.abs(a.offsetX - (a.width - usedW) / 2) < 1e-6, 'grid is horizontally centered')
})

// ---------------------------------------------------------------------------
// Tests — misc helpers
// ---------------------------------------------------------------------------

test('cards: ids, labels, colours', function () {
  assert.equal(api.cardSuit(c(0, 13)), 0)
  assert.equal(api.cardRank(c(3, 1)), 1)
  assert.equal(api.cardLabel(c(1, 1)), '♥A')
  assert.equal(api.cardIsRed(c(1, 5)), true)
  assert.equal(api.cardIsRed(c(2, 5)), true)
  assert.equal(api.cardIsRed(c(0, 5)), false)
  assert.equal(api.cardIsRed(c(3, 5)), false)
})

test('formatDuration: mm:ss and h:mm:ss', function () {
  assert.equal(api.formatDuration(0), '00:00')
  assert.equal(api.formatDuration(59), '00:59')
  assert.equal(api.formatDuration(60), '01:00')
  assert.equal(api.formatDuration(3599), '59:59')
  assert.equal(api.formatDuration(3600), '1:00:00')
  assert.equal(api.formatDuration(3661), '1:01:01')
  assert.equal(api.formatDuration(-4), '00:00')
})

// ---------------------------------------------------------------------------
// Random play fuzz: only public mutating APIs, invariants after every action
// ---------------------------------------------------------------------------

function legalActions(state) {
  const actions = []
  const sources = []
  if (state.waste.length) sources.push({ kind: 'waste' })
  state.tableau.forEach(function (column, col) {
    for (let index = 0; index < column.length; index += 1) {
      if (column[index].up) sources.push({ kind: 'tableau', col: col, index: index })
    }
  })
  state.foundations.forEach(function (pile, pileIndex) {
    if (pile.length) sources.push({ kind: 'foundation', pile: pileIndex })
  })
  for (const source of sources) {
    for (let col = 0; col < 7; col += 1) {
      if (api.canDrop(state, source, { kind: 'tableau', col: col }).ok) {
        actions.push({ type: 'move', selection: source, target: { kind: 'tableau', col: col } })
      }
    }
    for (let pile = 0; pile < 4; pile += 1) {
      if (api.canDrop(state, source, { kind: 'foundation', pile: pile }).ok) {
        actions.push({ type: 'move', selection: source, target: { kind: 'foundation', pile: pile } })
      }
    }
  }
  if (state.stock.length || state.waste.length) actions.push({ type: 'draw' })
  return actions
}

test('fuzz: random play keeps every invariant and undo is exact', function () {
  const rnd = api.mulberry32(20261018)
  let actions = 0
  let undos = 0
  let wins = 0
  for (let game = 0; game < 40; game += 1) {
    const seed = (game * 2654435761 + 12345) >>> 0
    const state = api.emptyState(seed)
    assertPilesValid(state)
    for (let step = 0; step < 250; step += 1) {
      const options = legalActions(state)
      if (!options.length) break
      const raise = rnd()
      if (raise < 0.12 && state.undo.length) {
        const undone = api.undoMove(state)
        assert.equal(undone.ok, true)
        undos += 1
      } else {
        const action = options[Math.floor(rnd() * options.length)]
        api.pushUndo(state)
        let result
        if (action.type === 'draw') result = api.drawStock(state)
        else result = api.applyMove(state, action.selection, action.target)
        if (!result.ok) {
          state.undo.pop()
          throw new Error('legal action rejected: ' + JSON.stringify(action) + ' -> ' + result.reason)
        }
        if (result.won) wins += 1
        actions += 1
      }
      assertPilesValid(state)
      assert.equal(state.won, api.hasWon(state))
    }
    // Re-sanitize the final position; it must survive a save/load cycle.
    const saved = api.serializeState(state)
    const restored = api.sanitizeState(JSON.parse(JSON.stringify(saved)))
    assert.ok(restored)
    assert.equal(JSON.stringify(api.serializeState(restored)), JSON.stringify(saved))
    assertPilesValid(restored)
  }
  assert.ok(actions > 5000, 'fuzz should run plenty of actions, got ' + actions)
  console.log('   fuzz: ' + actions + ' actions, ' + undos + ' undos, ' + wins + ' wins')
})

test('fuzz: corrupted saves never throw', function () {
  const base = JSON.stringify(api.serializeState(api.emptyState(77)))
  const rnd = api.mulberry32(424242)
  let rejected = 0
  let accepted = 0
  for (let i = 0; i < 3000; i += 1) {
    let raw
    try {
      raw = JSON.parse(base)
    } catch (error) {
      throw error
    }
    const mutations = 1 + Math.floor(rnd() * 4)
    for (let m = 0; m < mutations; m += 1) {
      const keys = ['schemaVersion', 'seed', 'started', 'won', 'moves', 'elapsedMs', 'stock', 'waste', 'foundations', 'tableau', 'undo']
      const key = keys[Math.floor(rnd() * keys.length)]
      const mode = rnd()
      if (mode < 0.2) delete raw[key]
      else if (mode < 0.5) raw[key] = null
      else if (mode < 0.7) raw[key] = 'corrupt'
      else if (mode < 0.9) raw[key] = Math.floor(rnd() * 1000)
      else raw[key] = { weird: true }
    }
    let result
    try {
      result = api.sanitizeState(raw)
    } catch (error) {
      throw new Error('sanitizeState threw on fuzz iteration ' + i + ': ' + error.message)
    }
    if (result) {
      accepted += 1
      assertPilesValid(result)
    } else {
      rejected += 1
    }
  }
  assert.ok(rejected > 1000, 'most corrupted saves should be rejected (rejected=' + rejected + ')')
  console.log('   save fuzz: accepted=' + accepted + ' rejected=' + rejected)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log('test seam keys: ' + Object.keys(api).length)
console.log('passed: ' + passed + ', failed: ' + failed)
if (failed > 0) process.exit(1)
