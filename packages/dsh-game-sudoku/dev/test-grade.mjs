#!/usr/bin/env node
/**
 * test-grade.mjs — acceptance test for the offline sudoku bank (api-spec-v2.md §6).
 *
 * `node dev/test-grade.mjs`
 *
 * Reads:
 *   dev/bank.json                     (authoritative bank; env SUDOKU_BANK_PATH)
 *   packages/dsh-game-sudoku/client.js (inline PUZZLE BANK block; env SUDOKU_CLIENT_PATH)
 *
 * Covers:
 *   1. Bank structure: 5 grades x 30..50, ids/solutions/givens/clues/techniques
 *      shape, id = grade + FNV-1a32(givens) base36, unique ids + unique givens,
 *      stable level ordering, conflict-free givens, valid solution.
 *   2. PER-PUZZLE INDEPENDENT RE-GRADE x3: grade === recorded grade every time,
 *      techniques identical across all three passes AND equal to the bank record,
 *      solution equals solve(), solution is a valid complete grid consistent with
 *      the givens.
 *   3. Unique solution: lib countSolutions(givens, 2) === 1 AND an independent
 *      set/array-based solver written here from scratch also counts exactly 1 and
 *      returns the recorded solution.
 *   4. 100 random generated puzzles (lib generateFullGrid + digPuzzle, seeded):
 *      every one must have exactly one solution (independent solver), be
 *      conflict-free and consistent with its own solution -> expect 100/100.
 *   5. Technique coverage: per-grade technique table + assertions
 *      (easy singles only; normal needs locked; hard needs pairs/triples;
 *      expert needs a wing; hell contains stuck puzzles).
 *   6. Inline consistency: client.js PUZZLE_BANK id/grade/givens/levels/count
 *      exactly match dev/bank.json, in order, and contain no solutions.
 *
 * Prints `PASS n / FAIL 0` and exits non-zero on any failure.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LEVELS,
  TECHNIQUE_LEVEL,
  parseGrid,
  gridToString,
  countSolutions,
  solve,
  computeConflicts,
  gradePuzzle,
  makeRng,
  generateFullGrid,
  digPuzzle,
} from './lib/techniques.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BANK_PATH = process.env.SUDOKU_BANK_PATH
  ? path.resolve(process.env.SUDOKU_BANK_PATH)
  : path.resolve(HERE, 'bank.json')
const CLIENT_PATH = process.env.SUDOKU_CLIENT_PATH
  ? path.resolve(process.env.SUDOKU_CLIENT_PATH)
  : path.resolve(HERE, '..', 'client.js')

const GRADE_LEVEL = Object.freeze({
  easy: 1,
  normal: 2,
  hard: 3,
  expert: 4,
  hell: 5,
})

const LEVEL_GRADE = Object.freeze(['invalid', 'easy', 'normal', 'hard', 'expert', 'hell'])
const TECHNIQUE_NAMES = Object.freeze(Object.keys(TECHNIQUE_LEVEL))
const LEVEL1 = new Set(['naked-single', 'hidden-single'])
const LOCKED = new Set(['pointing', 'claiming'])
const PAIRS_TRIPLES = new Set(['naked-pair', 'naked-triple', 'hidden-pair', 'hidden-triple'])
const WINGS = new Set(['x-wing', 'xy-wing'])

let passCount = 0
let failCount = 0
const failures = []

function recordPass() {
  passCount++
}

function check(name, condition, detail) {
  if (condition) {
    recordPass()
    return true
  }
  failCount++
  failures.push(detail ? name + ' :: ' + detail : name)
  return false
}

function section(title) {
  console.log('')
  console.log('## ' + title)
}

function fnv1a32(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// ---------------------------------------------------------------------------
// Independent helpers (written from scratch; deliberately NOT the lib code path)
// ---------------------------------------------------------------------------

const PEERS = (function buildPeers() {
  const peers = []
  for (let cell = 0; cell < 81; cell++) {
    const row = Math.floor(cell / 9)
    const col = cell % 9
    const boxRow = Math.floor(row / 3) * 3
    const boxCol = Math.floor(col / 3) * 3
    const set = new Set()
    for (let k = 0; k < 9; k++) {
      set.add(row * 9 + k)
      set.add(k * 9 + col)
      set.add((boxRow + Math.floor(k / 3)) * 9 + (boxCol + (k % 3)))
    }
    set.delete(cell)
    peers.push(Array.from(set).sort((a, b) => a - b))
  }
  return peers
})()

function parseDigits(text) {
  const grid = new Array(81)
  for (let i = 0; i < 81; i++) grid[i] = text.charCodeAt(i) - 48
  return grid
}

function independentCandidates(grid, cell) {
  const used = new Set()
  for (const peer of PEERS[cell]) {
    const value = grid[peer]
    if (value !== 0) used.add(value)
  }
  const out = []
  for (let digit = 1; digit <= 9; digit++) if (!used.has(digit)) out.push(digit)
  return out
}

/** Independent MRV backtracking solver: counts solutions (capped) and captures the first. */
function independentSolve(text, limit) {
  const cap = limit || 2
  const grid = parseDigits(text)
  for (let cell = 0; cell < 81; cell++) {
    const value = grid[cell]
    if (value < 0 || value > 9) return { count: 0, solution: null, error: 'bad-cell' }
  }
  // Conflict detection is implicit: duplicate givens make some unit unsolvable
  // / candidates empty, which yields zero solutions.
  let count = 0
  let solution = null
  function recurse() {
    let target = -1
    let targetCandidates = null
    for (let cell = 0; cell < 81; cell++) {
      if (grid[cell] !== 0) continue
      const candidates = independentCandidates(grid, cell)
      if (candidates.length === 0) return
      if (!targetCandidates || candidates.length < targetCandidates.length) {
        target = cell
        targetCandidates = candidates
        if (candidates.length === 1) break
      }
    }
    if (target === -1) {
      count++
      if (solution === null) solution = grid.slice()
      return
    }
    for (const digit of targetCandidates) {
      grid[target] = digit
      recurse()
      grid[target] = 0
      if (count >= cap) return
    }
  }
  recurse()
  return { count: Math.min(count, cap), solution }
}

