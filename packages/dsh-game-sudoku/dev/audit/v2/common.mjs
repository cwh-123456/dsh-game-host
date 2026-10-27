/**
 * Shared helpers for the v2 independent audit (verifier-owned).
 *
 * Loads the v2 client seam through ../harness.mjs (verifier-owned window stub),
 * reads dev/bank.json, extracts the inline PUZZLE_BANK marker block and provides
 * the invariant oracle for accepted v2 saves.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadClient, requireClient } from '../harness.mjs'
import {
  LEVEL_BY_GRADE,
  LEVELS,
  countSolutions,
  gridToString,
  parseGivens,
  refConsistent,
  refIsSolved,
  refIsValidSolution,
} from './oracle.mjs'

export const PACKAGE_DIR = fileURLToPath(new URL('../../../', import.meta.url))
export const BANK_FILE = join(PACKAGE_DIR, 'dev', 'bank.json')
export const CLIENT_FILE = join(PACKAGE_DIR, 'client.js')
export const WORKSPACE_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
export const BASELINE_FILE = fileURLToPath(new URL('../_baseline-v2-outside-sudoku.json', import.meta.url))

export const BANK_BEGIN = 'SUDOKU PUZZLE BANK: BEGIN'
export const BANK_END = 'SUDOKU PUZZLE BANK: END'

export const GRADE_KEYS = LEVELS.map((level) => level.key)
export const GRADE_LABELS = Object.fromEntries(LEVELS.map((level) => [level.key, level.label]))
export const GRADE_LEVEL = Object.fromEntries(LEVELS.map((level) => [level.key, level.level]))

export function waitFor(label, missing) {
  if (missing.length === 0) return
  console.log('WAITING (' + label + '): ' + missing.join('; '))
  process.exit(2)
}

export function readClientCode() {
  return readFileSync(CLIENT_FILE, 'utf8')
}

export function clientHasBankMarker(code) {
  return code.indexOf(BANK_BEGIN) !== -1 && code.indexOf(BANK_END) !== -1
}

/** Locate the generated inline BANK block (api-spec-v2 §3). */
export function extractInlineBankBlock(code) {
  const begin = code.indexOf(BANK_BEGIN)
  const end = code.indexOf(BANK_END)
  if (begin === -1 || end === -1 || end < begin) {
    return { found: false, begin: -1, end: -1, blockText: '', beginLine: null, endLine: null }
  }
  // Widen to the full marker comment lines.
  const lineStart = code.lastIndexOf('\n', begin)
  const lineEnd = code.indexOf('\n', end)
  const from = lineStart === -1 ? 0 : lineStart + 1
  const to = lineEnd === -1 ? code.length : lineEnd
  return {
    found: true,
    begin,
    end,
    blockText: code.slice(from, to),
    beginLine: code.slice(0, begin).split('\n').length,
    endLine: code.slice(0, end).split('\n').length,
  }
}

export function readBankText() {
  if (!existsSync(BANK_FILE)) return null
  return readFileSync(BANK_FILE, 'utf8')
}

/** @returns {{bank: object, text: string, bytes: number}|null} */
export function readBank() {
  const text = readBankText()
  if (text === null) return null
  return { bank: JSON.parse(text), text, bytes: Buffer.byteLength(text, 'utf8') }
}

/** Normalise puzzle givens (string in bank / array in state) to {grid, string}. */
export function normalizeGivens(value) {
  const grid = parseGivens(value)
  return { grid, string: gridToString(grid) }
}

export function bankIndex(bank) {
  const byId = new Map()
  const byGrade = new Map()
  for (const grade of GRADE_KEYS) byGrade.set(grade, [])
  for (const puzzle of bank.puzzles) {
    byId.set(puzzle.id, puzzle)
    if (!byGrade.has(puzzle.grade)) byGrade.set(puzzle.grade, [])
    byGrade.get(puzzle.grade).push(puzzle)
  }
  return { byId, byGrade }
}

/** Count puzzles recorded per grade in bank.levels. */
export function bankCounts(bank) {
  const counts = {}
  for (const puzzle of bank.puzzles) counts[puzzle.grade] = (counts[puzzle.grade] || 0) + 1
  return counts
}

/** Load client.js with the v2 test seam and validate BANK presence. */
export async function loadV2Client(tag) {
  const loaded = await loadClient({ testFlag: true, tag })
  const api = requireClient(loaded.api)
  return { ...loaded, api }
}

/**
 * Independent invariants a sanitised v2 state must satisfy (api-spec-v2 §7).
 * Throws on the first violation.
 */
