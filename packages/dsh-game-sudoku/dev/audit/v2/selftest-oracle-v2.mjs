/**
 * Self-test for the v2 independent technique oracle (no bank/client needed).
 *
 * Run: node dev/audit/v2/selftest-oracle-v2.mjs
 *
 * Validates every technique implementation against a synthetic candidate board
 * with a hand-built pattern (so each elimination/placement rule is checked in
 * isolation), plus determinism and uniqueness/oracle sanity.
 */
import assert from 'node:assert/strict'
import {
  ALL_TECHNIQUES,
  PEERS,
  TECHNIQUE_LEVEL,
  _runTechniqueOnCands,
  countNonZero,
  countSolutions,
  generateFullGrid,
  generateUniquePuzzle,
  gradePuzzle,
  gridToString,
  makeRng,
  parseGivens,
  puzzleId,
  fnv1a32,
} from './oracle.mjs'
import { CLASSIC_PUZZLE } from '../reference.mjs'
import { createRunner, must } from '../harness.mjs'

const runner = createRunner('v2 oracle self-test')

function fullCands() {
  return Array.from({ length: 81 }, () => [1, 2, 3, 4, 5, 6, 7, 8, 9])
}

function removeFrom(cands, cell, digits) {
  cands[cell] = cands[cell].filter((digit) => digits.indexOf(digit) === -1)
}

function has(cands, cell, digit) {
  return cands[cell] !== null && cands[cell].indexOf(digit) !== -1
}

runner.check('technique metadata covers all 5 levels in the frozen order', () => {
  assert.deepEqual(ALL_TECHNIQUES, [
    'naked-single',
    'hidden-single',
    'pointing',
    'claiming',
    'naked-pair',
    'naked-triple',
    'hidden-pair',
    'hidden-triple',
    'x-wing',
    'xy-wing',
  ])
  assert.equal(TECHNIQUE_LEVEL['naked-single'], 1)
  assert.equal(TECHNIQUE_LEVEL['hidden-single'], 1)
  assert.equal(TECHNIQUE_LEVEL.pointing, 2)
  assert.equal(TECHNIQUE_LEVEL.claiming, 2)
  assert.equal(TECHNIQUE_LEVEL['naked-pair'], 3)
  assert.equal(TECHNIQUE_LEVEL['naked-triple'], 3)
  assert.equal(TECHNIQUE_LEVEL['hidden-pair'], 3)
  assert.equal(TECHNIQUE_LEVEL['hidden-triple'], 3)
  assert.equal(TECHNIQUE_LEVEL['x-wing'], 4)
  assert.equal(TECHNIQUE_LEVEL['xy-wing'], 4)
})

runner.check('naked-single fills a cell with exactly one candidate', () => {
  const cands = fullCands()
  cands[5] = [7]
  const result = _runTechniqueOnCands(cands, 'naked-single')
  assert.equal(result.changed, true)
  assert.equal(result.grid[5], 7)
  // 7 is removed from every peer of cell 5
  for (const peer of PEERS[5]) assert.equal(has(result.cands, peer, 7), false, 'peer ' + peer + ' should drop 7')
})

runner.check('hidden-single fills the only place for a digit in a unit', () => {
  const cands = fullCands()
  // Row 0: digit 9 only possible at cell 4.
  for (let col = 0; col < 9; col += 1) if (col !== 4) removeFrom(cands, col, [9])
  const result = _runTechniqueOnCands(cands, 'hidden-single')
  assert.equal(result.changed, true)
  assert.notEqual(result.grid[4], 0)
})

runner.check('pointing eliminates a box-digit from the rest of its row', () => {
  const cands = fullCands()
  // box 0 (cells 0,1,2,9,10,11,18,19,20): digit 5 only in row 0 cells 0,1
  for (const cell of [2, 9, 10, 11, 18, 19, 20]) removeFrom(cands, cell, [5])
  const result = _runTechniqueOnCands(cands, 'pointing')
  assert.equal(result.changed, true)
  for (const cell of [3, 4, 5, 6, 7, 8]) {
    assert.equal(has(result.cands, cell, 5), false, 'pointing must drop 5 at row-0 cell ' + cell)
  }
  // candidate outside the line must be untouched
  assert.equal(has(result.cands, 12, 5), true)
})

