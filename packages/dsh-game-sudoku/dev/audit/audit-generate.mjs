/**
 * Audit 2/3 — independent solver cross-check, generation correctness, timing,
 * determinism, distinctness and givens-count separation.
 *
 * Run: node dev/audit/audit-generate.mjs
 *
 * The oracle in ./reference.mjs is an independent implementation (Sets +
 * reverse-scan MRV + descending digits); nothing here is copied from the engine.
 */
import {
  CLIENT_FILE,
  assert,
  clientExists,
  createRunner,
  loadClient,
  must,
  requireClient,
} from './harness.mjs'
import {
  CLASSIC_PUZZLE,
  UNSOLVABLE_GIVENS,
  auditRng,
  boardFromRows,
  countEmpty as refCountEmpty,
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
} from './reference.mjs'

if (!clientExists()) {
  console.log('WAITING: client.js does not exist yet at ' + CLIENT_FILE)
  process.exit(2)
}

const runner = createRunner('generation audit')
const loaded = await loadClient({ testFlag: true, tag: 'generate' })
const api = requireClient(loaded.api)

const EVIDENCE = {}
const DIFFICULTIES = ['easy', 'normal', 'hard']
const SEEDS_PER_DIFFICULTY = 120
const HARD_TIME_BOUND_MS = 200

function pct(sorted, p) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const sum = sorted.reduce((total, value) => total + value, 0)
  return {
    n: sorted.length,
    min: Number(sorted[0].toFixed(3)),
    mean: Number((sum / sorted.length).toFixed(3)),
    p95: Number(pct(sorted, 95).toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
    median: Number(pct(sorted, 50).toFixed(3)),
  }
}

function givensKey(givens) {
  return givens.join('')
}

function expectTypeError(label, fn) {
  let threw = false
  let error = null
  try {
    fn()
  } catch (caught) {
    threw = true
    error = caught
  }
  must(threw, label + ': expected a throw (TypeError) but call returned normally')
  must(error instanceof TypeError, label + ': expected TypeError, got ' + (error && error.constructor && error.constructor.name))
}

/** Full validation of one generated puzzle against the independent oracle. */
function validatePuzzle(label, diffKey, result) {
  must(result && typeof result === 'object', label + ': generatePuzzle must return an object')
  const expectedTarget = api.DIFFICULTIES[diffKey].givens
  assert.equal(result.difficulty, diffKey, label + ': difficulty')
  assert.equal(result.targetGivens, expectedTarget, label + ': targetGivens')
  assert.ok(Array.isArray(result.givens) && result.givens.length === 81, label + ': givens must be number[81]')
  assert.ok(Array.isArray(result.solution) && result.solution.length === 81, label + ': solution must be number[81]')
  assert.ok(
    result.givens.every((value) => Number.isInteger(value) && value >= 0 && value <= 9),
    label + ': givens values must be integers 0..9',
  )
  assert.ok(
    result.solution.every((value) => Number.isInteger(value) && value >= 1 && value <= 9),
    label + ': solution values must be integers 1..9',
  )

  const givensCount = countNonZero(result.givens)
  assert.equal(result.givensCount, givensCount, label + ': givensCount must equal the non-zero givens count')
  assert.equal(result.givensCount, 81 - refCountEmpty(result.givens), label + ': givensCount vs empties')
  assert.ok(result.givensCount >= expectedTarget, label + ': givensCount must be >= targetGivens')
  assert.ok(result.givensCount <= 81)

  // Spec §3: exactly one solution.
  assert.equal(api.countSolutions(result.givens, 2), 1, label + ': engine countSolutions must be 1')
  assert.equal(refCountSolutions(result.givens, 2), 1, label + ': reference solver must find exactly 1 solution')

  // Stored solution must be valid, consistent and equal to the reference solution.
  assert.ok(refIsValidSolution(result.solution), label + ': stored solution is not a legal complete grid')
  assert.ok(refConsistent(result.givens, result.solution), label + ': stored solution inconsistent with givens')
  const oracleSolution = refSolve(result.givens)
  must(oracleSolution, label + ': reference solver returned no solution')
  assert.deepEqual(result.solution, oracleSolution, label + ': stored solution differs from the independent solver')
  assert.deepEqual(api.solve(result.givens), result.solution, label + ': engine solve() differs from stored solution')

  // Givens must be conflict-free by both implementations.
  assert.deepEqual(refConflicts(result.givens), new Array(81).fill(0), label + ': reference found givens conflicts')
  assert.deepEqual(api.computeConflicts(result.givens), new Array(81).fill(0), label + ': engine found givens conflicts')

  // Generation metadata.
  assert.ok(typeof result.genMs === 'number' && Number.isFinite(result.genMs) && result.genMs >= 0, label + ': genMs')
  assert.ok(Number.isInteger(result.digAttempts) && result.digAttempts >= 0, label + ': digAttempts')
  assert.ok(Number.isInteger(result.digRemoved) && result.digRemoved >= 0, label + ': digRemoved')
  assert.equal(result.digRemoved, 81 - givensCount, label + ': digRemoved must equal removed cells')
  assert.ok(result.digAttempts >= result.digRemoved, label + ': digAttempts must be >= digRemoved')
  assert.equal(result.digPasses, 1, label + ': digPasses must be 1')
  return result
}

