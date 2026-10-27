/**
 * Pure-logic / bank self test for @local/dsh-game-sudoku (v2).
 *
 *   node dev/test-logic.mjs
 *
 * v2 is bank-driven: client.js contains the inlined PUZZLE_BANK and NO runtime
 * generator/solver. This test installs a minimal `window` stub, opts into the
 * v2 test seam (`window.__DSH_GAME_SUDOKU_TEST__ = true`) and exercises:
 *
 *   §8.1  seam/constants + inline bank integrity (cross-checked with dev/bank.json)
 *   §8.2  pickPuzzle unseen-first + fallback + determinism
 *   §8.3  createState
 *   §8.4  input / notes / erase / undo / win lock (v1 interaction semantics)
 *   §8.5  restart same puzzle / newPuzzle unseen-first + played growth
 *   §8.6  grade parameter + invalid-grade fallback
 *   §8.7  timer pause/resume/elapsed
 *   §8.8  save schema v2, roundtrip, bad-save matrix, 500-mutation fuzz,
 *         loadSavedState defensive paths, restore the SAME puzzle
 *   §8.9  formatTime / computeConflicts / isSolved / countEmpty edges
 *
 * When dev/lib/techniques.mjs exists it is imported for independent uniqueness
 * and re-grading cross-checks; the test still runs (with those checks skipped)
 * if the library is absent, but dev/bank.json is required as bank authority.
 *
 * No third-party dependencies; exits non-zero on failure.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// window / localStorage stub + module import
// ---------------------------------------------------------------------------

const storage = new Map()
let loadedDefinition = null

function makeStorage() {
  return {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null
    },
    setItem(key, value) {
      storage.set(key, String(value))
    },
    removeItem(key) {
      storage.delete(key)
    },
    clear() {
      storage.clear()
    },
  }
}

globalThis.window = {
  __DSH_GAME_SUDOKU_TEST__: true,
  __ModuleLoader__: {
    load(definition) {
      loadedDefinition = definition
    },
  },
  localStorage: makeStorage(),
  performance: { now: () => 0 },
}

await import(new URL('../client.js', import.meta.url).href)

const api = globalThis.window.__DSH_GAME_SUDOKU__
assert.ok(api, 'test seam window.__DSH_GAME_SUDOKU__ should be installed')

// ---------------------------------------------------------------------------
// Optional dev-side grading library + bank.json authority
// ---------------------------------------------------------------------------

const wantLibPath = new URL('./lib/techniques.mjs', import.meta.url)
const hasTechniquesLib = existsSync(wantLibPath)
const techniques = hasTechniquesLib ? await import(wantLibPath.href) : null

const bankJsonUrl = new URL('./bank.json', import.meta.url)
const hasBankJson = existsSync(bankJsonUrl)
let diskBank = null
if (hasBankJson) {
  try {
    diskBank = JSON.parse(readFileSync(bankJsonUrl, 'utf8'))
  } catch (error) {
    diskBank = null
  }
}

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    failed += 1
    failures.push({ name: name, error: error })
    console.error('not ok - ' + name)
    console.error(error && error.stack ? error.stack : error)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GRID = 9
const CELLS = 81
const KNOWN_GRADES = ['easy', 'normal', 'hard', 'expert', 'hell']
const SAVE_KEYS = ['elapsed', 'entries', 'grade', 'notes', 'played', 'puzzleId', 'schemaVersion', 'winAcked']

function bankPuzzles(grade) {
  return api.BANK.puzzles.filter(function sameGrade(puzzle) {
    return puzzle.grade === grade
  })
}

function countNonZero(grid) {
  let count = 0
  for (let i = 0; i < grid.length; i++) if (grid[i] !== 0) count += 1
  return count
}

function emptyIndices(givens) {
  const out = []
  for (let i = 0; i < CELLS; i++) if (givens[i] === 0) out.push(i)
  return out
}

function newState(grade, seed, now, played) {
  return api.createState({
    grade: grade === undefined ? 'normal' : grade,
    played: played === undefined ? [] : played,
    rng: api.createRng(seed === undefined ? 1 : seed),
    now: now === undefined ? 0 : now,
  })
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function mutate(base, editor) {
  const save = clone(base)
  editor(save)
  return save
}

function parseGivensForTest(value) {
  const grid = []
  for (let i = 0; i < CELLS; i++) grid.push(Number(value[i]))
  return grid
}

function zeroEntries() {
  return new Array(CELLS).fill(0)
}

function assertCompleteSolution(solution) {
  assert.equal(solution.length, CELLS, 'solution must have 81 cells')
  for (let i = 0; i < CELLS; i++) {
    assert.ok(Number.isInteger(solution[i]) && solution[i] >= 1 && solution[i] <= 9, 'solution digit at ' + i)
  }
  for (let r = 0; r < GRID; r++) {
    const set = new Set(solution.slice(r * GRID, r * GRID + GRID))
    assert.equal(set.size, GRID, 'row ' + r)
  }
  for (let c = 0; c < GRID; c++) {
    const set = new Set()
    for (let r = 0; r < GRID; r++) set.add(solution[r * GRID + c])
    assert.equal(set.size, GRID, 'column ' + c)
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const set = new Set()
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) set.add(solution[(br * 3 + a) * GRID + bc * 3 + b])
      }
      assert.equal(set.size, GRID, 'box ' + br + ',' + bc)
    }
  }
}

/**
 * Independent candidate-set solver used by this test only (the runtime has no
 * solver). Returns the first solution and up to `limit` solution count.
 */
function independentSolve(givens, limit) {
  const board = givens.slice()
  const cap = typeof limit === 'number' && limit > 0 ? limit : 1
  let count = 0
  let first = null

  function candidatesAt(index) {
    const row = Math.floor(index / GRID)
    const col = index % GRID
    const used = new Set()
    for (let k = 0; k < GRID; k++) {
      const a = board[row * GRID + k]
      const b = board[k * GRID + col]
      if (a) used.add(a)
      if (b) used.add(b)
    }
    const boxRow = Math.floor(row / 3) * 3
    const boxCol = Math.floor(col / 3) * 3
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const value = board[(boxRow + a) * GRID + boxCol + b]
        if (value) used.add(value)
      }
    }
    const out = []
    for (let d = 1; d <= 9; d++) if (!used.has(d)) out.push(d)
    return out
  }

  function search() {
    let target = -1
    let targetCandidates = null
    for (let i = 0; i < CELLS; i++) {
      if (board[i] !== 0) continue
      const candidates = candidatesAt(i)
      if (candidates.length === 0) return
      if (target === -1 || candidates.length < targetCandidates.length) {
        target = i
        targetCandidates = candidates
        if (candidates.length === 1) break
      }
    }
    if (target === -1) {
      count += 1
      if (first === null) first = board.slice()
      return
    }
    for (const digit of targetCandidates) {
      board[target] = digit
      search()
      board[target] = 0
      if (count >= cap) return
    }
  }

  search()
  return { count: count, first: first }
}

// ===========================================================================
// §8.1 Seam / constants / no runtime generator
// ===========================================================================

