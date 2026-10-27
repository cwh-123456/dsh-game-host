/**
 * v2 audit 3/4 — save schema v2 (structure/fuzz/restore-same-puzzle/v1 reject/
 * unknown-id reject), runtime pickPuzzle/newPuzzle/played semantics, no runtime
 * generation, performance and static UI checks.
 *
 * Run: node dev/audit/v2/audit-v2-save.mjs
 */
import {
  GRADE_KEYS,
  GRADE_LABELS,
  assertV2SaveShape,
  assertValidV2State,
  bankIndex,
  clientHasBankMarker,
  extractInlineBankBlock,
  loadV2Client,
  normalizeGivens,
  readBank,
  readClientCode,
  waitFor,
} from './common.mjs'
import { createRunner, must } from '../harness.mjs'

const runner = createRunner('v2 save/runtime audit')
const EVIDENCE = {}

const bankRead = readBank()
const missing = []
if (!bankRead) missing.push('dev/bank.json')
else if (!clientHasBankMarker(readClientCode())) missing.push('client.js inline BANK marker block')
waitFor('v2 artifacts not ready', missing)

const bank = bankRead.bank
const index = bankIndex(bank)
const code = readClientCode()
let loaded = null
try {
  loaded = await loadV2Client('v2-save')
} catch (error) {
  waitFor('v2 client seam could not load: ' + error.message, ['working v2 client.js'])
}
const api = loaded.api
if (!api.BANK || !Array.isArray(api.BANK.puzzles) || api.BANK.puzzles.length === 0) {
  waitFor('v2 client seam not populated yet', ['client.js inline BANK with puzzles (bank not promoted yet)'])
}
const storage = loaded.storage
const STORE_KEY = 'dsh.game.sudoku.v1'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function allIds(grade) {
  return index.byGrade.get(grade).map((puzzle) => puzzle.id)
}

function puzzlesOf(grade) {
  return index.byGrade.get(grade)
}

function emptyEntries() {
  return new Array(81).fill(0)
}

function givensGrid(puzzle) {
  return normalizeGivens(puzzle.givens).grid
}

function playerEntries(puzzle) {
  // Deterministic player layer: fill up to three empty cells with arbitrary digits.
  const givens = givensGrid(puzzle)
  const entries = emptyEntries()
  let placed = 0
  for (let cell = 0; cell < 81 && placed < 3; cell += 1) {
    if (givens[cell] !== 0) continue
    entries[cell] = 1 + ((cell + puzzle.id.length) % 9)
    placed += 1
  }
  return entries
}

function playerNotes(puzzle, entries) {
  const givens = givensGrid(puzzle)
  const notes = new Array(81).fill(0)
  for (let cell = 0; cell < 81; cell += 1) {
    if (givens[cell] === 0 && entries[cell] === 0) {
      notes[cell] = (1 << (cell % 9)) | 1
      break
    }
  }
  return notes
}

function makeRaw(puzzle, overrides = {}) {
  const entries = overrides.entries || playerEntries(puzzle)
  return Object.assign(
    {
      schemaVersion: 2,
      puzzleId: puzzle.id,
      grade: puzzle.grade,
      entries,
      notes: playerNotes(puzzle, entries),
      elapsed: 12345,
      played: [puzzle.id],
      winAcked: false,
    },
    overrides,
  )
}

function resetStorage() {
  storage.map.clear()
  storage.failGet = false
  storage.failSet = false
  storage.failRemove = false
}

function setRaw(raw) {
  storage.map.set(STORE_KEY, JSON.stringify(raw))
}

function assertRestoredMatches(state, puzzle, raw, label) {
  assertValidV2State(state, bank, label)
  must(state.puzzleId === puzzle.id, label + ': puzzleId must be exactly the saved one')
  const savedGivens = normalizeGivens(puzzle.givens).string
  must(normalizeGivens(state.givens).string === savedGivens, label + ': givens must be the saved puzzle (no repick)')
  const givens = givensGrid(puzzle)
  for (let cell = 0; cell < 81; cell += 1) {
    const expected = givens[cell] !== 0 ? givens[cell] : raw.entries[cell]
    must(state.board[cell] === expected, label + ': board cell ' + cell + ' mismatch')
  }
  for (let cell = 0; cell < 81; cell += 1) {
    must(state.notes[cell] === raw.notes[cell], label + ': notes cell ' + cell + ' mismatch')
  }
  must(state.elapsedMs === raw.elapsed, label + ': elapsed mismatch')
  must(state.grade === puzzle.grade, label + ': grade mismatch')
}

function expectReject(label, raw) {
  let threw = null
  let outcome
  try {
    outcome = api.sanitizeSave(raw)
  } catch (error) {
    threw = error
  }
  must(threw === null, label + ': sanitizeSave must not throw, threw ' + (threw && threw.message))
  must(outcome === null, label + ': sanitizeSave must reject this input')
}

