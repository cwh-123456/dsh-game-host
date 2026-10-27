#!/usr/bin/env node
/**
 * gen-bank.mjs — OFFLINE sudoku puzzle-bank generator (api-spec-v2.md §5).
 *
 * `node dev/gen-bank.mjs`
 *
 *   easy   40
 *   normal 40
 *   hard   40
 *   expert 40
 *   hell   30   (190 puzzles total)
 *
 * Generation strategy per target grade (deterministic, seeded):
 *   1. makeRng(seed) -> generateFullGrid() -> shuffle 81 cells.
 *   2. Dig one cell at a time, keeping the solution unique
 *      (countSolutions(givens, 2) === 1) after every removal.
 *   3. After every successful removal re-grade the puzzle with the frozen
 *      technique grader (dev/lib/techniques.mjs, spec §1):
 *        - grade === target            -> remember this exact-grade state,
 *                                         keep digging for a deeper one;
 *        - grade easier than target    -> keep digging;
 *        - grade harder than target    -> restore the cell, stop this attempt,
 *                                         accept the deepest exact-grade state
 *                                         seen (or abandon when none matched);
 *      `hell` instead digs to exhaustion (no removal possible any more) and is
 *      accepted only when the final puzzle is graded `hell` (stuck).
 *   4. Per-puzzle verification before acceptance: unique solution, grade matches
 *      the target exactly, two gradings are identical (grade + techniques +
 *      solution), stored solution is the unique solution, givens conflict-free,
 *      id / givens unique.
 *
 * Output is written to a TEMP directory because node cannot write inside the
 * workspace in this sandbox (spec §5.3):
 *   <tmp>/bank.json          authoritative bank (with solutions + techniques)
 *   <tmp>/client.banked.js   copy of the workspace client.js with ONLY the
 *                            `/* ==== SUDOKU PUZZLE BANK: BEGIN ... *\/ END`
 *                            block replaced by the generated inline bank.
 *
 * Promote the artifacts (Lead / escalated copy):
 *   Copy-Item "<tmp>\bank.json"        "packages\dsh-game-sudoku\dev\bank.json" -Force
 *   Copy-Item "<tmp>\client.banked.js" "packages\dsh-game-sudoku\client.js"      -Force
 *
 * CLI / env:
 *   node dev/gen-bank.mjs                       generate + patch
 *   node dev/gen-bank.mjs --patch-only=<bank.json>   only rebuild client.banked.js
 *   env SUDOKU_BANK_SEED   base seed (default 20261018)
 *   env SUDOKU_BANK_OUT    output directory (default mkdtemp under os.tmpdir())
 *   env SUDOKU_MAX_ATTEMPTS_PER_GRADE  attempt cap (default 20000)
 *
 * Exit code 0 only when every quota is met and every verification passes.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  LEVELS,
  TECHNIQUE_LEVEL,
  makeRng,
  generateFullGrid,
  gradePuzzle,
  countSolutions,
  solve,
  computeConflicts,
  gridToString,
} from './lib/techniques.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.resolve(__dirname, '..', 'client.js')

const BASE_SEED = Number(process.env.SUDOKU_BANK_SEED || 20261018)
const MAX_ATTEMPTS_PER_GRADE = Math.max(1, Number(process.env.SUDOKU_MAX_ATTEMPTS_PER_GRADE || 20000))

const QUOTAS = Object.freeze({
  easy: 40,
  normal: 40,
  hard: 40,
  expert: 40,
  hell: 30,
})

const GRADE_LEVEL = Object.freeze({
  easy: 1,
  normal: 2,
  hard: 3,
  expert: 4,
  hell: 5,
})

const LEVEL_GRADE = Object.freeze(['invalid', 'easy', 'normal', 'hard', 'expert', 'hell'])

const TECHNIQUE_NAMES = Object.freeze(Object.keys(TECHNIQUE_LEVEL))

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fnv1a32(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function puzzleId(grade, givens) {
  return grade + '-' + fnv1a32(givens).toString(36)
}

function localIsoStamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    'T' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds()) +
    sign +
    pad(Math.floor(abs / 60)) +
    ':' +
    pad(abs % 60)
  )
}

function shufflePositions(rng) {
  const order = new Array(81)
  for (let i = 0; i < 81; i++) order[i] = i
  for (let k = 80; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1))
    const tmp = order[k]
    order[k] = order[j]
    order[j] = tmp
  }
  return order
}

function countClues(grid) {
  let clues = 0
  for (let i = 0; i < 81; i++) if (grid[i] !== 0) clues++
  return clues
}

function clueDistribution(cluesList) {
  const map = new Map()
  for (const clues of cluesList) map.set(clues, (map.get(clues) || 0) + 1)
  return Array.from(map.entries()).sort((a, b) => a[0] - b[0])
}

function stats(values) {
  if (!values.length) return { min: 0, median: 0, mean: 0, max: 0 }
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  return { min: sorted[0], median, mean: Math.round(mean * 10) / 10, max: sorted[sorted.length - 1] }
}

function describeClues(cluesList) {
  const parts = clueDistribution(cluesList).map(([clues, count]) => clues + ':' + count)
  return parts.length ? parts.join(' ') : '-'
}

// ---------------------------------------------------------------------------
// Bank building
// ---------------------------------------------------------------------------

const acceptedByGrade = Object.create(null)
for (const level of LEVELS) acceptedByGrade[level.key] = []

const seenIds = new Set()
const seenGivens = new Set()

const statsByGrade = Object.create(null)
for (const level of LEVELS) statsByGrade[level.key] = { attempts: 0, accepts: 0, ms: 0 }

/**
 * Fully verify one candidate puzzle and, if it is exactly right, add it to the
 * bank. `triedGivens`/`triedTechniques` come from the dig loop; the authoritative
 * values are recomputed here from scratch.
 */
