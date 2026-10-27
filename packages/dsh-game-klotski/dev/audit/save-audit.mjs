/**
 * Suite 3 — save / restore audit for `dsh.game.klotski.v1` schema v1.
 *
 *   node packages/dsh-game-klotski/dev/audit/save-audit.mjs
 *
 * Covered:
 *   - legal-state roundtrip through serializeState -> JSON -> sanitizeSave,
 *     field by field (pieces, moves, elapsedMs, started, won, undo, best);
 *   - >= 5000 mutated / hostile save objects fed to sanitizeSave: never throws,
 *     every accepted result must satisfy every schema invariant;
 *   - only the documented localStorage key is written/read;
 *   - corrupt JSON / wrong schemaVersion / unknown level / overlap / out of
 *     bounds / won-flag mismatch are rejected and fall back to a fresh state;
 *   - undo / best sanitising (drop invalid, cap at UNDO_LIMIT), canonical piece
 *     re-ordering, input non-mutation.
 */
import assert from 'node:assert/strict'
import { readFileSync as readFile } from 'node:fs'
import { api, storage, storageMap } from './harness.mjs'
import * as oracle from './oracle.mjs'

const STORE_KEY = 'dsh.game.klotski.v1'
const SCHEMA_VERSION = 1
const UNDO_LIMIT = 200
const MAX_MOVES = 100000
const MAX_ELAPSED_MS = 604800000

let checks = 0
let failures = 0
const failureDetails = []

function check(name, fn) {
  checks += 1
  try {
    fn()
  } catch (error) {
    failures += 1
    failureDetails.push({ name, message: String(error && error.message) })
    console.error('FAIL ' + name + ': ' + (error && error.message))
  }
}

function ok(condition, message) {
  assert.ok(condition, message)
}

/* --------------------------------------------------------------- helpers */

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function randomPositions(levelIndex, seed) {
  // Deterministic random reachable arrangement via the shipped engine, used only
  // to produce realistic save payloads (rules already fuzz-verified separately).
  let x = seed >>> 0
  const rnd = () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
  let state = api.createState(levelIndex)
  const steps = 1 + ((rnd() * 40) | 0)
  for (let s = 0; s < steps; s += 1) {
    const moves = []
    for (let i = 0; i < state.pieces.length; i += 1) moves.push(...api.listMoves(state, i))
    if (moves.length === 0) break
    const move = moves[(rnd() * moves.length) | 0]
    const next = api.applySlide(state, move.pieceIndex, move.dx, move.dy, move.step)
    if (!next) break
    state = next
  }
  state.moves = Math.max(1, state.moves)
  state.elapsedMs = (seed % 90000) + 0.6
  state.started = true
  state.best = {}
  return state
}

function syntheticWinningState(levelIndex) {
  const level = api.LEVELS[levelIndex]
  const slots = {
    '2x2': [[1, 3]],
    '2x1': [[0, 2]],
    '1x2': [[0, 0], [3, 0], [0, 3], [3, 3]],
    '1x1': [[1, 0], [2, 0], [1, 1], [2, 1]],
  }
  const pieces = level.pieces.map((def) => {
    const [x, y] = slots[def.w + 'x' + def.h].shift()
    return { id: def.id, x, y }
  })
  return {
    levelIndex,
    pieces,
    moves: 17,
    elapsedMs: 54321,
    started: true,
    won: true,
    undo: [],
    best: {},
  }
}

