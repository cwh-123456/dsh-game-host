/**
 * v2 audit 1/4 — offline bank structure, per-puzzle uniqueness/solution, inline
 * block equality with dev/bank.json and "no runtime generator/solver" review.
 *
 * Run: node dev/audit/v2/audit-v2-bank.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  ALL_TECHNIQUES,
  countNonZero,
  countSolutions,
  gradePuzzle,
  gridToString,
  parseGivens,
  puzzleId,
  refConsistent,
  refIsValidSolution,
  solve,
} from './oracle.mjs'
import {
  BANK_BEGIN,
  BANK_END,
  GRADE_KEYS,
  GRADE_LABELS,
  GRADE_LEVEL,
  bankCounts,
  bankIndex,
  checkOutsideBaseline,
  clientHasBankMarker,
  extractInlineBankBlock,
  loadV2Client,
  readBank,
  readClientCode,
  waitFor,
} from './common.mjs'
import { createRunner, must } from '../harness.mjs'

const runner = createRunner('v2 bank audit')
const EVIDENCE = {}

// ---------------------------------------------------------------------------
// artifact readiness
// ---------------------------------------------------------------------------
const bankRead = readBank()
const clientExists = existsSync(new URL('../../../client.js', import.meta.url))
const missing = []
if (!bankRead) missing.push('dev/bank.json')
if (!clientExists) missing.push('client.js')
else if (!clientHasBankMarker(readClientCode())) missing.push('client.js inline BANK marker block (v1 client still present?)')
waitFor('v2 artifacts not ready', missing)

const code = readClientCode()
const { bank, text: bankText, bytes: bankBytes } = bankRead
let loaded = null
try {
  loaded = await loadV2Client('v2-bank')
} catch (error) {
  waitFor('v2 client seam could not load: ' + error.message, ['working v2 client.js'])
}
const api = loaded.api
if (!api.BANK) waitFor('v2 client seam', ['window.__DSH_GAME_SUDOKU__.BANK'])
if (!Array.isArray(api.BANK.puzzles) || api.BANK.puzzles.length === 0) {
  waitFor('v2 client seam not populated yet', ['client.js inline BANK with puzzles (bank not promoted yet)'])
}
const inline = extractInlineBankBlock(code)

// ---------------------------------------------------------------------------
// 1. top-level bank structure (api-spec-v2 §2)
// ---------------------------------------------------------------------------
runner.check('bank.json top-level structure and level table are valid', () => {
  must(bank && typeof bank === 'object' && !Array.isArray(bank), 'bank must be an object')
  must(bank.version === 2, 'bank.version must be 2')
  must(typeof bank.generatedAt === 'string' && !Number.isNaN(Date.parse(bank.generatedAt)), 'generatedAt must be an ISO timestamp')
  must(bank.generator && typeof bank.generator === 'object', 'generator metadata missing')
  must(Number.isInteger(bank.generator.seed), 'generator.seed must be an integer')
  must(Number.isInteger(bank.generator.attempts) && bank.generator.attempts >= 0, 'generator.attempts')
  must(typeof bank.generator.genMs === 'number' && bank.generator.genMs >= 0, 'generator.genMs')
  must(Array.isArray(bank.levels) && bank.levels.length === 5, 'levels must have 5 entries')
  bank.levels.forEach((level, index) => {
    const key = GRADE_KEYS[index]
    must(level && typeof level === 'object', 'levels[' + index + '] must be an object')
    must(level.key === key, 'levels[' + index + '].key must be ' + key)
    must(level.label === GRADE_LABELS[key], 'levels[' + index + '].label must be ' + GRADE_LABELS[key])
    must(level.level === GRADE_LEVEL[key], 'levels[' + index + '].level must be ' + GRADE_LEVEL[key])
    must(Number.isInteger(level.count) && level.count >= 30 && level.count <= 50, 'levels[' + index + '].count must be 30..50')
  })
  must(Array.isArray(bank.puzzles), 'bank.puzzles must be an array')
  const counts = bankCounts(bank)
  for (const level of bank.levels) {
    must(counts[level.key] === level.count, 'level ' + level.key + ' count=' + level.count + ' but found ' + (counts[level.key] || 0))
  }
  must(bank.puzzles.length === countsTotal(counts), 'puzzles total mismatch')
})

function countsTotal(counts) {
  return Object.values(counts).reduce((total, value) => total + value, 0)
}

// ---------------------------------------------------------------------------
// 2. puzzle fields, ids and content uniqueness
// ---------------------------------------------------------------------------
runner.check('every puzzle record has valid fields and a deterministic id', () => {
  const ids = new Set()
  for (const puzzle of bank.puzzles) {
    const label = 'puzzle ' + String(puzzle && puzzle.id)
    must(puzzle && typeof puzzle === 'object', 'puzzle must be an object')
    must(typeof puzzle.id === 'string' && puzzle.id.length > 3, label + ': id')
    must(GRADE_KEYS.indexOf(puzzle.grade) !== -1, label + ': grade ' + String(puzzle.grade))
    must(puzzle.id.startsWith(puzzle.grade + '-'), label + ': id must start with "<grade>-"')
    must(!ids.has(puzzle.id), label + ': duplicate id')
    ids.add(puzzle.id)
    must(typeof puzzle.givens === 'string' && puzzle.givens.length === 81, label + ': givens must be an 81-char string')
    must(/^[0-9]{81}$/.test(puzzle.givens), label + ': givens must only contain 0-9')
    must(typeof puzzle.solution === 'string' && puzzle.solution.length === 81, label + ': solution must be an 81-char string')
    must(/^[1-9]{81}$/.test(puzzle.solution), label + ': solution must only contain 1-9')
    must(Number.isInteger(puzzle.clues), label + ': clues must be an integer')
    must(Array.isArray(puzzle.techniques), label + ': techniques must be an array')
    const uniqueTechniques = new Set(puzzle.techniques)
    must(uniqueTechniques.size === puzzle.techniques.length, label + ': techniques must not repeat')
    for (const technique of puzzle.techniques) {
      must(ALL_TECHNIQUES.indexOf(technique) !== -1, label + ': unknown technique ' + String(technique))
    }
    must(puzzleId(puzzle.grade, puzzle.givens) === puzzle.id, label + ': id must equal grade + fnv1a32(givens) base36')
  }
})

runner.check('givens are conflict-free and clue counts are consistent', () => {
  const perGrade = new Map(GRADE_KEYS.map((grade) => [grade, new Set()]))
  for (const puzzle of bank.puzzles) {
    const label = puzzle.id
    const grid = parseGivens(puzzle.givens) // throws on invalid shape/conflicts
    const clues = countNonZero(grid)
    must(clues === puzzle.clues, label + ': clues=' + puzzle.clues + ' but non-zero givens=' + clues)
    must(clues >= 17, label + ': at least 17 clues expected')
    must(perGrade.get(puzzle.grade).has(gridToString(grid)) === false, label + ': duplicate board inside grade ' + puzzle.grade)
    perGrade.get(puzzle.grade).add(gridToString(grid))
  }
})

// ---------------------------------------------------------------------------
// 3. independent uniqueness + solution validation for EVERY puzzle
// ---------------------------------------------------------------------------
runner.check('every bank puzzle has exactly one solution and a correct stored solution (independent solver)', () => {
  let checked = 0
  for (const puzzle of bank.puzzles) {
    const label = puzzle.id
    const givens = parseGivens(puzzle.givens)
    must(countSolutions(givens, 2) === 1, label + ': independent solver must find exactly 1 solution')
    const solution = parseGivens(puzzle.solution)
    must(refIsValidSolution(solution), label + ': stored solution is not a legal complete grid')
    must(refConsistent(givens, solution), label + ': stored solution is inconsistent with the givens')
    const oracleSolution = solve(givens)
    must(oracleSolution !== null, label + ': oracle solve returned null')
    must(gridToString(oracleSolution) === puzzle.solution, label + ': stored solution differs from the independent solver')
    checked += 1
  }
  EVIDENCE.puzzlesUniquenessChecked = checked
})

// ---------------------------------------------------------------------------
// 4. inline block in client.js must match dev/bank.json exactly
// ---------------------------------------------------------------------------
runner.check('client.js contains exactly one generated BANK marker block', () => {
  const begins = code.split(BANK_BEGIN).length - 1
  const ends = code.split(BANK_END).length - 1
  must(begins === 1, 'expected exactly one BEGIN marker, found ' + begins)
  must(ends === 1, 'expected exactly one END marker, found ' + ends)
  must(inline.found, 'inline block not found')
  const inside = code.slice(inline.begin, inline.end)
  must(/const\s+PUZZLE_BANK\s*=/.test(inside), 'const PUZZLE_BANK must live inside the marker block')
  EVIDENCE.inlineBeginLine = inline.beginLine
  EVIDENCE.inlineEndLine = inline.endLine
  EVIDENCE.inlineBlockBytes = Buffer.byteLength(inline.blockText, 'utf8')
})

runner.check('seam BANK equals dev/bank.json (version/generatedAt/levels/index order/id/grade/givens)', () => {
  const runtime = api.BANK
  must(runtime && typeof runtime === 'object', 'seam BANK must be an object')
  must(runtime.version === bank.version, 'inline version must equal bank version')
  must(runtime.generatedAt === bank.generatedAt, 'inline generatedAt must equal bank.generatedAt')
  must(Array.isArray(runtime.levels) && runtime.levels.length === bank.levels.length, 'inline levels length')
  runtime.levels.forEach((level, index) => {
    const expected = bank.levels[index]
    must(level.key === expected.key, 'inline levels[' + index + '].key')
    must(level.label === expected.label, 'inline levels[' + index + '].label')
    must(level.level === expected.level, 'inline levels[' + index + '].level')
  })
  must(Array.isArray(runtime.puzzles), 'inline puzzles must be an array')
  must(runtime.puzzles.length === bank.puzzles.length, 'inline puzzle count ' + runtime.puzzles.length + ' != bank ' + bank.puzzles.length)
  for (let index = 0; index < bank.puzzles.length; index += 1) {
    const inlinePuzzle = runtime.puzzles[index]
    const bankPuzzle = bank.puzzles[index]
    must(inlinePuzzle.id === bankPuzzle.id, 'inline puzzle #' + index + ' id mismatch')
    must(inlinePuzzle.grade === bankPuzzle.grade, 'inline puzzle #' + index + ' grade mismatch')
    must(inlinePuzzle.givens === bankPuzzle.givens, 'inline puzzle #' + index + ' givens mismatch (' + inlinePuzzle.id + ')')
    const keys = Object.keys(inlinePuzzle).sort()
    must(keys.join(',') === 'givens,grade,id', 'inline puzzle #' + index + ' may only expose id/grade/givens, got ' + keys.join(','))
  }
})

runner.check('inline puzzles are grouped by level order and sorted by id inside each grade', () => {
  const runtime = api.BANK
  let previousGradeIndex = -1
  let previousId = null
  for (const puzzle of runtime.puzzles) {
    const gradeIndex = GRADE_KEYS.indexOf(puzzle.grade)
    must(gradeIndex !== -1, 'inline puzzle has invalid grade ' + puzzle.grade)
    must(gradeIndex >= previousGradeIndex, 'inline puzzles must be grouped in levels order')
    if (gradeIndex === previousGradeIndex) {
      must(previousId === null || previousId < puzzle.id, 'inline puzzles inside a grade must be sorted by id (' + previousId + ' -> ' + puzzle.id + ')')
    } else {
      previousGradeIndex = gradeIndex
    }
    previousId = puzzle.id
  }
})

runner.check('inline block contains no solution/techniques/clues dev-only data', () => {
  must(!/\bsolution\s*:/.test(inline.blockText), 'inline block must not carry solutions')
  must(!/\btechniques\s*:/.test(inline.blockText), 'inline block must not carry techniques')
  must(!/\bclues\s*:/.test(inline.blockText), 'inline block must not carry clue counts')
  // Same check against the runtime object, not just the text.
  for (const puzzle of api.BANK.puzzles) {
    must(!('solution' in puzzle), 'runtime puzzle must not expose solution')
    must(!('techniques' in puzzle), 'runtime puzzle must not expose techniques')
    must(!('clues' in puzzle), 'runtime puzzle must not expose clues')
  }
})

// ---------------------------------------------------------------------------
// 5. no runtime generator / solver (api-spec-v2 §7 + §9)
// ---------------------------------------------------------------------------
runner.check('client.js has no runtime generator or solver implementation', () => {
  const forbidden = [
    ['generatePuzzle', /\bgeneratePuzzle\b/],
    ['generateFullGrid', /\bgenerateFullGrid\b/],
    ['countSolutions', /\bcountSolutions\b/],
    ['searchSolutions', /\bsearchSolutions\b/],
    ['gradePuzzle', /\bgradePuzzle\b/],
    ['backtracking', /\bbacktrack(?:ing)?\b/i],
    ['swordfish/chains solver', /\bswordfish\b|\bxychain\b|\bcoloring\b/i],
  ]
  const hits = []
  for (const [label, pattern] of forbidden) {
    const match = pattern.exec(code)
    if (match) hits.push(label + '@line' + code.slice(0, match.index).split('\n').length)
  }
  must(hits.length === 0, 'forbidden runtime algorithm identifiers: ' + hits.join(', '))
  must(!/function\s+solve\s*\(/.test(code), 'runtime must not define solve()')
  for (const name of ['generatePuzzle', 'generateFullGrid', 'countSolutions', 'solve', 'gradePuzzle']) {
    must(typeof api[name] === 'undefined', 'seam must not export ' + name)
  }
})

runner.check('pickPuzzle only draws from the inline BANK (static review)', () => {
  const match = /function\s+pickPuzzle\s*\([^)]*\)\s*\{([\s\S]{0,1600})/.exec(code)
  must(match !== null, 'pickPuzzle implementation not found')
  const body = match[1]
  // The runtime may draw from startup indexes built from PUZZLE_BANK
  // (PUZZLES_BY_GRADE / ALL_PUZZLES / PUZZLE_BY_ID) instead of the literal.
  must(
    /PUZZLES_BY_GRADE|ALL_PUZZLES|PUZZLE_BY_ID|PUZZLE_BANK|BANK\b/.test(body),
    'pickPuzzle must draw from the bank-backed indexes',
  )
  must(/PUZZLE_BANK/.test(code), 'runtime bank indexes must be built from PUZZLE_BANK')
  must(!/generate|solve|countSolutions/i.test(body), 'pickPuzzle must not generate or solve')
  EVIDENCE.pickPuzzleLine = code.slice(0, match.index).split('\n').length
})

// ---------------------------------------------------------------------------
// 6. repo integrity + stats
// ---------------------------------------------------------------------------
runner.check('no file outside packages/dsh-game-sudoku was modified', () => {
  const result = checkOutsideBaseline(createHash)
  must(result.changed.length === 0, 'modified files outside the package: ' + result.changed.join(', '))
  must(result.missing.length === 0, 'disappeared files outside the package: ' + result.missing.join(', '))
  EVIDENCE.outsidePackageFilesChecked = result.checked
})

runner.check('bank statistics are recorded (clues, techniques, sizes)', () => {
  const byGrade = {}
  for (const grade of GRADE_KEYS) {
    const puzzles = bank.puzzles.filter((puzzle) => puzzle.grade === grade)
    const clues = puzzles.map((puzzle) => puzzle.clues)
    byGrade[grade] = {
      count: puzzles.length,
      clues: {
        min: Math.min(...clues),
        max: Math.max(...clues),
        mean: Number((clues.reduce((total, value) => total + value, 0) / clues.length).toFixed(2)),
      },
    }
  }
  const techniqueFrequency = {}
  for (const puzzle of bank.puzzles) {
    for (const technique of puzzle.techniques) techniqueFrequency[technique] = (techniqueFrequency[technique] || 0) + 1
  }
  EVIDENCE.bank = {
    summary: {
      version: bank.version,
      generatedAt: bank.generatedAt,
      generator: bank.generator,
      total: bank.puzzles.length,
      byGrade,
    },
    techniqueFrequency,
    bankBytes,
    inlineBlockBytes: Buffer.byteLength(inline.blockText, 'utf8'),
    clientBytes: Buffer.byteLength(code, 'utf8'),
    clientLines: code.split('\n').length,
  }
  must(bankBytes < 200 * 1024, 'bank.json unexpectedly large')
  must(Buffer.byteLength(code, 'utf8') < 250 * 1024, 'client.js unexpectedly large')
})

const summary = runner.summary()
for (const [key, value] of Object.entries(EVIDENCE)) {
  if (value !== undefined) console.log('EVIDENCE ' + key + ' ' + JSON.stringify(value))
}
console.log('RESULT v2 bank ' + JSON.stringify(summary))
