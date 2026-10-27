/**
 * save-fuzz.mjs — persistence audit: round-trip + corrupt-save mutation fuzz.
 *
 * Run (repo root):
 *   node packages/dsh-game-solitaire/dev/audit/save-fuzz.mjs
 *   node packages/dsh-game-solitaire/dev/audit/save-fuzz.mjs --mutations 5000
 * Read-only. Exit 0 = all persistence requirements hold.
 *
 * Requirements under test (handoff §技术约束 + contract §4 + task 009):
 *   R1 serializeState -> JSON -> sanitizeState must be lossless for a valid state
 *      (piles, seed, moves, started, won, elapsedMs, retained undo snapshots).
 *   R2 sanitizeState must NEVER throw, for any input (including non-JSON values).
 *   R3 any accepted sanitized state must itself be structurally valid (52 unique
 *      cards, foundation order, tableau face rules + run validity, win flag,
 *      legal ids/ranges) — checked by an independent validator, not by client code.
 *   R4 sanitize/serialize must reach a fixed point: sanitizeState(serializeState(s))
 *      deep-equals s for any s that sanitizeState already accepted (so a loaded save
 *      re-saved yields the identical save).
 *   R5 loadSavedState must never throw and must reject garbage / wrong schema /
 *      corrupt piles / cross-game keys; it returns the same state sanitize accepts.
 *   R6 saveStateToStorage writes exactly the documented key
 *      'dsh.game.solitaire.v1' and never touches other keys.
 *   R7 save size stays reasonable and serialization is stable across reload.
 */
import * as ref from './reference-solitaire.mjs'
import {
  seam, clientPilesToCanonical, resetEnv, env, SUIT_ORDER,
} from './harness.mjs'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const index = argv.indexOf('--' + name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}
const MUTATIONS = Math.max(1, Number(arg('mutations', 3000)))

const checks = []
const failures = []
function check(name, condition, detail) {
  checks.push({ name, ok: !!condition, detail })
  if (!condition) failures.push(`${name}${detail === undefined ? '' : ' :: ' + detail}`)
}

/* ------------------------------------------------------------------ *
 * Independent validators (do NOT trust client-side sanitize logic)
 * ------------------------------------------------------------------ */
const RANK_LABELS = ref.RANK_LABELS
const STORE_KEY = seam.STORE_KEY
const SAVE_UNDO = seam.SAVE_UNDO

function idValid(id) {
  return Number.isInteger(id) && id >= 0 && id <= 51
}