test('test seam v2 exports the documented API surface', () => {
  const constants = ['GAME_ID', 'STORE_KEY', 'SCHEMA_VERSION', 'GRID', 'CELLS', 'UNDO_LIMIT', 'LEVELS', 'DEFAULT_GRADE', 'BANK']
  for (const name of constants) assert.ok(name in api, 'missing constant ' + name)
  const functions = [
    'findPuzzle',
    'pickPuzzle',
    'createRng',
    'createState',
    'loadSavedState',
    'saveState',
    'serializeState',
    'sanitizeSave',
    'hasProgress',
    'countEmpty',
    'computeConflicts',
    'isSolved',
    'formatTime',
    'selectCell',
    'moveSelection',
    'toggleNotesMode',
    'applyDigit',
    'eraseCell',
    'undoMove',
    'restartPuzzle',
    'newPuzzle',
    'timerResume',
    'timerPause',
    'timerElapsed',
    'getSnapshot',
  ]
  for (const name of functions) assert.equal(typeof api[name], 'function', 'missing function ' + name)
  assert.equal(api.GAME_ID, 'sudoku')
  assert.equal(api.STORE_KEY, 'dsh.game.sudoku.v1')
  assert.equal(api.SCHEMA_VERSION, 2)
  assert.equal(api.GRID, 9)
  assert.equal(api.CELLS, 81)
  assert.equal(api.UNDO_LIMIT, 300)
  assert.equal(api.DEFAULT_GRADE, 'normal')
})

test('v2 has no runtime puzzle generator/solver', () => {
  assert.equal(typeof api.generatePuzzle, 'undefined', 'generatePuzzle must not exist at runtime')
  assert.equal(typeof api.countSolutions, 'undefined', 'countSolutions must not exist at runtime')
  assert.equal(typeof api.solve, 'undefined', 'solve must not exist at runtime')
  assert.equal(typeof api.generateFullGrid, 'undefined')
})

test('5 frozen levels with the expected keys/labels/order', () => {
  assert.deepEqual(
    api.LEVELS.map(function key(level) {
      return level.key
    }),
    KNOWN_GRADES,
  )
  assert.deepEqual(
    api.LEVELS.map(function label(level) {
      return level.label
    }),
    ['简单', '普通', '困难', '专家', '地狱'],
  )
  assert.deepEqual(
    api.LEVELS.map(function level(level) {
      return level.level
    }),
    [1, 2, 3, 4, 5],
  )
})