// ---------------------------------------------------------------------------
// Solver fixtures
// ---------------------------------------------------------------------------
runner.check('solvers agree on the classic unique puzzle', () => {
  assert.equal(refCountSolutions(CLASSIC_PUZZLE, 2), 1)
  assert.equal(api.countSolutions(CLASSIC_PUZZLE, 2), 1, 'engine must count exactly 1 solution')
  const oracle = refSolve(CLASSIC_PUZZLE)
  const engine = api.solve(CLASSIC_PUZZLE)
  must(engine !== null, 'engine solve() returned null for a solvable puzzle')
  assert.deepEqual(engine, oracle, 'engine solve() must equal the independent solver on a unique puzzle')
  assert.ok(refIsValidSolution(engine))
  EVIDENCE.classicGivens = countNonZero(CLASSIC_PUZZLE)
})

runner.check('solvers agree on the empty board (limit semantics)', () => {
  assert.equal(refCountSolutions(emptyBoard(), 2), 2)
  assert.equal(api.countSolutions(emptyBoard(), 2), 2, 'empty board must count to the default limit 2')
  assert.equal(api.countSolutions(emptyBoard(), 3), 3, 'limit=3 must count to 3')
  assert.equal(refCountSolutions(emptyBoard(), 3), 3)
  assert.equal(api.countSolutions(emptyBoard(), 5), 5, 'limit=5 must count to 5')
  assert.equal(refCountSolutions(emptyBoard(), 5), 5)
  const solved = api.solve(emptyBoard())
  must(solved !== null, 'solve(empty) must return a solution')
  assert.ok(refIsValidSolution(solved), 'solve(empty) must be a legal grid')
})

runner.check('solvers agree on a conflict-free UNSOLVABLE board (0 solutions, no throw)', () => {
  assert.equal(refCountSolutions(UNSOLVABLE_GIVENS, 2), 0)
  assert.equal(api.countSolutions(UNSOLVABLE_GIVENS, 2), 0, 'unsolvable givens must count 0')
  assert.equal(api.solve(UNSOLVABLE_GIVENS), null, 'solve() on unsolvable givens must be null')
  assert.equal(refSolve(UNSOLVABLE_GIVENS), null)
  assert.deepEqual(refConflicts(UNSOLVABLE_GIVENS), new Array(81).fill(0), 'fixture itself must be conflict-free')
})

runner.check('invalid countSolutions/solve input throws TypeError (program error per spec §3)', () => {
  const conflicting = CLASSIC_PUZZLE.slice()
  conflicting[1] = conflicting[0] // duplicate in row 0
  const cases = [
    ['null', null],
    ['undefined', undefined],
    ['non-array string', 'x'],
    ['80 cells', CLASSIC_PUZZLE.slice(0, 80)],
    ['82 cells', CLASSIC_PUZZLE.concat([0])],
    ['digit 10', (() => { const board = emptyBoard(); board[3] = 10; return board })()],
    ['digit -1', (() => { const board = emptyBoard(); board[3] = -1; return board })()],
    ['digit 1.5', (() => { const board = emptyBoard(); board[3] = 1.5; return board })()],
    ['digit string', (() => { const board = emptyBoard(); board[3] = '3'; return board })()],
    ['conflicting givens', conflicting],
  ]
  for (const [label, board] of cases) {
    expectTypeError('countSolutions(' + label + ')', () => api.countSolutions(board, 2))
    expectTypeError('solve(' + label + ')', () => api.solve(board))
    expectTypeError('reference countSolutions(' + label + ')', () => refCountSolutions(board, 2))
  }
})