function tryAccept(grade, givens, provenance) {
  const givensStr = gridToString(givens)
  const id = puzzleId(grade, givensStr)
  if (seenIds.has(id)) return { ok: false, reason: 'duplicate-id' }
  if (seenGivens.has(givensStr)) return { ok: false, reason: 'duplicate-givens' }
  if (countSolutions(givensStr, 2) !== 1) return { ok: false, reason: 'not-unique' }
  if (computeConflicts(givens).some((v) => v !== 0)) return { ok: false, reason: 'conflicting-givens' }

  const first = gradePuzzle(givensStr)
  if (first.grade !== grade) return { ok: false, reason: 'grade-' + first.grade }
  const second = gradePuzzle(givensStr)
  if (second.grade !== grade) return { ok: false, reason: 'regrade-' + second.grade }
  if (JSON.stringify(first.techniques) !== JSON.stringify(second.techniques)) {
    return { ok: false, reason: 'unstable-techniques' }
  }
  if (!first.solution || !second.solution) return { ok: false, reason: 'no-solution' }
  if (gridToString(first.solution) !== gridToString(second.solution)) {
    return { ok: false, reason: 'unstable-solution' }
  }

  const solved = solve(givensStr)
  if (!solved) return { ok: false, reason: 'solve-null' }
  const solutionStr = gridToString(solved)
  if (solutionStr !== gridToString(first.solution)) return { ok: false, reason: 'solution-mismatch' }
  if (computeConflicts(solved).some((v) => v !== 0)) return { ok: false, reason: 'invalid-solution' }
  for (let i = 0; i < 81; i++) {
    if (givens[i] !== 0 && givens[i] !== solved[i]) return { ok: false, reason: 'givens-inconsistent' }
  }

  // Grade semantics: highest used technique level must match the target.
  if (grade === 'hell') {
    if (!first.stuck) return { ok: false, reason: 'hell-not-stuck' }
  } else {
    const targetLevel = GRADE_LEVEL[grade]
    let maxLevel = 0
    for (const name of first.techniques) {
      const level = TECHNIQUE_LEVEL[name]
      if (!level) return { ok: false, reason: 'unknown-technique-' + name }
      if (level > maxLevel) maxLevel = level
    }
    if (maxLevel === 0) maxLevel = 1 // complete givens: solved without techniques
    if (maxLevel !== targetLevel) return { ok: false, reason: 'technique-level-' + maxLevel }
    if (first.solved !== true) return { ok: false, reason: 'not-solved' }
  }

  const clues = countClues(givens)
  acceptedByGrade[grade].push({
    id,
    grade,
    givens: givensStr,
    solution: solutionStr,
    clues,
    techniques: first.techniques.slice(),
    provenance,
  })
  seenIds.add(id)
  seenGivens.add(givensStr)
  return { ok: true }
}