// ---------------------------------------------------------------------------
// 1. seam surface + constants
// ---------------------------------------------------------------------------
runner.check('v2 seam exposes the documented constants, BANK and helpers', () => {
  must(api.BANK && typeof api.BANK === 'object', 'api.BANK must exist')
  must(api.SCHEMA_VERSION === 2, 'SCHEMA_VERSION must be 2')
  must(api.STORE_KEY === STORE_KEY, 'STORE_KEY')
  must(api.DEFAULT_GRADE === 'normal', 'DEFAULT_GRADE must be normal')
  must(api.GAME_ID === 'sudoku' && api.GRID === 9 && api.CELLS === 81, 'basic constants')
  must(api.UNDO_LIMIT === 300, 'UNDO_LIMIT')
  must(Array.isArray(api.LEVELS) && api.LEVELS.length === 5, 'LEVELS must have 5 entries')
  api.LEVELS.forEach((level, at) => {
    must(level.key === GRADE_KEYS[at], 'LEVELS[' + at + '].key')
    must(level.label === GRADE_LABELS[GRADE_KEYS[at]], 'LEVELS[' + at + '].label')
    must(level.level === at + 1, 'LEVELS[' + at + '].level')
  })
  for (const name of ['findPuzzle', 'pickPuzzle', 'createRng', 'createState', 'loadSavedState', 'saveState', 'serializeState', 'sanitizeSave']) {
    must(typeof api[name] === 'function', 'seam must export ' + name)
  }
  for (const name of ['generatePuzzle', 'generateFullGrid', 'countSolutions', 'solve', 'gradePuzzle']) {
    must(typeof api[name] === 'undefined', 'seam must NOT export ' + name)
  }
})

runner.check('findPuzzle resolves bank puzzles and rejects unknown ids', () => {
  for (const grade of GRADE_KEYS) {
    for (const puzzle of puzzlesOf(grade).slice(0, 3)) {
      const found = api.findPuzzle(puzzle.id)
      must(found && typeof found === 'object', 'findPuzzle(' + puzzle.id + ') must return the puzzle')
      must(found.id === puzzle.id, 'id')
      must(found.grade === puzzle.grade, 'grade')
      must(normalizeGivens(found.givens).string === puzzle.givens, 'givens')
    }
  }
  must(api.findPuzzle('easy-not-a-real-id') === null, 'unknown id must return null')
  must(api.findPuzzle(null) === null, 'null id must return null')
  must(api.findPuzzle(undefined) === null, 'undefined id must return null')
})

// ---------------------------------------------------------------------------
// 2. createState / serialize / save / load
// ---------------------------------------------------------------------------
let freshState = null
runner.check('createState draws a bank puzzle and builds a clean state', () => {
  resetStorage()
  freshState = api.createState({ grade: 'normal', played: [], rng: api.createRng(123), now: 1000 })
  must(freshState && typeof freshState === 'object', 'createState must return a state')
  const puzzle = index.byId.get(freshState.puzzleId)
  must(puzzle !== null, 'state.puzzleId must be a bank puzzle id')
  must(puzzle.grade === 'normal', 'picked puzzle must have the requested grade')
  must(freshState.grade === 'normal', 'state.grade must be the requested grade')
  must(normalizeGivens(freshState.givens).string === puzzle.givens, 'state.givens must equal the bank puzzle')
  const givens = givensGrid(puzzle)
  must(Array.isArray(freshState.board) && freshState.board.length === 81, 'board must be number[81]')
  for (let cell = 0; cell < 81; cell += 1) {
    must(freshState.board[cell] === givens[cell], 'fresh board must equal givens (cell ' + cell + ')')
  }
  must(freshState.notes.every((value) => value === 0), 'fresh notes must be empty')
  must(freshState.selected === null, 'fresh selected must be null')
  must(freshState.notesMode === false, 'fresh notesMode must be false')
  must(freshState.elapsedMs === 0, 'fresh elapsedMs must be 0')
  must(freshState.runningSince === 1000, 'fresh runningSince must be now')
  must(freshState.won === false && freshState.winAcked === false, 'fresh win flags')
  must(Array.isArray(freshState.undo) && freshState.undo.length === 0, 'fresh undo must be empty')
  must(Array.isArray(freshState.played) && freshState.played.indexOf(freshState.puzzleId) !== -1, 'played must include the fresh puzzle id')
  EVIDENCE.freshPuzzle = { id: freshState.puzzleId, grade: freshState.grade }
})

runner.check('createState is deterministic for the same rng seed and prefers unseen puzzles', () => {
  const first = api.createState({ grade: 'hard', played: [], rng: api.createRng(777), now: 0 })
  const second = api.createState({ grade: 'hard', played: [], rng: api.createRng(777), now: 0 })
  must(first.puzzleId === second.puzzleId, 'same seed must pick the same puzzle')
  // played = all but one id -> must pick the remaining unseen one
  const ids = allIds('easy')
  const seen = ids.slice(0, ids.length - 1)
  const remaining = ids[ids.length - 1]
  const state = api.createState({ grade: 'easy', played: seen, rng: api.createRng(1), now: 0 })
  must(state.puzzleId === remaining, 'createState must prefer the only unseen puzzle')
  must(seen.length === ids.length - 1, 'input played array passed to createState must not be mutated')
})