function validatePilesShape(piles, label) {
  const problems = []
  const seen = new Map()
  const consume = (ids, where) => {
    if (!Array.isArray(ids)) {
      problems.push(`${where}: not an array`)
      return
    }
    for (const id of ids) {
      if (!idValid(id)) {
        problems.push(`${where}: invalid card id ${JSON.stringify(id)}`)
        continue
      }
      if (seen.has(id)) problems.push(`${where}: duplicate card id ${id} (also in ${seen.get(id)})`)
      else seen.set(id, where)
    }
  }
  if (!Array.isArray(piles.stock)) problems.push('stock: not an array')
  else consume(piles.stock, 'stock')
  if (!Array.isArray(piles.waste)) problems.push('waste: not an array')
  else consume(piles.waste, 'waste')
  if (!Array.isArray(piles.foundations) || piles.foundations.length !== 4) {
    problems.push('foundations: must be 4 piles')
  } else {
    piles.foundations.forEach((pile, suitIndex) => {
      consume(pile, `foundation[${suitIndex}]`)
      if (!Array.isArray(pile)) return
      for (let k = 0; k < pile.length; k += 1) {
        const id = pile[k]
        if (!idValid(id)) continue
        if (Math.floor(id / 13) !== suitIndex) problems.push(`foundation[${suitIndex}]: holds a ${SUIT_ORDER[Math.floor(id / 13)]} card`)
        if ((id % 13) + 1 !== k + 1) problems.push(`foundation[${suitIndex}]: rank ${(id % 13) + 1} at index ${k}`)
      }
    })
  }
  if (!Array.isArray(piles.tableau) || piles.tableau.length !== 7) {
    problems.push('tableau: must be 7 columns')
  } else {
    piles.tableau.forEach((column, col) => {
      if (!Array.isArray(column)) {
        problems.push(`tableau[${col}]: not an array`)
        return
      }
      let sawUp = false
      column.forEach((card, index) => {
        const id = card && card.id
        if (!idValid(id)) {
          problems.push(`tableau[${col}][${index}]: invalid card id ${JSON.stringify(id)}`)
          return
        }
        if (!seen.has(id)) seen.set(id, `tableau[${col}][${index}]`)
        else problems.push(`tableau[${col}][${index}]: duplicate card id ${id} (also in ${seen.get(id)})`)
        const up = card && card.up === true
        if (up) sawUp = true
        else if (sawUp) problems.push(`tableau[${col}][${index}]: face-down card above a face-up card`)
      })
      if (column.length && !(column[column.length - 1] && column[column.length - 1].up === true)) {
        problems.push(`tableau[${col}]: top card is face down`)
      }
      let firstUp = -1
      for (let i = 0; i < column.length; i += 1) {
        if (column[i] && column[i].up === true) {
          firstUp = i
          break
        }
      }
      if (firstUp >= 0) {
        for (let i = firstUp + 1; i < column.length; i += 1) {
          const lower = column[i - 1].id
          const upper = column[i].id
          if ((upper % 13) + 1 !== (lower % 13)) problems.push(`tableau[${col}]: rank not descending at ${i}`)
          const lowerRed = [1, 2].includes(Math.floor(lower / 13))
          const upperRed = [1, 2].includes(Math.floor(upper / 13))
          if (lowerRed === upperRed) problems.push(`tableau[${col}]: colors not alternating at ${i}`)
        }
      }
    })
  }
  if (seen.size !== 52) problems.push(`${label}: contains ${seen.size} distinct cards, expected 52`)
  return problems
}

function validateAcceptedState(state, label) {
  const problems = []
  if (!state || typeof state !== 'object' || Array.isArray(state)) return [`${label}: not an object`]
  // sanitizeState returns the internal state shape (no schemaVersion); save files
  // carry schemaVersion and it must be exactly 1 if present.
  if ('schemaVersion' in state && state.schemaVersion !== 1) problems.push(`${label}: schemaVersion ${JSON.stringify(state.schemaVersion)} !== 1`)
  if (!Number.isInteger(state.seed) || state.seed < 0 || state.seed > 0xffffffff) problems.push(`${label}: bad seed ${JSON.stringify(state.seed)}`)
  if (!Number.isInteger(state.moves) || state.moves < 0) problems.push(`${label}: bad moves ${JSON.stringify(state.moves)}`)
  if (!Number.isInteger(state.elapsedMs) || state.elapsedMs < 0) problems.push(`${label}: bad elapsedMs ${JSON.stringify(state.elapsedMs)}`)
  if (typeof state.started !== 'boolean') problems.push(`${label}: started not boolean`)
  if (typeof state.won !== 'boolean') problems.push(`${label}: won not boolean`)
  problems.push(...validatePilesShape(state, label))
  const allWon = Array.isArray(state.foundations) && state.foundations.every((pile) => Array.isArray(pile) && pile.length === 13)
  if (state.won !== allWon) problems.push(`${label}: won flag ${state.won} inconsistent with foundations`)
  if (!Array.isArray(state.undo)) problems.push(`${label}: undo not an array`)
  else if (state.undo.length > SAVE_UNDO) problems.push(`${label}: undo ${state.undo.length} exceeds SAVE_UNDO ${SAVE_UNDO}`)
  else {
    state.undo.forEach((snapshot, index) => {
      const where = `${label}.undo[${index}]`
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        problems.push(`${where}: not an object`)
        return
      }
      if (!Number.isInteger(snapshot.moves) || snapshot.moves < 0) problems.push(`${where}: bad moves`)
      const decoded = decodeSnapshot(snapshot, where, problems)
      if (!decoded) return
      problems.push(...validatePilesShape(decoded, where))
      const snapshotAllWon = decoded.foundations.every((pile) => pile.length === 13)
      if (snapshot.won !== snapshotAllWon) problems.push(`${where}: won flag inconsistent`)
    })
  }
  return problems
}