function invariantCheck(state, context) {
  ok(state && typeof state === 'object', context + ': result must be object')
  ok(Number.isInteger(state.levelIndex) && state.levelIndex >= 0 && state.levelIndex < api.LEVELS.length, context + ': levelIndex invalid')
  const level = api.LEVELS[state.levelIndex]
  ok(Array.isArray(state.pieces) && state.pieces.length === level.pieces.length, context + ': piece count/array')
  const positions = state.pieces.map((p, i) => {
    ok(p.id === level.pieces[i].id, context + ': canonical piece order/id at ' + i)
    ok(Number.isInteger(p.x) && Number.isInteger(p.y), context + ': integer coords at ' + i)
    return { x: p.x, y: p.y }
  })
  const validation = oracle.validateArrangement(positions, level)
  ok(validation.ok, context + ': arrangement invalid: ' + validation.reason)
  ok(Number.isInteger(state.moves) && state.moves >= 0 && state.moves <= MAX_MOVES, context + ': moves')
  ok(Number.isInteger(state.elapsedMs) && state.elapsedMs >= 0 && state.elapsedMs <= MAX_ELAPSED_MS, context + ': elapsedMs')
  ok(typeof state.started === 'boolean', context + ': started bool')
  ok(typeof state.won === 'boolean', context + ': won bool')
  ok(state.won === oracle.isWon(positions, level), context + ': won flag must equal isWon(pieces)')
  ok(Array.isArray(state.undo), context + ': undo array')
  ok(state.undo.length <= UNDO_LIMIT, context + ': undo cap')
  for (const snapshot of state.undo) {
    ok(snapshot && Array.isArray(snapshot.pieces), context + ': undo snapshot pieces')
    ok(Number.isInteger(snapshot.moves) && snapshot.moves >= 0 && snapshot.moves <= state.moves, context + ': undo snapshot moves')
    const snapPositions = snapshot.pieces.map((p, i) => {
      ok(p.id === level.pieces[i].id, context + ': undo snapshot order at ' + i)
      ok(Number.isInteger(p.x) && Number.isInteger(p.y), context + ': undo snapshot coords at ' + i)
      return { x: p.x, y: p.y }
    })
    ok(oracle.validateArrangement(snapPositions, level).ok, context + ': undo snapshot arrangement')
  }
  ok(state.best && typeof state.best === 'object' && !Array.isArray(state.best), context + ': best object')
  for (const id of Object.keys(state.best)) {
    ok(api.LEVELS.some((levelDef) => levelDef.id === id), context + ': best key must be a known level id: ' + id)
    const record = state.best[id]
    ok(record && Number.isInteger(record.moves) && record.moves >= 1 && record.moves <= MAX_MOVES, context + ': best.moves')
    ok(Number.isInteger(record.elapsedMs) && record.elapsedMs >= 0 && record.elapsedMs <= MAX_ELAPSED_MS, context + ': best.elapsedMs')
  }
}

/* --------------------------------------------------------- 1. roundtrip */

console.log('=== Suite 3: save / restore audit (schema v1, key ' + STORE_KEY + ') ===\n')

check('constants: STORE_KEY and schemaVersion', () => {
  ok(api.STORE_KEY === STORE_KEY, 'STORE_KEY expected ' + STORE_KEY + ', got ' + api.STORE_KEY)
  ok(api.SCHEMA_VERSION === SCHEMA_VERSION, 'SCHEMA_VERSION expected 1')
})

const roundtripStates = []
for (let levelIndex = 0; levelIndex < api.LEVELS.length; levelIndex += 1) {
  roundtripStates.push(api.createState(levelIndex))
  roundtripStates.push(randomPositions(levelIndex, 0x1234 + levelIndex * 7919))
  roundtripStates.push(syntheticWinningState(levelIndex))
}

let roundtripCount = 0
for (let index = 0; index < roundtripStates.length; index += 1) {
  const state = roundtripStates[index]
  check('roundtrip field-by-field #' + index, () => {
    const serialized = api.serializeState(state)
    ok(serialized.schemaVersion === SCHEMA_VERSION, 'serialized schemaVersion')
    const parsed = JSON.parse(JSON.stringify(serialized))
    const expectedElapsed = Math.max(0, Math.round(state.elapsedMs))
    const sanitized = api.sanitizeSave(parsed)
    ok(sanitized, 'sanitizeSave must accept the serialized state')
    invariantCheck(sanitized, 'roundtrip#' + index)
    assert.deepStrictEqual(
      {
        levelIndex: sanitized.levelIndex,
        pieces: sanitized.pieces,
        moves: sanitized.moves,
        elapsedMs: sanitized.elapsedMs,
        started: sanitized.started,
        won: sanitized.won,
        undo: sanitized.undo,
        best: sanitized.best,
      },
      {
        levelIndex: state.levelIndex,
        pieces: state.pieces.map((p) => ({ id: p.id, x: p.x, y: p.y })),
        moves: state.moves,
        elapsedMs: expectedElapsed,
        started: state.started,
        won: oracle.isWon(state.pieces.map((p) => ({ x: p.x, y: p.y })), api.LEVELS[state.levelIndex]),
        undo: state.undo.slice(-UNDO_LIMIT),
        best: state.best,
      },
      'roundtrip fields differ',
    )
    roundtripCount += 1
  })
}

