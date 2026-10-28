/**
 * @local/dsh-game-solitaire — browser half.
 *
 * Registers a Klondike Solitaire game into the host's `game.stage` chain slot
 * (contract v1):
 *   - `select({ gameId })` returns the frozen `MATCHED` object only when the
 *     host selected `solitaire`, otherwise `null`
 *   - the component only relies on the `matched` prop, never on host internals
 *
 * Why everything lives in this one file: `client.js` is the only browser entry
 * the module loader serves. The loader's `require` resolves entries from the
 * module table (react, ...) and cannot load package-relative modules
 * synchronously, so a separate logic file would be unreachable in the browser.
 * Pure logic is therefore defined first and exposed on
 * `window.__DSH_GAME_SOLITAIRE__` only when
 * `window.__DSH_GAME_SOLITAIRE_TEST__ === true`, which lets `dev/` node tests
 * exercise it without a host (and an independent verifier diff-test it).
 *
 * v1 interaction is deliberately click-only:
 *   - click stock: draw 1 / recycle waste
 *   - click a face-up card: select it (whole legal run for tableau)
 *   - click a target column / foundation: place the selection
 *   - double-click a top card: auto-send to a foundation
 *   - undo snapshots, restart same deal, new game
 *
 * Save key: localStorage['dsh.game.solitaire.v1'] (schemaVersion: 1).
 * Other games' keys are never read or written here.
 */