runner.check('claiming eliminates a line-digit from the rest of its box', () => {
  const cands = fullCands()
  // row 0: digit 5 only inside box 0 (cells 0,1,2)
  for (const cell of [3, 4, 5, 6, 7, 8]) removeFrom(cands, cell, [5])
  const result = _runTechniqueOnCands(cands, 'claiming')
  assert.equal(result.changed, true)
  for (const cell of [9, 10, 11, 18, 19, 20]) {
    assert.equal(has(result.cands, cell, 5), false, 'claiming must drop 5 at box cell ' + cell)
  }
  assert.equal(has(result.cands, 3, 5), false) // removed as given setup, not by claiming
})

runner.check('naked-pair removes both digits from the other cells of a unit', () => {
  const cands = fullCands()
  cands[0] = [1, 2]
  cands[1] = [1, 2]
  const result = _runTechniqueOnCands(cands, 'naked-pair')
  assert.equal(result.changed, true)
  for (const cell of [2, 3, 4, 5, 6, 7, 8]) {
    assert.equal(has(result.cands, cell, 1), false)
    assert.equal(has(result.cands, cell, 2), false)
  }
  assert.deepEqual(result.cands[0], [1, 2])
})

runner.check('naked-triple removes the union from the other cells of a unit', () => {
  const cands = fullCands()
  cands[0] = [1, 2]
  cands[1] = [1, 3]
  cands[2] = [2, 3]
  const result = _runTechniqueOnCands(cands, 'naked-triple')
  assert.equal(result.changed, true)
  for (const cell of [3, 4, 5, 6, 7, 8]) {
    for (const digit of [1, 2, 3]) assert.equal(has(result.cands, cell, digit), false, 'cell ' + cell + ' digit ' + digit)
  }
})

runner.check('hidden-pair removes the extra candidates from the two cells', () => {
  const cands = fullCands()
  // row 0: digits 1,2 only in cells 0 and 1; cell 0 also has 3, cell 1 also has 4.
  for (const cell of [2, 3, 4, 5, 6, 7, 8]) removeFrom(cands, cell, [1, 2])
  cands[0] = [1, 2, 3]
  cands[1] = [1, 2, 4]
  const result = _runTechniqueOnCands(cands, 'hidden-pair')
  assert.equal(result.changed, true)
  assert.equal(has(result.cands, 0, 3), false, 'hidden pair must drop 3 from cell 0')
  assert.equal(has(result.cands, 1, 4), false, 'hidden pair must drop 4 from cell 1')
  assert.deepEqual(result.cands[0].slice().sort((a, b) => a - b), [1, 2])
})

runner.check('hidden-triple removes the extra candidates from the three cells', () => {
  const cands = fullCands()
  for (const cell of [3, 4, 5, 6, 7, 8]) removeFrom(cands, cell, [1, 2, 3])
  cands[0] = [1, 2, 4]
  cands[1] = [1, 3, 5]
  cands[2] = [2, 3, 6]
  const result = _runTechniqueOnCands(cands, 'hidden-triple')
  assert.equal(result.changed, true)
  for (const digit of [4, 5, 6]) {
    assert.equal(has(result.cands, 0, digit), false, 'hidden triple must drop ' + digit + ' from cell 0')
  }
  assert.equal(has(result.cands, 1, 5), false)
  assert.equal(has(result.cands, 2, 6), false)
})

runner.check('x-wing (row orientation) eliminates the digit from the aligned columns', () => {
  const cands = fullCands()
  // Rows 0 and 4: digit 5 only at cols 2 and 7 -> eliminate 5 from rows 1,2,3,5,6,7,8 in cols 2,7.
  for (const col of [0, 1, 3, 4, 5, 6, 8]) {
    removeFrom(cands, 0 * 9 + col, [5])
    removeFrom(cands, 4 * 9 + col, [5])
  }
  const result = _runTechniqueOnCands(cands, 'x-wing')
  assert.equal(result.changed, true)
  for (const row of [1, 2, 3, 5, 6, 7, 8]) {
    for (const col of [2, 7]) {
      assert.equal(has(result.cands, row * 9 + col, 5), false, 'x-wing must drop 5 at r' + row + 'c' + col)
    }
  }
  // the defining cells keep their candidate
  assert.equal(has(result.cands, 0 * 9 + 2, 5), true)
  assert.equal(has(result.cands, 4 * 9 + 7, 5), true)
})

