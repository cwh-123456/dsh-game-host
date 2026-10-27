/**
 * techniques.mjs — deterministic candidate-bitmask sudoku technique solver + grader.
 *
 * DEV-SIDE ONLY (node, ESM). This module is imported by dev/gen-bank.mjs,
 * dev/test-grade.mjs and dev/test-logic.mjs; it is NEVER shipped in client.js
 * (the browser runtime only draws the pre-generated bank).
 *
 * Model (api-spec-v2.md §1):
 *   - cells 0..80, units 0..26 (rows 0..8, columns 9..17, boxes 18..26),
 *     digits 1..9 ascending.
 *   - a board is a plain `number[81]`, 0 = empty.
 *   - the grader only propagates candidate bitmasks (9-bit per cell); it never
 *     guesses and never backtracks. Backtracking lives only in the uniqueness
 *     solver / full-grid generator, which are used by the dev tooling.
 *
 * Technique order (spec §1, frozen):
 *   level 1: naked-single, hidden-single                    -> grade "easy"
 *   level 2: pointing, claiming                             -> grade "normal"
 *   level 3: naked-pair, naked-triple, hidden-pair,
 *            hidden-triple                                  -> grade "hard"
 *   level 4: x-wing, xy-wing                                -> grade "expert"
 *   stuck with empty cells after exhausting every technique -> grade "hell"
 *
 * Each technique applies every elimination/fill it can find in one
 * deterministic batch; any progress restarts the scan at level 1.
 * Same input -> same grade, same `techniques` order, same solution.
 *
 * Exports (spec §4, plus `digPuzzle` used by the dev tests):
 *   LEVELS, TECHNIQUE_LEVEL,
 *   parseGrid, gridToString, countSolutions, solve, computeConflicts,
 *   gradePuzzle, generateFullGrid, makeRng, digPuzzle
 */

const CELLS = 81
const ALL_BITS = 0x1ff

// ---------------------------------------------------------------------------
// Geometry: rows 0..8, cols 9..17, boxes 18..26 (spec §1), peers per cell.
// ---------------------------------------------------------------------------

const ROW_OF = new Uint8Array(CELLS)
const COL_OF = new Uint8Array(CELLS)
const BOX_OF = new Uint8Array(CELLS)
const UNITS = []

for (let r = 0; r < 9; r++) {
  const unit = []
  for (let c = 0; c < 9; c++) unit.push(r * 9 + c)
  UNITS.push(unit)
}
for (let c = 0; c < 9; c++) {
  const unit = []
  for (let r = 0; r < 9; r++) unit.push(r * 9 + c)
  UNITS.push(unit)
}
for (let br = 0; br < 3; br++) {
  for (let bc = 0; bc < 3; bc++) {
    const unit = []
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) unit.push((br * 3 + r) * 9 + (bc * 3 + c))
    }
    UNITS.push(unit)
  }
}
for (let i = 0; i < CELLS; i++) {
  ROW_OF[i] = Math.floor(i / 9)
  COL_OF[i] = i % 9
  BOX_OF[i] = Math.floor(ROW_OF[i] / 3) * 3 + Math.floor(COL_OF[i] / 3)
}

const PEERS = []
const PEER_MATRIX = new Uint8Array(CELLS * CELLS)
for (let i = 0; i < CELLS; i++) {
  const set = new Set()
  for (const cell of UNITS[ROW_OF[i]]) if (cell !== i) set.add(cell)
  for (const cell of UNITS[9 + COL_OF[i]]) if (cell !== i) set.add(cell)
  for (const cell of UNITS[18 + BOX_OF[i]]) if (cell !== i) set.add(cell)
  const peers = Array.from(set).sort((a, b) => a - b)
  PEERS.push(peers)
  for (const p of peers) PEER_MATRIX[i * CELLS + p] = 1
}

// popcount / digit lookup tables for 9-bit candidate masks.
const POPCOUNT = new Uint8Array(512)
for (let m = 1; m < 512; m++) POPCOUNT[m] = POPCOUNT[m >> 1] + (m & 1)
const SINGLE_DIGIT = new Uint8Array(512)
for (let d = 1; d <= 9; d++) SINGLE_DIGIT[1 << (d - 1)] = d

// ---------------------------------------------------------------------------
// Public constants (spec §1).
// ---------------------------------------------------------------------------