runner.check('serializeState emits the frozen v2 save schema and given cells keep entries=0', () => {
  resetStorage()
  const state = api.createState({ grade: 'normal', played: [], rng: api.createRng(55), now: 1000 })
  const puzzle = index.byId.get(state.puzzleId)
  const givens = givensGrid(puzzle)
  // make some player progress + notes
  const empties = []
  for (let cell = 0; cell < 81; cell += 1) if (givens[cell] === 0) empties.push(cell)
  api.applyDigit(state, empties[0], 3, 1500)
  api.toggleNotesMode(state)
  api.applyDigit(state, empties[1], 7, 1700)
  api.toggleNotesMode(state)
  api.selectCell(state, empties[2])
  api.timerPause(state, 2000)
  const raw = api.serializeState(state)
  assertV2SaveShape(raw, bank, 'serialize')
  for (const key of ['schemaVersion', 'puzzleId', 'grade', 'entries', 'notes', 'elapsed', 'played', 'winAcked']) {
    must(key in raw, 'serializeState must expose ' + key)
  }
  must(raw.puzzleId === state.puzzleId, 'puzzleId')
  must(raw.grade === puzzle.grade, 'grade')
  must(Array.isArray(raw.entries) && raw.entries.length === 81, 'entries length')
  for (let cell = 0; cell < 81; cell += 1) {
    if (givens[cell] !== 0) must(raw.entries[cell] === 0, 'entries at given cell ' + cell + ' must be 0')
  }
  must(raw.entries[empties[0]] === 3, 'entries must carry the player value')
  must(raw.entries[empties[1]] === 0, 'pencil marks must not leak into entries')
  must(raw.notes[empties[1]] === 1 << 6, 'notes must carry the pencil mark')
  must(raw.elapsed === 1000, 'elapsed must be the paused elapsed time (1000ms)')
  must(Array.isArray(raw.played) && raw.played.indexOf(state.puzzleId) !== -1, 'played')
  must(JSON.parse(JSON.stringify(raw)).puzzleId === raw.puzzleId, 'save must be plain JSON data')
  EVIDENCE.serializeKeys = Object.keys(raw).sort()
})

runner.check('saveState → loadSavedState restores the SAME puzzle with entries/notes/elapsed', () => {
  resetStorage()
  const state = api.createState({ grade: 'hard', played: [], rng: api.createRng(99), now: 500 })
  const puzzle = index.byId.get(state.puzzleId)
  const givens = givensGrid(puzzle)
  const empties = []
  for (let cell = 0; cell < 81; cell += 1) if (givens[cell] === 0) empties.push(cell)
  api.applyDigit(state, empties[0], 4, 900)
  api.toggleNotesMode(state)
  api.applyDigit(state, empties[1], 2, 1000)
  api.toggleNotesMode(state)
  api.timerPause(state, 1500)
  const raw = api.serializeState(state)
  must(api.saveState(state) === true, 'saveState must return true')
  must(storage.map.size === 1, 'only the v2 STORE_KEY may be written')
  must(storage.map.has(STORE_KEY), 'saveState must use ' + STORE_KEY)
  const stored = JSON.parse(storage.map.get(STORE_KEY))
  must(stored.schemaVersion === 2, 'stored schemaVersion must be 2')
  must(stored.puzzleId === state.puzzleId, 'stored puzzleId')
  const restored = api.loadSavedState()
  must(restored !== null, 'loadSavedState must restore a valid v2 save')
  assertRestoredMatches(restored, puzzle, raw, 'restore')
  must(restored.runningSince === null, 'restored runningSince must be null (component resumes it)')
  const again = api.loadSavedState()
  must(again !== null && again.puzzleId === state.puzzleId, 'restore must be idempotent')
})

runner.check('restore keeps the exact puzzleId/givens for a sample across all 5 grades (never repicks)', () => {
  resetStorage()
  let restoredCount = 0
  for (const grade of GRADE_KEYS) {
    for (const puzzle of puzzlesOf(grade).slice(0, 3)) {
      const raw = makeRaw(puzzle)
      setRaw(raw)
      const state = api.loadSavedState()
      must(state !== null, puzzle.id + ': must restore')
      assertRestoredMatches(state, puzzle, raw, puzzle.id)
      restoredCount += 1
    }
  }
  EVIDENCE.restoredSamePuzzleCount = restoredCount
})

// ---------------------------------------------------------------------------
// 3. sanitizeSave reject matrix / normalisation
// ---------------------------------------------------------------------------
runner.check('old v1 saves and unknown puzzle ids are rejected (null, no throw)', () => {
  resetStorage()
  const v1 = {
    schemaVersion: 1,
    difficulty: 'easy',
    targetGivens: 40,
    givens: new Array(81).fill(0),
    solution: new Array(81).fill(1),
    board: new Array(81).fill(0),
    notes: new Array(81).fill(0),
    selected: null,
    notesMode: false,
    elapsedMs: 0,
    won: false,
    winAcked: false,
    undo: [],
  }
  expectReject('v1 save', v1)
  setRaw(v1)
  must(api.loadSavedState() === null, 'loadSavedState must drop a v1 save')
  const puzzle = puzzlesOf('normal')[0]
  expectReject('unknown puzzleId', makeRaw(puzzle, { puzzleId: 'normal-zzzzzzz' }))
  expectReject('grade mismatch', makeRaw(puzzle, { grade: 'easy' }))
  expectReject('invalid grade', makeRaw(puzzle, { grade: 'legendary' }))
})

