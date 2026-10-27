/**
 * Independent oracle for Klotski rules, written from handoff/to-sub/011-add-klotski.md:
 *
 *   - board 4 columns x 5 rows
 *   - move = translate one piece 1 or 2 cells along a clear path
 *   - never rotate, never overlap, never leave the board
 *   - win = Cao Cao (2x2) top-left reaches (col 1, row 3)
 *
 * Pieces are addressed by index into the level definition; only w/h come from
 * the level definition (`level.pieces[i].w/h`) so this module owns every rule.
 * It deliberately shares no code with client.js or dev/solve.mjs.
 */

export const COLS = 4
export const ROWS = 5
export const EXIT = { x: 1, y: 3, w: 2, h: 2 }
export const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

export function pieceDef(level, i) {
  return level.pieces[i]
}

/** Occupancy grid: -1 empty, otherwise piece index. Throws on out-of-bounds/overlap. */
export function occupancy(positions, level) {
  const grid = new Int8Array(COLS * ROWS).fill(-1)
  for (let i = 0; i < positions.length; i += 1) {
    const def = level.pieces[i]
    const p = positions[i]
    for (let dy = 0; dy < def.h; dy += 1) {
      for (let dx = 0; dx < def.w; dx += 1) {
        const x = p.x + dx
        const y = p.y + dy
        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) {
          throw new Error('oracle: piece ' + i + ' out of bounds at ' + x + ',' + y)
        }
        const cell = y * COLS + x
        if (grid[cell] !== -1) throw new Error('oracle: overlap at ' + x + ',' + y)
        grid[cell] = i
      }
    }
  }
  return grid
}

/** Full spec-level validation of an arrangement. */
export function validateArrangement(positions, level) {
  if (!Array.isArray(positions) || positions.length !== level.pieces.length) {
    return { ok: false, reason: 'piece count' }
  }
  const grid = new Int8Array(COLS * ROWS).fill(-1)
  for (let i = 0; i < positions.length; i += 1) {
    const def = level.pieces[i]
    const p = positions[i]
    if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y)) return { ok: false, reason: 'non-integer coords' }
    if (p.x < 0 || p.y < 0 || p.x + def.w > COLS || p.y + def.h > ROWS) {
      return { ok: false, reason: 'out of bounds' }
    }
    for (let dy = 0; dy < def.h; dy += 1) {
      for (let dx = 0; dx < def.w; dx += 1) {
        const cell = (p.y + dy) * COLS + (p.x + dx)
        if (grid[cell] !== -1) return { ok: false, reason: 'overlap' }
        grid[cell] = i
      }
    }
  }
  let empty = 0
  for (let i = 0; i < grid.length; i += 1) if (grid[i] === -1) empty += 1
  return { ok: true, grid, empty }
}

/**
 * Can piece `i` slide `step` (1 or 2) cells in (dx, dy)?
 * Every cell the piece would enter at each intermediate offset must be empty.
 * Rotation (both dx and dy non-zero), step 0/3, out-of-board and blocked paths
 * are rejected. A winning state does NOT change slide legality here.
 */
export function canSlide(positions, level, i, dx, dy, step) {
  if (!(dx === 0 || dy === 0)) return false
  if (dx === 0 && dy === 0) return false
  if (step !== 1 && step !== 2) return false
  if (!Number.isInteger(i) || i < 0 || i >= positions.length) return false
  const def = level.pieces[i]
  const p = positions[i]
  const nx = p.x + dx * step
  const ny = p.y + dy * step
  if (nx < 0 || ny < 0 || nx + def.w > COLS || ny + def.h > ROWS) return false
  const grid = occupancy(positions, level)
  for (let t = 1; t <= step; t += 1) {
    for (let oy = 0; oy < def.h; oy += 1) {
      for (let ox = 0; ox < def.w; ox += 1) {
        const cell = (p.y + dy * t + oy) * COLS + (p.x + dx * t + ox)
        const owner = grid[cell]
        // Cells still covered by the moving piece are not blockers; every cell
        // the piece newly enters must be empty.
        if (owner !== -1 && owner !== i) return false
      }
    }
  }
  return true
}

/** Raw 1- and 2-cell slides for one piece (independent of win state). */
export function listSlides(positions, level, i) {
  const out = []
  for (const [dx, dy] of DIRS) {
    for (let step = 1; step <= 2; step += 1) {
      if (!canSlide(positions, level, i, dx, dy, step)) break // 2 cells needs the 1-cell path clear
      out.push({
        pieceIndex: i,
        dx,
        dy,
        step,
        x: positions[i].x + dx * step,
        y: positions[i].y + dy * step,
      })
    }
  }
  return out
}

/** Legal moves as the game offers them: the game stops at the win, so no moves after winning. */
export function listMoves(positions, level, i) {
  if (isWon(positions, level)) return []
  return listSlides(positions, level, i)
}

export function legalMoves(positions, level) {
  const out = []
  if (isWon(positions, level)) return out
  for (let i = 0; i < positions.length; i += 1) out.push(...listSlides(positions, level, i))
  return out
}

/** Apply a slide; returns a new positions array or null if illegal. Never mutates the input. */
export function applySlide(positions, level, i, dx, dy, step) {
  if (!canSlide(positions, level, i, dx, dy, step)) return null
  const next = positions.map((p) => ({ x: p.x, y: p.y }))
  next[i].x += dx * step
  next[i].y += dy * step
  return next
}

/** Win: Cao Cao is the piece whose definition is 2x2 (kind 'cao' in level data, shape rule from spec). */
export function caoIndex(level) {
  for (let i = 0; i < level.pieces.length; i += 1) {
    if (level.pieces[i].kind === 'cao') return i
  }
  // Fall back to shape (spec: exactly one 2x2 piece is Cao Cao).
  for (let i = 0; i < level.pieces.length; i += 1) {
    if (level.pieces[i].w === 2 && level.pieces[i].h === 2) return i
  }
  return -1
}

export function isWon(positions, level) {
  const i = caoIndex(level)
  if (i < 0) return false
  return positions[i].x === EXIT.x && positions[i].y === EXIT.y
}

/** Stable key for a concrete arrangement (piece identities matter: index order). */
export function stateKey(positions) {
  let key = ''
  for (let i = 0; i < positions.length; i += 1) key += positions[i].x + ',' + positions[i].y + ';'
  return key
}

export function clonePositions(positions) {
  return positions.map((p) => ({ x: p.x, y: p.y }))
}

export function fromClientState(state) {
  return state.pieces.map((p) => ({ x: p.x, y: p.y }))
}