export const LEVELS = Object.freeze([
  Object.freeze({ key: 'easy', label: '简单', level: 1 }),
  Object.freeze({ key: 'normal', label: '普通', level: 2 }),
  Object.freeze({ key: 'hard', label: '困难', level: 3 }),
  Object.freeze({ key: 'expert', label: '专家', level: 4 }),
  Object.freeze({ key: 'hell', label: '地狱', level: 5 }),
])

export const TECHNIQUE_LEVEL = Object.freeze({
  'naked-single': 1,
  'hidden-single': 1,
  pointing: 2,
  claiming: 2,
  'naked-pair': 3,
  'naked-triple': 3,
  'hidden-pair': 3,
  'hidden-triple': 3,
  'x-wing': 4,
  'xy-wing': 4,
})

const GRADE_BY_LEVEL = Object.freeze(['invalid', 'easy', 'normal', 'hard', 'expert', 'hell'])
const LEVEL_TECHNIQUES = Object.freeze([
  Object.freeze([]),
  Object.freeze(['naked-single', 'hidden-single']),
  Object.freeze(['pointing', 'claiming']),
  Object.freeze(['naked-pair', 'naked-triple', 'hidden-pair', 'hidden-triple']),
  Object.freeze(['x-wing', 'xy-wing']),
])

// ---------------------------------------------------------------------------
// Parsing / serialising.
// ---------------------------------------------------------------------------

function malformed(message) {
  return new TypeError('techniques: ' + message)
}

/** string|number[] -> number[81]; throws TypeError when structurally invalid. */
export function parseGrid(givens) {
  const grid = new Array(CELLS)
  if (typeof givens === 'string') {
    const text = givens.trim()
    if (text.length !== CELLS) throw malformed('grid string must be exactly 81 digits')
    for (let i = 0; i < CELLS; i++) {
      const code = text.charCodeAt(i)
      if (code < 48 || code > 57) throw malformed('grid string may only contain digits 0-9')
      grid[i] = code - 48
    }
    return grid
  }
  if (givens && typeof givens.length === 'number' && givens.length === CELLS) {
    for (let i = 0; i < CELLS; i++) {
      const value = givens[i]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 9) {
        throw malformed('grid cells must be integers 0-9 (cell ' + i + ')')
      }
      grid[i] = value
    }
    return grid
  }
  throw malformed('grid must be an 81-digit string or an 81-element number[]')
}

/** number[81] -> 81-digit string. */
export function gridToString(grid) {
  const parsed = parseGrid(grid)
  let out = ''
  for (let i = 0; i < CELLS; i++) out += String(parsed[i])
  return out
}

// ---------------------------------------------------------------------------
// Candidate state used by the technique grader (no backtracking).
// ---------------------------------------------------------------------------

function buildState(grid) {
  const values = Int8Array.from(grid)
  const cand = new Int32Array(CELLS)
  const rowMask = new Int32Array(9)
  const colMask = new Int32Array(9)
  const boxMask = new Int32Array(9)
  let dead = false
  for (let i = 0; i < CELLS; i++) {
    const digit = values[i]
    if (digit === 0) continue
    const bit = 1 << (digit - 1)
    const r = ROW_OF[i]
    const c = COL_OF[i]
    const b = BOX_OF[i]
    if ((rowMask[r] | colMask[c] | boxMask[b]) & bit) {
      throw malformed('conflicting givens at cell ' + i)
    }
    rowMask[r] |= bit
    colMask[c] |= bit
    boxMask[b] |= bit
  }
  for (let i = 0; i < CELLS; i++) {
    if (values[i] !== 0) continue
    const mask = ~(rowMask[ROW_OF[i]] | colMask[COL_OF[i]] | boxMask[BOX_OF[i]]) & ALL_BITS
    cand[i] = mask
    if (mask === 0) dead = true
  }
  return { values, cand, rowMask, colMask, boxMask, dead }
}

function isComplete(values) {
  for (let i = 0; i < CELLS; i++) if (values[i] === 0) return false
  return true
}

function isValidCompleteGrid(grid) {
  if (!grid || grid.length !== CELLS) return false
  for (let u = 0; u < 27; u++) {
    let seen = 0
    const cells = UNITS[u]
    for (let k = 0; k < 9; k++) {
      const digit = grid[cells[k]]
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return false
      const bit = 1 << (digit - 1)
      if (seen & bit) return false
      seen |= bit
    }
  }
  return true
}

