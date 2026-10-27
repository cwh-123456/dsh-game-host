/**
 * Independent Sudoku reference implementation for the audit (verifier-owned).
 *
 * Written from scratch and deliberately NOT shared with the implementation:
 *   - candidate bookkeeping uses Sets of used digits per row/col/box
 *     (the spec engine uses 9-bit integer masks),
 *   - the MRV tie-break scans cells from index 80 down to 0,
 *   - candidate digits are tried in DESCENDING order.
 *
 * These choices make the reference a genuinely independent oracle: identical
 * answers on unique/solution counts cannot come from shared code.
 */

export const CELLS = 81

export function rowOf(index) {
  return Math.floor(index / 9)
}

export function colOf(index) {
  return index % 9
}

export function boxOf(index) {
  return Math.floor(rowOf(index) / 3) * 3 + Math.floor(colOf(index) / 3)
}

export function peerIndices(index) {
  const peers = []
  const row = rowOf(index)
  const col = colOf(index)
  const box = boxOf(index)
  for (let other = 0; other < CELLS; other += 1) {
    if (other === index) continue
    if (rowOf(other) === row || colOf(other) === col || boxOf(other) === box) peers.push(other)
  }
  return peers
}

const PEERS = Array.from({ length: CELLS }, (_, index) => peerIndices(index))

export function peersOf(index) {
  return PEERS[index]
}

export function emptyBoard() {
  return new Array(CELLS).fill(0)
}

export function boardFromRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 9) throw new Error('boardFromRows expects 9 rows')
  const board = []
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 9) throw new Error('boardFromRows: every row must have 9 cells')
    board.push(...row)
  }
  return board
}

export function countNonZero(board) {
  let total = 0
  for (const value of board) if (value !== 0) total += 1
  return total
}

export function countEmpty(board) {
  return CELLS - countNonZero(board)
}

export function boardValidShape(board) {
  if (!Array.isArray(board) || board.length !== CELLS) return false
  for (const value of board) {
    if (!Number.isInteger(value) || value < 0 || value > 9) return false
  }
  return true
}

/**
 * Throws TypeError exactly where the spec says countSolutions/solve must throw:
 * not an 81-cell array of integers 0..9, or conflicting givens.
 */
export function refValidateGivens(givens) {
  if (!Array.isArray(givens) || givens.length !== CELLS) {
    throw new TypeError('reference: givens must be an array of 81 cells')
  }
  for (const value of givens) {
    if (!Number.isInteger(value) || value < 0 || value > 9) {
      throw new TypeError('reference: givens values must be integers 0..9')
    }
  }
  for (let index = 0; index < CELLS; index += 1) {
    const value = givens[index]
    if (value === 0) continue
    for (const peer of PEERS[index]) {
      if (givens[peer] === value) {
        throw new TypeError(
          'reference: conflicting givens at cells ' + index + ' and ' + peer + ' (digit ' + value + ')',
        )
      }
    }
  }
}