function decodeSnapshot(snapshot, where, problems) {
  const { stock, waste, foundations, tableau } = snapshot
  if (!Array.isArray(tableau) || tableau.length !== 7) {
    problems.push(`${where}: bad tableau`)
    return null
  }
  const decodedTableau = []
  for (let col = 0; col < 7; col += 1) {
    const encoded = tableau[col]
    if (!Array.isArray(encoded)) {
      problems.push(`${where}.tableau[${col}]: not an array`)
      return null
    }
    const column = []
    for (let i = 0; i < encoded.length; i += 1) {
      const value = encoded[i]
      if (!Number.isInteger(value) || value < 0 || value > 103) {
        problems.push(`${where}.tableau[${col}][${i}]: bad encoded value ${JSON.stringify(value)}`)
        return null
      }
      column.push({ id: value % 52, up: value < 52 })
    }
    decodedTableau.push(column)
  }
  return { stock, waste, foundations, tableau: decodedTableau, moves: snapshot.moves, started: snapshot.started, won: snapshot.won }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
const clone = (value) => JSON.parse(JSON.stringify(value))
let rng = ref.makeRng(0xc0ffee)

function randomPlayState(seed, actions) {
  const state = seam.emptyState(seed)
  const localRng = ref.makeRng((seed ^ 0x51ed270b) >>> 0)
  for (let step = 0; step < actions; step += 1) {
    let action = null
    // gather legal (selection,target) pairs cheaply, then pick one; occasionally draw
    const pairs = []
    const selections = [{ kind: 'waste' }]
    state.tableau.forEach((column, col) => {
      column.forEach((card, index) => {
        if (card.up) selections.push({ kind: 'tableau', col, index })
      })
    })
    for (const suitPile of [0, 1, 2, 3]) selections.push({ kind: 'foundation', pile: suitPile })
    const targets = []
    for (let col = 0; col < 7; col += 1) targets.push({ kind: 'tableau', col })
    for (let pile = 0; pile < 4; pile += 1) targets.push({ kind: 'foundation', pile })
    for (const selection of selections) {
      for (const target of targets) {
        if (seam.canDrop(state, selection, target).ok) pairs.push({ selection, target })
      }
    }
    if (localRng() < 0.2 || pairs.length === 0 || state.won) {
      action = { type: 'draw' }
    } else {
      const pair = pairs[Math.floor(localRng() * pairs.length)]
      action = { type: 'move', selection: pair.selection, target: pair.target }
    }
    seam.pushUndo(state)
    if (action.type === 'draw') seam.drawStock(state)
    else seam.applyMove(state, action.selection, action.target)
    if (state.undo.length > seam.MAX_UNDO_KEEP) state.undo.splice(0, state.undo.length - seam.MAX_UNDO_KEEP)
    if (state.won) break
  }
  return state
}

function pilesEquivalent(canonicalA, canonicalB) {
  const diffs = ref.diffPiles(canonicalA, canonicalB)
  return diffs || []
}

/* ------------------------------------------------------------------ *
 * R1 — lossless round-trip on realistic states
 * ------------------------------------------------------------------ */
resetEnv()
const roundTripSeeds = [0, 1, 7, 42, 123456789, 0xffffffff]
let roundTrips = 0
let maxSaveBytes = 0
for (const seed of roundTripSeeds) {
  for (const actionCount of [0, 12, 60, 180]) {
    const state = randomPlayState(seed, actionCount)
    const snapshot = seam.serializeState(state)
    const json = JSON.stringify(snapshot)
    maxSaveBytes = Math.max(maxSaveBytes, json.length)
    const sanitized = seam.sanitizeState(JSON.parse(json))
    roundTrips += 1
    check(`round-trip not null (seed ${seed}, actions ${actionCount})`, !!sanitized)
    if (!sanitized) continue
    const expected = clientPilesToCanonical(state)
    const actual = clientPilesToCanonical(sanitized)
    const diffs = pilesEquivalent(expected, actual)
    check(`round-trip piles identical (seed ${seed}, actions ${actionCount})`, diffs.length === 0, JSON.stringify(diffs).slice(0, 600))
    check(`round-trip moves (seed ${seed}, actions ${actionCount})`, sanitized.moves === state.moves, `${sanitized.moves} vs ${state.moves}`)
    check(`round-trip seed (seed ${seed}, actions ${actionCount})`, sanitized.seed === (state.seed >>> 0), `${sanitized.seed} vs ${state.seed}`)
    check(`round-trip started (seed ${seed}, actions ${actionCount})`, sanitized.started === (state.started === true))
    check(`round-trip won (seed ${seed}, actions ${actionCount})`, sanitized.won === (state.won === true))
    check(`round-trip elapsedMs (seed ${seed}, actions ${actionCount})`, sanitized.elapsedMs === state.elapsedMs)
    const expectedUndo = Math.min(state.undo.length, SAVE_UNDO)
    check(`round-trip retained undo count (seed ${seed}, actions ${actionCount})`, sanitized.undo.length === expectedUndo, `${sanitized.undo.length} vs ${expectedUndo}`)
    for (const snapshotEntry of sanitized.undo) {
      const decoded = decodeSnapshot(snapshotEntry, 'undo', [])
      if (decoded) {
        const problems = validatePilesShape(decoded, 'undo')
        if (problems.length) {
          check(`round-trip undo snapshot valid (seed ${seed})`, false, problems.slice(0, 3).join(' | '))
          break
        }
      }
    }
    // sanitize -> serialize -> sanitize must be a fixed point (a reloaded save
    // re-saved must produce the identical internal state)
    const again = seam.sanitizeState(seam.serializeState(sanitized))
    check(`sanitize/serialize fixed point (seed ${seed}, actions ${actionCount})`, JSON.stringify(again) === JSON.stringify(sanitized), 'second sanitize differs')
    const problems = validateAcceptedState(sanitized, 'roundtrip')
    check(`accepted state independently valid (seed ${seed}, actions ${actionCount})`, problems.length === 0, problems.slice(0, 5).join(' | '))
  }
}

/* ------------------------------------------------------------------ *
 * R1b — makeSnapshot / restoreSnapshot round-trip
 * ------------------------------------------------------------------ */
{
  const state = randomPlayState(424242, 90)
  const snapshot = seam.makeSnapshot(state)
  const target = seam.emptyState(state.seed)
  seam.restoreSnapshot(target, clone(snapshot))
  const diffs = pilesEquivalent(clientPilesToCanonical(state), clientPilesToCanonical(target))
  check('makeSnapshot/restoreSnapshot restores piles', diffs.length === 0, JSON.stringify(diffs).slice(0, 500))
  check('makeSnapshot/restoreSnapshot restores moves', target.moves === state.moves, `${target.moves} vs ${state.moves}`)
  const encoded = seam.encodeTableau(state.tableau)
  const decoded = seam.decodeTableau(encoded)
  check('encodeTableau/decodeTableau round-trip', JSON.stringify(decoded) === JSON.stringify(state.tableau))
}

/* ------------------------------------------------------------------ *
 * R5 — loadSavedState: garbage and cross-key isolation
 * ------------------------------------------------------------------ */
resetEnv()
const garbageSaves = [
  '', ' ', '{', '}', 'null', 'undefined', '[]', '[1,2,3]', '"a string"', '42', 'true',
  '{"schemaVersion":1}', '{"schemaVersion":2}', '{"schemaVersion":"1"}',
  '{"schemaVersion":1,"seed":1}', '{"schemaVersion":1,"seed":1,"moves":0}',
  JSON.stringify({ schemaVersion: 1, seed: 1, moves: 0, elapsedMs: 0, stock: [], waste: [], foundations: [[], [], [], []], tableau: [[], [], [], [], [], [], []] }),
  '{"seed":0,"moves":0}', '\u0000\u0001binary', '{"schemaVersion":1,"seed":-1}',
]
let garbageThrows = 0
for (const raw of garbageSaves) {
  env.storage.set(STORE_KEY, raw)
  try {
    const loaded = seam.loadSavedState()
    check(`garbage save rejected or valid (${JSON.stringify(raw).slice(0, 40)})`, loaded === null || validateAcceptedState(loaded, 'loaded').length === 0)
  } catch (error) {
    garbageThrows += 1
    check(`garbage save must not throw (${JSON.stringify(raw).slice(0, 40)})`, false, String(error && error.message))
  }
}
check('garbage saves never threw', garbageThrows === 0, String(garbageThrows))

// valid save loads back identically and other game keys are never read
resetEnv()
{
  const state = randomPlayState(555, 40)
  seam.saveStateToStorage(state)
  check(`saveStateToStorage writes exactly ${STORE_KEY}`, env.storage.size === 1 && env.storage.has(STORE_KEY), [...env.storage.keys()].join(','))
  const keysAfterSave = [...env.storage.keys()]
  env.storage.set('dsh.game.quoridor.v1', '{"schemaVersion":1,"evil":true}')
  env.storage.set('some.other.key', 'x')
  const loaded = seam.loadSavedState()
  check('loadSavedState returns the sanitized saved state', !!loaded && validateAcceptedState(loaded, 'loaded-state').length === 0)
  const diffs = pilesEquivalent(clientPilesToCanonical(state), clientPilesToCanonical(loaded))
  check('loaded state equals saved state', diffs.length === 0, JSON.stringify(diffs).slice(0, 400))
  check('loadSavedState does not modify other storage keys', env.storage.get('dsh.game.quoridor.v1') === '{"schemaVersion":1,"evil":true}' && env.storage.get('some.other.key') === 'x')
  check('save only created its own key', keysAfterSave.every((key) => key === STORE_KEY))
}

/* ------------------------------------------------------------------ *
 * R6b — storage failures never break gameplay
 * ------------------------------------------------------------------ */
{
  resetEnv()
  // Replace localStorage with throwing implementations to prove try/catch.
  const saved = env.storage
  const brokenWindow = globalThis.window
  brokenWindow.localStorage = {
    getItem() { throw new Error('storage read failed') },
    setItem() { throw new Error('storage write failed') },
    removeItem() { throw new Error('storage remove failed') },
  }
  try {
    check('loadSavedState survives throwing storage', seam.loadSavedState() === null)
    let threw = false
    try {
      seam.saveStateToStorage(randomPlayState(9, 10))
    } catch (error) {
      threw = true
    }
    check('saveStateToStorage survives throwing storage', !threw)
  } finally {
    brokenWindow.localStorage = {
      getItem(key) { return saved.has(key) ? saved.get(key) : null },
      setItem(key, value) { saved.set(key, String(value)) },
      removeItem(key) { saved.delete(key) },
      clear() { saved.clear() },
    }
  }
}

/* ------------------------------------------------------------------ *
 * R2/R3/R4 — corrupt mutation fuzz
 * ------------------------------------------------------------------ */
resetEnv()
const baseState = randomPlayState(2026, 140)
const baseSave = seam.serializeState(baseState)

// explicit modifications that MUST be rejected (sanity of "rejects corrupt")
const mustReject = [
  ['wrong schemaVersion 2', (save) => { save.schemaVersion = 2 }],
  ['schemaVersion string', (save) => { save.schemaVersion = '1' }],
  ['schemaVersion missing', (save) => { delete save.schemaVersion }],
  ['seed negative', (save) => { save.seed = -1 }],
  ['seed > uint32', (save) => { save.seed = 0x100000000 }],
  ['seed non-integer', (save) => { save.seed = 1.5 }],
  ['moves negative', (save) => { save.moves = -1 }],
  ['moves non-integer', (save) => { save.moves = 2.5 }],
  ['elapsedMs negative', (save) => { save.elapsedMs = -5 }],
  ['stock not array', (save) => { save.stock = {} }],
  ['stock id out of range', (save) => { save.stock.push(52) }],
  ['stock id negative', (save) => { save.stock.push(-1) }],
  ['stock string id', (save) => { save.stock.push('3') }],
  ['stock null entry', (save) => { save.stock.push(null) }],
  ['duplicate card across piles', (save) => {
    const id = save.stock[0] !== undefined ? save.stock[0] : save.waste[0]
    save.waste.push(id)
  }],
  ['missing stock key', (save) => { delete save.stock }],
  ['tableau 6 columns', (save) => { save.tableau.pop() }],
  ['tableau column not array', (save) => { save.tableau[3] = 5 }],
  ['tableau encoded value > 103', (save) => { save.tableau[0].push(104) }],
  ['tableau encoded value string', (save) => { save.tableau[0].push('7') }],
  ['foundation wrong suit', (save) => {
    // put a spade card (id 1 = 2S) into the hearts foundation -> must be rejected
    save.foundations[1].push(1)
  }],
  ['foundation missing pile', (save) => { save.foundations.pop() }],
  ['foundation rank gap', (save) => {
    // hearts ace inside the spades foundation -> wrong suit / wrong rank
    save.foundations[0] = [13]
  }],
  ['won=true with empty foundations', (save) => { save.won = true }],
  ['undo not array', (save) => { save.undo = 'nope' }],
  ['undo garbage snapshot', (save) => { save.undo = [null, 7, 'x', []] }],
  ['top-level array', () => []],
  ['top-level null', () => null],
  ['top-level string', () => 'save'],
]
let explicitRejected = 0
for (const [name, mutate] of mustReject) {
  const mutated = mutate(clone(baseSave))
  let result = null
  let threw = false
  try {
    result = seam.sanitizeState(mutated)
  } catch (error) {
    threw = true
    check(`must-reject corrupt save: ${name}`, false, 'sanitize threw: ' + (error && error.message))
  }
  if (!threw) {
    check(`must-reject corrupt save: ${name}`, result === null, result ? 'accepted ' + JSON.stringify(result).slice(0, 200) : '')
    if (result === null) explicitRejected += 1
  }
}

// must-ACCEPT normalizations (documented, non-destructive behaviours)
{
  const extras = clone(baseSave)
  extras.unknownTopLevel = { a: 1 }
  const sanitized = seam.sanitizeState(extras)
  check('unknown extra keys are ignored (not fatal)', !!sanitized && !('unknownTopLevel' in sanitized))

  const tooMuchUndo = clone(baseSave)
  while (tooMuchUndo.undo.length < SAVE_UNDO + 25) tooMuchUndo.undo.push(clone(baseSave.undo[0] || seam.makeSnapshot(baseState)))
  const trimmed = seam.sanitizeState(tooMuchUndo)
  check(`undo longer than SAVE_UNDO is trimmed to ${SAVE_UNDO}`, !!trimmed && trimmed.undo.length <= SAVE_UNDO, trimmed ? String(trimmed.undo.length) : 'null')

  const startedFix = clone(baseSave)
  startedFix.moves = 3
  startedFix.started = false
  const fixed = seam.sanitizeState(startedFix)
  check('started=false with moves>0 is normalized to started=true', !!fixed && fixed.started === true)
}

/* mutation fuzz */
const MUTATION_OPS = [
  'drop-key', 'set-value', 'schema-bump', 'stock-extra', 'stock-drop', 'stock-duplicate',
  'foundation-swap', 'tableau-corrupt', 'undo-garbage', 'elapsed-corrupt', 'seed-corrupt',
  'moves-corrupt', 'won-corrupt', 'null-everything', 'array-wrap', 'deep-nested',
]
let accepted = 0
let rejected = 0
let throws = 0
const acceptedInvalid = []
const firstThrows = []
const keys = () => Object.keys(baseSave)
for (let i = 0; i < MUTATIONS; i += 1) {
  let mutated = clone(baseSave)
  const op = MUTATION_OPS[Math.floor(rng() * MUTATION_OPS.length)]
  let description = op
  switch (op) {
    case 'drop-key': {
      const key = keys()[Math.floor(rng() * keys().length)]
      delete mutated[key]
      description = 'delete ' + key
      break
    }
    case 'set-value': {
      const key = keys()[Math.floor(rng() * keys().length)]
      const values = [null, 0, -1, 1.5, 'x', [], {}, true, false, 1e12, '', NaN, Infinity]
      mutated[key] = values[Math.floor(rng() * values.length)]
      description = `set ${key}=${String(mutated[key])}`
      break
    }
    case 'schema-bump': mutated.schemaVersion = 2; break
    case 'stock-extra': mutated.stock.push(Math.floor(rng() * 60)); break
    case 'stock-drop': if (mutated.stock.length) mutated.stock.splice(Math.floor(rng() * mutated.stock.length), 1); break
    case 'stock-duplicate': {
      const all = [...mutated.stock, ...mutated.waste]
      if (all.length) mutated.stock.push(all[0])
      break
    }
    case 'foundation-swap': {
      const pile = Math.floor(rng() * 4)
      if (mutated.foundations[pile].length) mutated.foundations[pile][Math.floor(rng() * mutated.foundations[pile].length)] = Math.floor(rng() * 52)
      break
    }
    case 'tableau-corrupt': {
      const col = Math.floor(rng() * 7)
      const mode = Math.floor(rng() * 4)
      if (mode === 0) mutated.tableau[col].push(104)
      else if (mode === 1) mutated.tableau[col] = null
      else if (mode === 2 && mutated.tableau[col].length) mutated.tableau[col][0] = 200
      else mutated.tableau[Math.floor(rng() * 7)] = []
      break
    }
    case 'undo-garbage': mutated.undo = [{ nonsense: true }, null, 7, 'x', []]; break
    case 'elapsed-corrupt': mutated.elapsedMs = [1.5, -1, NaN, 8 * 24 * 3600 * 1000][Math.floor(rng() * 4)]; break
    case 'seed-corrupt': mutated.seed = [1.5, -1, 2 ** 32, NaN, 2 ** 40][Math.floor(rng() * 5)]; break
    case 'moves-corrupt': mutated.moves = [-1, 1.5, 1e12, NaN][Math.floor(rng() * 4)]; break
    case 'won-corrupt': mutated.won = [true, 'true', 1, null][Math.floor(rng() * 4)]; break
    case 'null-everything': mutated = null; break
    case 'array-wrap': mutated = [mutated]; break
    case 'deep-nested': {
      const pick = Math.floor(rng() * 4)
      if (pick === 0) mutated.foundations[0].push('AS')
      else if (pick === 1) mutated.tableau[0].push(mutated.tableau[0][0])
      else if (pick === 2 && mutated.undo[0]) mutated.undo[0].stock = 'nope'
      else mutated.undo = mutated.undo.slice(0, 3).map((snap) => (snap ? Object.assign({}, snap, { moves: -2 }) : snap))
      break
    }
  }
  // JSON-representable form (what a real localStorage save is) + raw form
  let jsonValue
  try {
    jsonValue = JSON.parse(JSON.stringify(mutated))
  } catch (error) {
    jsonValue = mutated
  }
  for (const [variantName, variant] of [['json', jsonValue], ['raw', mutated]]) {
    let result
    try {
      result = seam.sanitizeState(variant)
    } catch (error) {
      throws += 1
      if (firstThrows.length < 8) firstThrows.push({ description, variantName, error: String(error && error.message) })
      continue
    }
    if (result === null) {
      rejected += 1
      continue
    }
    accepted += 1
    const problems = validateAcceptedState(result, 'mutated')
    if (problems.length) {
      acceptedInvalid.push({ description, variantName, problems: problems.slice(0, 6), sample: JSON.stringify(result).slice(0, 500) })
      continue
    }
    // fixed point: an accepted state re-serialized and sanitized must be identical
    let again
    try {
      again = seam.sanitizeState(seam.serializeState(result))
    } catch (error) {
      throws += 1
      if (firstThrows.length < 8) firstThrows.push({ description, variantName, error: 'fixed-point threw: ' + (error && error.message) })
      continue
    }
    if (again === null || JSON.stringify(again) !== JSON.stringify(result)) {
      acceptedInvalid.push({ description, variantName, problems: ['sanitize/serialize fixed point broken'] })
    }
  }
}

check('mutation fuzz: sanitizeState never threw', throws === 0, JSON.stringify(firstThrows))
check('mutation fuzz: every accepted result is independently valid', acceptedInvalid.length === 0, JSON.stringify(acceptedInvalid.slice(0, 4)).slice(0, 3000))
check('mutation fuzz was non-vacuous (rejections and acceptances both observed)', rejected > 0 && accepted > 0, `accepted ${accepted}, rejected ${rejected}`)
check('explicit must-reject cases were all rejected', explicitRejected === mustReject.length, `${explicitRejected}/${mustReject.length}`)

/* R5b: corrupt save through loadSavedState matches sanitize verdict */
resetEnv()
{
  let loadMismatch = 0
  for (let i = 0; i < 200; i += 1) {
    const mutated = clone(baseSave)
    const key = keys()[Math.floor(rng() * keys().length)]
    if (rng() < 0.5) delete mutated[key]
    else mutated[key] = [null, -1, 1.5, {}, 'x'][Math.floor(rng() * 5)]
    const json = JSON.stringify(mutated)
    env.storage.set(STORE_KEY, json)
    let viaLoad
    try {
      viaLoad = seam.loadSavedState()
    } catch (error) {
      loadMismatch += 1
      continue
    }
    const direct = seam.sanitizeState(JSON.parse(json))
    const loadPiles = viaLoad ? JSON.stringify(clientPilesToCanonical(viaLoad)) : 'null'
    const directPiles = direct ? JSON.stringify(clientPilesToCanonical(direct)) : 'null'
    if (loadPiles !== directPiles) loadMismatch += 1
  }
  check('loadSavedState agrees with sanitizeState on corrupt saves', loadMismatch === 0, `${loadMismatch}/200 mismatches`)
}

/* R7: serialization stability across two save/load cycles */
resetEnv()
{
  const state = randomPlayState(8080, 70)
  seam.saveStateToStorage(state)
  const first = env.storage.get(STORE_KEY)
  const reloaded = seam.loadSavedState()
  seam.saveStateToStorage(Object.assign(seam.emptyState(reloaded.seed), reloaded))
  const second = env.storage.get(STORE_KEY)
  check('save is stable across save -> load -> save', first === second, `${String(first).length} vs ${String(second).length} bytes`)
  check('save size is sane (< 64 KiB)', String(first).length < 64 * 1024, `${String(first).length} bytes`)
  check('saved JSON contains schemaVersion 1 and the documented seed', JSON.parse(first).schemaVersion === 1 && Number.isInteger(JSON.parse(first).seed))
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */
const passed = checks.filter((item) => item.ok).length
console.log('\n=== save-fuzz summary ===')
console.log(`round-trip cases: ${roundTrips} (${roundTripSeeds.length} seeds x 4 action depths)`)
console.log(`corrupt mutations: ${MUTATIONS} x 2 forms (JSON + raw) = ${MUTATIONS * 2} sanitize calls`)
console.log(`  accepted (renormalized): ${accepted}, rejected: ${rejected}, throws: ${throws}`)
console.log(`max observed save size: ${maxSaveBytes} bytes`)
console.log(`checks: ${checks.length}, passed: ${passed}, failed: ${failures.length}`)
for (const failure of failures) console.log('  FAIL ' + failure)
if (failures.length) {
  console.error('\nSAVE-FUZZ FAILED')
  process.exit(1)
}
console.log('\nSAVE-FUZZ OK')