;(function () {
  'use strict'

  const GAME_ID = 'solitaire'
  const STORE_KEY = 'dsh.game.' + GAME_ID + '.v1'
  const SCHEMA_VERSION = 1
  const MIN_WIDTH = 320
  const MIN_HEIGHT = 240
  const MAX_ELAPSED_MS = 7 * 24 * 60 * 60 * 1000
  const MAX_MOVES = 10000000
  const MAX_UNDO_KEEP = 200
  const SAVE_UNDO = 40
  const MESSAGE_MS = 2600
  const DRAG_THRESHOLD = 6

  const SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'] // spade heart diamond club
  const SUIT_NAMES = ['黑桃', '红桃', '方块', '梅花']
  const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
  const RED_SUIT = [false, true, true, false]

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function clamp(value, low, high) {
    if (!Number.isFinite(value)) return low
    if (value < low) return low
    if (value > high) return high
    return value
  }

  function cardSuit(id) {
    return Math.floor(id / 13)
  }

  function cardRank(id) {
    return (id % 13) + 1
  }

  function cardIsRed(id) {
    return RED_SUIT[cardSuit(id)] === true
  }

  function cardLabel(id) {
    return SUITS[cardSuit(id)] + RANKS[cardRank(id)]
  }

  function cardLabelLong(id) {
    return SUIT_NAMES[cardSuit(id)] + RANKS[cardRank(id)]
  }

  function formatDuration(totalSeconds) {
    let seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0))
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const rest = seconds % 60
    function pad(value) {
      return value < 10 ? '0' + value : String(value)
    }
    if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(rest)
    return pad(minutes) + ':' + pad(rest)
  }

  // ---------------------------------------------------------------------------
  // Seeded shuffle + deal
  //
  // A game is fully described by its 32-bit seed, so "重开" can replay the very
  // same deal while "新游戏" picks a fresh seed.
  // ---------------------------------------------------------------------------

  function mulberry32(seed) {
    let state = seed >>> 0
    return function next() {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function randomSeed() {
    let value = 0
    try {
      const cryptoObj = typeof crypto !== 'undefined' ? crypto : null
      if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        const bucket = new Uint32Array(1)
        cryptoObj.getRandomValues(bucket)
        value = bucket[0] >>> 0
      }
    } catch (error) {
      value = 0
    }
    if (!value) {
      value = ((Math.floor(Math.random() * 0xffffffff) >>> 0) ^ (Date.now() >>> 0)) >>> 0
    }
    return value >>> 0
  }

  function shuffledDeck(seed) {
    const deck = new Array(52)
    for (let i = 0; i < 52; i += 1) deck[i] = i
    const rnd = mulberry32(seed)
    for (let i = deck.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1))
      const tmp = deck[i]
      deck[i] = deck[j]
      deck[j] = tmp
    }
    return deck
  }

  /**
   * Classic row-major deal: row r (0..6) deals one card to every column from r
   * to 6; column c therefore gets c + 1 cards and its last card is face up.
   * The 24 undealt cards become the stock (top of stock = last element).
   */
  function dealFromSeed(seed) {
    const deck = shuffledDeck(seed >>> 0)
    const tableau = [[], [], [], [], [], [], []]
    let index = 0
    for (let row = 0; row < 7; row += 1) {
      for (let col = row; col < 7; col += 1) {
        const id = deck[index]
        index += 1
        tableau[col].push({ id: id, up: row === col })
      }
    }
    return {
      stock: deck.slice(index),
      waste: [],
      foundations: [[], [], [], []],
      tableau: tableau,
    }
  }

  function emptyState(seed) {
    const deal = dealFromSeed(seed >>> 0)
    return {
      seed: seed >>> 0,
      started: false,
      won: false,
      moves: 0,
      elapsedMs: 0,
      undo: [],
      stock: deal.stock,
      waste: deal.waste,
      foundations: deal.foundations,
      tableau: deal.tableau,
    }
  }

  // ---------------------------------------------------------------------------
  // Undo snapshots (compact, JSON friendly) + persistence
  // ---------------------------------------------------------------------------

  function encodeTableau(tableau) {
    return tableau.map(function (column) {
      return column.map(function (card) {
        return card.up ? card.id : card.id + 52
      })
    })
  }

  function decodeTableau(encoded) {
    return encoded.map(function (column) {
      return column.map(function (value) {
        const number = Number(value)
        return { id: number % 52, up: number < 52 }
      })
    })
  }

  function makeSnapshot(state) {
    return {
      stock: state.stock.slice(),
      waste: state.waste.slice(),
      foundations: state.foundations.map(function (pile) {
        return pile.slice()
      }),
      tableau: encodeTableau(state.tableau),
      moves: state.moves,
      started: state.started === true,
      won: state.won === true,
    }
  }

  function restoreSnapshot(state, snapshot) {
    state.stock = snapshot.stock.slice()
    state.waste = snapshot.waste.slice()
    state.foundations = snapshot.foundations.map(function (pile) {
      return pile.slice()
    })
    state.tableau = decodeTableau(snapshot.tableau)
    state.moves = snapshot.moves
    state.started = snapshot.started === true
    state.won = snapshot.won === true
  }

  function pushUndo(state) {
    state.undo.push(makeSnapshot(state))
    if (state.undo.length > MAX_UNDO_KEEP) {
      state.undo.splice(0, state.undo.length - MAX_UNDO_KEEP)
    }
  }

  function undoMove(state) {
    if (!state.undo.length) return { ok: false, reason: '没有可撤销的步骤' }
    const snapshot = state.undo.pop()
    restoreSnapshot(state, snapshot)
    return { ok: true }
  }

  function restartState(state) {
    const deal = dealFromSeed(state.seed >>> 0)
    state.stock = deal.stock
    state.waste = deal.waste
    state.foundations = deal.foundations
    state.tableau = deal.tableau
    state.moves = 0
    state.elapsedMs = 0
    state.started = false
    state.won = false
    state.undo = []
    return state
  }

  // ---------------------------------------------------------------------------
  // Save state validation
  // ---------------------------------------------------------------------------

  function normalizeCardList(raw) {
    if (!Array.isArray(raw)) return null
    const list = []
    for (let i = 0; i < raw.length; i += 1) {
      const id = raw[i]
      if (!Number.isInteger(id) || id < 0 || id > 51) return null
      list.push(id)
    }
    return list
  }

  function isAlternatingRun(ids) {
    if (!Array.isArray(ids) || ids.length < 2) return true
    for (let i = 0; i < ids.length - 1; i += 1) {
      const upper = ids[i]
      const lower = ids[i + 1]
      if (!Number.isInteger(upper) || !Number.isInteger(lower)) return false
      if (cardRank(upper) !== cardRank(lower) + 1) return false
      if (cardIsRed(upper) === cardIsRed(lower)) return false
    }
    return true
  }

  function validatePiles(stockRaw, wasteRaw, foundationsRaw, tableauRaw) {
    const stock = normalizeCardList(stockRaw)
    if (!stock) return null
    const waste = normalizeCardList(wasteRaw)
    if (!waste) return null
    if (!Array.isArray(foundationsRaw) || foundationsRaw.length !== 4) return null
    const foundations = []
    for (let pile = 0; pile < 4; pile += 1) {
      const list = normalizeCardList(foundationsRaw[pile])
      if (!list) return null
      for (let k = 0; k < list.length; k += 1) {
        if (cardSuit(list[k]) !== pile) return null
        if (cardRank(list[k]) !== k + 1) return null
      }
      foundations.push(list)
    }
    if (!Array.isArray(tableauRaw) || tableauRaw.length !== 7) return null
    const tableau = []
    for (let col = 0; col < 7; col += 1) {
      const encoded = tableauRaw[col]
      if (!Array.isArray(encoded)) return null
      const column = []
      let sawFaceUp = false
      for (let i = 0; i < encoded.length; i += 1) {
        const value = encoded[i]
        if (!Number.isInteger(value) || value < 0 || value > 103) return null
        const up = value < 52
        if (up) sawFaceUp = true
        else if (sawFaceUp) return null // no face-down card underneath a face-up run
        column.push({ id: value % 52, up: up })
      }
      if (column.length && !column[column.length - 1].up) return null
      let firstUp = -1
      for (let i = 0; i < column.length; i += 1) {
        if (column[i].up) {
          firstUp = i
          break
        }
      }
      if (firstUp >= 0) {
        const run = []
        for (let i = firstUp; i < column.length; i += 1) run.push(column[i].id)
        if (!isAlternatingRun(run)) return null
      }
      tableau.push(column)
    }

    // Every one of the 52 cards must appear exactly once across all piles.
    const seen = new Uint8Array(52)
    let total = 0
    function consume(list) {
      for (let i = 0; i < list.length; i += 1) {
        const id = list[i]
        if (seen[id]) return false
        seen[id] = 1
        total += 1
      }
      return true
    }
    if (!consume(stock)) return null
    if (!consume(waste)) return null
    for (let pile = 0; pile < 4; pile += 1) {
      if (!consume(foundations[pile])) return null
    }
    for (let col = 0; col < 7; col += 1) {
      const ids = tableau[col].map(function (card) {
        return card.id
      })
      if (!consume(ids)) return null
    }
    if (total !== 52) return null
    return { stock: stock, waste: waste, foundations: foundations, tableau: tableau }
  }

  function sanitizeSnapshot(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const piles = validatePiles(raw.stock, raw.waste, raw.foundations, raw.tableau)
    if (!piles) return null
    const moves = raw.moves
    if (!Number.isInteger(moves) || moves < 0 || moves > MAX_MOVES) return null
    const started = raw.started === true
    const won = raw.won === true
    const allWon = piles.foundations.every(function (pile) {
      return pile.length === 13
    })
    if (won !== allWon) return null
    return {
      stock: piles.stock,
      waste: piles.waste,
      foundations: piles.foundations,
      tableau: encodeTableau(piles.tableau),
      moves: moves,
      started: started,
      won: won,
    }
  }

  function sanitizeState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (raw.schemaVersion !== SCHEMA_VERSION) return null
    const seed = raw.seed
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return null
    const piles = validatePiles(raw.stock, raw.waste, raw.foundations, raw.tableau)
    if (!piles) return null
    const moves = raw.moves
    if (!Number.isInteger(moves) || moves < 0 || moves > MAX_MOVES) return null
    let elapsedMs = raw.elapsedMs
    if (!Number.isInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > MAX_ELAPSED_MS) return null
    let started = raw.started === true
    let won = raw.won === true
    const allWon = piles.foundations.every(function (pile) {
      return pile.length === 13
    })
    if (won && !allWon) return null
    if (!won && allWon) won = true
    if (moves > 0 || won) started = true

    let undo = []
    if (Array.isArray(raw.undo)) {
      for (let i = 0; i < raw.undo.length; i += 1) {
        const snapshot = sanitizeSnapshot(raw.undo[i])
        if (snapshot) undo.push(snapshot)
      }
      if (undo.length > SAVE_UNDO) undo = undo.slice(undo.length - SAVE_UNDO)
    }

    return {
      seed: seed >>> 0,
      started: started,
      won: won,
      moves: moves,
      elapsedMs: elapsedMs,
      undo: undo,
      stock: piles.stock,
      waste: piles.waste,
      foundations: piles.foundations,
      tableau: piles.tableau,
    }
  }

  function serializeState(state) {
    return {
      schemaVersion: SCHEMA_VERSION,
      seed: state.seed >>> 0,
      started: state.started === true,
      won: state.won === true,
      moves: state.moves,
      elapsedMs: Math.max(0, Math.min(MAX_ELAPSED_MS, Math.round(state.elapsedMs))),
      stock: state.stock.slice(),
      waste: state.waste.slice(),
      foundations: state.foundations.map(function (pile) {
        return pile.slice()
      }),
      tableau: encodeTableau(state.tableau),
      undo: state.undo.slice(state.undo.length > SAVE_UNDO ? state.undo.length - SAVE_UNDO : 0),
    }
  }

  function loadSavedState() {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null
      const raw = window.localStorage.getItem(STORE_KEY)
      if (!raw) return null
      return sanitizeState(JSON.parse(raw))
    } catch (error) {
      return null
    }
  }

  function saveStateToStorage(state) {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return
      window.localStorage.setItem(STORE_KEY, JSON.stringify(serializeState(state)))
    } catch (error) {
      // Storage can be unavailable/full; gameplay keeps working in memory.
    }
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  function selectionCards(state, selection) {
    if (!selection || typeof selection !== 'object') return null
    if (selection.kind === 'waste') {
      if (!state.waste.length) return null
      return [state.waste[state.waste.length - 1]]
    }
    if (selection.kind === 'foundation') {
      const pile = state.foundations[selection.pile]
      if (!pile || !pile.length) return null
      return [pile[pile.length - 1]]
    }
    if (selection.kind === 'tableau') {
      const column = state.tableau[selection.col]
      if (!column) return null
      const index = selection.index
      if (!Number.isInteger(index) || index < 0 || index >= column.length) return null
      const cards = []
      for (let i = index; i < column.length; i += 1) {
        if (!column[i].up) return null
        cards.push(column[i].id)
      }
      return cards
    }
    return null
  }

  function hasWon(state) {
    for (let pile = 0; pile < 4; pile += 1) {
      if (state.foundations[pile].length !== 13) return false
    }
    return true
  }

  /**
   * Pure validation of a potential placement: no mutation, returns a readable
   * reason on failure so the UI can tell the user what rule blocked it.
   */
  function canDrop(state, selection, target) {
    const cards = selectionCards(state, selection)
    if (!cards || !cards.length) return { ok: false, reason: '没有选中的牌' }
    if (!isAlternatingRun(cards)) return { ok: false, reason: '这组牌不是合法序列' }
    if (!target || typeof target !== 'object') return { ok: false, reason: '不能放在这里' }

    if (target.kind === 'tableau') {
      const col = target.col
      if (!Number.isInteger(col) || col < 0 || col > 6) return { ok: false, reason: '目标列不存在' }
      if (selection.kind === 'tableau' && selection.col === col) {
        return { ok: false, reason: '已经在这一列了' }
      }
      const pile = state.tableau[col]
      const moving = cards[0]
      if (!pile.length) {
        if (cardRank(moving) !== 13) return { ok: false, reason: '空列只能放 K' }
        return { ok: true, cards: cards, target: target }
      }
      const top = pile[pile.length - 1]
      if (!top.up) return { ok: false, reason: '目标列顶上是扣着的牌' }
      if (cardRank(moving) !== cardRank(top.id) - 1) {
        return { ok: false, reason: '必须比 ' + cardLabel(top.id) + ' 小 1' }
      }
      if (cardIsRed(moving) === cardIsRed(top.id)) {
        return { ok: false, reason: '必须红黑交替' }
      }
      return { ok: true, cards: cards, target: target }
    }

    if (target.kind === 'foundation') {
      const pile = target.pile
      if (!Number.isInteger(pile) || pile < 0 || pile > 3) return { ok: false, reason: '基座不存在' }
      if (cards.length !== 1) return { ok: false, reason: '基座一次只能放一张牌' }
      if (selection.kind === 'foundation' && selection.pile === pile) {
        return { ok: false, reason: '已经在这个基座了' }
      }
      const card = cards[0]
      if (cardSuit(card) !== pile) return { ok: false, reason: '基座只能放同花色的牌' }
      const need = state.foundations[pile].length + 1
      if (cardRank(card) !== need) {
        return { ok: false, reason: '需要先放 ' + SUITS[pile] + RANKS[need] }
      }
      return { ok: true, cards: cards, target: target }
    }

    return { ok: false, reason: '不能放在这里' }
  }

  function removeSelection(state, selection, count) {
    if (selection.kind === 'waste') {
      state.waste.pop()
      return
    }
    if (selection.kind === 'foundation') {
      state.foundations[selection.pile].pop()
      return
    }
    const column = state.tableau[selection.col]
    column.splice(selection.index, count)
    const last = column[column.length - 1]
    if (last && !last.up) last.up = true
  }

  function applyMove(state, selection, target) {
    const check = canDrop(state, selection, target)
    if (!check.ok) return check
    const cards = check.cards
    removeSelection(state, selection, cards.length)
    if (target.kind === 'tableau') {
      const pile = state.tableau[target.col]
      for (let i = 0; i < cards.length; i += 1) {
        pile.push({ id: cards[i], up: true })
      }
    } else {
      state.foundations[target.pile].push(cards[0])
    }
    state.moves += 1
    state.started = true
    state.won = hasWon(state)
    return { ok: true, moved: cards.length, won: state.won }
  }

  function drawStock(state) {
    if (state.stock.length) {
      const card = state.stock.pop()
      state.waste.push(card)
      state.moves += 1
      state.started = true
      return { ok: true, kind: 'draw' }
    }
    if (state.waste.length) {
      // Flip the whole waste pile back over: the first card drawn becomes the
      // new top of the stock, exactly like turning the pile in real life.
      state.stock = state.waste.slice().reverse()
      state.waste = []
      state.moves += 1
      state.started = true
      return { ok: true, kind: 'recycle' }
    }
    return { ok: false, reason: '牌堆和弃牌堆都空了' }
  }

  function findFoundationFor(state, cardId) {
    const suit = cardSuit(cardId)
    const need = state.foundations[suit].length + 1
    return cardRank(cardId) === need ? suit : -1
  }

  function autoMoveToFoundation(state, source) {
    let selection = null
    let card = -1
    if (source && source.kind === 'waste') {
      if (!state.waste.length) return { ok: false, reason: '弃牌堆没有牌' }
      selection = { kind: 'waste' }
      card = state.waste[state.waste.length - 1]
    } else if (source && source.kind === 'tableau') {
      const column = state.tableau[source.col]
      if (!column) return { ok: false, reason: '牌列不存在' }
      const index = source.index
      if (!Number.isInteger(index) || index < 0 || index >= column.length) {
        return { ok: false, reason: '牌不存在' }
      }
      if (index !== column.length - 1) return { ok: false, reason: '这张牌上还压着别的牌' }
      if (!column[index].up) return { ok: false, reason: '扣着的牌不能移动' }
      selection = { kind: 'tableau', col: source.col, index: index }
      card = column[index].id
    } else {
      return { ok: false, reason: '这张牌不能自动移动' }
    }
    const pile = findFoundationFor(state, card)
    if (pile < 0) return { ok: false, reason: '这张牌暂时放不进基座' }
    const check = canDrop(state, selection, { kind: 'foundation', pile: pile })
    if (!check.ok) return check
    return { ok: true, selection: selection, target: { kind: 'foundation', pile: pile }, pile: pile }
  }

  // ---------------------------------------------------------------------------
  // Responsive layout (pure, testable; DOM rendering is DPR independent but we
  // still track devicePixelRatio so zoom changes trigger a relayout)
  // ---------------------------------------------------------------------------

  function computeLayout(width, height, tableau) {
    const W = Math.max(0, Number(width) || 0)
    const H = Math.max(0, Number(height) || 0)
    if (W < MIN_WIDTH || H < MIN_HEIGHT) return null

    const compact = Math.min(W, H)
    const margin = clamp(compact * 0.022, 6, 20)
    const colGap = clamp(W * 0.012, 4, 14)
    const widthBased = (W - margin * 2 - colGap * 6) / 7
    const heightBased = (H - margin * 2) / (1.4 * 2.17)
    let cardW = Math.max(1, Math.min(widthBased, heightBased))
    let cardH = cardW * 1.4
    let topGap = Math.max(8, cardH * 0.12)
    let tableauTop = margin + cardH + topGap
    let tableauH = H - tableauTop - margin
    const usedW = cardW * 7 + colGap * 6
    const offsetX = Math.max(margin, (W - usedW) / 2)

    const stockX = offsetX
    const wasteX = offsetX + cardW + colGap
    const fanGap = colGap * 0.8
    const foundationWidth = cardW * 4 + fanGap * 3
    const foundationBase = offsetX + usedW - foundationWidth
    const foundationX = []
    for (let pile = 0; pile < 4; pile += 1) {
      foundationX.push(foundationBase + pile * (cardW + fanGap))
    }
    const colX = []
    for (let col = 0; col < 7; col += 1) {
      colX.push(offsetX + col * (cardW + colGap))
    }

    const faceDownBase = Math.max(3, cardH * 0.1)
    const faceUpBase = Math.max(6, cardH * 0.225)
    const columns = Array.isArray(tableau) ? tableau : []
    const colOffsets = []
    for (let col = 0; col < 7; col += 1) {
      const cards = columns[col] || []
      const offsets = []
      if (cards.length) offsets.push(0)
      let required = cardH
      for (let i = 0; i < cards.length - 1; i += 1) {
        required += cards[i].up ? faceUpBase : faceDownBase
      }
      let scale = 1
      if (cards.length > 1 && required > tableauH) {
        scale = Math.max(0, (tableauH - cardH) / Math.max(1e-6, required - cardH))
      }
      let y = 0
      for (let i = 1; i < cards.length; i += 1) {
        y += (cards[i - 1].up ? faceUpBase : faceDownBase) * scale
        offsets.push(y)
      }
      colOffsets.push(offsets)
    }

    return {
      width: W,
      height: H,
      margin: margin,
      colGap: colGap,
      cardW: cardW,
      cardH: cardH,
      cardRadius: Math.max(3, cardH * 0.055),
      offsetX: offsetX,
      topY: margin,
      tableauTop: tableauTop,
      tableauH: Math.max(cardH, tableauH),
      stockX: stockX,
      wasteX: wasteX,
      wasteFanStep: cardW * 0.1,
      foundationX: foundationX,
      foundationGap: fanGap,
      colX: colX,
      colOffsets: colOffsets,
      faceDownBase: faceDownBase,
      faceUpBase: faceUpBase,
    }
  }

  // ---------------------------------------------------------------------------
  // Controller: state, timer, undo, persistence, DOM measurement
  // ---------------------------------------------------------------------------

  function createGame(host, options) {
    const opts = options || {}
    const view = typeof window !== 'undefined' ? window : null
    const doc = typeof document !== 'undefined' ? document : null
    const onState = typeof opts.onState === 'function' ? opts.onState : null
    const onError = typeof opts.onError === 'function' ? opts.onError : null
    const clock = typeof opts.clock === 'function' ? opts.clock : defaultClock
    const setTimeoutFn = typeof setTimeout === 'function' ? setTimeout : null
    const clearTimeoutFn = typeof clearTimeout === 'function' ? clearTimeout : null
    const rafCtor = view && typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame.bind(view) : null
    const cafCtor = view && typeof view.cancelAnimationFrame === 'function' ? view.cancelAnimationFrame.bind(view) : null

    let state = loadSavedState()
    if (!state) state = emptyState(randomSeed())

    let alive = true
    let destroyed = false
    let failure = null
    let selection = null
    let message = ''
    let messageTimer = null
    let drag = null
    let suppressClick = false
    let rafId = 0
    let timerKind = null
    let lastShownSecond = -1
    let runStart = null
    let observer = null
    let size = { width: 0, height: 0, dpr: 1 }

    function defaultClock() {
      try {
        if (view && view.performance && typeof view.performance.now === 'function') {
          return view.performance.now()
        }
        if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
          return performance.now()
        }
      } catch (error) {
        // fall through
      }
      return Date.now()
    }
    function now() {
      try {
        const value = clock()
        return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
      } catch (error) {
        return Date.now()
      }
    }

    function elapsedNow(at) {
      const moment = typeof at === 'number' ? at : now()
      if (runStart === null) return state.elapsedMs
      return Math.min(MAX_ELAPSED_MS, state.elapsedMs + Math.max(0, moment - runStart))
    }

    function settleElapsed(at) {
      if (runStart === null) return
      const moment = typeof at === 'number' ? at : now()
      state.elapsedMs = Math.min(MAX_ELAPSED_MS, state.elapsedMs + Math.max(0, moment - runStart))
      runStart = moment
    }

    function stopTimer() {
      if (runStart === null) return
      settleElapsed(now())
      runStart = null
    }

    function isHidden() {
      try {
        return !!(doc && doc.hidden === true)
      } catch (error) {
        return false
      }
    }

    function isSmall() {
      return size.width < MIN_WIDTH || size.height < MIN_HEIGHT
    }

    function buildLayout() {
      return isSmall() ? null : computeLayout(size.width, size.height, state.tableau)
    }

    function buildView() {
      const moment = now()
      const elapsedSeconds = Math.floor(elapsedNow(moment) / 1000)
      const layout = buildLayout()
      if (selection && !selectionCards(state, selection)) selection = null
      const valid = {
        tableau: [false, false, false, false, false, false, false],
        foundation: [false, false, false, false],
      }
      if (selection) {
        for (let col = 0; col < 7; col += 1) {
          valid.tableau[col] = canDrop(state, selection, { kind: 'tableau', col: col }).ok
        }
        for (let pile = 0; pile < 4; pile += 1) {
          valid.foundation[pile] = canDrop(state, selection, { kind: 'foundation', pile: pile }).ok
        }
      }
      const tableauView = state.tableau.map(function (column, col) {
        return column.map(function (card, index) {
          return {
            id: card.id,
            up: card.up,
            y: layout && layout.colOffsets[col] ? layout.colOffsets[col][index] || 0 : 0,
          }
        })
      })
      let dragView = null
      if (drag && drag.active && layout) {
        const target = drag.target
        dragView = {
          cards: drag.cards.slice(),
          source: {
            kind: drag.source.kind,
            col: drag.source.col,
            index: drag.source.index,
            pile: drag.source.pile,
          },
          x: drag.currentX,
          y: drag.currentY,
          offsetX: drag.offsetX,
          offsetY: drag.offsetY,
          step: Math.max(6, layout.faceUpBase),
          target: target
            ? (target.kind === 'foundation'
                ? { kind: 'foundation', pile: target.pile }
                : { kind: 'tableau', col: target.col })
            : null,
        }
      }
      return {
        width: size.width,
        height: size.height,
        dpr: size.dpr,
        tooSmall: isSmall(),
        layout: layout,
        stock: state.stock.slice(),
        waste: state.waste.slice(),
        foundations: state.foundations.map(function (pile) {
          return pile.slice()
        }),
        tableau: tableauView,
        selection: selection ? { kind: selection.kind, col: selection.col, index: selection.index, pile: selection.pile } : null,
        selectedCards: selection ? selectionCards(state, selection) || [] : [],
        valid: valid,
        drag: dragView,
        moves: state.moves,
        elapsedSeconds: elapsedSeconds,
        elapsedText: formatDuration(elapsedSeconds),
        undoCount: state.undo.length,
        started: state.started === true,
        won: state.won === true,
        message: message,
        seed: state.seed,
      }
    }

    function emit() {
      if (!onState || !alive) return
      try {
        onState(buildView())
      } catch (error) {
        try {
          console.error('[dsh-game-solitaire] state listener failed', error)
        } catch (logError) {
          // ignore
        }
      }
    }

    function setMessage(text) {
      message = typeof text === 'string' ? text : ''
      if (messageTimer) {
        try {
          if (clearTimeoutFn) clearTimeoutFn(messageTimer)
        } catch (error) {
          // ignore
        }
        messageTimer = null
      }
      if (message && setTimeoutFn) {
        messageTimer = setTimeoutFn(function () {
          messageTimer = null
          message = ''
          emit()
        }, MESSAGE_MS)
      }
    }

    function persist() {
      if (!alive) return
      try {
        settleElapsed(now())
        saveStateToStorage(state)
      } catch (error) {
        // never let persistence break the game
      }
    }

    function scheduleFrame() {
      if (!alive || failure || rafId) return
      if (isHidden() || !state.started || state.won) return
      try {
        if (rafCtor) {
          timerKind = 'raf'
          rafId = rafCtor(tick)
        } else if (setTimeoutFn) {
          timerKind = 'timeout'
          rafId = setTimeoutFn(tick, 500)
        }
      } catch (error) {
        fail(error)
      }
    }

    function cancelFrame() {
      if (!rafId) return
      try {
        if (timerKind === 'raf' && cafCtor) cafCtor(rafId)
        else if (timerKind === 'timeout' && clearTimeoutFn) clearTimeoutFn(rafId)
      } catch (error) {
        // ignore
      }
      rafId = 0
      timerKind = null
    }

    function tick() {
      rafId = 0
      timerKind = null
      if (!alive || failure) return
      try {
        if (isHidden() || !state.started || state.won) return
        const second = Math.floor(elapsedNow(now()) / 1000)
        if (second !== lastShownSecond) {
          lastShownSecond = second
          emit()
        }
        scheduleFrame()
      } catch (error) {
        fail(error)
      }
    }

    function ensureTimer() {
      if (!state.started || state.won || isHidden()) return
      if (runStart === null) runStart = now()
      scheduleFrame()
    }

    function measure() {
      try {
        let rect = null
        if (host && typeof host.getBoundingClientRect === 'function') {
          rect = host.getBoundingClientRect()
        }
        let width = rect && typeof rect.width === 'number' ? rect.width : host ? host.clientWidth : 0
        let height = rect && typeof rect.height === 'number' ? rect.height : host ? host.clientHeight : 0
        width = Math.max(0, Math.round(Number(width) || 0))
        height = Math.max(0, Math.round(Number(height) || 0))
        const dpr = clamp(view && typeof view.devicePixelRatio === 'number' && view.devicePixelRatio > 0 ? view.devicePixelRatio : 1, 1, 8)
        if (width !== size.width || height !== size.height || dpr !== size.dpr) {
          size = { width: width, height: height, dpr: dpr }
          return true
        }
      } catch (error) {
        // measured with fallback values
      }
      return false
    }

    function handleResize() {
      if (!alive) return
      try {
        if (measure()) emit()
      } catch (error) {
        fail(error)
      }
    }

    let resizeScheduled = false

    // ResizeObserver / window resize callbacks must not synchronously rewrite
    // the DOM layout they observe (Chromium reports "ResizeObserver loop
    // completed with undelivered notifications" otherwise). Defer one frame.
    function scheduleRelayout() {
      if (!alive || resizeScheduled) return
      resizeScheduled = true
      const run = function () {
        resizeScheduled = false
        if (!alive) return
        handleResize()
      }
      try {
        if (rafCtor) rafCtor(run)
        else if (setTimeoutFn) setTimeoutFn(run, 0)
        else run()
      } catch (error) {
        resizeScheduled = false
        run()
      }
    }

    function fail(error) {
      if (!alive) return
      failure = '游戏遇到问题，点「重试」重新开始。'
      cancelFrame()
      try {
        stopTimer()
        saveStateToStorage(state)
      } catch (persistError) {
        // ignore
      }
      try {
        console.error('[dsh-game-solitaire] runtime error', error)
      } catch (logError) {
        // ignore
      }
      if (onError) {
        try {
          onError(failure)
        } catch (listenerError) {
          try {
            console.error('[dsh-game-solitaire] error listener failed', listenerError)
          } catch (logError) {
            // ignore
          }
        }
      }
    }

    function commitAction(mutator) {
      if (!alive || failure) return null
      try {
        pushUndo(state)
        const result = mutator()
        if (!result || result.ok !== true) {
          state.undo.pop()
          return result
        }
        setMessage(result.message || '')
        if (!state.won) {
          if (runStart === null && !isHidden()) runStart = now()
        } else {
          stopTimer()
        }
        selection = null
        persist()
        lastShownSecond = Math.floor(elapsedNow(now()) / 1000)
        emit()
        ensureTimer()
        return result
      } catch (error) {
        fail(error)
        return null
      }
    }

    // ----- drag & drop (pointer driven; click-to-select still works) --------

    function boardPoint(event) {
      let rect = null
      try {
        rect = host && typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null
      } catch (error) {
        rect = null
      }
      const left = rect && typeof rect.left === 'number' ? rect.left : 0
      const top = rect && typeof rect.top === 'number' ? rect.top : 0
      return { x: Number(event.clientX) - left, y: Number(event.clientY) - top }
    }

    /**
     * Resolve the card under the pointer through the `data-dshsol-*` attributes
     * rendered by the React layer. Only movable cards carry those attributes.
     */
    function eventCardSource(event) {
      const target = event && event.target
      if (!target || typeof target.closest !== 'function') return null
      let element = null
      try {
        element = target.closest('[data-dshsol-card]')
      } catch (error) {
        element = null
      }
      if (!element) return null
      const dataset = element.dataset || {}
      if (!dataset.dshsolCard) return null
      const kind = dataset.dshsolKind
      if (kind === 'tableau') {
        const col = Number(dataset.dshsolCol)
        const index = Number(dataset.dshsolIndex)
        if (!Number.isInteger(col) || !Number.isInteger(index)) return null
        return { kind: 'tableau', col: col, index: index }
      }
      if (kind === 'waste') return { kind: 'waste' }
      if (kind === 'foundation') {
        const pile = Number(dataset.dshsolPile)
        if (!Number.isInteger(pile)) return null
        return { kind: 'foundation', pile: pile }
      }
      return null
    }

    function dragOrigin(source) {
      const layout = buildLayout()
      if (!layout) return null
      if (source.kind === 'tableau') {
        const column = state.tableau[source.col]
        if (!column || !column[source.index]) return null
        const offsets = layout.colOffsets[source.col] || []
        return {
          left: layout.colX[source.col],
          top: layout.tableauTop + (offsets[source.index] || 0),
          layout: layout,
        }
      }
      if (source.kind === 'waste') {
        if (!state.waste.length) return null
        const visible = Math.min(3, state.waste.length)
        return {
          left: layout.wasteX + Math.max(0, visible - 1) * layout.wasteFanStep,
          top: layout.topY,
          layout: layout,
        }
      }
      if (source.kind === 'foundation') {
        if (!state.foundations[source.pile] || !state.foundations[source.pile].length) return null
        return {
          left: layout.foundationX[source.pile],
          top: layout.topY,
          layout: layout,
        }
      }
      return null
    }

    function findDropTarget(x, y, source) {
      const layout = buildLayout()
      if (!layout) return null
      const pad = Math.max(4, layout.cardW * 0.06)
      let hovered = null
      for (let pile = 0; pile < 4; pile += 1) {
        const left = layout.foundationX[pile]
        const top = layout.topY
        if (x >= left - pad && x <= left + layout.cardW + pad && y >= top - pad && y <= top + layout.cardH + pad) {
          const target = { kind: 'foundation', pile: pile }
          const check = canDrop(state, source, target)
          if (check.ok) return { target: target, valid: true, reason: '' }
          if (!hovered) hovered = { target: target, valid: false, reason: check.reason }
        }
      }
      const tableauBottom = layout.tableauTop + layout.tableauH
      for (let col = 0; col < 7; col += 1) {
        const left = layout.colX[col]
        if (x < left - pad || x > left + layout.cardW + pad) continue
        if (y < layout.tableauTop - pad || y > tableauBottom + pad) continue
        const target = { kind: 'tableau', col: col }
        const check = canDrop(state, source, target)
        if (check.ok) return { target: target, valid: true, reason: '' }
        if (!hovered) hovered = { target: target, valid: false, reason: check.reason }
      }
      return hovered
    }

    function pointerDown(event) {
      if (!alive || failure) return
      if (!event) return
      if (event.button !== undefined && event.button !== 0) return
      if (event.isPrimary === false) return
      if (drag) return
      const source = eventCardSource(event)
      if (!source) return
      const cards = selectionCards(state, source)
      if (!cards || !cards.length) return
      const origin = dragOrigin(source)
      if (!origin) return
      const local = boardPoint(event)
      drag = {
        source: source,
        cards: cards,
        pointerId: event.pointerId === undefined ? 1 : event.pointerId,
        startX: local.x,
        startY: local.y,
        currentX: local.x,
        currentY: local.y,
        offsetX: local.x - origin.left,
        offsetY: local.y - origin.top,
        active: false,
        target: null,
      }
    }

    function pointerMove(event) {
      if (!drag || !event) return
      if (event.pointerId !== undefined && event.pointerId !== drag.pointerId) return
      const local = boardPoint(event)
      drag.currentX = local.x
      drag.currentY = local.y
      if (!drag.active) {
        const dx = local.x - drag.startX
        const dy = local.y - drag.startY
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
        drag.active = true
        selection = null
        setMessage('')
        try {
          if (host && typeof host.setPointerCapture === 'function') host.setPointerCapture(drag.pointerId)
        } catch (error) {
          // capture is a convenience; the board keeps receiving moves while inside
        }
      }
      const hit = findDropTarget(local.x, local.y, drag.source)
      drag.hoverTarget = hit ? hit.target : null
      drag.reason = hit && !hit.valid ? hit.reason : ''
      drag.target = hit && hit.valid ? hit.target : null
      emit()
    }

    function finishDrag(event, cancelled) {
      if (!drag) return
      const finished = drag
      if (!finished.active) {
        drag = null
        return
      }
      drag = null
      try {
        if (host && typeof host.releasePointerCapture === 'function') host.releasePointerCapture(finished.pointerId)
      } catch (error) {
        // ignore
      }
      if (!cancelled && finished.target) {
        const check = canDrop(state, finished.source, finished.target)
        if (check.ok) {
          commitAction(function () {
            return applyMove(state, finished.source, finished.target)
          })
        } else {
          setMessage(check.reason)
          emit()
        }
      } else if (!cancelled && finished.hoverTarget) {
        setMessage(finished.reason || '这里放不了')
        emit()
      } else {
        emit()
      }
      // A real browser may still dispatch a click after the drag; swallow it so
      // it cannot also select/clear something through the click handlers.
      suppressClick = true
      if (setTimeoutFn) {
        setTimeoutFn(function () {
          suppressClick = false
        }, 0)
      }
    }

    function pointerUp(event) {
      if (!drag || !event) return
      if (event.pointerId !== undefined && event.pointerId !== drag.pointerId) return
      finishDrag(event, false)
    }

    function pointerCancel(event) {
      if (!drag) return
      if (event && event.pointerId !== undefined && event.pointerId !== drag.pointerId) return
      finishDrag(event, true)
    }

    function clickCapture(event) {
      if (!suppressClick) return
      suppressClick = false
      try {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
      } catch (error) {
        // ignore
      }
    }

    // ----- user actions -----------------------------------------------------

    function drawFromStock() {
      if (!alive || failure) return
      if (!state.stock.length && !state.waste.length) {
        setMessage('牌堆和弃牌堆都空了')
        emit()
        return
      }
      selection = null
      commitAction(function () {
        const result = drawStock(state)
        if (result.ok && result.kind === 'recycle') result.message = '弃牌堆已收回牌堆'
        return result
      })
    }

    function onWasteClick() {
      if (!alive || failure) return
      if (!state.waste.length) return
      if (selection && selection.kind === 'waste') {
        selection = null
        setMessage('')
        emit()
        return
      }
      selection = { kind: 'waste' }
      setMessage('已选中 ' + cardLabel(state.waste[state.waste.length - 1]) + '，点目标列或基座放下')
      emit()
    }

    function onTableauCardClick(col, index) {
      if (!alive || failure) return
      const column = state.tableau[col]
      if (!column || !column[index]) return
      if (selection) {
        const samePile = selection.kind === 'tableau' && selection.col === col
        if (!samePile) {
          const check = canDrop(state, selection, { kind: 'tableau', col: col })
          if (check.ok) {
            commitAction(function () {
              return applyMove(state, selection, { kind: 'tableau', col: col })
            })
            return
          }
        } else if (selection.index === index) {
          selection = null
          setMessage('')
          emit()
          return
        }
      }
      if (!column[index].up) {
        setMessage('这张牌还扣着，不能移动')
        emit()
        return
      }
      selection = { kind: 'tableau', col: col, index: index }
      const count = column.length - index
      setMessage('已选中 ' + cardLabel(column[index].id) + (count > 1 ? '（' + count + ' 张）' : '') + '，点目标列或基座放下')
      emit()
    }

    function onColumnClick(col) {
      if (!alive || failure) return
      if (!selection) return
      const check = canDrop(state, selection, { kind: 'tableau', col: col })
      if (!check.ok) {
        setMessage(check.reason)
        emit()
        return
      }
      commitAction(function () {
        return applyMove(state, selection, { kind: 'tableau', col: col })
      })
    }

    function onFoundationClick(pile) {
      if (!alive || failure) return
      if (selection) {
        const check = canDrop(state, selection, { kind: 'foundation', pile: pile })
        if (check.ok) {
          commitAction(function () {
            return applyMove(state, selection, { kind: 'foundation', pile: pile })
          })
          return
        }
        setMessage(check.reason)
        emit()
        return
      }
      const foundation = state.foundations[pile]
      if (!foundation.length) {
        setMessage('基座空着，先放 A')
        emit()
        return
      }
      selection = { kind: 'foundation', pile: pile }
      setMessage('已选中 ' + cardLabel(foundation[foundation.length - 1]) + '，点目标列放下')
      emit()
    }

    function onDoubleClick(source) {
      if (!alive || failure) return
      const preview = autoMoveToFoundation(state, source)
      if (!preview.ok) {
        setMessage(preview.reason)
        emit()
        return
      }
      const selectionForMove = preview.selection
      const target = preview.target
      commitAction(function () {
        return applyMove(state, selectionForMove, target)
      })
    }

    function clearSelection() {
      if (!alive || failure) return
      if (!selection && !message) return
      selection = null
      setMessage('')
      emit()
    }

    function undo() {
      if (!alive || failure) return
      if (!state.undo.length) {
        setMessage('没有可撤销的步骤')
        emit()
        return
      }
      try {
        undoMove(state)
        selection = null
        setMessage('已撤销上一步')
        if (state.started && !state.won && runStart === null && !isHidden()) {
          runStart = now()
          scheduleFrame()
        }
        persist()
        emit()
      } catch (error) {
        fail(error)
      }
    }

    function restart() {
      if (!alive || failure) return
      try {
        stopTimer()
        cancelFrame()
        restartState(state)
        runStart = null
        selection = null
        lastShownSecond = 0
        setMessage('已重新发牌（同一副牌）')
        persist()
        emit()
      } catch (error) {
        fail(error)
      }
    }

    function newGame(seedOverride) {
      if (!alive || failure) return
      try {
        stopTimer()
        cancelFrame()
        const seed = Number.isInteger(seedOverride) ? seedOverride >>> 0 : randomSeed()
        state = emptyState(seed)
        runStart = null
        selection = null
        lastShownSecond = 0
        setMessage('新的一局')
        persist()
        emit()
      } catch (error) {
        fail(error)
      }
    }

    function onVisibilityChange() {
      if (!alive) return
      try {
        if (isHidden()) {
          stopTimer()
          cancelFrame()
          persist()
        } else if (state.started && !state.won && runStart === null) {
          runStart = now()
          scheduleFrame()
        }
        emit()
      } catch (error) {
        fail(error)
      }
    }

    function destroy() {
      if (destroyed) return
      try {
        stopTimer()
        saveStateToStorage(state)
      } catch (error) {
        // ignore
      }
      destroyed = true
      alive = false
      cancelFrame()
      if (messageTimer && clearTimeoutFn) {
        try {
          clearTimeoutFn(messageTimer)
        } catch (error) {
          // ignore
        }
        messageTimer = null
      }
      if (observer) {
        try {
          observer.disconnect()
        } catch (error) {
          // ignore
        }
        observer = null
      }
      try {
        if (view && typeof view.removeEventListener === 'function') view.removeEventListener('resize', scheduleRelayout)
      } catch (error) {
        // ignore
      }
      try {
        if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibilityChange)
      } catch (error) {
        // ignore
      }
    }

    // ----- wiring -----------------------------------------------------------

    measure()
    const ResizeObserverCtor = view && typeof view.ResizeObserver === 'function' ? view.ResizeObserver : null
    if (ResizeObserverCtor) {
      try {
        observer = new ResizeObserverCtor(function () {
          scheduleRelayout()
        })
        observer.observe(host)
      } catch (error) {
        observer = null
      }
    }
    if (view && typeof view.addEventListener === 'function') {
      try {
        view.addEventListener('resize', scheduleRelayout)
      } catch (error) {
        // ignore
      }
    }
    if (doc && typeof doc.addEventListener === 'function') {
      try {
        doc.addEventListener('visibilitychange', onVisibilityChange)
      } catch (error) {
        // ignore
      }
    }
    if (state.started && !state.won && !isHidden()) {
      runStart = now()
    }
    lastShownSecond = Math.floor(elapsedNow(now()) / 1000)
    emit()
    if (state.started && !state.won) scheduleFrame()

    return {
      destroy: destroy,
      drawFromStock: drawFromStock,
      onStockClick: drawFromStock,
      onWasteClick: onWasteClick,
      onTableauCardClick: onTableauCardClick,
      onColumnClick: onColumnClick,
      onFoundationClick: onFoundationClick,
      onDoubleClick: onDoubleClick,
      clearSelection: clearSelection,
      undo: undo,
      restart: restart,
      newGame: newGame,
      emitNow: emit,
      snapshot: buildView,
      getSelection: function () {
        return selection ? { kind: selection.kind, col: selection.col, index: selection.index, pile: selection.pile } : null
      },
      getState: function () {
        return state
      },
      pointerDown: pointerDown,
      pointerMove: pointerMove,
      pointerUp: pointerUp,
      pointerCancel: pointerCancel,
      clickCapture: clickCapture,
      getDrag: function () {
        return drag
          ? {
              active: drag.active,
              source: drag.source,
              cards: drag.cards.slice(),
              target: drag.target,
              x: drag.currentX,
              y: drag.currentY,
            }
          : null
      },
      relayout: handleResize,
    }
  }

  // ---------------------------------------------------------------------------
  // Styles (prefixed; injected inside our own root element, never on body)
  // ---------------------------------------------------------------------------

  const STYLE_TEXT = [
    '.dshsol-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);font-family:"Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;outline:none;user-select:none;-webkit-user-select:none;}',
    '.dshsol-root *,.dshsol-root *::before,.dshsol-root *::after{box-sizing:border-box;}',
    '.dshsol-toolbar{flex:0 0 auto;display:flex;align-items:center;gap:10px 14px;flex-wrap:wrap;padding:8px 12px;background:var(--dsw-alias-bg-base,#ffffff);border-bottom:1px solid var(--dsw-alias-border-l1,#d7dce2);}',
    '.dshsol-titlebox{display:flex;align-items:baseline;gap:10px;min-width:0;}',
    '.dshsol-title{font-size:15px;font-weight:700;letter-spacing:.02em;}',
    '.dshsol-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b949e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.dshsol-spacer{flex:1 1 auto;}',
    '.dshsol-stats{display:flex;gap:6px;flex:0 0 auto;}',
    '.dshsol-stat{min-width:64px;padding:3px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-1,#f6f7f9);border:1px solid var(--dsw-alias-border-l1,#e2e6ea);display:flex;flex-direction:column;align-items:flex-start;line-height:1.2;}',
    '.dshsol-stat-label{font-size:10px;color:var(--dsw-alias-label-tertiary,#8b949e);}',
    '.dshsol-stat-value{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;}',
    '.dshsol-actions{display:flex;gap:6px;flex:0 0 auto;}',
    '.dshsol-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f1f3f5);color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:5px 11px;font-size:12.5px;font-family:inherit;cursor:pointer;transition:background .15s,border-color .15s;}',
    '.dshsol-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e9edf1);border-color:var(--dsw-alias-border-l2,#b6bec8);}',
    '.dshsol-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,#dfe4e9);}',
    '.dshsol-btn:disabled{opacity:.45;cursor:default;}',
    '.dshsol-board{position:relative;flex:1 1 auto;min-height:0;min-width:0;overflow:hidden;touch-action:none;background:radial-gradient(120% 100% at 50% 0%,#2f7a3a 0%,#1f5e2a 42%,#123f1c 100%);}',
    '.dshsol-card{position:absolute;background:#fbfaf3;border:1px solid rgba(20,24,28,.25);box-shadow:0 1px 2px rgba(0,0,0,.35);overflow:hidden;}',
    '.dshsol-card--up{cursor:grab;}',
    '.dshsol-card--down{cursor:default;}',
    '.dshsol-board--dragging .dshsol-card--up{cursor:grabbing;}',
    '.dshsol-card--floating{pointer-events:none;box-shadow:0 14px 28px rgba(0,0,0,.48);}',
    '.dshsol-card--hidden{visibility:hidden;}',
    '.dshsol-card--up:hover{box-shadow:0 0 0 2px rgba(255,255,255,.85),0 5px 12px rgba(0,0,0,.4);}',
    '.dshsol-card--sel{box-shadow:0 0 0 3px #fbbf24,0 8px 18px rgba(0,0,0,.45);}',
    '.dshsol-face{position:absolute;inset:0;}',
    '.dshsol-corner{position:absolute;left:5%;top:3%;display:flex;flex-direction:column;align-items:center;line-height:1;}',
    '.dshsol-corner--br{left:auto;right:5%;top:auto;bottom:3%;transform:rotate(180deg);}',
    '.dshsol-rank{font-weight:700;letter-spacing:-.02em;}',
    '.dshsol-suit{line-height:1;}',
    '.dshsol-center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:.92;}',
    '.dshsol-red{color:#b3261e;}',
    '.dshsol-black{color:#1b1f24;}',
    '.dshsol-back{position:absolute;inset:0;background:repeating-linear-gradient(45deg,#2f56a8 0 5px,#24438a 5px 10px);}',
    '.dshsol-back::after{content:"";position:absolute;inset:7%;border:1.5px solid rgba(255,255,255,.5);border-radius:3px;}',
    '.dshsol-slot{position:absolute;border:2px dashed rgba(255,255,255,.28);border-radius:6px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.38);}',
    '.dshsol-slot--target{border-color:rgba(251,191,36,.95);background:rgba(251,191,36,.12);color:rgba(255,236,179,.9);}',
    '.dshsol-column{position:absolute;border-radius:7px;}',
    '.dshsol-column--target{background:rgba(251,191,36,.10);box-shadow:inset 0 0 0 2px rgba(251,191,36,.8);}',
    '.dshsol-column-empty{position:absolute;left:0;top:0;border:2px dashed rgba(255,255,255,.25);border-radius:6px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.32);pointer-events:none;}',
    '.dshsol-stock-badge{position:absolute;right:-4px;bottom:-4px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:rgba(15,23,42,.78);color:#f8fafc;font-size:10.5px;font-variant-numeric:tabular-nums;display:flex;align-items:center;justify-content:center;z-index:5;}',
    '.dshsol-recycle{position:absolute;inset:0;border:2px dashed rgba(255,255,255,.3);border-radius:6px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.6);}',
    '.dshsol-toast{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);max-width:86%;padding:5px 13px;border-radius:999px;background:rgba(8,20,10,.82);color:#f4f7f1;font-size:12px;line-height:1.45;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:900;}',
    '.dshsol-tip{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:8px 16px;border-radius:10px;background:rgba(8,20,10,.55);color:rgba(255,255,255,.85);font-size:12.5px;text-align:center;pointer-events:none;z-index:800;max-width:80%;line-height:1.5;}',
    '.dshsol-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(4,16,8,.52);padding:16px;z-index:1000;}',
    '.dshsol-panel{background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:14px;box-shadow:0 16px 44px rgba(0,0,0,.35);padding:20px 24px;text-align:center;max-width:88%;}',
    '.dshsol-panel-title{font-size:18px;font-weight:700;margin-bottom:6px;}',
    '.dshsol-panel-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary,#57606a);margin-bottom:14px;}',
    '.dshsol-panel-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}',
    '.dshsol-toosmall{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:rgba(255,255,255,.8);font-size:13px;text-align:center;padding:12px;line-height:1.6;}',
    '.dshsol-toosmall b{font-size:15px;}',
    // 「规则」弹窗：与同系列其它游戏保持同一套几何与 token。
    '.dshsol-rules-mask{position:absolute;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));}',
    '.dshsol-rules-card{width:min(560px,100%);max-height:86%;overflow:auto;border-radius:14px;background:var(--dsw-alias-bg-layer-2,#f1f3f5);border:1px solid var(--dsw-alias-border-l1,#d0d7de);box-shadow:0 12px 40px rgba(0,0,0,.3);outline:none;}',
    '.dshsol-rules-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:12px;padding:13px 18px;background:var(--dsw-alias-bg-layer-2,#f1f3f5);border-bottom:1px solid var(--dsw-alias-border-l1,#d0d7de);}',
    '.dshsol-rules-title{flex:1;font-size:15px;font-weight:600;}',
    '.dshsol-rules-close{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b949e);cursor:pointer;font-size:22px;line-height:1;padding:0 4px;border-radius:6px;font-family:inherit;}',
    '.dshsol-rules-body{padding:2px 18px 20px;}',
    '.dshsol-rules-body h3{font-size:12.5px;letter-spacing:.04em;color:var(--dsw-alias-label-primary,#1f2328);margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1,#d0d7de);font-weight:600;}',
    '.dshsol-rules-body ul{margin:8px 0;padding-left:19px;}',
    '.dshsol-rules-body li{font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary,#57606a);margin:6px 0;}',
    '.dshsol-rules-tip{font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary,#57606a);background:var(--dsw-alias-interactive-bg-hover,#eceff2);border-left:2px solid var(--dsw-alias-brand-primary,#2f81f7);border-radius:0 7px 7px 0;padding:9px 12px;margin:10px 0;}',
  ].join('')

  // ---------------------------------------------------------------------------
  // Client module: React component + `game.stage` registration
  // ---------------------------------------------------------------------------

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: '@local/dsh-game-solitaire',
      factory: function factory(require) {
        const React = require('react')
        const h = React.createElement

        function preventContextMenu(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
        }

        function renderCorner(cardId, size, extraClass) {
          return h(
            'div',
            { className: 'dshsol-corner' + (extraClass ? ' ' + extraClass : '') },
            h('span', { className: 'dshsol-rank', style: { fontSize: size.rank + 'px' } }, RANKS[cardRank(cardId)]),
            h('span', { className: 'dshsol-suit', style: { fontSize: size.suit + 'px' } }, SUITS[cardSuit(cardId)]),
          )
        }

        function renderFace(cardId, layout) {
          const width = layout.cardW
          const rankSize = Math.max(8, width * (cardRank(cardId) === 10 ? 0.24 : 0.3))
          const suitSize = Math.max(7, width * 0.2)
          const centerSize = Math.max(14, width * 0.6)
          return h(
            'div',
            { className: 'dshsol-face' },
            renderCorner(cardId, { rank: rankSize, suit: suitSize }, null),
            h('div', { className: 'dshsol-center', style: { fontSize: centerSize + 'px' } }, SUITS[cardSuit(cardId)]),
            width >= 64 ? renderCorner(cardId, { rank: rankSize, suit: suitSize }, 'dshsol-corner--br') : null,
          )
        }

        function cardNode(spec) {
          const layout = spec.layout
          const card = spec.card
          const style = {
            left: spec.x + 'px',
            top: spec.y + 'px',
            width: layout.cardW + 'px',
            height: layout.cardH + 'px',
            zIndex: spec.z,
            borderRadius: layout.cardRadius + 'px',
          }
          if (spec.styleExtra) {
            for (const name in spec.styleExtra) {
              if (Object.prototype.hasOwnProperty.call(spec.styleExtra, name)) style[name] = spec.styleExtra[name]
            }
          }
          let className = 'dshsol-card ' + (card.up ? 'dshsol-card--up ' : 'dshsol-card--down ')
          className += card.up ? (cardIsRed(card.id) ? 'dshsol-red' : 'dshsol-black') : ''
          if (spec.selected) className += ' dshsol-card--sel'
          if (spec.hidden) className += ' dshsol-card--hidden'
          if (spec.floating) className += ' dshsol-card--floating'
          const nodeProps = {
            key: spec.key,
            className: className,
            style: style,
            role: card.up ? 'button' : undefined,
            'aria-label': card.up ? cardLabelLong(card.id) : '扣着的牌',
            title: card.up ? cardLabelLong(card.id) : undefined,
            onClick: function onClick(event) {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
              if (spec.onClick) spec.onClick()
            },
            onDoubleClick: card.up && spec.onDoubleClick
              ? function onDoubleClick(event) {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  spec.onDoubleClick()
                }
              : undefined,
          }
          if (spec.dragSource) {
            nodeProps['data-dshsol-card'] = '1'
            nodeProps['data-dshsol-kind'] = spec.dragKind
            if (spec.dragKind === 'tableau') {
              nodeProps['data-dshsol-col'] = String(spec.dragCol)
              nodeProps['data-dshsol-index'] = String(spec.dragIndex)
            } else if (spec.dragKind === 'foundation') {
              nodeProps['data-dshsol-pile'] = String(spec.dragPile)
            }
          }
          return h(
            'div',
            nodeProps,
            card.up ? renderFace(card.id, layout) : h('div', { className: 'dshsol-back' }),
          )
        }

        function StockSlot(props) {
          const layout = props.layout
          const empty = props.count === 0
          const style = {
            position: 'absolute',
            left: layout.stockX + 'px',
            top: layout.topY + 'px',
            width: layout.cardW + 'px',
            height: layout.cardH + 'px',
            zIndex: 1,
          }
          return h(
            'div',
            {
              className: 'dshsol-slot',
              style: style,
              role: 'button',
              tabIndex: -1,
              'aria-label': empty ? '收回弃牌堆' : '牌堆，翻一张',
              title: empty ? '把弃牌堆收回去重翻' : '点一下翻一张',
              onClick: function onClick(event) {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                props.onDraw()
              },
            },
            empty
              ? h('div', { className: 'dshsol-recycle', style: { fontSize: Math.max(16, layout.cardW * 0.42) + 'px' } }, '\u21bb')
              : h('div', {
                  className: 'dshsol-card dshsol-card--down',
                  style: {
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: '100%',
                    height: '100%',
                    borderRadius: layout.cardRadius + 'px',
                  },
                }, h('div', { className: 'dshsol-back' })),
            empty ? null : h('div', { className: 'dshsol-stock-badge' }, String(props.count)),
          )
        }

        function WasteSlot(props) {
          const layout = props.layout
          const view = props.view
          const cards = view.waste
          const count = Math.min(3, cards.length)
          const start = cards.length - count
          const draggingWaste = !!(view.drag && view.drag.source.kind === 'waste')
          const nodes = []
          for (let i = 0; i < count; i += 1) {
            const card = { id: cards[start + i], up: true }
            const isTop = i === count - 1
            const selected = isTop && view.selection && view.selection.kind === 'waste'
            nodes.push(
              cardNode({
                key: 'waste-' + i,
                card: card,
                layout: layout,
                x: layout.wasteX + i * layout.wasteFanStep,
                y: layout.topY - (selected ? Math.max(4, layout.cardW * 0.06) : 0),
                z: 2 + i,
                selected: selected,
                hidden: isTop && draggingWaste,
                dragSource: isTop,
                dragKind: 'waste',
                onClick: function onClick() {
                  props.onWasteClick()
                },
                onDoubleClick: isTop
                  ? function onWasteDoubleClick() {
                      props.onWasteDoubleClick()
                    }
                  : undefined,
              }),
            )
          }
          return nodes
        }

        function FoundationSlot(props) {
          const layout = props.layout
          const pile = props.pile
          const cards = props.cards
          const target = props.target
          const style = {
            position: 'absolute',
            left: layout.foundationX[pile] + 'px',
            top: layout.topY + 'px',
            width: layout.cardW + 'px',
            height: layout.cardH + 'px',
            zIndex: 1,
          }
          const topCard = cards.length ? cards[cards.length - 1] : -1
          const selected = props.selected
          const draggingThisPile = !!(props.view && props.view.drag &&
            props.view.drag.source.kind === 'foundation' && props.view.drag.source.pile === pile)
          const children = []
          if (topCard >= 0) {
            children.push(
              cardNode({
                key: 'foundation-card',
                card: { id: topCard, up: true },
                layout: layout,
                x: 0,
                y: selected ? -Math.max(3, layout.cardW * 0.05) : 0,
                z: 2,
                selected: selected,
                hidden: draggingThisPile,
                dragSource: true,
                dragKind: 'foundation',
                dragPile: pile,
                onClick: null,
                onDoubleClick: null,
              }),
            )
          } else {
            children.push(
              h('span', { key: 'foundation-suit', style: { fontSize: Math.max(14, layout.cardW * 0.44) + 'px' } }, SUITS[pile]),
            )
          }
          return h(
            'div',
            {
              key: 'foundation-' + pile,
              className: 'dshsol-slot' + (target ? ' dshsol-slot--target' : ''),
              style: style,
              role: 'button',
              tabIndex: -1,
              'aria-label': '基座 ' + SUIT_NAMES[pile],
              onClick: function onClick(event) {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                props.onFoundationClick(pile)
              },
            },
            children,
          )
        }

        function TableauColumn(props) {
          const layout = props.layout
          const view = props.view
          const col = props.col
          const cards = view.tableau[col]
          const style = {
            position: 'absolute',
            left: layout.colX[col] + 'px',
            top: layout.tableauTop + 'px',
            width: layout.cardW + 'px',
            height: layout.tableauH + 'px',
            zIndex: 2,
          }
          const lift = Math.max(4, layout.cardW * 0.07)
          const nodes = []
          if (!cards.length) {
            nodes.push(
              h('div', {
                key: 'empty-col',
                className: 'dshsol-column-empty',
                style: {
                  width: layout.cardW + 'px',
                  height: layout.cardH + 'px',
                  fontSize: Math.max(14, layout.cardW * 0.4) + 'px',
                },
              }, 'K'),
            )
          }
          const draggingFrom = view.drag && view.drag.source.kind === 'tableau' && view.drag.source.col === col
          for (let i = 0; i < cards.length; i += 1) {
            const card = cards[i]
            const selected = !!(view.selection && view.selection.kind === 'tableau' &&
              view.selection.col === col && i >= view.selection.index)
            const inSelectedSource = selected
            const hidden = !!(draggingFrom && i >= view.drag.source.index)
            nodes.push(
              cardNode({
                key: 'card-' + col + '-' + i,
                card: card,
                layout: layout,
                x: 0,
                y: card.y - (inSelectedSource ? lift : 0),
                z: inSelectedSource ? 400 + i : i + 3,
                selected: selected,
                hidden: hidden,
                dragSource: card.up,
                dragKind: 'tableau',
                dragCol: col,
                dragIndex: i,
                onClick: card.up
                  ? function onClick() {
                      props.onCardClick(col, i)
                    }
                  : undefined,
                onDoubleClick: card.up
                  ? function onDoubleClick() {
                      props.onCardDoubleClick(col, i)
                    }
                  : undefined,
              }),
            )
          }
          return h(
            'div',
            {
              key: 'column-' + col,
              className: 'dshsol-column' + (props.target ? ' dshsol-column--target' : ''),
              style: style,
              onClick: function onClick(event) {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                props.onColumnClick(col)
              },
            },
            nodes,
          )
        }

        function Overlay(props) {
          return h(
            'div',
            { className: 'dshsol-overlay' },
            h(
              'div',
              { className: 'dshsol-panel' },
              h('div', { className: 'dshsol-panel-title' }, props.title),
              props.subtitle ? h('div', { className: 'dshsol-panel-sub' }, props.subtitle) : null,
              props.action
                ? h(
                    'div',
                    { className: 'dshsol-panel-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshsol-btn',
                        onClick: function onClick(event) {
                          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                          props.onAction()
                        },
                      },
                      props.action,
                    ),
                  )
                : null,
            ),
          )
        }

        function Stat(props) {
          return h(
            'div',
            { className: 'dshsol-stat' },
            h('span', { className: 'dshsol-stat-label' }, props.label),
            h('span', { className: 'dshsol-stat-value' }, props.value),
          )
        }

        // Stable identity so React does not detach/re-attach the ref every render.
        function focusCard(node) {
          if (node) node.focus()
        }

        function RulesModal(props) {
          function li(key, children) {
            return h('li', { key: key }, children)
          }
          function b(key, text) {
            return h('b', { key: key }, text)
          }
          return h(
            'div',
            {
              className: 'dshsol-rules-mask',
              onMouseDown: function (event) {
                if (event.target === event.currentTarget) props.onClose()
              },
            },
            h(
              'div',
              {
                ref: focusCard,
                tabIndex: -1,
                className: 'dshsol-rules-card',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': '接龙规则',
                onKeyDown: function (event) {
                  // Modal: swallow every key so the board behind does not react.
                  event.stopPropagation()
                  if (event.key === 'Escape') props.onClose()
                },
              },
              h(
                'div',
                { className: 'dshsol-rules-head' },
                h('span', { className: 'dshsol-rules-title' }, '接龙 · 规则与操作'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshsol-rules-close',
                    onClick: props.onClose,
                    'aria-label': '关闭',
                  },
                  '×',
                ),
              ),
              h(
                'div',
                { className: 'dshsol-rules-body' },
                h('h3', null, '一、目标'),
                h(
                  'ul',
                  null,
                  li('a1', ['把 52 张牌按花色整理成四摞：', b('a1a', '每种花色从 A 一路叠到 K'), '，四摞都到 K 就通关。']),
                  li('a2', ['经典 Klondike 规则，牌堆一次翻 1 张。']),
                ),
                h('h3', null, '二、牌桌怎么摆'),
                h(
                  'ul',
                  null,
                  li('b1', ['7 列牌桌：第 1 列 1 张、第 7 列 7 张，只有每列最下面一张是翻开的。']),
                  li('b2', ['列内只能按 ', b('b2a', '降序、红黑交替'), ' 叠放（红 7 上放黑 6，黑 10 上放红 9）。']),
                  li('b3', ['可以整段移动，但被拿起的这一段本身必须已经是合法序列。']),
                  li('b4', ['空列只接受 K，或以 K 开头的一整段。']),
                  li('b5', ['一段牌被移走后，新露出来的扣牌会自动翻开。']),
                ),
                h('h3', null, '三、牌堆与基座'),
                h(
                  'ul',
                  null,
                  li('c1', ['剩下 24 张作为牌堆，点一次翻 1 张到弃牌堆。']),
                  li('c2', ['牌堆空了再点一次，弃牌堆会整体翻回去重翻，次数不限。']),
                  li('c3', ['基座同花色、从 A 开始升序收到 K；弃牌堆顶和牌桌面朝上的牌都能进基座。']),
                  li('c4', ['基座顶牌也能点选后', b('c4a', '移回牌桌'), '，用来纠正放错的牌。']),
                ),
                h('h3', null, '四、操作'),
                h(
                  'ul',
                  null,
                  li('d1', ['拖拽面朝上的牌（整段一起拿起）到目标列或基座松手；目标会高亮，非法位置弹回并说明原因。']),
                  li('d2', ['也可以点选中、再点目标放下。点空白处或按 Esc 取消选中。']),
                  li('d3', [b('d3a', '双击'), '一张顶牌（每列最下面那张或弃牌堆顶）= 自动送进对应的基座。']),
                  li('d4', ['「撤销」退回上一步（至少 20 步），也可以用 Ctrl+Z。']),
                  li('d5', ['「重开」= 同一副牌重新发；「新游戏」= 换一副新牌。']),
                ),
                h(
                  'div',
                  { className: 'dshsol-rules-tip' },
                  '先别急着把 A 都收进基座 —— 基座上的牌就不能再回牌桌帮你叠牌了。翻开扣牌、腾出空列，通常比急着收牌更重要。',
                ),
              ),
            ),
          )
        }

        function makePlaceholderView() {
          return {
            width: 0,
            height: 0,
            dpr: 1,
            tooSmall: false,
            layout: null,
            stock: [],
            waste: [],
            foundations: [[], [], [], []],
            tableau: [[], [], [], [], [], [], []],
            selection: null,
            selectedCards: [],
            valid: {
              tableau: [false, false, false, false, false, false, false],
              foundation: [false, false, false, false],
            },
            moves: 0,
            elapsedSeconds: 0,
            elapsedText: '00:00',
            undoCount: 0,
            started: false,
            won: false,
            message: '',
            seed: 0,
          }
        }

        function Game(props) {
          const rootRef = React.useRef(null)
          const boardRef = React.useRef(null)
          const gameRef = React.useRef(null)
          const [view, setView] = React.useState(makePlaceholderView)
          const [error, setError] = React.useState(null)
          const [rulesOpen, setRulesOpen] = React.useState(false)
          const [attempt, setAttempt] = React.useState(0)

          React.useEffect(function () {
            const board = boardRef.current
            if (!board) return undefined
            let game = null
            try {
              game = createGame(board, {
                onState: function onState(next) {
                  setView(next)
                  setError(null)
                },
                onError: function onError(messageText) {
                  setError(messageText)
                },
              })
              gameRef.current = game
            } catch (createError) {
              try {
                console.error('[dsh-game-solitaire] failed to start', createError)
              } catch (logError) {
                // ignore
              }
              setError('游戏启动失败，点「重试」重新开始。')
              return undefined
            }
            return function cleanup() {
              gameRef.current = null
              try {
                game.destroy()
              } catch (destroyError) {
                try {
                  console.error('[dsh-game-solitaire] cleanup failed', destroyError)
                } catch (logError) {
                  // ignore
                }
              }
            }
          }, [attempt])

          const retry = React.useCallback(function () {
            setError(null)
            setAttempt(function (value) {
              return value + 1
            })
          }, [])

          const focusRoot = React.useCallback(function () {
            const root = rootRef.current
            if (!root || typeof root.focus !== 'function') return
            try {
              root.focus({ preventScroll: true })
            } catch (focusError) {
              try {
                root.focus()
              } catch (fallbackError) {
                // ignore
              }
            }
          }, [])

          const onBoardClick = React.useCallback(function () {
            focusRoot()
            const game = gameRef.current
            if (game) game.clearSelection()
          }, [focusRoot])

          // Clicking a card / column should also leave the keyboard focus on our
          // root so Esc and Ctrl+Z work (buttons keep their own focus).
          const onRootPointerDown = React.useCallback(function (event) {
            const target = event && event.target
            if (target && typeof target.closest === 'function' && target.closest('button')) return
            focusRoot()
          }, [focusRoot])

          const onKeyDown = React.useCallback(function (event) {
            if (!event) return
            const game = gameRef.current
            if (!game) return
            try {
              if (event.key === 'Escape') {
                if (typeof event.preventDefault === 'function') event.preventDefault()
                game.clearSelection()
                return
              }
              if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
                if (typeof event.preventDefault === 'function') event.preventDefault()
                game.undo()
              }
            } catch (keyError) {
              // ignore
            }
          }, [])

          const call = React.useCallback(function (name) {
            return function () {
              const game = gameRef.current
              if (!game || typeof game[name] !== 'function') return
              try {
                game[name].apply(game, arguments)
              } catch (callError) {
                try {
                  console.error('[dsh-game-solitaire] action failed', callError)
                } catch (logError) {
                  // ignore
                }
              }
            }
          }, [])

          const onStockClick = call('onStockClick')
          const onWasteClick = call('onWasteClick')
          const onColumnClick = call('onColumnClick')
          const onTableauCardClick = call('onTableauCardClick')
          const onFoundationClick = call('onFoundationClick')
          const onDoubleClick = call('onDoubleClick')
          const onUndo = call('undo')
          const onRestart = call('restart')
          const onNewGame = call('newGame')
          const onPointerDown = call('pointerDown')
          const onPointerMove = call('pointerMove')
          const onPointerUp = call('pointerUp')
          const onPointerCancel = call('pointerCancel')
          const onClickCapture = call('clickCapture')

          const layout = view.layout
          const boardChildren = []
          if (view.tooSmall) {
            boardChildren.push(
              h(
                'div',
                { key: 'too-small', className: 'dshsol-toosmall' },
                h('b', null, '窗口太小'),
                h('span', null, '把窗口放大一些再玩（至少 320 × 240）'),
              ),
            )
          } else if (layout) {
            boardChildren.push(
              h('div', { key: 'style-anchor', style: { display: 'none' } }),
            )
            boardChildren.push(
              h(StockSlot, {
                key: 'stock',
                layout: layout,
                count: view.stock.length,
                onDraw: onStockClick,
              }),
            )
            const wasteNodes = WasteSlot({
              layout: layout,
              view: view,
              onWasteClick: onWasteClick,
              onWasteDoubleClick: function onWasteDoubleClick() {
                onDoubleClick({ kind: 'waste' })
              },
            })
            for (let i = 0; i < wasteNodes.length; i += 1) boardChildren.push(wasteNodes[i])
            for (let pile = 0; pile < 4; pile += 1) {
              const dragTarget = view.drag && view.drag.target &&
                view.drag.target.kind === 'foundation' && view.drag.target.pile === pile
              boardChildren.push(
                h(FoundationSlot, {
                  key: 'foundation-' + pile,
                  layout: layout,
                  pile: pile,
                  view: view,
                  cards: view.foundations[pile],
                  target: view.valid.foundation[pile] || dragTarget,
                  selected: !!(view.selection && view.selection.kind === 'foundation' && view.selection.pile === pile),
                  onFoundationClick: onFoundationClick,
                }),
              )
            }
            for (let col = 0; col < 7; col += 1) {
              const dragTarget = view.drag && view.drag.target &&
                view.drag.target.kind === 'tableau' && view.drag.target.col === col
              boardChildren.push(
                h(TableauColumn, {
                  key: 'column-' + col,
                  layout: layout,
                  view: view,
                  col: col,
                  target: view.valid.tableau[col] || dragTarget,
                  onCardClick: onTableauCardClick,
                  onCardDoubleClick: function onCardDoubleClick(clickedCol, index) {
                    onDoubleClick({ kind: 'tableau', col: clickedCol, index: index })
                  },
                  onColumnClick: onColumnClick,
                }),
              )
            }
            if (view.drag && view.drag.cards.length) {
              const dragLeft = view.drag.x - view.drag.offsetX
              const dragTop = view.drag.y - view.drag.offsetY
              for (let i = 0; i < view.drag.cards.length; i += 1) {
                boardChildren.push(
                  cardNode({
                    key: 'drag-' + i,
                    card: { id: view.drag.cards[i], up: true },
                    layout: layout,
                    x: dragLeft,
                    y: dragTop + i * view.drag.step,
                    z: 950 + i,
                    floating: true,
                    onClick: null,
                    onDoubleClick: null,
                  }),
                )
              }
            }
            if (!view.started && !view.won && !view.drag) {
              boardChildren.push(
                h('div', { key: 'tip', className: 'dshsol-tip' }, '点牌堆翻牌开始 · 点击或拖拽选牌，放到目标列/基座 · 双击顶牌自动进基座'),
              )
            }
            if (view.message) {
              boardChildren.push(h('div', { key: 'toast', className: 'dshsol-toast' }, view.message))
            }
          }

          let overlay = null
          if (error) {
            overlay = h(Overlay, { title: '游戏出错了', subtitle: error, action: '重试', onAction: retry })
          } else if (view.won) {
            overlay = h(Overlay, {
              title: '恭喜通关！',
              subtitle: '用时 ' + view.elapsedText + ' · ' + view.moves + ' 步',
              action: '再来一局',
              onAction: onNewGame,
            })
          }

          return h(
            'div',
            {
              ref: rootRef,
              className: 'dshsol-root',
              tabIndex: 0,
              'data-dsh-game': GAME_ID,
              onContextMenu: preventContextMenu,
              onKeyDown: onKeyDown,
              onPointerDown: onRootPointerDown,
            },
            h('style', null, STYLE_TEXT),
            h(
              'div',
              { className: 'dshsol-toolbar' },
              h(
                'div',
                { className: 'dshsol-titlebox' },
                h('span', { className: 'dshsol-title' }, '接龙'),
                layout && layout.width >= 560
                  ? h('span', { className: 'dshsol-sub' }, '点击或拖拽选牌 · 双击进基座')
                  : null,
              ),
              h('div', { className: 'dshsol-spacer' }),
              h(
                'div',
                { className: 'dshsol-stats' },
                h(Stat, { label: '用时', value: view.elapsedText }),
                h(Stat, { label: '步数', value: String(view.moves) }),
              ),
              h(
                'div',
                { className: 'dshsol-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshsol-btn',
                    onClick: function () {
                      setRulesOpen(true)
                    },
                    'aria-haspopup': 'dialog',
                    title: '查看规则与操作',
                  },
                  '📖 规则',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshsol-btn',
                    disabled: view.undoCount === 0,
                    onClick: onUndo,
                    title: '撤销上一步（Ctrl+Z）',
                  },
                  '撤销',
                ),
                h('button', { type: 'button', className: 'dshsol-btn', onClick: onRestart, title: '同一副牌重新开始' }, '重开'),
                h('button', { type: 'button', className: 'dshsol-btn', onClick: onNewGame, title: '换一副新牌' }, '新游戏'),
              ),
            ),
            h(
              'div',
              {
                className: 'dshsol-board' + (view.drag ? ' dshsol-board--dragging' : ''),
                ref: boardRef,
                onClick: onBoardClick,
                onClickCapture: onClickCapture,
                onPointerDown: onPointerDown,
                onPointerMove: onPointerMove,
                onPointerUp: onPointerUp,
                onPointerCancel: onPointerCancel,
              },
              boardChildren,
              overlay,
            ),
            rulesOpen
              ? h(RulesModal, {
                  onClose: function () {
                    setRulesOpen(false)
                  },
                })
              : null,
          )
        }

        class GameBoundary extends React.Component {
          constructor(props) {
            super(props)
            this.state = { failed: false }
          }

          static getDerivedStateFromError() {
            return { failed: true }
          }

          componentDidCatch(error, info) {
            try {
              console.error('[dsh-game-solitaire] component crashed', error, info)
            } catch (logError) {
              // ignore
            }
          }

          render() {
            if (this.state.failed) {
              return h('div', { style: { padding: 16, color: 'var(--dsw-alias-label-secondary, #57606a)' } }, '接龙加载失败，请切走再重新进入「游戏」页。')
            }
            return this.props.children
          }
        }

        function GameEntry(props) {
          return h(GameBoundary, null, h(Game, props))
        }

        // Stable `matched` payload: a fresh `{}` on every select call would make
        // the chain renderer see a new matched reference on each render.
        const MATCHED = Object.freeze({})

        return {
          inject: ['slots'],
          apply: function apply(ctx) {
            try {
              ctx.slots.inject('game.stage', function () {
                try {
                  return ctx.slots.register(
                    {
                      name: 'game.stage',
                      id: GAME_ID,
                      label: function label() {
                        return '接龙'
                      },
                      select: function select(ownerProps) {
                        return ownerProps && ownerProps.gameId === GAME_ID ? MATCHED : null
                      },
                    },
                    GameEntry,
                  )
                } catch (registerError) {
                  try {
                    console.error('[dsh-game-solitaire] slot registration failed', registerError)
                  } catch (logError) {
                    // ignore
                  }
                  return function () {}
                }
              })
            } catch (injectError) {
              try {
                console.error('[dsh-game-solitaire] slot inject failed', injectError)
              } catch (logError) {
                // ignore
              }
            }
          },
        }
      },
    })
  }

  // ---------------------------------------------------------------------------
  // Opt-in test seam (used by dev/test-*.mjs and the independent verifier;
  // never enabled by the host)
  // ---------------------------------------------------------------------------

  if (typeof window !== 'undefined' && window.__DSH_GAME_SOLITAIRE_TEST__ === true) {
    Object.defineProperty(window, '__DSH_GAME_SOLITAIRE__', {
      value: Object.freeze({
        GAME_ID: GAME_ID,
        STORE_KEY: STORE_KEY,
        SCHEMA_VERSION: SCHEMA_VERSION,
        MIN_WIDTH: MIN_WIDTH,
        MIN_HEIGHT: MIN_HEIGHT,
        MAX_UNDO_KEEP: MAX_UNDO_KEEP,
        SAVE_UNDO: SAVE_UNDO,
        SUITS: SUITS.slice(),
        RANKS: RANKS.slice(),
        cardSuit: cardSuit,
        cardRank: cardRank,
        cardIsRed: cardIsRed,
        cardLabel: cardLabel,
        cardLabelLong: cardLabelLong,
        formatDuration: formatDuration,
        mulberry32: mulberry32,
        randomSeed: randomSeed,
        shuffledDeck: shuffledDeck,
        dealFromSeed: dealFromSeed,
        emptyState: emptyState,
        makeSnapshot: makeSnapshot,
        restoreSnapshot: restoreSnapshot,
        pushUndo: pushUndo,
        undoMove: undoMove,
        restartState: restartState,
        encodeTableau: encodeTableau,
        decodeTableau: decodeTableau,
        sanitizeState: sanitizeState,
        sanitizeSnapshot: sanitizeSnapshot,
        serializeState: serializeState,
        loadSavedState: loadSavedState,
        saveStateToStorage: saveStateToStorage,
        selectionCards: selectionCards,
        isAlternatingRun: isAlternatingRun,
        canDrop: canDrop,
        applyMove: applyMove,
        drawStock: drawStock,
        findFoundationFor: findFoundationFor,
        autoMoveToFoundation: autoMoveToFoundation,
        hasWon: hasWon,
        computeLayout: computeLayout,
        createGame: createGame,
      }),
      configurable: true,
    })
  }
})()