/** Place a digit on an empty cell and clear that candidate from all peers. */
function placeDigit(state, cell, digit) {
  const bit = 1 << (digit - 1)
  state.values[cell] = digit
  state.cand[cell] = 0
  const r = ROW_OF[cell]
  const c = COL_OF[cell]
  const b = BOX_OF[cell]
  state.rowMask[r] |= bit
  state.colMask[c] |= bit
  state.boxMask[b] |= bit
  const peers = PEERS[cell]
  for (let k = 0; k < peers.length; k++) {
    const peer = peers[k]
    if (state.values[peer] !== 0) continue
    const next = state.cand[peer] & ~bit
    if (next !== state.cand[peer]) {
      state.cand[peer] = next
      if (next === 0) state.dead = true
    }
  }
}

/**
 * Apply a collected batch of candidate eliminations.
 * `list` holds [cell, mask] pairs (duplicates are harmless).
 * Returns true when at least one candidate was removed.
 */
function applyEliminations(state, list) {
  let changed = false
  for (let k = 0; k < list.length; k++) {
    const cell = list[k][0]
    const mask = list[k][1]
    if (state.values[cell] !== 0) continue
    const next = state.cand[cell] & ~mask
    if (next === state.cand[cell]) continue
    state.cand[cell] = next
    changed = true
    if (next === 0) state.dead = true
  }
  return changed
}

// ---------------------------------------------------------------------------
// Level 1 — naked-single / hidden-single (fills a digit).
// ---------------------------------------------------------------------------

function applyNakedSingle(state) {
  let changed = false
  const values = state.values
  const cand = state.cand
  for (let cell = 0; cell < CELLS; cell++) {
    if (values[cell] !== 0) continue
    const mask = cand[cell]
    if (POPCOUNT[mask] !== 1) continue
    placeDigit(state, cell, SINGLE_DIGIT[mask])
    changed = true
    if (state.dead) return true
  }
  return changed
}

