/**
 * Audit 3/3 — pure-logic semantics per api-spec §4, timer/win/undo behaviour,
 * serialization and save sanitisation robustness (incl. >=2000-input fuzz).
 *
 * Run: node dev/audit/audit-state.mjs
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
  auditRng,
  countEmpty as refCountEmpty,
  emptyBoard,
  refConflicts,
  refConsistent,
  refIsSolved,
  refIsValidSolution,
  refSolve,
} from './reference.mjs'

if (!clientExists()) {
  console.log('WAITING: client.js does not exist yet at ' + CLIENT_FILE)
  process.exit(2)
}

const runner = createRunner('state/save audit')
const loaded = await loadClient({ testFlag: true, tag: 'state' })
const api = requireClient(loaded.api)
const storage = loaded.storage

const EVIDENCE = {}
const STORE_KEY = 'dsh.game.sudoku.v1'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function freshState({ difficulty = 'easy', seed = 1234, now = 1000 } = {}) {
  return api.createState({ difficulty, rng: api.createRng(seed), now })
}

function emptyCells(state) {
  const cells = []
  for (let index = 0; index < 81; index += 1) if (state.givens[index] === 0) cells.push(index)
  return cells
}

function givenCells(state) {
  const cells = []
  for (let index = 0; index < 81; index += 1) if (state.givens[index] !== 0) cells.push(index)
  return cells
}

function assertBoardMatchesGivens(state, label) {
  for (let index = 0; index < 81; index += 1) {
    if (state.givens[index] !== 0) {
      assert.equal(state.board[index], state.givens[index], label + ': given cell ' + index + ' must equal givens')
    }
  }
}

function snapshotState(state) {
  return clone({
    difficulty: state.difficulty,
    targetGivens: state.targetGivens,
    givens: state.givens,
    solution: state.solution,
    board: state.board,
    notes: state.notes,
    selected: state.selected,
    notesMode: state.notesMode,
    elapsedMs: state.elapsedMs,
    runningSince: state.runningSince,
    won: state.won,
    winAcked: state.winAcked,
    undo: state.undo,
  })
}

function makeWinState({ difficulty = 'easy', seed = 4321, startNow = 5000 } = {}) {
  const state = freshState({ difficulty, seed, now: startNow })
  let now = startNow
  const empties = emptyCells(state)
  for (let k = 0; k < empties.length; k += 1) {
    now += 10
    const index = empties[k]
    const changed = api.applyDigit(state, index, state.solution[index], now)
    must(changed === true, 'filling cell ' + index + ' during win setup must return true')
    if (k < empties.length - 1) must(state.won === false, 'won must stay false before the final cell')
  }
  must(state.won === true, 'state must be won after filling the last cell')
  return { state, lastNow: now, startNow }
}

/** Invariants every non-null sanitised state must satisfy (independent oracle). */
function assertSanitisedInvariants(state, label) {
  must(state && typeof state === 'object' && !Array.isArray(state), label + ': sanitize must return a plain object')
  // The returned value is an internal state (api-spec §5), not the raw §6 save:
  // schemaVersion only exists on the serialized envelope.
  if ('schemaVersion' in state) assert.equal(state.schemaVersion, 1, label + ': schemaVersion (if present)')
  assert.ok(['easy', 'normal', 'hard'].includes(state.difficulty), label + ': difficulty')
  assert.ok(Array.isArray(state.givens) && state.givens.length === 81, label + ': givens length')
  assert.ok(state.givens.every((value) => Number.isInteger(value) && value >= 0 && value <= 9), label + ': givens cells')
  assert.ok(state.givens.filter((value) => value !== 0).length >= 17, label + ': at least 17 givens required')
  assert.deepEqual(refConflicts(state.givens), new Array(81).fill(0), label + ': givens must be conflict-free')
  assert.ok(Array.isArray(state.solution) && state.solution.length === 81, label + ': solution length')
  assert.ok(state.solution.every((value) => Number.isInteger(value) && value >= 1 && value <= 9), label + ': solution cells')
  assert.ok(refIsValidSolution(state.solution), label + ': solution must be a legal complete grid')
  assert.ok(refConsistent(state.givens, state.solution), label + ': solution must match givens')
  assert.ok(Array.isArray(state.board) && state.board.length === 81, label + ': board length')
  assert.ok(state.board.every((value) => Number.isInteger(value) && value >= 0 && value <= 9), label + ': board cells')
  assertBoardMatchesGivens(state, label)
  assert.ok(Array.isArray(state.notes) && state.notes.length === 81, label + ': notes length')
  assert.ok(state.notes.every((value) => Number.isInteger(value) && value >= 0 && value <= 511), label + ': notes cells')
  for (let index = 0; index < 81; index += 1) {
    if (state.givens[index] !== 0 || state.board[index] !== 0) {
      assert.equal(state.notes[index], 0, label + ': notes must be 0 on givens and filled cells (cell ' + index + ')')
    }
  }
  assert.ok(Number.isInteger(state.elapsedMs) && state.elapsedMs >= 0 && state.elapsedMs <= 604800000, label + ': elapsedMs range')
  assert.ok(state.selected === null || (Number.isInteger(state.selected) && state.selected >= 0 && state.selected <= 80), label + ': selected range')
  assert.equal(typeof state.notesMode, 'boolean', label + ': notesMode boolean')
  assert.equal(typeof state.won, 'boolean', label + ': won boolean')
  assert.equal(typeof state.winAcked, 'boolean', label + ': winAcked boolean')
  assert.equal(state.won, refIsSolved(state.board), label + ': won must be recomputed from the board')
  assert.ok(Array.isArray(state.undo), label + ': undo must be an array')
  assert.ok(state.undo.length <= 300, label + ': undo must be capped at 300, got ' + state.undo.length)
  for (const entry of state.undo) {
    assert.ok(entry && typeof entry === 'object', label + ': undo entries must be objects')
    assert.ok(Number.isInteger(entry.index) && entry.index >= 0 && entry.index <= 80, label + ': undo index range')
    assert.equal(state.givens[entry.index], 0, label + ': undo entries must target non-given cells')
    assert.ok(Number.isInteger(entry.prevValue) && entry.prevValue >= 0 && entry.prevValue <= 9, label + ': undo prevValue')
    assert.ok(Number.isInteger(entry.prevNotes) && entry.prevNotes >= 0 && entry.prevNotes <= 511, label + ': undo prevNotes')
  }
  if (typeof state.runningSince !== 'undefined') assert.equal(state.runningSince, null, label + ': runningSince must be null after restore')
}

function validRaw({ seed = 111, difficulty = 'easy', now = 777 } = {}) {
  const state = freshState({ difficulty, seed, now })
  const empties = emptyCells(state)
  api.selectCell(state, empties[0])
  api.applyDigit(state, empties[0], state.solution[empties[0]], now + 100)
  api.applyDigit(state, empties[1], state.solution[empties[1]], now + 200)
  api.toggleNotesMode(state)
  api.applyDigit(state, empties[2], 3, now + 300)
  api.toggleNotesMode(state)
  return api.serializeState(state)
}