check('roundtrip caps undo at UNDO_LIMIT and drops invalid snapshots', () => {
  const state = randomPositions(0, 424242)
  // Build 260 valid snapshots by replaying from the initial level.
  let cursor = api.createState(0)
  const snapshots = []
  for (let i = 0; i < 260; i += 1) {
    const moves = []
    for (let p = 0; p < cursor.pieces.length; p += 1) moves.push(...api.listMoves(cursor, p))
    if (!moves.length) break
    const move = moves[i % moves.length]
    const next = api.applySlide(cursor, move.pieceIndex, move.dx, move.dy, move.step)
    if (!next) break
    snapshots.push({ pieces: next.pieces.map((p) => ({ id: p.id, x: p.x, y: p.y })), moves: next.moves })
    cursor = next
  }
  state.undo = snapshots
  state.moves = Math.max(state.moves, cursor.moves)
  const serialized = api.serializeState(state)
  ok(serialized.undo.length === UNDO_LIMIT, 'serializeState must cap undo at ' + UNDO_LIMIT + ', got ' + serialized.undo.length)
  const sanitized = api.sanitizeSave(clone(serialized))
  ok(sanitized, 'sanitizeSave accepts capped undo')
  ok(sanitized.undo.length <= UNDO_LIMIT, 'sanitize cap')
  invariantCheck(sanitized, 'undo-cap')
})

check('sanitizeSave re-orders permuted pieces to canonical level order', () => {
  const state = randomPositions(1, 777)
  const serialized = JSON.parse(JSON.stringify(api.serializeState(state)))
  serialized.pieces = serialized.pieces.slice().reverse()
  const sanitized = api.sanitizeSave(serialized)
  ok(sanitized, 'permuted-but-valid save should be accepted')
  const level = api.LEVELS[1]
  for (let i = 0; i < level.pieces.length; i += 1) {
    ok(sanitized.pieces[i].id === level.pieces[i].id, 'canonical order at ' + i)
  }
  invariantCheck(sanitized, 'reorder')
})

check('sanitizeSave does not mutate its input', () => {
  const state = randomPositions(2, 9091)
  const serialized = JSON.parse(JSON.stringify(api.serializeState(state)))
  serialized.pieces.reverse()
  serialized.pieces[0].x = 3
  const before = JSON.parse(JSON.stringify(serialized))
  api.sanitizeSave(serialized)
  assert.deepStrictEqual(serialized, before, 'sanitizeSave mutated the caller input')
})

/* ------------------------------------------- 2. hostile mutations (>=5000) */

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rnd = mulberry32(0xc0ffee)
const WEIRD_VALUES = [
  null,
  true,
  false,
  -1,
  0,
  1,
  1.5,
  -0.5,
  1e9,
  1e15,
  '0',
  '1',
  '12',
  '1.5',
  '-3',
  'abc',
  '',
  ' ',
  [],
  {},
  [null],
  { evil: true },
  NaN,
  Infinity,
  -Infinity,
  'dsh.game.klotski.v1',
]
const TOP_KEYS = ['schemaVersion', 'levelIndex', 'pieces', 'moves', 'elapsedMs', 'started', 'won', 'undo', 'best', 'extra']
const PIECE_KEYS = ['id', 'x', 'y', 'w', 'h', 'extra']

function randomValue() {
  return WEIRD_VALUES[(rnd() * WEIRD_VALUES.length) | 0]
}

