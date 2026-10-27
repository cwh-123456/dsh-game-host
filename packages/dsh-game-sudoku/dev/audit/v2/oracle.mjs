/**
 * v2 independent oracle — verifier-owned, written from scratch.
 *
 * This module is deliberately NOT dev/lib/techniques.mjs and shares no code with
 * it: candidate bookkeeping uses plain arrays (`number[]` of digits per cell),
 * every scan walks cells 0..80 / units 0..26 / digits 1..9 ascending, and the
 * technique pipeline follows api-spec-v2 §1 exactly.
 *
 * It provides:
 *   - the independent GRADE oracle (technique solver, no guessing / no backtrack)
 *   - an independent uniqueness solver + generator for the 100-puzzle check
 *   - bank id hashing (FNV-1a32 base36) and grid string helpers
 *
 * The uniqueness solver itself lives in ../reference.mjs (also verifier-owned,
 * written from scratch during the v1 audit: Sets + reverse-scan MRV).
 */
import {
  refConflicts,
  refConsistent,
  refCountSolutions,
  refIsSolved,
  refIsValidSolution,
  refSolve,
} from '../reference.mjs'

// ---------------------------------------------------------------------------
// Levels / technique metadata (api-spec-v2 §1)
// ---------------------------------------------------------------------------
export const LEVELS = [
  { key: 'easy', label: '简单', level: 1 },
  { key: 'normal', label: '普通', level: 2 },
  { key: 'hard', label: '困难', level: 3 },
  { key: 'expert', label: '专家', level: 4 },
  { key: 'hell', label: '地狱', level: 5 },
]

export const GRADE_BY_LEVEL = { 1: 'easy', 2: 'normal', 3: 'hard', 4: 'expert', 5: 'hell' }
export const LEVEL_BY_GRADE = Object.fromEntries(LEVELS.map((entry) => [entry.key, entry.level]))

export const TECHNIQUE_ORDER = [
  // level 1
  'naked-single',
  'hidden-single',
  // level 2
  'pointing',
  'claiming',
  // level 3
  'naked-pair',
  'naked-triple',
  'hidden-pair',
  'hidden-triple',
  // level 4
  'x-wing',
  'xy-wing',
]

export const TECHNIQUE_LEVEL = {
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
}

export const ALL_TECHNIQUES = TECHNIQUE_ORDER.slice()

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------
export function parseGivens(input) {
  let grid
  if (typeof input === 'string') {
    if (input.length !== 81) throw new TypeError('givens string must be exactly 81 chars')
    grid = new Array(81)
    for (let index = 0; index < 81; index += 1) {
      const char = input[index]
      if (char < '0' || char > '9') throw new TypeError('givens string may only contain 0-9')
      grid[index] = Number(char)
    }
  } else if (Array.isArray(input) && input.length === 81) {
    grid = input.slice()
    for (const value of grid) {
      if (!Number.isInteger(value) || value < 0 || value > 9) {
        throw new TypeError('givens values must be integers 0..9')
      }
    }
  } else {
    throw new TypeError('givens must be an 81-char string or an 81-cell array')
  }
  const conflicts = refConflicts(grid)
  for (let index = 0; index < 81; index += 1) {
    if (conflicts[index] !== 0) throw new TypeError('givens contain a duplicate value at cell ' + index)
  }
  return grid
}

export function gridToString(grid) {
  let out = ''
  for (let index = 0; index < 81; index += 1) out += grid[index] === 0 ? '0' : String(grid[index])
  return out
}

export function isValidGivensString(value) {
  if (typeof value !== 'string' || value.length !== 81) return false
  for (let index = 0; index < 81; index += 1) {
    if (value[index] < '0' || value[index] > '9') return false
  }
  try {
    parseGivens(value)
    return true
  } catch (error) {
    return false
  }
}

export function countNonZero(grid) {
  let total = 0
  for (const value of grid) if (value !== 0) total += 1
  return total
}

// Uniqueness oracle (my own solver from the v1 audit).
export function countSolutions(givens, limit = 2) {
  return refCountSolutions(parseGivens(givens), limit)
}

export function solve(givens) {
  return refSolve(parseGivens(givens))
}

export function conflicts(grid) {
  return refConflicts(grid)
}

export function isSolved(grid) {
  return refIsSolved(grid)
}

export { refConflicts, refConsistent, refIsSolved, refIsValidSolution }