// ---------------------------------------------------------------------------
// createState
// ---------------------------------------------------------------------------
runner.check('createState yields a clean, well-formed initial state', () => {
  const state = freshState({ difficulty: 'easy', seed: 11, now: 1000 })
  assert.equal(state.difficulty, 'easy')
  assert.equal(state.targetGivens, 40)
  assert.ok(Array.isArray(state.givens) && state.givens.length === 81)
  assert.ok(Array.isArray(state.solution) && state.solution.length === 81)
  assert.ok(refIsValidSolution(state.solution))
  assert.ok(refConsistent(state.givens, state.solution))
  assert.equal(state.givens.filter((value) => value !== 0).length, state.givensCount !== undefined ? state.givensCount : 40)
  assert.deepEqual(state.board, state.givens, 'fresh board must equal givens')
  assert.deepEqual(state.notes, new Array(81).fill(0))
  assert.equal(state.selected, null)
  assert.equal(state.notesMode, false)
  assert.equal(state.elapsedMs, 0)
  assert.equal(state.runningSince, 1000)
  assert.equal(state.won, false)
  assert.equal(state.winAcked, false)
  assert.ok(Array.isArray(state.undo) && state.undo.length === 0)
  assert.equal(api.timerElapsed(state, 1000), 0)
  assert.equal(api.hasProgress(state), false)
})

runner.check('createState matches generatePuzzle for the same seed', () => {
  const state = freshState({ difficulty: 'normal', seed: 777, now: 0 })
  const generated = api.generatePuzzle('normal', api.createRng(777))
  assert.deepEqual(state.givens, generated.givens)
  assert.deepEqual(state.solution, generated.solution)
  assert.equal(state.targetGivens, 34)
})

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------
runner.check('selectCell accepts any 0..80 cell (givens included) and rejects bad indices', () => {
  const state = freshState({ seed: 21 })
  const empties = emptyCells(state)
  const givens = givenCells(state)
  assert.equal(api.selectCell(state, empties[0]), true)
  assert.equal(state.selected, empties[0])
  assert.equal(api.selectCell(state, givens[0]), true, 'selecting a given cell must be allowed for highlighting')
  assert.equal(state.selected, givens[0])
  const before = state.selected
  for (const bad of [-1, 81, 1.5, '3', null, undefined, NaN]) {
    assert.equal(api.selectCell(state, bad), false, 'selectCell(' + String(bad) + ') must be false')
    assert.equal(state.selected, before, 'bad selection must not change the selection')
  }
})

runner.check('moveSelection moves and clamps inside the 9x9 grid', () => {
  const state = freshState({ seed: 22 })
  state.selected = 40 // r4 c4
  assert.equal(api.moveSelection(state, 1, 0), true)
  assert.equal(state.selected, 49, 'down one row from r4c4')
  assert.equal(api.moveSelection(state, 0, 1), true)
  assert.equal(state.selected, 50, 'right one column')
  assert.equal(api.moveSelection(state, -1, 0), true)
  assert.equal(state.selected, 41)
  // clamping
  state.selected = 0
  api.moveSelection(state, -1, 0)
  assert.equal(state.selected, 0, 'must clamp at the top')
  state.selected = 8
  api.moveSelection(state, 0, 1)
  assert.equal(state.selected, 8, 'must clamp at the right edge')
  state.selected = 72
  api.moveSelection(state, 1, 0)
  assert.equal(state.selected, 72, 'must clamp at the bottom edge')
  state.selected = 40
  api.moveSelection(state, 5, 5)
  assert.equal(state.selected, 80, 'large delta must clamp to the last cell')
  // no selection -> base cell 0
  state.selected = null
  assert.equal(api.moveSelection(state, 0, 1), true)
  assert.equal(state.selected, 1, 'unselected movement starts from cell 0')
  state.selected = null
  api.moveSelection(state, 1, 0)
  assert.equal(state.selected, 9)
})

// ---------------------------------------------------------------------------
// applyDigit / notes / erase / undo
// ---------------------------------------------------------------------------
runner.check('applyDigit bounds and given-cell guards are no-ops', () => {
  const state = freshState({ seed: 23, now: 1000 })
  const empty = emptyCells(state)[0]
  const given = givenCells(state)[0]
  const before = snapshotState(state)
  for (const badIndex of [-1, 81, 1.5, '3', null]) {
    assert.equal(api.applyDigit(state, badIndex, 5, 1010), false)
  }
  for (const badDigit of [0, 10, -1, 1.5, '3', null]) {
    assert.equal(api.applyDigit(state, empty, badDigit, 1010), false)
  }
  assert.equal(api.applyDigit(state, given, 5, 1010), false, 'given cells must never change')
  assert.deepEqual(snapshotState(state), before, 'rejected calls must have no side effects')
})

runner.check('applyDigit sets a value, pushes undo, and a repeated digit is a no-op', () => {
  const state = freshState({ seed: 24, now: 1000 })
  const empty = emptyCells(state)[0]
  const digit = (state.solution[empty] % 9) + 1 // deliberately not the solution value in most cases
  assert.equal(api.applyDigit(state, empty, digit, 1500), true)
  assert.equal(state.board[empty], digit)
  assert.equal(state.notes[empty], 0)
  assert.equal(state.undo.length, 1)
  assert.deepEqual(state.undo[0], { index: empty, prevValue: 0, prevNotes: 0 })
  assert.equal(state.runningSince, 1000, 'typing must not restart the timer')
  assert.equal(api.timerElapsed(state, 1500), 500)
  // same digit again: no auto-erase, no second undo entry
  assert.equal(api.applyDigit(state, empty, digit, 1600), false, 'same digit must return false')
  assert.equal(state.board[empty], digit)
  assert.equal(state.undo.length, 1)
  // different digit overwrites and pushes another undo entry
  const other = digit === 9 ? 8 : 9
  assert.equal(api.applyDigit(state, empty, other, 1700), true)
  assert.equal(state.board[empty], other)
  assert.equal(state.undo.length, 2)
  assert.deepEqual(state.undo[1], { index: empty, prevValue: digit, prevNotes: 0 })
})

runner.check('applyDigit allows a conflicting value (red conflict hint) and computeConflicts sees it', () => {
  const state = freshState({ seed: 25, now: 0 })
  const empties = emptyCells(state)
  // Find an empty cell that shares a unit with a given digit different from its solution.
  let target = -1
  let conflictingDigit = -1
  for (const empty of empties) {
    for (let index = 0; index < 81; index += 1) {
      if (index === empty || state.givens[index] === 0) continue
      const sameRow = Math.floor(index / 9) === Math.floor(empty / 9)
      const sameCol = index % 9 === empty % 9
      const sameBox =
        Math.floor(Math.floor(index / 9) / 3) === Math.floor(Math.floor(empty / 9) / 3) &&
        Math.floor((index % 9) / 3) === Math.floor((empty % 9) / 3)
      if ((sameRow || sameCol || sameBox) && state.givens[index] !== state.solution[empty]) {
        target = empty
        conflictingDigit = state.givens[index]
        break
      }
    }
    if (target !== -1) break
  }
  must(target !== -1, 'could not find a cell that allows a conflicting digit')
  assert.equal(api.applyDigit(state, target, conflictingDigit, 10), true, 'conflicting digits must be accepted')
  assert.equal(state.board[target], conflictingDigit)
  assert.equal(api.computeConflicts(state.board)[target], 1, 'conflict must be reported')
  assert.equal(state.won, false)
})