function mutate(raw, validBases) {
  const kind = (rnd() * 10) | 0
  if (kind === 0) return randomValue()
  if (kind === 1) return []
  if (kind === 2) return {}
  if (kind === 3) return String(raw)
  if (kind === 4) return JSON.stringify(raw).slice(0, (rnd() * 40) | 0) // truncated JSON
  const base = clone(validBases[(rnd() * validBases.length) | 0])
  if (kind === 5) {
    delete base[TOP_KEYS[(rnd() * TOP_KEYS.length) | 0]]
    return base
  }
  if (kind === 6) {
    base[TOP_KEYS[(rnd() * TOP_KEYS.length) | 0]] = randomValue()
    return base
  }
  if (kind === 7) {
    const piece = base.pieces[(rnd() * base.pieces.length) | 0]
    piece[PIECE_KEYS[(rnd() * PIECE_KEYS.length) | 0]] = randomValue()
    return base
  }
  if (kind === 8) {
    const op = (rnd() * 5) | 0
    if (op === 0 && base.pieces.length) base.pieces.splice((rnd() * base.pieces.length) | 0, 1)
    else if (op === 1 && base.pieces.length) base.pieces.push(clone(base.pieces[0]))
    else if (op === 2) base.pieces = base.pieces.reverse()
    else if (op === 3 && base.pieces.length > 1) {
      const src = base.pieces[0]
      base.pieces[1].x = src.x
      base.pieces[1].y = src.y
    } else base.pieces = randomValue()
    return base
  }
  // deep hostile mutation
  const target = rnd() < 0.5 ? base : base.pieces[(rnd() * base.pieces.length) | 0]
  const keys = target && typeof target === 'object' ? Object.keys(target) : []
  if (keys.length) target[keys[(rnd() * keys.length) | 0]] = randomValue()
  else if (target && typeof target === 'object') target.evil = randomValue()
  return base
}

const validBases = roundtripStates.map((state) => JSON.parse(JSON.stringify(api.serializeState(state))))

const MUTATIONS = 6000
let accepted = 0
let rejected = 0
let throws = 0
let acceptedFailures = 0
const startedAt = Date.now()
for (let i = 0; i < MUTATIONS; i += 1) {
  const raw = mutate(validBases[i % validBases.length], validBases)
  try {
    const result = api.sanitizeSave(raw)
    if (result === null || result === undefined) {
      rejected += 1
    } else {
      accepted += 1
      try {
        invariantCheck(result, 'mutation#' + i)
      } catch (error) {
        acceptedFailures += 1
        failureDetails.push({ name: 'mutation#' + i, message: 'accepted but invariants violated: ' + error.message, sample: JSON.stringify(raw).slice(0, 300) })
      }
    }
  } catch (error) {
    throws += 1
    failureDetails.push({ name: 'mutation#' + i + '-throw', message: String(error && error.message), sample: JSON.stringify(raw).slice(0, 300) })
  }
}
const mutationMs = Date.now() - startedAt

check('sanitizeSave: ' + MUTATIONS + ' hostile mutations never throw and accept only valid states', () => {
  ok(throws === 0, throws + ' mutation(s) made sanitizeSave throw')
  ok(acceptedFailures === 0, acceptedFailures + ' accepted mutation(s) violated schema invariants')
  ok(accepted + rejected === MUTATIONS, 'mutation accounting mismatch')
})

/* ---------------------------------------- 3. storage key discipline + I/O */

check('persistState writes only ' + STORE_KEY + ' and roundtrips through loadSavedState', () => {
  storageMap.clear()
  storage.setItem('foreign.key', 'keep-me')
  const state = randomPositions(3, 314159)
  const written = api.persistState(state)
  ok(written === true, 'persistState should report success')
  ok(storageMap.has(STORE_KEY), 'documented key must be written')
  ok(storage.getItem('foreign.key') === 'keep-me', 'persistState must not touch foreign keys')
  const keys = Array.from(storageMap.keys())
  ok(keys.length === 2, 'only the documented key (plus the pre-existing foreign key) should exist, got ' + keys.join(','))
  const rawText = storage.getItem(STORE_KEY)
  const parsed = JSON.parse(rawText)
  ok(parsed.schemaVersion === SCHEMA_VERSION, 'persisted schemaVersion')
  const loaded = api.loadSavedState()
  ok(loaded, 'loadSavedState must restore the persisted state')
  invariantCheck(loaded, 'restored')
  assert.deepStrictEqual(
    loaded.pieces.map((p) => p.id + ':' + p.x + ',' + p.y),
    parsed.pieces.map((p) => p.id + ':' + p.x + ',' + p.y),
    'restored arrangement',
  )
  ok(loaded.moves === parsed.moves && loaded.elapsedMs === parsed.elapsedMs, 'restored moves/elapsed')
})