function buildOneGrade(grade, rng) {
  const quota = QUOTAS[grade]
  const targetLevel = GRADE_LEVEL[grade]
  const stats = statsByGrade[grade]
  const startedAt = Date.now()
  const maxAttempts = MAX_ATTEMPTS_PER_GRADE
  const deadlines = { dig: 0, graded: 0 }
  let accepts = 0

  while (accepts < quota && stats.attempts < maxAttempts) {
    stats.attempts++
    const full = generateFullGrid(rng)
    const solution = full.slice()
    const grid = full.slice()
    const order = shufflePositions(rng)

    if (grade === 'hell') {
      // §5: dig to exhaustion, accept only a stuck ("hell") puzzle.
      for (let pass = 0; pass < 16; pass++) {
        let removedThisPass = 0
        for (let k = 0; k < order.length; k++) {
          const pos = order[k]
          if (grid[pos] === 0) continue
          const saved = grid[pos]
          grid[pos] = 0
          if (countSolutions(grid, 2) === 1) {
            removedThisPass++
          } else {
            grid[pos] = saved
          }
        }
        if (removedThisPass === 0) break
      }
      const graded = gradePuzzle(grid, { skipUniqueness: true })
      if (graded.grade !== 'hell') continue
      const result = tryAccept(grade, grid, 'max-dig')
      if (result.ok) accepts++
      continue
    }

    // Non-hell target: incremental dig, remember the deepest exact-grade state.
    let lastGood = null
    let exceeded = false
    for (let pass = 0; pass < 16 && !exceeded; pass++) {
      let removedThisPass = 0
      for (let k = 0; k < order.length; k++) {
        const pos = order[k]
        if (grid[pos] === 0) continue
        const saved = grid[pos]
        grid[pos] = 0
        if (countSolutions(grid, 2) !== 1) {
          grid[pos] = saved
          continue
        }
        const graded = gradePuzzle(grid, { skipUniqueness: true })
        const level = graded.grade === 'invalid' ? 99 : GRADE_LEVEL[graded.grade]
        if (level > targetLevel) {
          grid[pos] = saved
          exceeded = true
          break
        }
        removedThisPass++
        if (level === targetLevel) lastGood = grid.slice()
      }
      if (removedThisPass === 0) break
    }
    if (!lastGood) continue
    const result = tryAccept(grade, lastGood, 'incremental-dig')
    if (result.ok) accepts++
    else {
      // A verification failure means either a grader bug or (extremely rarely)
      // a duplicate; keep digging instead of aborting the whole run.
      deadlines.graded++
      if (deadlines.graded > 200) {
        throw new Error('gen-bank: more than 200 accepted candidates failed final verification for ' + grade)
      }
    }
  }

  stats.accepts = accepts
  stats.ms = Date.now() - startedAt
  return accepts
}

// ---------------------------------------------------------------------------
// Inline bank block + client.js patching (only the marker block is touched)
// ---------------------------------------------------------------------------

const BANK_BEGIN = 'SUDOKU PUZZLE BANK: BEGIN'
const BANK_END = 'SUDOKU PUZZLE BANK: END'