runner.check('notes mode toggles pencil marks, counts undo, and guards filled cells', () => {
  const state = freshState({ seed: 26, now: 0 })
  const empty = emptyCells(state)[0]
  assert.equal(state.notesMode, false)
  assert.equal(api.toggleNotesMode(state), true)
  assert.equal(state.notesMode, true)
  assert.equal(api.applyDigit(state, empty, 3, 10), true, 'pencil mark must be a change')
  assert.equal(state.board[empty], 0, 'notes mode must not write a value')
  assert.equal(state.notes[empty], 1 << 2)
  assert.equal(state.undo.length, 1)
  assert.equal(api.applyDigit(state, empty, 3, 20), true, 'toggling the same mark off is a change')
  assert.equal(state.notes[empty], 0)
  assert.equal(state.undo.length, 2)
  assert.equal(api.applyDigit(state, empty, 7, 30), true)
  assert.equal(state.notes[empty], 1 << 6)
  // a filled cell cannot take notes
  api.toggleNotesMode(state) // back to normal mode
  api.applyDigit(state, empty, 5, 40)
  api.toggleNotesMode(state) // notes mode on again
  assert.equal(api.applyDigit(state, empty, 2, 50), false, 'notes mode on a filled cell must be false')
  assert.equal(state.notes[empty], 0, 'filled cells keep notes at 0')
  // undo restores the mark's previous state
  api.toggleNotesMode(state) // normal
  assert.equal(api.undoMove(state, 60), true)
  assert.equal(state.board[empty], 0, 'undo must remove the value')
  assert.equal(state.notes[empty], 1 << 6, 'undo must restore the pencil mark snapshot')
})

runner.check('filling a value clears that cell’s notes and the undo entry records prevNotes', () => {
  const state = freshState({ seed: 27, now: 0 })
  const empty = emptyCells(state)[0]
  api.toggleNotesMode(state)
  api.applyDigit(state, empty, 1, 10)
  api.applyDigit(state, empty, 4, 20)
  assert.equal(state.notes[empty], (1 << 0) | (1 << 3))
  api.toggleNotesMode(state)
  assert.equal(api.applyDigit(state, empty, 9, 30), true)
  assert.equal(state.notes[empty], 0, 'filling a value must clear notes')
  const entry = state.undo[state.undo.length - 1]
  assert.equal(entry.index, empty)
  assert.equal(entry.prevValue, 0)
  assert.equal(entry.prevNotes, (1 << 0) | (1 << 3))
  assert.equal(api.undoMove(state, 40), true)
  assert.equal(state.board[empty], 0)
  assert.equal(state.notes[empty], (1 << 0) | (1 << 3), 'undo must restore the pencil marks')
})

runner.check('eraseCell guards and clears value+notes', () => {
  const state = freshState({ seed: 28, now: 0 })
  const givens = givenCells(state)
  const empties = emptyCells(state)
  assert.equal(api.eraseCell(state, givens[0], 10), false, 'given cells are not erasable')
  assert.equal(api.eraseCell(state, empties[0], 10), false, 'an untouched empty cell is a no-op')
  assert.equal(api.applyDigit(state, empties[0], 5, 20), true)
  assert.equal(api.eraseCell(state, empties[0], 30), true)
  assert.equal(state.board[empties[0]], 0)
  assert.equal(state.notes[empties[0]], 0)
  assert.equal(state.undo.length, 2)

  // Notes-only cell: spec §4 says "本来就空 -> false" while §10.7 expects erasing
  // to clear pencil marks; both readings are defensible, record the behaviour.
  const noteState = freshState({ seed: 29, now: 0 })
  const noteCell = emptyCells(noteState)[0]
  api.toggleNotesMode(noteState)
  api.applyDigit(noteState, noteCell, 2, 10)
  const undoBefore = noteState.undo.length
  const notesBefore = noteState.notes[noteCell]
  const erased = api.eraseCell(noteState, noteCell, 20)
  if (erased === true) {
    assert.equal(noteState.notes[noteCell], 0, 'eraseCell returning true must clear the notes')
    assert.ok(noteState.undo.length > undoBefore, 'a successful erase pushes undo')
  } else {
    must(noteState.notes[noteCell] === notesBefore, 'eraseCell returning false must not clear notes')
    runner.note(
      'AMBIGUITY: eraseCell(notes-only cell) returns false (spec §4 literal wording); spec §10.7 "擦除清草稿" arguably implies true. Accepted both readings.',
    )
  }
})

runner.check('undoMove is LIFO, no-ops on an empty stack, and restores value+notes', () => {
  const state = freshState({ seed: 30, now: 0 })
  const empties = emptyCells(state)
  assert.equal(api.undoMove(state, 5), false, 'empty undo stack is a no-op')
  assert.equal(api.applyDigit(state, empties[0], 1, 10), true)
  assert.equal(api.applyDigit(state, empties[1], 2, 20), true)
  assert.equal(api.applyDigit(state, empties[2], 3, 30), true)
  assert.equal(state.undo.length, 3)
  assert.equal(api.undoMove(state, 40), true)
  assert.equal(state.board[empties[2]], 0, 'LIFO: undo the last change first')
  assert.equal(state.board[empties[1]], 2)
  assert.equal(api.undoMove(state, 50), true)
  assert.equal(state.board[empties[1]], 0)
  assert.equal(state.board[empties[0]], 1)
  assert.equal(api.undoMove(state, 60), true)
  assert.equal(state.board[empties[0]], 0)
  assert.equal(state.undo.length, 0)
  assert.equal(api.undoMove(state, 70), false)
  assert.equal(state.runningSince, 0, 'undo must not restart the timer')
})

runner.check('undoMove skips corrupt entries that target given cells', () => {
  const state = freshState({ seed: 31, now: 0 })
  const empty = emptyCells(state)[0]
  const given = givenCells(state)[0]
  api.applyDigit(state, empty, 4, 10)
  // Corrupt entry on top of the stack (simulating a hand-edited save).
  state.undo.push({ index: given, prevValue: 0, prevNotes: 0 })
  assert.equal(api.undoMove(state, 20), true, 'a corrupt top entry must be skipped and the next one undone')
  assert.equal(state.board[empty], 0)
  assert.equal(state.undo.length, 0, 'both the corrupt entry and the undone entry are removed')
  state.undo.push({ index: given, prevValue: 0, prevNotes: 0 })
  assert.equal(api.undoMove(state, 30), false, 'only corrupt entries left: false')
  assert.equal(state.undo.length, 0, 'corrupt entries are consumed, not left behind')
})

runner.check('undo stack is capped at UNDO_LIMIT (300)', () => {
  const state = freshState({ seed: 32, now: 0 })
  const cell = emptyCells(state)[0]
  let now = 0
  for (let round = 0; round < 320; round += 1) {
    now += 1
    if (round % 2 === 0) {
      api.applyDigit(state, cell, 5, now)
    } else {
      api.eraseCell(state, cell, now)
    }
  }
  assert.equal(state.undo.length, 300, 'undo stack must be capped at 300')
})

// ---------------------------------------------------------------------------
// restart / newPuzzle
// ---------------------------------------------------------------------------
runner.check('restartPuzzle resets the puzzle but keeps question, difficulty and valid selection', () => {
  const state = freshState({ seed: 33, now: 1000 })
  const givensBefore = state.givens.slice()
  const solutionBefore = state.solution.slice()
  const empties = emptyCells(state)
  api.selectCell(state, empties[0])
  api.applyDigit(state, empties[0], 5, 1500)
  api.applyDigit(state, empties[1], state.solution[empties[1]], 2000)
  api.toggleNotesMode(state)
  api.applyDigit(state, empties[2], 2, 2500)
  api.toggleNotesMode(state)
  must(state.undo.length > 0)
  api.restartPuzzle(state, 9000)
  assert.deepEqual(state.board, givensBefore, 'board must return to the givens')
  assert.deepEqual(state.notes, new Array(81).fill(0))
  assert.equal(state.undo.length, 0)
  assert.equal(state.elapsedMs, 0)
  assert.equal(state.runningSince, 9000, 'restart restarts the timer')
  assert.equal(state.won, false)
  assert.equal(state.winAcked, false)
  assert.deepEqual(state.givens, givensBefore, 'question must not change')
  assert.deepEqual(state.solution, solutionBefore)
  assert.equal(state.selected, empties[0], 'valid selection is retained')
  assert.equal(api.timerElapsed(state, 9000), 0)
})