check('source uses no other dsh.game.* key', () => {
  const source = readFile(new URL('../../client.js', import.meta.url), 'utf8')
  const keyLiterals = source.match(/dsh\.game\.[A-Za-z0-9_.-]+/g) || []
  ok(keyLiterals.length > 0, 'expected the store key literal in client.js')
  for (const literal of keyLiterals) ok(literal === STORE_KEY, 'unexpected store key literal: ' + literal)
  const localStorageCalls = source.match(/localStorage[^\n]*/g) || []
  for (const line of localStorageCalls) ok(!/getItem|setItem/.test(line) || /STORE_KEY/.test(line) || /typeof localStorage/.test(line), 'localStorage usage outside STORE_KEY: ' + line)
})

/* --------------------------------------------- 4. corrupt saves are rejected */

storageMap.clear()
const validSave = JSON.parse(JSON.stringify(api.serializeState(randomPositions(0, 555))))

function mustReject(name, raw) {
  check('reject: ' + name, () => {
    let result
    try {
      result = api.sanitizeSave(raw)
    } catch (error) {
      throw new Error('sanitizeSave threw: ' + error.message)
    }
    ok(result === null, 'expected null, got a state')
  })
}

mustReject('null', null)
mustReject('undefined', undefined)
mustReject('array', [])
mustReject('string', 'dsh.game.klotski.v1')
mustReject('number', 42)
mustReject('schemaVersion missing', (() => { const s = clone(validSave); delete s.schemaVersion; return s })())
mustReject('schemaVersion 2', { ...clone(validSave), schemaVersion: 2 })
mustReject('schemaVersion "1"', { ...clone(validSave), schemaVersion: '1' })
mustReject('levelIndex -1', { ...clone(validSave), levelIndex: -1 })
mustReject('levelIndex 4', { ...clone(validSave), levelIndex: 4 })
mustReject('levelIndex 1.5', { ...clone(validSave), levelIndex: 1.5 })
mustReject('levelIndex "1"', { ...clone(validSave), levelIndex: '1' })
mustReject('pieces overlap', {
  ...clone(validSave),
  pieces: clone(validSave.pieces).map((p, i) => (i === 1 ? { ...p, x: validSave.pieces[0].x, y: validSave.pieces[0].y } : p)),
})
mustReject('piece out of bounds', { ...clone(validSave), pieces: clone(validSave.pieces).map((p, i) => (i === 0 ? { ...p, x: 3, y: 4 } : p)) })
mustReject('piece count too short', { ...clone(validSave), pieces: clone(validSave.pieces).slice(0, 9) })
mustReject('piece count too long', { ...clone(validSave), pieces: clone(validSave.pieces).concat([{ id: 'x', x: 0, y: 0 }]) })
mustReject('duplicate piece id', {
  ...clone(validSave),
  pieces: clone(validSave.pieces).map((p, i) => (i === 1 ? { ...p, id: validSave.pieces[0].id } : p)),
})
mustReject('unknown piece id', { ...clone(validSave), pieces: clone(validSave.pieces).map((p, i) => (i === 0 ? { ...p, id: 'nope' } : p)) })
mustReject('moves -1', { ...clone(validSave), moves: -1 })
mustReject('moves 100001', { ...clone(validSave), moves: 100001 })
mustReject('moves 1.5', { ...clone(validSave), moves: 1.5 })
mustReject('elapsedMs -1', { ...clone(validSave), elapsedMs: -1 })
mustReject('elapsedMs > one week', { ...clone(validSave), elapsedMs: MAX_ELAPSED_MS + 1 })
mustReject('elapsedMs 1.5', { ...clone(validSave), elapsedMs: 1.5 })
mustReject('started non-boolean', { ...clone(validSave), started: 1 })
mustReject('won non-boolean', { ...clone(validSave), won: 'false' })
mustReject('won=false but Cao Cao is at the exit', { ...clone(validSave), pieces: syntheticWinningState(0).pieces, won: false, moves: 17 })
mustReject('won=true but Cao Cao is not at the exit', { ...clone(validSave), won: true })

check('winning state is accepted', () => {
  const win = syntheticWinningState(1)
  const sanitized = api.sanitizeSave(JSON.parse(JSON.stringify(api.serializeState(win))))
  ok(sanitized && sanitized.won === true, 'winning save should be accepted with won=true')
  invariantCheck(sanitized, 'winning')
})

