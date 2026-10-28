/**
 * @local/dsh-game-tetris — browser half.
 *
 * Registers 「俄罗斯方块」 (Tetris) into the host's `game.stage` chain slot
 * (contract v1):
 *   - `select({ gameId })` returns `{}` only when the host selected `tetris`
 *   - the component only relies on the `matched` prop, never on host internals
 *
 * Why everything lives in this one file: `client.js` is the only browser entry
 * the module loader serves. The loader's `require` resolves entries from the
 * module table (react, ...) and cannot load package-relative modules
 * synchronously, so a separate pure-logic file would be unreachable in the
 * browser. Pure logic therefore lives first in this file and is exposed on
 * `window.__DSH_GAME_TETRIS__` only when `window.__DSH_GAME_TETRIS_TEST__ ===
 * true`, which lets `dev/` node tests exercise it without a host.
 *
 * Gameplay decisions (also documented in README.md):
 *   - 10 × 20 visible board + 2 hidden spawn rows (22 rows internally)
 *   - 7-bag randomizer (shuffle I O T S Z J L, deal all 7, reshuffle)
 *   - 4 rotation states per piece, simple wall kicks:
 *     (0,0) → ±1 column → ±2 columns → up 1 row
 *   - gravity is driven by accumulated timestamps (not frame counts):
 *     dropMs = max(80, 800 - (level-1) * 60)
 *   - lock delay 400 ms, reset by a successful move/rotate, capped at 15 resets
 *   - hold may be used once per spawned piece
 *   - clear 1/2/3/4 lines = 100/300/500/800 × level, level up every 10 lines
 *   - ghost piece, next-5 queue, score/lines/level/elapsed display
 *   - game over when the next piece cannot spawn
 *
 * Save key: localStorage['dsh.game.tetris.v1'] (schemaVersion: 1).
 */