runner.check('restartPuzzle drops an out-of-range selection', () => {
  const state = freshState({ seed: 34, now: 0 })
  state.selected = 999
  api.restartPuzzle(state, 100)
  assert.equal(state.selected, null)
})

runner.check('newPuzzle replaces the question, resets progress/timer and keeps valid difficulty', () => {
  const state = freshState({ seed: 35, now: 1000 })
  const oldGivens = state.givens.slice()
  const empties = emptyCells(state)
  api.selectCell(state, empties[0])
  api.applyDigit(state, empties[0], 3, 1500)
  const rng = api.createRng(9876)
  api.newPuzzle(state, 'hard', rng, 7000)
  assert.equal(state.difficulty, 'hard')
  assert.equal(state.targetGivens, 28)
  const expected = api.generatePuzzle('hard', api.createRng(9876))
  assert.deepEqual(state.givens, expected.givens, 'newPuzzle must use the provided rng deterministically')
  assert.notDeepEqual(state.givens, oldGivens, 'newPuzzle must change the question')
  assert.deepEqual(state.board, state.givens)
  assert.deepEqual(state.notes, new Array(81).fill(0))
  assert.equal(state.undo.length, 0)
  assert.equal(state.elapsedMs, 0)
  assert.equal(state.runningSince, 7000)
  assert.equal(state.won, false)
  assert.equal(state.winAcked, false)
  assert.equal(state.selected, null)
  assert.equal(state.givens.filter((value) => value !== 0).length, 28)
})

runner.check('newPuzzle with an invalid difficulty falls back to normal', () => {
  const state = freshState({ seed: 36, now: 0 })
  api.newPuzzle(state, 'bogus', api.createRng(5), 1)
  assert.equal(state.difficulty, 'normal')
  assert.equal(state.targetGivens, 34)
})

// ---------------------------------------------------------------------------
// timers
// ---------------------------------------------------------------------------
runner.check('timer pause/resume/elapsed semantics with fake now', () => {
  const state = freshState({ seed: 37, now: 1000 })
  assert.equal(api.timerElapsed(state, 1000), 0)
  assert.equal(api.timerElapsed(state, 1500), 500)
  assert.equal(api.timerElapsed(state, 900), 0, 'negative delta must clamp to 0')
  api.timerPause(state, 1500)
  assert.equal(state.elapsedMs, 500)
  assert.equal(state.runningSince, null)
  assert.equal(api.timerElapsed(state, 999999), 500, 'paused timer must not advance')
  api.timerPause(state, 2000) // idempotent
  assert.equal(state.elapsedMs, 500)
  api.timerResume(state, 2000)
  assert.equal(state.runningSince, 2000)
  assert.equal(api.timerElapsed(state, 2500), 1000)
  api.timerResume(state, 3000) // idempotent: already running
  assert.equal(state.runningSince, 2000, 'repeated resume must not reset the start')
  assert.equal(api.timerElapsed(state, 3000), 1500)
  // pause in the past clamps
  const other = freshState({ seed: 38, now: 1000 })
  api.timerPause(other, 400)
  assert.equal(other.elapsedMs, 0)
  assert.equal(other.runningSince, null)
})

// ---------------------------------------------------------------------------
// win
// ---------------------------------------------------------------------------
runner.check('winning pauses the timer, flags won/winAcked and rejects further edits', () => {
  const { state, lastNow, startNow } = makeWinState({ seed: 4321 })
  assert.equal(state.won, true)
  assert.equal(state.winAcked, false)
  assert.equal(state.runningSince, null, 'win must pause the timer')
  assert.equal(state.elapsedMs, lastNow - startNow, 'elapsed must be frozen at the winning move')
  assert.equal(api.timerElapsed(state, lastNow + 10000), state.elapsedMs)
  assert.equal(api.countEmpty(state.board), 0)
  assert.ok(refIsSolved(state.board))
  // givens intentionally keep their 41 zeros for this puzzle; the *board* must be full.
  assert.equal(state.board.filter((value) => value !== 0).length, 81, 'board must be completely filled after the win')
  // every editing call is disabled after the win
  const before = snapshotState(state)
  const anyIndex = givenCells(state)[0]
  assert.equal(api.applyDigit(state, anyIndex, 1, lastNow + 10), false)
  assert.equal(api.eraseCell(state, anyIndex, lastNow + 10), false)
  assert.equal(api.undoMove(state, lastNow + 10), false, 'undo must be disabled after a win')
  assert.deepEqual(snapshotState(state), before, 'apply/erase/undo must have no side effects after winning')
})

runner.check('won state also freezes pencil mode (api-spec §4 "won 禁止…草稿")', () => {
  const { state } = makeWinState({ seed: 4321 })
  const notesModeBefore = state.notesMode
  const undoBefore = state.undo.length
  const snapshotBefore = snapshotState(state)
  const toggled = api.toggleNotesMode(state)
  assert.equal(toggled, false, 'toggleNotesMode must return false once the game is won')
  assert.equal(state.notesMode, notesModeBefore, 'toggleNotesMode must not change notesMode after a win')
  assert.equal(state.undo.length, undoBefore)
  assert.deepEqual(snapshotState(state), snapshotBefore, 'toggleNotesMode must have no side effects after a win')
})

runner.check('restartPuzzle after a win resets won/winAcked and restarts the timer', () => {
  const { state } = makeWinState({ seed: 4322 })
  api.restartPuzzle(state, 999999)
  assert.equal(state.won, false)
  assert.equal(state.winAcked, false)
  assert.equal(state.runningSince, 999999)
  assert.equal(state.elapsedMs, 0)
  assert.deepEqual(state.board, state.givens)
  assert.equal(state.undo.length, 0)
})

runner.check('newPuzzle after a win clears won/winAcked', () => {
  const { state } = makeWinState({ seed: 4323 })
  api.newPuzzle(state, 'normal', api.createRng(14), 100)
  assert.equal(state.won, false)
  assert.equal(state.winAcked, false)
  assert.equal(state.difficulty, 'normal')
  assert.deepEqual(state.board, state.givens)
})

runner.check('getSnapshot mirrors the live state without mutating it', () => {
  const state = freshState({ seed: 39, now: 1000 })
  const empty = emptyCells(state)[0]
  api.selectCell(state, empty)
  api.toggleNotesMode(state)
  api.applyDigit(state, empty, 3, 1500)
  api.toggleNotesMode(state)
  const before = snapshotState(state)
  const snapshot = api.getSnapshot(state, 2000)
  must(snapshot && typeof snapshot === 'object', 'getSnapshot must return an object')
  assert.deepEqual(snapshotState(state), before, 'getSnapshot must not mutate the state')
  // The spec does not freeze the snapshot shape: verify every field it does expose,
  // and record (do not fail) fields that are absent.
  const present = Object.keys(snapshot)
  EVIDENCE.snapshotKeys = present.slice().sort()
  const fieldChecks = {
    board: (value) => assert.deepEqual(value, state.board),
    notes: (value) => assert.deepEqual(value, state.notes),
    won: (value) => assert.equal(value, state.won),
    notesMode: (value) => assert.equal(value, state.notesMode),
    difficulty: (value) => assert.equal(value, state.difficulty),
    selected: (value) => assert.equal(value, state.selected),
    givens: (value) => assert.deepEqual(value, state.givens),
    solution: (value) => assert.deepEqual(value, state.solution),
    winAcked: (value) => assert.equal(value, state.winAcked),
    elapsedMs: (value) => assert.equal(value, api.timerElapsed(state, 2000)),
    remaining: (value) => assert.equal(value, api.countEmpty(state.board)),
    running: (value) => assert.equal(value, state.runningSince !== null),
    timerText: (value) => assert.equal(value, api.formatTime(api.timerElapsed(state, 2000))),
    conflicts: (value) => assert.deepEqual(value, api.computeConflicts(state.board)),
    canUndo: (value) => assert.equal(value, state.undo.length > 0 && state.won !== true),
  }
  for (const [key, verify] of Object.entries(fieldChecks)) {
    if (key in snapshot) verify(snapshot[key])
  }
  for (const requiredKey of ['board', 'won']) {
    if (!(requiredKey in snapshot)) {
      runner.note('AMBIGUITY: getSnapshot lacks "' + requiredKey + '" (spec does not freeze the snapshot shape); keys=' + present.join(','))
    }
  }
  const winSnapshot = api.getSnapshot(makeWinState({ seed: 4324 }).state, 0)
  if ('won' in winSnapshot) {
    assert.equal(winSnapshot.won, true)
    assert.equal(winSnapshot.winAcked, false)
  }
})

