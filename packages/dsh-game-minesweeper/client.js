/**
 * @local/dsh-game-minesweeper — browser half.
 *
 * Registers a Minesweeper game into the host's `game.stage` chain slot
 * (contract v1):
 *   - `select({ gameId })` returns the frozen `MATCHED` object only when the
 *     host selected `minesweeper`, otherwise `null`
 *   - the component only relies on the `matched` prop, never on host internals
 *
 * Why everything lives in this one file: `client.js` is the only browser entry
 * the module loader serves. The loader's `require` resolves entries from the
 * module table (react, ...) and cannot load package-relative modules
 * synchronously, so a separate `game.js` would be unreachable in the browser.
 * Pure logic is therefore defined first in this file and is exposed on
 * `window.__DSH_GAME_MINESWEEPER__` only when
 * `window.__DSH_GAME_MINESWEEPER_TEST__ === true`, which lets `dev/` node tests
 * exercise it without a host.
 *
 * Save key: localStorage['dsh.game.minesweeper.v1'] (schemaVersion: 1).
 * The 2048 save key (`dsh.game.2048.v1`) is never read or written here.
 */
;(function () {
  'use strict'

  const GAME_ID = 'minesweeper'
  const STORE_KEY = 'dsh.game.' + GAME_ID + '.v1'
  const SCHEMA_VERSION = 1
  const MIN_WIDTH = 320
  const MIN_HEIGHT = 240
  const MAX_LOG_MS = 7 * 24 * 60 * 60 * 1000

  /**
   * Three classic presets. `rows` is the shorter side for the expert board so
   * that a wide 30x16 grid fits a typical 16:9 stage without scrolling.
   */
  const LEVELS = {
    beginner: { rows: 9, cols: 9, mines: 10, label: '初级' },
    intermediate: { rows: 16, cols: 16, mines: 40, label: '中级' },
    expert: { rows: 16, cols: 30, mines: 99, label: '高级' },
  }
  const LEVEL_IDS = ['beginner', 'intermediate', 'expert']

  // ---------------------------------------------------------------------------
  // Pure game logic (no DOM, no React, unit-testable under node)
  // ---------------------------------------------------------------------------

  function levelConfig(difficulty) {
    const config = LEVELS[difficulty]
    if (!config) return null
    return {
      difficulty,
      rows: config.rows,
      cols: config.cols,
      mines: config.mines,
      label: config.label,
    }
  }

  function randomUnit(random) {
    let value = typeof random === 'function' ? random() : Math.random()
    if (typeof value !== 'number' || !Number.isFinite(value)) value = 0
    if (value < 0) value = 0
    if (value >= 1) value = 0.999999999
    return value
  }

  /** All board indices around `index` (8 for a centre cell, 3 for a corner). */
  function neighborIndices(rows, cols, index) {
    const result = []
    if (!Number.isInteger(index) || index < 0 || index >= rows * cols) return result
    const row = Math.floor(index / cols)
    const col = index % cols
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) continue
        const r = row + dr
        const c = col + dc
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue
        result.push(r * cols + c)
      }
    }
    return result
  }

  /** Number of mines around every cell. */
  function computeAdjacent(rows, cols, mine) {
    const total = rows * cols
    const adjacent = new Array(total).fill(0)
    for (let index = 0; index < total; index += 1) {
      if (mine[index]) continue
      const neighbors = neighborIndices(rows, cols, index)
      let count = 0
      for (let i = 0; i < neighbors.length; i += 1) {
        if (mine[neighbors[i]]) count += 1
      }
      adjacent[index] = count
    }
    return adjacent
  }

  /**
   * Place exactly `mines` mines. The clicked cell and (when there is room) its
   * eight neighbours are excluded, which is the classic "first click is always
   * safe and opens an area" behaviour.
   */
  function generateMines(rows, cols, mines, safeIndex, random) {
    const total = rows * cols
    const rng = typeof random === 'function' ? random : Math.random
    const excluded = new Set()
    if (Number.isInteger(safeIndex) && safeIndex >= 0 && safeIndex < total) {
      excluded.add(safeIndex)
      const neighbors = neighborIndices(rows, cols, safeIndex)
      for (let i = 0; i < neighbors.length; i += 1) excluded.add(neighbors[i])
    }
    let candidates = []
    for (let index = 0; index < total; index += 1) {
      if (!excluded.has(index)) candidates.push(index)
    }
    // Tiny boards may not have room for a full safe ring; fall back to keeping
    // only the clicked cell safe.
    if (candidates.length < mines) {
      candidates = []
      for (let index = 0; index < total; index += 1) {
        if (index !== safeIndex) candidates.push(index)
      }
    }
    const count = Math.min(mines, candidates.length)
    for (let i = 0; i < count; i += 1) {
      const span = candidates.length - i
      const pick = i + Math.min(span - 1, Math.floor(randomUnit(rng) * span))
      const swap = candidates[i]
      candidates[i] = candidates[pick]
      candidates[pick] = swap
    }
    const mine = new Array(total).fill(0)
    for (let i = 0; i < count; i += 1) mine[candidates[i]] = 1
    return mine
  }

  /** All-empty best-time map (milliseconds, null = never won). */
  function emptyBestMap() {
    return { beginner: null, intermediate: null, expert: null }
  }

  function normalizeBestMap(input) {
    const result = emptyBestMap()
    if (!input || typeof input !== 'object') return result
    for (let i = 0; i < LEVEL_IDS.length; i += 1) {
      const id = LEVEL_IDS[i]
      const value = input[id]
      if (Number.isInteger(value) && value >= 0 && value <= MAX_LOG_MS) result[id] = value
    }
    return result
  }

  /** A brand-new board, before the first reveal (mines are placed later). */
  function freshState(difficulty, best) {
    const config = levelConfig(difficulty) || levelConfig('beginner')
    const total = config.rows * config.cols
    return {
      difficulty: config.difficulty,
      rows: config.rows,
      cols: config.cols,
      mines: config.mines,
      mine: new Array(total).fill(0),
      adjacent: new Array(total).fill(0),
      revealed: new Array(total).fill(0),
      flagged: new Array(total).fill(0),
      started: false,
      status: 'ready',
      exploded: -1,
      elapsedMs: 0,
      best: normalizeBestMap(best),
    }
  }

  function countFlagged(state) {
    let count = 0
    for (let index = 0; index < state.flagged.length; index += 1) {
      if (state.flagged[index]) count += 1
    }
    return count
  }

  function countRevealed(state) {
    let count = 0
    for (let index = 0; index < state.revealed.length; index += 1) {
      if (state.revealed[index]) count += 1
    }
    return count
  }

  function safeCellTotal(state) {
    return state.rows * state.cols - state.mines
  }

  function isWon(state) {
    return state.started && state.status !== 'lost' && countRevealed(state) === safeCellTotal(state)
  }

  /** Place mines on the first reveal, keeping the clicked cell and ring safe. */
  function ensureMines(state, safeIndex, random) {
    if (state.started) return
    state.mine = generateMines(state.rows, state.cols, state.mines, safeIndex, random)
    state.adjacent = computeAdjacent(state.rows, state.cols, state.mine)
    state.started = true
    state.status = 'playing'
  }

  function winGame(state) {
    state.status = 'won'
    for (let index = 0; index < state.mine.length; index += 1) {
      if (state.mine[index]) state.flagged[index] = 1
    }
    return true
  }

  function checkWin(state) {
    if (state.status === 'playing' && isWon(state)) return winGame(state)
    return false
  }

  /** Reveal one cell, flood-filling empty regions. Mutates `state`. */
  function revealAt(state, index, random) {
    if (!state || !Number.isInteger(index) || index < 0 || index >= state.rows * state.cols) return false
    if (state.status !== 'ready' && state.status !== 'playing') return false
    if (state.flagged[index] || state.revealed[index]) return false
    if (!state.started) ensureMines(state, index, random)
    if (state.mine[index]) {
      state.exploded = index
      state.status = 'lost'
      return true
    }
    const total = state.rows * state.cols
    const stack = [index]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current < 0 || current >= total) continue
      if (state.revealed[current] || state.flagged[current] || state.mine[current]) continue
      state.revealed[current] = 1
      if (state.adjacent[current] !== 0) continue
      const neighbors = neighborIndices(state.rows, state.cols, current)
      for (let i = 0; i < neighbors.length; i += 1) {
        const next = neighbors[i]
        if (!state.revealed[next] && !state.flagged[next] && !state.mine[next]) stack.push(next)
      }
    }
    checkWin(state)
    return true
  }

  /** Toggle a flag. Flags are allowed before the first reveal and while playing. */
  function toggleFlag(state, index) {
    if (!state || !Number.isInteger(index) || index < 0 || index >= state.rows * state.cols) return false
    if (state.status !== 'ready' && state.status !== 'playing') return false
    if (state.revealed[index]) return false
    state.flagged[index] = state.flagged[index] ? 0 : 1
    return true
  }

  /**
   * Chord / quick-open: on a revealed number whose neighbouring flag count
   * matches the number, reveal every other neighbour. Mutates `state`.
   */
  function chordAt(state, index, random) {
    if (!state || !Number.isInteger(index) || index < 0 || index >= state.rows * state.cols) return false
    if (state.status !== 'playing' || !state.revealed[index]) return false
    const need = state.adjacent[index]
    if (!need || need <= 0) return false
    const neighbors = neighborIndices(state.rows, state.cols, index)
    let flags = 0
    for (let i = 0; i < neighbors.length; i += 1) {
      if (state.flagged[neighbors[i]]) flags += 1
    }
    if (flags !== need) return false
    let opened = false
    for (let i = 0; i < neighbors.length; i += 1) {
      if (state.status === 'won' || state.status === 'lost') break
      const neighbor = neighbors[i]
      if (state.flagged[neighbor] || state.revealed[neighbor]) continue
      if (revealAt(state, neighbor, random)) opened = true
    }
    return opened
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  function sanitizeBinaryArray(input, length) {
    if (!Array.isArray(input) || input.length !== length) return null
    const result = new Array(length)
    for (let index = 0; index < length; index += 1) {
      const value = input[index]
      if (value === 1 || value === true) result[index] = 1
      else if (value === 0 || value === false) result[index] = 0
      else return null
    }
    return result
  }

  /**
   * Validate a persisted snapshot. Returns null (start a new game) for any
   * shape/version/consistency mismatch instead of throwing.
   *
   * `adjacent` is derived from `mine`, and the board size comes from the
   * difficulty preset, so tampered/duplicated size fields cannot desync it.
   */
  function sanitizeState(input) {
    try {
      if (!input || typeof input !== 'object') return null
      if (input.schemaVersion !== SCHEMA_VERSION) return null
      const config = levelConfig(input.difficulty)
      if (!config) return null
      const total = config.rows * config.cols
      const mine = sanitizeBinaryArray(input.mine, total)
      if (!mine) return null
      const revealed = sanitizeBinaryArray(input.revealed, total)
      if (!revealed) return null
      const flagged = sanitizeBinaryArray(input.flagged, total)
      if (!flagged) return null

      const started = input.started === true
      const rawStatus = input.status
      if (
        rawStatus !== 'ready' &&
        rawStatus !== 'playing' &&
        rawStatus !== 'won' &&
        rawStatus !== 'lost'
      ) {
        return null
      }
      if (rawStatus === 'ready') {
        if (started) return null
      } else if (!started) {
        return null
      }

      let mineCount = 0
      let safeRevealed = 0
      for (let index = 0; index < total; index += 1) {
        if (mine[index]) {
          mineCount += 1
        } else if (revealed[index]) {
          safeRevealed += 1
        }
      }
      const safeTotal = total - config.mines
      if (!started) {
        if (mineCount !== 0 || safeRevealed !== 0) return null
      } else if (mineCount !== config.mines) {
        return null
      }
      for (let index = 0; index < total; index += 1) {
        if (revealed[index] && mine[index]) return null
        if (flagged[index] && revealed[index]) return null
      }

      let exploded = -1
      if (input.exploded !== undefined && input.exploded !== null && input.exploded !== -1) {
        if (!Number.isInteger(input.exploded) || input.exploded < 0 || input.exploded >= total) return null
        if (!mine[input.exploded]) return null
        exploded = input.exploded
      }
      if (rawStatus === 'lost') {
        if (exploded < 0) return null
      } else if (exploded !== -1) {
        return null
      }

      let status = rawStatus
      if (status === 'won' && safeRevealed !== safeTotal) return null
      if (status === 'lost' && safeRevealed === safeTotal) return null
      if (status === 'playing' && safeRevealed === safeTotal) {
        // A save taken between "all safe cells revealed" and the win flag is
        // repaired instead of thrown away.
        status = 'won'
      }
      if (status === 'won') {
        // A won board always shows every mine as a flag, even if the save was
        // written mid-transition (or hand-edited).
        for (let index = 0; index < total; index += 1) {
          if (mine[index]) flagged[index] = 1
        }
      }
      if (status === 'lost' && exploded >= 0) {
        // The exploded cell is drawn with the boom highlight; a flag on top of
        // it would hide the only visual explanation of the loss.
        flagged[exploded] = 0
      }

      const elapsedMs = input.elapsedMs
      if (!Number.isInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > MAX_LOG_MS) return null

      return {
        difficulty: config.difficulty,
        rows: config.rows,
        cols: config.cols,
        mines: config.mines,
        mine,
        adjacent: computeAdjacent(config.rows, config.cols, mine),
        revealed,
        flagged,
        started,
        status,
        exploded,
        elapsedMs,
        best: normalizeBestMap(input.best),
      }
    } catch (error) {
      return null
    }
  }

  function serializeState(state) {
    return {
      schemaVersion: SCHEMA_VERSION,
      difficulty: state.difficulty,
      rows: state.rows,
      cols: state.cols,
      mines: state.mines,
      mine: state.mine.slice(),
      revealed: state.revealed.slice(),
      flagged: state.flagged.slice(),
      started: state.started === true,
      status: state.status,
      exploded: state.exploded,
      elapsedMs: Math.max(0, Math.min(MAX_LOG_MS, Math.round(state.elapsedMs))),
      best: {
        beginner: state.best.beginner,
        intermediate: state.best.intermediate,
        expert: state.best.expert,
      },
    }
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

  function saveStateToStorage(state) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(serializeState(state)))
    } catch (error) {
      // Storage may be unavailable; gameplay keeps working in memory.
    }
  }

  // ---------------------------------------------------------------------------
  // Canvas colours / drawing helpers (opaque classic palette, readable on
  // both light and dark host themes)
  // ---------------------------------------------------------------------------

  const COLORS = {
    hidden: '#bdbdbd',
    hiddenHover: '#cdcdcd',
    edgeLight: '#e8e8e8',
    edgeDark: '#8f8f8f',
    revealed: '#e4e4e4',
    grid: '#c9c9c9',
    boom: '#d84315',
    flag: '#b71c1c',
    pole: '#3e2723',
    mine: '#263238',
    mineHighlight: 'rgba(255, 255, 255, 0.75)',
    wrong: '#b71c1c',
    // Contrast-checked against the opaque light cells: every digit and the
    // flag stay >= 3:1 (graphics) / digits >= 4.5:1 (text) in both themes,
    // because the canvas colours never depend on the host theme.
    number: ['', '#0b5fce', '#0f6b2f', '#b71c1c', '#2d2a8f', '#8a3b00', '#006354', '#222222', '#616161'],
  }
  const FONT_STACK = '"Segoe UI", system-ui, -apple-system, sans-serif'

  function computeLayout(width, height, rows, cols) {
    const inset = Math.max(4, Math.min(14, Math.min(width, height) * 0.02))
    const availWidth = Math.max(1, width - inset * 2)
    const availHeight = Math.max(1, height - inset * 2)
    const cell = Math.max(1, Math.floor(Math.min(availWidth / cols, availHeight / rows)))
    const boardWidth = cell * cols
    const boardHeight = cell * rows
    return {
      x: Math.floor((width - boardWidth) / 2),
      y: Math.floor((height - boardHeight) / 2),
      cell,
      rows,
      cols,
      boardWidth,
      boardHeight,
    }
  }

  function cellIndexAt(layout, x, y) {
    if (!layout) return -1
    const localX = x - layout.x
    const localY = y - layout.y
    if (localX < 0 || localY < 0 || localX >= layout.boardWidth || localY >= layout.boardHeight) {
      return -1
    }
    const col = Math.floor(localX / layout.cell)
    const row = Math.floor(localY / layout.cell)
    if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return -1
    return row * layout.cols + col
  }

  function drawHiddenCell(ctx, x, y, cell, hover) {
    ctx.fillStyle = hover ? COLORS.hiddenHover : COLORS.hidden
    ctx.fillRect(x, y, cell, cell)
    const bevel = Math.max(1, Math.floor(cell * 0.08))
    ctx.fillStyle = COLORS.edgeLight
    ctx.fillRect(x, y, cell, bevel)
    ctx.fillRect(x, y, bevel, cell)
    ctx.fillStyle = COLORS.edgeDark
    ctx.fillRect(x, y + cell - bevel, cell, bevel)
    ctx.fillRect(x + cell - bevel, y, bevel, cell)
  }

  function drawRevealedCell(ctx, x, y, cell, background) {
    ctx.fillStyle = background
    ctx.fillRect(x, y, cell, cell)
    if (cell >= 6) {
      ctx.fillStyle = COLORS.grid
      ctx.fillRect(x, y + cell - 1, cell, 1)
      ctx.fillRect(x + cell - 1, y, 1, cell)
    }
  }

  function drawNumber(ctx, x, y, cell, value) {
    const color = COLORS.number[value] || COLORS.number[8]
    if (!color) return
    ctx.fillStyle = color
    ctx.font = '700 ' + Math.max(7, Math.round(cell * 0.62)) + 'px ' + FONT_STACK
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(value), x + cell / 2, y + cell / 2 + cell * 0.04)
  }

  function drawFlag(ctx, x, y, cell) {
    const poleX = x + cell * 0.54
    const poleTop = y + cell * 0.2
    const poleBottom = y + cell * 0.8
    ctx.strokeStyle = COLORS.pole
    ctx.lineWidth = Math.max(1, cell * 0.07)
    ctx.beginPath()
    ctx.moveTo(poleX, poleBottom)
    ctx.lineTo(poleX, poleTop)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(poleX, poleTop)
    ctx.lineTo(poleX - cell * 0.36, poleTop + cell * 0.14)
    ctx.lineTo(poleX, poleTop + cell * 0.3)
    ctx.closePath()
    ctx.fillStyle = COLORS.flag
    ctx.fill()
    ctx.fillStyle = COLORS.pole
    ctx.fillRect(x + cell * 0.28, y + cell * 0.78, cell * 0.44, Math.max(1, cell * 0.07))
  }

  function drawMine(ctx, x, y, cell) {
    const centerX = x + cell / 2
    const centerY = y + cell / 2
    const radius = cell * 0.22
    const spike = cell * 0.36
    ctx.strokeStyle = COLORS.mine
    ctx.lineWidth = Math.max(1, cell * 0.07)
    for (let i = 0; i < 8; i += 1) {
      const angle = (i * Math.PI) / 4
      const inner = radius * 0.6
      ctx.beginPath()
      ctx.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner)
      ctx.lineTo(centerX + Math.cos(angle) * spike, centerY + Math.sin(angle) * spike)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
    ctx.fillStyle = COLORS.mine
    ctx.fill()
    ctx.beginPath()
    ctx.arc(centerX - radius * 0.32, centerY - radius * 0.32, radius * 0.3, 0, Math.PI * 2)
    ctx.fillStyle = COLORS.mineHighlight
    ctx.fill()
  }

  function drawWrongMark(ctx, x, y, cell) {
    ctx.strokeStyle = COLORS.wrong
    ctx.lineWidth = Math.max(1, cell * 0.1)
    ctx.beginPath()
    ctx.moveTo(x + cell * 0.22, y + cell * 0.22)
    ctx.lineTo(x + cell * 0.78, y + cell * 0.78)
    ctx.moveTo(x + cell * 0.78, y + cell * 0.22)
    ctx.lineTo(x + cell * 0.22, y + cell * 0.78)
    ctx.stroke()
  }

  function drawTooSmall(ctx, width, height) {
    ctx.fillStyle = '#8f8f8f'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '600 15px ' + FONT_STACK
    ctx.fillText('窗口太小', width / 2, height / 2 - 10)
    ctx.font = '13px ' + FONT_STACK
    ctx.fillText('请放大游戏区域', width / 2, height / 2 + 12)
  }

  // ---------------------------------------------------------------------------
  // Game instance: state + canvas + input + persistence + cleanup
  // ---------------------------------------------------------------------------

  function createGame(host, options) {
    if (!host) throw new Error('minesweeper: missing mount element')
    const opts = options || {}
    const random = typeof opts.random === 'function' ? opts.random : Math.random
    const onState = typeof opts.onState === 'function' ? opts.onState : null
    const onError = typeof opts.onError === 'function' ? opts.onError : null
    const doc = document
    const view = window

    const canvas = doc.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('minesweeper: 2d canvas context unavailable')
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'application')
    canvas.setAttribute('aria-label', '扫雷棋盘：左键翻开，右键插旗，双击数字快开')
    canvas.style.cssText =
      'display:block;width:100%;height:100%;outline:none;touch-action:none;-webkit-user-select:none;user-select:none;cursor:default'

    let state = loadSavedState() || freshState('beginner')
    let alive = true
    let failure = null
    let raf = 0
    let size = { width: 0, height: 0, dpr: 1 }
    let layout = null
    let hoverIndex = -1
    // Timer: committed milliseconds plus the wall-clock start of the current run.
    let runStart = null
    let runBase = 0
    let shownSecond = 0

    function clock() {
      const perf = view.performance
      return perf && typeof perf.now === 'function' ? perf.now() : Date.now()
    }

    function elapsedNow(now) {
      if (runStart === null) return state.elapsedMs
      const raw = runBase + Math.max(0, now - runStart)
      return Math.min(MAX_LOG_MS, Math.max(0, raw))
    }

    function startClock(now) {
      if (runStart !== null) return
      runBase = state.elapsedMs
      runStart = now
    }

    function commitElapsed(now) {
      if (runStart === null) return
      state.elapsedMs = Math.max(0, Math.min(MAX_LOG_MS, Math.round(runBase + Math.max(0, now - runStart))))
      runStart = null
    }

    function recordBest() {
      if (state.status !== 'won') return
      const elapsed = Math.max(0, Math.min(MAX_LOG_MS, Math.round(state.elapsedMs)))
      const best = state.best[state.difficulty]
      if (best === null || elapsed < best) state.best[state.difficulty] = elapsed
    }

    function snapshot() {
      const now = clock()
      const seconds = Math.floor(elapsedNow(now) / 1000)
      const flagged = countFlagged(state)
      return {
        difficulty: state.difficulty,
        status: state.status,
        rows: state.rows,
        cols: state.cols,
        mines: state.mines,
        flags: flagged,
        remaining: state.mines - flagged,
        elapsed: seconds,
        best: state.best[state.difficulty],
      }
    }

    function emit() {
      shownSecond = Math.floor(elapsedNow(clock()) / 1000)
      if (!onState) return
      try {
        onState(snapshot())
      } catch (error) {
        console.error('[dsh-game-minesweeper] state listener failed', error)
      }
    }

    function persist() {
      saveStateToStorage(state)
    }

    function fail(error) {
      if (!alive) return
      failure = '游戏遇到问题，点「重试」重新开始。'
      if (raf) {
        try {
          view.cancelAnimationFrame(raf)
        } catch (cancelError) {
          // ignore
        }
        raf = 0
      }
      if (runStart !== null) commitElapsed(clock())
      try {
        console.error('[dsh-game-minesweeper] runtime error', error)
      } catch (logError) {
        // ignore
      }
      if (onError) {
        try {
          onError(failure)
        } catch (listenerError) {
          console.error('[dsh-game-minesweeper] error listener failed', listenerError)
        }
      }
    }

    function paint() {
      if (!alive) return
      try {
        drawFrame()
      } catch (error) {
        fail(error)
      }
    }

    function drawFrame() {
      context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
      context.clearRect(0, 0, size.width, size.height)
      if (size.width < MIN_WIDTH || size.height < MIN_HEIGHT) {
        layout = null
        drawTooSmall(context, size.width, size.height)
        return
      }
      const nextLayout = computeLayout(size.width, size.height, state.rows, state.cols)
      layout = nextLayout
      const cell = nextLayout.cell
      const total = state.rows * state.cols
      const showMines = state.status === 'lost'
      for (let index = 0; index < total; index += 1) {
        const row = Math.floor(index / state.cols)
        const col = index % state.cols
        const x = nextLayout.x + col * cell
        const y = nextLayout.y + row * cell
        const isMine = state.mine[index] === 1
        const isRevealed = state.revealed[index] === 1
        const isFlagged = state.flagged[index] === 1
        if (showMines && isMine) {
          if (isFlagged) {
            drawHiddenCell(context, x, y, cell, false)
            drawFlag(context, x, y, cell)
          } else {
            drawRevealedCell(context, x, y, cell, index === state.exploded ? COLORS.boom : COLORS.revealed)
            drawMine(context, x, y, cell)
          }
          continue
        }
        if (isRevealed) {
          drawRevealedCell(context, x, y, cell, COLORS.revealed)
          if (state.adjacent[index] > 0) drawNumber(context, x, y, cell, state.adjacent[index])
          continue
        }
        if (isFlagged) {
          drawHiddenCell(context, x, y, cell, false)
          drawFlag(context, x, y, cell)
          if (showMines && !isMine) drawWrongMark(context, x, y, cell)
          continue
        }
        const hover = hoverIndex === index && (state.status === 'ready' || state.status === 'playing')
        drawHiddenCell(context, x, y, cell, hover)
      }
    }

    function tick() {
      raf = 0
      if (!alive || failure || doc.hidden || state.status !== 'playing') return
      const now = clock()
      const second = Math.floor(elapsedNow(now) / 1000)
      if (second !== shownSecond) {
        shownSecond = second
        emit()
      }
      scheduleFrame()
    }

    function scheduleFrame() {
      if (!alive || failure || raf || doc.hidden || state.status !== 'playing') return
      try {
        raf = view.requestAnimationFrame(tick)
      } catch (error) {
        fail(error)
      }
    }

    /**
     * Run one user action, then commit timer/persistence/render side effects.
     * Every user-facing mutation goes through here so all of them are guarded.
     */
    function act(mutator) {
      if (!alive || failure) return false
      let changed = false
      try {
        changed = mutator()
      } catch (error) {
        fail(error)
        return false
      }
      if (!changed) return false
      const now = clock()
      if (state.status === 'playing') {
        startClock(now)
      } else if (runStart !== null) {
        commitElapsed(now)
      }
      if (state.status === 'won') recordBest()
      if (state.status !== 'playing' && state.status !== 'ready') hoverIndex = -1
      persist()
      emit()
      paint()
      scheduleFrame()
      return true
    }

    function reveal(index) {
      return act(function () {
        return revealAt(state, index, random)
      })
    }

    function flag(index) {
      return act(function () {
        return toggleFlag(state, index)
      })
    }

    function chord(index) {
      return act(function () {
        return chordAt(state, index, random)
      })
    }

    function newGame(nextDifficulty) {
      if (!alive || failure) return false
      const target =
        typeof nextDifficulty === 'string' && LEVELS[nextDifficulty] ? nextDifficulty : state.difficulty
      if (runStart !== null) commitElapsed(clock())
      state = freshState(target, state.best)
      runStart = null
      runBase = 0
      shownSecond = 0
      hoverIndex = -1
      persist()
      emit()
      paint()
      return true
    }

    function setDifficulty(difficulty) {
      if (!LEVELS[difficulty]) return false
      return newGame(difficulty)
    }

    function focusCanvas() {
      try {
        canvas.focus({ preventScroll: true })
      } catch (error) {
        try {
          canvas.focus()
        } catch (focusError) {
          // ignore
        }
      }
    }

    function preventEvent(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
    }

    function pointerCell(event) {
      if (!layout) return -1
      let left = 0
      let top = 0
      try {
        if (typeof canvas.getBoundingClientRect === 'function') {
          const rect = canvas.getBoundingClientRect()
          if (rect) {
            left = typeof rect.left === 'number' ? rect.left : 0
            top = typeof rect.top === 'number' ? rect.top : 0
          }
        }
      } catch (error) {
        // Use the canvas origin fallback.
      }
      const clientX = event && typeof event.clientX === 'number' ? event.clientX : 0
      const clientY = event && typeof event.clientY === 'number' ? event.clientY : 0
      return cellIndexAt(layout, clientX - left, clientY - top)
    }

    function onPointerDown(event) {
      if (!alive || failure) return
      focusCanvas()
      const index = pointerCell(event)
      if (index < 0) return
      const button = event && typeof event.button === 'number' ? event.button : 0
      if (button === 0) {
        reveal(index)
        return
      }
      if (button === 2) {
        preventEvent(event)
        flag(index)
        return
      }
      if (button === 1) {
        preventEvent(event)
        chord(index)
      }
    }

    function onPointerMove(event) {
      if (!alive || failure) return
      if (state.status !== 'ready' && state.status !== 'playing') {
        if (hoverIndex !== -1) {
          hoverIndex = -1
          paint()
        }
        return
      }
      const index = pointerCell(event)
      if (index !== hoverIndex) {
        hoverIndex = index
        paint()
      }
    }

    function onPointerLeave() {
      if (hoverIndex === -1) return
      hoverIndex = -1
      paint()
    }

    function onContextMenu(event) {
      preventEvent(event)
    }

    function onDoubleClick(event) {
      if (!alive || failure) return
      const index = pointerCell(event)
      if (index >= 0) chord(index)
    }

    function onVisibilityChange() {
      if (!alive) return
      if (doc.hidden) {
        if (runStart !== null) commitElapsed(clock())
        if (raf) {
          try {
            view.cancelAnimationFrame(raf)
          } catch (error) {
            // ignore
          }
          raf = 0
        }
        persist()
        return
      }
      if (state.status === 'playing') {
        startClock(clock())
        scheduleFrame()
      }
      paint()
      emit()
    }

    // devicePixelRatio can change without the host changing CSS size (dragging
    // the window between monitors, browser zoom). ResizeObserver does not fire
    // for that, so a window resize listener re-arms the backing store as well.
    function onWindowResize() {
      if (!alive) return
      try {
        resize()
      } catch (error) {
        fail(error)
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
      paint()
    }

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

    doc.addEventListener('visibilitychange', onVisibilityChange)
    view.addEventListener('resize', onWindowResize)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('contextmenu', onContextMenu)
    canvas.addEventListener('dblclick', onDoubleClick)
    host.appendChild(canvas)

    try {
      resize()
      // A page can mount while hidden (e.g. the panel is restored in a
      // background window); do not let the timer run over hidden time.
      if (state.status === 'playing' && !doc.hidden) {
        startClock(clock())
        scheduleFrame()
      }
      if (state.status === 'won') recordBest()
      persist()
      emit()
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
      if (runStart !== null) commitElapsed(clock())
      try {
        persist()
      } catch (error) {
        // ignore
      }
      alive = false
      if (raf) {
        try {
          view.cancelAnimationFrame(raf)
        } catch (error) {
          // ignore
        }
        raf = 0
      }
      try {
        if (resizeObserver) resizeObserver.disconnect()
      } catch (error) {
        // ignore
      }
      try {
        doc.removeEventListener('visibilitychange', onVisibilityChange)
      } catch (error) {
        // ignore
      }
      try {
        view.removeEventListener('resize', onWindowResize)
      } catch (error) {
        // ignore
      }
      try {
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerleave', onPointerLeave)
        canvas.removeEventListener('contextmenu', onContextMenu)
        canvas.removeEventListener('dblclick', onDoubleClick)
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
      reveal,
      flag,
      chord,
      newGame,
      setDifficulty,
      destroy: teardown,
      getState: snapshot,
      getLayout: function () {
        if (!layout) return null
        return {
          x: layout.x,
          y: layout.y,
          cell: layout.cell,
          rows: layout.rows,
          cols: layout.cols,
          boardWidth: layout.boardWidth,
          boardHeight: layout.boardHeight,
        }
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Test seam: only active when a test harness opts in before importing this file
  // ---------------------------------------------------------------------------

  if (window.__DSH_GAME_MINESWEEPER_TEST__ === true) {
    try {
      Object.defineProperty(window, '__DSH_GAME_MINESWEEPER__', {
        configurable: true,
        value: {
          GAME_ID,
          STORE_KEY,
          SCHEMA_VERSION,
          LEVELS,
          LEVEL_IDS,
          MIN_WIDTH,
          MIN_HEIGHT,
          MAX_LOG_MS,
          levelConfig,
          freshState,
          emptyBestMap,
          normalizeBestMap,
          neighborIndices,
          computeAdjacent,
          generateMines,
          ensureMines,
          revealAt,
          toggleFlag,
          chordAt,
          checkWin,
          isWon,
          countFlagged,
          countRevealed,
          sanitizeState,
          serializeState,
          createGame,
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
    id: '@local/dsh-game-minesweeper',
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
          whiteSpace: 'nowrap',
        },
        spacer: { flex: 1, minWidth: 0 },
        levels: { display: 'flex', gap: 4 },
        levelButton: {
          border: '0.5px solid var(--dsw-alias-border-l1)',
          borderRadius: 7,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          fontFamily: 'inherit',
          fontSize: 12,
          lineHeight: '16px',
          padding: '5px 9px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
        levelButtonActive: {
          border: '0.5px solid var(--dsw-alias-brand-primary, var(--dsw-alias-border-l1))',
          background: 'var(--dsw-alias-interactive-bg-active)',
          color: 'var(--dsw-alias-label-primary)',
        },
        scores: { display: 'flex', gap: 8 },
        score: {
          minWidth: 58,
          padding: '3px 10px',
          textAlign: 'center',
          borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
        },
        scoreLabel: {
          fontSize: 10,
          lineHeight: '14px',
          letterSpacing: '0.04em',
          color: 'var(--dsw-alias-label-tertiary)',
        },
        scoreValue: {
          fontSize: 16,
          lineHeight: '20px',
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
        },
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
        actions: { display: 'flex', gap: 8 },
        stage: { position: 'relative', flex: 1, minHeight: 0, borderRadius: 10, overflow: 'hidden' },
        host: { position: 'absolute', inset: 0, outline: 'none' },
        overlay: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.38))',
        },
        panel: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          maxWidth: 320,
          padding: '20px 24px',
          textAlign: 'center',
          borderRadius: 12,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          boxShadow: 'var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.18))',
        },
        panelTitle: { fontSize: 18, fontWeight: 600 },
        panelSub: { fontSize: 13, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' },
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
        '.dshmines-btn{transition:background-color .12s ease,opacity .12s ease}',
        '.dshmines-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)!important}',
        '.dshmines-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      ].join('\n')

      function ScoreBox(props) {
        return h(
          'div',
          { style: UI.score },
          h('div', { style: UI.scoreLabel }, props.label),
          h('div', { style: UI.scoreValue }, String(props.value)),
        )
      }

      function Overlay(props) {
        return h(
          'div',
          { style: UI.overlay, role: 'status' },
          h(
            'div',
            { style: UI.panel },
            h('div', { style: UI.panelTitle }, props.title),
            props.subtitle ? h('div', { style: UI.panelSub }, props.subtitle) : null,
            h(
              'button',
              { type: 'button', className: 'dshmines-btn', style: UI.button, onClick: props.onAction },
              props.action,
            ),
          ),
        )
      }

      const INITIAL_SNAPSHOT = {
        difficulty: 'beginner',
        status: 'ready',
        rows: 9,
        cols: 9,
        mines: 10,
        flags: 0,
        remaining: 10,
        elapsed: 0,
        best: null,
      }

      function formatSeconds(value) {
        // Classic boards cap at 999, but a long relaxed game should still show
        // its real elapsed time; the counter box is min-width so this is safe.
        return String(Math.max(0, Math.floor(value))) + 's'
      }

      function bestText(best) {
        if (best === null || best === undefined) return '—'
        return formatSeconds(Math.floor(best / 1000))
      }

      function DifficultyButtons(props) {
        return h(
          'div',
          { style: UI.levels, role: 'group', 'aria-label': '难度' },
          LEVEL_IDS.map(function (id) {
            const active = props.difficulty === id
            return h(
              'button',
              {
                key: id,
                type: 'button',
                className: 'dshmines-btn',
                'aria-pressed': active,
                style: active ? Object.assign({}, UI.levelButton, UI.levelButtonActive) : UI.levelButton,
                onClick: function () {
                  props.onChoose(id)
                },
              },
              LEVELS[id].label,
            )
          }),
        )
      }

      function Game(props) {
        const rootRef = React.useRef(null)
        const hostRef = React.useRef(null)
        const gameRef = React.useRef(null)
        const [snapshot, setSnapshot] = React.useState(INITIAL_SNAPSHOT)
        const [error, setError] = React.useState(null)
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
            console.error('[dsh-game-minesweeper] failed to start', createError)
            setError('游戏启动失败，点「重试」重新开始。')
            return undefined
          }
          return function cleanup() {
            gameRef.current = null
            try {
              game.destroy()
            } catch (destroyError) {
              console.error('[dsh-game-minesweeper] cleanup failed', destroyError)
            }
          }
        }, [attempt])

        const restart = React.useCallback(function () {
          const game = gameRef.current
          if (game) game.newGame()
        }, [])

        const chooseDifficulty = React.useCallback(function (difficulty) {
          const game = gameRef.current
          if (game) game.setDifficulty(difficulty)
        }, [])

        const retry = React.useCallback(function () {
          setError(null)
          setAttempt(function (value) {
            return value + 1
          })
        }, [])

        const status = snapshot.status
        const levelLabel = LEVELS[snapshot.difficulty] ? LEVELS[snapshot.difficulty].label : ''
        let overlay = null
        if (error) {
          overlay = h(Overlay, { title: '游戏出错了', subtitle: error, action: '重试', onAction: retry })
        } else if (status === 'lost') {
          overlay = h(Overlay, {
            title: '踩到雷了',
            subtitle: '本局用时 ' + snapshot.elapsed + ' 秒，再来一局？',
            action: '再来一局',
            onAction: restart,
          })
        } else if (status === 'won') {
          overlay = h(Overlay, {
            title: '扫雷成功！',
            subtitle: '用时 ' + snapshot.elapsed + ' 秒 · 最佳 ' + bestText(snapshot.best),
            action: '再来一局',
            onAction: restart,
          })
        }

        return h(
          'div',
          { ref: rootRef, style: UI.root, tabIndex: 0, 'data-dsh-game': GAME_ID },
          h('style', null, STYLE_TEXT),
          h(
            'div',
            { style: UI.toolbar },
            h(
              'div',
              { style: UI.titleBlock },
              h('div', { style: UI.title }, '扫雷'),
              h('div', { style: UI.hint }, '左键翻开 · 右键插旗 · 双击数字快开'),
            ),
            h('div', { style: UI.spacer }),
            h(DifficultyButtons, { difficulty: snapshot.difficulty, onChoose: chooseDifficulty }),
            h(
              'div',
              { style: UI.scores },
              h(ScoreBox, { label: '剩余', value: snapshot.remaining }),
              h(ScoreBox, { label: '用时', value: formatSeconds(snapshot.elapsed) }),
              h(ScoreBox, { label: '最佳', value: bestText(snapshot.best) }),
            ),
            h(
              'div',
              { style: UI.actions },
              h(
                'button',
                { type: 'button', className: 'dshmines-btn', style: UI.button, onClick: restart },
                '新游戏',
              ),
            ),
          ),
          h(
            'div',
            { style: UI.stage },
            h('div', { ref: hostRef, style: UI.host }),
            overlay,
            h(
              'div',
              { style: { position: 'absolute', right: 8, bottom: 6, fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', pointerEvents: 'none' } },
              levelLabel + ' · ' + snapshot.mines + ' 雷',
            ),
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
          console.error('[dsh-game-minesweeper] component crashed', error, info)
        }

        render() {
          if (this.state.failed) {
            return h('div', { style: UI.crash }, '扫雷加载失败，请切走再重新进入「游戏」页。')
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
                      return '扫雷'
                    },
                    select: function (ownerProps) {
                      return ownerProps && ownerProps.gameId === GAME_ID ? MATCHED : null
                    },
                  },
                  GameEntry,
                )
              } catch (error) {
                console.error('[dsh-game-minesweeper] slot registration failed', error)
                return function () {}
              }
            })
          } catch (error) {
            console.error('[dsh-game-minesweeper] slot inject failed', error)
          }
        },
      }
    },
  })
})()