export function refCountSolutions(givens, limit = 2) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('reference: limit must be a positive integer')
  refValidateGivens(givens)

  const grid = Array.from(givens)
  const rowUsed = Array.from({ length: 9 }, () => new Set())
  const colUsed = Array.from({ length: 9 }, () => new Set())
  const boxUsed = Array.from({ length: 9 }, () => new Set())
  for (let index = 0; index < CELLS; index += 1) {
    const value = grid[index]
    if (value === 0) continue
    rowUsed[rowOf(index)].add(value)
    colUsed[colOf(index)].add(value)
    boxUsed[boxOf(index)].add(value)
  }

  function candidates(index) {
    const row = rowUsed[rowOf(index)]
    const col = colUsed[colOf(index)]
    const box = boxUsed[boxOf(index)]
    const list = []
    for (let digit = 1; digit <= 9; digit += 1) {
      if (!row.has(digit) && !col.has(digit) && !box.has(digit)) list.push(digit)
    }
    return list
  }

  function place(index, digit) {
    grid[index] = digit
    rowUsed[rowOf(index)].add(digit)
    colUsed[colOf(index)].add(digit)
    boxUsed[boxOf(index)].add(digit)
  }

  function unplace(index, digit) {
    grid[index] = 0
    rowUsed[rowOf(index)].delete(digit)
    colUsed[colOf(index)].delete(digit)
    boxUsed[boxOf(index)].delete(digit)
  }

  let solutions = 0

  function search() {
    let chosen = -1
    let chosenCandidates = null
    for (let index = CELLS - 1; index >= 0; index -= 1) {
      if (grid[index] !== 0) continue
      const list = candidates(index)
      if (list.length === 0) return // dead end
      if (chosenCandidates === null || list.length < chosenCandidates.length) {
        chosen = index
        chosenCandidates = list
        if (list.length === 1) break
      }
    }
    if (chosen === -1) {
      solutions += 1
      return
    }
    for (let k = chosenCandidates.length - 1; k >= 0; k -= 1) {
      const digit = chosenCandidates[k]
      place(chosen, digit)
      search()
      unplace(chosen, digit)
      if (solutions >= limit) return
    }
  }

  search()
  return solutions
}

export function refSolve(givens) {
  refValidateGivens(givens)
  const grid = Array.from(givens)
  const rowUsed = Array.from({ length: 9 }, () => new Set())
  const colUsed = Array.from({ length: 9 }, () => new Set())
  const boxUsed = Array.from({ length: 9 }, () => new Set())
  const empties = []
  for (let index = 0; index < CELLS; index += 1) {
    const value = grid[index]
    if (value === 0) {
      empties.push(index)
      continue
    }
    rowUsed[rowOf(index)].add(value)
    colUsed[colOf(index)].add(value)
    boxUsed[boxOf(index)].add(value)
  }

  function candidates(index) {
    const row = rowUsed[rowOf(index)]
    const col = colUsed[colOf(index)]
    const box = boxUsed[boxOf(index)]
    const list = []
    for (let digit = 1; digit <= 9; digit += 1) {
      if (!row.has(digit) && !col.has(digit) && !box.has(digit)) list.push(digit)
    }
    return list
  }

  function search() {
    let chosen = -1
    let chosenCandidates = null
    for (const index of empties) {
      if (grid[index] !== 0) continue
      const list = candidates(index)
      if (list.length === 0) return false
      if (chosenCandidates === null || list.length < chosenCandidates.length) {
        chosen = index
        chosenCandidates = list
        if (list.length === 1) break
      }
    }
    if (chosen === -1) return true
    for (let k = chosenCandidates.length - 1; k >= 0; k -= 1) {
      const digit = chosenCandidates[k]
      grid[chosen] = digit
      rowUsed[rowOf(chosen)].add(digit)
      colUsed[colOf(chosen)].add(digit)
      boxUsed[boxOf(chosen)].add(digit)
      if (search()) return true
      grid[chosen] = 0
      rowUsed[rowOf(chosen)].delete(digit)
      colUsed[colOf(chosen)].delete(digit)
      boxUsed[boxOf(chosen)].delete(digit)
    }
    return false
  }

  return search() ? grid : null
}

/** Independent conflict map: 1 if a cell repeats a digit in its row/col/box. */
export function refConflicts(board) {
  if (!Array.isArray(board) || board.length !== CELLS) throw new TypeError('reference: board must have 81 cells')
  const result = new Array(CELLS).fill(0)
  for (let index = 0; index < CELLS; index += 1) {
    const value = board[index]
    if (!Number.isInteger(value) || value < 0 || value > 9) throw new TypeError('reference: invalid cell value')
    if (value === 0) continue
    for (const peer of PEERS[index]) {
      if (board[peer] === value) {
        result[index] = 1
        break
      }
    }
  }
  return result
}