// ---------------------------------------------------------------------------
// formatTime
// ---------------------------------------------------------------------------
runner.check('formatTime matches mm:ss / h:mm:ss boundaries', () => {
  const table = [
    [0, '00:00'],
    [1, '00:00'],
    [999, '00:00'],
    [1000, '00:01'],
    [59999, '00:59'],
    [60000, '01:00'],
    [600000, '10:00'],
    [3599000, '59:59'],
    [3599999, '59:59'],
    [3600000, '1:00:00'],
    [3661000, '1:01:01'],
    [36000000, '10:00:00'],
  ]
  for (const [ms, expected] of table) {
    assert.equal(api.formatTime(ms), expected, 'formatTime(' + ms + ')')
  }
  EVIDENCE.formatTimeTable = table.length
})

// ---------------------------------------------------------------------------
// serialize / save / load
// ---------------------------------------------------------------------------
runner.check('serializeState produces the frozen §6 schema (no runningSince leaked)', () => {
  const raw = validRaw({ seed: 111, difficulty: 'easy', now: 777 })
  assert.equal(raw.schemaVersion, 1)
  for (const key of [
    'difficulty',
    'targetGivens',
    'givens',
    'solution',
    'board',
    'notes',
    'selected',
    'notesMode',
    'elapsedMs',
    'won',
    'winAcked',
    'undo',
  ]) {
    assert.ok(key in raw, 'serializeState must expose ' + key)
  }
  assert.ok(!('runningSince' in raw), 'runningSince is memory-only and must not be serialized')
  assert.ok(Array.isArray(raw.givens) && raw.givens.length === 81)
  assert.ok(Array.isArray(raw.solution) && raw.solution.length === 81)
  assert.ok(Array.isArray(raw.board) && raw.board.length === 81)
  assert.ok(Array.isArray(raw.notes) && raw.notes.length === 81)
  assert.ok(Array.isArray(raw.undo))
  assert.ok(Number.isInteger(raw.elapsedMs) && raw.elapsedMs >= 0)
  assert.equal(typeof raw.won, 'boolean')
  assert.equal(typeof raw.winAcked, 'boolean')
  assert.equal(typeof raw.notesMode, 'boolean')
  // must be plain JSON data
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), raw)
  EVIDENCE.serializedKeys = Object.keys(raw).sort()
})

runner.check('serialize → sanitize round-trip preserves the game', () => {
  const raw = validRaw({ seed: 112, now: 888 })
  const restored = api.sanitizeSave(clone(raw))
  must(restored !== null, 'a freshly serialized save must sanitize successfully')
  assertSanitisedInvariants(restored, 'roundtrip')
  for (const key of ['difficulty', 'givens', 'solution', 'board', 'notes', 'selected', 'notesMode', 'won', 'winAcked']) {
    assert.deepEqual(restored[key], raw[key], 'roundtrip changed ' + key)
  }
  assert.equal(restored.elapsedMs, raw.elapsedMs)
  assert.deepEqual(restored.undo, raw.undo, 'roundtrip must keep the undo stack')
})

runner.check('saveState writes exactly STORE_KEY and loadSavedState restores the same game', () => {
  storage.failGet = false
  storage.failSet = false
  storage.map.clear()
  const state = freshState({ seed: 113, now: 100 })
  const empties = emptyCells(state)
  api.applyDigit(state, empties[0], 4, 200)
  api.toggleNotesMode(state)
  api.applyDigit(state, empties[1], 7, 300)
  api.toggleNotesMode(state)
  api.selectCell(state, empties[2])
  api.timerPause(state, 400)
  const raw = api.serializeState(state)
  assert.equal(api.saveState(state), true, 'saveState must return true on success')
  assert.equal(storage.map.size, 1, 'only one storage key may be written')
  assert.ok(storage.map.has(STORE_KEY), 'the save must use ' + STORE_KEY)
  const stored = JSON.parse(storage.map.get(STORE_KEY))
  assert.equal(stored.schemaVersion, 1)
  assert.deepEqual(stored, raw, 'saveState must persist serializeState(state)')

  const restored = api.loadSavedState()
  must(restored !== null, 'loadSavedState must restore a valid save')
  assertSanitisedInvariants(restored, 'load')
  for (const key of ['difficulty', 'targetGivens', 'givens', 'solution', 'board', 'notes', 'selected', 'notesMode', 'elapsedMs', 'won', 'winAcked']) {
    assert.deepEqual(restored[key], raw[key], 'restored ' + key + ' differs from the saved value')
  }
  assert.deepEqual(restored.undo, raw.undo)
  assert.equal(restored.runningSince, null, 'restored state must be paused until the component resumes it')
})

runner.check('saveState with a live timer persists the elapsed clock (5s autosave must not lose time)', () => {
  storage.map.clear()
  storage.failSet = false
  storage.failGet = false
  const state = freshState({ seed: 120, now: 1000 })
  const empty = emptyCells(state)[0]
  api.applyDigit(state, empty, 5, 5000) // timer keeps running: elapsed = 4000 at now=6000
  const liveRaw = api.serializeState(state, 6000)
  assert.equal(liveRaw.elapsedMs, 5000, 'serializeState(state, now) must persist the live elapsed time')
  assert.equal(api.saveState(state, 6000), true)
  const stored = JSON.parse(storage.map.get(STORE_KEY))
  assert.equal(stored.elapsedMs, 5000, 'the persisted save must carry the live elapsed time')
  const restored = api.loadSavedState()
  must(restored !== null)
  assert.equal(restored.elapsedMs, 5000, 'restored clock must equal the saved clock')
  assert.equal(restored.runningSince, null)
  // The component resumes the clock on mount; elapsed must continue from 5000.
  api.timerResume(restored, 10000)
  assert.equal(api.timerElapsed(restored, 12000), 7000, 'timer must continue after restore')
})

