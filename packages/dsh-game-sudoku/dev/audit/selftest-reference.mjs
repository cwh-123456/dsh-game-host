/**
 * Self-test for the verifier's independent reference oracle (no client.js needed).
 *
 * Run: node dev/audit/selftest-reference.mjs
 *
 * Proves the oracle used to cross-check the implementation is itself sane:
 * known fixtures, brute-force conflict cross-check and parser validation.
 */
import assert from 'node:assert/strict'
import {
  CLASSIC_PUZZLE,
  UNSOLVABLE_GIVENS,
  auditRng,
  countNonZero,
  derivePartial,
  emptyBoard,
  randomBoard,
  refConflicts,
  refConsistent,
  refCountSolutions,
  refIsSolved,
  refIsValidSolution,
  refSolve,
  refValidateGivens,
  boardFromRows,
} from './reference.mjs'
import { createRunner, must } from './harness.mjs'

const runner = createRunner('reference oracle self-test')

runner.check('classic puzzle has exactly one solution accepted by the oracle', () => {
  assert.equal(refCountSolutions(CLASSIC_PUZZLE), 1)
  const solution = refSolve(CLASSIC_PUZZLE)
  must(solution !== null)
  assert.ok(refIsValidSolution(solution))
  assert.ok(refConsistent(CLASSIC_PUZZLE, solution))
  assert.equal(refCountSolutions(solution), 1)
  assert.equal(refIsSolved(solution), true)
  assert.equal(refIsSolved(CLASSIC_PUZZLE), false)
})

runner.check('empty board counts respect the limit', () => {
  assert.equal(refCountSolutions(emptyBoard(), 1), 1)
  assert.equal(refCountSolutions(emptyBoard(), 2), 2)
  assert.equal(refCountSolutions(emptyBoard(), 5), 5)
})

runner.check('conflict-free unsolvable fixture has zero solutions', () => {
  assert.deepEqual(refConflicts(UNSOLVABLE_GIVENS), new Array(81).fill(0))
  assert.equal(refCountSolutions(UNSOLVABLE_GIVENS), 0)
  assert.equal(refSolve(UNSOLVABLE_GIVENS), null)
})

runner.check('conflict map matches an independent O(peers^2) brute force on random boards', () => {
  const rng = auditRng(314159)
  for (let trial = 0; trial < 300; trial += 1) {
    const board = randomBoard(rng, rng() * 0.9)
    const expected = new Array(81).fill(0)
    for (let index = 0; index < 81; index += 1) {
      const value = board[index]
      if (value === 0) continue
      let conflict = false
      for (let other = 0; other < 81; other += 1) {
        if (other === index || board[other] !== value) continue
        const sameRow = Math.floor(other / 9) === Math.floor(index / 9)
        const sameCol = other % 9 === index % 9
        const sameBox =
          Math.floor(Math.floor(other / 9) / 3) === Math.floor(Math.floor(index / 9) / 3) &&
          Math.floor((other % 9) / 3) === Math.floor((index % 9) / 3)
        if (sameRow || sameCol || sameBox) {
          conflict = true
          break
        }
      }
      expected[index] = conflict ? 1 : 0
    }
    assert.deepEqual(refConflicts(board), expected, 'trial ' + trial)
  }
})

runner.check('refSolve results are legal and consistent with their givens', () => {
  const rng = auditRng(271828)
  const base = refSolve(CLASSIC_PUZZLE)
  must(base !== null)
  let unique = 0
  let multi = 0
  for (let trial = 0; trial < 120; trial += 1) {
    const keep = 17 + Math.floor(rng() * 50)
    const board = derivePartial(base, keep, rng)
    const count = refCountSolutions(board, 2)
    const solution = refSolve(board)
    if (count === 1) {
      unique += 1
      must(solution !== null)
      assert.ok(refIsValidSolution(solution))
      assert.ok(refConsistent(board, solution))
    } else {
      multi += 1
      if (count === 0) assert.equal(solution, null)
      else {
        must(solution !== null)
        assert.ok(refIsValidSolution(solution))
        assert.ok(refConsistent(board, solution))
      }
    }
  }
  must(unique > 0, 'expected some unique partial boards in the sample')
  must(multi > 0, 'expected some non-unique partial boards in the sample')
})

runner.check('input validation rejects malformed givens with TypeError', () => {
  const invalid = [
    null,
    'x',
    emptyBoard().slice(0, 80),
    (() => {
      const board = emptyBoard()
      board[0] = 10
      return board
    })(),
    (() => {
      const board = boardFromRows(
        new Array(9).fill(0).map(() => new Array(9).fill(0)),
      )
      board[0] = 5
      board[1] = 5
      return board
    })(),
  ]
  for (const board of invalid) {
    assert.throws(() => refValidateGivens(board), TypeError)
    assert.throws(() => refCountSolutions(board), TypeError)
  }
  expectNoThrow(() => refValidateGivens(CLASSIC_PUZZLE))
  assert.equal(countNonZero(CLASSIC_PUZZLE), 30)
})

function expectNoThrow(fn) {
  fn()
}

const summary = runner.summary()
console.log('RESULT reference oracle ' + JSON.stringify(summary))
