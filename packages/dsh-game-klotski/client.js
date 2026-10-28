/**
 * @local/dsh-game-klotski — browser client module for the DSH game deck.
 *
 * Klotski / 华容道: a 4-column x 5-row sliding-block puzzle. Move the blocks
 * aside (1 or 2 cells per slide, never rotating, never overlapping) and bring
 * the 2x2 Cao Cao block to the bottom-middle exit — its top-left must reach
 * (col 1, row 3), i.e. it then covers rows 3-4, cols 1-2.
 *
 * Single-file bundle (classic script wrapped in an IIFE):
 *
 *   1. Constants + the four level layouts (piece + coordinates, no pixels).
 *   2. Pure engine: legal-move generation, slide / undo / win, timer format,
 *      save schema v1 sanitising. No DOM, no React.
 *   3. Test seam on `window.__DSH_GAME_KLOTSKI__` ONLY when
 *      `window.__DSH_GAME_KLOTSKI_TEST__ === true` before this module is imported.
 *   4. DOM controller (`createGame`) rendering a React-independent UI inside the
 *      host root: board, pieces, selection / destination markers, level chips,
 *      undo / restart, timer with visibility pause, win overlay, too-small hint,
 *      auto-save to `dsh.game.klotski.v1`.
 *   5. React `Game` component (wraps `createGame`) and the `game.stage` slot
 *      registration (id `klotski`).
 *
 * Contract: handoff/contract/game-plugin-api.v1.md
 * Spec:     handoff/to-sub/011-add-klotski.md
 */