/** Independent full-grid validity check (rows, columns, boxes). */
function isCompleteValidSolution(grid) {
  if (!grid || grid.length !== 81) return false
  for (let i = 0; i < 81; i++) {
    if (!Number.isInteger(grid[i]) || grid[i] < 1 || grid[i] > 9) return false
  }
  for (let row = 0; row < 9; row++) {
    const seen = new Set()
    for (let col = 0; col < 9; col++) {
      const value = grid[row * 9 + col]
      if (seen.has(value)) return false
      seen.add(value)
    }
  }
  for (let col = 0; col < 9; col++) {
    const seen = new Set()
    for (let row = 0; row < 9; row++) {
      const value = grid[row * 9 + col]
      if (seen.has(value)) return false
      seen.add(value)
    }
  }
  for (let boxRow = 0; boxRow < 3; boxRow++) {
    for (let boxCol = 0; boxCol < 3; boxCol++) {
      const seen = new Set()
      for (let k = 0; k < 9; k++) {
        const value = grid[(boxRow * 3 + Math.floor(k / 3)) * 9 + (boxCol * 3 + (k % 3))]
        if (seen.has(value)) return false
        seen.add(value)
      }
    }
  }
  return true
}

function independentConflictFree(givensText) {
  const grid = parseDigits(givensText)
  for (let cell = 0; cell < 81; cell++) {
    const value = grid[cell]
    if (value === 0) continue
    for (const peer of PEERS[cell]) {
      if (grid[peer] === value) return false
    }
  }
  return true
}

function isDigits(text, length) {
  if (typeof text !== 'string' || text.length !== length) return false
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i)
    if (code < 48 || code > 57) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Load inputs
// ---------------------------------------------------------------------------