check('loadSavedState: corrupt JSON / bad version fall back (null), good save restores', () => {
  storageMap.clear()
  ok(api.loadSavedState() === null, 'empty storage -> null')
  storage.setItem(STORE_KEY, '{not json')
  ok(api.loadSavedState() === null, 'bad JSON -> null')
  storage.setItem(STORE_KEY, JSON.stringify({ schemaVersion: 99 }))
  ok(api.loadSavedState() === null, 'wrong schemaVersion -> null')
  storage.setItem(STORE_KEY, JSON.stringify(validSave))
  const loaded = api.loadSavedState()
  ok(loaded && loaded.levelIndex === validSave.levelIndex, 'good save -> state')
  // createGame would fall back to createState(0) when loadSavedState() is null.
  ok(api.loadSavedState() !== null, 'valid save still loads')
})

check('loadSavedState never throws on 2000 random raw strings', () => {
  const weird = [
    '',
    'null',
    '[]',
    '{}',
    '{"schemaVersion":1}',
    '{"schemaVersion":1,"levelIndex":0,"pieces":"x"}',
    '{"schemaVersion":1,"levelIndex":0,"pieces":[],"moves":0,"elapsedMs":0,"started":false,"won":false}',
    '\u0000',
    'é'.repeat(50),
  ]
  storageMap.clear()
  for (let i = 0; i < 2000; i += 1) {
    const raw = weird[(rnd() * weird.length) | 0] + (rnd() < 0.5 ? '' : Math.random().toString(36).slice(2))
    storage.setItem(STORE_KEY, raw)
    try {
      api.loadSavedState()
    } catch (error) {
      throw new Error('loadSavedState threw on input #' + i + ': ' + error.message)
    }
  }
  storageMap.clear()
})

/* --------------------------------------------------- 5. undo/best sanitise */

check('sanitizeSave sanitises undo snapshots', () => {
  const base = JSON.parse(JSON.stringify(api.serializeState(randomPositions(2, 1111))))
  base.moves = 10
  base.undo = [
    null,
    'x',
    {},
    { pieces: clone(base.pieces), moves: 11 }, // moves > total -> drop
    { pieces: clone(base.pieces), moves: 3 }, // valid -> keep
    { pieces: [{ id: 'cao', x: 0, y: 0 }], moves: 2 }, // invalid arrangement -> drop
    { pieces: clone(base.pieces), moves: '2' }, // numeric string -> kept (strict int)
  ]
  const sanitized = api.sanitizeSave(base)
  ok(sanitized, 'base should be accepted')
  ok(sanitized.undo.length === 2, 'expected exactly 2 valid undo snapshots, got ' + sanitized.undo.length)
  invariantCheck(sanitized, 'undo-sanitise')
})

check('sanitizeSave sanitises best records', () => {
  const base = JSON.parse(JSON.stringify(api.serializeState(randomPositions(1, 2222))))
  base.best = {
    hengdao: { moves: 0, elapsedMs: 10 }, // moves < 1 -> drop
    zhihui: 'nope',
    qitou: { moves: 5, elapsedMs: -1 }, // elapsed < 0 -> drop
    cengceng: { moves: 6, elapsedMs: 600 }, // valid -> keep
    unknown_level: { moves: 3, elapsedMs: 3 }, // drop
  }
  const sanitized = api.sanitizeSave(base)
  ok(sanitized, 'base should be accepted')
  assert.deepStrictEqual(Object.keys(sanitized.best), ['cengceng'], 'only the valid known-level best record survives')
  invariantCheck(sanitized, 'best-sanitise')
})

/* --------------------------------------------------------------- results */

console.log('\n--- Result ---')
console.log(
  JSON.stringify(
    {
      checkCount: checks,
      failures,
      roundtripFieldsChecked: roundtripCount,
      mutations: { total: MUTATIONS, accepted, rejected, throws, acceptedFailures, path: 'sanitizeSave', ms: mutationMs },
      failureDetails: failureDetails.slice(0, 10),
    },
    null,
    2,
  ),
)

if (failures > 0) {
  console.error('\nSUITE 3 FAILED: ' + failures + ' failing check(s)')
  process.exitCode = 1
} else {
  console.log('\nSUITE 3 PASS — roundtrip, ' + MUTATIONS + ' hostile mutations with 0 throws, key discipline and rejection cases OK.')
}