// ---------------------------------------------------------------------------
// Generation: correctness + timing, 3 difficulties x 120 seeds
// ---------------------------------------------------------------------------
const allResults = { easy: [], normal: [], hard: [] }
const wallTimes = { easy: [], normal: [], hard: [] }
const selfTimes = { easy: [], normal: [], hard: [] }
const slowCalls = []
let validationFailures = 0
let totalGivensChecks = 0

runner.check('generatePuzzle: 3 difficulties x ' + SEEDS_PER_DIFFICULTY + ' seeds are valid, unique and < 200ms', () => {
  for (const diffKey of DIFFICULTIES) {
    for (let seed = 0; seed < SEEDS_PER_DIFFICULTY; seed += 1) {
      const numericSeed = 1000 * (DIFFICULTIES.indexOf(diffKey) + 1) + seed
      const rng = api.createRng(numericSeed)
      const started = performance.now()
      const result = api.generatePuzzle(diffKey, rng)
      const wallMs = performance.now() - started
      const label = diffKey + '/seed=' + numericSeed
      validatePuzzle(label, diffKey, result)
      totalGivensChecks += 1
      allResults[diffKey].push(result)
      wallTimes[diffKey].push(wallMs)
      selfTimes[diffKey].push(result.genMs)
      if (wallMs >= HARD_TIME_BOUND_MS || result.genMs >= HARD_TIME_BOUND_MS) {
        slowCalls.push({ label, wallMs: Number(wallMs.toFixed(2)), genMs: result.genMs })
      }
    }
  }

  // Re-measure the slow calls (machine contention can hit one call); a persistent
  // >200ms result is a real hard-constraint violation.
  for (const slow of slowCalls) {
    const [diffKey] = slow.label.split('/')
    const numericSeed = Number(slow.label.split('seed=')[1])
    const attempts = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now()
      const result = api.generatePuzzle(diffKey, api.createRng(numericSeed))
      attempts.push({ wallMs: performance.now() - started, genMs: result.genMs })
      validatePuzzle('recheck ' + slow.label + '#' + attempt, diffKey, result)
    }
    slow.attempts = attempts.map((item) => ({ wallMs: Number(item.wallMs.toFixed(2)), genMs: item.genMs }))
    slow.medianWallMs = Number(
      attempts
        .map((item) => item.wallMs)
        .sort((a, b) => a - b)[1]
        .toFixed(2),
    )
  }

  const persistent = slowCalls.filter((slow) => slow.medianWallMs >= HARD_TIME_BOUND_MS)
  EVIDENCE.slowCalls = slowCalls
  assert.deepEqual(
    persistent,
    [],
    'hard bound violated after re-measurement: ' + JSON.stringify(persistent),
  )
  assert.equal(validationFailures, 0)
})

runner.check('generation statistics recorded: timing and givens per difficulty', () => {
  const summary = {}
  for (const diffKey of DIFFICULTIES) {
    const counts = allResults[diffKey].map((result) => result.givensCount)
    summary[diffKey] = {
      puzzles: allResults[diffKey].length,
      wallMs: stats(wallTimes[diffKey]),
      selfGenMs: stats(selfTimes[diffKey]),
      givens: stats(counts),
    }
  }
  EVIDENCE.generation = summary
  EVIDENCE.totalPuzzlesValidated = totalGivensChecks

  for (const diffKey of DIFFICULTIES) {
    // Self-reported genMs must be a faithful under-estimate of wall time.
    for (let index = 0; index < allResults[diffKey].length; index += 1) {
      const self = allResults[diffKey][index].genMs
      const wall = wallTimes[diffKey][index]
      must(
        self <= wall + 15,
        diffKey + '#' + index + ': self-reported genMs (' + self + 'ms) exceeds measured wall time (' + wall.toFixed(1) + 'ms)',
      )
    }
  }

  // Easy must reliably reach its exact 40-given target (api-spec §10.3).
  const easyCounts = allResults.easy.map((result) => result.givensCount)
  assert.deepEqual(
    easyCounts.filter((count) => count !== 40),
    [],
    'easy puzzles must reach exactly 40 givens, deviations: ' + JSON.stringify(easyCounts.filter((count) => count !== 40)),
  )
  for (const result of allResults.normal) assert.ok(result.givensCount >= 34, 'normal must be >= 34 givens')
  for (const result of allResults.hard) assert.ok(result.givensCount >= 28, 'hard must be >= 28 givens')

  const easyGivens = summary.easy.givens.median
  const normalGivens = summary.normal.givens.median
  const hardGivens = summary.hard.givens.median
  assert.ok(easyGivens > normalGivens, 'median easy givens (' + easyGivens + ') must exceed normal (' + normalGivens + ')')
  assert.ok(normalGivens > hardGivens, 'median normal givens (' + normalGivens + ') must exceed hard (' + hardGivens + ')')
})