function loadBank() {
  if (!fs.existsSync(BANK_PATH)) {
    console.error('FATAL: bank.json not found at ' + BANK_PATH)
    process.exit(1)
  }
  let bank
  try {
    bank = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'))
  } catch (error) {
    console.error('FATAL: bank.json is not valid JSON: ' + error.message)
    process.exit(1)
  }
  return bank
}

const BANK_BEGIN = 'SUDOKU PUZZLE BANK: BEGIN'
const BANK_END = 'SUDOKU PUZZLE BANK: END'

function loadInlineBank() {
  if (!fs.existsSync(CLIENT_PATH)) return { missing: 'client.js not found at ' + CLIENT_PATH }
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const lines = source.split('\n')
  const begin = lines.findIndex((line) => line.includes(BANK_BEGIN))
  const end = lines.findIndex((line, index) => index >= begin && line.includes(BANK_END))
  if (begin === -1 || end === -1) return { missing: 'client.js has no SUDOKU PUZZLE BANK markers' }
  const block = lines.slice(begin + 1, end).join('\n')
  try {
    const inline = new Function(block + '\nreturn PUZZLE_BANK')()
    return { inline, blockBytes: Buffer.byteLength(lines.slice(begin, end + 1).join('\n'), 'utf8'), source }
  } catch (error) {
    return { missing: 'inline PUZZLE_BANK does not evaluate: ' + error.message }
  }
}

// ---------------------------------------------------------------------------
// 1. Structure
// ---------------------------------------------------------------------------