// ---------------------------------------------------------------------------
// Units / peers
// ---------------------------------------------------------------------------
export const ROW_UNITS = Array.from({ length: 9 }, (_, row) =>
  Array.from({ length: 9 }, (_, col) => row * 9 + col),
)
export const COL_UNITS = Array.from({ length: 9 }, (_, col) =>
  Array.from({ length: 9 }, (_, row) => row * 9 + col),
)
export const BOX_UNITS = Array.from({ length: 9 }, (_, box) => {
  const startRow = Math.floor(box / 3) * 3
  const startCol = (box % 3) * 3
  const cells = []
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) cells.push((startRow + r) * 9 + startCol + c)
  }
  return cells
})
/** Units 0..8 = rows, 9..17 = cols, 18..26 = boxes (api-spec-v2 §1). */
export const UNITS = [...ROW_UNITS, ...COL_UNITS, ...BOX_UNITS]
export const BOX_OF_CELL = (() => {
  const out = new Array(81)
  for (let box = 0; box < 9; box += 1) for (const cell of BOX_UNITS[box]) out[cell] = box
  return out
})()
export const PEERS = (() => {
  const out = new Array(81)
  for (let cell = 0; cell < 81; cell += 1) {
    const row = Math.floor(cell / 9)
    const col = cell % 9
    const set = new Set()
    for (const other of ROW_UNITS[row]) set.add(other)
    for (const other of COL_UNITS[col]) set.add(other)
    for (const other of BOX_UNITS[BOX_OF_CELL[cell]]) set.add(other)
    set.delete(cell)
    out[cell] = [...set].sort((a, b) => a - b)
  }
  return out
})()

// ---------------------------------------------------------------------------
// Candidate-array board used by the technique solver
// ---------------------------------------------------------------------------
function createBoard(givens) {
  const grid = givens.slice()
  const cands = new Array(81).fill(null)
  for (let cell = 0; cell < 81; cell += 1) {
    if (grid[cell] !== 0) continue
    const used = new Set()
    for (const peer of PEERS[cell]) if (grid[peer] !== 0) used.add(grid[peer])
    const list = []
    for (let digit = 1; digit <= 9; digit += 1) if (!used.has(digit)) list.push(digit)
    cands[cell] = list
  }
  return { grid, cands }
}

function setValue(board, cell, digit) {
  board.grid[cell] = digit
  board.cands[cell] = null
  for (const peer of PEERS[cell]) {
    const list = board.cands[peer]
    if (!list) continue
    const at = list.indexOf(digit)
    if (at !== -1) list.splice(at, 1)
  }
}

function removeCandidate(board, cell, digit) {
  const list = board.cands[cell]
  if (!list) return false
  const at = list.indexOf(digit)
  if (at === -1) return false
  list.splice(at, 1)
  return true
}

function boardFull(grid) {
  for (let index = 0; index < 81; index += 1) if (grid[index] === 0) return false
  return true
}

function candidateCells(board, unitCells, digit) {
  const out = []
  for (const cell of unitCells) {
    const list = board.cands[cell]
    if (list && list.indexOf(digit) !== -1) out.push(cell)
  }
  return out
}

// ---------------------------------------------------------------------------
// Techniques — each returns true when it changed the board.
// Within one call every applicable instance is applied (deterministic order),
// then the main loop restarts at level 1 per api-spec-v2 §1.
// ---------------------------------------------------------------------------
function applyNakedSingles(board) {
  let changed = false
  let again = true
  while (again) {
    again = false
    for (let cell = 0; cell < 81; cell += 1) {
      const list = board.cands[cell]
      if (board.grid[cell] === 0 && list && list.length === 1) {
        setValue(board, cell, list[0])
        changed = true
        again = true
      }
    }
  }
  return changed
}

function applyHiddenSingles(board) {
  let changed = false
  let again = true
  while (again) {
    again = false
    outer: for (let unit = 0; unit < 27; unit += 1) {
      const cells = UNITS[unit]
      for (let digit = 1; digit <= 9; digit += 1) {
        let found = -1
        let count = 0
        for (const cell of cells) {
          const list = board.cands[cell]
          if (list && list.indexOf(digit) !== -1) {
            count += 1
            found = cell
            if (count > 1) break
          }
        }
        if (count === 1 && board.grid[found] === 0) {
          setValue(board, found, digit)
          changed = true
          again = true
          break outer
        }
      }
    }
  }
  return changed
}