runner.check('loadSavedState NEVER regenerates: a handcrafted classic puzzle save is restored verbatim', () => {
  storage.map.clear()
  const solution = refSolve(CLASSIC_PUZZLE)
  must(solution !== null, 'classic puzzle must be solvable')
  const board = CLASSIC_PUZZLE.slice()
  const empties = []
  for (let index = 0; index < 81; index += 1) if (board[index] === 0) empties.push(index)
  board[empties[0]] = solution[empties[0]]
  board[empties[1]] = 5
  const notes = new Array(81).fill(0)
  notes[empties[2]] = (1 << 0) | (1 << 8)
  const raw = {
    schemaVersion: 1,
    difficulty: 'hard',
    targetGivens: 28,
    givens: CLASSIC_PUZZLE,
    solution,
    board,
    notes,
    selected: 40,
    notesMode: true,
    elapsedMs: 12345,
    won: false,
    winAcked: false,
    undo: [
      { index: empties[0], prevValue: 0, prevNotes: 0 },
      { index: empties[1], prevValue: 0, prevNotes: 0 },
    ],
  }
  storage.map.set(STORE_KEY, JSON.stringify(raw))
  const restored = api.loadSavedState()
  must(restored !== null, 'handcrafted valid save must load')
  assert.deepEqual(restored.givens, CLASSIC_PUZZLE, 'the restored question must be the saved one, not a generated one')
  assert.deepEqual(restored.solution, solution)
  assert.deepEqual(restored.board, board, 'the player board must be restored verbatim')
  assert.deepEqual(restored.notes, notes)
  assert.equal(restored.selected, 40)
  assert.equal(restored.notesMode, true)
  assert.equal(restored.elapsedMs, 12345)
  assert.equal(restored.undo.length, 2)
  // loading twice gives the identical puzzle: no generator side effects
  const again = api.loadSavedState()
  assert.deepEqual(again.givens, CLASSIC_PUZZLE)
})

runner.check('loadSavedState returns null on corrupt JSON / missing key / throwing storage (never throws)', () => {
  storage.failGet = false
  storage.map.clear()
  assert.equal(api.loadSavedState(), null, 'missing key')
  storage.map.set(STORE_KEY, '{not json')
  assert.equal(api.loadSavedState(), null, 'corrupt JSON')
  storage.map.set(STORE_KEY, 'null')
  assert.equal(api.loadSavedState(), null)
  storage.map.set(STORE_KEY, JSON.stringify({ schemaVersion: 2 }))
  assert.equal(api.loadSavedState(), null)
  storage.failGet = true
  let threw = false
  let result
  try {
    result = api.loadSavedState()
  } catch {
    threw = true
  }
  assert.equal(threw, false, 'loadSavedState must never throw')
  assert.equal(result, null, 'throwing storage must load as null')
  storage.failGet = false
})

runner.check('saveState failures are swallowed and reported as false', () => {
  storage.map.clear()
  storage.failSet = true
  const state = freshState({ seed: 114, now: 0 })
  let threw = false
  let result
  try {
    result = api.saveState(state)
  } catch {
    threw = true
  }
  storage.failSet = false
  assert.equal(threw, false, 'saveState must never throw')
  assert.equal(result, false, 'saveState must return false when localStorage fails')
})

// ---------------------------------------------------------------------------
// sanitizeSave: must-reject matrix
// ---------------------------------------------------------------------------
runner.check('sanitizeSave rejects every invalid core field (must-reject matrix)', () => {
  const good = validRaw({ seed: 115 })
  const cases = []
  const add = (label, raw) => cases.push([label, raw])

  // not a valid save object
  add('null', null)
  add('undefined', undefined)
  add('number', 42)
  add('boolean', true)
  add('string', 'save')
  add('empty object', {})
  add('empty array', [])

  // schemaVersion
  add('schemaVersion 2', Object.assign(clone(good), { schemaVersion: 2 }))
  add('schemaVersion "1"', Object.assign(clone(good), { schemaVersion: '1' }))
  const noVersion = clone(good)
  delete noVersion.schemaVersion
  add('schemaVersion missing', noVersion)

  // difficulty
  add('difficulty expert', Object.assign(clone(good), { difficulty: 'expert' }))
  add('difficulty null', Object.assign(clone(good), { difficulty: null }))
  add('difficulty number', Object.assign(clone(good), { difficulty: 1 }))

  // givens
  const givensMissing = clone(good)
  delete givensMissing.givens
  add('givens missing', givensMissing)
  add('givens 80 cells', Object.assign(clone(good), { givens: good.givens.slice(0, 80) }))
  add('givens 82 cells', Object.assign(clone(good), { givens: good.givens.concat([0]) }))
  add('givens not array', Object.assign(clone(good), { givens: 'x' }))
  const givensTooBig = good.givens.slice()
  givensTooBig[0] = 10
  add('givens digit 10', Object.assign(clone(good), { givens: givensTooBig }))
  const givensNegative = good.givens.slice()
  givensNegative[0] = -1
  add('givens digit -1', Object.assign(clone(good), { givens: givensNegative }))
  const givensFraction = good.givens.slice()
  givensFraction[0] = 1.5
  add('givens digit 1.5', Object.assign(clone(good), { givens: givensFraction }))
  const givensString = good.givens.slice()
  givensString[0] = '5'
  add('givens digit string', Object.assign(clone(good), { givens: givensString }))
  // fewer than 17 non-zero givens (blank solution-independent given cells)
  const sparse = clone(good)
  let remaining = sparse.givens.filter((value) => value !== 0).length
  for (let index = 0; index < 81 && remaining > 16; index += 1) {
    if (sparse.givens[index] !== 0) {
      sparse.givens[index] = 0
      remaining -= 1
    }
  }
  add('givens fewer than 17', sparse)
  // conflicting givens: duplicate the first given into another cell of the same row
  const conflicting = clone(good)
  const firstGiven = conflicting.givens.findIndex((value) => value !== 0)
  const rowStart = Math.floor(firstGiven / 9) * 9
  let conflictTarget = -1
  for (let index = rowStart; index < rowStart + 9; index += 1) {
    if (index !== firstGiven && conflicting.givens[index] !== conflicting.givens[firstGiven]) {
      conflictTarget = index
      break
    }
  }
  must(conflictTarget !== -1, 'could not build a conflicting givens fixture')
  conflicting.givens[conflictTarget] = conflicting.givens[firstGiven]
  add('givens conflicting', conflicting)

  // solution
  const solutionMissing = clone(good)
  delete solutionMissing.solution
  add('solution missing', solutionMissing)
  add('solution 80 cells', Object.assign(clone(good), { solution: good.solution.slice(0, 80) }))
  const solutionZero = good.solution.slice()
  solutionZero[0] = 0
  add('solution digit 0', Object.assign(clone(good), { solution: solutionZero }))
  const solutionBig = good.solution.slice()
  solutionBig[0] = 10
  add('solution digit 10', Object.assign(clone(good), { solution: solutionBig }))
  const solutionInvalid = good.solution.slice()
  // duplicate within row 0
  solutionInvalid[1] = solutionInvalid[0]
  add('solution invalid complete grid', Object.assign(clone(good), { solution: solutionInvalid }))
  // valid complete grid but inconsistent with givens: globally swap digits 1 and 2
  const swapped = good.solution.map((value) => (value === 1 ? 2 : value === 2 ? 1 : value))
  assert.ok(refIsValidSolution(swapped), 'digit-swapped grid must still be a legal complete grid')
  assert.ok(!refConsistent(good.givens, swapped), 'digit-swapped grid must be inconsistent with the givens')
  add('solution inconsistent with givens (valid grid)', Object.assign(clone(good), { solution: swapped }))

  // board
  const boardMissing = clone(good)
  delete boardMissing.board
  add('board missing', boardMissing)
  add('board 80 cells', Object.assign(clone(good), { board: good.board.slice(0, 80) }))
  const boardBig = good.board.slice()
  boardBig[0] = 10
  add('board digit 10', Object.assign(clone(good), { board: boardBig }))
  const boardNegative = good.board.slice()
  boardNegative[0] = -1
  add('board digit -1', Object.assign(clone(good), { board: boardNegative }))
  const boardGivenMismatch = good.board.slice()
  boardGivenMismatch[firstGiven] = good.givens[firstGiven] === 9 ? 8 : good.givens[firstGiven] + 1
  add('board given mismatch', Object.assign(clone(good), { board: boardGivenMismatch }))
  const boardGivenZero = good.board.slice()
  boardGivenZero[firstGiven] = 0
  add('board given erased', Object.assign(clone(good), { board: boardGivenZero }))

  // notes structural violations (wrong length)
  add('notes 80 cells', Object.assign(clone(good), { notes: good.notes.slice(0, 80) }))
  add('notes 82 cells', Object.assign(clone(good), { notes: good.notes.concat([0]) }))
  add('notes not array', Object.assign(clone(good), { notes: 0 }))

  // undo is an array of entries; a structurally broken one is not a core reject
  // (it is filtered) - covered in the normalisation checks below.

  for (const [label, raw] of cases) {
    let outcome
    let threw = null
    try {
      outcome = api.sanitizeSave(raw)
    } catch (error) {
      threw = error
    }
    must(threw === null, 'sanitizeSave threw on ' + label + ': ' + (threw && threw.message))
    assert.equal(outcome, null, 'sanitizeSave must reject case: ' + label)
  }
  EVIDENCE.mustRejectCases = cases.length
})