runner.check('sanitizeSave rejects all structurally invalid v2 saves', () => {
  const puzzle = puzzlesOf('normal')[1]
  const good = makeRaw(puzzle)
  must(api.sanitizeSave(clone(good)) !== null, 'baseline valid save must sanitize')
  const cases = []
  const add = (label, raw) => cases.push([label, raw])
  add('null', null)
  add('undefined', undefined)
  add('string', 'save')
  add('number', 2)
  add('array', [])
  add('empty object', {})
  add('schemaVersion 1', Object.assign(clone(good), { schemaVersion: 1 }))
  add('schemaVersion 3', Object.assign(clone(good), { schemaVersion: 3 }))
  add('schemaVersion missing', (() => { const raw = clone(good); delete raw.schemaVersion; return raw })())
  add('puzzleId missing', (() => { const raw = clone(good); delete raw.puzzleId; return raw })())
  add('puzzleId unknown', Object.assign(clone(good), { puzzleId: 'normal-unknown' }))
  add('grade mismatch', Object.assign(clone(good), { grade: 'easy' }))
  add('grade missing', (() => { const raw = clone(good); delete raw.grade; return raw })())
  add('entries missing', (() => { const raw = clone(good); delete raw.entries; return raw })())
  add('entries 80 cells', Object.assign(clone(good), { entries: good.entries.slice(0, 80) }))
  add('entries 82 cells', Object.assign(clone(good), { entries: good.entries.concat([0]) }))
  const entriesBig = good.entries.slice()
  entriesBig[0] = 10
  add('entries digit 10', Object.assign(clone(good), { entries: entriesBig }))
  const entriesNeg = good.entries.slice()
  entriesNeg[0] = -1
  add('entries digit -1', Object.assign(clone(good), { entries: entriesNeg }))
  const entriesFloat = good.entries.slice()
  entriesFloat[0] = 1.5
  add('entries digit 1.5', Object.assign(clone(good), { entries: entriesFloat }))
  const entriesString = good.entries.slice()
  entriesString[0] = '5'
  add('entries digit string', Object.assign(clone(good), { entries: entriesString }))
  add('notes missing', (() => { const raw = clone(good); delete raw.notes; return raw })())
  add('notes 80 cells', Object.assign(clone(good), { notes: good.notes.slice(0, 80) }))
  add('notes 512 value', (() => {
    const notes = good.notes.slice()
    notes[0] = 512
    return Object.assign(clone(good), { notes })
  })())
  add('notes -1 value', (() => {
    const notes = good.notes.slice()
    notes[0] = -1
    return Object.assign(clone(good), { notes })
  })())
  add('notes float', (() => {
    const notes = good.notes.slice()
    notes[0] = 1.5
    return Object.assign(clone(good), { notes })
  })())
  add('elapsed string', Object.assign(clone(good), { elapsed: '123' }))
  add('elapsed NaN', Object.assign(clone(good), { elapsed: NaN }))
  add('elapsed missing', (() => { const raw = clone(good); delete raw.elapsed; return raw })())
  // NOTE: a non-array `played` is not in the must-reject matrix: api-spec-v2 §7
  // only says "played 过滤为题库中存在的 id 且 ≤500", and the implementation
  // leniently normalises a non-array to [] (recorded in the normalisation check).
  for (const [label, raw] of cases) expectReject(label, raw)
  EVIDENCE.rejectCases = cases.length
})

runner.check('sanitizeSave normalises recoverable v2 fields instead of rejecting', () => {
  const puzzle = puzzlesOf('normal')[2]
  const givens = givensGrid(puzzle)
  const empties = []
  for (let cell = 0; cell < 81; cell += 1) if (givens[cell] === 0) empties.push(cell)
  const givenCell = givens.findIndex((value) => value !== 0)

  // given-cell entries are forced back to 0 (spec: 恢复时强制 0)
  const rawGiven = makeRaw(puzzle)
  rawGiven.entries[givenCell] = 9
  const normalisedGiven = api.sanitizeSave(clone(rawGiven))
  must(normalisedGiven !== null, 'nonzero entries on a given cell must be normalised, not rejected')
  must(normalisedGiven.board[givenCell] === givens[givenCell], 'given entry must be forced back to the givens value')

  // notes on given/filled cells are zeroed
  const rawNotes = makeRaw(puzzle)
  rawNotes.notes[givenCell] = 511
  rawNotes.notes[empties[0]] = 1 // this entry cell is filled by makeRaw
  const normalisedNotes = api.sanitizeSave(clone(rawNotes))
  must(normalisedNotes !== null, 'notes on given/filled cells must be normalised')
  must(normalisedNotes.notes[givenCell] === 0, 'notes on a given cell must be zeroed')
  must(normalisedNotes.notes[empties[0]] === 0, 'notes on a filled cell must be zeroed')

  // elapsed clamped
  const negative = api.sanitizeSave(Object.assign(clone(makeRaw(puzzle)), { elapsed: -500 }))
  must(negative !== null, 'negative elapsed must clamp, not reject')
  must(negative.elapsedMs === 0, 'negative elapsed must clamp to 0')
  const huge = api.sanitizeSave(Object.assign(clone(makeRaw(puzzle)), { elapsed: 999999999 }))
  must(huge !== null)
  must(huge.elapsedMs === 604800000, 'huge elapsed must clamp to 604800000')

  // winAcked booleanised from `=== true`
  for (const value of [1, 'true', {}, 0, null]) {
    const state = api.sanitizeSave(Object.assign(clone(makeRaw(puzzle)), { winAcked: value }))
    must(state !== null)
    must(state.winAcked === false, 'winAcked must be booleanised from ' + JSON.stringify(value))
  }
  const acked = api.sanitizeSave(Object.assign(clone(makeRaw(puzzle)), { winAcked: true }))
  must(acked !== null && acked.winAcked === true, 'winAcked=true must be preserved')

  // played filter: unknown ids dropped, valid kept, <=500
  const playedRaw = clone(makeRaw(puzzle))
  playedRaw.played = ['bogus', puzzle.id, 42, null, puzzlesOf('easy')[0].id]
  const playedState = api.sanitizeSave(playedRaw)
  must(playedState !== null, 'unknown played ids must be filtered, not rejected')
  must(playedState.played.indexOf('bogus') === -1, 'unknown played id must be dropped')
  must(playedState.played.indexOf(42) === -1, 'non-string played id must be dropped')
  must(playedState.played.indexOf(puzzle.id) !== -1, 'valid played id must be kept')
  const overflow = clone(makeRaw(puzzle))
  overflow.played = allIds('easy').concat(allIds('normal')).concat(allIds('hard')).concat(allIds('expert')).concat(allIds('hell'))
  overflow.played = overflow.played.concat(overflow.played, overflow.played, overflow.played, overflow.played)
  const capped = api.sanitizeSave(overflow)
  must(capped !== null)
  must(capped.played.length <= 500, 'played must be capped at 500')
  EVIDENCE.normalisationProbes = {
    elapsedFloat: (() => {
      const state = api.sanitizeSave(Object.assign(clone(makeRaw(puzzle)), { elapsed: 12.5 }))
      return state === null ? 'rejected' : 'accepted:' + state.elapsedMs
    })(),
    playedDuplicates: capped.played.length === new Set(capped.played).size ? 'deduped' : 'duplicates-allowed',
    playedNonArray: (() => {
      const state = api.sanitizeSave(Object.assign(clone(makeRaw(puzzle)), { played: 'nope' }))
      if (state === null) return 'rejected'
      return 'accepted:playedLength=' + state.played.length
    })(),
  }
})