function applyPointing(board) {
  let changed = false
  for (let box = 0; box < 9; box += 1) {
    const cells = BOX_UNITS[box]
    for (let digit = 1; digit <= 9; digit += 1) {
      const positions = candidateCells(board, cells, digit)
      if (positions.length < 2) continue
      const rows = new Set(positions.map((cell) => Math.floor(cell / 9)))
      if (rows.size === 1) {
        const rowCells = ROW_UNITS[Math.floor(positions[0] / 9)]
        for (const target of rowCells) {
          if (cells.indexOf(target) !== -1) continue
          if (removeCandidate(board, target, digit)) changed = true
        }
      }
      const cols = new Set(positions.map((cell) => cell % 9))
      if (cols.size === 1) {
        const col = positions[0] % 9
        for (const target of COL_UNITS[col]) {
          if (cells.indexOf(target) !== -1) continue
          if (removeCandidate(board, target, digit)) changed = true
        }
      }
    }
  }
  return changed
}

function applyClaiming(board) {
  let changed = false
  const lineSets = [ROW_UNITS, COL_UNITS]
  for (let kind = 0; kind < lineSets.length; kind += 1) {
    for (let line = 0; line < 9; line += 1) {
      const cells = lineSets[kind][line]
      for (let digit = 1; digit <= 9; digit += 1) {
        const positions = candidateCells(board, cells, digit)
        if (positions.length < 2) continue
        const boxes = new Set(positions.map((cell) => BOX_OF_CELL[cell]))
        if (boxes.size !== 1) continue
        const boxCells = BOX_UNITS[BOX_OF_CELL[positions[0]]]
        for (const target of boxCells) {
          if (cells.indexOf(target) !== -1) continue
          if (removeCandidate(board, target, digit)) changed = true
        }
      }
    }
  }
  return changed
}

function applyNakedSubset(board, size) {
  let changed = false
  let again = true
  while (again) {
    again = false
    outer: for (let unit = 0; unit < 27; unit += 1) {
      const cells = UNITS[unit]
      const eligible = []
      for (const cell of cells) {
        const list = board.cands[cell]
        if (list && list.length >= 2 && list.length <= size) eligible.push(cell)
      }
      if (eligible.length < size) continue
      const combo = new Array(size)
      const search = (start, depth) => {
        if (depth === size) {
          const union = new Set()
          for (let index = 0; index < size; index += 1) {
            for (const digit of board.cands[combo[index]]) union.add(digit)
          }
          if (union.size !== size) return false
          let applied = false
          for (const cell of cells) {
            if (combo.indexOf(cell) !== -1) continue
            for (const digit of union) if (removeCandidate(board, cell, digit)) applied = true
          }
          return applied
        }
        for (let index = start; index < eligible.length; index += 1) {
          combo[depth] = eligible[index]
          if (search(index + 1, depth + 1)) return true
        }
        return false
      }
      if (search(0, 0)) {
        changed = true
        again = true
        break outer
      }
    }
  }
  return changed
}

function applyHiddenSubset(board, size) {
  let changed = false
  let again = true
  while (again) {
    again = false
    outer: for (let unit = 0; unit < 27; unit += 1) {
      const cells = UNITS[unit]
      const digitPositions = []
      for (let digit = 1; digit <= 9; digit += 1) {
        const positions = candidateCells(board, cells, digit)
        if (positions.length > 0) digitPositions.push({ digit, positions })
      }
      const combo = new Array(size)
      const search = (start, depth) => {
        if (depth === size) {
          const union = new Set()
          for (let index = 0; index < size; index += 1) {
            for (const cell of combo[index].positions) union.add(cell)
          }
          if (union.size !== size) return false
          const allowed = new Set(combo.map((entry) => entry.digit))
          let applied = false
          for (const cell of union) {
            const list = board.cands[cell]
            if (!list) continue
            for (let index = list.length - 1; index >= 0; index -= 1) {
              if (allowed.has(list[index])) continue
              list.splice(index, 1)
              applied = true
            }
          }
          return applied
        }
        for (let index = start; index < digitPositions.length; index += 1) {
          combo[depth] = digitPositions[index]
          if (search(index + 1, depth + 1)) return true
        }
        return false
      }
      if (search(0, 0)) {
        changed = true
        again = true
        break outer
      }
    }
  }
  return changed
}