test('static source: bank markers, no runtime generator/solver, hooks, no global keydown', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(source.indexOf('/* ==== SUDOKU PUZZLE BANK: BEGIN (generated by dev/gen-bank.mjs, do not edit) ==== */') !== -1)
  assert.ok(source.indexOf('/* ==== SUDOKU PUZZLE BANK: END ==== */') !== -1)
  for (const forbidden of ['generatePuzzle', 'countSolutions', 'generateFullGrid', 'searchSolutions', 'buildMasks', 'DIG_BUDGET']) {
    assert.equal(source.indexOf(forbidden), -1, 'runtime must not contain ' + forbidden)
  }
  assert.ok(source.indexOf('dsh.game.sudoku.v1') !== -1)
  assert.ok(source.indexOf('@local/dsh-game-sudoku') !== -1)
  assert.ok(source.indexOf("require('react')") !== -1)
  assert.ok(!/\bwindow\.addEventListener\s*\(\s*['"]keydown/.test(source), 'no window keydown listener')
  assert.ok(!/\bdocument\.addEventListener\s*\(\s*['"]keydown/.test(source), 'no document keydown listener')
  assert.ok(/onKeyDown\s*:/.test(source), 'keyboard handler must live on the component root')
  assert.ok(!/^\s*import\s/m.test(source), 'client.js must not import third-party modules')
  for (const hook of ['data-dsh-game', 'data-sudoku-board', 'data-cell', 'data-given', 'data-value', 'data-selected', 'data-peer', 'data-conflict', 'data-digit', 'data-action', 'data-difficulty', 'data-role', 'data-overlay']) {
    assert.ok(source.indexOf(hook) !== -1, 'missing data hook ' + hook)
  }
  for (const grade of KNOWN_GRADES) assert.ok(source.indexOf(grade) !== -1, 'grade key should appear in source: ' + grade)
})

test('module loader registration is still game.stage/sudoku (contract v1)', () => {
  assert.ok(loadedDefinition)
  assert.equal(loadedDefinition.id, '@local/dsh-game-sudoku')
  assert.equal(typeof loadedDefinition.factory, 'function')

  const ReactStub = {
    createElement() {
      return null
    },
    Fragment: 'fragment',
    useRef() {
      return { current: null }
    },
    useState() {
      return [undefined, function noop() {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    Component: class {
      constructor(props) {
        this.props = props
      }
      setState() {}
    },
  }
  const plugin = loadedDefinition.factory(function requireStub(id) {
    assert.equal(id, 'react')
    return ReactStub
  })
  assert.deepEqual(plugin.inject, ['slots'])

  const registrations = []
  plugin.apply({
    slots: {
      inject(name, callback) {
        assert.equal(name, 'game.stage')
        const dispose = callback()
        assert.equal(typeof dispose, 'function')
      },
      register(options, component) {
        registrations.push({ options: options, component: component })
        return function dispose() {}
      },
    },
  })
  assert.equal(registrations.length, 1)
  const options = registrations[0].options
  assert.equal(options.name, 'game.stage')
  assert.equal(options.id, 'sudoku')
  assert.equal(options.label(), '数独')
  assert.equal(typeof registrations[0].component, 'function')
  const matched = options.select({ gameId: 'sudoku' })
  assert.ok(matched && Object.isFrozen(matched))
  assert.equal(options.select({ gameId: 'sudoku' }), matched)
  assert.equal(options.select({ gameId: '2048' }), null)
})

// ===========================================================================
// §8.1 Bank integrity
// ===========================================================================

test('inline bank structure: version, levels, 30..50 puzzles per grade', () => {
  assert.ok(api.BANK && typeof api.BANK === 'object')
  assert.equal(api.BANK.version, 2)
  assert.ok(Array.isArray(api.BANK.levels) && api.BANK.levels.length === 5)
  assert.ok(Array.isArray(api.BANK.puzzles))
  assert.ok(api.BANK.puzzles.length > 0, 'inline PUZZLE_BANK is empty — bank promotion is pending')

  const gradePool = new Map()
  for (const puzzle of api.BANK.puzzles) {
    assert.equal(typeof puzzle.id, 'string')
    assert.ok(puzzle.id.length > 0)
    assert.ok(KNOWN_GRADES.indexOf(puzzle.grade) !== -1, 'unknown grade ' + puzzle.grade)
    gradePool.set(puzzle.grade, (gradePool.get(puzzle.grade) || 0) + 1)
  }
  for (const grade of KNOWN_GRADES) {
    const count = gradePool.get(grade) || 0
    assert.ok(count >= 30 && count <= 50, grade + ' should have 30..50 puzzles, got ' + count)
  }
})

test('inline bank: unique ids, unique faces, grade-prefixed ids, 81 legal clues', () => {
  const ids = new Set()
  const faces = new Set()
  for (const puzzle of api.BANK.puzzles) {
    assert.ok(!ids.has(puzzle.id), 'duplicate id ' + puzzle.id)
    ids.add(puzzle.id)
    assert.equal(puzzle.id.indexOf(puzzle.grade + '-'), 0, 'id should be prefixed with its grade: ' + puzzle.id)
    assert.equal(typeof puzzle.givens, 'string')
    assert.equal(puzzle.givens.length, CELLS, puzzle.id + ' givens length')
    assert.ok(!faces.has(puzzle.givens), 'duplicate puzzle face ' + puzzle.id)
    faces.add(puzzle.givens)
    assert.ok(/^[0-9]{81}$/.test(puzzle.givens), puzzle.id + ' givens must be 81 digits')
    const grid = parseGivensForTest(puzzle.givens)
    const conflicts = api.computeConflicts(grid)
    for (let i = 0; i < CELLS; i++) assert.equal(conflicts[i], 0, puzzle.id + ' given conflict at ' + i)
    assert.ok(countNonZero(grid) >= 17, puzzle.id + ' needs at least 17 clues')
    if (puzzle.clues !== undefined) assert.equal(puzzle.clues, countNonZero(grid), puzzle.id + ' clues mismatch')
  }
})

test('inline bank matches dev/bank.json (ids/grade/givens) when present', () => {
  if (!hasBankJson) {
    assert.ok(false, 'dev/bank.json missing — bank promotion is pending')
  }
  assert.ok(diskBank, 'dev/bank.json must be valid JSON')
  assert.equal(diskBank.version, 2)
  assert.ok(Array.isArray(diskBank.puzzles))
  assert.equal(api.BANK.puzzles.length, diskBank.puzzles.length, 'inline/bank puzzle count mismatch')

  const diskById = new Map()
  for (const puzzle of diskBank.puzzles) diskById.set(puzzle.id, puzzle)
  for (const puzzle of api.BANK.puzzles) {
    const disk = diskById.get(puzzle.id)
    assert.ok(disk, 'inline puzzle missing from dev/bank.json: ' + puzzle.id)
    assert.equal(puzzle.grade, disk.grade, puzzle.id + ' grade mismatch')
    assert.equal(puzzle.givens, disk.givens, puzzle.id + ' givens mismatch')
  }
  assert.equal(api.BANK.levels.length, diskBank.levels.length, 'levels mismatch')
})

test('inline bank: every puzzle is uniquely solvable (independent solver)', () => {
  if (techniques) {
    for (const puzzle of api.BANK.puzzles) {
      const grid = techniques.parseGrid(puzzle.givens)
      assert.equal(techniques.countSolutions(grid, 2), 1, puzzle.id + ' must have exactly one solution')
    }
    return
  }
  for (const grade of KNOWN_GRADES) {
    const sample = bankPuzzles(grade).slice(0, 2)
    for (const puzzle of sample) {
      const result = independentSolve(parseGivensForTest(puzzle.givens), 2)
      assert.equal(result.count, 1, puzzle.id + ' must have a unique solution')
    }
  }
})

test('dev/bank.json solutions are legal and match their givens', () => {
  if (!diskBank) return
  for (const puzzle of diskBank.puzzles) {
    assert.equal(typeof puzzle.solution, 'string')
    assert.equal(puzzle.solution.length, CELLS, puzzle.id + ' solution length')
    const solution = parseGivensForTest(puzzle.solution)
    assertCompleteSolution(solution)
    const givens = parseGivensForTest(puzzle.givens)
    for (let i = 0; i < CELLS; i++) if (givens[i] !== 0) assert.equal(givens[i], solution[i], puzzle.id + ' given/solution mismatch at ' + i)
  }
})

test('re-grading a sample per grade reproduces the recorded grade (dev solver)', () => {
  if (!techniques || typeof techniques.gradePuzzle !== 'function') {
    return
  }
  for (const grade of KNOWN_GRADES) {
    const sample = bankPuzzles(grade).slice(0, 3)
    for (const puzzle of sample) {
      const result = techniques.gradePuzzle(techniques.parseGrid(puzzle.givens))
      assert.equal(result.grade, grade, puzzle.id + ' re-graded as ' + result.grade)
      if (grade !== 'hell') {
        assert.ok(Array.isArray(result.techniques) && result.techniques.length > 0, puzzle.id + ' techniques')
      }
      assertCompleteSolution(result.solution)
    }
  }
})

test('grade coverage: each grade uses the techniques required by the v2 spec', () => {
  if (!diskBank) return
  const coverage = new Map()
  for (const puzzle of diskBank.puzzles) {
    if (!Array.isArray(puzzle.techniques)) continue
    if (!coverage.has(puzzle.grade)) coverage.set(puzzle.grade, new Set())
    const set = coverage.get(puzzle.grade)
    for (const name of puzzle.techniques) set.add(name)
  }
  const has = function has(grade, names) {
    const set = coverage.get(grade)
    if (!set) return false
    return names.some(function some(name) {
      return set.has(name)
    })
  }
  assert.ok(has('easy', ['naked-single', 'hidden-single']), 'easy should use singles')
  assert.ok(has('normal', ['pointing', 'claiming']), 'normal should use locked candidates')
  assert.ok(has('hard', ['naked-pair', 'naked-triple', 'hidden-pair', 'hidden-triple']), 'hard should use pairs/triples')
  assert.ok(has('expert', ['x-wing', 'xy-wing']), 'expert should use x-wing/xy-wing')
  assert.ok(coverage.has('hell'), 'hell coverage missing')
})

// ===========================================================================
// §8.2 pickPuzzle
// ===========================================================================

test('pickPuzzle: every grade yields that grade; invalid grade -> default', () => {
  for (const grade of KNOWN_GRADES) {
    const puzzle = api.pickPuzzle(grade, [], api.createRng(11))
    assert.ok(puzzle, grade + ' pool empty')
    assert.equal(puzzle.grade, grade)
    assert.ok(api.findPuzzle(puzzle.id), 'picked id must exist in bank')
  }
  const fallback = api.pickPuzzle('bogus-grade', [], api.createRng(12))
  assert.ok(fallback)
  assert.equal(fallback.grade, api.DEFAULT_GRADE)
})

test('pickPuzzle: prefers unseen ids, falls back when the pool is fully played', () => {
  for (const grade of KNOWN_GRADES) {
    const pool = bankPuzzles(grade)
    const allButLast = pool.slice(0, pool.length - 1).map(function id(puzzle) {
      return puzzle.id
    })
    const target = pool[pool.length - 1]
    const picked = api.pickPuzzle(grade, allButLast, api.createRng(7))
    assert.equal(picked.id, target.id, grade + ' should pick the only unseen puzzle')

    const allPlayed = pool.map(function id(puzzle) {
      return puzzle.id
    })
    const fallback = api.pickPuzzle(grade, allPlayed, api.createRng(8))
    assert.ok(fallback, grade + ' fully played should still return a puzzle')
    assert.equal(fallback.grade, grade)
  }
})

test('pickPuzzle: seeded rng gives >1 distinct id and is reproducible', () => {
  for (const grade of KNOWN_GRADES) {
    const rngA = api.createRng(20261018)
    const rngB = api.createRng(20261018)
    const seen = new Set()
    const sequence = []
    for (let i = 0; i < 40; i++) {
      const a = api.pickPuzzle(grade, [], rngA)
      seen.add(a.id)
      sequence.push(api.pickPuzzle(grade, [], rngB).id)
    }
    assert.ok(seen.size > 1, grade + ' distribution should not collapse to one id')
    const rngC = api.createRng(20261018)
    for (let i = 0; i < 40; i++) assert.equal(api.pickPuzzle(grade, [], rngC).id, sequence[i], 'deterministic sequence')
  }
})

test('pickPuzzle: does not mutate the played array', () => {
  const played = bankPuzzles('easy').slice(0, 3).map(function id(puzzle) {
    return puzzle.id
  })
  const snapshot = played.slice()
  api.pickPuzzle('easy', played, api.createRng(5))
  assert.deepEqual(played, snapshot)
})

// ===========================================================================
// §8.3 createState
// ===========================================================================

test('createState: picks a bank puzzle and starts a clean board', () => {
  for (const grade of KNOWN_GRADES) {
    const state = newState(grade, 31, 1234)
    assert.ok(api.findPuzzle(state.puzzleId), 'puzzleId must be in bank')
    assert.equal(state.grade, grade)
    assert.equal(state.givens.length, CELLS)
    assert.deepEqual(state.board, state.givens, 'board must start as givens')
    assert.equal(countNonZero(state.notes), 0)
    assert.equal(state.selected, null)
    assert.equal(state.notesMode, false)
    assert.equal(state.elapsedMs, 0)
    assert.equal(state.runningSince, 1234)
    assert.equal(state.won, false)
    assert.equal(state.winAcked, false)
    assert.deepEqual(state.undo, [])
    assert.ok(state.played.indexOf(state.puzzleId) !== -1, 'current puzzle must be marked played')
    assert.equal(new Set(state.played).size, state.played.length, 'played ids must be unique')
  }
})

test('createState: honours an existing played list (prefers unseen)', () => {
  const pool = bankPuzzles('expert')
  const unseen = pool[pool.length - 1]
  const played = pool.slice(0, pool.length - 1).map(function id(puzzle) {
    return puzzle.id
  })
  const state = newState('expert', 32, 0, played)
  assert.equal(state.puzzleId, unseen.id)
  assert.equal(state.played[state.played.length - 1], unseen.id)
  for (const id of played) assert.ok(state.played.indexOf(id) !== -1, 'previous played id kept: ' + id)
})

test('createState: missing/invalid grade falls back to normal', () => {
  const missing = api.createState({ now: 0, rng: api.createRng(33) })
  assert.equal(missing.grade, 'normal')
  const invalid = api.createState({ grade: 'impossible', now: 0, rng: api.createRng(34) })
  assert.equal(invalid.grade, 'normal')
})

// ===========================================================================
// §8.4 Input / notes / erase / undo / win lock
// ===========================================================================

test('applyDigit: givens/bounds/identical-digit are rejected', () => {
  const state = newState('easy', 41, 0)
  const given = state.givens.findIndex(function given(value) {
    return value !== 0
  })
  const empty = state.givens.findIndex(function empty(value) {
    return value === 0
  })
  const before = state.board.slice()
  assert.equal(api.applyDigit(state, given, 5, 100), false)
  assert.deepEqual(state.board, before)
  assert.equal(state.undo.length, 0)
  assert.equal(api.applyDigit(state, empty, 0, 100), false)
  assert.equal(api.applyDigit(state, empty, 10, 100), false)
  assert.equal(api.applyDigit(state, -1, 5, 100), false)
  assert.equal(api.applyDigit(state, CELLS, 5, 100), false)
  assert.equal(api.applyDigit(state, empty + 0.5, 5, 100), false)

  assert.equal(api.applyDigit(state, empty, 5, 100), true)
  assert.equal(state.board[empty], 5)
  assert.deepEqual(state.undo[0], { index: empty, prevValue: 0, prevNotes: 0 })
  assert.equal(api.applyDigit(state, empty, 5, 200), false, 'same digit is a no-op')
  assert.equal(state.undo.length, 1)
})

test('input: player layer never touches givens, conflicts are allowed and flagged', () => {
  const state = newState('normal', 42, 0)
  const given = state.givens.findIndex(function given(value) {
    return value !== 0
  })
  const row = Math.floor(given / GRID)
  let target = -1
  for (let c = 0; c < GRID; c++) {
    const index = row * GRID + c
    if (state.givens[index] === 0) {
      target = index
      break
    }
  }
  assert.ok(target >= 0)
  assert.equal(api.applyDigit(state, target, state.givens[given], 100), true)
  const conflicts = api.computeConflicts(state.board)
  assert.equal(conflicts[target], 1)
  assert.equal(conflicts[given], 1)
  assert.equal(state.board[given], state.givens[given], 'given cell untouched')
})

test('notes: toggle bits, reject filled cells, fill clears notes, undo restores', () => {
  const state = newState('easy', 43, 0)
  const empties = emptyIndices(state.givens)
  const a = empties[0]
  const b = empties[1]

  assert.equal(api.toggleNotesMode(state), true)
  assert.equal(api.applyDigit(state, a, 3, 100), true)
  assert.equal(state.board[a], 0)
  assert.equal(state.notes[a], 1 << 2)
  assert.equal(api.applyDigit(state, a, 3, 110), true, 'same note toggles off')
  assert.equal(state.notes[a], 0)
  assert.equal(api.applyDigit(state, a, 8, 120), true)
  const mask = state.notes[a]
  assert.equal(mask, 1 << 7)

  assert.equal(api.toggleNotesMode(state), false)
  assert.equal(api.applyDigit(state, a, 4, 130), true)
  assert.equal(state.notes[a], 0, 'filling clears notes')
  assert.equal(api.undoMove(state, 140), true)
  assert.equal(state.board[a], 0)
  assert.equal(state.notes[a], mask, 'undo restores the notes')

  api.toggleNotesMode(state)
  api.applyDigit(state, b, 9, 150)
  api.toggleNotesMode(state)
  assert.equal(api.applyDigit(state, b, 1, 160), true)
  assert.equal(state.board[b], 1)
  api.toggleNotesMode(state)
  assert.equal(api.applyDigit(state, b, 2, 170), false, 'notes mode cannot overwrite a value')
  api.toggleNotesMode(state)
})

test('eraseCell: clears value/notes, rejects givens and untouched cells', () => {
  const state = newState('easy', 44, 0)
  const empties = emptyIndices(state.givens)
  const a = empties[0]
  const b = empties[1]
  const given = state.givens.findIndex(function given(value) {
    return value !== 0
  })
  assert.equal(api.eraseCell(state, given, 100), false)
  assert.equal(api.eraseCell(state, a, 100), false)
  api.applyDigit(state, a, 6, 100)
  assert.equal(api.eraseCell(state, a, 110), true)
  assert.equal(state.board[a], 0)
  api.toggleNotesMode(state)
  api.applyDigit(state, b, 5, 120)
  assert.ok(state.notes[b] !== 0)
  assert.equal(api.eraseCell(state, b, 130), true)
  assert.equal(state.notes[b], 0)
})

test('undoMove: restores in order, skips corrupt entries, caps at 300', () => {
  const state = newState('easy', 45, 0)
  const empties = emptyIndices(state.givens)
  const a = empties[0]
  const b = empties[1]
  api.applyDigit(state, a, 1, 100)
  api.toggleNotesMode(state)
  api.applyDigit(state, b, 7, 110)
  api.toggleNotesMode(state)
  assert.equal(api.undoMove(state, 120), true)
  assert.equal(state.notes[b], 0)
  assert.equal(api.undoMove(state, 130), true)
  assert.equal(state.board[a], 0)
  assert.equal(api.undoMove(state, 140), false)

  const given = state.givens.findIndex(function given(value) {
    return value !== 0
  })
  state.board[a] = 9
  state.undo = [{ index: a, prevValue: 3, prevNotes: 0 }, { index: given, prevValue: 0, prevNotes: 0 }, null, { index: 'x' }]
  assert.equal(api.undoMove(state, 150), true)
  assert.equal(state.board[a], 3)
  assert.equal(state.undo.length, 0)

  const big = newState('easy', 46, 0)
  const cell = emptyIndices(big.givens)[0]
  for (let i = 0; i < 350; i++) assert.equal(api.applyDigit(big, cell, (i % 9) + 1, 100 + i), true)
  assert.equal(big.undo.length, api.UNDO_LIMIT)
})

test('win: filling the solution sets won, freezes the timer and locks mutation', () => {
  const state = newState('easy', 47, 0)
  const empties = emptyIndices(state.givens)
  const solution = independentSolve(state.givens, 1).first
  assert.ok(solution, 'bank puzzle must be solvable by the independent test solver')

  let now = 0
  for (let i = 0; i < empties.length; i++) {
    const index = empties[i]
    now = 1000 + i * 10
    assert.equal(api.applyDigit(state, index, solution[index], now), true)
    if (i < empties.length - 1) assert.equal(state.won, false)
  }
  assert.equal(state.won, true)
  assert.equal(state.winAcked, false)
  assert.equal(state.runningSince, null, 'timer pauses on win')
  const elapsedAtWin = state.elapsedMs
  assert.equal(elapsedAtWin, now)
  assert.equal(api.timerElapsed(state, now + 90000), elapsedAtWin, 'time frozen after win')

  const frozen = state.board.slice()
  const undoLen = state.undo.length
  assert.equal(api.applyDigit(state, empties[0], 1, now + 100), false)
  assert.equal(api.eraseCell(state, empties[0], now + 100), false)
  assert.equal(api.undoMove(state, now + 100), false)
  assert.equal(api.toggleNotesMode(state), false, 'notes mode toggle must be locked after win')
  assert.equal(state.notesMode, false)
  assert.deepEqual(state.board, frozen)
  assert.equal(state.undo.length, undoLen)

  const snapshot = api.getSnapshot(state, now + 60000)
  assert.equal(snapshot.won, true)
  assert.equal(snapshot.remaining, 0)
  assert.equal(snapshot.canUndo, false)
  assert.equal(snapshot.timerText, api.formatTime(elapsedAtWin))
  assert.equal(snapshot.puzzleId, state.puzzleId)
  assert.equal(snapshot.grade, 'easy')
})

test('win: a wrong final digit does not win', () => {
  const state = newState('normal', 48, 0)
  const empties = emptyIndices(state.givens)
  const solution = independentSolve(state.givens, 1).first
  for (let i = 0; i < empties.length - 1; i++) api.applyDigit(state, empties[i], solution[empties[i]], 100 + i)
  const last = empties[empties.length - 1]
  const correct = solution[last]
  const wrong = correct === 9 ? 1 : correct + 1
  assert.equal(api.applyDigit(state, last, wrong, 5000), true)
  assert.equal(state.won, false)
  assert.equal(api.isSolved(state.board), false)
  assert.equal(api.eraseCell(state, last, 5100), true)
  assert.equal(api.applyDigit(state, last, correct, 5200), true)
  assert.equal(state.won, true)
})

test('selection: selectCell / moveSelection clamp and start from 0', () => {
  const state = newState('easy', 49, 0)
  assert.equal(api.selectCell(state, 40), true)
  assert.equal(state.selected, 40)
  assert.equal(api.selectCell(state, -1), false)
  assert.equal(api.selectCell(state, CELLS), false)
  assert.equal(api.selectCell(state, 3.5), false)
  assert.equal(state.selected, 40)
  state.selected = null
  assert.equal(api.moveSelection(state, 1, 1), true)
  assert.equal(state.selected, 10)
  state.selected = 0
  assert.equal(api.moveSelection(state, -1, 0), false)
  assert.equal(api.moveSelection(state, 0, -1), false)
  state.selected = 8
  assert.equal(api.moveSelection(state, 0, 1), false)
  assert.equal(api.moveSelection(state, 1, 0), true)
  assert.equal(state.selected, 17)
  const given = state.givens.findIndex(function given(value) {
    return value !== 0
  })
  assert.equal(api.selectCell(state, given), true, 'givens are selectable for highlight')
})

test('hasProgress tracks entries and pencil marks', () => {
  const state = newState('easy', 50, 0)
  assert.equal(api.hasProgress(state), false)
  const cell = emptyIndices(state.givens)[0]
  api.applyDigit(state, cell, 7, 100)
  assert.equal(api.hasProgress(state), true)
  api.undoMove(state, 110)
  assert.equal(api.hasProgress(state), false)
  api.toggleNotesMode(state)
  api.applyDigit(state, cell, 2, 120)
  assert.equal(api.hasProgress(state), true)
})

// ===========================================================================
// §8.5 Restart / newPuzzle
// ===========================================================================

test('restartPuzzle: same puzzle, resets board/notes/undo/timer, keeps selection', () => {
  const state = newState('hard', 61, 0)
  const puzzleId = state.puzzleId
  const givens = state.givens.slice()
  const cell = emptyIndices(givens)[0]
  api.applyDigit(state, cell, 4, 100)
  api.selectCell(state, cell)
  api.timerPause(state, 400)

  api.restartPuzzle(state, 5000)
  assert.equal(state.puzzleId, puzzleId, 'restart keeps the same puzzle')
  assert.deepEqual(state.givens, givens)
  assert.deepEqual(state.board, givens)
  assert.equal(countNonZero(state.notes), 0)
  assert.deepEqual(state.undo, [])
  assert.equal(state.elapsedMs, 0)
  assert.equal(state.runningSince, 5000)
  assert.equal(state.won, false)
  assert.equal(state.selected, cell, 'valid selection preserved')
})

test('newPuzzle: changes puzzle, grade, clears progress, grows played', () => {
  const state = newState('easy', 62, 0)
  const previousId = state.puzzleId
  const previousCount = state.played.length
  const cell = emptyIndices(state.givens)[0]
  api.applyDigit(state, cell, 3, 100)
  api.selectCell(state, cell)

  api.newPuzzle(state, 'hard', api.createRng(63), 5000)
  assert.equal(state.grade, 'hard')
  assert.notEqual(state.puzzleId, previousId)
  assert.equal(api.findPuzzle(state.puzzleId).grade, 'hard')
  assert.deepEqual(state.board, state.givens)
  assert.equal(countNonZero(state.notes), 0)
  assert.deepEqual(state.undo, [])
  assert.equal(state.selected, null)
  assert.equal(state.elapsedMs, 0)
  assert.equal(state.runningSince, 5000)
  assert.equal(state.won, false)
  assert.equal(state.played.length, previousCount + 1)
  assert.equal(state.played[state.played.length - 1], state.puzzleId)
  assert.ok(state.played.indexOf(previousId) !== -1)
})

test('newPuzzle: prefers unseen ids and falls back when all are played', () => {
  const pool = bankPuzzles('normal')
  const target = pool[pool.length - 1]
  const state = newState('normal', 64, 0)
  state.played = pool.slice(0, pool.length - 1).map(function id(puzzle) {
    return puzzle.id
  })
  api.newPuzzle(state, 'normal', api.createRng(65), 0)
  assert.equal(state.puzzleId, target.id, 'only unseen puzzle chosen')

  const full = newState('normal', 66, 0)
  full.played = pool.map(function id(puzzle) {
    return puzzle.id
  })
  api.newPuzzle(full, 'normal', api.createRng(67), 0)
  assert.equal(api.findPuzzle(full.puzzleId).grade, 'normal')
  assert.ok(full.played.length <= pool.length, 'played list cannot exceed bank pool')
})

test('newPuzzle: invalid grade falls back to normal; played stays unique/capped', () => {
  const state = newState('easy', 68, 0)
  api.newPuzzle(state, 'not-a-grade', api.createRng(69), 0)
  assert.equal(state.grade, 'normal')

  const repeated = []
  const ids = api.BANK.puzzles.map(function id(puzzle) {
    return puzzle.id
  })
  for (let i = 0; i < 700; i++) repeated.push(ids[i % ids.length])
  const payload = api.serializeState(Object.assign({}, state, { played: repeated }), 0)
  assert.ok(payload.played.length <= 500, 'played cap 500')
  assert.equal(new Set(payload.played).size, payload.played.length, 'played deduped')
  const restored = api.sanitizeSave(payload)
  assert.ok(restored)
  assert.equal(restored.played.length, payload.played.length)
})

// ===========================================================================
// §8.7 Timer
// ===========================================================================

test('timer: pause / resume / elapsed semantics with a fake clock', () => {
  const state = newState('easy', 71, 1000)
  assert.equal(state.runningSince, 1000)
  assert.equal(api.timerElapsed(state, 1500), 500)
  assert.equal(api.timerElapsed(state, 400), 0)
  api.timerPause(state, 1500)
  assert.equal(state.elapsedMs, 500)
  assert.equal(state.runningSince, null)
  assert.equal(api.timerElapsed(state, 9000), 500)
  api.timerPause(state, 9500)
  assert.equal(state.elapsedMs, 500)
  api.timerResume(state, 9000)
  assert.equal(state.runningSince, 9000)
  assert.equal(api.timerElapsed(state, 9500), 1000)
  api.timerResume(state, 9700)
  assert.equal(state.runningSince, 9000)
  api.timerPause(state, 8000)
  assert.equal(state.elapsedMs, 500)
  assert.equal(state.runningSince, null)
})

// ===========================================================================
// §8.8 Save / restore
// ===========================================================================

test('serializeState: exact v2 save shape', () => {
  const state = newState('normal', 81, 1000)
  const empties = emptyIndices(state.givens)
  api.applyDigit(state, empties[0], 5, 1100)
  api.toggleNotesMode(state)
  api.applyDigit(state, empties[1], 3, 1200)
  api.timerPause(state, 1500)
  state.winAcked = true

  const payload = api.serializeState(state)
  assert.deepEqual(Object.keys(payload).sort(), SAVE_KEYS, 'save keys must be exactly the v2 schema')
  assert.equal(payload.schemaVersion, 2)
  assert.equal(payload.puzzleId, state.puzzleId)
  assert.equal(payload.grade, state.grade)
  assert.equal(payload.entries.length, CELLS)
  const givenIndex = state.givens.findIndex(function given(value) {
    return value !== 0
  })
  assert.equal(payload.entries[givenIndex], 0, 'entries are 0 on givens')
  assert.equal(payload.entries[empties[0]], 5)
  assert.equal(payload.notes.length, CELLS)
  assert.equal(payload.notes[empties[1]], 1 << 2)
  assert.equal(payload.elapsed, 500)
  assert.ok(Array.isArray(payload.played))
  assert.ok(payload.played.indexOf(state.puzzleId) !== -1)
  assert.equal(payload.winAcked, true)
  assert.equal('runningSince' in payload, false)
  assert.equal('won' in payload, false)
  assert.equal('givens' in payload, false, 'givens live in the bank, not in the save')
})

test('serializeState: explicit now freezes the live timer without mutating state', () => {
  const state = newState('easy', 82, 1000)
  api.timerPause(state, 1000)
  api.timerResume(state, 2000)
  const payload = api.serializeState(state, 6500)
  assert.equal(payload.elapsed, 4500)
  assert.equal(state.elapsedMs, 0)
})

test('sanitizeSave: serialize -> sanitize round-trips the same puzzle and progress', () => {
  const state = newState('expert', 83, 1000)
  const empties = emptyIndices(state.givens)
  api.selectCell(state, empties[0])
  api.applyDigit(state, empties[0], 6, 1100)
  api.toggleNotesMode(state)
  api.applyDigit(state, empties[1], 1, 1200)
  api.applyDigit(state, empties[1], 9, 1300)
  api.timerPause(state, 2000)

  const payload = api.serializeState(state)
  const restored = api.sanitizeSave(payload)
  assert.ok(restored, 'valid save restores')
  assert.equal(restored.puzzleId, state.puzzleId)
  assert.equal(restored.grade, state.grade)
  assert.deepEqual(restored.givens, state.givens, 'givens come from the bank for the same puzzleId')
  assert.deepEqual(restored.board, state.board)
  assert.deepEqual(restored.notes, state.notes)
  assert.equal(restored.elapsedMs, state.elapsedMs)
  assert.equal(restored.runningSince, null)
  assert.equal(restored.won, api.isSolved(state.board))
  assert.equal(restored.selected, null, 'v2 save does not persist selection')
  assert.equal(restored.notesMode, false, 'v2 save does not persist the notes-mode toggle')
  assert.deepEqual(restored.undo, [], 'v2 save does not persist the undo stack')
  assert.deepEqual(restored.played, payload.played)
})

test('sanitizeSave: rejects old v1 saves and unknown/mismatched puzzle ids', () => {
  const state = newState('normal', 84, 0)
  const base = api.serializeState(state, 100)

  const v1 = {
    schemaVersion: 1,
    difficulty: 'normal',
    targetGivens: 34,
    givens: new Array(CELLS).fill(0),
    solution: new Array(CELLS).fill(1),
    board: new Array(CELLS).fill(0),
    notes: new Array(CELLS).fill(0),
    selected: null,
    notesMode: false,
    elapsedMs: 0,
    won: false,
    winAcked: false,
    undo: [],
  }
  assert.equal(api.sanitizeSave(v1), null, 'v1 saves must be dropped')

  const unknown = clone(base)
  unknown.puzzleId = 'normal-does-not-exist'
  assert.equal(api.sanitizeSave(unknown), null)

  const mismatched = clone(base)
  mismatched.grade = mismatched.grade === 'easy' ? 'hard' : 'easy'
  assert.equal(api.sanitizeSave(mismatched), null, 'grade must match the bank puzzle')

  for (const bad of [null, undefined, 42, 'not json', [], {}]) {
    assert.equal(api.sanitizeSave(bad), null)
  }
  const wrongVersion = clone(base)
  wrongVersion.schemaVersion = 3
  assert.equal(api.sanitizeSave(wrongVersion), null)
})

test('sanitizeSave: bad-save matrix (structural problems -> null)', () => {
  const state = newState('hard', 85, 0)
  const cell = emptyIndices(state.givens)[0]
  api.applyDigit(state, cell, 4, 100)
  const base = api.serializeState(state, 200)

  const rejects = [
    ['entries missing', mutate(base, function (save) { delete save.entries })],
    ['entries short', mutate(base, function (save) { save.entries = save.entries.slice(0, 80) })],
    ['entries long', mutate(base, function (save) { save.entries = save.entries.concat([0]) })],
    ['entries out of range', mutate(base, function (save) { save.entries[cell] = 10 })],
    ['entries non-integer', mutate(base, function (save) { save.entries[cell] = 1.5 })],
    ['entries negative', mutate(base, function (save) { save.entries[cell] = -1 })],
    ['entries string', mutate(base, function (save) { save.entries[cell] = '5' })],
    ['notes missing', mutate(base, function (save) { delete save.notes })],
    ['notes short', mutate(base, function (save) { save.notes = save.notes.slice(0, 80) })],
    ['notes out of range', mutate(base, function (save) { save.notes[cell] = 512 })],
    ['notes non-integer', mutate(base, function (save) { save.notes[cell] = 0.5 })],
    ['elapsed missing', mutate(base, function (save) { delete save.elapsed })],
    ['elapsed string', mutate(base, function (save) { save.elapsed = 'soon' })],
    ['elapsed NaN', mutate(base, function (save) { save.elapsed = NaN })],
    ['puzzleId missing', mutate(base, function (save) { delete save.puzzleId })],
    ['puzzleId number', mutate(base, function (save) { save.puzzleId = 7 })],
    ['schemaVersion missing', mutate(base, function (save) { delete save.schemaVersion })],
  ]
  for (const pair of rejects) {
    assert.equal(api.sanitizeSave(pair[1]), null, 'should reject: ' + pair[0])
  }
  assert.ok(api.sanitizeSave(clone(base)), 'baseline save must be valid')
})

test('sanitizeSave: tolerant normalisation (givens/notes/played/elapsed/winAcked)', () => {
  const state = newState('normal', 86, 0)
  const empties = emptyIndices(state.givens)
  const given = state.givens.findIndex(function given(value) {
    return value !== 0
  })
  api.applyDigit(state, empties[0], 7, 100)
  const base = api.serializeState(state, 200)

  // given cells in the entries layer are forced back to 0 -> board keeps the given
  const givenEntry = clone(base)
  givenEntry.entries[given] = 9
  const fixedGiven = api.sanitizeSave(givenEntry)
  assert.ok(fixedGiven)
  assert.equal(fixedGiven.board[given], state.givens[given])

  // stale notes on given / filled cells are zeroed, not rejected
  const staleNotes = clone(base)
  staleNotes.notes[given] = 5
  staleNotes.notes[empties[0]] = 7
  const fixedNotes = api.sanitizeSave(staleNotes)
  assert.ok(fixedNotes)
  assert.equal(fixedNotes.notes[given], 0)
  assert.equal(fixedNotes.notes[empties[0]], 0)

  // elapsed clamp + rounding
  const low = clone(base)
  low.elapsed = -50
  assert.equal(api.sanitizeSave(low).elapsedMs, 0)
  const high = clone(base)
  high.elapsed = 1e12
  assert.equal(api.sanitizeSave(high).elapsedMs, 604800000)
  const rounded = clone(base)
  rounded.elapsed = 1234.7
  assert.equal(api.sanitizeSave(rounded).elapsedMs, 1235)

  // played: unknown ids dropped, duplicates removed, cap respected
  const hostilePlayed = clone(base)
  const ids = api.BANK.puzzles.slice(0, 5).map(function id(puzzle) {
    return puzzle.id
  })
  hostilePlayed.played = ['ghost-1'].concat(ids).concat(ids).concat([state.puzzleId])
  const playedOut = api.sanitizeSave(hostilePlayed).played
  assert.equal(playedOut.indexOf('ghost-1'), -1)
  assert.equal(new Set(playedOut).size, playedOut.length)
  assert.ok(playedOut.indexOf(state.puzzleId) !== -1)
  assert.ok(playedOut.length <= 500)

  const notArray = clone(base)
  notArray.played = 'nope'
  assert.ok(api.sanitizeSave(notArray), 'non-array played is tolerated')
  assert.deepEqual(api.sanitizeSave(notArray).played, [])

  // winAcked is booleanised
  const coerced = clone(base)
  coerced.winAcked = 1
  assert.equal(api.sanitizeSave(coerced).winAcked, false)
  coerced.winAcked = true
  assert.equal(api.sanitizeSave(coerced).winAcked, true)
})

test('sanitizeSave: won is recomputed from the board (never trusted blindly)', () => {
  const state = newState('easy', 87, 0)
  const base = api.serializeState(state, 100)
  const fakeWin = clone(base)
  fakeWin.won = true
  assert.equal(api.sanitizeSave(fakeWin).won, false)

  const solution = independentSolve(state.givens, 1).first
  const solvedEntries = zeroEntries()
  for (let i = 0; i < CELLS; i++) if (state.givens[i] === 0) solvedEntries[i] = solution[i]
  const solved = clone(base)
  solved.entries = solvedEntries
  const restored = api.sanitizeSave(solved)
  assert.equal(restored.won, true)
  assert.equal(restored.winAcked, false)
})

test('sanitizeSave: 500 random mutations never throw; accepted states stay coherent', () => {
  const state = newState('hard', 88, 0)
  const cell = emptyIndices(state.givens)[0]
  api.applyDigit(state, cell, 2, 100)
  const base = api.serializeState(state, 200)
  const random = api.createRng(20261018)
  const keys = ['schemaVersion', 'puzzleId', 'grade', 'entries', 'notes', 'elapsed', 'played', 'winAcked']
  let accepted = 0

  for (let iteration = 0; iteration < 500; iteration++) {
    const save = clone(base)
    const operations = 1 + Math.floor(random() * 3)
    for (let op = 0; op < operations; op++) {
      const key = keys[Math.floor(random() * keys.length)]
      const choice = Math.floor(random() * 5)
      if (choice === 0) {
        delete save[key]
      } else if (choice === 1) {
        save[key] = null
      } else if (choice === 2 && Array.isArray(save[key])) {
        const array = save[key]
        if (array.length > 0) array[Math.floor(random() * array.length)] = Math.floor(random() * 24) - 6
      } else if (choice === 3 && Array.isArray(save[key])) {
        save[key].length = Math.floor(random() * 100)
      } else {
        save[key] = { mutated: true }
      }
    }
    let result
    try {
      result = api.sanitizeSave(save)
    } catch (error) {
      throw new Error('sanitizeSave threw on mutation #' + iteration + ': ' + error)
    }
    if (result) {
      accepted += 1
      const puzzle = api.findPuzzle(result.puzzleId)
      assert.ok(puzzle, 'accepted state must point at a bank puzzle')
      assert.equal(result.grade, puzzle.grade)
      assert.equal(result.givens.length, CELLS)
      assert.equal(result.board.length, CELLS)
      assert.equal(result.notes.length, CELLS)
      assert.equal(result.runningSince, null)
      assert.equal(result.won, api.isSolved(result.board))
      assert.ok(result.elapsedMs >= 0 && result.elapsedMs <= 604800000)
      for (let i = 0; i < CELLS; i++) {
        if (result.givens[i] !== 0) assert.equal(result.board[i], result.givens[i], 'given cell overwritten')
        if (result.givens[i] !== 0 || result.board[i] !== 0) assert.equal(result.notes[i], 0, 'stale notes kept')
      }
    }
  }
  assert.ok(accepted >= 1, 'at least some mutated-but-valid saves should be accepted')
})

test('loadSavedState / saveState: defensive storage paths', () => {
  storage.clear()
  assert.equal(api.loadSavedState(), null, 'missing key -> null')

  storage.set(api.STORE_KEY, 'not json at all')
  assert.equal(api.loadSavedState(), null, 'bad JSON -> null')

  storage.set(api.STORE_KEY, JSON.stringify({ schemaVersion: 1 }))
  assert.equal(api.loadSavedState(), null, 'old v1 shape -> null')

  const state = newState('hard', 89, 1000)
  api.timerPause(state, 4000)
  assert.equal(api.saveState(state), true)
  const restored = api.loadSavedState()
  assert.ok(restored)
  assert.equal(restored.puzzleId, state.puzzleId)
  assert.deepEqual(restored.givens, state.givens)
  assert.equal(restored.elapsedMs, 3000)
  assert.equal(restored.runningSince, null)

  const originalStorage = window.localStorage
  window.localStorage = {
    getItem() {
      throw new Error('storage blocked')
    },
    setItem() {
      throw new Error('storage blocked')
    },
    removeItem() {
      throw new Error('storage blocked')
    },
  }
  try {
    assert.equal(api.loadSavedState(), null)
    assert.equal(api.saveState(state), false)
  } finally {
    window.localStorage = originalStorage
  }

  window.localStorage = undefined
  try {
    assert.equal(api.loadSavedState(), null)
    assert.equal(api.saveState(state), false)
  } finally {
    window.localStorage = originalStorage
  }

  assert.equal(api.saveState(null), false)
})

test('restore keeps the SAME bank puzzle (never re-picks; unknown id -> null)', () => {
  storage.clear()
  const state = newState('normal', 90, 0)
  const puzzleId = state.puzzleId
  const signature = state.givens.join(',')
  const cell = emptyIndices(state.givens)[0]
  api.applyDigit(state, cell, 8, 500)
  // The component pauses the timer before persisting; mirror that here by
  // freezing the live elapsed time through the explicit `now` argument.
  assert.equal(api.saveState(state, 500), true)

  const restored = api.loadSavedState()
  assert.ok(restored)
  assert.equal(restored.puzzleId, puzzleId, 'puzzleId restored verbatim')
  assert.equal(restored.givens.join(','), signature, 'same givens')
  assert.equal(restored.board[cell], 8, 'entries restored')
  assert.equal(restored.elapsedMs, 500, 'elapsed restored')

  // unknown id: sanitize must reject (the caller starts a fresh puzzle, never a swap)
  const payload = api.serializeState(state, 0)
  payload.puzzleId = 'normal-missing'
  storage.set(api.STORE_KEY, JSON.stringify(payload))
  assert.equal(api.loadSavedState(), null)
})

// ===========================================================================
// §8.9 formatTime / conflicts / isSolved / countEmpty
// ===========================================================================

test('formatTime boundaries', () => {
  assert.equal(api.formatTime(0), '00:00')
  assert.equal(api.formatTime(-1000), '00:00')
  assert.equal(api.formatTime(NaN), '00:00')
  assert.equal(api.formatTime(999), '00:00')
  assert.equal(api.formatTime(1000), '00:01')
  assert.equal(api.formatTime(59999), '00:59')
  assert.equal(api.formatTime(60000), '01:00')
  assert.equal(api.formatTime(3599000), '59:59')
  assert.equal(api.formatTime(3600000), '1:00:00')
  assert.equal(api.formatTime(3661000), '1:01:01')
  assert.equal(api.formatTime(86399000), '23:59:59')
  assert.equal(api.formatTime(360000000), '100:00:00')
})

test('computeConflicts: row / column / box / clean / solved', () => {
  const zero = function zero() {
    return new Array(CELLS).fill(0)
  }
  const row = zero()
  row[0] = 5
  row[4] = 5
  let conflicts = api.computeConflicts(row)
  assert.equal(conflicts[0], 1)
  assert.equal(conflicts[4], 1)
  assert.equal(countNonZero(conflicts), 2)

  const col = zero()
  col[1] = 7
  col[37] = 7
  conflicts = api.computeConflicts(col)
  assert.equal(conflicts[1], 1)
  assert.equal(conflicts[37], 1)

  const box = zero()
  box[0] = 3
  box[10] = 3
  conflicts = api.computeConflicts(box)
  assert.equal(conflicts[0], 1)
  assert.equal(conflicts[10], 1)

  const clean = zero()
  clean[0] = 1
  clean[1] = 2
  clean[9] = 3
  assert.equal(countNonZero(api.computeConflicts(clean)), 0)

  const state = newState('easy', 91, 0)
  const solution = independentSolve(state.givens, 1).first
  assert.equal(countNonZero(api.computeConflicts(solution)), 0)
})

test('isSolved / countEmpty edges', () => {
  const state = newState('easy', 92, 0)
  assert.equal(api.isSolved(state.board), false)
  assert.equal(api.isSolved(new Array(CELLS).fill(0)), false)
  assert.equal(api.countEmpty(state.board), emptyIndices(state.givens).length)
  const solution = independentSolve(state.givens, 1).first
  assert.equal(api.isSolved(solution), true)
  assert.equal(api.countEmpty(solution), 0)
  const duplicate = solution.slice()
  duplicate[1] = duplicate[0]
  assert.equal(api.isSolved(duplicate), false)
})

// ===========================================================================
// Report
// ===========================================================================

console.log('')
console.log('=== inline bank summary ===')
console.log('bank puzzles: ' + api.BANK.puzzles.length + ' (version ' + api.BANK.version + ', generatedAt ' + JSON.stringify(api.BANK.generatedAt) + ')')
console.log('levels: ' + api.LEVELS.map(function text(level) { return level.key + '/' + level.label + '/' + level.level }).join('  '))
for (const grade of KNOWN_GRADES) {
  const pool = bankPuzzles(grade)
  const clues = pool
    .map(function clueCount(puzzle) {
      return countNonZero(parseGivensForTest(puzzle.givens))
    })
    .sort(function asc(a, b) {
      return a - b
    })
  const median = clues.length ? clues[Math.floor(clues.length / 2)] : 0
  console.log(
    '  ' +
      grade.padEnd(8) +
      'count=' +
      String(pool.length).padEnd(4) +
      'clues min/median/max=' +
      (clues[0] || 0) +
      '/' +
      median +
      '/' +
      (clues[clues.length - 1] || 0),
  )
}
console.log('dev/bank.json: ' + (diskBank ? 'present' : 'MISSING (bank promotion pending)') + '; dev/lib/techniques.mjs: ' + (techniques ? 'present' : 'missing'))
console.log('')
if (failed > 0) {
  console.error('FAILURES:')
  for (const failure of failures) {
    console.error(' - ' + failure.name)
    console.error(failure.error && failure.error.stack ? failure.error.stack : failure.error)
  }
  console.error('')
}
console.log('PASS ' + passed + ' / FAIL ' + failed)
process.exitCode = failed === 0 ? 0 : 1