function testStructure(bank) {
  section('1. bank structure')
  check('bank is an object', bank && typeof bank === 'object')
  check('bank.version === 2', bank.version === 2, 'got ' + bank.version)
  check('bank.generatedAt is a non-empty string', typeof bank.generatedAt === 'string' && bank.generatedAt.length > 0)
  check(
    'bank.generator has numeric seed/attempts/genMs',
    bank.generator &&
      Number.isFinite(bank.generator.seed) &&
      Number.isFinite(bank.generator.attempts) &&
      Number.isFinite(bank.generator.genMs),
  )

  check('bank.levels is an array of 5', Array.isArray(bank.levels) && bank.levels.length === 5)
  const levelsOk = LEVELS.every((expected, index) => {
    const actual = bank.levels[index]
    return (
      actual &&
      actual.key === expected.key &&
      actual.label === expected.label &&
      actual.level === expected.level &&
      Number.isInteger(actual.count) &&
      actual.count >= 30 &&
      actual.count <= 50
    )
  })
  check('levels match spec keys/labels/levels and counts 30..50', levelsOk, JSON.stringify(bank.levels))

  check('bank.puzzles is an array', Array.isArray(bank.puzzles))
  const totalCount = bank.levels.reduce((sum, level) => sum + level.count, 0)
  check('puzzle count equals sum of level counts', bank.puzzles.length === totalCount, bank.puzzles.length + ' vs ' + totalCount)

  const ids = new Set()
  const givensSeen = new Set()
  const countByGrade = Object.create(null)
  const problems = []
  for (const puzzle of bank.puzzles) {
    const label = puzzle && puzzle.id ? puzzle.id : JSON.stringify(puzzle).slice(0, 40)
    if (!puzzle || typeof puzzle !== 'object') {
      problems.push(label + ': not an object')
      continue
    }
    if (typeof puzzle.id !== 'string' || !/^(easy|normal|hard|expert|hell)-[0-9a-z]+$/.test(puzzle.id)) {
      problems.push(label + ': bad id shape')
      continue
    }
    if (!(puzzle.grade in GRADE_LEVEL)) problems.push(label + ': bad grade ' + puzzle.grade)
    if (!isDigits(puzzle.givens, 81)) problems.push(label + ': givens not 81 digits')
    if (!isDigits(puzzle.solution, 81)) problems.push(label + ': solution not 81 digits')
    if (!Array.isArray(puzzle.techniques)) problems.push(label + ': techniques not an array')
    else if (puzzle.techniques.some((name) => !(name in TECHNIQUE_LEVEL))) {
      problems.push(label + ': unknown/unsorted technique name')
    } else if (JSON.stringify(puzzle.techniques) !== JSON.stringify(Array.from(new Set(puzzle.techniques)))) {
      problems.push(label + ': techniques list is not unique')
    }
    if (puzzle.clues !== puzzle.givens.split('0').join('').length) {
      problems.push(label + ': clues field mismatch')
    }
    const expectedId = puzzle.grade + '-' + fnv1a32(puzzle.givens).toString(36)
    if (puzzle.id !== expectedId) problems.push(label + ': id != FNV-1a32(givens) (' + expectedId + ')')
    if (ids.has(puzzle.id)) problems.push(label + ': duplicate id')
    ids.add(puzzle.id)
    if (givensSeen.has(puzzle.givens)) problems.push(label + ': duplicate givens')
    givensSeen.add(puzzle.givens)
    countByGrade[puzzle.grade] = (countByGrade[puzzle.grade] || 0) + 1

    // givens: conflict-free, consistent with solution, solution valid.
    if (isDigits(puzzle.givens, 81) && isDigits(puzzle.solution, 81)) {
      if (!independentConflictFree(puzzle.givens)) problems.push(label + ': conflicting givens')
      if (computeConflicts(puzzle.givens).some((value) => value !== 0)) {
        problems.push(label + ': lib reports conflicting givens')
      }
      const solutionGrid = parseDigits(puzzle.solution)
      if (!isCompleteValidSolution(solutionGrid)) problems.push(label + ': solution is not a valid complete grid')
      const givensGrid = parseDigits(puzzle.givens)
      for (let i = 0; i < 81; i++) {
        if (givensGrid[i] !== 0 && givensGrid[i] !== solutionGrid[i]) {
          problems.push(label + ': givens not consistent with solution')
          break
        }
      }
    }
  }
  check('every puzzle passes structural checks', problems.length === 0, problems.slice(0, 8).join(' | '))

  // ordering: level order, then id ascending within grade
  let orderOk = true
  let orderDetail = ''
  let cursor = 0
  for (const level of bank.levels) {
    const slice = bank.puzzles.slice(cursor, cursor + level.count)
    cursor += level.count
    if (slice.some((puzzle) => puzzle.grade !== level.key)) {
      orderOk = false
      orderDetail = 'non-' + level.key + ' puzzle inside ' + level.key + ' block'
      break
    }
    const sorted = slice.map((puzzle) => puzzle.id).slice().sort()
    if (JSON.stringify(slice.map((puzzle) => puzzle.id)) !== JSON.stringify(sorted)) {
      orderOk = false
      orderDetail = level.key + ' ids not sorted'
      break
    }
  }
  check('puzzles ordered by level then id', orderOk, orderDetail)

  for (const level of LEVELS) {
    const count = countByGrade[level.key] || 0
    check('grade ' + level.key + ' count matches level.count', count === bank.levels.find((l) => l.key === level.key).count)
  }
}

// ---------------------------------------------------------------------------
// 2 + 3. Independent re-grade x3, uniqueness, solutions
// ---------------------------------------------------------------------------