function applyXWing(board) {
  let changed = false
  let again = true
  while (again) {
    again = false
    outer: for (let digit = 1; digit <= 9; digit += 1) {
      // row orientation
      for (let first = 0; first < 9; first += 1) {
        const firstCells = candidateCells(board, ROW_UNITS[first], digit)
        if (firstCells.length !== 2) continue
        const firstCols = firstCells.map((cell) => cell % 9)
        for (let second = first + 1; second < 9; second += 1) {
          const secondCells = candidateCells(board, ROW_UNITS[second], digit)
          if (secondCells.length !== 2) continue
          const secondCols = secondCells.map((cell) => cell % 9)
          if (firstCols[0] !== secondCols[0] || firstCols[1] !== secondCols[1]) continue
          for (const col of firstCols) {
            for (let row = 0; row < 9; row += 1) {
              if (row === first || row === second) continue
              if (removeCandidate(board, row * 9 + col, digit)) {
                changed = true
                again = true
              }
            }
          }
          if (again) break outer
        }
      }
      // column orientation
      for (let first = 0; first < 9; first += 1) {
        const firstCells = candidateCells(board, COL_UNITS[first], digit)
        if (firstCells.length !== 2) continue
        const firstRows = firstCells.map((cell) => Math.floor(cell / 9))
        for (let second = first + 1; second < 9; second += 1) {
          const secondCells = candidateCells(board, COL_UNITS[second], digit)
          if (secondCells.length !== 2) continue
          const secondRows = secondCells.map((cell) => Math.floor(cell / 9))
          if (firstRows[0] !== secondRows[0] || firstRows[1] !== secondRows[1]) continue
          for (const row of firstRows) {
            for (let col = 0; col < 9; col += 1) {
              if (col === first || col === second) continue
              if (removeCandidate(board, row * 9 + col, digit)) {
                changed = true
                again = true
              }
            }
          }
          if (again) break outer
        }
      }
    }
  }
  return changed
}

function applyXYWing(board) {
  let changed = false
  let again = true
  while (again) {
    again = false
    outer: for (let pivot = 0; pivot < 81; pivot += 1) {
      const pivotCands = board.cands[pivot]
      if (!pivotCands || pivotCands.length !== 2) continue
      const [a, b] = pivotCands
      const pincers = []
      for (const cell of PEERS[pivot]) {
        const list = board.cands[cell]
        if (!list || list.length !== 2) continue
        const hasA = list.indexOf(a) !== -1
        const hasB = list.indexOf(b) !== -1
        if (hasA === hasB) continue // must share exactly one digit with the pivot
        const shared = hasA ? a : b
        const other = list[0] === shared ? list[1] : list[0]
        pincers.push({ cell, shared, other })
      }
      for (let first = 0; first < pincers.length; first += 1) {
        for (let second = first + 1; second < pincers.length; second += 1) {
          const pincerA = pincers[first]
          const pincerB = pincers[second]
          if (pincerA.shared === pincerB.shared) continue
          if (pincerA.other !== pincerB.other) continue
          const z = pincerA.other
          for (const target of PEERS[pincerA.cell]) {
            if (PEERS[pincerB.cell].indexOf(target) === -1) continue
            if (target === pincerA.cell || target === pincerB.cell) continue
            if (removeCandidate(board, target, z)) {
              changed = true
              again = true
            }
          }
          if (again) break outer
        }
      }
    }
  }
  return changed
}

const TECHNIQUE_APPLIERS = [
  { technique: 'naked-single', level: 1, apply: applyNakedSingles },
  { technique: 'hidden-single', level: 1, apply: applyHiddenSingles },
  { technique: 'pointing', level: 2, apply: applyPointing },
  { technique: 'claiming', level: 2, apply: applyClaiming },
  { technique: 'naked-pair', level: 3, apply: (board) => applyNakedSubset(board, 2) },
  { technique: 'naked-triple', level: 3, apply: (board) => applyNakedSubset(board, 3) },
  { technique: 'hidden-pair', level: 3, apply: (board) => applyHiddenSubset(board, 2) },
  { technique: 'hidden-triple', level: 3, apply: (board) => applyHiddenSubset(board, 3) },
  { technique: 'x-wing', level: 4, apply: applyXWing },
  { technique: 'xy-wing', level: 4, apply: applyXYWing },
]

/**
 * Verifier self-test hook: run a single technique against a synthetic candidate
 * board. `cands[cell]` is an array of digits (or null for a filled cell) and all
 * cells are treated as empty. Returns the changed candidate board.
 */