runner.check('sanitizeSave normalises non-core fields instead of rejecting', () => {
  const good = validRaw({ seed: 116 })
  const firstGiven = good.givens.findIndex((value) => value !== 0)
  const emptyCellsList = good.givens
    .map((value, index) => (value === 0 && good.board[index] === 0 ? index : -1))
    .filter((index) => index !== -1)
  must(emptyCellsList.length >= 3, 'validRaw fixture should leave empty board cells')
  const emptyCell = emptyCellsList[0]
  const secondEmpty = emptyCellsList[1]

  // selected out of range -> null
  for (const bad of [999, -1, 1.5, '3']) {
    const raw = Object.assign(clone(good), { selected: bad })
    const state = api.sanitizeSave(raw)
    must(state !== null, 'selected=' + String(bad) + ' must not reject the save')
    assert.equal(state.selected, null, 'invalid selected must become null')
  }

  // elapsed clamped
  const negative = api.sanitizeSave(Object.assign(clone(good), { elapsedMs: -100 }))
  must(negative !== null)
  assert.equal(negative.elapsedMs, 0)
  const huge = api.sanitizeSave(Object.assign(clone(good), { elapsedMs: 999999999 }))
  must(huge !== null)
  assert.equal(huge.elapsedMs, 604800000)

  // booleans are `=== true`
  for (const value of ['true', 1, {}, 0, null]) {
    const state = api.sanitizeSave(Object.assign(clone(good), { notesMode: value, winAcked: value }))
    must(state !== null)
    assert.equal(state.notesMode, false, 'notesMode must be booleanised from ' + JSON.stringify(value))
    assert.equal(state.winAcked, false, 'winAcked must be booleanised from ' + JSON.stringify(value))
  }
  const boolState = api.sanitizeSave(Object.assign(clone(good), { notesMode: true, winAcked: true }))
  must(boolState !== null)
  assert.equal(boolState.notesMode, true)
  assert.equal(boolState.winAcked, true)

  // notes on given/filled cells are zeroed, not rejected
  const dirtyNotes = clone(good)
  dirtyNotes.notes[firstGiven] = 511
  dirtyNotes.notes[emptyCell] = 7
  const normalisedNotes = api.sanitizeSave(dirtyNotes)
  must(normalisedNotes !== null, 'notes on given/filled cells must be normalised, not rejected')
  assert.equal(normalisedNotes.notes[firstGiven], 0)
  assert.equal(normalisedNotes.notes[emptyCell], 7, 'valid notes on an empty cell must be kept')

  // undo: bad entries are filtered, good ones kept, cap at 300
  const undoRaw = clone(good)
  undoRaw.undo = [
    { index: emptyCell, prevValue: 0, prevNotes: 1 },
    { index: firstGiven, prevValue: 0, prevNotes: 0 }, // bad: given cell
    { index: 81, prevValue: 0, prevNotes: 0 }, // bad index
    { index: -1, prevValue: 0, prevNotes: 0 },
    { index: 1.5, prevValue: 0, prevNotes: 0 },
    { index: secondEmpty, prevValue: 10, prevNotes: 0 }, // bad prevValue
    { index: secondEmpty, prevValue: 0, prevNotes: 512 }, // bad prevNotes
    { index: secondEmpty, prevValue: 3, prevNotes: 9 },
  ]
  const filtered = api.sanitizeSave(undoRaw)
  must(filtered !== null, 'bad undo entries must be filtered, not reject the save')
  assert.deepEqual(filtered.undo, [
    { index: emptyCell, prevValue: 0, prevNotes: 1 },
    { index: secondEmpty, prevValue: 3, prevNotes: 9 },
  ])
  const overflow = clone(good)
  overflow.undo = new Array(400).fill(0).map((_, index) => ({ index: emptyCell, prevValue: 0, prevNotes: index % 512 }))
  const capped = api.sanitizeSave(overflow)
  must(capped !== null)
  assert.ok(capped.undo.length <= 300, 'undo must be capped at 300, got ' + capped.undo.length)

  // won is recomputed from the board
  const fakeWin = api.sanitizeSave(Object.assign(clone(good), { won: true }))
  must(fakeWin !== null)
  assert.equal(fakeWin.won, false, 'won must be recomputed from the board, not trusted from the save')
})

runner.check('sanitizeSave ambiguous/lenient inputs are recorded, not failed', () => {
  const good = validRaw({ seed: 117 })
  const probes = []
  const probe = (label, raw) => {
    let outcome = 'threw'
    try {
      const value = api.sanitizeSave(raw)
      outcome = value === null ? 'rejected' : 'accepted'
    } catch (error) {
      outcome = 'THREW: ' + error.message
    }
    probes.push({ label, outcome })
  }
  const noNotes = clone(good)
  delete noNotes.notes
  probe('notes field missing', noNotes)
  probe('notes 512 value', Object.assign(clone(good), { notes: good.notes.map((value, index) => (index === 5 ? 512 : value)) }))
  probe('elapsedMs string', Object.assign(clone(good), { elapsedMs: '123' }))
  probe('elapsedMs float', Object.assign(clone(good), { elapsedMs: 12.5 }))
  probe('undo non-array', Object.assign(clone(good), { undo: 'nope' }))
  probe('targetGivens string', Object.assign(clone(good), { targetGivens: 'x' }))
  probe('extra unknown field', Object.assign(clone(good), { extra: { nested: true } }))
  probe('winAcked missing', (() => { const raw = clone(good); delete raw.winAcked; return raw })())
  EVIDENCE.ambiguousSanitize = probes
  for (const entry of probes) {
    must(entry.outcome !== 'threw', 'sanitizeSave threw on ambiguous input: ' + entry.label + ' (' + entry.outcome + ')')
  }
  runner.note('Ambiguous sanitize inputs recorded verbatim in EVIDENCE ambiguousSanitize (spec silent on type-clamps): ' + JSON.stringify(probes))
})