function applyHiddenSingle(state) {
  let changed = false
  const values = state.values
  const cand = state.cand
  for (let u = 0; u < 27; u++) {
    const cells = UNITS[u]
    for (let digit = 1; digit <= 9; digit++) {
      const bit = 1 << (digit - 1)
      let found = -1
      let count = 0
      for (let k = 0; k < 9; k++) {
        const cell = cells[k]
        if (values[cell] === digit) {
          count = -1
          break
        }
        if (cand[cell] & bit) {
          count++
          if (count === 1) found = cell
          else break
        }
      }
      if (count === 1) {
        placeDigit(state, found, digit)
        changed = true
        if (state.dead) return true
      }
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
// Level 2 — pointing / claiming (locked candidates).
// ---------------------------------------------------------------------------

function applyPointing(state) {
  const list = []
  const values = state.values
  const cand = state.cand
  for (let box = 0; box < 9; box++) {
    const boxUnit = 18 + box
    const cells = UNITS[boxUnit]
    for (let digit = 1; digit <= 9; digit++) {
      const bit = 1 << (digit - 1)
      let count = 0
      let row0 = -1
      let col0 = -1
      let sameRow = true
      let sameCol = true
      let placed = false
      for (let k = 0; k < 9; k++) {
        const cell = cells[k]
        if (values[cell] === digit) {
          placed = true
          break
        }
        if ((cand[cell] & bit) === 0) continue
        count++
        const r = ROW_OF[cell]
        const c = COL_OF[cell]
        if (count === 1) {
          row0 = r
          col0 = c
        } else {
          if (r !== row0) sameRow = false
          if (c !== col0) sameCol = false
        }
      }
      if (placed || count < 2) continue
      if (sameRow) {
        const rowCells = UNITS[row0]
        for (let k = 0; k < 9; k++) {
          const cell = rowCells[k]
          if (BOX_OF[cell] === box) continue
          if (values[cell] === 0 && (cand[cell] & bit)) list.push([cell, bit])
        }
      } else if (sameCol) {
        const colCells = UNITS[9 + col0]
        for (let k = 0; k < 9; k++) {
          const cell = colCells[k]
          if (BOX_OF[cell] === box) continue
          if (values[cell] === 0 && (cand[cell] & bit)) list.push([cell, bit])
        }
      }
    }
  }
  return applyEliminations(state, list)
}

function applyClaiming(state) {
  const list = []
  const values = state.values
  const cand = state.cand
  for (let line = 0; line < 18; line++) {
    const cells = UNITS[line]
    const isRow = line < 9
    const lineIndex = isRow ? line : line - 9
    for (let digit = 1; digit <= 9; digit++) {
      const bit = 1 << (digit - 1)
      let count = 0
      let box = -1
      let sameBox = true
      let placed = false
      for (let k = 0; k < 9; k++) {
        const cell = cells[k]
        if (values[cell] === digit) {
          placed = true
          break
        }
        if ((cand[cell] & bit) === 0) continue
        count++
        const b = BOX_OF[cell]
        if (count === 1) box = b
        else if (b !== box) sameBox = false
      }
      if (placed || count < 2 || !sameBox) continue
      const boxCells = UNITS[18 + box]
      for (let k = 0; k < 9; k++) {
        const cell = boxCells[k]
        const inLine = isRow ? ROW_OF[cell] === lineIndex : COL_OF[cell] === lineIndex
        if (inLine) continue
        if (values[cell] === 0 && (cand[cell] & bit)) list.push([cell, bit])
      }
    }
  }
  return applyEliminations(state, list)
}

// ---------------------------------------------------------------------------
// Level 3 — naked pair/triple, hidden pair/triple.
// ---------------------------------------------------------------------------

function applyNakedPair(state) {
  const list = []
  const values = state.values
  const cand = state.cand
  for (let u = 0; u < 27; u++) {
    const cells = UNITS[u]
    const groups = new Map()
    for (let k = 0; k < 9; k++) {
      const cell = cells[k]
      if (values[cell] !== 0) continue
      const mask = cand[cell]
      if (POPCOUNT[mask] !== 2) continue
      let group = groups.get(mask)
      if (!group) {
        group = []
        groups.set(mask, group)
      }
      group.push(cell)
    }
    for (const [mask, group] of groups) {
      if (group.length !== 2) continue // >2 can only happen on an inconsistent board
      for (let k = 0; k < 9; k++) {
        const cell = cells[k]
        if (cell === group[0] || cell === group[1]) continue
        if (values[cell] === 0 && (cand[cell] & mask)) list.push([cell, mask])
      }
    }
  }
  return applyEliminations(state, list)
}

function applyNakedTriple(state) {
  const list = []
  const values = state.values
  const cand = state.cand
  for (let u = 0; u < 27; u++) {
    const cells = UNITS[u]
    const combo = [] // { cell, mask } with 2..3 candidates
    for (let k = 0; k < 9; k++) {
      const cell = cells[k]
      if (values[cell] !== 0) continue
      const mask = cand[cell]
      const pc = POPCOUNT[mask]
      if (pc === 2 || pc === 3) combo.push([cell, mask])
    }
    const n = combo.length
    for (let a = 0; a < n - 2; a++) {
      for (let b = a + 1; b < n - 1; b++) {
        for (let c = b + 1; c < n; c++) {
          const union = combo[a][1] | combo[b][1] | combo[c][1]
          if (POPCOUNT[union] !== 3) continue
          const cells3 = [combo[a][0], combo[b][0], combo[c][0]]
          for (let k = 0; k < 9; k++) {
            const cell = cells[k]
            if (cell === cells3[0] || cell === cells3[1] || cell === cells3[2]) continue
            if (values[cell] === 0 && (cand[cell] & union)) list.push([cell, union])
          }
        }
      }
    }
  }
  return applyEliminations(state, list)
}

function applyHiddenPair(state) {
  const list = []
  const values = state.values
  const cand = state.cand
  for (let u = 0; u < 27; u++) {
    const cells = UNITS[u]
    const positions = new Array(10)
    for (let digit = 1; digit <= 9; digit++) positions[digit] = []
    for (let k = 0; k < 9; k++) {
      const cell = cells[k]
      if (values[cell] !== 0) continue
      const mask = cand[cell]
      for (let digit = 1; digit <= 9; digit++) {
        if (mask & (1 << (digit - 1))) positions[digit].push(cell)
      }
    }
    for (let d1 = 1; d1 <= 8; d1++) {
      const p1 = positions[d1]
      if (p1.length !== 2) continue
      for (let d2 = d1 + 1; d2 <= 9; d2++) {
        const p2 = positions[d2]
        if (p2.length !== 2) continue
        if (p1[0] !== p2[0] || p1[1] !== p2[1]) continue
        const keep = (1 << (d1 - 1)) | (1 << (d2 - 1))
        const remove = ~keep & ALL_BITS
        for (let k = 0; k < 2; k++) {
          const cell = p1[k]
          if (cand[cell] & remove) list.push([cell, remove])
        }
      }
    }
  }
  return applyEliminations(state, list)
}

function applyHiddenTriple(state) {
  const list = []
  const values = state.values
  const cand = state.cand
  for (let u = 0; u < 27; u++) {
    const cells = UNITS[u]
    const positions = new Array(10)
    for (let digit = 1; digit <= 9; digit++) positions[digit] = []
    for (let k = 0; k < 9; k++) {
      const cell = cells[k]
      if (values[cell] !== 0) continue
      const mask = cand[cell]
      for (let digit = 1; digit <= 9; digit++) {
        if (mask & (1 << (digit - 1))) positions[digit].push(cell)
      }
    }
    for (let d1 = 1; d1 <= 7; d1++) {
      const p1 = positions[d1]
      if (p1.length === 0 || p1.length > 3) continue
      for (let d2 = d1 + 1; d2 <= 8; d2++) {
        const p2 = positions[d2]
        if (p2.length === 0 || p2.length > 3) continue
        for (let d3 = d2 + 1; d3 <= 9; d3++) {
          const p3 = positions[d3]
          if (p3.length === 0 || p3.length > 3) continue
          const union = []
          const seen = new Set()
          for (const group of [p1, p2, p3]) {
            for (let k = 0; k < group.length; k++) {
              const cell = group[k]
              if (seen.has(cell)) continue
              seen.add(cell)
              union.push(cell)
            }
          }
          if (union.length !== 3) continue
          const keep = (1 << (d1 - 1)) | (1 << (d2 - 1)) | (1 << (d3 - 1))
          const remove = ~keep & ALL_BITS
          for (let k = 0; k < 3; k++) {
            const cell = union[k]
            if (cand[cell] & remove) list.push([cell, remove])
          }
        }
      }
    }
  }
  return applyEliminations(state, list)
}

// ---------------------------------------------------------------------------
// Level 4 — x-wing / xy-wing.
// ---------------------------------------------------------------------------

function digitPositionsInUnit(state, unitIndex, digit) {
  const cells = UNITS[unitIndex]
  const bit = 1 << (digit - 1)
  const out = []
  for (let k = 0; k < 9; k++) {
    const cell = cells[k]
    if (state.cand[cell] & bit) out.push(cell)
  }
  return out
}

function applyXWing(state) {
  const list = []
  const values = state.values
  const cand = state.cand
  for (let digit = 1; digit <= 9; digit++) {
    const bit = 1 << (digit - 1)
    // Row-based x-wing: two rows whose only two positions share the same columns.
    for (let r1 = 0; r1 < 8; r1++) {
      const p1 = digitPositionsInUnit(state, r1, digit)
      if (p1.length !== 2) continue
      for (let r2 = r1 + 1; r2 < 9; r2++) {
        const p2 = digitPositionsInUnit(state, r2, digit)
        if (p2.length !== 2) continue
        const c1 = p1[0] % 9
        const c2 = p1[1] % 9
        if (p2[0] % 9 !== c1 || p2[1] % 9 !== c2) continue
        for (let r = 0; r < 9; r++) {
          if (r === r1 || r === r2) continue
          for (let k = 0; k < 2; k++) {
            const cell = r * 9 + (k === 0 ? c1 : c2)
            if (values[cell] === 0 && (cand[cell] & bit)) list.push([cell, bit])
          }
        }
      }
    }
    // Column-based x-wing: two columns whose only two positions share the same rows.
    for (let c1 = 0; c1 < 8; c1++) {
      const p1 = digitPositionsInUnit(state, 9 + c1, digit)
      if (p1.length !== 2) continue
      for (let c2 = c1 + 1; c2 < 9; c2++) {
        const p2 = digitPositionsInUnit(state, 9 + c2, digit)
        if (p2.length !== 2) continue
        const r1 = Math.floor(p1[0] / 9)
        const r2 = Math.floor(p1[1] / 9)
        if (Math.floor(p2[0] / 9) !== r1 || Math.floor(p2[1] / 9) !== r2) continue
        for (let c = 0; c < 9; c++) {
          if (c === c1 || c === c2) continue
          for (let k = 0; k < 2; k++) {
            const cell = (k === 0 ? r1 : r2) * 9 + c
            if (values[cell] === 0 && (cand[cell] & bit)) list.push([cell, bit])
          }
        }
      }
    }
  }
  return applyEliminations(state, list)
}

function applyXYWing(state) {
  const list = []
  const values = state.values
  const cand = state.cand
  const bivalue = []
  for (let cell = 0; cell < CELLS; cell++) {
    if (values[cell] === 0 && POPCOUNT[cand[cell]] === 2) bivalue.push(cell)
  }
  for (let pi = 0; pi < bivalue.length; pi++) {
    const pivot = bivalue[pi]
    const pivotMask = cand[pivot]
    const pivotDigits = []
    for (let d = 1; d <= 9; d++) if (pivotMask & (1 << (d - 1))) pivotDigits.push(d)
    const sharedA = [] // pincer { pivotDigitA, commonDigit }, cells
    const sharedB = []
    const peers = PEERS[pivot]
    for (let k = 0; k < peers.length; k++) {
      const cell = peers[k]
      if (values[cell] !== 0) continue
      const mask = cand[cell]
      if (POPCOUNT[mask] !== 2) continue
      const shared = mask & pivotMask
      if (POPCOUNT[shared] !== 1) continue
      const other = mask & ~pivotMask
      if (POPCOUNT[other] !== 1) continue
      const sharedDigit = SINGLE_DIGIT[shared]
      const otherDigit = SINGLE_DIGIT[other]
      if (sharedDigit === pivotDigits[0]) sharedA.push({ cell, common: otherDigit })
      else sharedB.push({ cell, common: otherDigit })
    }
    for (let a = 0; a < sharedA.length; a++) {
      for (let b = 0; b < sharedB.length; b++) {
        if (sharedA[a].common !== sharedB[b].common) continue
        const common = sharedA[a].common
        const pincerA = sharedA[a].cell
        const pincerB = sharedB[b].cell
        const bit = 1 << (common - 1)
        for (let k = 0; k < PEERS[pincerA].length; k++) {
          const cell = PEERS[pincerA][k]
          if (cell === pivot || cell === pincerA || cell === pincerB) continue
          if (!PEER_MATRIX[cell * CELLS + pincerB]) continue
          if (values[cell] === 0 && (cand[cell] & bit)) list.push([cell, bit])
        }
      }
    }
  }
  return applyEliminations(state, list)
}

const TECHNIQUE_IMPL = Object.freeze({
  'naked-single': applyNakedSingle,
  'hidden-single': applyHiddenSingle,
  pointing: applyPointing,
  claiming: applyClaiming,
  'naked-pair': applyNakedPair,
  'naked-triple': applyNakedTriple,
  'hidden-pair': applyHiddenPair,
  'hidden-triple': applyHiddenTriple,
  'x-wing': applyXWing,
  'xy-wing': applyXYWing,
})

// ---------------------------------------------------------------------------
// Backtracking solver (uniqueness + solution) — NOT used by the grader.
// ---------------------------------------------------------------------------

function searchSolutions(grid, limit, wantSolution) {
  const state = buildState(grid) // throws TypeError on conflicting givens
  if (state.dead) return { count: 0, solution: null }
  const values = state.values
  const cand = state.cand
  const rowMask = state.rowMask
  const colMask = state.colMask
  const boxMask = state.boxMask
  let count = 0
  let solution = null
  function recurse() {
    let best = -1
    let bestPC = 10
    for (let i = 0; i < CELLS; i++) {
      if (values[i] !== 0) continue
      const pc = POPCOUNT[cand[i]]
      if (pc === 0) return
      if (pc < bestPC) {
        bestPC = pc
        best = i
        if (pc === 1) break
      }
    }
    if (best === -1) {
      count++
      if (wantSolution && solution === null) solution = Array.from(values)
      return
    }
    const r = ROW_OF[best]
    const c = COL_OF[best]
    const b = BOX_OF[best]
    const mask = cand[best]
    const savedCand = cand.slice()
    const peers = PEERS[best]
    for (let digit = 1; digit <= 9; digit++) {
      const bit = 1 << (digit - 1)
      if ((mask & bit) === 0) continue
      values[best] = digit
      rowMask[r] |= bit
      colMask[c] |= bit
      boxMask[b] |= bit
      for (let k = 0; k < peers.length; k++) cand[peers[k]] &= ~bit
      recurse()
      values[best] = 0
      rowMask[r] &= ~bit
      colMask[c] &= ~bit
      boxMask[b] &= ~bit
      cand.set(savedCand)
      if (count >= limit) return
    }
  }
  recurse()
  return { count: Math.min(count, limit), solution }
}

/**
 * Number of solutions of `givens`, counting at most `limit` (default 2).
 * Throws TypeError for malformed input or conflicting givens (spec §4).
 */
export function countSolutions(givens, limit = 2) {
  const grid = parseGrid(givens)
  let lim = 2
  if (limit !== undefined) {
    const numeric = Number(limit)
    if (!Number.isFinite(numeric)) throw malformed('countSolutions limit must be a finite number')
    lim = Math.max(1, Math.floor(numeric))
  }
  return searchSolutions(grid, lim, false).count
}

/** First solution of `givens` as number[81], or null when unsolvable. */
export function solve(givens) {
  const grid = parseGrid(givens)
  return searchSolutions(grid, 1, true).solution
}

// ---------------------------------------------------------------------------
// Conflict map (0/1 per cell) — no solver, just unit duplicate detection.
// ---------------------------------------------------------------------------

export function computeConflicts(board) {
  const grid = parseGrid(board)
  const out = new Array(CELLS).fill(0)
  for (let u = 0; u < 27; u++) {
    const cells = UNITS[u]
    const counts = new Array(10).fill(0)
    for (let k = 0; k < 9; k++) {
      const digit = grid[cells[k]]
      if (digit !== 0) counts[digit]++
    }
    for (let k = 0; k < 9; k++) {
      const cell = cells[k]
      const digit = grid[cell]
      if (digit !== 0 && counts[digit] > 1) out[cell] = 1
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) + full-grid generator.
// ---------------------------------------------------------------------------

export function makeRng(seed) {
  const numeric = Number(seed)
  let state = Number.isFinite(numeric) ? Math.floor(numeric) >>> 0 : 0
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random complete valid grid (number[81]) using MRV + shuffled digits. */
export function generateFullGrid(rng) {
  const random = typeof rng === 'function' ? rng : Math.random
  const values = new Int8Array(CELLS)
  const cand = new Int32Array(CELLS)
  const rowMask = new Int32Array(9)
  const colMask = new Int32Array(9)
  const boxMask = new Int32Array(9)
  for (let i = 0; i < CELLS; i++) cand[i] = ALL_BITS
  function fill() {
    let best = -1
    let bestPC = 10
    for (let i = 0; i < CELLS; i++) {
      if (values[i] !== 0) continue
      const pc = POPCOUNT[cand[i]]
      if (pc === 0) return false
      if (pc < bestPC) {
        bestPC = pc
        best = i
        if (pc === 1) break
      }
    }
    if (best === -1) return true
    // Local digit order: recursion must never share this scratch array.
    const order = new Array(9)
    const mask = cand[best]
    let n = 0
    for (let d = 1; d <= 9; d++) if (mask & (1 << (d - 1))) order[n++] = d
    for (let k = n - 1; k > 0; k--) {
      const j = Math.floor(random() * (k + 1))
      const tmp = order[k]
      order[k] = order[j]
      order[j] = tmp
    }
    const savedCand = cand.slice()
    const r = ROW_OF[best]
    const c = COL_OF[best]
    const b = BOX_OF[best]
    const peers = PEERS[best]
    for (let k = 0; k < n; k++) {
      const digit = order[k]
      const bit = 1 << (digit - 1)
      values[best] = digit
      rowMask[r] |= bit
      colMask[c] |= bit
      boxMask[b] |= bit
      for (let p = 0; p < peers.length; p++) cand[peers[p]] &= ~bit
      if (fill()) return true
      values[best] = 0
      rowMask[r] &= ~bit
      colMask[c] &= ~bit
      boxMask[b] &= ~bit
      cand.set(savedCand)
    }
    return false
  }
  fill()
  const result = Array.from(values)
  // Defensive: a generator bug must fail loudly instead of poisoning the bank.
  if (!isValidCompleteGrid(result)) throw new Error('generateFullGrid: produced an invalid grid')
  return result
}

// ---------------------------------------------------------------------------
// Grader (spec §1). Deterministic: candidate propagation only, frozen order.
// ---------------------------------------------------------------------------

function invalidResult() {
  return {
    grade: 'invalid',
    level: 0,
    solved: false,
    techniques: [],
    solution: null,
    stuck: false,
    steps: [],
  }
}

/**
 * Grade a puzzle with the frozen technique order.
 *
 * @param {string|number[]} givens
 * @param {{skipUniqueness?: boolean}} [options] dev-internal fast path: skip the
 *        internal uniqueness probe when the caller has already proven the
 *        puzzle has exactly one solution (gen-bank does this during digging).
 * @returns {{grade:string, level:number, solved:boolean, techniques:string[],
 *            solution:number[]|null, stuck:boolean, steps:{level:number,technique:string}[]}}
 */
export function gradePuzzle(givens, options) {
  const opts = options || {}
  const grid = parseGrid(givens)
  const state = buildState(grid) // throws TypeError on conflicting givens
  if (!opts.skipUniqueness) {
    const probe = searchSolutions(grid, 2, false)
    if (probe.count !== 1) return invalidResult()
  }
  if (state.dead) return invalidResult()

  const techniques = []
  const steps = []
  let maxLevel = 0
  let stuck = false

  for (;;) {
    if (isComplete(state.values)) break
    if (state.dead) return invalidResult()
    let progressed = false
    for (let level = 1; level <= 4 && !progressed; level++) {
      const names = LEVEL_TECHNIQUES[level]
      for (let t = 0; t < names.length; t++) {
        const name = names[t]
        const changed = TECHNIQUE_IMPL[name](state)
        if (state.dead) return invalidResult()
        if (!changed) continue
        if (!techniques.includes(name)) {
          techniques.push(name)
          steps.push({ level, technique: name })
        }
        if (level > maxLevel) maxLevel = level
        progressed = true
        break
      }
    }
    if (!progressed) {
      stuck = true
      break
    }
  }

  const solved = !stuck && isComplete(state.values)
  let solution
  if (solved) {
    solution = Array.from(state.values)
  } else {
    const first = searchSolutions(grid, 1, true)
    solution = first.solution
    if (!solution) return invalidResult()
    for (let i = 0; i < CELLS; i++) {
      if (state.values[i] !== 0 && state.values[i] !== solution[i]) return invalidResult()
    }
  }
  if (!isValidCompleteGrid(solution)) return invalidResult()

  return {
    grade: stuck ? 'hell' : maxLevel === 0 ? 'easy' : GRADE_BY_LEVEL[maxLevel],
    level: stuck ? 5 : maxLevel === 0 ? 1 : maxLevel,
    solved,
    techniques,
    solution,
    stuck,
    steps,
  }
}

// ---------------------------------------------------------------------------
// Digging helper (spec §6.4: generated unique puzzles for the uniqueness test).
// ---------------------------------------------------------------------------

function shuffledPositions(random) {
  const order = new Array(CELLS)
  for (let i = 0; i < CELLS; i++) order[i] = i
  for (let k = CELLS - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1))
    const tmp = order[k]
    order[k] = order[j]
    order[j] = tmp
  }
  return order
}

/**
 * Dig holes from a solved/unique grid while keeping the solution unique.
 * Passes are repeated until a full pass removes nothing (maximal dig).
 *
 * @param {string|number[]} givens
 * @param {() => number} [rng]
 * @param {{maxPasses?: number}} [options]
 * @returns {{givens:number[], solution:number[], removed:number, passes:number, clues:number}}
 */
export function digPuzzle(givens, rng, options) {
  const opts = options || {}
  const random = typeof rng === 'function' ? rng : Math.random
  const grid = parseGrid(givens)
  const solution = solve(grid)
  if (!solution) throw new Error('digPuzzle: puzzle has no solution')
  const out = grid.slice()
  const order = shuffledPositions(random)
  const maxPasses = Number.isFinite(opts.maxPasses) ? Math.max(1, Math.floor(opts.maxPasses)) : 12
  let removed = 0
  let passes = 0
  while (passes < maxPasses) {
    passes++
    let removedThisPass = 0
    for (let k = 0; k < order.length; k++) {
      const pos = order[k]
      if (out[pos] === 0) continue
      const saved = out[pos]
      out[pos] = 0
      if (countSolutions(out, 2) === 1) {
        removed++
        removedThisPass++
      } else {
        out[pos] = saved
      }
    }
    if (removedThisPass === 0) break
  }
  return { givens: out, solution, removed, passes, clues: CELLS - removed }
}