// ---------------------------------------------------------------------------
// 4. fuzz
// ---------------------------------------------------------------------------
runner.check('sanitizeSave fuzz: 2000 corrupt v2 saves never throw and accepted states are valid', () => {
  const puzzle = puzzlesOf('hard')[0]
  const valid = makeRaw(puzzle)
  const validKeys = Object.keys(valid)
  const junkPool = [null, undefined, true, false, 0, 1, -1, 1.5, 81, 512, '0', 'x', '', [], {}, [1, 2, 3], { a: 1 }, NaN, Infinity]
  const rng = mulberry(424242)

  function randomJunk() {
    const roll = rng()
    if (roll < 0.55) return junkPool[Math.floor(rng() * junkPool.length)]
    if (roll < 0.75) {
      const array = []
      const length = Math.floor(rng() * 4)
      for (let at = 0; at < length; at += 1) array.push(junkPool[Math.floor(rng() * junkPool.length)])
      return array
    }
    const object = {}
    for (const key of validKeys.slice(0, Math.floor(rng() * 4))) object[key] = junkPool[Math.floor(rng() * junkPool.length)]
    return object
  }

  function mutate(seedRaw) {
    const raw = clone(seedRaw)
    const keys = Object.keys(raw)
    for (let operation = 0; operation < 1 + Math.floor(rng() * 4); operation += 1) {
      const roll = rng()
      if (roll < 0.15 && keys.length > 0) {
        delete raw[keys[Math.floor(rng() * keys.length)]]
      } else if (roll < 0.3) {
        raw['junk' + Math.floor(rng() * 5)] = randomJunk()
      } else if (roll < 0.85 && keys.length > 0) {
        const key = keys[Math.floor(rng() * keys.length)]
        const value = raw[key]
        if (Array.isArray(value)) {
          const at = Math.floor(rng() * value.length)
          const action = rng()
          if (action < 0.5) value[at] = randomJunk()
          else if (action < 0.75) value.splice(at, 1)
          else value.push(randomJunk())
        } else if (value && typeof value === 'object') {
          const subKeys = Object.keys(value)
          if (subKeys.length > 0) value[subKeys[Math.floor(rng() * subKeys.length)]] = randomJunk()
          else raw[key] = randomJunk()
        } else {
          raw[key] = randomJunk()
        }
      } else if (keys.length > 0) {
        raw[keys[Math.floor(rng() * keys.length)]] = randomJunk()
      }
    }
    return raw
  }

  let cases = 0
  let rejected = 0
  let accepted = 0
  let throws = 0
  for (let at = 0; at < 2000; at += 1) {
    const input = at < 800 ? randomJunk() : mutate(valid)
    cases += 1
    try {
      const outcome = api.sanitizeSave(input)
      if (outcome === null) {
        rejected += 1
      } else {
        accepted += 1
        assertValidV2State(outcome, bank, 'fuzz #' + at)
      }
    } catch (error) {
      throws += 1
    }
  }
  EVIDENCE.sanitizeFuzz = { cases, rejected, accepted, throws }
  must(throws === 0, 'sanitizeSave threw on ' + throws + ' fuzz inputs')
})