export function refIsComplete(board) {
  return Array.isArray(board) && board.length === CELLS && board.every((value) => Number.isInteger(value) && value >= 1 && value <= 9)
}

export function refIsSolved(board) {
  if (!refIsComplete(board)) return false
  return refConflicts(board).every((value) => value === 0)
}

/** Validate a full grid as a legal Sudoku solution (1..9 row/col/box permutations). */
export function refIsValidSolution(board) {
  if (!refIsComplete(board)) return false
  for (let unit = 0; unit < 9; unit += 1) {
    const row = new Set()
    const col = new Set()
    const box = new Set()
    for (let k = 0; k < 9; k += 1) {
      row.add(board[unit * 9 + k])
      col.add(board[k * 9 + unit])
      const boxRow = Math.floor(unit / 3) * 3 + Math.floor(k / 3)
      const boxCol = (unit % 3) * 3 + (k % 3)
      box.add(board[boxRow * 9 + boxCol])
    }
    if (row.size !== 9 || col.size !== 9 || box.size !== 9) return false
  }
  return true
}

export function refConsistent(givens, solution) {
  if (!Array.isArray(givens) || !Array.isArray(solution)) return false
  if (givens.length !== CELLS || solution.length !== CELLS) return false
  for (let index = 0; index < CELLS; index += 1) {
    if (givens[index] !== 0 && givens[index] !== solution[index]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Classic unique-solution puzzle (well known, 30 givens). */
export const CLASSIC_PUZZLE = boardFromRows([
  [5, 3, 0, 0, 7, 0, 0, 0, 0],
  [6, 0, 0, 1, 9, 5, 0, 0, 0],
  [0, 9, 8, 0, 0, 0, 0, 6, 0],
  [8, 0, 0, 0, 6, 0, 0, 0, 3],
  [4, 0, 0, 8, 0, 3, 0, 0, 1],
  [7, 0, 0, 0, 2, 0, 0, 0, 6],
  [0, 6, 0, 0, 0, 0, 2, 8, 0],
  [0, 0, 0, 4, 1, 9, 0, 0, 5],
  [0, 0, 0, 0, 8, 0, 0, 7, 9],
])

/**
 * Conflict-free but UNSOLVABLE givens. Column 0 holds 1..8 in rows 0..7, so
 * cell (8,0) is forced to 9, but row 8 already contains the 9 at (8,4):
 * the column has no candidate left. No row/col/box has a repeated given, so
 * countSolutions must return 0 (not throw).
 */
export const UNSOLVABLE_GIVENS = (() => {
  const board = emptyBoard()
  for (let row = 0; row < 8; row += 1) board[row * 9] = row + 1
  board[8 * 9 + 4] = 9
  return board
})()

// ---------------------------------------------------------------------------
// Audit-side random helpers (independent of the engine RNG)
// ---------------------------------------------------------------------------

/** xorshift32, deliberately a different PRNG from the spec's mulberry32. */
export function auditRng(seed) {
  let state = (seed >>> 0) || 0x9e3779b9
  return function next() {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
}

export function shuffled(array, rng) {
  const copy = array.slice()
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(rng() * (index + 1))
    const temp = copy[index]
    copy[index] = copy[pick]
    copy[pick] = temp
  }
  return copy
}

/** Keep `keep` randomly chosen solution digits, blank everything else. */
export function derivePartial(solution, keep, rng) {
  const board = emptyBoard()
  const order = shuffled(Array.from({ length: CELLS }, (_, index) => index), rng)
  for (let k = 0; k < keep; k += 1) {
    const index = order[k]
    board[index] = solution[index]
  }
  return board
}

/** Random value-filled board (0..9 values, conflicts allowed by construction). */
export function randomBoard(rng, fillRatio = 0.4) {
  const board = emptyBoard()
  for (let index = 0; index < CELLS; index += 1) {
    if (rng() < fillRatio) board[index] = 1 + Math.floor(rng() * 9)
  }
  return board
}