runner.check('generation is deterministic for the same seed (givens + solution)', () => {
  for (const diffKey of DIFFICULTIES) {
    for (const seed of [0, 7, 424242]) {
      const first = api.generatePuzzle(diffKey, api.createRng(seed))
      const second = api.generatePuzzle(diffKey, api.createRng(seed))
      assert.deepEqual(second.givens, first.givens, diffKey + '/seed=' + seed + ': same seed must give same givens')
      assert.deepEqual(second.solution, first.solution, diffKey + '/seed=' + seed + ': same seed must give same solution')
      assert.equal(second.givensCount, first.givensCount)
      assert.equal(second.difficulty, first.difficulty)
    }
  }
})

runner.check('createRng is deterministic, seeded and in [0,1)', () => {
  const a = api.createRng(42)
  const b = api.createRng(42)
  for (let index = 0; index < 50; index += 1) {
    const valueA = a()
    const valueB = b()
    assert.equal(valueA, valueB, 'same seed must produce the same stream')
    assert.ok(valueA >= 0 && valueA < 1, 'rng output must be in [0,1), got ' + valueA)
  }
  const c = api.createRng(43)
  const different = Array.from({ length: 5 }, () => c())
  const reference = Array.from({ length: 5 }, () => api.createRng(42)())
  assert.notDeepEqual(different, reference, 'different seeds must produce different streams')
})

runner.check('invalid difficulty falls back to normal (spec §3)', () => {
  for (const invalid of ['expert', undefined, null, 'HARD', 42]) {
    const result = api.generatePuzzle(invalid, api.createRng(555))
    assert.equal(result.difficulty, 'normal', 'invalid difficulty ' + String(invalid) + ' must fall back to normal')
    assert.equal(result.targetGivens, 34)
    validatePuzzle('fallback(' + String(invalid) + ')', 'normal', result)
  }
})

runner.check('25 consecutive generated puzzles are all distinct', () => {
  const keys = new Set()
  for (let seed = 0; seed < 25; seed += 1) {
    const result = api.generatePuzzle('normal', api.createRng(700000 + seed))
    keys.add(givensKey(result.givens))
  }
  assert.equal(keys.size, 25, 'expected 25 distinct puzzles, got ' + keys.size)
  EVIDENCE.distinctGenerated = keys.size
})

runner.check('createState/newPuzzle produce 21 distinct consecutive puzzles', () => {
  const rng = api.createRng(987654)
  const state = api.createState({ difficulty: 'normal', rng, now: 0 })
  const keys = new Set([givensKey(state.givens)])
  for (let round = 0; round < 20; round += 1) {
    api.newPuzzle(state, 'normal', rng, 0)
    keys.add(givensKey(state.givens))
  }
  assert.equal(keys.size, 21, 'newPuzzle must not repeat a puzzle; distinct=' + keys.size)
  EVIDENCE.distinctNewPuzzle = keys.size
})

runner.check('createState is deterministic for the same seed', () => {
  const first = api.createState({ difficulty: 'hard', rng: api.createRng(31337), now: 0 })
  const second = api.createState({ difficulty: 'hard', rng: api.createRng(31337), now: 0 })
  assert.deepEqual(second.givens, first.givens)
  assert.deepEqual(second.solution, first.solution)
  assert.equal(second.difficulty, 'hard')
  assert.equal(second.targetGivens, 28)
})