export function _runTechniqueOnCands(cands, technique) {
  const entry = TECHNIQUE_APPLIERS.find((item) => item.technique === technique)
  if (!entry) throw new TypeError('unknown technique ' + technique)
  const board = {
    grid: new Array(81).fill(0),
    cands: cands.map((list) => (list ? list.slice() : null)),
  }
  const changed = entry.apply(board)
  return { changed, cands: board.cands, grid: board.grid }
}

/**
 * Independent grade oracle.
 * @param {string|number[]} input givens
 * @returns {{grade:string, level:number, solved:boolean, techniques:string[],
 *   solution:number[]|null, stuck:boolean, steps:Array<{level:number,technique:string}>,
 *   maxLevel:number}}
 */
export function gradePuzzle(input) {
  const givens = parseGivens(input)
  const solutions = refCountSolutions(givens, 2)
  if (solutions !== 1) {
    return {
      grade: 'invalid',
      level: 0,
      solved: false,
      techniques: [],
      solution: null,
      stuck: false,
      steps: [],
      maxLevel: 0,
      reason: solutions === 0 ? 'no-solution' : 'multiple-solutions',
    }
  }
  const solution = refSolve(givens)
  const board = createBoard(givens)
  const techniques = []
  const steps = []
  let maxLevel = 0
  let stuck = false

  for (;;) {
    if (boardFull(board.grid)) break
    let applied = null
    for (const entry of TECHNIQUE_APPLIERS) {
      if (entry.apply(board)) {
        applied = entry
        break
      }
    }
    if (!applied) {
      stuck = true
      break
    }
    if (techniques.indexOf(applied.technique) === -1) {
      techniques.push(applied.technique)
      steps.push({ level: applied.level, technique: applied.technique })
    }
    if (applied.level > maxLevel) maxLevel = applied.level
  }

  const solved = boardFull(board.grid)
  // Internal sanity: a technique-only solve must land exactly on the unique solution.
  if (solved) {
    for (let index = 0; index < 81; index += 1) {
      if (board.grid[index] !== solution[index]) {
        throw new Error('oracle internal error: technique solve diverged at cell ' + index)
      }
    }
  }
  const grade = stuck ? 'hell' : GRADE_BY_LEVEL[maxLevel] || 'easy'
  const level = stuck ? 5 : Math.max(1, maxLevel)
  return { grade, level, solved, techniques, solution, stuck, steps, maxLevel }
}

// ---------------------------------------------------------------------------
// Granularity variant used to explain bank technique lists.
// api-spec-v2 §1 explicitly allows applying "all found" changes at once OR
// applying them one at a time, as long as the order is deterministic. The
// batch pipeline above is one valid reading; the bank grader may use the
// one-at-a-time reading, which changes which techniques appear first (most
// visibly naked-single vs hidden-single). This variant lets the audit verify
// that the recorded bank lists are a legal reading of the frozen order.
// ---------------------------------------------------------------------------
function fillTargetNakedSingle(board) {
  for (let cell = 0; cell < 81; cell += 1) {
    const list = board.cands[cell]
    if (board.grid[cell] === 0 && list && list.length === 1) return { cell, digit: list[0] }
  }
  return null
}

function fillTargetHiddenSingle(board) {
  for (let unit = 0; unit < 27; unit += 1) {
    const cells = UNITS[unit]
    for (let digit = 1; digit <= 9; digit += 1) {
      let found = -1
      let count = 0
      for (const cell of cells) {
        const list = board.cands[cell]
        if (list && list.indexOf(digit) !== -1) {
          count += 1
          found = cell
          if (count > 1) break
        }
      }
      if (count === 1 && board.grid[found] === 0) return { cell: found, digit }
    }
  }
  return null
}

/** Returns the elimination list for the FIRST applicable pattern of a technique. */
function eliminationTargetsPointing(board) {
  for (let box = 0; box < 9; box += 1) {
    const cells = BOX_UNITS[box]
    for (let digit = 1; digit <= 9; digit += 1) {
      const positions = candidateCells(board, cells, digit)
      if (positions.length < 2) continue
      const rows = new Set(positions.map((cell) => Math.floor(cell / 9)))
      if (rows.size === 1) {
        const targets = []
        for (const target of ROW_UNITS[Math.floor(positions[0] / 9)]) {
          if (cells.indexOf(target) !== -1) continue
          if (board.cands[target] && board.cands[target].indexOf(digit) !== -1) targets.push([target, digit])
        }
        if (targets.length) return targets
      }
      const cols = new Set(positions.map((cell) => cell % 9))
      if (cols.size === 1) {
        const targets = []
        for (const target of COL_UNITS[positions[0] % 9]) {
          if (cells.indexOf(target) !== -1) continue
          if (board.cands[target] && board.cands[target].indexOf(digit) !== -1) targets.push([target, digit])
        }
        if (targets.length) return targets
      }
    }
  }
  return null
}