function buildInlineBlock(puzzles, generatedAt) {
  const lines = []
  lines.push('/* ==== SUDOKU PUZZLE BANK: BEGIN (generated by dev/gen-bank.mjs, do not edit) ==== */')
  lines.push('const PUZZLE_BANK = {')
  lines.push('  version: 2,')
  lines.push("  generatedAt: '" + generatedAt + "',")
  lines.push('  levels: [')
  for (const level of LEVELS) {
    lines.push("    { key: '" + level.key + "', label: '" + level.label + "', level: " + level.level + ' },')
  }
  lines.push('  ],')
  lines.push('  puzzles: [')
  for (const puzzle of puzzles) {
    lines.push(
      "    { id: '" + puzzle.id + "', grade: '" + puzzle.grade + "', givens: '" + puzzle.givens + "' },",
    )
  }
  lines.push('  ],')
  lines.push('}')
  lines.push('/* ==== SUDOKU PUZZLE BANK: END ==== */')
  return lines.join('\n')
}

/**
 * Replace ONLY the marker block (inclusive) in `source`.
 * Returns null when the markers are missing.
 */
function patchClientSource(source, blockUnindented) {
  const lines = source.split('\n')
  const begin = lines.findIndex((line) => line.includes(BANK_BEGIN))
  if (begin === -1) return null
  let end = -1
  for (let i = begin; i < lines.length; i++) {
    if (lines[i].includes(BANK_END)) {
      end = i
      break
    }
  }
  if (end === -1) return null
  const indentMatch = /^[ \t]*/.exec(lines[begin])
  const indent = indentMatch ? indentMatch[0] : ''
  const blockLines = blockUnindented.split('\n').map((line) => (line.length ? indent + line : line))
  const out = lines.slice(0, begin).concat(blockLines, lines.slice(end + 1))
  return out.join('\n')
}

function verifyPatchedClient(patchedSource, puzzles, label) {
  // 1. Whole client still parses as a classic script body.
  try {
    // eslint-disable-next-line no-new-func
    new Function(patchedSource)
  } catch (error) {
    throw new Error('client.banked.js does not parse: ' + error.message)
  }
  // 2. Extract the inline block and evaluate it; must equal the authoritative bank.
  const lines = patchedSource.split('\n')
  const begin = lines.findIndex((line) => line.includes(BANK_BEGIN))
  const end = lines.findIndex((line, index) => index >= begin && line.includes(BANK_END))
  if (begin === -1 || end === -1) throw new Error('patched client lost the BANK markers')
  const block = lines.slice(begin + 1, end).join('\n')
  const inline = new Function(block + '\nreturn PUZZLE_BANK')()
  if (!inline || inline.version !== 2) throw new Error('inline PUZZLE_BANK missing/version mismatch')
  if (!Array.isArray(inline.levels) || inline.levels.length !== LEVELS.length) {
    throw new Error('inline levels length mismatch')
  }
  for (let i = 0; i < LEVELS.length; i++) {
    const expected = LEVELS[i]
    const actual = inline.levels[i]
    if (!actual || actual.key !== expected.key || actual.label !== expected.label || actual.level !== expected.level) {
      throw new Error('inline level mismatch at ' + i)
    }
  }
  if (!Array.isArray(inline.puzzles) || inline.puzzles.length !== puzzles.length) {
    throw new Error('inline puzzle count mismatch')
  }
  for (let i = 0; i < puzzles.length; i++) {
    const expected = puzzles[i]
    const actual = inline.puzzles[i]
    if (!actual || actual.id !== expected.id || actual.grade !== expected.grade || actual.givens !== expected.givens) {
      throw new Error('inline puzzle mismatch at index ' + i + ' (' + expected.id + ')')
    }
    if ('solution' in actual || 'techniques' in actual) {
      throw new Error('inline puzzle must not contain solution/techniques (' + expected.id + ')')
    }
  }
  console.log('[gen-bank] inline verification OK (' + label + '): ' + puzzles.length + ' puzzles, 5 levels')
}