runner.check('x-wing (column orientation) eliminates the digit from the aligned rows', () => {
  const cands = fullCands()
  // Cols 0 and 6: digit 8 only at rows 1 and 5 -> eliminate 8 from cols 1..8 at rows 1,5.
  for (const row of [0, 2, 3, 4, 6, 7, 8]) {
    removeFrom(cands, row * 9 + 0, [8])
    removeFrom(cands, row * 9 + 6, [8])
  }
  const result = _runTechniqueOnCands(cands, 'x-wing')
  assert.equal(result.changed, true)
  for (const col of [1, 2, 3, 4, 5, 7, 8]) {
    for (const row of [1, 5]) {
      assert.equal(has(result.cands, row * 9 + col, 8), false, 'x-wing must drop 8 at r' + row + 'c' + col)
    }
  }
})

runner.check('xy-wing eliminates the shared pincer digit from cells seeing both pincers', () => {
  const cands = fullCands()
  const pivot = 4 * 9 + 4 // centre
  const pincerA = 4 * 9 + 5 // same row as pivot
  const pincerB = 5 * 9 + 4 // same column as pivot
  cands[pivot] = [1, 2]
  cands[pincerA] = [1, 3]
  cands[pincerB] = [2, 3]
  const result = _runTechniqueOnCands(cands, 'xy-wing')
  assert.equal(result.changed, true)
  // Cells that see both pincers: centre box plus the shared row/col cells.
  for (const cell of [3 * 9 + 3, 3 * 9 + 4, 3 * 9 + 5, 4 * 9 + 3, 5 * 9 + 3, 5 * 9 + 5]) {
    assert.equal(has(result.cands, cell, 3), false, 'xy-wing must drop 3 at cell ' + cell)
  }
  // A cell that only sees pincerA keeps its 3.
  assert.equal(has(result.cands, 4 * 9 + 6, 3), true)
})

runner.check('technique functions are deterministic and idempotent on a second pass', () => {
  const cands = fullCands()
  cands[0] = [1, 2]
  cands[1] = [1, 2]
  const first = _runTechniqueOnCands(cands, 'naked-pair')
  const second = _runTechniqueOnCands(cands, 'naked-pair')
  assert.deepEqual(first.cands, second.cands)
  const again = _runTechniqueOnCands(first.cands, 'naked-pair')
  assert.equal(again.changed, false, 'second application of the same elimination must not change anything')
})

runner.check('gradePuzzle metadata: classic puzzle solvable and deterministic', () => {
  const first = gradePuzzle(CLASSIC_PUZZLE)
  const second = gradePuzzle(CLASSIC_PUZZLE)
  assert.equal(first.solved, true)
  assert.equal(first.stuck, false)
  assert.ok(['easy', 'normal', 'hard', 'expert'].includes(first.grade))
  assert.deepEqual(first.techniques, second.techniques)
  assert.equal(first.grade, second.grade)
  // only singles on the classic puzzle -> easy
  assert.equal(first.grade, 'easy')
  assert.deepEqual(first.techniques, ['naked-single'])
})

runner.check('gradePuzzle rejects invalid boards and reports invalid', () => {
  const multi = gradePuzzle(new Array(81).fill(0))
  assert.equal(multi.grade, 'invalid')
  assert.equal(multi.solution, null)
  assert.throws(() => parseGivens('0'.repeat(80)), TypeError)
  assert.throws(() => gradePuzzle('0'.repeat(79) + 'x'), TypeError)
})

runner.check('unique-puzzle generation rate is 100% (20 samples) and puzzles grade deterministically', () => {
  const rng = makeRng(424242)
  let unique = 0
  for (let trial = 0; trial < 20; trial += 1) {
    const puzzle = generateUniquePuzzle(rng)
    assert.equal(countSolutions(puzzle.givens, 2), 1, 'generated puzzle must be unique')
    assert.ok(countNonZero(puzzle.givens) >= 17)
    assert.ok(gridToString(puzzle.givens).length === 81)
    const graded = gradePuzzle(puzzle.givens)
    assert.equal(graded.grade === 'invalid', false)
    assert.ok(graded.solution !== null)
    const regraded = gradePuzzle(puzzle.givens)
    assert.equal(regraded.grade, graded.grade)
    assert.deepEqual(regraded.techniques, graded.techniques)
    unique += 1
  }
  assert.equal(unique, 20)
})

runner.check('id hash: fnv1a32 is stable and the id is grade + base36 hash', () => {
  const givens = gridToString(CLASSIC_PUZZLE)
  assert.equal(fnv1a32(givens), fnv1a32(givens))
  assert.notEqual(fnv1a32(givens), fnv1a32(givens.slice(0, 80) + '1'))
  const id = puzzleId('easy', givens)
  assert.ok(/^easy-[0-9a-z]+$/.test(id), 'id format ' + id)
})

const summary = runner.summary()
console.log('RESULT v2 oracle ' + JSON.stringify(summary))