function testGradingAndUniqueness(bank) {
  section('2/3. 3x independent re-grade, uniqueness, solution consistency')
  let stableGrade = 0
  let stableTechniques = 0
  let stableSolution = 0
  let uniqueLib = 0
  let uniqueIndependent = 0
  const gradeProblems = []
  const regradeMs = { start: Date.now() }

  for (const puzzle of bank.puzzles) {
    const givens = puzzle.givens
    let gradeOk = true
    let techniquesOk = true
    let solutionOk = true
    const results = []
    for (let pass = 0; pass < 3; pass++) {
      const result = gradePuzzle(givens)
      results.push(result)
      if (result.grade !== puzzle.grade) gradeOk = false
      if (JSON.stringify(result.techniques) !== JSON.stringify(puzzle.techniques)) techniquesOk = false
      if (!result.solution || gridToString(result.solution) !== puzzle.solution) solutionOk = false
    }
    if (gradeOk) stableGrade++
    else gradeProblems.push(puzzle.id + ': ' + results.map((r) => r.grade).join('/'))
    if (techniquesOk) stableTechniques++
    else {
      gradeProblems.push(puzzle.id + ': techniques ' + JSON.stringify(results.map((r) => r.techniques)) + ' vs bank ' + JSON.stringify(puzzle.techniques))
    }
    if (solutionOk) stableSolution++
    else gradeProblems.push(puzzle.id + ': solution mismatch')

    // lib uniqueness + independent uniqueness + independent solution
    const libCount = countSolutions(givens, 2)
    if (libCount === 1) uniqueLib++
    else gradeProblems.push(puzzle.id + ': lib countSolutions=' + libCount)

    const independent = independentSolve(givens, 2)
    if (independent.count === 1) uniqueIndependent++
    else gradeProblems.push(puzzle.id + ': independent count=' + independent.count)
    if (independent.solution && gridToString(independent.solution) !== puzzle.solution) {
      gradeProblems.push(puzzle.id + ': independent solution != bank solution')
    }

    const solved = solve(givens)
    if (!solved || gridToString(solved) !== puzzle.solution) {
      gradeProblems.push(puzzle.id + ': solve() != bank solution')
    }
  }

  check('grade matches recorded grade 3/3 for every puzzle', stableGrade === bank.puzzles.length, stableGrade + '/' + bank.puzzles.length)
  check('techniques stable 3/3 and equal to bank for every puzzle', stableTechniques === bank.puzzles.length, stableTechniques + '/' + bank.puzzles.length)
  check('solution stable 3/3 and equal to bank for every puzzle', stableSolution === bank.puzzles.length, stableSolution + '/' + bank.puzzles.length)
  check('lib countSolutions(givens,2) === 1 for every puzzle', uniqueLib === bank.puzzles.length, uniqueLib + '/' + bank.puzzles.length)
  check('independent solver finds exactly 1 solution for every puzzle', uniqueIndependent === bank.puzzles.length, uniqueIndependent + '/' + bank.puzzles.length)
  check('no grading/uniqueness problems', gradeProblems.length === 0, gradeProblems.slice(0, 8).join(' | '))
  console.log(
    '  re-graded ' +
      bank.puzzles.length +
      ' puzzles x3 in ' +
      (Date.now() - regradeMs.start) +
      ' ms (grade stable ' +
      stableGrade +
      ', techniques stable ' +
      stableTechniques +
      ', solution stable ' +
      stableSolution +
      ')',
  )
}

// ---------------------------------------------------------------------------
// 4. 100 random unique-puzzle generation rate
// ---------------------------------------------------------------------------

function testRandomGeneration() {
  section('4. 100 random generated puzzles -> unique solution rate')
  const ROUNDS = 100
  let unique = 0
  let conflictFree = 0
  let consistent = 0
  const problems = []
  const startedAt = Date.now()
  for (let seed = 1; seed <= ROUNDS; seed++) {
    const rng = makeRng(seed * 7919 + 13)
    const full = generateFullGrid(rng)
    const dug = digPuzzle(full, rng)
    const givensText = gridToString(dug.givens)
    const independent = independentSolve(givensText, 2)
    const libCount = countSolutions(givensText, 2)
    if (independent.count === 1 && libCount === 1) unique++
    else problems.push('seed ' + seed + ': independent=' + independent.count + ' lib=' + libCount)

    if (independentConflictFree(givensText)) conflictFree++
    else problems.push('seed ' + seed + ': conflicting givens')

    // its own solution must be the recorded dig solution and a valid full grid
    const okSolution =
      independent.solution && isCompleteValidSolution(independent.solution) && gridToString(independent.solution) === gridToString(dug.solution)
    if (okSolution) consistent++
    else problems.push('seed ' + seed + ': solution mismatch/invalid')

    if (!isDigits(givensText, 81) || dug.clues < 17) problems.push('seed ' + seed + ': clue count ' + dug.clues)
  }
  check('100/100 random puzzles have exactly one solution', unique === 100, unique + '/100 (' + problems.slice(0, 5).join(' | ') + ')')
  check('100/100 random puzzles have conflict-free givens', conflictFree === 100, conflictFree + '/100')
  check('100/100 random puzzles are consistent with a valid solution', consistent === 100, consistent + '/100')
  console.log('  100 random generations + independent uniqueness checks in ' + (Date.now() - startedAt) + ' ms -> ' + unique + '/100 unique')
}