function buildClientBanked(bank, puzzles, generatedAt) {
  if (!fs.existsSync(CLIENT_PATH)) {
    console.log('[gen-bank] client.js not found: ' + CLIENT_PATH)
    return null
  }
  // Re-read the client at the very end so the patch is based on the freshest copy.
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  if (!source.includes(BANK_BEGIN) || !source.includes(BANK_END)) {
    console.log('[gen-bank] client.js has no SUDOKU PUZZLE BANK markers -> client.banked.js skipped')
    return null
  }
  const block = buildInlineBlock(puzzles, generatedAt)
  const patched = patchClientSource(source, block)
  if (!patched) throw new Error('gen-bank: failed to patch the marker block in client.js')
  verifyPatchedClient(patched, puzzles, 'client.js')
  return { patched, block }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function resolveOutDir() {
  const fromEnv = process.env.SUDOKU_BANK_OUT
  if (fromEnv) {
    const dir = path.resolve(fromEnv)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sudoku-bank-'))
}

function writeOutputs(outDir, bankJson, clientBanked) {
  const bankPath = path.join(outDir, 'bank.json')
  fs.writeFileSync(bankPath, bankJson, 'utf8')
  console.log('[gen-bank] wrote ' + bankPath + ' (' + Buffer.byteLength(bankJson, 'utf8') + ' bytes)')
  let clientPath = null
  if (clientBanked) {
    clientPath = path.join(outDir, 'client.banked.js')
    fs.writeFileSync(clientPath, clientBanked.patched, 'utf8')
    console.log('[gen-bank] wrote ' + clientPath + ' (' + Buffer.byteLength(clientBanked.patched, 'utf8') + ' bytes)')
    console.log(
      '[gen-bank] inline block: ' + Buffer.byteLength(clientBanked.block, 'utf8') + ' bytes (without indentation)',
    )
  }
  return { bankPath, clientPath }
}

// ---------------------------------------------------------------------------
// --patch-only: rebuild client.banked.js from an existing bank.json
// ---------------------------------------------------------------------------

function patchOnlyMode(bankJsonPath) {
  const bank = JSON.parse(fs.readFileSync(bankJsonPath, 'utf8'))
  const puzzles = bank.puzzles.map((p) => ({ id: p.id, grade: p.grade, givens: p.givens }))
  const built = buildClientBanked(bank, puzzles, bank.generatedAt)
  if (!built) {
    console.error('[gen-bank] patch-only failed: client.js markers missing')
    process.exit(2)
  }
  const outDir = resolveOutDir()
  const paths = writeOutputs(outDir, JSON.stringify(bank, null, 2) + '\n', built)
  console.log('[gen-bank] patch-only temp dir: ' + outDir)
  console.log('[gen-bank] patch-only promoted candidate: ' + paths.clientPath)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const patchArg = process.argv.find((arg) => arg.startsWith('--patch-only='))
  if (patchArg) {
    patchOnlyMode(patchArg.slice('--patch-only='.length))
    return
  }

  const wallStart = Date.now()
  console.log('[gen-bank] seed=' + BASE_SEED + ' quotas=' + JSON.stringify(QUOTAS))
  console.log('[gen-bank] technique grader: dev/lib/techniques.mjs (frozen order §1)')

  const rng = makeRng(BASE_SEED)
  let totalAttempts = 0
  for (const level of LEVELS) {
    const accepted = buildOneGrade(level.key, rng)
    const gradeStats = statsByGrade[level.key]
    totalAttempts += gradeStats.attempts
    const clues = acceptedByGrade[level.key].map((puzzle) => puzzle.clues)
    const range = stats(clues)
    console.log(
      '[gen-bank] ' +
        level.key.padEnd(7) +
        ' attempts=' +
        String(gradeStats.attempts).padStart(5) +
        ' accepts=' +
        String(accepted).padStart(3) +
        '/' +
        QUOTAS[level.key] +
        ' ms=' +
        String(gradeStats.ms).padStart(6) +
        ' clues min/median/mean/max=' +
        range.min +
        '/' +
        range.median +
        '/' +
        range.mean +
        '/' +
        range.max +
        ' dist=' +
        describeClues(clues),
    )
    if (accepted < QUOTAS[level.key]) {
      console.error(
        '[gen-bank] FAIL quota not reached for ' +
          level.key +
          ': ' +
          accepted +
          '/' +
          QUOTAS[level.key] +
          ' after ' +
          gradeStats.attempts +
          ' attempts (cap ' +
          MAX_ATTEMPTS_PER_GRADE +
          ')',
      )
      process.exit(1)
    }
  }

  // Merge, sort (level order, id ascending) and build the authoritative bank.
  const puzzles = []
  for (const level of LEVELS) {
    const gradePuzzles = acceptedByGrade[level.key].slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const puzzle of gradePuzzles) {
      puzzles.push({
        id: puzzle.id,
        grade: puzzle.grade,
        givens: puzzle.givens,
        solution: puzzle.solution,
        clues: puzzle.clues,
        techniques: puzzle.techniques,
      })
    }
  }

  const generatedAt = localIsoStamp(new Date())
  const genMs = Date.now() - wallStart
  const bank = {
    version: 2,
    generatedAt,
    generator: { seed: BASE_SEED, attempts: totalAttempts, genMs },
    levels: LEVELS.map((level) => ({
      key: level.key,
      label: level.label,
      level: level.level,
      count: acceptedByGrade[level.key].length,
    })),
    puzzles,
  }
  const bankJson = JSON.stringify(bank, null, 2) + '\n'

  // Global re-verification of the final artifact (fresh gradePuzzle calls).
  let verified = 0
  const verifyStart = Date.now()
  for (const puzzle of puzzles) {
    if (countSolutions(puzzle.givens, 2) !== 1) throw new Error('final verify: not unique ' + puzzle.id)
    const first = gradePuzzle(puzzle.givens)
    const second = gradePuzzle(puzzle.givens)
    if (first.grade !== puzzle.grade || second.grade !== puzzle.grade) {
      throw new Error('final verify: grade mismatch ' + puzzle.id)
    }
    if (JSON.stringify(first.techniques) !== JSON.stringify(puzzle.techniques)) {
      throw new Error('final verify: techniques mismatch ' + puzzle.id)
    }
    if (JSON.stringify(first.techniques) !== JSON.stringify(second.techniques)) {
      throw new Error('final verify: unstable techniques ' + puzzle.id)
    }
    if (!first.solution || gridToString(first.solution) !== puzzle.solution) {
      throw new Error('final verify: solution mismatch ' + puzzle.id)
    }
    if (computeConflicts(puzzle.solution).some((v) => v !== 0)) {
      throw new Error('final verify: bad solution ' + puzzle.id)
    }
    verified++
  }
  console.log(
    '[gen-bank] final verification: ' +
      verified +
      '/' +
      puzzles.length +
      ' puzzles unique+solution+2x stable grade/techniques OK (' +
      (Date.now() - verifyStart) +
      ' ms)',
  )

  const built = buildClientBanked(bank, puzzles, generatedAt)

  // Unique temp dir for the artifacts.
  const outDir = resolveOutDir()
  const paths = writeOutputs(outDir, bankJson, built)
  const wallMs = Date.now() - wallStart
  console.log('[gen-bank] total generation wall time: ' + wallMs + ' ms (genMs recorded in bank: ' + genMs + ' ms)')
  console.log('[gen-bank] temp dir: ' + outDir)
  console.log('[gen-bank] bank path: ' + paths.bankPath)
  if (paths.clientPath) console.log('[gen-bank] client candidate path: ' + paths.clientPath)
  console.log('[gen-bank] DONE')
}

main()