function eliminationTargetsClaiming(board) {
  const lines = [ROW_UNITS, COL_UNITS]
  for (let kind = 0; kind < 2; kind += 1) {
    for (let line = 0; line < 9; line += 1) {
      const cells = lines[kind][line]
      for (let digit = 1; digit <= 9; digit += 1) {
        const positions = candidateCells(board, cells, digit)
        if (positions.length < 2) continue
        const boxes = new Set(positions.map((cell) => BOX_OF_CELL[cell]))
        if (boxes.size !== 1) continue
        const targets = []
        for (const target of BOX_UNITS[BOX_OF_CELL[positions[0]]]) {
          if (cells.indexOf(target) !== -1) continue
          if (board.cands[target] && board.cands[target].indexOf(digit) !== -1) targets.push([target, digit])
        }
        if (targets.length) return targets
      }
    }
  }
  return null
}

function eliminationTargetsNakedSubset(board, size) {
  for (let unit = 0; unit < 27; unit += 1) {
    const cells = UNITS[unit]
    const eligible = []
    for (const cell of cells) {
      const list = board.cands[cell]
      if (list && list.length >= 2 && list.length <= size) eligible.push(cell)
    }
    const combo = new Array(size)
    const search = (start, depth) => {
      if (depth === size) {
        const union = new Set()
        for (let index = 0; index < size; index += 1) {
          for (const digit of board.cands[combo[index]]) union.add(digit)
        }
        if (union.size !== size) return null
        const targets = []
        for (const cell of cells) {
          if (combo.indexOf(cell) !== -1) continue
          for (const digit of union) {
            if (board.cands[cell] && board.cands[cell].indexOf(digit) !== -1) targets.push([cell, digit])
          }
        }
        return targets.length ? targets : null
      }
      for (let index = start; index < eligible.length; index += 1) {
        combo[depth] = eligible[index]
        const found = search(index + 1, depth + 1)
        if (found) return found
      }
      return null
    }
    const found = search(0, 0)
    if (found) return found
  }
  return null
}

function eliminationTargetsHiddenSubset(board, size) {
  for (let unit = 0; unit < 27; unit += 1) {
    const cells = UNITS[unit]
    const digitPositions = []
    for (let digit = 1; digit <= 9; digit += 1) {
      const positions = candidateCells(board, cells, digit)
      if (positions.length > 0) digitPositions.push({ digit, positions })
    }
    const combo = new Array(size)
    const search = (start, depth) => {
      if (depth === size) {
        const union = new Set()
        for (let index = 0; index < size; index += 1) {
          for (const cell of combo[index].positions) union.add(cell)
        }
        if (union.size !== size) return null
        const allowed = new Set(combo.map((entry) => entry.digit))
        const targets = []
        for (const cell of union) {
          const list = board.cands[cell]
          if (!list) continue
          for (const digit of list) if (!allowed.has(digit)) targets.push([cell, digit])
        }
        return targets.length ? targets : null
      }
      for (let index = start; index < digitPositions.length; index += 1) {
        combo[depth] = digitPositions[index]
        const found = search(index + 1, depth + 1)
        if (found) return found
      }
      return null
    }
    const found = search(0, 0)
    if (found) return found
  }
  return null
}

function eliminationTargetsXWing(board) {
  for (let digit = 1; digit <= 9; digit += 1) {
    for (let first = 0; first < 9; first += 1) {
      const firstCells = candidateCells(board, ROW_UNITS[first], digit)
      if (firstCells.length !== 2) continue
      const cols = firstCells.map((cell) => cell % 9)
      for (let second = first + 1; second < 9; second += 1) {
        const secondCells = candidateCells(board, ROW_UNITS[second], digit)
        if (secondCells.length !== 2) continue
        const secondCols = secondCells.map((cell) => cell % 9)
        if (cols[0] !== secondCols[0] || cols[1] !== secondCols[1]) continue
        const targets = []
        for (const col of cols) {
          for (let row = 0; row < 9; row += 1) {
            if (row === first || row === second) continue
            const cell = row * 9 + col
            if (board.cands[cell] && board.cands[cell].indexOf(digit) !== -1) targets.push([cell, digit])
          }
        }
        if (targets.length) return targets
      }
    }
    for (let first = 0; first < 9; first += 1) {
      const firstCells = candidateCells(board, COL_UNITS[first], digit)
      if (firstCells.length !== 2) continue
      const rows = firstCells.map((cell) => Math.floor(cell / 9))
      for (let second = first + 1; second < 9; second += 1) {
        const secondCells = candidateCells(board, COL_UNITS[second], digit)
        if (secondCells.length !== 2) continue
        const secondRows = secondCells.map((cell) => Math.floor(cell / 9))
        if (rows[0] !== secondRows[0] || rows[1] !== secondRows[1]) continue
        const targets = []
        for (const row of rows) {
          for (let col = 0; col < 9; col += 1) {
            if (col === first || col === second) continue
            const cell = row * 9 + col
            if (board.cands[cell] && board.cands[cell].indexOf(digit) !== -1) targets.push([cell, digit])
          }
        }
        if (targets.length) return targets
      }
    }
  }
  return null
}