// ---------------------------------------------------------------------------
// 5. Technique coverage
// ---------------------------------------------------------------------------

function testCoverage(bank) {
  section('5. technique coverage')
  const coverage = Object.create(null)
  for (const level of LEVELS) {
    const row = Object.create(null)
    for (const name of TECHNIQUE_NAMES) row[name] = 0
    coverage[level.key] = row
  }
  for (const puzzle of bank.puzzles) {
    for (const name of puzzle.techniques) coverage[puzzle.grade][name]++
  }

  // Print the table (report can quote it directly).
  const header = 'grade  ' + TECHNIQUE_NAMES.map((name) => name.slice(0, 14).padStart(15)).join('')
  console.log(header)
  for (const level of LEVELS) {
    const row = coverage[level.key]
    const cells = TECHNIQUE_NAMES.map((name) => String(row[name]).padStart(15)).join('')
    console.log(level.key.padEnd(7) + cells)
  }

  const problems = []
  for (const level of LEVELS) {
    const puzzles = bank.puzzles.filter((puzzle) => puzzle.grade === level.key)
    const target = GRADE_LEVEL[level.key]
    for (const puzzle of puzzles) {
      const levels = puzzle.techniques.map((name) => TECHNIQUE_LEVEL[name] || 0)
      const maxLevel = levels.length ? Math.max(...levels) : 0
      if (level.key === 'hell') {
        // no technique cap; must be reported as stuck by the grader (checked below)
        continue
      }
      if (maxLevel !== target) problems.push(puzzle.id + ': max technique level ' + maxLevel + ' != ' + target)
      if (maxLevel > target) problems.push(puzzle.id + ': uses technique harder than its grade')
    }
  }
  check('no puzzle uses a technique level above its grade', problems.length === 0, problems.slice(0, 8).join(' | '))

  // Coverage assertions from spec §6.5.
  const easyPuzzles = bank.puzzles.filter((puzzle) => puzzle.grade === 'easy')
  check(
    'easy: every puzzle uses only singles and at least one single',
    easyPuzzles.every(
      (puzzle) =>
        puzzle.techniques.length > 0 && puzzle.techniques.every((name) => LEVEL1.has(name)),
    ),
    easyPuzzles
      .filter((puzzle) => !(puzzle.techniques.length > 0 && puzzle.techniques.every((name) => LEVEL1.has(name))))
      .map((puzzle) => puzzle.id)
      .slice(0, 5)
      .join(','),
  )
  const normalPuzzles = bank.puzzles.filter((puzzle) => puzzle.grade === 'normal')
  check(
    'normal: at least one puzzle needs pointing/claiming',
    normalPuzzles.some((puzzle) => puzzle.techniques.some((name) => LOCKED.has(name))),
  )
  check(
    'normal: every puzzle uses at least one locked-candidate technique',
    normalPuzzles.every((puzzle) => puzzle.techniques.some((name) => LOCKED.has(name))),
  )
  const hardPuzzles = bank.puzzles.filter((puzzle) => puzzle.grade === 'hard')
  check(
    'hard: at least one puzzle needs a pair/triple',
    hardPuzzles.some((puzzle) => puzzle.techniques.some((name) => PAIRS_TRIPLES.has(name))),
  )
  check(
    'hard: every puzzle uses at least one pair/triple',
    hardPuzzles.every((puzzle) => puzzle.techniques.some((name) => PAIRS_TRIPLES.has(name))),
  )
  const expertPuzzles = bank.puzzles.filter((puzzle) => puzzle.grade === 'expert')
  check(
    'expert: at least one puzzle needs x-wing/xy-wing',
    expertPuzzles.some((puzzle) => puzzle.techniques.some((name) => WINGS.has(name))),
  )
  check(
    'expert: every puzzle uses at least one wing',
    expertPuzzles.every((puzzle) => puzzle.techniques.some((name) => WINGS.has(name))),
  )

  // hell: every puzzle must still be stuck when graded, and at least one exists.
  let stuckCount = 0
  const hellProblems = []
  for (const puzzle of bank.puzzles.filter((p) => p.grade === 'hell')) {
    const graded = gradePuzzle(puzzle.givens)
    if (graded.stuck && graded.solved === false) stuckCount++
    else hellProblems.push(puzzle.id + ': not stuck (' + graded.grade + ')')
  }
  check('hell: at least one puzzle is technique-exhausted and stuck', stuckCount > 0)
  check('hell: every puzzle is stuck', hellProblems.length === 0, hellProblems.slice(0, 5).join(' | '))
  console.log('  hell puzzles stuck after exhausting every implemented technique: ' + stuckCount + '/' + (bank.puzzles.filter((p) => p.grade === 'hell').length))
}