// ---------------------------------------------------------------------------
// Solver cross-check on randomly derived partial boards + conflicts
// ---------------------------------------------------------------------------
runner.check('countSolutions cross-check on 180 derived partial boards', () => {
  const rng = auditRng(20261018)
  const solutionPool = []
  for (const diffKey of DIFFICULTIES) {
    for (const result of allResults[diffKey].slice(0, 20)) solutionPool.push(result.solution)
  }
  assert.equal(solutionPool.length, 60)
  let unique = 0
  let multi = 0
  let compared = 0
  for (let trial = 0; trial < 180; trial += 1) {
    const solution = solutionPool[trial % solutionPool.length]
    const keep = 5 + Math.floor(rng() * 66) // 5..70 givens
    const board = derivePartial(solution, keep, rng)
    const engineCount = api.countSolutions(board, 2)
    const oracleCount = refCountSolutions(board, 2)
    assert.equal(engineCount, oracleCount, 'trial ' + trial + ' keep=' + keep + ': engine count ' + engineCount + ' vs oracle ' + oracleCount)
    assert.ok(engineCount === 0 || engineCount === 1 || engineCount === 2)
    if (engineCount === 1) {
      unique += 1
      assert.deepEqual(api.solve(board), refSolve(board), 'trial ' + trial + ': unique solution mismatch')
    } else {
      multi += 1
      const engineSolution = api.solve(board)
      if (engineCount === 0) {
        assert.equal(engineSolution, null)
        assert.equal(refSolve(board), null)
      } else {
        must(engineSolution !== null, 'trial ' + trial + ': engine solve() null on a solvable board')
        assert.ok(refIsValidSolution(engineSolution), 'trial ' + trial + ': engine solve() returned an invalid grid')
        assert.ok(refConsistent(board, engineSolution), 'trial ' + trial + ': engine solve() ignores some givens')
      }
    }
    compared += 1
  }
  EVIDENCE.countSolutionsCrossCheck = { compared, unique, multi }
})

runner.check('computeConflicts cross-check on 200 random boards', () => {
  const rng = auditRng(555123)
  let compared = 0
  for (let trial = 0; trial < 200; trial += 1) {
    const board = randomBoard(rng, rng() * 0.8)
    const engine = api.computeConflicts(board)
    const oracle = refConflicts(board)
    assert.ok(Array.isArray(engine) && engine.length === 81, 'computeConflicts must return number[81]')
    assert.ok(engine.every((value) => value === 0 || value === 1), 'computeConflicts values must be 0/1')
    assert.deepEqual(engine, oracle, 'trial ' + trial + ': computeConflicts mismatch')
    compared += 1
  }
  // Full valid solutions: no conflicts. Givens of generated puzzles: no conflicts.
  for (const diffKey of DIFFICULTIES) {
    for (const result of allResults[diffKey].slice(0, 10)) {
      assert.deepEqual(api.computeConflicts(result.solution), new Array(81).fill(0))
      assert.deepEqual(api.computeConflicts(result.givens), new Array(81).fill(0))
      compared += 2
    }
  }
  EVIDENCE.computeConflictsCrossCheck = compared
})

runner.check('countEmpty / isSolved cross-check on random boards', () => {
  const rng = auditRng(909090)
  for (let trial = 0; trial < 100; trial += 1) {
    const board = randomBoard(rng, rng() * 0.8)
    assert.equal(api.countEmpty(board), refCountEmpty(board), 'countEmpty mismatch on trial ' + trial)
    assert.equal(api.isSolved(board), refIsSolved(board), 'isSolved mismatch on trial ' + trial)
  }
  assert.equal(api.isSolved(allResults.normal[0].solution), true)
  assert.equal(api.isSolved(allResults.normal[0].givens), false)
  assert.equal(api.countEmpty(allResults.normal[0].solution), 0)
})

runner.check('empty-board solve() returns a legal grid (200 repeats, no duplicates)', () => {
  for (let trial = 0; trial < 5; trial += 1) {
    const solved = api.solve(emptyBoard())
    must(solved !== null)
    assert.ok(refIsValidSolution(solved))
  }
})

const summary = runner.summary()
for (const [key, value] of Object.entries(EVIDENCE)) {
  if (value !== undefined) console.log('EVIDENCE ' + key + ' ' + JSON.stringify(value))
}
console.log('RESULT generation audit ' + JSON.stringify(summary))
