/**
 * @local/dsh-game-2048 — browser half.
 *
 * Registers a 2048 game into the host's `game.stage` chain slot (contract v1):
 *   - `select({ gameId })` returns `{}` only when the host selected `2048`
 *   - the component only relies on the `matched` prop, never on host internals
 *
 * Why everything lives in this one file: `client.js` is the only browser entry
 * the module loader serves. The loader's `require` resolves entries from the
 * module table (react, ...) and cannot load package-relative modules
 * synchronously, so a separate `game.js` would be unreachable in the browser.
 * Pure logic is therefore defined first in this file and is exposed on
 * `window.__DSH_GAME_2048__` only when `window.__DSH_GAME_2048_TEST__ === true`,
 * which lets `dev/` node tests exercise it without a host.
 *
 * Save key: localStorage['dsh.game.2048.v1'] (schemaVersion: 1).
 */
;(function () {
  'use strict'

  const GAME_ID = '2048'
  const STORE_KEY = 'dsh.game.' + GAME_ID + '.v1'
  const SCHEMA_VERSION = 1
  const SIZE = 4
  const CELL_COUNT = SIZE * SIZE
  const SLIDE_MS = 110
  const POP_MS = 110
  const SWIPE_MIN_PX = 24
  const MIN_WIDTH = 260
  const MIN_HEIGHT = 240

  // ---------------------------------------------------------------------------
  // Pure game logic (no DOM, no React, unit-testable under node)
  // ---------------------------------------------------------------------------

  function createEmptyBoard() {
    return new Array(CELL_COUNT).fill(0)
  }

  function isTileValue(value) {
    return (
      Number.isInteger(value) &&
      value >= 2 &&
      value <= 1073741824 &&
      (value & (value - 1)) === 0
    )
  }

  function hasMoves(board) {
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const value = board[index]
      if (value === 0) return true
      const row = Math.floor(index / SIZE)
      const col = index % SIZE
      if (col + 1 < SIZE && board[index + 1] === value) return true
      if (row + 1 < SIZE && board[index + SIZE] === value) return true
    }
    return false
  }

  function hasWon(board) {
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (board[index] >= 2048) return true
    }
    return false
  }

  /**
   * Place one random tile (2 with p=0.9, 4 otherwise) on an empty cell.
   * `random` must return a number in [0, 1); the default is Math.random.
   * Returns null when the board is full.
   */
  function spawnTile(board, random) {
    const rng = typeof random === 'function' ? random : Math.random
    const empty = []
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (board[index] === 0) empty.push(index)
    }
    if (empty.length === 0) return null
    const slot = Math.min(empty.length - 1, Math.max(0, Math.floor(rng() * empty.length)))
    const value = rng() < 0.9 ? 2 : 4
    const next = board.slice()
    next[empty[slot]] = value
    return { board: next, index: empty[slot], value }
  }

  function createInitialBoard(random) {
    let board = createEmptyBoard()
    const first = spawnTile(board, random)
    board = first.board
    const second = spawnTile(board, random)
    return second.board
  }

  function freshState(random, best) {
    const board = createInitialBoard(random)
    return {
      board,
      score: 0,
      best: Number.isInteger(best) && best >= 0 ? best : 0,
      won: false,
      winAcked: true,
      undo: null,
      over: !hasMoves(board),
    }
  }

  /** Board indices of one line, ordered from the edge tiles move toward. */
  function lineIndices(direction, line) {
    const cells = []
    for (let step = 0; step < SIZE; step += 1) {
      let row
      let col
      if (direction === 'left') {
        row = line
        col = step
      } else if (direction === 'right') {
        row = line
        col = SIZE - 1 - step
      } else if (direction === 'up') {
        row = step
        col = line
      } else {
        row = SIZE - 1 - step
        col = line
      }
      cells.push(row * SIZE + col)
    }
    return cells
  }

  /**
   * Slide + merge one move.
   *
   * Returns `{ board, moved, gained, movements, mergedTargets }` where every
   * non-zero source tile appears in `movements` as `{ from, to, value, merged }`
   * (`value` is the pre-merge value). `mergedTargets` lists board indices of
   * cells that received a merge, for the pop animation.
   */
  function moveBoard(board, direction) {
    const result = {
      board: board.slice(),
      moved: false,
      gained: 0,
      movements: [],
      mergedTargets: [],
    }
    if (direction !== 'left' && direction !== 'right' && direction !== 'up' && direction !== 'down') {
      return result
    }

    const next = board.slice()

    for (let line = 0; line < SIZE; line += 1) {
      const cells = lineIndices(direction, line)
      for (let index = 0; index < cells.length; index += 1) next[cells[index]] = 0

      const tiles = []
      for (let index = 0; index < cells.length; index += 1) {
        const value = board[cells[index]]
        if (value !== 0) tiles.push({ value, from: cells[index] })
      }

      const targets = []
      let cursor = 0
      while (cursor < tiles.length) {
        const current = tiles[cursor]
        const following = cursor + 1 < tiles.length ? tiles[cursor + 1] : null
        if (following && following.value === current.value) {
          const value = current.value * 2
          targets.push({ value, from: [current.from, following.from], merged: true })
          result.gained += value
          cursor += 2
        } else {
          targets.push({ value: current.value, from: [current.from], merged: false })
          cursor += 1
        }
      }

      for (let position = 0; position < targets.length; position += 1) {
        const target = targets[position]
        const to = cells[position]
        next[to] = target.value
        if (target.merged) result.mergedTargets.push(to)
        for (let source = 0; source < target.from.length; source += 1) {
          const from = target.from[source]
          if (from !== to) result.moved = true
          if (target.merged) result.moved = true
          result.movements.push({
            from,
            to,
            value: board[from],
            merged: target.merged,
          })
        }
      }
    }

    result.board = next
    return result
  }

  function sanitizeBoard(input) {
    if (!Array.isArray(input) || input.length !== CELL_COUNT) return null
    const board = new Array(CELL_COUNT)
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const value = input[index]
      if (value === 0) {
        board[index] = 0
        continue
      }
      if (!isTileValue(value)) return null
      board[index] = value
    }
    return board
  }

  function sanitizeScore(value) {
    if (Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) return value
    return null
  }

  function sanitizeUndo(input) {
    if (!input || typeof input !== 'object') return null
    const board = sanitizeBoard(input.board)
    if (!board) return null
    const score = sanitizeScore(input.score)
    if (score === null) return null
    return {
      board,
      score,
      won: input.won === true,
      winAcked: input.winAcked === true,
    }
  }

  /**
   * Validate a persisted snapshot. Returns null (start a new game) for any
   * shape/version mismatch instead of throwing.
   */
  function sanitizeState(input) {
    if (!input || typeof input !== 'object' || input.schemaVersion !== SCHEMA_VERSION) return null
    const board = sanitizeBoard(input.board)
    if (!board) return null
    const score = sanitizeScore(input.score)
    if (score === null) return null
    const storedBest = sanitizeScore(input.best)
    const best = Math.max(score, storedBest === null ? 0 : storedBest)
    const won = input.won === true
    const winAcked = input.winAcked === undefined ? won : input.winAcked === true
    return {
      board,
      score,
      best,
      won,
      winAcked,
      undo: sanitizeUndo(input.undo),
      over: !hasMoves(board),
    }
  }

  function serializeState(state) {
    const undo = state.undo
      ? {
          board: state.undo.board.slice(),
          score: state.undo.score,
          won: state.undo.won === true,
          winAcked: state.undo.winAcked === true,
        }
      : null
    return {
      schemaVersion: SCHEMA_VERSION,
      board: state.board.slice(),
      score: state.score,
      best: state.best,
      won: state.won === true,
      winAcked: state.winAcked === true,
      undo,
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
  // Canvas rendering helpers
  // ---------------------------------------------------------------------------

  const BOARD_BG = '#bbada0'
  const EMPTY_BG = '#cdc1b4'
  const TILE_STYLES = {
    2: { bg: '#eee4da', fg: '#776e65' },
    4: { bg: '#ede0c8', fg: '#776e65' },
    8: { bg: '#f2b179', fg: '#f9f6f2' },
    16: { bg: '#f59563', fg: '#f9f6f2' },
    32: { bg: '#f67c5f', fg: '#f9f6f2' },
    64: { bg: '#f65e3b', fg: '#f9f6f2' },
    128: { bg: '#edcf72', fg: '#776e65' },
    256: { bg: '#edcc61', fg: '#776e65' },
    512: { bg: '#edc850', fg: '#776e65' },
    1024: { bg: '#edc53f', fg: '#776e65' },
    2048: { bg: '#edc22e', fg: '#776e65' },
  }
  const SUPER_TILE = { bg: '#3c3a32', fg: '#f9f6f2' }
  const FONT_STACK = '"Segoe UI", system-ui, -apple-system, sans-serif'

  const KEYS = {
    arrowleft: 'left',
    a: 'left',
    arrowright: 'right',
    d: 'right',
    arrowup: 'up',
    w: 'up',
    arrowdown: 'down',
    s: 'down',
  }

  function clamp01(value) {
    if (value < 0) return 0
    if (value > 1) return 1
    return value
  }

  function easeOutCubic(progress) {
    return 1 - Math.pow(1 - progress, 3)
  }

  function easeOutBack(progress) {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(progress - 1, 3) + c1 * Math.pow(progress - 1, 2)
  }

  function tileStyle(value) {
    return TILE_STYLES[value] || SUPER_TILE
  }

  function tileFont(cell, value) {
    const digits = String(value).length
    const ratio = digits <= 2 ? 0.45 : digits === 3 ? 0.36 : digits === 4 ? 0.29 : 0.23
    return '700 ' + Math.max(10, Math.round(cell * ratio)) + 'px ' + FONT_STACK
  }

  function computeLayout(width, height) {
    const inset = Math.max(8, Math.min(width, height) * 0.018)
    const boardSize = Math.max(0, Math.min(width - inset * 2, height - inset * 2))
    const gap = Math.max(3, boardSize * 0.022)
    const cell = Math.max(1, (boardSize - gap * (SIZE + 1)) / SIZE)
    return {
      x: (width - boardSize) / 2,
      y: (height - boardSize) / 2,
      boardSize,
      gap,
      cell,
      radius: Math.max(3, cell * 0.12),
      boardRadius: Math.max(8, boardSize * 0.018),
    }
  }

  function cellOrigin(layout, index) {
    const row = Math.floor(index / SIZE)
    const col = index % SIZE
    return {
      x: layout.x + layout.gap + col * (layout.cell + layout.gap),
      y: layout.y + layout.gap + row * (layout.cell + layout.gap),
    }
  }

  function drawRoundedRect(ctx, x, y, width, height, radius, fillStyle) {
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
    ctx.fillStyle = fillStyle
    ctx.fill()
  }

  function drawTile(ctx, layout, centerX, centerY, value, scale) {
    const style = tileStyle(value)
    ctx.save()
    ctx.translate(centerX, centerY)
    if (scale && scale !== 1) ctx.scale(scale, scale)
    drawRoundedRect(ctx, -layout.cell / 2, -layout.cell / 2, layout.cell, layout.cell, layout.radius, style.bg)
    ctx.fillStyle = style.fg
    ctx.font = tileFont(layout.cell, value)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(value), 0, layout.cell * 0.02)
    ctx.restore()
  }

  function drawTooSmall(ctx, width, height) {
    ctx.fillStyle = BOARD_BG
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#f9f6f2'
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
    if (!host) throw new Error('2048: missing mount element')
    const opts = options || {}
    const random = typeof opts.random === 'function' ? opts.random : Math.random
    const onState = typeof opts.onState === 'function' ? opts.onState : null
    const onError = typeof opts.onError === 'function' ? opts.onError : null
    // Keyboard events are listened on the component root (not window/document).
    // `keyTarget` must therefore be the widest element owned by this game
    // (toolbar + board), so clicking 撤销/新游戏 does not detach the arrow keys.
    const keyTarget =
      opts.keyTarget && typeof opts.keyTarget.addEventListener === 'function' ? opts.keyTarget : host
    const doc = document
    const view = window

    let state = loadSavedState() || freshState(random)
    let alive = true
    let anim = null
    let raf = 0
    let failure = null
    let size = { width: 0, height: 0, dpr: 1 }
    let pointerStart = null
    const canvas = doc.createElement('canvas')
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'application')
    canvas.setAttribute('aria-label', '2048 游戏棋盘')
    canvas.style.cssText =
      'display:block;width:100%;height:100%;outline:none;touch-action:none;-webkit-user-select:none;user-select:none'

    function clock() {
      const perf = view.performance
      return perf && typeof perf.now === 'function' ? perf.now() : Date.now()
    }

    function snapshot() {
      return {
        score: state.score,
        best: state.best,
        over: state.over,
        won: state.won,
        winAcked: state.winAcked,
        canUndo: state.undo !== null,
      }
    }

    function emit() {
      if (!onState) return
      try {
        onState(snapshot())
      } catch (error) {
        console.error('[dsh-game-2048] state listener failed', error)
      }
    }

    function persist() {
      saveStateToStorage(state)
    }

    function fail(error) {
      if (!alive) return
      failure = '游戏遇到问题，点「重试」重新开始。'
      anim = null
      if (raf) {
        try {
          view.cancelAnimationFrame(raf)
        } catch (cancelError) {
          // ignore
        }
        raf = 0
      }
      try {
        console.error('[dsh-game-2048] runtime error', error)
      } catch (logError) {
        // ignore
      }
      if (onError) {
        try {
          onError(failure)
        } catch (listenerError) {
          console.error('[dsh-game-2048] error listener failed', listenerError)
        }
      }
    }

    function advance(nowTs) {
      if (!anim) return
      if (anim.phase === 'slide') {
        const progress = (nowTs - anim.phaseStart) / SLIDE_MS
        anim.progress = clamp01(progress)
        if (progress >= 1) {
          anim.phase = 'pop'
          anim.phaseStart = nowTs
          anim.progress = 0
        }
      }
      if (anim.phase === 'pop') {
        const progress = (nowTs - anim.phaseStart) / POP_MS
        anim.progress = clamp01(progress)
        if (progress >= 1) anim = null
      }
    }

    function renderScene(ctx, layout) {
      drawRoundedRect(ctx, layout.x, layout.y, layout.boardSize, layout.boardSize, layout.boardRadius, BOARD_BG)

      for (let index = 0; index < CELL_COUNT; index += 1) {
        const origin = cellOrigin(layout, index)
        drawRoundedRect(ctx, origin.x, origin.y, layout.cell, layout.cell, layout.radius, EMPTY_BG)
      }

      if (anim && anim.phase === 'slide') {
        const eased = easeOutCubic(anim.progress)
        for (let index = 0; index < anim.movements.length; index += 1) {
          const movement = anim.movements[index]
          const from = cellOrigin(layout, movement.from)
          const to = cellOrigin(layout, movement.to)
          const x = from.x + (to.x - from.x) * eased
          const y = from.y + (to.y - from.y) * eased
          drawTile(ctx, layout, x + layout.cell / 2, y + layout.cell / 2, movement.value)
        }
        return
      }

      const popScale =
        anim && anim.phase === 'pop' ? 0.8 + 0.2 * easeOutBack(anim.progress) : 1
      for (let index = 0; index < CELL_COUNT; index += 1) {
        const value = state.board[index]
        if (value === 0) continue
        const origin = cellOrigin(layout, index)
        const centerX = origin.x + layout.cell / 2
        const centerY = origin.y + layout.cell / 2
        const popping =
          anim &&
          anim.phase === 'pop' &&
          (index === anim.spawnIndex || anim.mergedTargets.indexOf(index) !== -1)
        drawTile(ctx, layout, centerX, centerY, value, popping ? popScale : 1)
      }
    }

    function drawFrame() {
      advance(clock())
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2048: 2d canvas context unavailable')
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
      ctx.clearRect(0, 0, size.width, size.height)
      if (size.width < MIN_WIDTH || size.height < MIN_HEIGHT) {
        drawTooSmall(ctx, size.width, size.height)
        return
      }
      renderScene(ctx, computeLayout(size.width, size.height))
    }

    function tick() {
      raf = 0
      if (!alive) return
      if (doc.hidden) {
        finishAnimation()
        return
      }
      try {
        drawFrame()
      } catch (error) {
        fail(error)
        return
      }
      if (anim) {
        try {
          raf = view.requestAnimationFrame(tick)
        } catch (error) {
          fail(error)
        }
      }
    }

    function ensureFrame() {
      if (!alive || raf) return
      if (doc.hidden) {
        finishAnimation()
        return
      }
      try {
        raf = view.requestAnimationFrame(tick)
      } catch (error) {
        fail(error)
      }
    }

    function finishAnimation() {
      if (!anim) return
      anim = null
      if (raf) {
        try {
          view.cancelAnimationFrame(raf)
        } catch (error) {
          // ignore
        }
        raf = 0
      }
      try {
        drawFrame()
      } catch (error) {
        fail(error)
      }
    }

    function move(direction) {
      if (!alive || failure) return false
      if (anim) finishAnimation()
      let result
      try {
        result = moveBoard(state.board, direction)
      } catch (error) {
        fail(error)
        return false
      }
      if (!result.moved) return false

      const undo = {
        board: state.board.slice(),
        score: state.score,
        won: state.won,
        winAcked: state.winAcked,
      }
      const spawned = spawnTile(result.board, random)
      const nextBoard = spawned ? spawned.board : result.board

      state.undo = undo
      state.board = nextBoard
      state.score += result.gained
      state.best = Math.max(state.best, state.score)
      if (!state.won && hasWon(nextBoard)) {
        state.won = true
        state.winAcked = false
      }
      state.over = !hasMoves(nextBoard)

      anim = {
        phase: 'slide',
        phaseStart: clock(),
        progress: 0,
        movements: result.movements,
        mergedTargets: result.mergedTargets,
        spawnIndex: spawned ? spawned.index : -1,
      }
      persist()
      emit()
      if (doc.hidden) finishAnimation()
      else ensureFrame()
      return true
    }

    function undo() {
      if (!alive || failure || !state.undo) return false
      if (anim) finishAnimation()
      state.board = state.undo.board.slice()
      state.score = state.undo.score
      state.won = state.undo.won
      state.winAcked = state.undo.winAcked
      state.undo = null
      state.over = !hasMoves(state.board)
      persist()
      emit()
      try {
        drawFrame()
      } catch (error) {
        fail(error)
      }
      return true
    }

    function newGame() {
      if (!alive || failure) return false
      if (anim) {
        anim = null
        if (raf) {
          try {
            view.cancelAnimationFrame(raf)
          } catch (error) {
            // ignore
          }
          raf = 0
        }
      }
      state = freshState(random, state.best)
      persist()
      emit()
      try {
        drawFrame()
      } catch (error) {
        fail(error)
        return false
      }
      return true
    }

    function acknowledgeWin() {
      if (!alive || failure || !state.won || state.winAcked) return false
      state.winAcked = true
      persist()
      emit()
      return true
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
      drawFrame()
    }

    function onKeyDown(event) {
      if (!alive || failure) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
      const direction = KEYS[key]
      if (direction) {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        move(direction)
        return
      }
      if (key === 'u') {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        undo()
      }
    }

    function onPointerDown(event) {
      if (!alive || failure) return
      if (event.button !== undefined && event.button !== 0) return
      pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId }
      try {
        if (canvas.setPointerCapture && event.pointerId !== undefined) {
          canvas.setPointerCapture(event.pointerId)
        }
      } catch (error) {
        // pointer capture is a nicety only
      }
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

    function onPointerUp(event) {
      if (!pointerStart) return
      const start = pointerStart
      pointerStart = null
      if (!alive || failure) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN_PX) return
      if (Math.abs(dx) >= Math.abs(dy)) move(dx > 0 ? 'right' : 'left')
      else move(dy > 0 ? 'down' : 'up')
    }

    function onPointerCancel() {
      pointerStart = null
    }

    function onVisibilityChange() {
      if (!alive) return
      if (doc.hidden) {
        if (anim) {
          anim = null
          if (raf) {
            try {
              view.cancelAnimationFrame(raf)
            } catch (error) {
              // ignore
            }
            raf = 0
          }
        }
        return
      }
      try {
        drawFrame()
      } catch (error) {
        fail(error)
      }
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
    keyTarget.addEventListener('keydown', onKeyDown)
    view.addEventListener('resize', onWindowResize)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerCancel)
    host.appendChild(canvas)

    try {
      resize()
      persist()
      emit()
      try {
        canvas.focus({ preventScroll: true })
      } catch (focusError) {
        try {
          canvas.focus()
        } catch (fallbackError) {
          // focus is best-effort
        }
      }
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
      anim = null
      if (raf) {
        try {
          view.cancelAnimationFrame(raf)
        } catch (error) {
          // ignore
        }
        raf = 0
      }
      try {
        saveStateToStorage(state)
      } catch (error) {
        // ignore
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
        keyTarget.removeEventListener('keydown', onKeyDown)
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
        canvas.removeEventListener('pointerup', onPointerUp)
        canvas.removeEventListener('pointercancel', onPointerCancel)
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
      move,
      undo,
      newGame,
      acknowledgeWin,
      destroy: teardown,
      getState: function () {
        return snapshot()
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Test seam: only active when a test harness opts in before importing this file
  // ---------------------------------------------------------------------------

  if (window.__DSH_GAME_2048_TEST__ === true) {
    try {
      Object.defineProperty(window, '__DSH_GAME_2048__', {
        configurable: true,
        value: {
          GAME_ID,
          STORE_KEY,
          SCHEMA_VERSION,
          SIZE,
          CELL_COUNT,
          createEmptyBoard,
          spawnTile,
          createInitialBoard,
          freshState,
          moveBoard,
          hasMoves,
          hasWon,
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
    id: '@local/dsh-game-2048',
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
          paddingBottom: 10,
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
        scores: { display: 'flex', gap: 8 },
        score: {
          minWidth: 62,
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
        '.dsh2048-btn{transition:background-color .12s ease,opacity .12s ease}',
        '.dsh2048-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)!important}',
        '.dsh2048-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      ].join('\n')

      function buttonStyle(enabled) {
        return enabled ? UI.button : Object.assign({}, UI.button, UI.buttonDisabled)
      }

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
              { type: 'button', className: 'dsh2048-btn', style: UI.button, onClick: props.onAction },
              props.action,
            ),
          ),
        )
      }

      const INITIAL_SNAPSHOT = {
        score: 0,
        best: 0,
        over: false,
        won: false,
        winAcked: true,
        canUndo: false,
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
              // Listen on the whole component root so the arrow keys keep
              // working after the user clicks 撤销 / 新游戏 / an overlay button.
              keyTarget: rootRef.current,
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
            console.error('[dsh-game-2048] failed to start', createError)
            setError('游戏启动失败，点「重试」重新开始。')
            return undefined
          }
          return function cleanup() {
            gameRef.current = null
            try {
              game.destroy()
            } catch (destroyError) {
              console.error('[dsh-game-2048] cleanup failed', destroyError)
            }
          }
        }, [attempt])

        const startNewGame = React.useCallback(function () {
          const game = gameRef.current
          if (game) game.newGame()
        }, [])

        const undoMove = React.useCallback(function () {
          const game = gameRef.current
          if (game) game.undo()
        }, [])

        const continueAfterWin = React.useCallback(function () {
          const game = gameRef.current
          if (game) game.acknowledgeWin()
        }, [])

        const retry = React.useCallback(function () {
          setError(null)
          setAttempt(function (value) {
            return value + 1
          })
        }, [])

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
              h('div', { style: UI.title }, '2048'),
              h('div', { style: UI.hint }, '方向键 / WASD 移动 · U 撤销'),
            ),
            h('div', { style: UI.spacer }),
            h(
              'div',
              { style: UI.scores },
              h(ScoreBox, { label: '分数', value: snapshot.score }),
              h(ScoreBox, { label: '最高', value: snapshot.best }),
            ),
            h(
              'div',
              { style: UI.actions },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh2048-btn',
                  style: buttonStyle(snapshot.canUndo),
                  disabled: !snapshot.canUndo,
                  onClick: undoMove,
                },
                '撤销',
              ),
              h(
                'button',
                { type: 'button', className: 'dsh2048-btn', style: UI.button, onClick: startNewGame },
                '新游戏',
              ),
            ),
          ),
          h(
            'div',
            { style: UI.stage },
            h('div', { ref: hostRef, style: UI.host }),
            error
              ? h(Overlay, { title: '游戏出错了', subtitle: error, action: '重试', onAction: retry })
              : snapshot.over
                ? h(Overlay, {
                    title: '没有可移动的方块了',
                    subtitle: '本局得分 ' + snapshot.score,
                    action: '再来一局',
                    onAction: startNewGame,
                  })
                : snapshot.won && !snapshot.winAcked
                  ? h(Overlay, {
                      title: '达到 2048！',
                      subtitle: '可以继续挑战更高分',
                      action: '继续玩',
                      onAction: continueAfterWin,
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
          console.error('[dsh-game-2048] component crashed', error, info)
        }

        render() {
          if (this.state.failed) {
            return h('div', { style: UI.crash }, '2048 加载失败，请切走再重新进入「游戏」页。')
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
                      return '2048'
                    },
                    select: function (ownerProps) {
                      return ownerProps && ownerProps.gameId === GAME_ID ? MATCHED : null
                    },
                  },
                  GameEntry,
                )
              } catch (error) {
                console.error('[dsh-game-2048] slot registration failed', error)
                return function () {}
              }
            })
          } catch (error) {
            console.error('[dsh-game-2048] slot inject failed', error)
          }
        },
      }
    },
  })
})()