// ---------------------------------------------------------------------------
// 6. Inline block consistency
// ---------------------------------------------------------------------------

function testInline(bank) {
  section('6. inline PUZZLE_BANK consistency')
  const loaded = loadInlineBank()
  if (loaded.missing) {
    check('client.js inline PUZZLE_BANK exists', false, loaded.missing)
    return
  }
  const inline = loaded.inline
  check('inline version === 2', inline && inline.version === 2)
  check('inline generatedAt === bank generatedAt', inline.generatedAt === bank.generatedAt, inline.generatedAt + ' vs ' + bank.generatedAt)
  check('inline levels === bank levels (key/label/level)', JSON.stringify(inline.levels) === JSON.stringify(bank.levels.map((level) => ({ key: level.key, label: level.label, level: level.level }))), JSON.stringify(inline.levels))
  check('inline puzzle count === bank puzzle count', Array.isArray(inline.puzzles) && inline.puzzles.length === bank.puzzles.length, (inline.puzzles ? inline.puzzles.length : 'n/a') + ' vs ' + bank.puzzles.length)
  if (Array.isArray(inline.puzzles)) {
    const problems = []
    const count = Math.min(inline.puzzles.length, bank.puzzles.length)
    for (let i = 0; i < count; i++) {
      const expected = bank.puzzles[i]
      const actual = inline.puzzles[i]
      if (!actual) {
        problems.push('index ' + i + ': missing')
        continue
      }
      if (actual.id !== expected.id) problems.push('index ' + i + ': id ' + actual.id + ' != ' + expected.id)
      if (actual.grade !== expected.grade) problems.push('index ' + i + ': grade mismatch ' + actual.id)
      if (actual.givens !== expected.givens) problems.push('index ' + i + ': givens mismatch ' + actual.id)
      if ('solution' in actual) problems.push('index ' + i + ': inline must not contain solution (' + actual.id + ')')
      if ('techniques' in actual) problems.push('index ' + i + ': inline must not contain techniques (' + actual.id + ')')
    }
    check('inline puzzles exactly match bank (id/grade/givens, order, no solutions)', problems.length === 0, problems.slice(0, 8).join(' | '))
  }
  console.log('  inline block bytes: ' + loaded.blockBytes + ' | client.js bytes: ' + Buffer.byteLength(loaded.source, 'utf8'))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('test-grade: bank=' + BANK_PATH)
  console.log('test-grade: client=' + CLIENT_PATH)
  const bank = loadBank()
  testStructure(bank)
  testGradingAndUniqueness(bank)
  testRandomGeneration()
  testCoverage(bank)
  testInline(bank)

  console.log('')
  if (failures.length) {
    console.log('FAIL ' + failCount + ' / PASS ' + passCount)
    for (const failure of failures.slice(0, 40)) console.log('  - ' + failure)
    if (failures.length > 40) console.log('  ... ' + (failures.length - 40) + ' more failures')
    process.exit(1)
  }
  console.log('PASS ' + passCount + ' / FAIL 0')
  process.exit(0)
}

main()
