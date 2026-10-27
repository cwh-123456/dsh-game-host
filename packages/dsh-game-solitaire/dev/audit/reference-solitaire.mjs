/**
 * reference-solitaire.mjs — independent Klondike (solitaire) reference model.
 *
 * Purpose: an audit oracle written ONLY from the task specification
 * (handoff/to-sub/009-add-solitaire.md) and the classic Klondike rules.
 * It deliberately does NOT import, read, or copy packages/dsh-game-solitaire/client.js.
 * It is read-only: this module never touches the filesystem.
 *
 * Rule set implemented (from the task handoff):
 *   - 52 cards, 4 suits (S,H,D,C), ranks A..K (1..13), red = H,D.
 *   - Deal: 7 tableau columns; column i (1-based) receives i cards; only the
 *     last card of each column is face up; the remaining 24 cards form the stock.
 *   - Foundations: one per suit, ascending from A to K.
 *   - Stock/waste: draw ONE card at a time; when the stock is empty, tapping it
 *     recycles the whole waste back into the stock (unlimited times).
 *   - Tableau: descending rank, alternating red/black; whole valid runs may be
 *     moved; an empty column accepts only a King (or a King-headed run).
 *   - Waste top may move to a tableau column or a foundation.
 *   - Moving cards off a tableau column auto-flips the newly exposed top card.
 *   - Double-click / auto-move sends a single top card to its foundation if legal.
 *   - Win: all four foundations hold 13 cards (K on top).
 *
 * Internal representation (chosen by this file, unrelated to client.js):
 *   card   = { r: 1..13, s: 'S'|'H'|'D'|'C', up: boolean }
 *   state  = {
 *     tableau: [ card[] x 7 ],            // last element = top of column
 *     foundations: { S: card[], H, D, C },// ascending, last = top
 *     stock: card[],                      // last element = next card drawn
 *     waste: card[],                      // last element = waste top
 *     moves: number,
 *     won: boolean,
 *   }
 *
 * Canonical export form (used by diff-fuzz to compare against client.js):
 *   { stock: [code...],           // code order = DRAW ORDER (next drawn first)
 *     waste: [code...],           // bottom -> top
 *     tableau: [[{c, up}...]],    // bottom -> top, 7 columns
 *     foundations: { S: [code...] },
 *     moves, won }
 * where code = RANK_LABEL + SUIT, e.g. 'AS', '10H', 'QD'.
 */