function eliminationTargetsXYWing(board) {
  for (let pivot = 0; pivot < 81; pivot += 1) {
    const pivotCands = board.cands[pivot]
    if (!pivotCands || pivotCands.length !== 2) continue
    const [a, b] = pivotCands
    const pincers = []
    for (const cell of PEERS[pivot]) {
      const list = board.cands[cell]
      if (!list || list.length !== 2) continue
      const hasA = list.indexOf(a) !== -1
      const hasB = list.indexOf(b) !== -1
      if (hasA === hasB) continue
      pincers.push({ cell, shared: hasA ? a : b, other: list[0] === (hasA ? a : b) ? list[1] : list[0] })
    }
    for (let first = 0; first < pincers.length; first += 1) {
      for (let second = first + 1; second < pincers.length; second += 1) {
        const pincerA = pincers[first]
        const pincerB = pincers[second]
        if (pincerA.shared === pincerB.shared) continue
        if (pincerA.other !== pincerB.other) continue
        const z = pincerA.other
        const targets = []
        for (const target of PEERS[pincerA.cell]) {
          if (PEERS[pincerB.cell].indexOf(target) === -1) continue
          if (target === pincerA.cell || target === pincerB.cell) continue
          if (board.cands[target] && board.cands[target].indexOf(z) !== -1) targets.push([target, z])
        }
        if (targets.length) return targets
      }
    }
  }
  return null
}

const VARIANT_STEPS = [
  { technique: 'naked-single', level: 1, kind: 'fill', single: fillTargetNakedSingle, batch: applyNakedSingles },
  { technique: 'hidden-single', level: 1, kind: 'fill', single: fillTargetHiddenSingle, batch: applyHiddenSingles },
  { technique: 'pointing', level: 2, kind: 'elim', find: eliminationTargetsPointing, batch: applyPointing },
  { technique: 'claiming', level: 2, kind: 'elim', find: eliminationTargetsClaiming, batch: applyClaiming },
  { technique: 'naked-pair', level: 3, kind: 'elim', find: (board) => eliminationTargetsNakedSubset(board, 2), batch: (board) => applyNakedSubset(board, 2) },
  { technique: 'naked-triple', level: 3, kind: 'elim', find: (board) => eliminationTargetsNakedSubset(board, 3), batch: (board) => applyNakedSubset(board, 3) },
  { technique: 'hidden-pair', level: 3, kind: 'elim', find: (board) => eliminationTargetsHiddenSubset(board, 2), batch: (board) => applyHiddenSubset(board, 2) },
  { technique: 'hidden-triple', level: 3, kind: 'elim', find: (board) => eliminationTargetsHiddenSubset(board, 3), batch: (board) => applyHiddenSubset(board, 3) },
  { technique: 'x-wing', level: 4, kind: 'elim', find: eliminationTargetsXWing, batch: applyXWing },
  { technique: 'xy-wing', level: 4, kind: 'elim', find: eliminationTargetsXYWing, batch: applyXYWing },
]

/**
 * Same frozen technique order as gradePuzzle, but with a configurable
 * application granularity:
 *   fills: 'single' (one placement per restart) | 'batch' (all placements)
 *   eliminations: 'pattern' (all eliminations of the first pattern) |
 *                 'one' (only the first elimination) | 'batch' (all patterns)
 */