;(function () {
  'use strict'

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const GAME_ID = 'klotski'
  const GAME_LABEL = '华容道'
  const STORE_KEY = 'dsh.game.klotski.v1'
  const SCHEMA_VERSION = 1
  const COLS = 4
  const ROWS = 5
  const EXIT = { x: 1, y: 3, w: 2, h: 2 }
  const UNDO_LIMIT = 200
  const MAX_MOVES = 100000
  const MAX_ELAPSED_MS = 604800000 // one week, defensive upper bound
  const MIN_WIDTH = 320
  const MIN_HEIGHT = 240
  const AUTOSAVE_MS = 4000

  // ---------------------------------------------------------------------------
  // Level data. Coordinates are grid cells: x = col 0..3, y = row 0..4.
  // `par` is the BFS-verified minimum number of slides (1-2 cells each) for
  // that layout; dev/solve.mjs asserts it still holds.
  // ---------------------------------------------------------------------------

  function def(id, name, kind, w, h, x, y) {
    return { id: id, name: name, kind: kind, w: w, h: h, x: x, y: y }
  }

  const LEVELS = [
    {
      id: 'hengdao',
      name: '横刀立马',
      tag: '经典',
      par: 90,
      pieces: [
        def('zhang', '张飞', 'general', 1, 2, 0, 0),
        def('cao', '曹操', 'cao', 2, 2, 1, 0),
        def('zhao', '赵云', 'general', 1, 2, 3, 0),
        def('ma', '马超', 'general', 1, 2, 0, 2),
        def('guan', '关羽', 'guan', 2, 1, 1, 2),
        def('huang', '黄忠', 'general', 1, 2, 3, 2),
        def('bing1', '兵', 'soldier', 1, 1, 1, 3),
        def('bing2', '兵', 'soldier', 1, 1, 2, 3),
        def('bing3', '兵', 'soldier', 1, 1, 0, 4),
        def('bing4', '兵', 'soldier', 1, 1, 3, 4),
      ],
    },
    {
      id: 'zhihui',
      name: '指挥若定',
      tag: '经典',
      par: 90,
      pieces: [
        def('zhang', '张飞', 'general', 1, 2, 0, 0),
        def('cao', '曹操', 'cao', 2, 2, 1, 0),
        def('zhao', '赵云', 'general', 1, 2, 3, 0),
        def('ma', '马超', 'general', 1, 2, 0, 2),
        def('guan', '关羽', 'guan', 2, 1, 1, 2),
        def('huang', '黄忠', 'general', 1, 2, 3, 2),
        def('bing1', '兵', 'soldier', 1, 1, 1, 3),
        def('bing2', '兵', 'soldier', 1, 1, 2, 3),
        def('bing3', '兵', 'soldier', 1, 1, 1, 4),
        def('bing4', '兵', 'soldier', 1, 1, 2, 4),
      ],
    },
    {
      id: 'qitou',
      name: '齐头并进',
      tag: '进阶',
      par: 76,
      pieces: [
        def('zhang', '张飞', 'general', 1, 2, 0, 0),
        def('cao', '曹操', 'cao', 2, 2, 1, 0),
        def('zhao', '赵云', 'general', 1, 2, 3, 0),
        def('ma', '马超', 'general', 1, 2, 0, 2),
        def('bing1', '兵', 'soldier', 1, 1, 1, 2),
        def('bing2', '兵', 'soldier', 1, 1, 2, 2),
        def('huang', '黄忠', 'general', 1, 2, 3, 2),
        def('guan', '关羽', 'guan', 2, 1, 1, 3),
        def('bing3', '兵', 'soldier', 1, 1, 0, 4),
        def('bing4', '兵', 'soldier', 1, 1, 3, 4),
      ],
    },
    {
      id: 'cengceng',
      name: '层层设防',
      tag: '挑战',
      par: 77,
      pieces: [
        def('bing1', '兵', 'soldier', 1, 1, 0, 0),
        def('cao', '曹操', 'cao', 2, 2, 1, 0),
        def('bing2', '兵', 'soldier', 1, 1, 3, 0),
        def('zhang', '张飞', 'general', 1, 2, 0, 1),
        def('zhao', '赵云', 'general', 1, 2, 3, 1),
        def('guan', '关羽', 'guan', 2, 1, 1, 2),
        def('ma', '马超', 'general', 1, 2, 0, 3),
        def('bing3', '兵', 'soldier', 1, 1, 1, 3),
        def('bing4', '兵', 'soldier', 1, 1, 2, 3),
        def('huang', '黄忠', 'general', 1, 2, 3, 3),
      ],
    },
  ]

  const LEVEL_BY_ID = Object.create(null)
  for (let i = 0; i < LEVELS.length; i += 1) LEVEL_BY_ID[LEVELS[i].id] = i

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function toInt(value) {
    if (typeof value === 'number' && isFinite(value)) return Math.floor(value)
    if (typeof value === 'string' && value !== '' && isFinite(Number(value))) return Math.floor(Number(value))
    return NaN
  }

  /** Strict integer for coordinates / indices: no 1.5 -> 1 coercion. */
  function toStrictInt(value) {
    if (typeof value === 'number' && Number.isInteger(value)) return value
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
    return NaN
  }

  function clampInt(value, min, max) {
    if (!isFinite(value)) return min
    return Math.min(max, Math.max(min, Math.floor(value)))
  }

  function copyPieces(pieces) {
    const out = []
    for (let i = 0; i < pieces.length; i += 1) out.push({ id: pieces[i].id, x: pieces[i].x, y: pieces[i].y })
    return out
  }

  function getLevel(index) {
    return LEVELS[index] || LEVELS[0]
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.floor((isFinite(ms) ? ms : 0) / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const mm = (m < 10 ? '0' : '') + m
    const ss = (s < 10 ? '0' : '') + s
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss
  }

  function nowMs() {
    try {
      if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
        return performance.now()
      }
    } catch (ignored) {
      /* fall through */
    }
    return Date.now()
  }

  // ---------------------------------------------------------------------------
  // Pure engine
  // ---------------------------------------------------------------------------

  function createState(levelIndex, best) {
    const index = clampInt(levelIndex, 0, LEVELS.length - 1)
    const level = LEVELS[index]
    return {
      levelIndex: index,
      pieces: level.pieces.map(function (p) {
        return { id: p.id, x: p.x, y: p.y }
      }),
      moves: 0,
      elapsedMs: 0,
      started: false,
      won: false,
      undo: [],
      best: best && typeof best === 'object' ? Object.assign({}, best) : {},
    }
  }

  function buildGrid(state) {
    const grid = new Int8Array(COLS * ROWS).fill(-1)
    for (let i = 0; i < state.pieces.length; i += 1) {
      const piece = state.pieces[i]
      const levelPiece = LEVELS[state.levelIndex].pieces.find(function (p) {
        return p.id === piece.id
      })
      if (!levelPiece) throw new Error('unknown piece ' + piece.id)
      for (let dy = 0; dy < levelPiece.h; dy += 1) {
        for (let dx = 0; dx < levelPiece.w; dx += 1) {
          const x = piece.x + dx
          const y = piece.y + dy
          if (x < 0 || y < 0 || x >= COLS || y >= ROWS) throw new Error('piece out of bounds: ' + piece.id)
          const cell = y * COLS + x
          if (grid[cell] !== -1) throw new Error('pieces overlap at ' + x + ',' + y)
          grid[cell] = i
        }
      }
    }
    return grid
  }

  function pieceAt(state, x, y) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return -1
    return buildGrid(state)[y * COLS + x]
  }

  function isWon(state) {
    for (let i = 0; i < state.pieces.length; i += 1) {
      if (state.pieces[i].id === 'cao') {
        return state.pieces[i].x === EXIT.x && state.pieces[i].y === EXIT.y
      }
    }
    return false
  }

  function pieceIndexById(state, id) {
    for (let i = 0; i < state.pieces.length; i += 1) if (state.pieces[i].id === id) return i
    return -1
  }

  /**
   * Can `pieceIndex` slide one or two cells in (dx, dy)?
   * A slide is legal only if every cell the piece enters on the way is empty
   * (cells currently occupied by the moving piece itself are fine).
   */
  function canSlide(state, pieceIndex, dx, dy, step) {
    if (!(dx === 0 || dy === 0)) return false
    if (dx === 0 && dy === 0) return false
    if (step !== 1 && step !== 2) return false
    if (pieceIndex < 0 || pieceIndex >= state.pieces.length) return false
    const levelPiece = LEVELS[state.levelIndex].pieces[pieceIndex]
    if (!levelPiece) return false
    const piece = state.pieces[pieceIndex]
    const targetX = piece.x + dx * step
    const targetY = piece.y + dy * step
    if (targetX < 0 || targetY < 0 || targetX + levelPiece.w > COLS || targetY + levelPiece.h > ROWS) return false
    const grid = buildGrid(state)
    for (let t = 1; t <= step; t += 1) {
      for (let oy = 0; oy < levelPiece.h; oy += 1) {
        for (let ox = 0; ox < levelPiece.w; ox += 1) {
          const cellX = piece.x + dx * t + ox
          const cellY = piece.y + dy * t + oy
          const owner = grid[cellY * COLS + cellX]
          if (owner !== -1 && owner !== pieceIndex) return false
        }
      }
    }
    return true
  }

  /** Legal moves for one piece: 1- and 2-cell slides per direction. */
  function listMoves(state, pieceIndex) {
    const out = []
    if (state.won) return out
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]
    for (let d = 0; d < dirs.length; d += 1) {
      const dx = dirs[d][0]
      const dy = dirs[d][1]
      for (let step = 1; step <= 2; step += 1) {
        if (!canSlide(state, pieceIndex, dx, dy, step)) break
        out.push({
          pieceIndex: pieceIndex,
          dx: dx,
          dy: dy,
          step: step,
          x: state.pieces[pieceIndex].x + dx * step,
          y: state.pieces[pieceIndex].y + dy * step,
        })
      }
    }
    return out
  }

  /** Cells this move newly enters (destination footprint minus own footprint). */
  function enteredCells(state, pieceIndex, move) {
    const def = LEVELS[state.levelIndex].pieces[pieceIndex]
    const grid = buildGrid(state)
    const cells = []
    for (let oy = 0; oy < def.h; oy += 1) {
      for (let ox = 0; ox < def.w; ox += 1) {
        const x = move.x + ox
        const y = move.y + oy
        if (grid[y * COLS + x] !== pieceIndex) cells.push({ x: x, y: y })
      }
    }
    return cells
  }

  /**
   * Map "x,y" (a newly entered, currently empty cell) -> move for the selected
   * piece. Using entered cells instead of the destination top-left keeps the
   * click target outside the piece itself (e.g. a 2x2 block sliding down).
   * A closer slide wins when two slides enter the same cell.
   */
  function destinations(state, pieceIndex) {
    const out = Object.create(null)
    const moves = listMoves(state, pieceIndex)
    for (let i = 0; i < moves.length; i += 1) {
      const cells = enteredCells(state, pieceIndex, moves[i])
      for (let c = 0; c < cells.length; c += 1) {
        const key = cells[c].x + ',' + cells[c].y
        if (!(key in out)) out[key] = moves[i]
      }
    }
    return out
  }

  function applySlide(state, pieceIndex, dx, dy, step) {
    if (!canSlide(state, pieceIndex, dx, dy, step)) return null
    const next = {
      levelIndex: state.levelIndex,
      pieces: copyPieces(state.pieces),
      moves: state.moves + 1,
      elapsedMs: state.elapsedMs,
      started: true,
      won: false,
      undo: state.undo.concat([
        {
          pieces: copyPieces(state.pieces),
          moves: state.moves,
        },
      ]),
      best: state.best,
    }
    if (next.undo.length > UNDO_LIMIT) next.undo = next.undo.slice(next.undo.length - UNDO_LIMIT)
    next.pieces[pieceIndex].x += dx * step
    next.pieces[pieceIndex].y += dy * step
    next.won = isWon(next)
    return next
  }

  function undoState(state) {
    if (!state.undo.length) return null
    const snapshot = state.undo[state.undo.length - 1]
    return {
      levelIndex: state.levelIndex,
      pieces: copyPieces(snapshot.pieces),
      moves: snapshot.moves,
      elapsedMs: state.elapsedMs,
      started: state.started,
      won: false,
      undo: state.undo.slice(0, state.undo.length - 1),
      best: state.best,
    }
  }

  function restartState(state) {
    const fresh = createState(state.levelIndex, state.best)
    return fresh
  }

  // ---------------------------------------------------------------------------
  // Save / restore (schema v1)
  // ---------------------------------------------------------------------------

  function arrangementValid(pieces, level) {
    if (!Array.isArray(pieces) || pieces.length !== level.pieces.length) return false
    const grid = new Int8Array(COLS * ROWS).fill(-1)
    const seen = Object.create(null)
    for (let i = 0; i < pieces.length; i += 1) {
      const item = pieces[i]
      if (!item || typeof item.id !== 'string' || seen[item.id]) return false
      let levelPiece = null
      for (let j = 0; j < level.pieces.length; j += 1) {
        if (level.pieces[j].id === item.id) {
          levelPiece = level.pieces[j]
          break
        }
      }
      if (!levelPiece) return false
      const x = toStrictInt(item.x)
      const y = toStrictInt(item.y)
      if (!isFinite(x) || !isFinite(y)) return false
      if (x < 0 || y < 0 || x + levelPiece.w > COLS || y + levelPiece.h > ROWS) return false
      for (let oy = 0; oy < levelPiece.h; oy += 1) {
        for (let ox = 0; ox < levelPiece.w; ox += 1) {
          const cell = (y + oy) * COLS + (x + ox)
          if (grid[cell] !== -1) return false
          grid[cell] = i
        }
      }
      seen[item.id] = true
    }
    return true
  }

  function sanitizeUndo(rawUndo, level, moves) {
    const out = []
    if (!Array.isArray(rawUndo)) return out
    for (let i = 0; i < rawUndo.length; i += 1) {
      const item = rawUndo[i]
      if (!item || typeof item !== 'object') continue
      const snapMoves = toInt(item.moves)
      if (!isFinite(snapMoves) || snapMoves < 0 || snapMoves > moves) continue
      if (!arrangementValid(item.pieces, level)) continue
      out.push({ pieces: copyPieces(item.pieces), moves: snapMoves })
      if (out.length >= UNDO_LIMIT) break
    }
    return out
  }

  function sanitizeBest(rawBest) {
    const out = {}
    if (!rawBest || typeof rawBest !== 'object') return out
    for (let i = 0; i < LEVELS.length; i += 1) {
      const value = rawBest[LEVELS[i].id]
      if (!value || typeof value !== 'object') continue
      const moves = toInt(value.moves)
      const elapsed = toInt(value.elapsedMs)
      if (isFinite(moves) && moves >= 1 && moves <= MAX_MOVES && isFinite(elapsed) && elapsed >= 0 && elapsed <= MAX_ELAPSED_MS) {
        out[LEVELS[i].id] = { moves: moves, elapsedMs: elapsed }
      }
    }
    return out
  }

  /** Validate a parsed save object; returns a clean state or null. */
  function sanitizeSave(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (raw.schemaVersion !== SCHEMA_VERSION) return null
    if (typeof raw.levelIndex !== 'number' || !Number.isInteger(raw.levelIndex)) return null
    const levelIndex = raw.levelIndex
    if (levelIndex < 0 || levelIndex >= LEVELS.length) return null
    const level = LEVELS[levelIndex]
    if (!arrangementValid(raw.pieces, level)) return null
    const moves = toStrictInt(raw.moves)
    if (!isFinite(moves) || moves < 0 || moves > MAX_MOVES) return null
    const elapsedMs = toStrictInt(raw.elapsedMs)
    if (!isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > MAX_ELAPSED_MS) return null
    if (typeof raw.started !== 'boolean' || typeof raw.won !== 'boolean') return null
    // Canonical piece order: every engine helper addresses pieces by their index
    // in the level definition, so re-order the saved array to match.
    const byId = Object.create(null)
    for (let i = 0; i < raw.pieces.length; i += 1) byId[raw.pieces[i].id] = raw.pieces[i]
    const pieces = level.pieces.map(function (levelPiece) {
      const saved = byId[levelPiece.id]
      return { id: levelPiece.id, x: toStrictInt(saved.x), y: toStrictInt(saved.y) }
    })
    const won = isWon({ levelIndex: levelIndex, pieces: pieces })
    if (raw.won !== won) return null
    return {
      levelIndex: levelIndex,
      pieces: pieces,
      moves: moves,
      elapsedMs: elapsedMs,
      started: raw.started,
      won: won,
      undo: sanitizeUndo(raw.undo, level, moves),
      best: sanitizeBest(raw.best),
    }
  }

  function serializeState(state) {
    return {
      schemaVersion: SCHEMA_VERSION,
      levelIndex: state.levelIndex,
      pieces: copyPieces(state.pieces),
      moves: state.moves,
      elapsedMs: Math.max(0, Math.round(state.elapsedMs)),
      started: state.started,
      won: state.won,
      undo: state.undo.slice(-UNDO_LIMIT).map(function (snap) {
        return { pieces: copyPieces(snap.pieces), moves: snap.moves }
      }),
      best: sanitizeBest(state.best),
    }
  }

  function getStorage() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage
    } catch (ignored) {
      /* fall through */
    }
    try {
      if (typeof window !== 'undefined' && window && window.localStorage) return window.localStorage
    } catch (ignored) {
      /* fall through */
    }
    return null
  }

  function loadSavedState() {
    try {
      const storage = getStorage()
      if (!storage) return null
      const raw = storage.getItem(STORE_KEY)
      if (!raw) return null
      return sanitizeSave(JSON.parse(raw))
    } catch (error) {
      return null
    }
  }

  function persistState(state) {
    try {
      const storage = getStorage()
      if (!storage) return false
      storage.setItem(STORE_KEY, JSON.stringify(serializeState(state)))
      return true
    } catch (error) {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Test seam (Node-only; never installed in the real host)
  // ---------------------------------------------------------------------------

  if (typeof window !== 'undefined' && window && window.__DSH_GAME_KLOTSKI_TEST__ === true) {
    try {
      Object.defineProperty(window, '__DSH_GAME_KLOTSKI__', {
        configurable: true,
        enumerable: false,
        value: {
          GAME_ID: GAME_ID,
          STORE_KEY: STORE_KEY,
          SCHEMA_VERSION: SCHEMA_VERSION,
          COLS: COLS,
          ROWS: ROWS,
          EXIT: EXIT,
          UNDO_LIMIT: UNDO_LIMIT,
          MIN_WIDTH: MIN_WIDTH,
          MIN_HEIGHT: MIN_HEIGHT,
          LEVELS: LEVELS,
          createState: createState,
          createGame: createGame,
          buildGrid: buildGrid,
          pieceAt: pieceAt,
          isWon: isWon,
          canSlide: canSlide,
          listMoves: listMoves,
          destinations: destinations,
          applySlide: applySlide,
          undoState: undoState,
          restartState: restartState,
          sanitizeSave: sanitizeSave,
          serializeState: serializeState,
          sanitizeBest: sanitizeBest,
          arrangementValid: arrangementValid,
          loadSavedState: loadSavedState,
          persistState: persistState,
          formatTime: formatTime,
        },
      })
    } catch (ignored) {
      /* non-fatal: tests can still exercise the factory through the module loader */
    }
  }

  // ---------------------------------------------------------------------------
  // DOM controller
  // ---------------------------------------------------------------------------

  const CSS = [
    '.dshklt-root{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;',
    'padding:10px 12px;outline:none;overflow:hidden;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    'color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-base,transparent);',
    'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}',
    '.dshklt-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:0;}',
    '.dshklt-title{font-size:15px;font-weight:800;letter-spacing:.5px;white-space:nowrap;}',
    '.dshklt-title small{font-weight:500;opacity:.6;font-size:11px;margin-left:4px;letter-spacing:0;}',
    '.dshklt-levels{display:flex;gap:5px;flex-wrap:wrap;}',
    '.dshklt-chip{border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-base,#fff);',
    'color:inherit;border-radius:999px;padding:2px 10px;font-size:12px;line-height:1.6;cursor:pointer;',
    'transition:background .12s,color .12s,border-color .12s;font-family:inherit;}',
    '.dshklt-chip:hover{border-color:#b3261e;color:#b3261e;}',
    '.dshklt-chip--active{background:#b3261e;border-color:#b3261e;color:#fff;}',
    '.dshklt-chip--active:hover{color:#fff;}',
    '.dshklt-meta{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px;',
    'color:var(--dsw-alias-label-secondary,#57606a);min-height:18px;}',
    '.dshklt-meta b{color:var(--dsw-alias-label-primary,#1f2328);font-variant-numeric:tabular-nums;font-weight:700;}',
    '.dshklt-actions{display:flex;gap:6px;margin-left:auto;}',
    '.dshklt-btn{font-family:inherit;font-size:12px;line-height:1.5;padding:4px 10px;border-radius:7px;',
    'border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-base,#fff);color:inherit;',
    'cursor:pointer;transition:background .12s,border-color .12s;}',
    '.dshklt-btn:hover:not(:disabled){border-color:#b3261e;color:#b3261e;}',
    '.dshklt-btn:disabled{opacity:.45;cursor:default;}',
    '.dshklt-btn--primary{background:#b3261e;border-color:#b3261e;color:#fff;}',
    '.dshklt-btn--primary:hover:not(:disabled){background:#98200f;color:#fff;}',
    '.dshklt-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;position:relative;}',
    '.dshklt-board-wrap{position:relative;flex:none;}',
    '.dshklt-board{position:relative;border-radius:12px;overflow:hidden;',
    'background:linear-gradient(135deg,rgba(255,255,255,.10),rgba(0,0,0,.10)),',
    'repeating-linear-gradient(90deg,rgba(255,255,255,.035) 0 2px,transparent 2px 9px),',
    'linear-gradient(180deg,#9a6a3c,#7a4d26 55%,#5f3a1b);',
    'box-shadow:inset 0 0 0 2px rgba(255,224,170,.30),inset 0 2px 14px rgba(0,0,0,.35),0 10px 30px rgba(0,0,0,.25);',
    'touch-action:manipulation;cursor:pointer;}',
    '.dshklt-board--won{box-shadow:inset 0 0 0 2px rgba(126,224,138,.85),0 0 26px rgba(126,224,138,.45),0 10px 30px rgba(0,0,0,.25);}',
    '.dshklt-cell{position:absolute;box-sizing:border-box;border:1px solid rgba(255,232,190,.13);',
    'background:rgba(0,0,0,.045);}',
    '.dshklt-cell:nth-child(even){background:rgba(0,0,0,.075);}',
    '.dshklt-piece{position:absolute;box-sizing:border-box;border-radius:8px;display:flex;align-items:center;',
    'justify-content:center;text-align:center;line-height:1.05;padding:2px;overflow:hidden;',
    'border:1px solid rgba(0,0,0,.22);box-shadow:0 3px 0 rgba(0,0,0,.26),inset 0 1px 0 rgba(255,255,255,.30);',
    'transition:left .13s ease,top .13s ease,box-shadow .15s ease,outline-color .12s ease;',
    'color:#fff;font-weight:800;letter-spacing:.5px;will-change:left,top;}',
    '.dshklt-piece--cao{background:linear-gradient(150deg,#f4776a,#c0342a 58%,#9d1f16);',
    'font-size:calc(var(--dshklt-cell,60px) * .40);text-shadow:0 2px 4px rgba(0,0,0,.38);',
    'letter-spacing:2px;outline:1px solid rgba(255,220,150,.55);outline-offset:-3px;}',
    '.dshklt-piece--guan{background:linear-gradient(150deg,#a582df,#7646b8 60%,#5c2f96);',
    'font-size:calc(var(--dshklt-cell,60px) * .32);text-shadow:0 1px 3px rgba(0,0,0,.32);}',
    '.dshklt-piece--general{background:linear-gradient(150deg,#6ba6dd,#3d79b4 60%,#275a8e);',
    'font-size:calc(var(--dshklt-cell,60px) * .30);text-shadow:0 1px 3px rgba(0,0,0,.32);}',
    '.dshklt-piece--soldier{background:linear-gradient(150deg,#e6d3a1,#c3a367 60%,#a5834a);color:#3a2a10;',
    'font-size:calc(var(--dshklt-cell,60px) * .34);text-shadow:0 1px 0 rgba(255,255,255,.35);}',
    '.dshklt-piece--selected{outline:3px solid #ffd27a;outline-offset:2px;z-index:6;',
    'box-shadow:0 0 0 2px rgba(255,210,122,.45),0 0 18px rgba(255,200,90,.5),0 3px 0 rgba(0,0,0,.26);}',
    '.dshklt-exit{position:absolute;box-sizing:border-box;border:2px dashed rgba(255,210,122,.85);border-radius:8px;',
    'pointer-events:none;display:flex;align-items:flex-end;justify-content:center;padding-bottom:2px;',
    'color:#ffd27a;font-size:calc(var(--dshklt-cell,60px) * .17);letter-spacing:3px;opacity:.95;',
    'text-shadow:0 1px 3px rgba(0,0,0,.6);transition:border-color .2s,box-shadow .2s,color .2s;}',
    '.dshklt-exit span{transform:translateY(1px);}',
    '.dshklt-exit--won{border-color:#7ee08a;color:#c9ffd0;box-shadow:0 0 20px rgba(126,224,138,.55),inset 0 0 20px rgba(126,224,138,.35);}',
    '.dshklt-marker{position:absolute;border-radius:50%;pointer-events:none;z-index:5;',
    'width:calc(var(--dshklt-cell,60px) * .30);height:calc(var(--dshklt-cell,60px) * .30);',
    'transform:translate(-50%,-50%);background:radial-gradient(circle at 35% 30%,#fff4c9,#ffc44d 60%,#f29b1e);',
    'box-shadow:0 0 10px rgba(255,190,70,.9),0 0 0 1px rgba(120,70,0,.25);',
    'animation:dshklt-pulse 1.15s ease-in-out infinite;}',
    '@keyframes dshklt-pulse{0%,100%{opacity:.85;transform:translate(-50%,-50%) scale(.92);}',
    '50%{opacity:1;transform:translate(-50%,-50%) scale(1.10);}}',
    '.dshklt-toast{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:30;',
    'background:rgba(18,22,28,.86);color:#fff;font-size:12px;line-height:1.5;padding:5px 14px;border-radius:999px;',
    'opacity:0;transition:opacity .18s ease;pointer-events:none;white-space:nowrap;max-width:92%;overflow:hidden;',
    'text-overflow:ellipsis;}',
    '.dshklt-toast--show{opacity:1;}',
    '.dshklt-win{position:absolute;inset:0;z-index:20;display:none;align-items:center;justify-content:center;',
    'background:rgba(8,12,18,.52);border-radius:12px;}',
    '.dshklt-win--show{display:flex;animation:dshklt-fade .22s ease;}',
    '@keyframes dshklt-fade{from{opacity:0;}to{opacity:1;}}',
    '.dshklt-win-card{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);',
    'border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:14px;padding:16px 20px;min-width:210px;',
    'max-width:88%;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.38);}',
    '.dshklt-win-title{font-size:17px;font-weight:900;color:#b3261e;margin:0 0 6px;letter-spacing:1px;}',
    '.dshklt-win-sub{font-size:12px;line-height:1.9;color:var(--dsw-alias-label-secondary,#57606a);margin-bottom:10px;}',
    '.dshklt-win-sub b{color:var(--dsw-alias-label-primary,#1f2328);}',
    '.dshklt-win-btns{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}',
    '.dshklt-too-small{position:absolute;inset:0;display:none;align-items:center;justify-content:center;',
    'text-align:center;font-size:13px;line-height:1.8;color:var(--dsw-alias-label-secondary,#57606a);padding:18px;}',
    '.dshklt-root--small .dshklt-top,.dshklt-root--small .dshklt-meta,.dshklt-root--small .dshklt-stage,',
    '.dshklt-root--small .dshklt-actions{display:none;}',
    '.dshklt-root--small .dshklt-too-small{display:flex;}',
    '.dshklt-fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;',
    'justify-content:center;gap:10px;padding:20px;text-align:center;font-size:13px;',
    'color:var(--dsw-alias-label-secondary,#57606a);background:var(--dsw-alias-bg-base,transparent);}',
    // 「规则」弹窗：与同系列其它游戏保持同一套几何与 token。
    '.dshklt-rules-mask{position:absolute;inset:0;z-index:40;display:none;align-items:center;justify-content:center;',
    'padding:20px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));}',
    '.dshklt-rules-mask--show{display:flex;}',
    '.dshklt-rules-card{width:min(560px,100%);max-height:86%;overflow:auto;border-radius:14px;',
    'background:var(--dsw-alias-bg-layer-2,#f1f3f5);border:1px solid var(--dsw-alias-border-l1,#d0d7de);',
    'box-shadow:0 12px 40px rgba(0,0,0,.3);outline:none;}',
    '.dshklt-rules-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:12px;',
    'padding:13px 18px;background:var(--dsw-alias-bg-layer-2,#f1f3f5);',
    'border-bottom:1px solid var(--dsw-alias-border-l1,#d0d7de);}',
    '.dshklt-rules-title{flex:1;font-size:15px;font-weight:600;}',
    '.dshklt-rules-close{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b949e);',
    'cursor:pointer;font-size:22px;line-height:1;padding:0 4px;border-radius:6px;font-family:inherit;}',
    '.dshklt-rules-body{padding:2px 18px 20px;}',
    '.dshklt-rules-body h3{font-size:12.5px;letter-spacing:.04em;color:var(--dsw-alias-label-primary,#1f2328);',
    'margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1,#d0d7de);font-weight:600;}',
    '.dshklt-rules-body ul{margin:8px 0;padding-left:19px;}',
    '.dshklt-rules-body li{font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary,#57606a);margin:6px 0;}',
    '.dshklt-rules-tip{font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary,#57606a);',
    'background:var(--dsw-alias-interactive-bg-hover,#eceff2);',
    'border-left:2px solid var(--dsw-alias-brand-primary,#2f81f7);',
    'border-radius:0 7px 7px 0;padding:9px 12px;margin:10px 0;}',
  ].join('')

  function addClass(element, className) {
    if (!element) return
    if (element.classList && typeof element.classList.add === 'function') element.classList.add(className)
    else element.className = (element.className ? element.className + ' ' : '') + className
  }

  function removeClass(element, className) {
    if (!element) return
    if (element.classList && typeof element.classList.remove === 'function') element.classList.remove(className)
    else element.className = String(element.className || '').split(/\s+/).filter(function (name) {
      return name && name !== className
    }).join(' ')
  }

  function setText(element, text) {
    if (element) element.textContent = text
  }

  function makeElement(doc, tag, className, text) {
    const element = doc.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }

  function blockLabel(piece) {
    return piece.name
  }

  /**
   * Build the interactive game inside `host`. Returns a controller with
   * destroy() plus a few read-only views used by the dev tests.
   */
  function createGame(host) {
    if (!host) throw new Error('createGame: host element is required')
    const doc = host.ownerDocument || (typeof document !== 'undefined' ? document : null)
    if (!doc) throw new Error('createGame: document is unavailable')

    let state = loadSavedState() || createState(0)
    let selected = null
    let layout = null
    let tooSmall = false
    let destroyed = false
    let hidden = typeof doc.hidden === 'boolean' ? doc.hidden === true : doc.visibilityState === 'hidden'
    let timing = false
    let elapsedBase = state.elapsedMs || 0
    let activeSince = 0
    let rafId = 0
    let lastAutosave = 0
    let lastDpr = 0
    let toastTimer = 0
    let layoutRaf = 0
    let observer = null
    let fallbackResize = false

    const elementMap = Object.create(null)
    const levelChips = []
    let pieceElements = []

    // ----- static DOM -------------------------------------------------------

    const root = makeElement(doc, 'div', 'dshklt-root')
    root.setAttribute('data-game', GAME_ID)
    root.setAttribute('tabindex', '0')
    root.setAttribute('aria-label', GAME_LABEL)

    const style = doc.createElement('style')
    style.textContent = CSS
    root.appendChild(style)

    const top = makeElement(doc, 'div', 'dshklt-top')
    const title = makeElement(doc, 'div', 'dshklt-title', GAME_LABEL)
    title.appendChild(makeElement(doc, 'small', '', '滑动解谜'))
    top.appendChild(title)

    const levelsRow = makeElement(doc, 'div', 'dshklt-levels')
    for (let i = 0; i < LEVELS.length; i += 1) {
      const chip = makeElement(doc, 'button', 'dshklt-chip', LEVELS[i].name)
      chip.setAttribute('type', 'button')
      chip.setAttribute('data-level-index', String(i))
      chip.setAttribute('title', LEVELS[i].name + '（最少 ' + LEVELS[i].par + ' 步）')
      levelsRow.appendChild(chip)
      levelChips.push(chip)
    }
    top.appendChild(levelsRow)

    const actionsTop = makeElement(doc, 'div', 'dshklt-actions')
    const undoButton = makeElement(doc, 'button', 'dshklt-btn', '撤销')
    undoButton.setAttribute('type', 'button')
    undoButton.setAttribute('data-action', 'undo')
    undoButton.setAttribute('title', '撤销上一步（Ctrl+Z）')
    const restartButton = makeElement(doc, 'button', 'dshklt-btn', '重开')
    restartButton.setAttribute('type', 'button')
    restartButton.setAttribute('data-action', 'restart')
    restartButton.setAttribute('title', '重开本关')
    const rulesButton = makeElement(doc, 'button', 'dshklt-btn', '📖 规则')
    rulesButton.setAttribute('type', 'button')
    rulesButton.setAttribute('data-action', 'rules')
    rulesButton.setAttribute('title', '查看规则与操作')
    rulesButton.setAttribute('aria-haspopup', 'dialog')
    actionsTop.appendChild(rulesButton)
    actionsTop.appendChild(undoButton)
    actionsTop.appendChild(restartButton)
    top.appendChild(actionsTop)
    root.appendChild(top)

    const meta = makeElement(doc, 'div', 'dshklt-meta')
    const movesWrap = makeElement(doc, 'span', '', '步数 ')
    const movesValue = makeElement(doc, 'b', '', '0')
    movesWrap.appendChild(movesValue)
    const timeWrap = makeElement(doc, 'span', '', '用时 ')
    const timeValue = makeElement(doc, 'b', '', '00:00')
    timeWrap.appendChild(timeValue)
    const parWrap = makeElement(doc, 'span', '', '最少 ')
    const parValue = makeElement(doc, 'b', '', String(LEVELS[0].par))
    parWrap.appendChild(parValue)
    meta.appendChild(movesWrap)
    meta.appendChild(timeWrap)
    meta.appendChild(parWrap)
    const bestWrap = makeElement(doc, 'span', '', '最佳 ')
    const bestValue = makeElement(doc, 'b', '', '—')
    bestWrap.appendChild(bestValue)
    meta.appendChild(bestWrap)
    root.appendChild(meta)

    const stage = makeElement(doc, 'div', 'dshklt-stage')
    const boardWrap = makeElement(doc, 'div', 'dshklt-board-wrap')
    const board = makeElement(doc, 'div', 'dshklt-board')
    board.setAttribute('role', 'grid')
    board.setAttribute('aria-label', '华容道棋盘，4 列 5 行')
    const cellsLayer = makeElement(doc, 'div', '')
    cellsLayer.style.position = 'absolute'
    cellsLayer.style.inset = '0'
    const markersLayer = makeElement(doc, 'div', '')
    markersLayer.style.position = 'absolute'
    markersLayer.style.inset = '0'
    markersLayer.style.pointerEvents = 'none'
    const piecesLayer = makeElement(doc, 'div', '')
    piecesLayer.style.position = 'absolute'
    piecesLayer.style.inset = '0'
    const exitEl = makeElement(doc, 'div', 'dshklt-exit')
    exitEl.appendChild(makeElement(doc, 'span', '', '出口'))
    board.appendChild(cellsLayer)
    board.appendChild(piecesLayer)
    board.appendChild(markersLayer)
    board.appendChild(exitEl)
    boardWrap.appendChild(board)

    const winOverlay = makeElement(doc, 'div', 'dshklt-win')
    const winCard = makeElement(doc, 'div', 'dshklt-win-card')
    const winTitle = makeElement(doc, 'div', 'dshklt-win-title', '曹操已到出口！')
    const winSub = makeElement(doc, 'div', 'dshklt-win-sub', '')
    const winButtons = makeElement(doc, 'div', 'dshklt-win-btns')
    const nextButton = makeElement(doc, 'button', 'dshklt-btn dshklt-btn--primary', '下一关')
    nextButton.setAttribute('type', 'button')
    nextButton.setAttribute('data-action', 'next')
    const replayButton = makeElement(doc, 'button', 'dshklt-btn', '重玩本关')
    replayButton.setAttribute('type', 'button')
    replayButton.setAttribute('data-action', 'replay')
    const closeButton = makeElement(doc, 'button', 'dshklt-btn', '关掉')
    closeButton.setAttribute('type', 'button')
    closeButton.setAttribute('data-action', 'close-win')
    winButtons.appendChild(nextButton)
    winButtons.appendChild(replayButton)
    winButtons.appendChild(closeButton)
    winCard.appendChild(winTitle)
    winCard.appendChild(winSub)
    winCard.appendChild(winButtons)
    winOverlay.appendChild(winCard)
    boardWrap.appendChild(winOverlay)
    stage.appendChild(boardWrap)
    root.appendChild(stage)

    const actionsBottom = makeElement(doc, 'div', 'dshklt-actions')
    actionsBottom.style.display = 'none'
    root.appendChild(actionsBottom)

    const toast = makeElement(doc, 'div', 'dshklt-toast')
    root.appendChild(toast)

    const tooSmallEl = makeElement(doc, 'div', 'dshklt-too-small', '窗口太小，放大一点再玩')
    root.appendChild(tooSmallEl)

    /* ----- rules dialog -----------------------------------------------------
     * 纯 DOM 搭建：和胜利卡片同一层（绝对定位 + 遮罩），打开时盖住整块舞台。
     * 文本里以 "!" 开头的片段渲染成 <b>，其余是普通文字。 */
    const RULES_SECTIONS = [
      {
        title: '一、目标',
        items: [
          ['棋盘 ', '!4 列 × 5 行', '（20 格），10 个棋子 + 2 个空格。'],
          ['挪开挡路的棋子，把 ', '!曹操（2×2）', ' 移到最下面两行的中间 —— 也就是出口 —— 就算过关。'],
        ],
      },
      {
        title: '二、棋子',
        items: [
          ['曹操 2×2；关羽 2×1（横）；张飞 / 赵云 / 马超 / 黄忠各 1×2（竖）；兵 ×4 各 1×1。'],
          ['棋子形状固定，', '!不能旋转', '。'],
        ],
      },
      {
        title: '三、怎么走',
        items: [
          ['点棋子选中，它所有能走的落点会显示金色圆点；点圆点或目标空格就能移动。'],
          ['一步可以滑 1 格，也可以滑 2 格；但滑 2 格的路径必须', '!全部是空格', '，不能穿过别的棋子。'],
          ['不能重叠、不能出界。再点一次已选中的棋子可取消选中。'],
          ['键盘：方向键移动 1 格，Shift + 方向键尝试 2 格，Esc 取消选中，Ctrl / Cmd + Z 撤销。'],
        ],
      },
      {
        title: '四、关卡与记录',
        items: [
          ['四个关卡：横刀立马（最少 90 步）、指挥若定（90）、齐头并进（76）、层层设防（77）。'],
          ['「最少步数」是在本作规则下用 BFS 求出的最短解，可以当作目标。'],
          ['状态栏显示步数、用时、本关最少步数与最佳记录（步数优先，步数相同比用时）。'],
        ],
      },
      {
        tip: '曹操要下到底，必须先给它腾出 2 格宽的直通道：先想「哪两列能让它一路直下」，再倒推该把谁挪开。兵最灵活，常用来临时占位把大棋子挤开。',
      },
    ]

    const rulesMask = makeElement(doc, 'div', 'dshklt-rules-mask')
    const rulesCard = makeElement(doc, 'div', 'dshklt-rules-card')
    rulesCard.setAttribute('role', 'dialog')
    rulesCard.setAttribute('aria-modal', 'true')
    rulesCard.setAttribute('aria-label', '华容道规则')
    rulesCard.setAttribute('tabindex', '-1')
    const rulesHead = makeElement(doc, 'div', 'dshklt-rules-head')
    rulesHead.appendChild(makeElement(doc, 'span', 'dshklt-rules-title', '华容道 · 规则与操作'))
    const rulesCloseButton = makeElement(doc, 'button', 'dshklt-rules-close', '×')
    rulesCloseButton.setAttribute('type', 'button')
    rulesCloseButton.setAttribute('aria-label', '关闭')
    rulesHead.appendChild(rulesCloseButton)
    rulesCard.appendChild(rulesHead)
    const rulesBody = makeElement(doc, 'div', 'dshklt-rules-body')
    for (let sectionIndex = 0; sectionIndex < RULES_SECTIONS.length; sectionIndex += 1) {
      const section = RULES_SECTIONS[sectionIndex]
      if (section.tip) {
        rulesBody.appendChild(makeElement(doc, 'div', 'dshklt-rules-tip', section.tip))
        continue
      }
      rulesBody.appendChild(makeElement(doc, 'h3', '', section.title))
      const list = makeElement(doc, 'ul')
      for (let itemIndex = 0; itemIndex < section.items.length; itemIndex += 1) {
        const item = section.items[itemIndex]
        const line = makeElement(doc, 'li')
        for (let partIndex = 0; partIndex < item.length; partIndex += 1) {
          const part = item[partIndex]
          // "!" 前缀表示这段文字加粗。只用 createElement（不用 createTextNode），
          // 这样 dev/audit 里的极简假 DOM 也能渲染。
          const bold = part.charAt(0) === '!'
          line.appendChild(makeElement(doc, bold ? 'b' : 'span', '', bold ? part.slice(1) : part))
        }
        list.appendChild(line)
      }
      rulesBody.appendChild(list)
    }
    rulesCard.appendChild(rulesBody)
    rulesMask.appendChild(rulesCard)
    root.appendChild(rulesMask)

    function openRules() {
      addClass(rulesMask, 'dshklt-rules-mask--show')
      try {
        rulesCard.focus()
      } catch (focusError) {
        // focus is a nicety; the dialog still works without it
      }
    }

    function closeRules() {
      removeClass(rulesMask, 'dshklt-rules-mask--show')
    }

    function rulesOpen() {
      return String(rulesMask.className || '').indexOf('dshklt-rules-mask--show') >= 0
    }

    host.appendChild(root)

    // ----- static board grid ------------------------------------------------

    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const cell = makeElement(doc, 'div', 'dshklt-cell')
        cell.style.left = x * (100 / COLS) + '%'
        cell.style.top = y * (100 / ROWS) + '%'
        cell.style.width = 100 / COLS + '%'
        cell.style.height = 100 / ROWS + '%'
        cellsLayer.appendChild(cell)
      }
    }

    function placeExit() {
      exitEl.style.left = EXIT.x * (100 / COLS) + '%'
      exitEl.style.top = EXIT.y * (100 / ROWS) + '%'
      exitEl.style.width = EXIT.w * (100 / COLS) + '%'
      exitEl.style.height = EXIT.h * (100 / ROWS) + '%'
    }
    placeExit()

    // ----- rendering helpers ------------------------------------------------

    function levelPieceDefs() {
      return LEVELS[state.levelIndex].pieces
    }

    function rebuildPieces() {
      for (let i = 0; i < pieceElements.length; i += 1) {
        if (pieceElements[i].parentNode === piecesLayer) piecesLayer.removeChild(pieceElements[i])
        else if (pieceElements[i].remove) pieceElements[i].remove()
      }
      pieceElements = []
      const defs = levelPieceDefs()
      for (let i = 0; i < state.pieces.length; i += 1) {
        const piece = state.pieces[i]
        const pieceDef = defs[i]
        if (!pieceDef) continue
        const pieceEl = makeElement(doc, 'div', 'dshklt-piece dshklt-piece--' + pieceDef.kind)
        pieceEl.setAttribute('data-piece-id', piece.id)
        pieceEl.setAttribute('title', pieceDef.name)
        const label = makeElement(doc, 'span', '', blockLabel(pieceDef))
        pieceEl.appendChild(label)
        pieceEl.style.left = piece.x * (100 / COLS) + '%'
        pieceEl.style.top = piece.y * (100 / ROWS) + '%'
        pieceEl.style.width = pieceDef.w * (100 / COLS) + '%'
        pieceEl.style.height = pieceDef.h * (100 / ROWS) + '%'
        piecesLayer.appendChild(pieceEl)
        pieceElements.push(pieceEl)
      }
      elementMap.piecesLayer = piecesLayer
    }

    function renderPieces() {
      for (let i = 0; i < pieceElements.length; i += 1) {
        const pieceEl = pieceElements[i]
        const piece = state.pieces[i]
        if (!piece) continue
        pieceEl.style.left = piece.x * (100 / COLS) + '%'
        pieceEl.style.top = piece.y * (100 / ROWS) + '%'
        if (i === selected) addClass(pieceEl, 'dshklt-piece--selected')
        else removeClass(pieceEl, 'dshklt-piece--selected')
      }
    }

    function renderMarkers() {
      while (markersLayer.firstChild) markersLayer.removeChild(markersLayer.firstChild)
      if (selected === null || state.won) return
      const map = destinations(state, selected)
      const keys = Object.keys(map)
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i]
        const move = map[key]
        const cell = key.split(',')
        const marker = makeElement(doc, 'div', 'dshklt-marker')
        marker.setAttribute('data-target', key)
        marker.setAttribute('data-dest', move.x + ',' + move.y)
        marker.setAttribute('data-cell', key)
        marker.style.left = (Number(cell[0]) + 0.5) * (100 / COLS) + '%'
        marker.style.top = (Number(cell[1]) + 0.5) * (100 / ROWS) + '%'
        markersLayer.appendChild(marker)
      }
    }

    function bestForCurrentLevel() {
      return state.best && state.best[LEVELS[state.levelIndex].id]
    }

    function renderMeta() {
      setText(movesValue, String(state.moves))
      setText(timeValue, formatTime(currentElapsed()))
      setText(parValue, String(LEVELS[state.levelIndex].par))
      const best = bestForCurrentLevel()
      setText(bestValue, best ? best.moves + ' 步' : '—')
      undoButton.disabled = state.undo.length === 0 || state.won
    }

    function renderChips() {
      for (let i = 0; i < levelChips.length; i += 1) {
        if (i === state.levelIndex) addClass(levelChips[i], 'dshklt-chip--active')
        else removeClass(levelChips[i], 'dshklt-chip--active')
        levelChips[i].setAttribute('aria-pressed', i === state.levelIndex ? 'true' : 'false')
      }
    }

    function renderWin() {
      if (!state.won) {
        removeClass(winOverlay, 'dshklt-win--show')
        removeClass(board, 'dshklt-board--won')
        removeClass(exitEl, 'dshklt-exit--won')
        return
      }
      addClass(board, 'dshklt-board--won')
      addClass(exitEl, 'dshklt-exit--won')
      addClass(winOverlay, 'dshklt-win--show')
      const level = LEVELS[state.levelIndex]
      const best = bestForCurrentLevel()
      const record = best && best.moves === state.moves && best.elapsedMs === Math.round(state.elapsedMs)
      setText(
        winSub,
        level.name +
          ' · 步数 ' +
          state.moves +
          '（最少 ' +
          level.par +
          '） · 用时 ' +
          formatTime(state.elapsedMs) +
          (record ? ' · 新纪录！' : best ? ' · 最佳 ' + best.moves + ' 步' : ''),
      )
      const isLast = state.levelIndex >= LEVELS.length - 1
      setText(nextButton, isLast ? '再玩一次' : '下一关')
      nextButton.setAttribute('data-action', isLast ? 'replay' : 'next')
    }

    function renderAll() {
      rebuildPiecesIfNeeded()
      renderPieces()
      renderMarkers()
      renderMeta()
      renderChips()
      renderWin()
    }

    let renderedLevelIndex = -1
    function rebuildPiecesIfNeeded() {
      if (renderedLevelIndex === state.levelIndex && pieceElements.length === state.pieces.length) return
      renderedLevelIndex = state.levelIndex
      rebuildPieces()
    }

    // ----- timer ------------------------------------------------------------

    function currentElapsed() {
      if (!timing) return elapsedBase
      return elapsedBase + Math.max(0, nowMs() - activeSince)
    }

    function scheduleTick() {
      if (rafId || destroyed) return
      const raf =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : function (fn) {
              return setTimeout(fn, 16)
            }
      rafId = raf(function tick() {
        rafId = 0
        if (!timing || destroyed) return
        const value = currentElapsed()
        state.elapsedMs = Math.round(value)
        setText(timeValue, formatTime(value))
        const stamp = nowMs()
        if (stamp - lastAutosave >= AUTOSAVE_MS) {
          lastAutosave = stamp
          persist()
        }
        scheduleTick()
      })
    }

    function startTimer() {
      if (timing || destroyed || hidden || state.won || !state.started) return
      activeSince = nowMs()
      timing = true
      lastAutosave = activeSince
      scheduleTick()
    }

    function stopTimer(commit) {
      if (!timing) {
        if (commit) state.elapsedMs = Math.round(elapsedBase)
        return
      }
      elapsedBase = Math.max(0, elapsedBase + Math.max(0, nowMs() - activeSince))
      timing = false
      if (rafId) {
        try {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
          else clearTimeout(rafId)
        } catch (ignored) {
          /* ignore */
        }
        rafId = 0
      }
      if (commit) state.elapsedMs = Math.round(elapsedBase)
    }

    function resetClock() {
      stopTimer(false)
      elapsedBase = 0
      state.elapsedMs = 0
      setText(timeValue, formatTime(0))
    }

    // ----- persistence ------------------------------------------------------

    function persist() {
      if (destroyed) return false
      try {
        state.elapsedMs = Math.round(currentElapsed())
        return persistState(state)
      } catch (error) {
        return false
      }
    }

    // ----- toast / errors ---------------------------------------------------

    function toastMessage(message, duration) {
      try {
        setText(toast, message)
        addClass(toast, 'dshklt-toast--show')
        if (toastTimer) {
          if (typeof clearTimeout === 'function') clearTimeout(toastTimer)
          toastTimer = 0
        }
        toastTimer = setTimeout(function () {
          toastTimer = 0
          removeClass(toast, 'dshklt-toast--show')
        }, duration || 1600)
      } catch (ignored) {
        /* ignore */
      }
    }

    function showFatal(message) {
      try {
        while (winCard.firstChild) winCard.removeChild(winCard.firstChild)
        const title = makeElement(doc, 'div', 'dshklt-win-title', '华容道出错了')
        const sub = makeElement(doc, 'div', 'dshklt-win-sub', message || '试试重新开始本关。')
        const retry = makeElement(doc, 'button', 'dshklt-btn dshklt-btn--primary', '重开本关')
        retry.setAttribute('type', 'button')
        retry.addEventListener('click', function () {
          try {
            doRestart()
          } catch (ignored) {
            /* ignore */
          }
        })
        const buttons = makeElement(doc, 'div', 'dshklt-win-btns')
        buttons.appendChild(retry)
        winCard.appendChild(title)
        winCard.appendChild(sub)
        winCard.appendChild(buttons)
        addClass(winOverlay, 'dshklt-win--show')
      } catch (ignored) {
        /* ignore */
      }
    }

    function handleError(error) {
      try {
        if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
          console.error('[klotski]', error)
        }
      } catch (ignored) {
        /* ignore */
      }
      toastMessage('操作失败，已保留当前进度')
    }

    // ----- actions ----------------------------------------------------------

    function doMove(pieceIndex, dx, dy, step) {
      if (state.won || destroyed) return false
      const next = applySlide(state, pieceIndex, dx, dy, step)
      if (!next) {
        toastMessage('这个方向走不通')
        return false
      }
      const wasStarted = state.started
      state = next
      selected = null
      if (!wasStarted) {
        elapsedBase = state.elapsedMs || 0
        startTimer()
      }
      if (state.won) {
        stopTimer(true)
        updateBest()
      }
      renderAll()
      persist()
      if (state.won) renderWin()
      return true
    }

    function updateBest() {
      const levelId = LEVELS[state.levelIndex].id
      const previous = state.best[levelId]
      const record = { moves: state.moves, elapsedMs: Math.round(state.elapsedMs) }
      if (!previous || record.moves < previous.moves || (record.moves === previous.moves && record.elapsedMs < previous.elapsedMs)) {
        state.best = Object.assign({}, state.best)
        state.best[levelId] = record
      }
    }

    function doUndo() {
      if (state.won || destroyed) return
      const next = undoState(state)
      if (!next) {
        toastMessage('没有可撤销的步骤')
        return
      }
      state = next
      selected = null
      if (state.moves === 0) {
        resetClock()
        state.started = false
      }
      renderAll()
      persist()
      toastMessage('已撤销一步')
    }

    function doRestart() {
      if (destroyed) return
      const best = state.best
      state = createState(state.levelIndex, best)
      selected = null
      resetClock()
      lastDpr = 0
      renderAll()
      persist()
      toastMessage('已重开「' + LEVELS[state.levelIndex].name + '」')
    }

    function doSetLevel(index) {
      if (destroyed) return
      const target = clampInt(index, 0, LEVELS.length - 1)
      if (target === state.levelIndex) {
        toastMessage('已在「' + LEVELS[target].name + '」')
        return
      }
      saveBeforeLevelSwitch()
      state = createState(target, state.best)
      selected = null
      resetClock()
      renderAll()
      persist()
      toastMessage('切换到「' + LEVELS[target].name + '」 · 最少 ' + LEVELS[target].par + ' 步')
    }

    function saveBeforeLevelSwitch() {
      try {
        stopTimer(true)
        persistState(state)
      } catch (ignored) {
        /* ignore */
      }
    }

    function doCloseWin() {
      removeClass(winOverlay, 'dshklt-win--show')
      toastMessage('已通关 · 可换关或重开')
    }

    // ----- layout -----------------------------------------------------------

    function computeLayout() {
      if (destroyed) return
      const width = host.clientWidth || 0
      const height = host.clientHeight || 0
      const small = width < MIN_WIDTH || height < MIN_HEIGHT
      tooSmall = small
      if (small) addClass(root, 'dshklt-root--small')
      else removeClass(root, 'dshklt-root--small')
      if (small) {
        layout = null
        return
      }
      const stageWidth = stage.clientWidth || width
      const stageHeight = stage.clientHeight || Math.max(240, height - 96)
      const usableWidth = Math.max(80, stageWidth - 10)
      const usableHeight = Math.max(100, stageHeight - 10)
      const cell = Math.max(22, Math.floor(Math.min(usableWidth / COLS, usableHeight / ROWS)))
      const boardWidth = cell * COLS
      const boardHeight = cell * ROWS
      board.style.width = boardWidth + 'px'
      board.style.height = boardHeight + 'px'
      board.style.setProperty('--dshklt-cell', cell + 'px')
      board.style.setProperty('--dshklt-gap', Math.max(1, Math.round(cell * 0.035)) + 'px')
      layout = { cell: cell, boardWidth: boardWidth, boardHeight: boardHeight }
      const dpr = (typeof window !== 'undefined' && window && window.devicePixelRatio) || 1
      if (dpr !== lastDpr) lastDpr = dpr
    }

    function scheduleLayout() {
      if (destroyed || layoutRaf) return
      const raf =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : function (fn) {
              return setTimeout(fn, 16)
            }
      layoutRaf = raf(function () {
        layoutRaf = 0
        try {
          computeLayout()
        } catch (error) {
          handleError(error)
        }
      })
    }

    // ----- input ------------------------------------------------------------

    function eventCell(event) {
      if (!layout || !board) return null
      const rect = board.getBoundingClientRect ? board.getBoundingClientRect() : null
      if (!rect) return null
      const x = Math.floor((event.clientX - rect.left) / layout.cell)
      const y = Math.floor((event.clientY - rect.top) / layout.cell)
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return null
      return { x: x, y: y }
    }

    function onBoardClick(event) {
      try {
        if (destroyed) return
        const cell = eventCell(event)
        if (!cell) return
        const owner = pieceAt(state, cell.x, cell.y)
        if (owner !== -1) {
          if (selected === owner) {
            selected = null
          } else {
            selected = owner
            const map = destinations(state, owner)
            if (Object.keys(map).length === 0) toastMessage(LEVELS[state.levelIndex].pieces[owner].name + ' 暂时动不了')
          }
          renderPieces()
          renderMarkers()
          return
        }
        if (selected !== null) {
          const map = destinations(state, selected)
          const move = map[cell.x + ',' + cell.y]
          if (move) {
            doMove(move.pieceIndex, move.dx, move.dy, move.step)
            return
          }
          selected = null
          renderPieces()
          renderMarkers()
        }
      } catch (error) {
        handleError(error)
      }
    }

    function onKeyDown(event) {
      try {
        if (destroyed || !event) return
        if (event.defaultPrevented) return
        // The rules dialog owns the keyboard while it is open.
        if (rulesOpen()) return
        if (state.won) return
        const key = event.key
        if (key === 'Escape') {
          if (selected !== null) {
            selected = null
            renderPieces()
            renderMarkers()
          }
          return
        }
        if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'Z')) {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          doUndo()
          return
        }
        const dirs = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        }
        const dir = dirs[key]
        if (!dir) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (selected === null) return
        let step = event.shiftKey ? 2 : 1
        let move = null
        for (let s = step; s >= 1 && !move; s -= 1) {
          if (canSlide(state, selected, dir[0], dir[1], s)) move = { dx: dir[0], dy: dir[1], step: s }
        }
        if (move) doMove(selected, move.dx, move.dy, move.step)
      } catch (error) {
        handleError(error)
      }
    }

    function onPointerDown() {
      try {
        if (root.focus) root.focus()
      } catch (ignored) {
        /* ignore */
      }
    }

    function onVisibilityChange() {
      try {
        if (destroyed) return
        const isHidden = typeof doc.hidden === 'boolean' ? doc.hidden === true : doc.visibilityState === 'hidden'
        if (isHidden === hidden) return
        hidden = isHidden
        if (hidden) {
          stopTimer(true)
          persist()
        } else if (state.started && !state.won) {
          startTimer()
        }
      } catch (error) {
        handleError(error)
      }
    }

    function onResizeFallback() {
      scheduleLayout()
    }

    // ----- wiring -----------------------------------------------------------

    board.addEventListener('click', onBoardClick)
    root.addEventListener('pointerdown', onPointerDown)
    root.addEventListener('keydown', onKeyDown)
    undoButton.addEventListener('click', function () {
      try {
        if (undoButton.disabled) return
        doUndo()
      } catch (error) {
        handleError(error)
      }
    })
    restartButton.addEventListener('click', function () {
      try {
        doRestart()
      } catch (error) {
        handleError(error)
      }
    })
    rulesButton.addEventListener('click', function () {
      try {
        openRules()
      } catch (error) {
        handleError(error)
      }
    })
    rulesCloseButton.addEventListener('click', function () {
      closeRules()
    })
    rulesMask.addEventListener('mousedown', function (event) {
      if (event && event.target === rulesMask) closeRules()
    })
    rulesCard.addEventListener('keydown', function (event) {
      // Modal: swallow every key so the board behind does not react.
      if (!event) return
      if (typeof event.stopPropagation === 'function') event.stopPropagation()
      if (event.key === 'Escape') closeRules()
    })
    for (let i = 0; i < levelChips.length; i += 1) {
      (function (index) {
        levelChips[index].addEventListener('click', function () {
          try {
            doSetLevel(index)
          } catch (error) {
            handleError(error)
          }
        })
      })(i)
    }
    nextButton.addEventListener('click', function () {
      try {
        if (nextButton.getAttribute('data-action') === 'replay') doRestart()
        else doSetLevel(state.levelIndex + 1)
      } catch (error) {
        handleError(error)
      }
    })
    replayButton.addEventListener('click', function () {
      try {
        doRestart()
      } catch (error) {
        handleError(error)
      }
    })
    closeButton.addEventListener('click', function () {
      try {
        doCloseWin()
      } catch (error) {
        handleError(error)
      }
    })

    try {
      doc.addEventListener('visibilitychange', onVisibilityChange)
    } catch (ignored) {
      /* ignore */
    }

    try {
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(function () {
          scheduleLayout()
        })
        observer.observe(host)
        observer.observe(stage)
      } else {
        fallbackResize = true
        if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', onResizeFallback)
        }
      }
    } catch (ignored) {
      fallbackResize = true
    }

    // ----- boot -------------------------------------------------------------

    try {
      if (state.started && !state.won) elapsedBase = state.elapsedMs || 0
      else elapsedBase = state.elapsedMs || 0
      renderAll()
      computeLayout()
      if (state.started && !state.won) startTimer()
    } catch (error) {
      handleError(error)
    }

    // ----- teardown ---------------------------------------------------------

    function destroy() {
      if (destroyed) return
      try {
        stopTimer(true)
        persist()
      } catch (ignored) {
        /* ignore */
      }
      destroyed = true
      try {
        if (observer && typeof observer.disconnect === 'function') observer.disconnect()
      } catch (ignored) {
        /* ignore */
      }
      try {
        if (fallbackResize && typeof window !== 'undefined' && window && typeof window.removeEventListener === 'function') {
          window.removeEventListener('resize', onResizeFallback)
        }
        doc.removeEventListener('visibilitychange', onVisibilityChange)
        root.removeEventListener('pointerdown', onPointerDown)
        root.removeEventListener('keydown', onKeyDown)
        board.removeEventListener('click', onBoardClick)
      } catch (ignored) {
        /* ignore */
      }
      try {
        if (rafId) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
          else clearTimeout(rafId)
          rafId = 0
        }
        if (layoutRaf) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(layoutRaf)
          else clearTimeout(layoutRaf)
          layoutRaf = 0
        }
        if (toastTimer) {
          clearTimeout(toastTimer)
          toastTimer = 0
        }
      } catch (ignored) {
        /* ignore */
      }
      try {
        if (root.parentNode) root.parentNode.removeChild(root)
        else if (root.remove) root.remove()
      } catch (ignored) {
        /* ignore */
      }
    }

    return {
      destroy: destroy,
      save: persist,
      getState: function () {
        return state
      },
      getView: function () {
        return {
          levelIndex: state.levelIndex,
          moves: state.moves,
          elapsedMs: Math.round(currentElapsed()),
          started: state.started,
          won: state.won,
          selected: selected,
          timing: timing,
          hidden: hidden,
          tooSmall: tooSmall,
          layout: layout ? { cell: layout.cell, boardWidth: layout.boardWidth, boardHeight: layout.boardHeight } : null,
          best: state.best,
        }
      },
      __test: {
        root: root,
        board: board,
        stage: stage,
        piecesLayer: piecesLayer,
        markersLayer: markersLayer,
        winOverlay: winOverlay,
        levelChips: levelChips,
        undoButton: undoButton,
        restartButton: restartButton,
        computeLayout: computeLayout,
        scheduleLayout: scheduleLayout,
        doSetLevel: doSetLevel,
        doMove: doMove,
        doUndo: doUndo,
        doRestart: doRestart,
        selectPiece: function (index) {
          selected = index
          renderPieces()
          renderMarkers()
        },
        clickCell: function (x, y) {
          const rect = board.getBoundingClientRect()
          const cell = layout ? layout.cell : 0
          if (!cell) return
          onBoardClick({ clientX: rect.left + (x + 0.5) * cell, clientY: rect.top + (y + 0.5) * cell })
        },
        persist: persist,
        toastMessage: toastMessage,
      },
    }
  }

  // ---------------------------------------------------------------------------
  // React component + slot registration
  // ---------------------------------------------------------------------------

  window.__ModuleLoader__.load({
    id: '@local/dsh-game-klotski',
    factory(require) {
      const React = require('react')
      const h = React.createElement

      class ErrorBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }

        static getDerivedStateFromError(error) {
          return { error: error }
        }

        componentDidCatch(error) {
          try {
            if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
              console.error('[klotski] component error', error)
            }
          } catch (ignored) {
            /* ignore */
          }
        }

        render() {
          if (this.state.error) {
            return h(
              'div',
              {
                style: {
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  fontSize: '13px',
                  color: 'var(--dsw-alias-label-secondary, #57606a)',
                },
              },
              h('div', null, '华容道出错了'),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => this.setState({ error: null }),
                  style: {
                    padding: '4px 12px',
                    borderRadius: '7px',
                    border: '1px solid var(--dsw-alias-border-l1, #d0d7de)',
                    background: 'var(--dsw-alias-bg-base, #fff)',
                    color: 'inherit',
                    cursor: 'pointer',
                  },
                },
                '重试',
              ),
            )
          }
          return this.props.children
        }
      }

      function Game() {
        const hostRef = React.useRef(null)
        React.useEffect(function () {
          const host = hostRef.current
          if (!host) return undefined
          let game = null
          try {
            game = createGame(host)
            try {
              // Dev-preview / automation handle; harmless on the host element.
              host.__dshKlotskiGame = game
            } catch (ignored) {
              /* ignore */
            }
          } catch (error) {
            try {
              if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
                console.error('[klotski] mount failed', error)
              }
            } catch (ignored) {
              /* ignore */
            }
            const fallback = host.ownerDocument.createElement('div')
            fallback.className = 'dshklt-fallback'
            fallback.textContent = '华容道加载失败，切走再回来或刷新重试'
            host.appendChild(fallback)
            return function () {
              try {
                if (fallback.parentNode) fallback.parentNode.removeChild(fallback)
              } catch (ignored) {
                /* ignore */
              }
            }
          }
          return function () {
            try {
              if (host && host.__dshKlotskiGame) delete host.__dshKlotskiGame
            } catch (ignored) {
              /* ignore */
            }
            try {
              if (game) game.destroy()
            } catch (ignored) {
              /* ignore */
            }
          }
        }, [])
        return h('div', {
          ref: hostRef,
          style: { width: '100%', height: '100%', position: 'relative', outline: 'none' },
        })
      }

      function GameEntry() {
        return h(ErrorBoundary, null, h(Game))
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.inject('game.stage', () =>
            ctx.slots.register(
              {
                name: 'game.stage',
                id: GAME_ID,
                label: () => GAME_LABEL,
                select: ({ gameId }) => (gameId === GAME_ID ? {} : null),
              },
              GameEntry,
            ),
          )
        },
      }
    },
  })
})()