runner.check('loadSavedState fuzz: 300 corrupt JSON payloads never throw and never yield an invalid state', () => {
  resetStorage()
  const puzzle = puzzlesOf('expert')[0]
  const validText = JSON.stringify(makeRaw(puzzle))
  const rng = mulberry(777001)
  let cases = 0
  let restoredValid = 0
  let rejected = 0
  let throws = 0
  for (let at = 0; at < 300; at += 1) {
    const roll = rng()
    let payload
    if (roll < 0.4) {
      payload = ['', '{', 'null', '[]', '{}', '{"schemaVersion":2}', 'not json', '<xml/>'][Math.floor(rng() * 8)]
    } else {
      const chars = validText.split('')
      for (let edit = 0; edit < 1 + Math.floor(rng() * 5); edit += 1) {
        const position = Math.floor(rng() * chars.length)
        const action = rng()
        if (action < 0.4) chars[position] = String.fromCharCode(32 + Math.floor(rng() * 90))
        else if (action < 0.7) chars.splice(position, 1)
        else chars.splice(position, 0, String.fromCharCode(32 + Math.floor(rng() * 90)))
      }
      payload = chars.join('')
    }
    storage.map.set(STORE_KEY, payload)
    cases += 1
    try {
      const state = api.loadSavedState()
      if (state === null) {
        rejected += 1
      } else {
        restoredValid += 1
        assertValidV2State(state, bank, 'load fuzz #' + at)
      }
    } catch (error) {
      throws += 1
    }
  }
  resetStorage()
  EVIDENCE.loadFuzz = { cases, rejected, restoredValid, throws }
  must(throws === 0, 'loadSavedState threw in ' + throws + ' fuzz cases')
})