export function gradePuzzleVariant(input, options = {}) {
  const fills = options.fills || 'single'
  const eliminations = options.eliminations || 'pattern'
  const givens = parseGivens(input)
  const solutions = refCountSolutions(givens, 2)
  if (solutions !== 1) {
    return { grade: 'invalid', level: 0, solved: false, techniques: [], solution: null, stuck: false, steps: [], maxLevel: 0 }
  }
  const solution = refSolve(givens)
  const board = createBoard(givens)
  const techniques = []
  const steps = []
  let maxLevel = 0
  let stuck = false
  for (;;) {
    if (boardFull(board.grid)) break
    let applied = null
    for (const entry of VARIANT_STEPS) {
      let changed = false
      if (entry.kind === 'fill') {
        if (fills === 'batch') {
          changed = entry.batch(board)
        } else {
          const target = entry.single(board)
          if (target) {
            setValue(board, target.cell, target.digit)
            changed = true
          }
        }
      } else if (eliminations === 'batch') {
        changed = entry.batch(board)
      } else {
        const targets = entry.find(board)
        if (targets && targets.length) {
          const list = eliminations === 'one' ? targets.slice(0, 1) : targets
          for (const [cell, digit] of list) {
            if (removeCandidate(board, cell, digit)) changed = true
          }
        }
      }
      if (changed) {
        applied = entry
        break
      }
    }
    if (!applied) {
      stuck = true
      break
    }
    if (techniques.indexOf(applied.technique) === -1) {
      techniques.push(applied.technique)
      steps.push({ level: applied.level, technique: applied.technique })
    }
    if (applied.level > maxLevel) maxLevel = applied.level
  }
  const solved = boardFull(board.grid)
  if (solved) {
    for (let index = 0; index < 81; index += 1) {
      if (board.grid[index] !== solution[index]) {
        throw new Error('oracle variant internal error: technique solve diverged at cell ' + index)
      }
    }
  }
  const grade = stuck ? 'hell' : GRADE_BY_LEVEL[maxLevel] || 'easy'
  const level = stuck ? 5 : Math.max(1, maxLevel)
  return { grade, level, solved, techniques, solution, stuck, steps, maxLevel }
}

// ---------------------------------------------------------------------------
// Generator used for the 100-random-unique-puzzles check
// ---------------------------------------------------------------------------
/** xorshift32 — deliberately different PRNG from the spec's mulberry32. */
export function makeRng(seed) {
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

function shuffled(array, rng) {
  const copy = array.slice()
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(rng() * (index + 1))
    const temp = copy[index]
    copy[index] = copy[pick]
    copy[pick] = temp
  }
  return copy
}

/** Random complete legal grid via randomized backtracking (no uniqueness solver). */
export function generateFullGrid(rng) {
  const grid = new Array(81).fill(0)
  const rowUsed = Array.from({ length: 9 }, () => new Set())
  const colUsed = Array.from({ length: 9 }, () => new Set())
  const boxUsed = Array.from({ length: 9 }, () => new Set())

  function fill(cell) {
    if (cell === 81) return true
    const row = Math.floor(cell / 9)
    const col = cell % 9
    const box = BOX_OF_CELL[cell]
    const digits = shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9], rng)
    for (const digit of digits) {
      if (rowUsed[row].has(digit) || colUsed[col].has(digit) || boxUsed[box].has(digit)) continue
      grid[cell] = digit
      rowUsed[row].add(digit)
      colUsed[col].add(digit)
      boxUsed[box].add(digit)
      if (fill(cell + 1)) return true
      grid[cell] = 0
      rowUsed[row].delete(digit)
      colUsed[col].delete(digit)
      boxUsed[box].delete(digit)
    }
    return false
  }

  if (!fill(0)) throw new Error('oracle generator failed to build a full grid')
  return grid
}

/** Dig a full grid down to a unique-solution puzzle (verifier-owned strategy). */
export function generateUniquePuzzle(rng) {
  const solution = generateFullGrid(rng)
  const givens = solution.slice()
  const order = shuffled(Array.from({ length: 81 }, (_, index) => index), rng)
  for (const cell of order) {
    const value = givens[cell]
    givens[cell] = 0
    const count = refCountSolutions(givens, 2)
    if (count !== 1) givens[cell] = value
  }
  return { givens, solution, clues: countNonZero(givens) }
}

// ---------------------------------------------------------------------------
// Bank id (api-spec-v2 §2): grade prefix + FNV-1a32(givens) base36
// ---------------------------------------------------------------------------
export function fnv1a32(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function puzzleId(grade, givensString) {
  return grade + '-' + fnv1a32(givensString).toString(36)
}