// ---------------------------------------------------------------------------
// sanitizeSave fuzz: >= 2000 inputs, never throws, output always valid
// ---------------------------------------------------------------------------
runner.check('sanitizeSave fuzz: 2000 corrupt/random inputs never throw and never yield an invalid state', () => {
  const rng = auditRng(424242)
  const valid = validRaw({ seed: 118 })
  const validKeys = Object.keys(valid)
  const junkPool = [null, undefined, true, false, 0, 1, -1, 1.5, 81, 512, '0', 'x', '', [], {}, [1, 2, 3], { a: 1 }, NaN, Infinity]

  function randomJunk() {
    const roll = rng()
    if (roll < 0.55) return junkPool[Math.floor(rng() * junkPool.length)]
    if (roll < 0.75) {
      const array = []
      const length = Math.floor(rng() * 4)
      for (let index = 0; index < length; index += 1) array.push(junkPool[Math.floor(rng() * junkPool.length)])
      return array
    }
    const object = {}
    const keys = validKeys.slice(0, Math.floor(rng() * 5))
    for (const key of keys) object[key] = junkPool[Math.floor(rng() * junkPool.length)]
    return object
  }

  function mutate(seedRaw) {
    const raw = clone(seedRaw)
    const keys = Object.keys(raw)
    const operations = 1 + Math.floor(rng() * 4)
    for (let operation = 0; operation < operations; operation += 1) {
      const roll = rng()
      if (roll < 0.15 && keys.length > 0) {
        const key = keys[Math.floor(rng() * keys.length)]
        delete raw[key]
      } else if (roll < 0.3) {
        raw['junk' + Math.floor(rng() * 5)] = randomJunk()
      } else if (roll < 0.85 && keys.length > 0) {
        const key = keys[Math.floor(rng() * keys.length)]
        const value = raw[key]
        if (Array.isArray(value)) {
          const index = Math.floor(rng() * value.length)
          const action = rng()
          if (action < 0.5) value[index] = randomJunk()
          else if (action < 0.75) value.splice(index, 1)
          else value.push(randomJunk())
        } else if (value && typeof value === 'object') {
          const subKeys = Object.keys(value)
          const subKey = subKeys[Math.floor(rng() * subKeys.length)]
          if (subKey !== undefined) value[subKey] = randomJunk()
          else raw[key] = randomJunk()
        } else {
          raw[key] = randomJunk()
        }
      } else if (keys.length > 0) {
        const key = keys[Math.floor(rng() * keys.length)]
        raw[key] = randomJunk()
      }
    }
    return raw
  }

  let cases = 0
  let rejected = 0
  let accepted = 0
  let throws = 0
  const throwSamples = []
  for (let index = 0; index < 2000; index += 1) {
    const input = index < 800 ? randomJunk() : mutate(valid)
    cases += 1
    try {
      const outcome = api.sanitizeSave(input)
      if (outcome === null) {
        rejected += 1
      } else {
        accepted += 1
        assertSanitisedInvariants(outcome, 'fuzz case #' + index)
      }
    } catch (error) {
      throws += 1
      if (throwSamples.length < 5) throwSamples.push({ index, message: error.message })
    }
  }
  EVIDENCE.sanitizeFuzz = { cases, rejected, accepted, throws }
  assert.equal(throws, 0, 'sanitizeSave threw on ' + throws + ' fuzz inputs: ' + JSON.stringify(throwSamples))
  EVIDENCE.sanitizeFuzzThrowSamples = throwSamples
})

runner.check('loadSavedState fuzz: 300 corrupt JSON payloads never throw and restore only valid states', () => {
  const rng = auditRng(777001)
  const valid = validRaw({ seed: 119 })
  const validText = JSON.stringify(valid)
  const junkStrings = ['', '{', 'null', '[]', '{}', '{"schemaVersion":1}', 'not json', '<xml/>', validText.slice(0, 40)]
  let cases = 0
  let restoredValid = 0
  let rejected = 0
  let throws = 0
  for (let index = 0; index < 300; index += 1) {
    let payload
    const roll = rng()
    if (roll < 0.4) {
      payload = junkStrings[Math.floor(rng() * junkStrings.length)]
    } else {
      // mutate the JSON text at random code units (still often parseable)
      const chars = validText.split('')
      const edits = 1 + Math.floor(rng() * 5)
      for (let edit = 0; edit < edits; edit += 1) {
        const at = Math.floor(rng() * chars.length)
        const action = rng()
        if (action < 0.4) chars[at] = String.fromCharCode(32 + Math.floor(rng() * 90))
        else if (action < 0.7) chars.splice(at, 1)
        else chars.splice(at, 0, String.fromCharCode(32 + Math.floor(rng() * 90)))
      }
      payload = chars.join('')
    }
    storage.map.set(STORE_KEY, payload)
    cases += 1
    try {
      const state = api.loadSavedState()
      if (state === null) rejected += 1
      else {
        restoredValid += 1
        assertSanitisedInvariants(state, 'load fuzz #' + index)
      }
    } catch (error) {
      throws += 1
    }
  }
  storage.map.delete(STORE_KEY)
  EVIDENCE.loadFuzz = { cases, rejected, restoredValid, throws }
  assert.equal(throws, 0, 'loadSavedState threw in ' + throws + ' fuzz cases')
})

// ---------------------------------------------------------------------------
// hasProgress oracle cross-check
// ---------------------------------------------------------------------------
runner.check('hasProgress matches an independent oracle and clears after full undo', () => {
  const state = freshState({ seed: 40, now: 0 })
  const empties = emptyCells(state)
  assert.equal(api.hasProgress(state), false)
  api.applyDigit(state, empties[0], 5, 10)
  assert.equal(api.hasProgress(state), true, 'a player value is progress')
  assert.equal(api.undoMove(state, 20), true)
  assert.equal(api.hasProgress(state), false, 'undoing back to the start means no progress')
  api.toggleNotesMode(state)
  api.applyDigit(state, empties[1], 2, 30)
  assert.equal(api.hasProgress(state), true, 'a pencil mark is progress')

  const rng = auditRng(606060)
  for (let trial = 0; trial < 100; trial += 1) {
    const probe = freshState({ seed: 500 + trial, now: 0 })
    const cells = emptyCells(probe)
    const steps = Math.floor(rng() * 6)
    for (let step = 0; step < steps; step += 1) {
      const cell = cells[Math.floor(rng() * cells.length)]
      if (rng() < 0.3) api.toggleNotesMode(probe)
      api.applyDigit(probe, cell, 1 + Math.floor(rng() * 9), step * 10)
    }
    let oracle = false
    for (let index = 0; index < 81; index += 1) {
      if (probe.board[index] !== probe.givens[index] || probe.notes[index] !== 0) {
        oracle = true
        break
      }
    }
    assert.equal(api.hasProgress(probe), oracle, 'hasProgress mismatch on trial ' + trial)
  }
  EVIDENCE.hasProgressOracleTrials = 100
})

// ---------------------------------------------------------------------------
// save after win / winAcked persistence
// ---------------------------------------------------------------------------
runner.check('won/winAcked survive serialize+sanitize and board-solved wins are recomputed', () => {
  const { state } = makeWinState({ seed: 4325 })
  const raw = api.serializeState(state)
  assert.equal(raw.won, true)
  assert.equal(raw.winAcked, false)
  storage.map.clear()
  storage.map.set(STORE_KEY, JSON.stringify(raw))
  const restored = api.loadSavedState()
  must(restored !== null, 'a won game must be saveable and loadable')
  assertSanitisedInvariants(restored, 'won-load')
  assert.equal(restored.won, true)
  assert.equal(restored.winAcked, false)
  assert.deepEqual(restored.board, state.board)
  // winAcked = true is preserved
  const acked = api.sanitizeSave(Object.assign(clone(raw), { winAcked: true }))
  must(acked !== null)
  assert.equal(acked.winAcked, true)
  assert.equal(acked.won, true)
})

const summary = runner.summary()
for (const [key, value] of Object.entries(EVIDENCE)) {
  if (value !== undefined) console.log('EVIDENCE ' + key + ' ' + JSON.stringify(value))
}
console.log('RESULT state audit ' + JSON.stringify(summary))