function mulberry(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

runner.check('saveState failures are swallowed; loadSavedState is defensive on storage errors', () => {
  resetStorage()
  storage.failSet = true
  const state = api.createState({ grade: 'easy', played: [], rng: api.createRng(3), now: 0 })
  let result
  let threw = false
  try {
    result = api.saveState(state)
  } catch (error) {
    threw = true
  }
  storage.failSet = false
  must(threw === false, 'saveState must never throw')
  must(result === false, 'saveState must return false when storage fails')
  storage.failGet = true
  let loadedValue
  threw = false
  try {
    loadedValue = api.loadSavedState()
  } catch (error) {
    threw = true
  }
  storage.failGet = false
  must(threw === false, 'loadSavedState must never throw')
  must(loadedValue === null, 'loadSavedState must return null when storage throws')
})

// ---------------------------------------------------------------------------
// 5. pickPuzzle / newPuzzle / played semantics
// ---------------------------------------------------------------------------
runner.check('pickPuzzle returns grade-correct puzzles and never mutates played', () => {
  for (const grade of GRADE_KEYS) {
    const ids = allIds(grade)
    const played = []
    const picked = api.pickPuzzle(grade, played, api.createRng(10))
    must(picked && typeof picked === 'object', 'pickPuzzle(' + grade + ') must return a puzzle')
    must(picked.grade === grade, 'picked puzzle grade')
    must(index.byId.has(picked.id), 'picked puzzle must be in the bank')
    must(played.length === 0, 'pickPuzzle must not mutate the played array')
    // seeded draws should not always be the same puzzle
    const distinct = new Set()
    for (let seed = 1; seed <= 40; seed += 1) distinct.add(api.pickPuzzle(grade, [], api.createRng(seed)).id)
    must(distinct.size > 1, 'pickPuzzle(' + grade + ') must vary with the rng (distinct=' + distinct.size + ')')
    must(distinct.size <= ids.length, 'distinct picks ' + distinct.size + ' exceed the grade size ' + ids.length)
  }
})

runner.check('pickPuzzle prefers unseen puzzles and falls back when the whole grade has been played', () => {
  for (const grade of GRADE_KEYS) {
    const ids = allIds(grade)
    if (ids.length < 2) continue
    const remaining = ids[ids.length - 1]
    const seen = ids.slice(0, ids.length - 1)
    const picked = api.pickPuzzle(grade, seen, api.createRng(2026))
    must(picked.id === remaining, grade + ': must pick the only unseen puzzle, got ' + picked.id)
    const fallback = api.pickPuzzle(grade, ids.slice(), api.createRng(2026))
    must(fallback && index.byId.has(fallback.id), grade + ': fallback must return a grade puzzle when all are played')
    must(fallback.grade === grade, grade + ': fallback grade')
    must(ids.indexOf(fallback.id) !== -1, grade + ': fallback id must be in the grade')
  }
})

runner.check('pickPuzzle is deterministic for the same rng seed and works without an rng', () => {
  const first = api.pickPuzzle('normal', [], api.createRng(31415))
  const second = api.pickPuzzle('normal', [], api.createRng(31415))
  must(first.id === second.id, 'same seed must pick the same puzzle')
  const withoutRng = api.pickPuzzle('normal', [])
  must(withoutRng && index.byId.has(withoutRng.id), 'pickPuzzle must work without an explicit rng (Math.random)')
  const invalidGrade = (() => {
    try {
      const picked = api.pickPuzzle('legendary', [], api.createRng(1))
      return picked && picked.id ? 'returned:' + picked.grade : 'returned-empty'
    } catch (error) {
      return 'threw:' + error.message
    }
  })()
  EVIDENCE.invalidGradePick = invalidGrade
})

runner.check('createState/newPuzzle keep grade correct, reset progress and accumulate played without duplicates', () => {
  resetStorage()
  const state = api.createState({ grade: 'normal', played: [], rng: api.createRng(808), now: 1000 })
  const firstId = state.puzzleId
  const puzzle = index.byId.get(firstId)
  const givens = givensGrid(puzzle)
  const empties = []
  for (let cell = 0; cell < 81; cell += 1) if (givens[cell] === 0) empties.push(cell)
  api.applyDigit(state, empties[0], 5, 1500)
  api.selectCell(state, empties[1])
  api.timerPause(state, 2000)
  api.newPuzzle(state, 'expert', api.createRng(909), 7000)
  must(state.grade === 'expert', 'newPuzzle must switch grade')
  must(index.byId.has(state.puzzleId), 'newPuzzle must pick a bank puzzle')
  must(index.byId.get(state.puzzleId).grade === 'expert', 'newPuzzle must pick from the requested grade')
  const newGivens = givensGrid(index.byId.get(state.puzzleId))
  for (let cell = 0; cell < 81; cell += 1) {
    must(state.board[cell] === newGivens[cell], 'newPuzzle board must equal the new givens')
  }
  must(state.notes.every((value) => value === 0), 'newPuzzle must clear notes')
  must(state.undo.length === 0, 'newPuzzle must clear undo')
  must(state.elapsedMs === 0, 'newPuzzle must reset elapsed')
  must(state.runningSince === 7000, 'newPuzzle must restart the timer')
  must(state.won === false && state.winAcked === false, 'newPuzzle must reset win flags')
  must(state.selected === null, 'newPuzzle must clear selected')
  must(state.played.indexOf(firstId) !== -1, 'played must keep previous ids')
  must(state.played.indexOf(state.puzzleId) !== -1, 'played must include the current id')
  must(new Set(state.played).size === state.played.length, 'played must not contain duplicates')

  // Repeated newPuzzle: ids vary, played stays bounded/deduped.
  const seen = new Set()
  for (let round = 0; round < 40; round += 1) {
    const grade = GRADE_KEYS[round % GRADE_KEYS.length]
    api.newPuzzle(state, grade, api.createRng(1000 + round), round * 10)
    must(index.byId.has(state.puzzleId), 'newPuzzle round ' + round + ' must pick a bank puzzle')
    must(index.byId.get(state.puzzleId).grade === grade, 'newPuzzle round ' + round + ' grade')
    seen.add(state.puzzleId)
    must(state.played.length <= 500, 'played must stay capped at 500')
    must(state.played.length <= bank.puzzles.length, 'played cannot exceed the bank size')
    must(new Set(state.played).size === state.played.length, 'played must stay deduped')
  }
  must(seen.size > 1, '40 newPuzzle calls must not always return the same puzzle')
  EVIDENCE.newPuzzleDistinct = seen.size
})

runner.check('newPuzzle with an invalid grade still returns a valid bank puzzle (no throw)', () => {
  const state = api.createState({ grade: 'normal', played: [], rng: api.createRng(5), now: 0 })
  let outcome = 'returned'
  try {
    api.newPuzzle(state, 'legendary', api.createRng(6), 100)
  } catch (error) {
    outcome = 'threw:' + error.message
  }
  EVIDENCE.invalidGradeNewPuzzle = outcome
  must(index.byId.has(state.puzzleId), 'invalid-grade newPuzzle must fall back to a bank puzzle')
  must(state.played.indexOf(state.puzzleId) !== -1, 'fallback puzzle id must be recorded in played')
})

// ---------------------------------------------------------------------------
// 6. runtime performance (api-spec-v2 §9: pick/restore < 5ms)
// ---------------------------------------------------------------------------
runner.check('pickPuzzle/createState/loadSavedState are fast (< 5ms target)', () => {
  resetStorage()
  const sample = api.createState({ grade: 'normal', played: [], rng: api.createRng(7), now: 0 })
  const raw = api.serializeState(sample)
  // pickPuzzle x100
  const pickTimes = []
  for (let at = 0; at < 100; at += 1) {
    const start = performance.now()
    api.pickPuzzle('normal', [], api.createRng(at))
    pickTimes.push(performance.now() - start)
  }
  // createState x100
  const createTimes = []
  for (let at = 0; at < 100; at += 1) {
    const start = performance.now()
    api.createState({ grade: 'normal', played: [], rng: api.createRng(at), now: 0 })
    createTimes.push(performance.now() - start)
  }
  // loadSavedState x100
  storage.map.set(STORE_KEY, JSON.stringify(raw))
  const loadTimes = []
  for (let at = 0; at < 100; at += 1) {
    const start = performance.now()
    const state = api.loadSavedState()
    loadTimes.push(performance.now() - start)
    must(state !== null, 'loadSavedState hot loop must restore')
  }
  const stats = (values) => {
    const sorted = values.slice().sort((a, b) => a - b)
    return {
      mean: Number((sorted.reduce((total, value) => total + value, 0) / sorted.length).toFixed(3)),
      p95: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(3)),
      max: Number(sorted[sorted.length - 1].toFixed(3)),
    }
  }
  EVIDENCE.performance = {
    pickPuzzle: stats(pickTimes),
    createState: stats(createTimes),
    loadSavedState: stats(loadTimes),
  }
  for (const name of ['pickPuzzle', 'createState', 'loadSavedState']) {
    const entry = EVIDENCE.performance[name]
    must(entry.p95 < 5, name + ' p95 must be < 5ms, got ' + entry.p95)
    must(entry.mean < 5, name + ' mean must be < 5ms, got ' + entry.mean)
  }
})