;(function () {
  'use strict'

  const GAME_ID = 'tetris'
  const STORE_KEY = 'dsh.game.' + GAME_ID + '.v1'
  const SCHEMA_VERSION = 1

  const COLS = 10
  const HIDDEN_ROWS = 2
  const VISIBLE_ROWS = 20
  const ROWS = HIDDEN_ROWS + VISIBLE_ROWS

  const PIECE_TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']
  const TYPE_CODE = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 }
  const CODE_TYPE = [null, 'I', 'O', 'T', 'S', 'Z', 'J', 'L']

  const QUEUE_SHOWN = 5
  const SPAWN_ROW = HIDDEN_ROWS - 1

  const BASE_DROP_MS = 800
  const MIN_DROP_MS = 80
  const DROP_STEP_MS = 60
  const LINES_PER_LEVEL = 10
  const LOCK_DELAY_MS = 400
  const MAX_LOCK_RESETS = 15
  const CLEAR_POINTS = [0, 100, 300, 500, 800]
  const SOFT_DROP_POINTS = 1
  const HARD_DROP_POINTS = 2

  const MAX_SCORE = 1000000000
  const MAX_LINES = 1000000
  const MAX_PLAY_MS = 1000000000

  const MIN_STAGE_W = 340
  const MIN_STAGE_H = 300
  const PERSIST_INTERVAL_MS = 4000
  const THEME_REFRESH_MS = 1500

  const FONT_STACK = '"Segoe UI", system-ui, -apple-system, sans-serif'

  // ---------------------------------------------------------------------------
  // Piece definitions (pure, no DOM)
  //
  // SRS-style matrices: I is 4×4, O is 2×2, the rest are 3×3. Rotating the
  // matrix clockwise four times returns the original, and the spawn row is
  // chosen so the lowest cell of every piece starts on the first visible row.
  // ---------------------------------------------------------------------------

  const SPAWN_MATRICES = {
    I: ['....', '####', '....', '....'],
    O: ['##', '##'],
    T: ['.#.', '###', '...'],
    S: ['.##', '##.', '...'],
    Z: ['##.', '.##', '...'],
    J: ['#..', '###', '...'],
    L: ['..#', '###', '...'],
  }

  function parseMatrix(rows) {
    const matrix = []
    for (let y = 0; y < rows.length; y += 1) {
      const row = []
      for (let x = 0; x < rows[y].length; x += 1) row.push(rows[y][x] === '#' ? 1 : 0)
      matrix.push(row)
    }
    return matrix
  }

  /** Clockwise rotation for a square matrix: out[y][x] = in[n-1-x][y]. */
  function rotateMatrixCW(matrix) {
    const n = matrix.length
    const out = []
    for (let y = 0; y < n; y += 1) {
      const row = []
      for (let x = 0; x < n; x += 1) row.push(matrix[n - 1 - x][y])
      out.push(row)
    }
    return out
  }

  function matrixCells(matrix) {
    const cells = []
    for (let y = 0; y < matrix.length; y += 1) {
      for (let x = 0; x < matrix[y].length; x += 1) {
        if (matrix[y][x] === 1) cells.push([x, y])
      }
    }
    return cells
  }

  const PIECES = (function buildPieces() {
    const pieces = {}
    for (let index = 0; index < PIECE_TYPES.length; index += 1) {
      const type = PIECE_TYPES[index]
      const matrices = []
      const cellsByRot = []
      let matrix = parseMatrix(SPAWN_MATRICES[type])
      for (let rot = 0; rot < 4; rot += 1) {
        matrices.push(matrix)
        cellsByRot.push(matrixCells(matrix))
        matrix = rotateMatrixCW(matrix)
      }
      pieces[type] = {
        type,
        size: SPAWN_MATRICES[type].length,
        matrices,
        cellsByRot,
      }
    }
    return pieces
  })()

  const PIECE_COLORS = {
    I: { main: '#22d3ee', light: '#a5f3fc', dark: '#0e7490' },
    O: { main: '#fbbf24', light: '#fde68a', dark: '#b45309' },
    T: { main: '#c084fc', light: '#e9d5ff', dark: '#7e22ce' },
    S: { main: '#4ade80', light: '#bbf7d0', dark: '#15803d' },
    Z: { main: '#fb7185', light: '#fecdd3', dark: '#be123c' },
    J: { main: '#60a5fa', light: '#bfdbfe', dark: '#1d4ed8' },
    L: { main: '#fb923c', light: '#fed7aa', dark: '#c2410c' },
  }

  // ---------------------------------------------------------------------------
  // RNG helpers
  // ---------------------------------------------------------------------------

  function rngUnit(rng) {
    let value
    try {
      value = Number(rng())
    } catch (error) {
      value = 0
    }
    if (!Number.isFinite(value)) value = 0
    if (value < 0) value = 0
    if (value >= 1) value = 0.999999999
    return value
  }

  /** Fisher–Yates over the 7 piece types. */
  function shuffleBag(rng) {
    const source = typeof rng === 'function' ? rng : Math.random
    const bag = PIECE_TYPES.slice()
    for (let index = bag.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rngUnit(source) * (index + 1))
      const value = bag[index]
      bag[index] = bag[swap]
      bag[swap] = value
    }
    return bag
  }

  // ---------------------------------------------------------------------------
  // Board / piece helpers (pure)
  // ---------------------------------------------------------------------------

  function createEmptyBoard() {
    const board = []
    for (let row = 0; row < ROWS; row += 1) board.push(new Array(COLS).fill(0))
    return board
  }

  function isPieceType(value) {
    return PIECE_TYPES.indexOf(value) !== -1
  }

  function makeSpawnPiece(type) {
    const size = PIECES[type].size
    return {
      type,
      rot: 0,
      x: Math.floor((COLS - size) / 2),
      y: SPAWN_ROW,
    }
  }

  function pieceCells(piece) {
    return PIECES[piece.type].cellsByRot[piece.rot]
  }

  /** True when the piece overlaps a wall, the floor or a filled cell. */
  function collides(board, piece) {
    if (!board || !piece || !PIECES[piece.type]) return true
    const cells = pieceCells(piece)
    for (let index = 0; index < cells.length; index += 1) {
      const x = piece.x + cells[index][0]
      const y = piece.y + cells[index][1]
      if (x < 0 || x >= COLS || y >= ROWS) return true
      if (y >= 0 && board[y][x] !== 0) return true
    }
    return false
  }

  function canMove(board, piece, dx, dy) {
    if (!piece) return false
    return !collides(board, {
      type: piece.type,
      rot: piece.rot,
      x: piece.x + dx,
      y: piece.y + dy,
    })
  }

  function ghostRow(board, piece) {
    if (!piece) return 0
    let row = piece.y
    while (!collides(board, { type: piece.type, rot: piece.rot, x: piece.x, y: row + 1 })) {
      row += 1
    }
    return row
  }

  /**
   * Simple (non-SRS) wall kicks: in place, ±1 column, ±2 columns, then up one
   * row. Returns the kicked piece or null when every candidate is blocked.
   */
  function rotatePiece(board, piece, direction) {
    if (!piece) return null
    const step = direction < 0 ? 3 : 1
    const nextRot = (piece.rot + step) % 4
    const kicks = [
      [0, 0],
      [-1, 0],
      [1, 0],
      [-2, 0],
      [2, 0],
      [0, -1],
    ]
    for (let index = 0; index < kicks.length; index += 1) {
      const candidate = {
        type: piece.type,
        rot: nextRot,
        x: piece.x + kicks[index][0],
        y: piece.y + kicks[index][1],
      }
      if (candidate.y < 0) continue
      if (!collides(board, candidate)) return candidate
    }
    return null
  }

  /** Removes full rows in place, shifts everything down and returns the count. */
  function clearFullLines(board) {
    const kept = []
    let cleared = 0
    for (let row = 0; row < ROWS; row += 1) {
      let full = true
      for (let col = 0; col < COLS; col += 1) {
        if (board[row][col] === 0) {
          full = false
          break
        }
      }
      if (full) cleared += 1
      else kept.push(board[row])
    }
    while (kept.length < ROWS) kept.unshift(new Array(COLS).fill(0))
    for (let row = 0; row < ROWS; row += 1) board[row] = kept[row]
    return cleared
  }

  function dropIntervalMs(level) {
    const safe = Number.isFinite(level) && level >= 1 ? Math.floor(level) : 1
    return Math.max(MIN_DROP_MS, BASE_DROP_MS - (safe - 1) * DROP_STEP_MS)
  }

  // ---------------------------------------------------------------------------
  // Queue / spawn / hold (pure, mutates the passed state)
  // ---------------------------------------------------------------------------

  function fillQueue(state, rng) {
    while (state.queue.length < QUEUE_SHOWN) {
      if (!state.bag || state.bag.length === 0) state.bag = shuffleBag(rng)
      state.queue.push(state.bag.shift())
    }
  }

  function takeNext(state, rng) {
    fillQueue(state, rng)
    const type = state.queue.shift()
    fillQueue(state, rng)
    return type
  }

  function spawnPiece(state, type) {
    const piece = makeSpawnPiece(type)
    state.current = piece
    if (collides(state.board, piece)) {
      state.current = null
      state.over = true
      return null
    }
    return piece
  }

  function spawnNext(state, rng) {
    const type = takeNext(state, rng)
    state.canHold = true
    return spawnPiece(state, type)
  }

  function attachRuntime(state) {
    state.dropAccum = 0
    state.lockAccum = 0
    state.lockResets = 0
    state.resting = false
    return state
  }

  function freshState(rng) {
    const state = {
      board: createEmptyBoard(),
      current: null,
      queue: [],
      bag: [],
      hold: null,
      canHold: true,
      score: 0,
      lines: 0,
      level: 1,
      playMs: 0,
      over: false,
    }
    attachRuntime(state)
    fillQueue(state, rng)
    spawnNext(state, rng)
    return state
  }

  /**
   * Locks the current piece, clears lines, scores, levels up and spawns the next
   * piece. Returns `{ cleared, gained }`. The caller resets lock timers.
   */
  function lockCurrent(state, rng) {
    const piece = state.current
    const result = { cleared: 0, gained: 0 }
    if (!piece) return result
    const cells = pieceCells(piece)
    for (let index = 0; index < cells.length; index += 1) {
      const x = piece.x + cells[index][0]
      const y = piece.y + cells[index][1]
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue
      state.board[y][x] = TYPE_CODE[piece.type]
    }
    state.current = null
    const cleared = clearFullLines(state.board)
    result.cleared = cleared
    if (cleared > 0) {
      result.gained = CLEAR_POINTS[cleared] * state.level
      state.score += result.gained
      state.lines += cleared
      state.level = Math.floor(state.lines / LINES_PER_LEVEL) + 1
    }
    spawnNext(state, rng)
    return result
  }

  /** Store or swap the current piece. Returns false when hold is not allowed. */
  function holdPiece(state, rng) {
    if (!state.current || state.over || !state.canHold) return false
    const currentType = state.current.type
    let nextType
    if (state.hold) {
      nextType = state.hold
      state.hold = currentType
    } else {
      state.hold = currentType
      nextType = takeNext(state, rng)
    }
    state.canHold = false
    spawnPiece(state, nextType)
    return true
  }

  // ---------------------------------------------------------------------------
  // Save / restore (pure; bad saves must become a fresh game, never throw)
  // ---------------------------------------------------------------------------

  function sanitizeInt(value, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) return null
    return value
  }

  function sanitizeBoard(input) {
    if (!Array.isArray(input) || input.length !== ROWS) return null
    const board = []
    for (let row = 0; row < ROWS; row += 1) {
      const source = input[row]
      if (!Array.isArray(source) || source.length !== COLS) return null
      const clean = new Array(COLS)
      let full = true
      for (let col = 0; col < COLS; col += 1) {
        const value = source[col]
        if (!Number.isInteger(value) || value < 0 || value > 7) return null
        clean[col] = value
        if (value === 0) full = false
      }
      // A persisted board can never legitimately contain a full row: lines are
      // cleared synchronously on lock, before any save happens.
      if (full) return null
      board.push(clean)
    }
    return board
  }

  function sanitizePiece(input) {
    if (!input || typeof input !== 'object') return null
    if (!isPieceType(input.type)) return null
    if (!Number.isInteger(input.rot) || input.rot < 0 || input.rot > 3) return null
    if (!Number.isInteger(input.x) || !Number.isInteger(input.y)) return null
    if (input.x < -4 || input.x > COLS + 4) return null
    if (input.y < 0 || input.y > ROWS) return null
    return { type: input.type, rot: input.rot, x: input.x, y: input.y }
  }

  function sanitizeTypeList(input, maxLength, unique) {
    if (input === undefined || input === null) return []
    if (!Array.isArray(input) || input.length > maxLength) return null
    const out = []
    const seen = {}
    for (let index = 0; index < input.length; index += 1) {
      const value = input[index]
      if (!isPieceType(value)) return null
      if (unique && seen[value] === true) return null
      seen[value] = true
      out.push(value)
    }
    return out
  }

  /** Validate a persisted snapshot. Returns null for any mismatch. */
  function sanitizeState(input) {
    if (!input || typeof input !== 'object' || input.schemaVersion !== SCHEMA_VERSION) return null
    const board = sanitizeBoard(input.board)
    if (!board) return null
    const score = sanitizeInt(input.score, 0, MAX_SCORE)
    const lines = sanitizeInt(input.lines, 0, MAX_LINES)
    const playMs = sanitizeInt(input.playMs, 0, MAX_PLAY_MS)
    if (score === null || lines === null || playMs === null) return null

    const over = input.over === true
    let current = null
    if (!over) {
      current = sanitizePiece(input.current)
      if (!current) return null
      if (collides(board, current)) return null
      const cells = pieceCells(current)
      for (let index = 0; index < cells.length; index += 1) {
        if (current.y + cells[index][1] < 0) return null
      }
    }

    const queue = sanitizeTypeList(input.queue, 40, false)
    const bag = sanitizeTypeList(input.bag, PIECE_TYPES.length, true)
    if (queue === null || bag === null) return null

    let hold = null
    if (input.hold !== null && input.hold !== undefined) {
      if (!isPieceType(input.hold)) return null
      hold = input.hold
    }

    return {
      board,
      current,
      queue,
      bag,
      hold,
      canHold: input.canHold === true,
      score,
      lines,
      level: Math.floor(lines / LINES_PER_LEVEL) + 1,
      playMs,
      over,
      paused: input.paused === true && !over,
    }
  }

  /**
   * Clamp a counter into the range accepted by sanitizeState. Long/absurd runs
   * then still round-trip instead of being discarded as a corrupt save; normal
   * values are far below these caps.
   */
  function clampCounter(value, max) {
    const number = Math.floor(Number(value))
    if (!Number.isFinite(number) || number < 0) return 0
    return Math.min(number, max)
  }

  function serializeState(state, pausedByUser) {
    return {
      schemaVersion: SCHEMA_VERSION,
      board: state.board.map(function (row) {
        return row.slice()
      }),
      current: state.current
        ? { type: state.current.type, rot: state.current.rot, x: state.current.x, y: state.current.y }
        : null,
      queue: state.queue.slice(),
      bag: state.bag ? state.bag.slice() : [],
      hold: state.hold,
      canHold: state.canHold === true,
      score: clampCounter(state.score, MAX_SCORE),
      lines: clampCounter(state.lines, MAX_LINES),
      level: clampCounter(state.level, MAX_LINES),
      playMs: clampCounter(state.playMs, MAX_PLAY_MS),
      over: state.over === true,
      paused: pausedByUser === true,
    }
  }

  /** Turn a sanitized snapshot into a playable state (fills queue/bag). */
  function hydrateState(saved, rng) {
    const state = saved
    attachRuntime(state)
    fillQueue(state, rng)
    if (state.current) {
      state.resting = !canMove(state.board, state.current, 0, 1)
    }
    return state
  }

  function loadSavedState() {
    try {
      const raw = window.localStorage.getItem(STORE_KEY)
      if (!raw) return null
      return sanitizeState(JSON.parse(raw))
    } catch (error) {
      return null
    }
  }

  function saveStateToStorage(state, pausedByUser) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(serializeState(state, pausedByUser)))
    } catch (error) {
      // localStorage may be unavailable; gameplay keeps working in memory.
    }
  }

  // ---------------------------------------------------------------------------
  // Layout + theme
  // ---------------------------------------------------------------------------

  const FALLBACK_THEME = Object.freeze({
    base: '#0f1218',
    surface: 'rgba(148, 163, 184, 0.10)',
    border: 'rgba(148, 163, 184, 0.28)',
    text: '#eef2f8',
    secondary: '#b6c0cf',
    tertiary: '#8b95a5',
    accent: '#5b9dff',
  })

  const BOARD_FILL = '#0b1020'
  const BOARD_EDGE = 'rgba(148, 163, 184, 0.38)'
  const GRID_LINE = 'rgba(148, 163, 184, 0.10)'

  /** Sample the host theme tokens once; fallbacks keep the game usable. */
  function readTheme(element, view) {
    try {
      if (!element || !view || typeof view.getComputedStyle !== 'function') return FALLBACK_THEME
      const style = view.getComputedStyle(element)
      if (!style || typeof style.getPropertyValue !== 'function') return FALLBACK_THEME
      function pick(name, fallback) {
        try {
          const value = String(style.getPropertyValue(name) || '').trim()
          return value || fallback
        } catch (error) {
          return fallback
        }
      }
      return {
        base: pick('--dsw-alias-bg-base', FALLBACK_THEME.base),
        surface: pick('--dsw-alias-bg-layer-2', FALLBACK_THEME.surface),
        border: pick('--dsw-alias-border-l1', FALLBACK_THEME.border),
        text: pick('--dsw-alias-label-primary', FALLBACK_THEME.text),
        secondary: pick('--dsw-alias-label-secondary', FALLBACK_THEME.secondary),
        tertiary: pick('--dsw-alias-label-tertiary', FALLBACK_THEME.tertiary),
        accent: pick('--dsw-alias-brand-primary', FALLBACK_THEME.accent),
      }
    } catch (error) {
      return FALLBACK_THEME
    }
  }

  /**
   * Board + side panel geometry in CSS pixels. The side panel is 4.6 cells
   * wide, the gap 0.9 cells, so the whole group is 15.5 cells wide × 20 high.
   */
  function computeLayout(width, height) {
    const w = Math.max(0, width)
    const h = Math.max(0, height)
    const pad = Math.max(8, Math.min(18, Math.min(w, h) * 0.02))
    const sideUnits = 4.6
    const gapUnits = 0.9
    const cell = Math.max(
      6,
      Math.floor(Math.min((w - pad * 2) / (COLS + gapUnits + sideUnits), (h - pad * 2) / VISIBLE_ROWS)),
    )
    const boardW = COLS * cell
    const boardH = VISIBLE_ROWS * cell
    const gap = Math.max(6, Math.round(gapUnits * cell))
    const sideW = Math.round(sideUnits * cell)
    const groupW = boardW + gap + sideW
    const x = Math.max(pad, Math.round((w - groupW) / 2))
    const y = Math.max(pad, Math.round((h - boardH) / 2))
    return {
      cell,
      pad,
      board: { x, y, w: boardW, h: boardH },
      side: { x: x + boardW + gap, y, w: sideW, h: boardH },
    }
  }

  // ---------------------------------------------------------------------------
  // Canvas drawing helpers
  // ---------------------------------------------------------------------------

  function pathRoundRect(ctx, x, y, width, height, radius) {
    if (width <= 0 || height <= 0) return
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2))
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + width - r, y)
    ctx.arcTo(x + width, y, x + width, y + r, r)
    ctx.lineTo(x + width, y + height - r)
    ctx.arcTo(x + width, y + height, x + width - r, y + height, r)
    ctx.lineTo(x + r, y + height)
    ctx.arcTo(x, y + height, x, y + height - r, r)
    ctx.lineTo(x, y + r)
    ctx.arcTo(x, y, x + r, y, r)
    ctx.closePath()
  }

  function fillRoundRect(ctx, x, y, width, height, radius, style) {
    pathRoundRect(ctx, x, y, width, height, radius)
    ctx.fillStyle = style
    ctx.fill()
  }

  function strokeRoundRect(ctx, x, y, width, height, radius, style, lineWidth) {
    pathRoundRect(ctx, x, y, width, height, radius)
    ctx.strokeStyle = style
    ctx.lineWidth = lineWidth
    ctx.stroke()
  }

  function drawBlock(ctx, x, y, cell, type, alpha) {
    const color = PIECE_COLORS[type] || PIECE_COLORS.T
    const opacity = typeof alpha === 'number' ? alpha : 1
    if (cell < 6) {
      ctx.save()
      ctx.globalAlpha = opacity
      ctx.fillStyle = color.main
      ctx.fillRect(x, y, cell, cell)
      ctx.restore()
      return
    }
    const inset = Math.max(1, Math.round(cell * 0.055))
    const size = cell - inset * 2
    const radius = Math.max(2, Math.round(cell * 0.16))
    ctx.save()
    ctx.globalAlpha = opacity
    fillRoundRect(ctx, x + inset, y + inset, size, size, radius, color.main)
    if (size >= 10) {
      const lightHeight = Math.max(2, Math.round(size * 0.16))
      const darkHeight = Math.max(2, Math.round(size * 0.18))
      ctx.globalAlpha = opacity * 0.55
      fillRoundRect(
        ctx,
        x + inset + 1,
        y + inset + 1,
        size - 2,
        lightHeight,
        Math.max(1, radius * 0.6),
        color.light,
      )
      ctx.globalAlpha = opacity * 0.5
      fillRoundRect(
        ctx,
        x + inset + 1,
        y + inset + size - darkHeight - 1,
        size - 2,
        darkHeight,
        Math.max(1, radius * 0.6),
        color.dark,
      )
    }
    ctx.restore()
  }

  function drawGhostBlock(ctx, x, y, cell, type) {
    if (cell < 6) return
    const color = PIECE_COLORS[type] || PIECE_COLORS.T
    const inset = Math.max(1, Math.round(cell * 0.09))
    const size = cell - inset * 2
    const radius = Math.max(2, Math.round(cell * 0.16))
    ctx.save()
    ctx.globalAlpha = 0.14
    fillRoundRect(ctx, x + inset, y + inset, size, size, radius, color.main)
    ctx.globalAlpha = 0.8
    strokeRoundRect(ctx, x + inset, y + inset, size, size, radius, color.main, Math.max(1, Math.round(cell * 0.07)))
    ctx.restore()
  }

  function drawBoardPanel(ctx, layout) {
    fillRoundRect(ctx, layout.board.x, layout.board.y, layout.board.w, layout.board.h, Math.max(6, layout.cell * 0.16), BOARD_FILL)

    ctx.save()
    pathRoundRect(ctx, layout.board.x, layout.board.y, layout.board.w, layout.board.h, Math.max(6, layout.cell * 0.16))
    ctx.clip()
    ctx.strokeStyle = GRID_LINE
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let col = 1; col < COLS; col += 1) {
      const x = layout.board.x + col * layout.cell + 0.5
      ctx.moveTo(x, layout.board.y)
      ctx.lineTo(x, layout.board.y + layout.board.h)
    }
    for (let row = 1; row < VISIBLE_ROWS; row += 1) {
      const y = layout.board.y + row * layout.cell + 0.5
      ctx.moveTo(layout.board.x, y)
      ctx.lineTo(layout.board.x + layout.board.w, y)
    }
    ctx.stroke()
    ctx.restore()

    strokeRoundRect(
      ctx,
      layout.board.x,
      layout.board.y,
      layout.board.w,
      layout.board.h,
      Math.max(6, layout.cell * 0.16),
      BOARD_EDGE,
      1.5,
    )
  }

  function drawPreviewCentered(ctx, type, centerX, centerY, maxWidth, maxHeight) {
    if (!type || !PIECES[type] || maxWidth < 4 || maxHeight < 4) return
    const cells = PIECES[type].cellsByRot[0]
    let minX = 99
    let maxX = -1
    let minY = 99
    let maxY = -1
    for (let index = 0; index < cells.length; index += 1) {
      const x = cells[index][0]
      const y = cells[index][1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const width = maxX - minX + 1
    const height = maxY - minY + 1
    const fit = Math.min(maxWidth / width, maxHeight / height) * 0.72
    const mini = Math.max(2, Math.floor(fit))
    const originX = centerX - (width * mini) / 2 - minX * mini
    const originY = centerY - (height * mini) / 2 - minY * mini
    for (let index = 0; index < cells.length; index += 1) {
      drawBlock(ctx, originX + cells[index][0] * mini, originY + cells[index][1] * mini, mini, type)
    }
  }

  function drawSidebarPanel(ctx, x, y, width, height, label, theme, labelSize, pad) {
    const radius = Math.max(6, Math.round(pad * 0.9))
    fillRoundRect(ctx, x, y, width, height, radius, theme.surface)
    strokeRoundRect(ctx, x, y, width, height, radius, theme.border, 1)
    ctx.save()
    ctx.fillStyle = theme.tertiary
    ctx.font = '600 ' + labelSize + 'px ' + FONT_STACK
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(label, x + pad, y + pad)
    ctx.restore()
  }

  function drawSidebar(ctx, layout, theme, state) {
    const pad = Math.max(6, Math.round(layout.cell * 0.24))
    const labelSize = Math.max(10, Math.round(layout.cell * 0.3))
    const labelHeight = Math.round(labelSize * 1.15)
    const panelGap = Math.max(6, Math.round(layout.cell * 0.5))
    const holdHeight = Math.min(
      layout.side.h * 0.25,
      Math.round(labelHeight + pad * 2 + layout.cell * 2.6),
    )
    const nextY = layout.side.y + holdHeight + panelGap
    const nextHeight = layout.side.y + layout.side.h - nextY
    const nextUsable = nextHeight > labelHeight + pad * 2 + 8

    // HOLD
    drawSidebarPanel(ctx, layout.side.x, layout.side.y, layout.side.w, holdHeight, 'HOLD', theme, labelSize, pad)
    const holdInnerTop = layout.side.y + pad + labelHeight
    const holdInnerHeight = holdHeight - pad * 2 - labelHeight
    drawPreviewCentered(
      ctx,
      state.hold,
      layout.side.x + layout.side.w / 2,
      holdInnerTop + holdInnerHeight / 2,
      layout.side.w - pad * 2,
      holdInnerHeight,
    )

    if (!nextUsable) return

    // NEXT (first 5 queue entries)
    drawSidebarPanel(ctx, layout.side.x, nextY, layout.side.w, nextHeight, 'NEXT', theme, labelSize, pad)
    const innerTop = nextY + pad + labelHeight
    const innerHeight = nextHeight - pad * 2 - labelHeight
    const slotHeight = innerHeight / QUEUE_SHOWN
    for (let index = 0; index < QUEUE_SHOWN; index += 1) {
      const type = state.queue[index]
      if (!type) break
      drawPreviewCentered(
        ctx,
        type,
        layout.side.x + layout.side.w / 2,
        innerTop + slotHeight * (index + 0.5),
        layout.side.w - pad * 2,
        slotHeight - 2,
      )
    }
  }

  function drawTooSmall(ctx, width, height, theme) {
    if (width <= 0 || height <= 0) return
    ctx.save()
    ctx.fillStyle = theme.base
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = theme.text
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const size = Math.max(12, Math.min(18, Math.round(Math.min(width, height) * 0.06)))
    ctx.font = '600 ' + size + 'px ' + FONT_STACK
    ctx.fillText('窗口太小', width / 2, height / 2 - size)
    ctx.fillStyle = theme.secondary
    ctx.font = Math.max(11, size - 3) + 'px ' + FONT_STACK
    ctx.fillText('请放大游戏区域', width / 2, height / 2 + size)
    ctx.restore()
  }

  function drawScene(ctx, layout, theme, state) {
    drawBoardPanel(ctx, layout)

    const boardX = layout.board.x
    const boardY = layout.board.y
    const cell = layout.cell

    // Locked blocks.
    for (let row = HIDDEN_ROWS; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const code = state.board[row][col]
        if (code === 0) continue
        drawBlock(
          ctx,
          boardX + col * cell,
          boardY + (row - HIDDEN_ROWS) * cell,
          cell,
          CODE_TYPE[code],
        )
      }
    }

    if (state.current && !state.over) {
      const piece = state.current
      const cells = pieceCells(piece)

      // Ghost preview at the drop position.
      const landing = ghostRow(state.board, piece)
      if (landing !== piece.y) {
        for (let index = 0; index < cells.length; index += 1) {
          const row = landing + cells[index][1]
          if (row < HIDDEN_ROWS) continue
          drawGhostBlock(
            ctx,
            boardX + (piece.x + cells[index][0]) * cell,
            boardY + (row - HIDDEN_ROWS) * cell,
            cell,
            piece.type,
          )
        }
      }

      // Active piece.
      for (let index = 0; index < cells.length; index += 1) {
        const row = piece.y + cells[index][1]
        if (row < HIDDEN_ROWS) continue
        drawBlock(
          ctx,
          boardX + (piece.x + cells[index][0]) * cell,
          boardY + (row - HIDDEN_ROWS) * cell,
          cell,
          piece.type,
        )
      }
    }

    drawSidebar(ctx, layout, theme, state)
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds
  }

  // ---------------------------------------------------------------------------
  // Game instance: state + canvas + input + persistence + cleanup
  // ---------------------------------------------------------------------------

  function createGame(host, options) {
    if (!host) throw new Error('tetris: missing mount element')
    const opts = options || {}
    const random = typeof opts.random === 'function' ? opts.random : Math.random
    const onState = typeof opts.onState === 'function' ? opts.onState : null
    const onError = typeof opts.onError === 'function' ? opts.onError : null
    const doc = document
    const view = window

    const saved = loadSavedState()
    let state = saved ? hydrateState(saved, random) : freshState(random)
    let paused = saved ? saved.paused === true : false
    let pauseReason = paused ? 'user' : null
    let alive = true
    let raf = 0
    let failure = null
    let focused = false
    let theme = FALLBACK_THEME
    let size = { width: 0, height: 0, dpr: 1 }
    let lastTs = 0
    let lastEmitSec = -1
    let persistAccum = 0
    let themeAccum = 0

    const canvas = doc.createElement('canvas')
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'application')
    canvas.setAttribute('aria-label', '俄罗斯方块棋盘')
    canvas.style.cssText =
      'display:block;width:100%;height:100%;outline:none;touch-action:none;-webkit-user-select:none;user-select:none'

    function clock() {
      const perf = view.performance
      return perf && typeof perf.now === 'function' ? perf.now() : Date.now()
    }

    function snapshot() {
      return {
        score: state.score,
        lines: state.lines,
        level: state.level,
        elapsedMs: Math.max(0, Math.floor(state.playMs)),
        paused,
        over: state.over === true,
        focused,
        canHold: state.canHold === true,
        hold: state.hold,
        next: state.queue.slice(0, QUEUE_SHOWN),
        current: state.current ? state.current.type : null,
        piece: state.current
          ? {
              type: state.current.type,
              rot: state.current.rot,
              x: state.current.x,
              y: state.current.y,
            }
          : null,
      }
    }

    function emit() {
      if (!onState) return
      try {
        onState(snapshot())
      } catch (error) {
        console.error('[dsh-game-tetris] state listener failed', error)
      }
    }

    function persist() {
      saveStateToStorage(state, paused && pauseReason === 'user')
    }

    function stopLoop() {
      if (!raf) return
      try {
        view.cancelAnimationFrame(raf)
      } catch (error) {
        // ignore
      }
      raf = 0
    }

    function fail(error) {
      if (!alive) return
      failure = '游戏遇到问题，点「重试」重新开始。'
      stopLoop()
      try {
        console.error('[dsh-game-tetris] runtime error', error)
      } catch (logError) {
        // ignore
      }
      if (onError) {
        try {
          onError(failure)
        } catch (listenerError) {
          console.error('[dsh-game-tetris] error listener failed', listenerError)
        }
      }
    }

    function drawFrame() {
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('tetris: 2d canvas context unavailable')
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
      ctx.clearRect(0, 0, size.width, size.height)
      if (size.width < MIN_STAGE_W || size.height < MIN_STAGE_H) {
        drawTooSmall(ctx, size.width, size.height, theme)
        return
      }
      drawScene(ctx, computeLayout(size.width, size.height), theme, state)
    }

    function canPlay() {
      return alive && !failure && !paused && state.over !== true && doc.hidden !== true
    }

    function isGrounded() {
      return state.current ? !canMove(state.board, state.current, 0, 1) : false
    }

    function settleAfterManipulation() {
      if (!state.current) return
      state.dropAccum = 0
      if (canMove(state.board, state.current, 0, 1)) {
        state.resting = false
        state.lockAccum = 0
        return
      }
      if (!state.resting) {
        state.resting = true
        state.lockAccum = 0
        return
      }
      if (state.lockResets < MAX_LOCK_RESETS) {
        state.lockResets += 1
        state.lockAccum = 0
      }
    }

    function lockAndAdvance() {
      if (!state.current) return
      lockCurrent(state, random)
      state.resting = false
      state.lockAccum = 0
      state.lockResets = 0
      state.dropAccum = 0
      if (!state.over && state.current && !canMove(state.board, state.current, 0, 1)) {
        state.resting = true
      }
      persist()
      emit()
      drawFrame()
      if (state.over) stopLoop()
    }

    function update(dt) {
      if (state.over) return
      state.playMs += dt

      themeAccum += dt
      if (themeAccum >= THEME_REFRESH_MS) {
        themeAccum = 0
        theme = readTheme(host, view)
      }

      persistAccum += dt
      if (persistAccum >= PERSIST_INTERVAL_MS) {
        persistAccum = 0
        persist()
      }

      if (state.resting) {
        state.lockAccum += dt
        if (state.lockAccum >= LOCK_DELAY_MS) lockAndAdvance()
        return
      }

      state.dropAccum += dt
      const interval = dropIntervalMs(state.level)
      let steps = 0
      while (state.dropAccum >= interval && steps < 8) {
        steps += 1
        state.dropAccum -= interval
        if (!state.current || !canMove(state.board, state.current, 0, 1)) {
          state.resting = true
          state.lockAccum = 0
          state.dropAccum = 0
          return
        }
        state.current.y += 1
        if (!canMove(state.board, state.current, 0, 1)) {
          state.resting = true
          state.lockAccum = 0
          state.dropAccum = 0
          return
        }
      }
    }

    function frame(timestamp) {
      raf = 0
      if (!alive || failure) return
      const now = typeof timestamp === 'number' ? timestamp : clock()
      if (!lastTs) lastTs = now
      let dt = now - lastTs
      if (!(dt >= 0)) dt = 0
      // A stalled frame (GC, compositor hiccup) must not teleport the piece.
      if (dt > 250) dt = 250
      lastTs = now
      try {
        if (doc.hidden !== true && !paused && !state.over) update(dt)
        drawFrame()
        const second = Math.floor(state.playMs / 1000)
        if (second !== lastEmitSec) {
          lastEmitSec = second
          emit()
        }
      } catch (error) {
        fail(error)
        return
      }
      if (!paused && !state.over && doc.hidden !== true && alive && !failure) {
        try {
          raf = view.requestAnimationFrame(frame)
        } catch (error) {
          fail(error)
        }
      }
    }

    function startLoop() {
      if (!alive || failure || raf) return
      if (paused || state.over || doc.hidden === true) return
      lastTs = clock()
      try {
        raf = view.requestAnimationFrame(frame)
      } catch (error) {
        fail(error)
      }
    }

    function pauseGame(reason) {
      if (!alive || failure || state.over || paused) return false
      paused = true
      pauseReason = reason
      stopLoop()
      state.dropAccum = 0
      persist()
      drawFrame()
      emit()
      return true
    }

    function resumeGame() {
      if (!alive || failure || !paused || state.over) return false
      paused = false
      pauseReason = null
      state.dropAccum = 0
      lastTs = clock()
      persist()
      drawFrame()
      emit()
      startLoop()
      return true
    }

    function togglePause() {
      if (!alive || failure || state.over) return false
      return paused ? resumeGame() : pauseGame('user')
    }

    function moveHorizontal(direction) {
      if (!canPlay() || !state.current) return false
      const candidate = {
        type: state.current.type,
        rot: state.current.rot,
        x: state.current.x + direction,
        y: state.current.y,
      }
      if (collides(state.board, candidate)) return false
      state.current.x = candidate.x
      settleAfterManipulation()
      drawFrame()
      return true
    }

    function softDrop() {
      if (!canPlay() || !state.current) return false
      const candidate = {
        type: state.current.type,
        rot: state.current.rot,
        x: state.current.x,
        y: state.current.y + 1,
      }
      if (collides(state.board, candidate)) {
        if (!state.resting) {
          state.resting = true
          state.lockAccum = 0
        }
        return false
      }
      state.current.y += 1
      state.score += SOFT_DROP_POINTS
      state.dropAccum = 0
      settleAfterManipulation()
      emit()
      drawFrame()
      return true
    }

    function rotate(direction) {
      if (!canPlay() || !state.current) return false
      const rotated = rotatePiece(state.board, state.current, direction)
      if (!rotated) return false
      state.current = rotated
      settleAfterManipulation()
      drawFrame()
      return true
    }

    function hardDrop() {
      if (!canPlay() || !state.current) return false
      let distance = 0
      while (canMove(state.board, state.current, 0, 1)) {
        state.current.y += 1
        distance += 1
      }
      state.score += distance * HARD_DROP_POINTS
      state.dropAccum = 0
      lockAndAdvance()
      return true
    }

    function swapHold() {
      if (!canPlay() || !state.current || !state.canHold) return false
      if (!holdPiece(state, random)) return false
      state.resting = false
      state.lockAccum = 0
      state.lockResets = 0
      state.dropAccum = 0
      if (!state.over && state.current && !canMove(state.board, state.current, 0, 1)) {
        state.resting = true
      }
      persist()
      emit()
      drawFrame()
      if (state.over) stopLoop()
      return true
    }

    function newGame() {
      if (!alive || failure) return false
      state = freshState(random)
      paused = false
      pauseReason = null
      lastTs = clock()
      lastEmitSec = -1
      persistAccum = 0
      themeAccum = 0
      persist()
      emit()
      drawFrame()
      startLoop()
      focusCanvas()
      return true
    }

    function focusCanvas() {
      try {
        canvas.focus({ preventScroll: true })
      } catch (error) {
        try {
          canvas.focus()
        } catch (focusError) {
          // Focus is best-effort.
        }
      }
    }

    function resize() {
      if (!alive) return
      const rect = typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null
      const width = Math.max(0, Math.floor((rect && rect.width) || 0))
      const height = Math.max(0, Math.floor((rect && rect.height) || 0))
      const dpr = Math.max(1, view.devicePixelRatio || 1)
      size = { width, height, dpr }
      const pixelWidth = Math.max(1, Math.floor(width * dpr))
      const pixelHeight = Math.max(1, Math.floor(height * dpr))
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight
      theme = readTheme(host, view)
      drawFrame()
    }

    function onKeyDownRaw(event) {
      if (!alive || failure) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const key = typeof event.key === 'string' ? event.key : ''
      const code = typeof event.code === 'string' ? event.code : ''
      const lower = key.toLowerCase()
      const repeat = event.repeat === true
      function prevent() {
        if (typeof event.preventDefault === 'function') event.preventDefault()
      }

      if (lower === 'arrowleft') {
        prevent()
        moveHorizontal(-1)
        return
      }
      if (lower === 'arrowright') {
        prevent()
        moveHorizontal(1)
        return
      }
      if (lower === 'arrowdown') {
        prevent()
        softDrop()
        return
      }
      if (lower === 'arrowup' || lower === 'x') {
        prevent()
        if (!repeat) rotate(1)
        return
      }
      if (lower === 'z') {
        prevent()
        if (!repeat) rotate(-1)
        return
      }
      if (lower === 'c' || key === 'Shift') {
        if (!repeat) swapHold()
        return
      }
      if (key === ' ' || key === 'Spacebar' || code === 'Space') {
        prevent()
        if (!repeat) hardDrop()
        return
      }
      if (lower === 'p') {
        if (!repeat) togglePause()
        return
      }
      if (lower === 'r') {
        if (!repeat) newGame()
      }
    }

    function onPointerDown(event) {
      if (!alive) return
      if (event && event.button !== undefined && event.button !== 0) return
      focusCanvas()
    }

    function onCanvasFocus() {
      focused = true
      emit()
    }

    function onCanvasBlur() {
      focused = false
      emit()
    }

    function onVisibilityChange() {
      if (!alive) return
      if (doc.hidden === true) {
        if (!paused && !state.over) pauseGame('hidden')
        else stopLoop()
        return
      }
      if (paused && (pauseReason === 'hidden' || pauseReason === 'blur')) {
        resumeGame()
        focusCanvas()
        return
      }
      if (!paused && !state.over) {
        lastTs = clock()
        startLoop()
      }
      drawFrame()
    }

    function onWindowBlur() {
      if (!alive || doc.hidden === true) return
      if (!paused && !state.over) pauseGame('blur')
    }

    function onWindowFocus() {
      if (!alive || doc.hidden === true) return
      if (paused && pauseReason === 'blur') {
        resumeGame()
        focusCanvas()
      }
    }

    function onWindowResize() {
      if (!alive) return
      try {
        resize()
      } catch (error) {
        fail(error)
      }
    }

    /**
     * Contract v1 §8: every event handler is wrapped so a render/persist error
     * becomes the in-game 「重试」 overlay instead of an uncaught listener error.
     */
    function safely(handler) {
      return function safeHandler(event) {
        if (!alive) return
        try {
          handler(event)
        } catch (error) {
          fail(error)
        }
      }
    }

    const handleVisibilityChange = safely(onVisibilityChange)
    const handleWindowResize = safely(onWindowResize)
    const handleWindowBlur = safely(onWindowBlur)
    const handleWindowFocus = safely(onWindowFocus)
    const onKeyDown = safely(onKeyDownRaw)
    const handlePointerDown = safely(onPointerDown)
    const handleCanvasFocus = safely(onCanvasFocus)
    const handleCanvasBlur = safely(onCanvasBlur)

    let resizeObserver = null
    const ResizeObserverCtor = view.ResizeObserver
    if (typeof ResizeObserverCtor === 'function') {
      resizeObserver = new ResizeObserverCtor(function () {
        try {
          resize()
        } catch (error) {
          fail(error)
        }
      })
      resizeObserver.observe(host)
    }

    doc.addEventListener('visibilitychange', handleVisibilityChange)
    view.addEventListener('resize', handleWindowResize)
    view.addEventListener('blur', handleWindowBlur)
    view.addEventListener('focus', handleWindowFocus)
    canvas.addEventListener('keydown', onKeyDown)
    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('focus', handleCanvasFocus)
    canvas.addEventListener('blur', handleCanvasBlur)
    host.appendChild(canvas)

    try {
      resize()
      // Restored user pause: draw the frozen board and wait for P / 继续.
      if (paused) drawFrame()
      persist()
      emit()
      focusCanvas()
      startLoop()
    } catch (error) {
      try {
        teardown()
      } catch (teardownError) {
        // ignore
      }
      throw error
    }

    function teardown() {
      if (!alive) return
      alive = false
      stopLoop()
      try {
        persist()
      } catch (error) {
        // ignore
      }
      try {
        if (resizeObserver) resizeObserver.disconnect()
      } catch (error) {
        // ignore
      }
      try {
        doc.removeEventListener('visibilitychange', handleVisibilityChange)
      } catch (error) {
        // ignore
      }
      try {
        view.removeEventListener('resize', handleWindowResize)
        view.removeEventListener('blur', handleWindowBlur)
        view.removeEventListener('focus', handleWindowFocus)
      } catch (error) {
        // ignore
      }
      try {
        canvas.removeEventListener('keydown', onKeyDown)
        canvas.removeEventListener('pointerdown', handlePointerDown)
        canvas.removeEventListener('focus', handleCanvasFocus)
        canvas.removeEventListener('blur', handleCanvasBlur)
      } catch (error) {
        // ignore
      }
      try {
        canvas.remove()
      } catch (error) {
        // ignore
      }
    }

    return {
      newGame,
      togglePause,
      pause: function () {
        return pauseGame('user')
      },
      resume: resumeGame,
      focus: focusCanvas,
      destroy: teardown,
      getState: function () {
        return snapshot()
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Test seam: only active when a test harness opts in before importing this file
  // ---------------------------------------------------------------------------

  if (window.__DSH_GAME_TETRIS_TEST__ === true) {
    try {
      Object.defineProperty(window, '__DSH_GAME_TETRIS__', {
        configurable: true,
        value: {
          GAME_ID,
          STORE_KEY,
          SCHEMA_VERSION,
          COLS,
          ROWS,
          HIDDEN_ROWS,
          VISIBLE_ROWS,
          PIECE_TYPES,
          TYPE_CODE,
          CODE_TYPE,
          QUEUE_SHOWN,
          SPAWN_ROW,
          LINES_PER_LEVEL,
          CLEAR_POINTS,
          SOFT_DROP_POINTS,
          HARD_DROP_POINTS,
          LOCK_DELAY_MS,
          MAX_LOCK_RESETS,
          MIN_STAGE_W,
          MIN_STAGE_H,
          PIECES,
          createEmptyBoard,
          makeSpawnPiece,
          freshState,
          fillQueue,
          takeNext,
          spawnNext,
          collides,
          canMove,
          ghostRow,
          rotatePiece,
          lockCurrent,
          clearFullLines,
          holdPiece,
          dropIntervalMs,
          computeLayout,
          serializeState,
          sanitizeState,
          hydrateState,
          createGame,
          formatTime,
        },
      })
    } catch (error) {
      // A test seam failure must never affect the game itself.
    }
  }

  // ---------------------------------------------------------------------------
  // React wrapper + slot registration
  // ---------------------------------------------------------------------------

  window.__ModuleLoader__.load({
    id: '@local/dsh-game-tetris',
    factory(require) {
      const React = require('react')
      const h = React.createElement

      const UI = {
        root: {
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '10px 12px 12px',
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
        },
        toolbar: {
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          paddingBottom: 8,
        },
        titleBlock: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
        title: { fontSize: 20, fontWeight: 600, lineHeight: '1.1', letterSpacing: '0.02em' },
        hint: {
          fontSize: 11,
          lineHeight: '15px',
          color: 'var(--dsw-alias-label-tertiary)',
          maxWidth: 520,
        },
        spacer: { flex: 1, minWidth: 0 },
        stats: { display: 'flex', gap: 8, flexWrap: 'wrap' },
        stat: {
          minWidth: 56,
          padding: '3px 10px',
          textAlign: 'center',
          borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
        },
        statLabel: {
          fontSize: 10,
          lineHeight: '14px',
          letterSpacing: '0.04em',
          color: 'var(--dsw-alias-label-tertiary)',
        },
        statValue: {
          fontSize: 16,
          lineHeight: '20px',
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
        },
        actions: { display: 'flex', gap: 8 },
        button: {
          border: '0.5px solid var(--dsw-alias-border-l1)',
          borderRadius: 8,
          background: 'var(--dsw-alias-interactive-bg-hover)',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'inherit',
          fontSize: 13,
          lineHeight: '18px',
          padding: '6px 12px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
        buttonDisabled: { opacity: 0.45, cursor: 'default' },
        // 「规则」弹窗：与同系列其它游戏保持同一套几何与 token。
        rulesMask: {
          position: 'absolute',
          inset: 0,
          zIndex: 20,
          padding: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45))',
        },
        rulesCard: {
          width: 'min(560px, 100%)',
          maxHeight: '86%',
          overflow: 'auto',
          borderRadius: 14,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          boxShadow: 'var(--dsw-elevation-panel, 0 12px 40px rgba(0,0,0,0.3))',
          outline: 'none',
        },
        rulesHead: {
          position: 'sticky',
          top: 0,
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '13px 18px',
          background: 'var(--dsw-alias-bg-layer-2)',
          borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
        },
        rulesTitle: { flex: 1, fontSize: 15, fontWeight: 600 },
        rulesClose: {
          border: 0,
          background: 'transparent',
          color: 'var(--dsw-alias-label-tertiary)',
          cursor: 'pointer',
          fontSize: 22,
          lineHeight: 1,
          padding: '0 4px',
          borderRadius: 6,
          fontFamily: 'inherit',
        },
        rulesBody: { padding: '2px 18px 20px' },
        rulesH3: {
          fontSize: 12.5,
          letterSpacing: '0.04em',
          color: 'var(--dsw-alias-label-primary)',
          margin: '20px 0 8px',
          paddingBottom: 6,
          borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
        },
        rulesUl: { margin: '8px 0', paddingLeft: 19 },
        rulesLi: {
          fontSize: 13,
          lineHeight: '21px',
          color: 'var(--dsw-alias-label-secondary)',
          margin: '6px 0',
        },
        rulesTip: {
          fontSize: 12.5,
          lineHeight: '19px',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'var(--dsw-alias-interactive-bg-hover)',
          borderLeft: '2px solid var(--dsw-alias-brand-primary, #2f81f7)',
          borderRadius: '0 7px 7px 0',
          padding: '9px 12px',
          margin: '10px 0',
        },
        stage: { position: 'relative', flex: 1, minHeight: 0, borderRadius: 10, overflow: 'hidden' },
        host: { position: 'absolute', inset: 0, outline: 'none' },
        focusHint: {
          position: 'absolute',
          top: 10,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '5px 10px',
          borderRadius: 8,
          fontSize: 12,
          lineHeight: '17px',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        },
        overlay: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.42))',
        },
        panel: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          maxWidth: 340,
          padding: '20px 24px',
          textAlign: 'center',
          borderRadius: 12,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          boxShadow: 'var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.18))',
        },
        panelTitle: { fontSize: 18, fontWeight: 600 },
        panelSub: { fontSize: 13, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' },
        panelActions: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
        buttonSecondary: {
          border: '0.5px solid var(--dsw-alias-border-l1)',
          borderRadius: 8,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          fontFamily: 'inherit',
          fontSize: 13,
          lineHeight: '18px',
          padding: '6px 12px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
        crash: {
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          textAlign: 'center',
          fontSize: 13,
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-secondary)',
        },
      }

      const STYLE_TEXT = [
        '.dshtetris-btn{transition:background-color .12s ease,opacity .12s ease}',
        '.dshtetris-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)!important}',
        '.dshtetris-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      ].join('\n')

      function StatBox(props) {
        return h(
          'div',
          { style: UI.stat },
          h('div', { style: UI.statLabel }, props.label),
          h('div', { style: UI.statValue }, String(props.value)),
        )
      }

      function Overlay(props) {
        return h(
          'div',
          { style: UI.overlay, role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { style: UI.panel },
            h('div', { style: UI.panelTitle }, props.title),
            props.subtitle ? h('div', { style: UI.panelSub }, props.subtitle) : null,
            h(
              'div',
              { style: UI.panelActions },
              (props.actions || []).map(function (action, index) {
                return h(
                  'button',
                  {
                    key: action.label + '-' + index,
                    type: 'button',
                    className: 'dshtetris-btn',
                    style: action.secondary ? UI.buttonSecondary : UI.button,
                    onClick: action.onClick,
                  },
                  action.label,
                )
              }),
            ),
          ),
        )
      }

      // Stable identity so React does not detach/re-attach the ref every render.
      function focusCard(node) {
        if (node) node.focus()
      }

      function RulesModal(props) {
        function li(key, children) {
          return h('li', { key: key, style: UI.rulesLi }, children)
        }
        function b(key, text) {
          return h('b', { key: key }, text)
        }
        return h(
          'div',
          {
            style: UI.rulesMask,
            onMouseDown: function (event) {
              if (event.target === event.currentTarget) props.onClose()
            },
          },
          h(
            'div',
            {
              ref: focusCard,
              tabIndex: -1,
              style: UI.rulesCard,
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': '俄罗斯方块规则',
              onKeyDown: function (event) {
                // Modal: swallow every key so the board behind does not react.
                event.stopPropagation()
                if (event.key === 'Escape') props.onClose()
              },
            },
            h(
              'div',
              { style: UI.rulesHead },
              h('div', { style: UI.rulesTitle }, '俄罗斯方块 · 规则与操作'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshtetris-btn',
                  style: UI.rulesClose,
                  onClick: props.onClose,
                  'aria-label': '关闭',
                },
                '×',
              ),
            ),
            h(
              'div',
              { style: UI.rulesBody },
              h('h3', { style: UI.rulesH3 }, '一、目标'),
              h(
                'ul',
                { style: UI.rulesUl },
                li('a1', ['棋盘 ', b('a1a', '10 列 × 20 行'), '（上方另有 2 行隐藏出生区）。方块从顶部落下，堆满一整行就消掉。']),
                li('a2', ['新方块出生位置被占住时，游戏结束。']),
                li('a3', ['棋盘上的半透明方块是', b('a3a', '幽灵落点'), '，显示这一块会落在哪。']),
              ),
              h('h3', { style: UI.rulesH3 }, '二、方块与随机'),
              h(
                'ul',
                { style: UI.rulesUl },
                li('b1', ['7 种方块 I、O、T、S、Z、J、L，各 4 个旋转态。']),
                li('b2', [b('b2a', '7-bag 随机'), '：7 种各发一次、洗牌发完再洗下一袋，不会长时间等不到某一种。']),
                li('b3', ['右侧 HOLD 槽可暂存一块，NEXT 显示接下来 5 块。']),
                li('b4', ['每个方块', b('b4a', '只能暂存一次'), '：暂存后要等下一块落下才能再存。']),
              ),
              h('h3', { style: UI.rulesH3 }, '三、按键'),
              h(
                'ul',
                { style: UI.rulesUl },
                li('c1', ['← / → 左右移动；↓ 软降，每格 +1 分。']),
                li('c2', ['↑ 或 X 顺时针旋转，Z 逆时针旋转。旋转有墙踢：依次尝试原地、左右 1 列、左右 2 列、上移 1 行。']),
                li('c3', ['空格硬降：直接落底并锁定，每格 +2 分。']),
                li('c4', ['C 或 Shift 暂存 / 换回；P 暂停 / 继续；R 重开一局。']),
                li('c5', ['键盘要先点一下棋盘才生效（画面上会提示「点击棋盘以启用键盘」）。']),
              ),
              h('h3', { style: UI.rulesH3 }, '四、计分与速度'),
              h(
                'ul',
                { style: UI.rulesUl },
                li('d1', ['一次消 1 / 2 / 3 / 4 行 = ', b('d1a', '100 / 300 / 500 / 800'), ' × 当前等级。']),
                li('d2', ['每消 10 行升 1 级，下落间隔 = max(80, 800 − (等级−1)×60) 毫秒，越往后越快。']),
                li('d3', ['方块落地后有 ', b('d3a', '400ms 锁定延迟'), '；期间移动或旋转会重置计时，最多重置 15 次。']),
                li('d4', ['切到后台会自动暂停，回来后继续，用时按实际游戏时间计。']),
              ),
              h(
                'div',
                { style: UI.rulesTip },
                '四行一起消（Tetris）拿 800 分，比零散消行划算得多。所以在边上留一条竖井给 I 块，是俄罗斯方块最经典的基本功。',
              ),
            ),
          ),
        )
      }

      const INITIAL_SNAPSHOT = {
        score: 0,
        lines: 0,
        level: 1,
        elapsedMs: 0,
        paused: false,
        over: false,
        focused: false,
        canHold: true,
        hold: null,
        next: [],
        current: null,
      }

      function Game(props) {
        const rootRef = React.useRef(null)
        const hostRef = React.useRef(null)
        const gameRef = React.useRef(null)
        const [snapshot, setSnapshot] = React.useState(INITIAL_SNAPSHOT)
        const [error, setError] = React.useState(null)
        const [rulesOpen, setRulesOpen] = React.useState(false)
        const [attempt, setAttempt] = React.useState(0)

        React.useEffect(() => {
          const host = hostRef.current
          if (!host) return undefined
          let game = null
          try {
            game = createGame(host, {
              onState: function (next) {
                setSnapshot(next)
                setError(null)
              },
              onError: function (message) {
                setError(message)
              },
            })
            gameRef.current = game
          } catch (createError) {
            console.error('[dsh-game-tetris] failed to start', createError)
            setError('游戏启动失败，点「重试」重新开始。')
            return undefined
          }
          return function cleanup() {
            gameRef.current = null
            try {
              game.destroy()
            } catch (destroyError) {
              console.error('[dsh-game-tetris] cleanup failed', destroyError)
            }
          }
        }, [attempt])

        const act = React.useCallback(function (run) {
          const game = gameRef.current
          if (!game) return
          try {
            run(game)
          } finally {
            // Buttons steal DOM focus; hand the keyboard back to the canvas.
            try {
              game.focus()
            } catch (focusError) {
              // ignore
            }
          }
        }, [])

        const togglePause = React.useCallback(function () {
          act(function (game) {
            game.togglePause()
          })
        }, [act])

        const restart = React.useCallback(function () {
          act(function (game) {
            game.newGame()
          })
        }, [act])

        const resume = React.useCallback(function () {
          act(function (game) {
            game.resume()
          })
        }, [act])

        const retry = React.useCallback(function () {
          setError(null)
          setAttempt(function (value) {
            return value + 1
          })
        }, [])

        let overlay = null
        if (error) {
          overlay = h(Overlay, {
            title: '游戏出错了',
            subtitle: error,
            actions: [{ label: '重试', onClick: retry }],
          })
        } else if (snapshot.over) {
          overlay = h(Overlay, {
            title: '游戏结束',
            subtitle:
              '得分 ' +
              snapshot.score +
              ' · 消除 ' +
              snapshot.lines +
              ' 行 · 等级 ' +
              snapshot.level,
            actions: [{ label: '再来一局', onClick: restart }],
          })
        } else if (snapshot.paused) {
          overlay = h(Overlay, {
            title: '已暂停',
            subtitle: '按 P 或点「继续」回到游戏',
            actions: [
              { label: '继续', onClick: resume },
              { label: '重新开始', onClick: restart, secondary: true },
            ],
          })
        }

        return h(
          'div',
          { ref: rootRef, style: UI.root, 'data-dsh-game': GAME_ID },
          h('style', null, STYLE_TEXT),
          h(
            'div',
            { style: UI.toolbar },
            h(
              'div',
              { style: UI.titleBlock },
              h('div', { style: UI.title }, '俄罗斯方块'),
              h(
                'div',
                { style: UI.hint },
                '← → 移动 · ↓ 软降 · ↑ / X 顺时针 · Z 逆时针 · 空格 硬降 · C / Shift 暂存 · P 暂停 · R 重开',
              ),
            ),
            h('div', { style: UI.spacer }),
            h(
              'div',
              { style: UI.stats },
              h(StatBox, { label: '分数', value: snapshot.score }),
              h(StatBox, { label: '消除', value: snapshot.lines }),
              h(StatBox, { label: '等级', value: snapshot.level }),
              h(StatBox, { label: '用时', value: formatTime(snapshot.elapsedMs) }),
            ),
            h(
              'div',
              { style: UI.actions },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshtetris-btn',
                  style: UI.button,
                  onClick: function () {
                    setRulesOpen(true)
                  },
                  'aria-haspopup': 'dialog',
                },
                '📖 规则',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshtetris-btn',
                  style: snapshot.over || error ? Object.assign({}, UI.button, UI.buttonDisabled) : UI.button,
                  disabled: snapshot.over || Boolean(error),
                  onClick: togglePause,
                },
                snapshot.paused ? '继续' : '暂停',
              ),
              h(
                'button',
                { type: 'button', className: 'dshtetris-btn', style: UI.button, onClick: restart },
                '重开',
              ),
            ),
          ),
          h(
            'div',
            { style: UI.stage },
            h('div', { ref: hostRef, style: UI.host }),
            snapshot.focused || snapshot.paused || snapshot.over || error
              ? null
              : h('div', { style: UI.focusHint }, '点击棋盘以启用键盘'),
            overlay,
            rulesOpen
              ? h(RulesModal, {
                  onClose: function () {
                    setRulesOpen(false)
                  },
                })
              : null,
          ),
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
          console.error('[dsh-game-tetris] component crashed', error, info)
        }

        render() {
          if (this.state.failed) {
            return h('div', { style: UI.crash }, '俄罗斯方块加载失败，请切走再重新进入「游戏」页。')
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
                    label: function () {
                      return '俄罗斯方块'
                    },
                    select: function (ownerProps) {
                      return ownerProps && ownerProps.gameId === GAME_ID ? MATCHED : null
                    },
                  },
                  GameEntry,
                )
              } catch (error) {
                console.error('[dsh-game-tetris] slot registration failed', error)
                return function () {}
              }
            })
          } catch (error) {
            console.error('[dsh-game-tetris] slot inject failed', error)
          }
        },
      }
    },
  })
})()