export const SUITS = ['S', 'H', 'D', 'C']
export const RANK_LABELS = [null, 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
export const RED_SUITS = new Set(['H', 'D'])
export const KING = 13
export const ACE = 1
export const COLUMNS = 7
export const DECK_SIZE = 52
export const STOCK_AT_DEAL = 24

export function isRed(suit) {
  return RED_SUITS.has(suit)
}

export function cardCode(card) {
  return RANK_LABELS[card.r] + card.s
}

export function parseCardCode(code) {
  const suit = code.slice(-1)
  const label = code.slice(0, -1)
  const r = RANK_LABELS.indexOf(label)
  if (!SUITS.includes(suit) || r < 1) throw new Error('bad card code: ' + code)
  return { r, s: suit }
}

/* ------------------------------------------------------------------------- *
 * Deterministic RNG + deal (own implementation; mulberry32 is public domain)
 * ---------------------------------------------------------------------- */

export function makeRng(seed) {
  // Standard mulberry32; seed 0 is a valid state (do NOT substitute a constant,
  // otherwise seed 0 would deal a different deck). 32-bit wrap-around only.
  let a = Number(seed) >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function freshDeck() {
  const deck = []
  for (const s of SUITS) {
    for (let r = ACE; r <= KING; r += 1) deck.push({ r, s, up: false })
  }
  return deck
}

export function shuffledDeck(seed) {
  const deck = freshDeck()
  const rng = makeRng(seed)
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = deck[i]
    deck[i] = deck[j]
    deck[j] = tmp
  }
  return deck
}

/**
 * Deal a new Klondike game from a numeric seed with the classic physical
 * dealing order: row by row, so row r (0..6) deals one card to every column
 * from r to 6; column c therefore receives c+1 cards and its last card is face
 * up. The last 24 shuffled cards go to the stock.
 *
 * Note: the shuffle here is the auditor's own deterministic PRNG + Fisher-Yates;
 * whether it matches the client's RNG is a separate, honest question, so the
 * differential fuzzer also imports the client's dealt state directly and
 * compares deal equality explicitly.
 */
export function dealFromSeed(seed) {
  const deck = shuffledDeck(seed)
  const tableau = Array.from({ length: COLUMNS }, () => [])
  let cursor = 0
  for (let row = 0; row < COLUMNS; row += 1) {
    for (let col = row; col < COLUMNS; col += 1) {
      const card = deck[cursor]
      cursor += 1
      tableau[col].push({ r: card.r, s: card.s, up: row === col })
    }
  }
  const stock = deck.slice(cursor).map((c) => ({ r: c.r, s: c.s, up: false }))
  const foundations = { S: [], H: [], D: [], C: [] }
  return { tableau, foundations, stock, waste: [], moves: 0, won: false }
}

/* ------------------------------------------------------------------------- *
 * State helpers
 * ---------------------------------------------------------------------- */

export function cloneState(state) {
  return {
    tableau: state.tableau.map((pile) => pile.map((c) => ({ r: c.r, s: c.s, up: !!c.up }))),
    foundations: {
      S: state.foundations.S.map((c) => ({ r: c.r, s: c.s, up: true })),
      H: state.foundations.H.map((c) => ({ r: c.r, s: c.s, up: true })),
      D: state.foundations.D.map((c) => ({ r: c.r, s: c.s, up: true })),
      C: state.foundations.C.map((c) => ({ r: c.r, s: c.s, up: true })),
    },
    stock: state.stock.map((c) => ({ r: c.r, s: c.s, up: false })),
    waste: state.waste.map((c) => ({ r: c.r, s: c.s, up: true })),
    moves: state.moves,
    won: !!state.won,
  }
}

export function isWon(state) {
  return SUITS.every((s) => state.foundations[s].length === KING)
}

export function foundationTop(state, suit) {
  const pile = state.foundations[suit]
  return pile.length ? pile[pile.length - 1] : null
}

/* ------------------------------------------------------------------------- *
 * Rule engine — sources and destinations are plain descriptors:
 *   src: { zone: 'waste' }
 *        { zone: 'tableau', col: 0..6, index: 0..len-1 }
 *        { zone: 'foundation', suit: 'S'|'H'|'D'|'C' }   (optional, off by default)
 *   dst: { zone: 'tableau', col: 0..6 }
 *        { zone: 'foundation', suit: 'S'|'H'|'D'|'C' }
 * ---------------------------------------------------------------------- */

export function isValidRun(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return false
  for (let i = 1; i < cards.length; i += 1) {
    const lower = cards[i - 1]
    const upper = cards[i]
    if (upper.r !== lower.r - 1) return false
    if (isRed(upper.s) === isRed(lower.s)) return false
  }
  return true
}

function columnOf(state, col) {
  if (!Number.isInteger(col) || col < 0 || col >= COLUMNS) return null
  return state.tableau[col]
}

/** Cards that a drag starting at `src` would carry, or null when not grabbable. */
export function getRun(state, src, options = {}) {
  if (!src || typeof src !== 'object') return null
  if (src.zone === 'waste') {
    return state.waste.length ? [state.waste[state.waste.length - 1]] : null
  }
  if (src.zone === 'tableau') {
    const pile = columnOf(state, src.col)
    if (!pile) return null
    if (!Number.isInteger(src.index) || src.index < 0 || src.index >= pile.length) return null
    for (let i = src.index; i < pile.length; i += 1) {
      if (!pile[i].up) return null // face-down cards can never be grabbed
    }
    return pile.slice(src.index).map((c) => ({ r: c.r, s: c.s, up: true }))
  }
  if (src.zone === 'foundation') {
    if (options.allowFromFoundation !== true) return null // not part of the v1 spec
    if (!SUITS.includes(src.suit)) return null
    const top = foundationTop(state, src.suit)
    return top ? [top] : null
  }
  return null
}

/** Can `run` (as grabbed from `src`) be dropped on `dst`? Returns {ok, reason}. */
export function canDrop(state, src, dst, options = {}) {
  const run = getRun(state, src, options)
  if (!run) return { ok: false, reason: 'source-empty-or-unmovable' }
  if (!isValidRun(run)) return { ok: false, reason: 'run-not-a-valid-sequence' }
  if (!dst || typeof dst !== 'object') return { ok: false, reason: 'bad-destination' }

  if (dst.zone === 'tableau') {
    const pile = columnOf(state, dst.col)
    if (!pile) return { ok: false, reason: 'bad-column' }
    const moving = run[0]
    // Refuse dragging within the same column (would be a no-op / self-overlap).
    if (src.zone === 'tableau' && src.col === dst.col) return { ok: false, reason: 'same-column' }
    if (pile.length === 0) {
      if (moving.r !== KING) return { ok: false, reason: 'empty-column-needs-king' }
      return { ok: true, run }
    }
    const top = pile[pile.length - 1]
    if (!top.up) return { ok: false, reason: 'target-face-down' }
    if (top.r !== moving.r + 1) return { ok: false, reason: 'not-descending' }
    if (isRed(top.s) === isRed(moving.s)) return { ok: false, reason: 'same-color' }
    return { ok: true, run }
  }

  if (dst.zone === 'foundation') {
    if (!SUITS.includes(dst.suit)) return { ok: false, reason: 'bad-foundation' }
    if (run.length !== 1) return { ok: false, reason: 'foundation-needs-single-card' }
    const moving = run[0]
    if (moving.s !== dst.suit) return { ok: false, reason: 'wrong-suit' }
    const pile = state.foundations[dst.suit]
    if (moving.r !== pile.length + 1) return { ok: false, reason: 'not-next-rank' }
    return { ok: true, run }
  }

  return { ok: false, reason: 'unknown-destination-zone' }
}

function removeRun(state, src, runLength) {
  if (src.zone === 'waste') {
    state.waste.pop()
    return
  }
  if (src.zone === 'tableau') {
    const pile = state.tableau[src.col]
    pile.splice(src.index, runLength)
    if (pile.length && !pile[pile.length - 1].up) pile[pile.length - 1].up = true // auto-flip
    return
  }
  if (src.zone === 'foundation') {
    state.foundations[src.suit].pop()
    return
  }
  throw new Error('removeRun: unknown zone ' + src.zone)
}

/**
 * Apply a move. Pure: never mutates the input state; returns
 * { ok: false, reason } or { ok: true, state, cards }.
 */
export function applyMove(state, src, dst, options = {}) {
  const verdict = canDrop(state, src, dst, options)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  const next = cloneState(state)
  const run = verdict.run.map((c) => ({ r: c.r, s: c.s, up: true }))
  removeRun(next, src, run.length)
  if (dst.zone === 'tableau') {
    for (const card of run) next.tableau[dst.col].push(card)
  } else {
    for (const card of run) next.foundations[dst.suit].push(card)
  }
  next.moves += 1
  next.won = isWon(next)
  return { ok: true, state: next, cards: run }
}

/**
 * Draw one card from the stock into the waste, or recycle the waste back into
 * the stock when the stock is empty. Pure. Returns
 * { ok: false, reason } or { ok: true, state, drawn: card|null, recycled: bool }.
 */
export function drawStock(state) {
  if (state.stock.length === 0 && state.waste.length === 0) {
    return { ok: false, reason: 'stock-and-waste-empty' }
  }
  const next = cloneState(state)
  if (next.stock.length === 0) {
    // Flip the waste packet back over: the card drawn first is drawn first again.
    const recycled = next.waste.slice().reverse()
    for (const card of recycled) card.up = false
    next.stock = recycled
    next.waste = []
    next.moves += 1
    return { ok: true, state: next, drawn: null, recycled: true }
  }
  const card = next.stock.pop()
  card.up = true
  next.waste.push(card)
  next.moves += 1
  return { ok: true, state: next, drawn: card, recycled: false }
}

/** Double-click / auto-move: single top card straight to its foundation if legal. */
export function autoMove(state, src) {
  const run = getRun(state, src)
  if (!run || run.length !== 1) return { ok: false, reason: 'auto-needs-single-card' }
  const isTop = src.zone === 'waste' || (src.zone === 'tableau' && src.index === state.tableau[src.col].length - 1)
  if (!isTop) return { ok: false, reason: 'auto-needs-top-card' }
  const card = run[0]
  const dst = { zone: 'foundation', suit: card.s }
  return applyMove(state, src, dst)
}

/** Auto-flip pass used after manual state injection (imports, fuzz corruption). */
export function normalizeFaceUp(state) {
  for (const pile of state.tableau) {
    if (pile.length && !pile[pile.length - 1].up) pile[pile.length - 1].up = true
  }
  state.won = isWon(state)
  return state
}

/* ------------------------------------------------------------------------- *
 * Canonical export / import (shape documented in the file header)
 * ---------------------------------------------------------------------- */

export function exportPiles(state) {
  return {
    // canonical stock order = draw order (next drawn first)
    stock: state.stock.slice().reverse().map(cardCode),
    waste: state.waste.map(cardCode),
    tableau: state.tableau.map((pile) => pile.map((c) => ({ c: cardCode(c), up: !!c.up }))),
    foundations: {
      S: state.foundations.S.map(cardCode),
      H: state.foundations.H.map(cardCode),
      D: state.foundations.D.map(cardCode),
      C: state.foundations.C.map(cardCode),
    },
    moves: state.moves,
    won: !!state.won,
  }
}

/**
 * Build a model state from a canonical export. Throws on structural problems
 * (used to turn client-provided state into the oracle's representation).
 */
export function importPiles(piles) {
  const make = (code, up) => ({ ...parseCardCode(code), up: !!up })
  if (!piles || !Array.isArray(piles.tableau) || piles.tableau.length !== COLUMNS) {
    throw new Error('importPiles: tableau must have 7 columns')
  }
  const stock = (piles.stock || []).slice().reverse().map((code) => make(code, false))
  const state = {
    tableau: piles.tableau.map((pile) =>
      (pile || []).map((entry) =>
        typeof entry === 'string' ? make(entry, true) : make(entry.c, entry.up),
      ),
    ),
    foundations: {
      S: (piles.foundations.S || []).map((code) => make(code, true)),
      H: (piles.foundations.H || []).map((code) => make(code, true)),
      D: (piles.foundations.D || []).map((code) => make(code, true)),
      C: (piles.foundations.C || []).map((code) => make(code, true)),
    },
    stock,
    waste: (piles.waste || []).map((code) => make(code, true)),
    moves: Number.isInteger(piles.moves) ? piles.moves : 0,
    won: false,
  }
  state.won = isWon(state)
  return state
}

/* ------------------------------------------------------------------------- *
 * Invariants / validation (used by tests and by the fuzzer after every step)
 * ---------------------------------------------------------------------- */

/** Structural + rule invariants. Returns an array of human-readable problems. */
export function validateState(state) {
  const problems = []
  const seen = new Map()
  const count = (card, where) => {
    const code = cardCode(card)
    if (seen.has(code)) problems.push(`duplicate card ${code} (${seen.get(code)} and ${where})`)
    else seen.set(code, where)
  }

  if (!Array.isArray(state.tableau) || state.tableau.length !== COLUMNS) {
    problems.push('tableau must have 7 columns')
    return problems
  }
  state.tableau.forEach((pile, col) => {
    let sawUp = false
    pile.forEach((card, idx) => {
      count(card, `tableau[${col}][${idx}]`)
      if (card.up) sawUp = true
      else if (sawUp) problems.push(`tableau[${col}]: face-down card above a face-up card at index ${idx}`)
    })
    if (pile.length && !pile[pile.length - 1].up) problems.push(`tableau[${col}]: top card is face down (auto-flip missing)`)
    // every exposed face-up segment must be a legal descending alternating run
    const firstUp = pile.findIndex((c) => c.up)
    if (firstUp >= 0 && !isValidRun(pile.slice(firstUp))) {
      problems.push(`tableau[${col}]: face-up run is not descending alternating (${pile.slice(firstUp).map(cardCode).join(',')})`)
    }
  })

  for (const suit of SUITS) {
    const pile = state.foundations[suit]
    if (!Array.isArray(pile)) {
      problems.push(`foundation ${suit} missing`)
      continue
    }
    pile.forEach((card, idx) => {
      count(card, `foundation[${suit}][${idx}]`)
      if (card.s !== suit) problems.push(`foundation ${suit}: holds a ${card.s} card`)
      if (card.r !== idx + 1) problems.push(`foundation ${suit}: rank ${card.r} at index ${idx}, expected ${idx + 1}`)
      if (!card.up) problems.push(`foundation ${suit}: card face down`)
    })
  }

  state.stock.forEach((card, idx) => {
    count(card, `stock[${idx}]`)
    if (card.up) problems.push('stock card face up')
  })
  state.waste.forEach((card, idx) => {
    count(card, `waste[${idx}]`)
    if (!card.up) problems.push('waste card face down')
  })

  if (seen.size !== DECK_SIZE) problems.push(`deck has ${seen.size} distinct cards, expected ${DECK_SIZE}`)
  if (!Number.isInteger(state.moves) || state.moves < 0) problems.push('moves must be a non-negative integer')
  if (!!state.won !== isWon(state)) problems.push(`won flag ${state.won} inconsistent with foundations`)
  return problems
}

/** Deal-specific invariants for a freshly dealt state. */
export function validateDeal(state) {
  const problems = validateState(state)
  state.tableau.forEach((pile, col) => {
    if (pile.length !== col + 1) problems.push(`column ${col} has ${pile.length} cards, expected ${col + 1}`)
    pile.forEach((card, idx) => {
      const expectUp = idx === pile.length - 1
      if (!!card.up !== expectUp) problems.push(`column ${col} card ${idx} up=${card.up}, expected ${expectUp}`)
    })
  })
  if (state.stock.length !== STOCK_AT_DEAL) problems.push(`stock has ${state.stock.length} cards, expected ${STOCK_AT_DEAL}`)
  if (state.waste.length !== 0) problems.push('waste is not empty at deal')
  if (SUITS.some((s) => state.foundations[s].length !== 0)) problems.push('foundations are not empty at deal')
  if (state.moves !== 0) problems.push(`moves is ${state.moves}, expected 0 at deal`)
  return problems
}

/* ------------------------------------------------------------------------- *
 * Snapshot history (same contract the game must honour: >= 20 steps)
 * ---------------------------------------------------------------------- */

export function createHistory(initialState, limit = 50) {
  const stack = [cloneState(initialState)]
  return {
    stack,
    get length() {
      return stack.length
    },
    push(state) {
      stack.push(cloneState(state))
      while (stack.length > limit) stack.shift()
    },
    undo() {
      if (stack.length <= 1) return null
      stack.pop()
      return cloneState(stack[stack.length - 1])
    },
    canUndo() {
      return stack.length > 1
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Deep comparison helper: returns null when equal, otherwise a diff object.
 * ---------------------------------------------------------------------- */

export function diffPiles(expected, actual) {
  const diffs = []
  const cmpList = (label, a, b) => {
    const ja = JSON.stringify(a)
    const jb = JSON.stringify(b)
    if (ja !== jb) diffs.push({ field: label, expected: a, actual: b })
  }
  cmpList('stock', expected.stock, actual.stock)
  cmpList('waste', expected.waste, actual.waste)
  cmpList('tableau', expected.tableau, actual.tableau)
  for (const suit of SUITS) {
    cmpList('foundations.' + suit, expected.foundations[suit], actual.foundations[suit])
  }
  if (expected.won !== actual.won) diffs.push({ field: 'won', expected: expected.won, actual: actual.won })
  return diffs.length ? diffs : null
}