// ---------------------------------------------------------------------------
// 7. no runtime generation / static UI v2
// ---------------------------------------------------------------------------
runner.check('client.js contains no runtime generator or solver (static)', () => {
  const forbidden = [/\bgeneratePuzzle\b/, /\bgenerateFullGrid\b/, /\bcountSolutions\b/, /\bsolveGrid\b/, /\bgradePuzzle\b/, /\bbacktrack/i]
  for (const pattern of forbidden) {
    const match = pattern.exec(code)
    must(match === null, 'forbidden runtime algorithm ' + String(pattern) + ' at line ' + (match ? code.slice(0, match.index).split('\n').length : '?'))
  }
  must(!/function\s+solve\s*\(/.test(code), 'runtime must not define solve()')
})

runner.check('v2 static UI: 5 difficulty chips, level labels, data hooks and overlays', () => {
  for (const gradeKey of GRADE_KEYS) {
    const label = GRADE_LABELS[gradeKey]
    must(code.indexOf(label) !== -1, 'missing difficulty label literal ' + label)
  }
  for (const literal of ['简单', '普通', '困难', '专家', '地狱']) {
    must(code.indexOf(literal) !== -1, 'missing difficulty label ' + literal)
  }
  // labels must be bank-driven (or at least reference the bank levels)
  must(/BANK\.levels|PUZZLE_BANK\.levels|LEVELS/.test(code), 'difficulty chips should be driven by the bank LEVELS')
  for (const hook of ['data-difficulty', 'data-sudoku-board', 'data-cell', 'data-given', 'data-value', 'data-selected', 'data-peer', 'data-conflict', 'data-digit', 'data-action', 'data-overlay', 'data-role']) {
    must(code.indexOf(hook) !== -1, 'missing data hook ' + hook)
  }
  for (const action of ['dismiss-win', 'confirm', 'cancel', 'erase', 'notes', 'undo', 'restart']) {
    must(code.indexOf(action) !== -1, 'missing action literal ' + action)
  }
  for (const role of ['timer', 'remaining', 'too-small']) must(code.indexOf(role) !== -1, 'missing data-role ' + role)
  must(/aria-pressed/.test(code), 'difficulty chips should expose aria-pressed')
  must(/(['"])win\1/.test(code), 'win overlay literal')
  must(/grade/.test(code), 'grade must appear in the UI')
})

runner.check('v2 static UI: root sizing, keyboard isolation, timer/cleanup wiring, no canvas', () => {
  must(/['"]data-dsh-game['"]\s*:\s*(['"]sudoku['"]|GAME_ID\b)/.test(code), 'root data-dsh-game')
  must(/width\s*:\s*['"]100%['"]/.test(code), 'root width 100%')
  must(/height\s*:\s*['"]100%['"]/.test(code), 'root height 100%')
  must(/boxSizing\s*:\s*['"]border-box['"]/.test(code), 'root border-box')
  must(/tabIndex\s*:\s*0/.test(code), 'root tabIndex 0')
  must(!/(?:window|document|globalThis)\s*\.\s*addEventListener\s*\(\s*['"`]keydown/.test(code), 'no global keydown listener')
  must(/onKeyDown/.test(code), 'component-root keyboard handler')
  must(/clearInterval\s*\(/.test(code), 'clearInterval cleanup')
  must(/removeEventListener\s*\(/.test(code), 'removeEventListener cleanup')
  must(/\.disconnect\s*\(/.test(code), 'ResizeObserver.disconnect cleanup')
  must(/visibilitychange/.test(code), 'visibilitychange handler')
  must(/setInterval\s*\(/.test(code), 'timer interval')
  must(/ResizeObserver/.test(code), 'ResizeObserver')
  must(!/window\.innerWidth|window\.innerHeight/.test(code), 'do not read window.innerWidth/innerHeight')
  must(!/getContext\s*\(/.test(code), 'no canvas rendering')
  requirePattern('320 too-small threshold', /320/, code)
  requirePattern('240 too-small threshold', /240/, code)
  requirePattern('STORE_KEY literal', /dsh\.game\.sudoku\.v1/, code)
  const errors = []
  let from = 0
  let at
  while ((at = code.indexOf('console.error(', from)) !== -1) {
    const chunk = code.slice(at, at + 260)
    if (chunk.indexOf('[dsh-game-sudoku]') === -1) errors.push(code.slice(0, at).split('\n').length)
    from = at + 1
  }
  must(errors.length === 0, 'console.error without [dsh-game-sudoku] prefix on lines ' + errors.join(','))
  const requires = []
  const re = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g
  let match
  while ((match = re.exec(code)) !== null) requires.push(match[2])
  must(requires.every((id) => id === 'react'), 'only require("react") is allowed, got ' + JSON.stringify(requires))
  must(/\(function\s*\(\)\s*\{[\s\S]{0,200}?['"]use strict['"]/.test(code), 'single strict-mode IIFE')
  must(!/^\s*(import|export)\s/m.test(code), 'no ESM import/export statements in client.js')
})

function requirePattern(label, pattern, text) {
  must(pattern.test(text), label + ': missing expected pattern ' + String(pattern))
}

const summary = runner.summary()
for (const [key, value] of Object.entries(EVIDENCE)) {
  if (value !== undefined) console.log('EVIDENCE ' + key + ' ' + JSON.stringify(value))
}
console.log('RESULT v2 save ' + JSON.stringify(summary))