export function assertValidV2State(state, bank, label) {
  const index = bankIndex(bank)
  const fail = (message) => {
    throw new Error(label + ': ' + message)
  }
  if (!state || typeof state !== 'object') fail('state must be an object')
  const puzzle = index.byId.get(state.puzzleId)
  if (!puzzle) fail('puzzleId "' + state.puzzleId + '" must exist in the bank')
  if (state.grade !== puzzle.grade) fail('grade "' + state.grade + '" must match bank grade "' + puzzle.grade + '"')

  const givens = normalizeGivens(puzzle.givens).grid
  const stateGivens = normalizeGivens(state.givens).grid
  if (gridToString(stateGivens) !== gridToString(givens)) fail('restored givens differ from the bank puzzle')

  const board = state.board
  if (!Array.isArray(board) || board.length !== 81) fail('board must be number[81]')
  for (let cell = 0; cell < 81; cell += 1) {
    const value = board[cell]
    if (!Number.isInteger(value) || value < 0 || value > 9) fail('board cell ' + cell + ' must be an integer 0..9')
    if (givens[cell] !== 0 && value !== givens[cell]) fail('given cell ' + cell + ' must keep the givens value')
  }

  const notes = state.notes
  if (!Array.isArray(notes) || notes.length !== 81) fail('notes must be number[81]')
  for (let cell = 0; cell < 81; cell += 1) {
    const value = notes[cell]
    if (!Number.isInteger(value) || value < 0 || value > 511) fail('notes cell ' + cell + ' must be an integer 0..511')
    if ((givens[cell] !== 0 || board[cell] !== 0) && value !== 0) {
      fail('notes must be 0 on given/filled cell ' + cell)
    }
  }

  if (!Number.isInteger(state.elapsedMs) || state.elapsedMs < 0 || state.elapsedMs > 604800000) {
    fail('elapsedMs must be an integer 0..604800000')
  }
  if (!Array.isArray(state.played)) fail('played must be an array')
  if (state.played.length > 500) fail('played must be capped at 500')
  for (const id of state.played) {
    if (typeof id !== 'string' || !index.byId.has(id)) fail('played contains an unknown puzzle id: ' + String(id))
  }
  if (typeof state.winAcked !== 'boolean') fail('winAcked must be a boolean')
  if (state.runningSince !== null && state.runningSince !== undefined) fail('restored state runningSince must be null/undefined')
  if (state.won !== refIsSolved(board)) fail('won must equal isSolved(board)')
  // A restored state must not have regenerated a puzzle: givens match the bank puzzle above.
  return { puzzle, givens }
}

/** Check that a serialized v2 save has the frozen §7 shape. */
export function assertV2SaveShape(raw, bank, label) {
  const fail = (message) => {
    throw new Error(label + ': ' + message)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('save must be a plain object')
  if (raw.schemaVersion !== 2) fail('schemaVersion must be 2')
  const index = bankIndex(bank)
  const puzzle = index.byId.get(raw.puzzleId)
  if (!puzzle) fail('puzzleId must exist in the bank')
  if (raw.grade !== puzzle.grade) fail('grade must match the bank puzzle grade')
  const givens = normalizeGivens(puzzle.givens).grid
  if (!Array.isArray(raw.entries) || raw.entries.length !== 81) fail('entries must be number[81]')
  for (let cell = 0; cell < 81; cell += 1) {
    const value = raw.entries[cell]
    if (!Number.isInteger(value) || value < 0 || value > 9) fail('entries cell ' + cell + ' must be an integer 0..9')
    if (givens[cell] !== 0 && value !== 0) fail('entries must be 0 on given cell ' + cell)
  }
  if (!Array.isArray(raw.notes) || raw.notes.length !== 81) fail('notes must be number[81]')
  for (let cell = 0; cell < 81; cell += 1) {
    const value = raw.notes[cell]
    if (!Number.isInteger(value) || value < 0 || value > 511) fail('notes cell ' + cell + ' must be an integer 0..511')
    if ((givens[cell] !== 0 || raw.entries[cell] !== 0) && value !== 0) fail('notes must be 0 on given/filled cell ' + cell)
  }
  if (typeof raw.elapsed !== 'number' || !Number.isFinite(raw.elapsed)) fail('elapsed must be a finite number')
  if (raw.elapsed < 0) fail('elapsed must be clamped >= 0')
  if (raw.elapsed > 604800000) fail('elapsed must be clamped <= 604800000')
  if (!Array.isArray(raw.played)) fail('played must be an array')
  if (raw.played.length > 500) fail('played must be capped at 500')
  for (const id of raw.played) {
    if (typeof id !== 'string' || !index.byId.has(id)) fail('played contains an unknown puzzle id')
  }
  if (typeof raw.winAcked !== 'boolean') fail('winAcked must be a boolean')
  return { puzzle, givens }
}

/** Hash-compare the archived "outside the sudoku package" baseline. */
export function checkOutsideBaseline(createHash) {
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
  const changed = []
  const missing = []
  for (const [relPath, hash] of Object.entries(baseline)) {
    const absolute = join(WORKSPACE_ROOT, relPath)
    if (!existsSync(absolute)) {
      missing.push(relPath)
      continue
    }
    const actual = createHash('sha256').update(readFileSync(absolute)).digest('hex').toUpperCase()
    if (actual !== hash) changed.push(relPath)
  }
  return { changed, missing, checked: Object.keys(baseline).length }
}

export function bankJsonSummary(bank) {
  const counts = bankCounts(bank)
  return {
    version: bank.version,
    generatedAt: bank.generatedAt,
    levels: GRADE_KEYS.map((grade) => ({
      key: grade,
      label: GRADE_LABELS[grade],
      level: GRADE_LEVEL[grade],
      count: counts[grade] || 0,
    })),
    total: bank.puzzles.length,
  }
}

export { LEVELS, LEVEL_BY_GRADE, refConsistent, refIsSolved, refIsValidSolution, countSolutions }
