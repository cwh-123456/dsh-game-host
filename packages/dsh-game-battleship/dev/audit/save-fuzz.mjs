/**
 * save-fuzz.mjs — persistence audit: round-trip + corrupt-save mutation fuzz.
 *
 * Run (repo root):
 *   node packages/dsh-game-battleship/dev/audit/save-fuzz.mjs
 *   node packages/dsh-game-battleship/dev/audit/save-fuzz.mjs --mutations 5000
 * Read-only. Exit 0 = all persistence requirements hold.
 *
 * Requirements under test (handoff §技术约束 + contract §4 + task 1):
 *   R1 serializeState -> JSON -> sanitizeState is lossless for valid states in
 *      every phase (place/partial fleet, battle, mid-AI-turn, over by win,
 *      over by surrender; all difficulties; allowAdjacent on/off).
 *   R2 sanitizeState must NEVER throw, for any input (including non-JSON values).
 *   R3 every accepted sanitized state must itself be structurally valid per an
 *      independent validator: ship shapes/in-bounds/overlap/adjacency (incl.
 *      diagonal), hit cells on ships, miss cells off ships, winner/phase/turn
 *      consistency, shot parity (playerFired === enemyFired or enemyFired+1),
 *      endReason consistency (sunk / surrender).
 *   R4 sanitize/serialize must be a fixed point (a loaded save re-saved yields
 *      the identical state).
 *   R5 loadSavedState must never throw and must reject garbage / wrong schema /
 *      inconsistent saves; it returns the same state sanitize accepts.
 *   R6 saveStateToStorage writes exactly 'dsh.game.battleship.v1' and never
 *      touches other keys; a throwing localStorage is survivable both ways.
 *   R7 save size stays reasonable and a save is stable across save->load->save.
 */
import * as ref from './reference-battleship.mjs'
import { seam, env, resetEnv, makeHost } from './harness.mjs'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const index = argv.indexOf('--' + name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}
const MUTATIONS = Math.max(1, Number(arg('mutations', 5000)))

const checks = []
const failures = []
function check(name, condition, detail) {
  checks.push({ name, ok: !!condition, detail })
  if (!condition) failures.push(`${name}${detail === undefined ? '' : ' :: ' + detail}`)
}

/* ------------------------------------------------------------------ *
 * Independent validators (do NOT trust the client's sanitizeState)
 * ------------------------------------------------------------------ */
const STORE_KEY = seam.STORE_KEY
const clone = (value) => JSON.parse(JSON.stringify(value))

function countShots(shots) {
  if (!Array.isArray(shots)) return -1
  let count = 0
  for (const value of shots) if (value !== 0) count += 1
  return count
}

/**
 * Full independent consistency check for a save-shaped state.
 * Returns an array of problems (empty = acceptable).
 */
function validateSaveState(state) {
  const problems = ref.validateState(state)
  if (!state || typeof state !== 'object' || Array.isArray(state)) return problems
  if (state.schemaVersion !== 1) problems.push(`schemaVersion ${JSON.stringify(state.schemaVersion)} !== 1`)

  const playerFired = countShots(state.playerShots)
  const enemyFired = countShots(state.enemyShots)
  if (playerFired >= 0 && enemyFired >= 0 && state.phase !== 'place') {
    if (!(playerFired === enemyFired || playerFired === enemyFired + 1)) {
      problems.push(`shot parity broken: playerFired=${playerFired} enemyFired=${enemyFired}`)
    }
    if (state.phase === 'battle') {
      if (playerFired === enemyFired && state.turn !== 'player') problems.push(`battle: parity even but turn=${state.turn}`)
      if (playerFired === enemyFired + 1 && state.turn !== 'enemy') problems.push(`battle: parity odd but turn=${state.turn}`)
    }
    if (state.phase === 'over') {
      const playerFleetSunk = ref.allSunk(state.playerShips, state.enemyShots)
      const enemyFleetSunk = ref.allSunk(state.enemyShips, state.playerShots)
      if (state.winner === 'player') {
        if (!enemyFleetSunk) problems.push('winner=player but enemy fleet is not sunk')
        if (playerFleetSunk) problems.push('winner=player but player fleet is also sunk')
        if (playerFired !== enemyFired + 1) problems.push(`winner=player needs playerFired=enemyFired+1 (${playerFired}/${enemyFired})`)
        if (state.endReason !== 'sunk') problems.push(`winner=player endReason=${JSON.stringify(state.endReason)}`)
      } else if (state.winner === 'enemy') {
        if (playerFired !== enemyFired) problems.push(`winner=enemy needs playerFired=enemyFired (${playerFired}/${enemyFired})`)
        if (playerFleetSunk) {
          if (state.endReason !== 'sunk') problems.push(`player fleet sunk but endReason=${JSON.stringify(state.endReason)}`)
        } else if (state.endReason !== 'surrender') {
          problems.push(`player fleet alive but endReason=${JSON.stringify(state.endReason)} (expected surrender)`)
        }
        if (enemyFleetSunk) problems.push('winner=enemy but enemy fleet is also sunk')
      }
    }
  }
  if (state.phase === 'place') {
    if (countShots(state.playerShots) !== 0 || countShots(state.enemyShots) !== 0) problems.push('place phase has shots')
    if (state.turn !== 'player') problems.push(`place phase turn=${state.turn}`)
    if (state.winner !== null) problems.push('place phase has a winner')
    if (state.enemyShips.length !== 0) problems.push('place phase has enemy ships')
    if (state.placementIndex !== state.playerShips.length) problems.push('place phase placementIndex mismatch')
    if (state.endReason !== null && state.endReason !== undefined) problems.push(`place phase endReason=${JSON.stringify(state.endReason)} (must be null)`)
  } else if (Array.isArray(state.playerShips) && state.playerShips.length !== ref.SHIPS.length) {
    problems.push(`${state.phase} phase with ${state.playerShips.length} player ships`)
  }
  return problems
}

/* ------------------------------------------------------------------ *
 * State generators (drive the real seam like a player would)
 * ------------------------------------------------------------------ */
function randomUnfired(shots) {
  const cells = ref.unfiredCells(shots)
  return cells.length ? cells[Math.floor(Math.random() * cells.length)] : null
}

/**
 * Create a battle-ish state through the real seam. `steps` actions are played
 * (player shots + AI turns) unless the game ends first.
 */
function playState(seed, options = {}) {
  const state = seam.newGameState(seed)
  state.difficulty = options.difficulty || 'normal'
  state.allowAdjacent = options.allowAdjacent === true
  let randomized = false
  for (let attempt = 0; attempt < 30 && !randomized; attempt += 1) {
    randomized = seam.randomizePlayerFleet(state).ok === true
  }
  if (!randomized) throw new Error('could not randomize fleet for seed ' + seed)
  const start = seam.startBattle(state)
  if (!start.ok) throw new Error('startBattle failed for seed ' + seed)
  const localRng = ref.makeRng((seed >>> 0) ^ 0x2f6e2b1)
  const steps = options.steps === undefined ? 50 : options.steps
  for (let step = 0; step < steps; step += 1) {
    if (state.phase !== 'battle') break
    if (state.turn === 'player') {
      const cell = ref.unfiredCells(state.playerShots)[Math.floor(localRng() * ref.unfiredCells(state.playerShots).length)]
      const result = seam.fireAt(state, cell)
      if (!result.ok) break
    } else {
      const result = seam.aiFire(state)
      if (!result.ok) break
    }
  }
  return state
}

function makePartialPlaceState(seed) {
  const state = seam.newGameState(seed)
  const localRng = ref.makeRng(((seed >>> 0) ^ 0x1234abcd) >>> 0)
  for (let attempt = 0; attempt < 200 && state.placementIndex < 2; attempt += 1) {
    const origin = Math.floor(localRng() * 100)
    const orientation = localRng() < 0.5 ? 'h' : 'v'
    if (seam.canPlaceCurrent(state, origin, orientation).ok) seam.placeCurrent(state, origin, orientation)
  }
  return state
}

/**
 * A legal place-phase state with exactly `count` (0..5) player ships placed and
 * an empty enemy fleet. count=5 models "randomized but not started yet".
 */
function makePlaceState(count, seed = 1) {
  const state = seam.newGameState(seed)
  // deterministic legal layout for counts 1..4 (ships are placed in roster order)
  const layout = [
    [0, 'h'],   // carrier 0..4
    [23, 'v'],  // battleship 23,33,43,53
    [45, 'v'],  // cruiser 45,55,65
    [47, 'v'],  // submarine 47,57,67
  ]
  if (count >= 5) {
    for (let attempt = 0; attempt < 30 && state.placementIndex < 5; attempt += 1) {
      if (seam.randomizePlayerFleet(state).ok) break
    }
  } else {
    for (let i = 0; i < count; i += 1) {
      const [origin, orientation] = layout[i]
      const result = seam.placeCurrent(state, origin, orientation)
      if (!result.ok) throw new Error(`could not place ship ${i} for a ${count}-ship place state`)
    }
  }
  if (state.phase !== 'place' || state.placementIndex !== count || state.enemyShips.length !== 0) {
    throw new Error(`bad ${count}-ship place state: phase=${state.phase} index=${state.placementIndex} enemy=${state.enemyShips.length}`)
  }
  return state
}

function makeOverState(seed) {
  return playState(seed, { steps: 600 })
}

function makeSurrenderState(seed) {
  const state = playState(seed, { steps: 2 })
  if (state.phase === 'battle' && state.turn === 'enemy') seam.aiFire(state)
  const result = seam.surrender(state)
  if (!result.ok || state.phase !== 'over' || state.endReason !== 'surrender') {
    throw new Error('could not build a surrender state for seed ' + seed + ': ' + JSON.stringify(result))
  }
  return state
}

/** Play with a deliberately strong player (fires only at enemy ship cells) -> player win. */
function makePlayerWinState(seed) {
  const state = seam.newGameState(seed)
  for (let attempt = 0; attempt < 30 && state.phase === 'place'; attempt += 1) {
    if (seam.randomizePlayerFleet(state).ok) break
  }
  seam.startBattle(state)
  const shipsByCell = []
  for (const ship of state.enemyShips) for (const cell of ship.cells) shipsByCell.push(cell)
  let guard = 0
  while (state.phase === 'battle' && guard < 400) {
    guard += 1
    if (state.turn === 'player') {
      const cell = shipsByCell.find((candidate) => state.playerShots[candidate] === 0)
      if (cell === undefined) break
      seam.fireAt(state, cell)
    } else {
      seam.aiFire(state)
    }
  }
  if (state.winner !== 'player') throw new Error('could not build a player-win state for seed ' + seed)
  return state
}

/** Play deliberately badly (random shots) until the hunting AI wins. */
function makeEnemyWinState(seedStart) {
  for (let attemptSeed = seedStart; attemptSeed < seedStart + 200; attemptSeed += 1) {
    const state = seam.newGameState(attemptSeed)
    for (let attempt = 0; attempt < 30 && state.phase === 'place'; attempt += 1) {
      if (seam.randomizePlayerFleet(state).ok) break
    }
    seam.startBattle(state)
    const localRng = ref.makeRng((attemptSeed >>> 0) ^ 0x5eed1234)
    let guard = 0
    while (state.phase === 'battle' && guard < 400) {
      guard += 1
      if (state.turn === 'player') {
        const unfired = ref.unfiredCells(state.playerShots)
        if (!unfired.length) break
        seam.fireAt(state, unfired[Math.floor(localRng() * unfired.length)])
      } else {
        seam.aiFire(state)
      }
    }
    if (state.winner === 'enemy') return state
  }
  throw new Error('could not build an enemy-win state')
}

/* ------------------------------------------------------------------ *
 * R1 — lossless round-trip on realistic states in every phase
 * ------------------------------------------------------------------ */
resetEnv()
const roundTripStates = []
for (const seed of [0, 1, 7, 42, 123456, 0xffffffff]) {
  roundTripStates.push({ label: `place-partial seed ${seed}`, state: makePartialPlaceState(seed) })
  roundTripStates.push({ label: `battle seed ${seed}`, state: playState(seed, { steps: 40 }) })
  roundTripStates.push({ label: `mid-AI-turn seed ${seed}`, state: playState(seed, { steps: 41 }) })
}
for (const difficulty of ref.DIFFICULTIES) {
  roundTripStates.push({ label: `battle difficulty ${difficulty}`, state: playState(101, { steps: 30, difficulty }) })
}
roundTripStates.push({ label: 'battle allowAdjacent', state: playState(202, { steps: 25, allowAdjacent: true }) })
// place phase with 0/1/4/5 ships placed (5 = randomized but not started)
for (const count of [0, 1, 4, 5]) {
  roundTripStates.push({ label: `place-${count}-ships`, state: makePlaceState(count, count + 1) })
}
for (const seed of [3, 11, 99]) roundTripStates.push({ label: `over seed ${seed}`, state: makeOverState(seed) })
roundTripStates.push({ label: 'over-win player', state: makePlayerWinState(3) })
roundTripStates.push({ label: 'over-win enemy', state: makeEnemyWinState(11) })
roundTripStates.push({ label: 'over by surrender', state: makeSurrenderState(5) })

let roundTrips = 0
let maxSaveBytes = 0
for (const entry of roundTripStates) {
  const state = entry.state
  const snapshot = seam.serializeState(state)
  const json = JSON.stringify(snapshot)
  maxSaveBytes = Math.max(maxSaveBytes, json.length)
  let sanitized = null
  try {
    sanitized = seam.sanitizeState(JSON.parse(json))
  } catch (error) {
    check(`round-trip must not throw (${entry.label})`, false, String(error && error.message))
    continue
  }
  roundTrips += 1
  check(`round-trip accepted (${entry.label})`, !!sanitized)
  if (!sanitized) continue
  check(`round-trip lossless (${entry.label})`, JSON.stringify(seam.serializeState(sanitized)) === json, 'serialized state changed')
  const problems = validateSaveState(sanitized)
  check(`round-trip accepted state independently valid (${entry.label})`, problems.length === 0, problems.slice(0, 6).join(' | '))
  check(`round-trip phase preserved (${entry.label})`, sanitized.phase === state.phase, `${sanitized.phase} vs ${state.phase}`)
  check(`round-trip turn preserved (${entry.label})`, sanitized.turn === state.turn, `${sanitized.turn} vs ${state.turn}`)
  check(`round-trip endReason preserved (${entry.label})`, sanitized.endReason === (state.endReason === undefined ? null : state.endReason), `${sanitized.endReason} vs ${state.endReason}`)
  check(`round-trip ships preserved (${entry.label})`, JSON.stringify(sanitized.playerShips) === JSON.stringify(state.playerShips) && JSON.stringify(sanitized.enemyShips) === JSON.stringify(state.enemyShips))
  check(`round-trip shots preserved (${entry.label})`, JSON.stringify(sanitized.playerShots) === JSON.stringify(state.playerShots) && JSON.stringify(sanitized.enemyShots) === JSON.stringify(state.enemyShots))
  check(`round-trip placementIndex preserved (${entry.label})`, sanitized.placementIndex === state.placementIndex, `${sanitized.placementIndex} vs ${state.placementIndex}`)
  if (state.phase === 'place') {
    check(`round-trip place phase keeps enemyShips empty (${entry.label})`, Array.isArray(sanitized.enemyShips) && sanitized.enemyShips.length === 0)
    check(`round-trip place phase keeps endReason null (${entry.label})`, sanitized.endReason === null, String(sanitized.endReason))
  }
  // fixed point: a reloaded save re-saved yields the identical state
  const again = seam.sanitizeState(seam.serializeState(sanitized))
  check(`sanitize/serialize fixed point (${entry.label})`, again !== null && JSON.stringify(again) === JSON.stringify(sanitized), 'second sanitize differs')
}

// mid-AI-turn round-trip must actually be a mid-AI-turn state
const midTurnEntry = roundTripStates.find((entry) => entry.label === 'mid-AI-turn seed 0')
check('mid-AI-turn sample has turn=enemy in battle', midTurnEntry && midTurnEntry.state.phase === 'battle' && midTurnEntry.state.turn === 'enemy', midTurnEntry && `${midTurnEntry.state.phase}/${midTurnEntry.state.turn}`)

// over states: one win and one surrender must both round-trip
const overSamples = roundTripStates.filter((entry) => entry.label.startsWith('over'))
check(
  'over-state samples include a win and a surrender',
  overSamples.some((entry) => entry.state.winner === 'player') && overSamples.some((entry) => entry.state.endReason === 'surrender'),
  JSON.stringify(overSamples.map((entry) => ({ label: entry.label, phase: entry.state.phase, winner: entry.state.winner, endReason: entry.state.endReason }))),
)

/* ------------------------------------------------------------------ *
 * R5 — loadSavedState: garbage and cross-key isolation
 * ------------------------------------------------------------------ */
resetEnv()
const garbageSaves = [
  '', ' ', '{', '}', 'null', 'undefined', '[]', '[1,2,3]', '"a string"', '42', 'true',
  '{"schemaVersion":1}', '{"schemaVersion":2}', '{"schemaVersion":"1"}',
  '{"schemaVersion":1,"seed":1}', '{"schemaVersion":1,"seed":1,"phase":"battle"}',
  '{"seed":0,"rng":0}', '\u0000\u0001binary', '{"schemaVersion":1,"seed":-1}',
  JSON.stringify({ schemaVersion: 1, seed: 1, rng: 1, phase: 'place', allowAdjacent: false, difficulty: 'normal', orientation: 'h', placementIndex: 0, playerShips: [], enemyShips: [], playerShots: [], enemyShots: [], turn: 'player', winner: null }),
]
let garbageThrows = 0
for (const raw of garbageSaves) {
  env.storage.set(STORE_KEY, raw)
  try {
    const loaded = seam.loadSavedState()
    check(`garbage save rejected or valid (${JSON.stringify(raw).slice(0, 40)})`, loaded === null || validateSaveState(loaded).length === 0, loaded && validateSaveState(loaded).slice(0, 3).join(' | '))
  } catch (error) {
    garbageThrows += 1
    check(`garbage save must not throw (${JSON.stringify(raw).slice(0, 40)})`, false, String(error && error.message))
  }
}
check('garbage saves never threw', garbageThrows === 0, String(garbageThrows))

// a valid save loads back identically and other keys are never read/written
resetEnv()
{
  const state = playState(555, { steps: 30 })
  const snapshot = seam.serializeState(state)
  seam.saveStateToStorage(state)
  check(`saveStateToStorage writes exactly ${STORE_KEY}`, env.storage.size === 1 && env.storage.has(STORE_KEY), [...env.storage.keys()].join(','))
  const keysAfterSave = [...env.storage.keys()]
  env.storage.set('dsh.game.quoridor.v1', '{"schemaVersion":1,"evil":true}')
  env.storage.set('some.other.key', 'x')
  const loaded = seam.loadSavedState()
  check('loadSavedState returns the sanitized saved state', !!loaded && validateSaveState(loaded).length === 0, loaded && validateSaveState(loaded).slice(0, 4).join(' | '))
  check('loaded state equals saved state', loaded !== null && JSON.stringify(seam.serializeState(loaded)) === JSON.stringify(snapshot))
  check('loadSavedState does not modify other storage keys', env.storage.get('dsh.game.quoridor.v1') === '{"schemaVersion":1,"evil":true}' && env.storage.get('some.other.key') === 'x')
  check('save only created its own key', keysAfterSave.every((key) => key === STORE_KEY))
}

/* ------------------------------------------------------------------ *
 * R6 — storage failures never break gameplay
 * ------------------------------------------------------------------ */
{
  resetEnv()
  const saved = env.storage
  const brokenStorage = {
    getItem() { throw new Error('storage read failed') },
    setItem() { throw new Error('storage write failed') },
    removeItem() { throw new Error('storage remove failed') },
  }
  const previous = globalThis.window.localStorage
  globalThis.window.localStorage = brokenStorage
  try {
    check('loadSavedState survives throwing storage', seam.loadSavedState() === null)
    let threw = false
    let result = null
    try {
      result = seam.saveStateToStorage(playState(9, { steps: 10 }))
    } catch (error) {
      threw = true
    }
    check('saveStateToStorage survives throwing storage', !threw && result === false, String(result))
    let createThrew = false
    let controller = null
    try {
      controller = seam.createGame(makeHost(), {})
      controller.destroy()
    } catch (error) {
      createThrew = true
    }
    check('createGame survives throwing storage', !createThrew)
  } finally {
    globalThis.window.localStorage = previous
    void saved
  }
}

/* ------------------------------------------------------------------ *
 * Explicit must-reject corruption (one hand-written case per invariant)
 * ------------------------------------------------------------------ */
resetEnv()
const baseState = playState(2026, { steps: 60 })
const baseSave = JSON.parse(JSON.stringify(seam.serializeState(baseState)))
const waterCell = (() => {
  const shipCells = new Set(baseState.enemyShips.flatMap((ship) => ship.cells))
  for (let cell = 0; cell < 100; cell += 1) if (!shipCells.has(cell) && baseState.playerShots[cell] === 0) return cell
  return null
})()
const shipCell = baseState.enemyShips[0].cells[0]
const playerShipCell = baseState.playerShips[0].cells[0]

const mustReject = [
  ['wrong schemaVersion 2', (save) => { save.schemaVersion = 2 }],
  ['schemaVersion string', (save) => { save.schemaVersion = '1' }],
  ['schemaVersion missing', (save) => { delete save.schemaVersion }],
  ['top-level array', () => []],
  ['top-level null', () => null],
  ['top-level string', () => 'save'],
  ['seed negative', (save) => { save.seed = -1 }],
  ['seed > uint32', (save) => { save.seed = 0x100000000 }],
  ['seed non-integer', (save) => { save.seed = 1.5 }],
  ['rng negative', (save) => { save.rng = -1 }],
  ['rng NaN', (save) => { save.rng = NaN }],
  ['bad phase', (save) => { save.phase = 'lobby' }],
  ['allowAdjacent string', (save) => { save.allowAdjacent = 'yes' }],
  ['bad difficulty', (save) => { save.difficulty = 'insane' }],
  ['bad orientation', (save) => { save.orientation = 'diagonal' }],
  ['placementIndex negative', (save) => { save.placementIndex = -1 }],
  ['placementIndex > 5', (save) => { save.placementIndex = 6 }],
  ['placementIndex mismatch', (save) => { save.placementIndex = 2 }],
  ['ship overlap', (save) => { save.enemyShips[1].cells = save.enemyShips[0].cells.slice(0, save.enemyShips[1].cells.length) }],
  ['ship out of bounds (cell 100)', (save) => { save.enemyShips[0].cells = [95, 96, 97, 98, 100].slice(0, save.enemyShips[0].cells.length) }],
  ['ship out of bounds (negative)', (save) => { save.playerShips[0].cells = [-1, 0, 1, 2, 3].slice(0, save.playerShips[0].cells.length) }],
  ['ship wrong length', (save) => { save.enemyShips[0].cells = save.enemyShips[0].cells.slice(0, -1) }],
  ['ship not contiguous', (save) => { const cells = save.enemyShips[0].cells; cells[cells.length - 1] = cells[cells.length - 2] + 2 }],
  ['ship key mismatch', (save) => { save.enemyShips[0].key = 'destroyer' }],
  ['duplicate ship key', (save) => { save.enemyShips[1].key = save.enemyShips[0].key }],
  ['adjacency violation (default rules)', (save) => {
    // move battleship right under the carrier: adjacent, no overlap
    save.allowAdjacent = false
    const anchor = save.playerShips[0].cells[0]
    const x = ref.cellX(anchor)
    const y = ref.cellY(anchor) + 1
    save.playerShips[1].cells = [0, 1, 2, 3].map((offset) => ref.cellAt(Math.min(x, 6) + offset, y))
  }],
  ['hit on water', (save) => { if (waterCell !== null) save.playerShots[waterCell] = 2 }],
  ['miss on a ship', (save) => { save.playerShots[shipCell] = 1 }],
  ['enemy hit on water', (save) => { if (waterCell !== null) save.enemyShots[waterCell] = 2 }],
  ['enemy miss on own ship', (save) => { save.enemyShots[playerShipCell] = 1 }],
  ['shot value 3', (save) => { save.playerShots[0] = 3 }],
  ['shot value string', (save) => { save.playerShots[0] = '2' }],
  ['shot array too short', (save) => { save.playerShots.pop() }],
  ['shot array too long', (save) => { save.playerShots.push(0) }],
  ['winner mismatch (not sunk)', (save) => { save.phase = 'over'; save.winner = 'player'; save.endReason = 'sunk' }],
  ['winner enemy without sunk fleet or surrender', (save) => { save.phase = 'over'; save.winner = 'enemy'; save.endReason = 'sunk' }],
  ['over without winner', (save) => { save.phase = 'over' }],
  ['winner on a battle state', (save) => { save.winner = 'player' }],
  ['bad winner value', (save) => { save.winner = 'draw' }],
  ['turn mismatch in battle (even parity, enemy turn)', (save) => {
    save.turn = 'enemy'
  }],
  ['parity broken (two extra player shots)', (save) => {
    let added = 0
    for (let cell = 0; cell < 100 && added < 2; cell += 1) {
      if (save.playerShots[cell] === 0) { save.playerShots[cell] = 1; added += 1 }
    }
  }],
  ['endReason bogus', (save) => { save.endReason = 'timeout' }],
  ['player ships missing', (save) => { save.playerShips = [] }],
  ['enemy ships missing', (save) => { save.enemyShips = [] }],
  ['ships not arrays', (save) => { save.playerShips = {} }],
  ['null shots', (save) => { save.playerShots = null }],
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

// documented non-fatal normalization: unknown extra top-level keys are ignored
{
  const extras = clone(baseSave)
  extras.unknownTopLevel = { a: 1, nested: [1, 2, 3] }
  let sanitized = null
  try {
    sanitized = seam.sanitizeState(extras)
  } catch (error) {
    check('unknown extra keys must not throw', false, String(error && error.message))
  }
  check('unknown extra keys are ignored (not fatal)', !!sanitized && !('unknownTopLevel' in sanitized))
}

/* ------------------------------------------------------------------ *
 * place-phase save coverage (0/1/4/5 ships; enemyShips/endReason rules)
 * ------------------------------------------------------------------ */
let placeExplicitRejected = 0
let placeMustRejectCount = 0
{
  for (const count of [0, 1, 4, 5]) {
    const state = makePlaceState(count, 300 + count)
    const save = clone(seam.serializeState(state))
    const sanitized = seam.sanitizeState(save)
    check(`place-phase ${count}-ship save accepted`, !!sanitized)
    if (sanitized) {
      check(`place-phase ${count}-ship save placementIndex preserved`, sanitized.placementIndex === count, `${sanitized.placementIndex} vs ${count}`)
      check(`place-phase ${count}-ship save enemyShips empty`, Array.isArray(sanitized.enemyShips) && sanitized.enemyShips.length === 0)
      check(`place-phase ${count}-ship save endReason null`, sanitized.endReason === null, String(sanitized.endReason))
      const problems = validateSaveState(sanitized)
      check(`place-phase ${count}-ship save independently valid`, problems.length === 0, problems.slice(0, 4).join(' | '))
      check(`place-phase ${count}-ship save fixed point`, JSON.stringify(seam.sanitizeState(seam.serializeState(sanitized))) === JSON.stringify(sanitized))
    }
  }

  const state5 = makePlaceState(5, 4242)
  const save5 = clone(seam.serializeState(state5))

  // endReason is forced to null in the place phase (documented normalization)
  const withEndReason = clone(save5)
  withEndReason.endReason = 'sunk'
  const normalized = seam.sanitizeState(withEndReason)
  check('place-phase endReason is normalized to null (not fatal)', !!normalized && normalized.endReason === null, normalized && String(normalized.endReason))

  const placeMustReject = [
    ['place phase with enemyShips', () => {
      const mutated = clone(save5)
      mutated.enemyShips = clone(save5.playerShips) // 5 valid ships, but the enemy fleet must not exist yet
      return mutated
    }],
    ['place phase with shots on the board', () => {
      const mutated = clone(save5)
      mutated.playerShots[0] = 1
      return mutated
    }],
    ['place phase with a winner', () => {
      const mutated = clone(save5)
      mutated.winner = 'player'
      return mutated
    }],
    ['place phase with turn=enemy', () => {
      const mutated = clone(save5)
      mutated.turn = 'enemy'
      return mutated
    }],
    ['place phase with placementIndex mismatch', () => {
      const mutated = clone(save5)
      mutated.placementIndex = 4
      return mutated
    }],
    ['place phase with six ships', () => {
      const mutated = clone(save5)
      mutated.playerShips.push(clone(mutated.playerShips[0]))
      return mutated
    }],
  ]
  placeMustRejectCount = placeMustReject.length
  for (const [name, make] of placeMustReject) {
    let result = null
    let threw = false
    try {
      result = seam.sanitizeState(make())
    } catch (error) {
      threw = true
      check(`place-phase must-reject: ${name}`, false, 'sanitize threw: ' + (error && error.message))
    }
    if (!threw) {
      check(`place-phase must-reject: ${name}`, result === null, result ? 'accepted' : '')
      if (result === null) placeExplicitRejected += 1
    }
  }
  check('place-phase explicit must-reject cases rejected', placeExplicitRejected === placeMustRejectCount, `${placeExplicitRejected}/${placeMustRejectCount}`)
}

/* ------------------------------------------------------------------ *
 * R2/R3/R4 — corrupt mutation fuzz
 * ------------------------------------------------------------------ */
const keys = Object.keys(baseSave)
const rng = ref.makeRng(0xc0ffee)
const MUTATION_OPS = [
  'drop-key', 'set-value', 'schema-bump', 'phase-corrupt', 'allow-adjacent-corrupt',
  'difficulty-corrupt', 'orientation-corrupt', 'placement-index-corrupt', 'fleet-overlap',
  'fleet-out-of-bounds', 'fleet-shape', 'fleet-key', 'fleet-drop-ship', 'fleet-duplicate-ship',
  'shots-hit-on-water', 'shots-miss-on-ship', 'shots-value-corrupt', 'shots-length',
  'winner-corrupt', 'turn-corrupt', 'end-reason-corrupt', 'seed-corrupt', 'rng-corrupt',
  'parity-corrupt', 'null-everything', 'array-wrap', 'deep-nested',
]
let accepted = 0
let rejected = 0
let throws = 0
const acceptedInvalid = []
const firstThrows = []

for (let i = 0; i < MUTATIONS; i += 1) {
  let mutated = clone(baseSave)
  const op = MUTATION_OPS[Math.floor(rng() * MUTATION_OPS.length)]
  let description = op
  switch (op) {
    case 'drop-key': {
      const key = keys[Math.floor(rng() * keys.length)]
      delete mutated[key]
      description = 'delete ' + key
      break
    }
    case 'set-value': {
      const key = keys[Math.floor(rng() * keys.length)]
      const values = [null, 0, -1, 1.5, 'x', [], {}, true, false, 1e12, '', NaN, Infinity]
      mutated[key] = values[Math.floor(rng() * values.length)]
      description = `set ${key}=${String(mutated[key])}`
      break
    }
    case 'schema-bump': mutated.schemaVersion = 2; break
    case 'phase-corrupt': mutated.phase = ['lobby', 'over', 'battle', '', null][Math.floor(rng() * 5)]; break
    case 'allow-adjacent-corrupt': mutated.allowAdjacent = [true, false, 'true', 1, null][Math.floor(rng() * 5)]; break
    case 'difficulty-corrupt': mutated.difficulty = ['insane', '', null, 3][Math.floor(rng() * 4)]; break
    case 'orientation-corrupt': mutated.orientation = ['x', 'diagonal', '', null][Math.floor(rng() * 4)]; break
    case 'placement-index-corrupt': mutated.placementIndex = [-1, 6, 2.5, '3', null][Math.floor(rng() * 5)]; break
    case 'fleet-overlap': {
      const index = Math.floor(rng() * mutated.enemyShips.length)
      const other = (index + 1) % mutated.enemyShips.length
      mutated.enemyShips[index].cells = mutated.enemyShips[other].cells.slice(0, mutated.enemyShips[index].cells.length)
      description = 'enemy fleet overlap'
      break
    }
    case 'fleet-out-of-bounds': {
      const fleet = rng() < 0.5 ? mutated.playerShips : mutated.enemyShips
      const index = Math.floor(rng() * fleet.length)
      const cells = fleet[index].cells
      const mode = Math.floor(rng() * 4)
      if (mode === 0) cells[0] = 100
      else if (mode === 1) cells[0] = -1
      else if (mode === 2) cells[0] = 1.5
      else cells[0] = '5'
      description = 'out-of-bounds ship cell'
      break
    }
    case 'fleet-shape': {
      const fleet = rng() < 0.5 ? mutated.playerShips : mutated.enemyShips
      const index = Math.floor(rng() * fleet.length)
      const cells = fleet[index].cells
      const mode = Math.floor(rng() * 4)
      if (mode === 0) cells[cells.length - 1] = cells[cells.length - 2] + 2
      else if (mode === 1) cells.reverse()
      else if (mode === 2) cells[0] = cells[0] + 10
      else cells[1] = cells[0]
      description = 'broken ship shape'
      break
    }
    case 'fleet-key': {
      const fleet = rng() < 0.5 ? mutated.playerShips : mutated.enemyShips
      const index = Math.floor(rng() * fleet.length)
      fleet[index].key = ['carrier', 'destroyer', 'bogus', null][Math.floor(rng() * 4)]
      description = 'ship key corruption'
      break
    }
    case 'fleet-drop-ship': {
      if (rng() < 0.5) mutated.playerShips.pop()
      else mutated.enemyShips.pop()
      description = 'dropped a ship'
      break
    }
    case 'fleet-duplicate-ship': {
      const fleet = rng() < 0.5 ? mutated.playerShips : mutated.enemyShips
      if (fleet.length > 1) fleet[1] = clone(fleet[0])
      description = 'duplicated ship'
      break
    }
    case 'shots-hit-on-water': {
      const shots = rng() < 0.5 ? mutated.playerShots : mutated.enemyShots
      let cell = Math.floor(rng() * 100)
      if (shots[cell] !== 0) { for (let pos = 0; pos < 100; pos += 1) if (shots[pos] === 0) { cell = pos; break } }
      shots[cell] = 2
      description = 'hit on water'
      break
    }
    case 'shots-miss-on-ship': {
      const usePlayer = rng() < 0.5
      const ships = usePlayer ? mutated.enemyShips : mutated.playerShips
      const shots = usePlayer ? mutated.playerShots : mutated.enemyShots
      const ship = ships[Math.floor(rng() * ships.length)]
      const cell = ship.cells[Math.floor(rng() * ship.cells.length)]
      shots[cell] = 1
      description = 'miss on a ship'
      break
    }
    case 'shots-value-corrupt': {
      const shots = rng() < 0.5 ? mutated.playerShots : mutated.enemyShots
      const cell = Math.floor(rng() * 100)
      shots[cell] = [3, -1, 1.5, '2', null, NaN][Math.floor(rng() * 6)]
      description = 'bad shot value'
      break
    }
    case 'shots-length': {
      const shots = rng() < 0.5 ? mutated.playerShots : mutated.enemyShots
      if (rng() < 0.5) shots.pop()
      else shots.push(0)
      description = 'bad shot array length'
      break
    }
    case 'winner-corrupt': mutated.winner = ['player', 'enemy', 'draw', 1, true][Math.floor(rng() * 5)]; break
    case 'turn-corrupt': mutated.turn = ['player', 'enemy', 'ai', null][Math.floor(rng() * 4)]; break
    case 'end-reason-corrupt': mutated.endReason = ['sunk', 'surrender', 'timeout', 1, null][Math.floor(rng() * 5)]; break
    case 'seed-corrupt': mutated.seed = [-1, 1.5, 2 ** 32, NaN, 2 ** 40][Math.floor(rng() * 5)]; break
    case 'rng-corrupt': mutated.rng = [-1, 1.5, 2 ** 32, NaN, 2 ** 40][Math.floor(rng() * 5)]; break
    case 'parity-corrupt': {
      const target = rng() < 0.5 ? mutated.playerShots : mutated.enemyShots
      const extra = 1 + Math.floor(rng() * 3)
      let added = 0
      for (let cell = 0; cell < 100 && added < extra; cell += 1) {
        if (target[cell] === 0) { target[cell] = 1; added += 1 }
      }
      description = `parity +${extra}`
      break
    }
    case 'null-everything': mutated = null; break
    case 'array-wrap': mutated = [mutated]; break
    case 'deep-nested': {
      const pick = Math.floor(rng() * 4)
      if (pick === 0) mutated.playerShots[10] = [1, 2, 3]
      else if (pick === 1) mutated.enemyShips[0].cells = { 0: 1, 1: 2 }
      else if (pick === 2) mutated.playerShips = [mutated.playerShips[0], mutated.playerShips[0]]
      else mutated.winner = { winner: 'player' }
      break
    }
  }
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
    const problems = validateSaveState(result)
    if (problems.length) {
      acceptedInvalid.push({ description, variantName, problems: problems.slice(0, 8), sample: JSON.stringify(result).slice(0, 600) })
      continue
    }
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

/* R5b: corrupted save through loadSavedState matches sanitize verdict */
resetEnv()
{
  let loadMismatch = 0
  for (let i = 0; i < 200; i += 1) {
    const mutated = clone(baseSave)
    const key = keys[Math.floor(rng() * keys.length)]
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
    const loadJson = viaLoad ? JSON.stringify(seam.serializeState(viaLoad)) : 'null'
    const directJson = direct ? JSON.stringify(seam.serializeState(direct)) : 'null'
    if (loadJson !== directJson) loadMismatch += 1
  }
  check('loadSavedState agrees with sanitizeState on corrupt saves', loadMismatch === 0, `${loadMismatch}/200 mismatches`)
}

/* R7: serialization stability across two save/load cycles + size */
resetEnv()
{
  const state = playState(8080, { steps: 70 })
  seam.saveStateToStorage(state)
  const first = env.storage.get(STORE_KEY)
  const reloaded = seam.loadSavedState()
  check('saveStateToStorage + loadSavedState round-trip', !!reloaded)
  seam.saveStateToStorage(reloaded)
  const second = env.storage.get(STORE_KEY)
  check('save is stable across save -> load -> save', first === second, `${String(first).length} vs ${String(second).length} bytes`)
  check('save size is sane (< 64 KiB)', String(first).length < 64 * 1024, `${String(first).length} bytes`)
  const parsed = JSON.parse(first)
  check('saved JSON contains schemaVersion 1 and the documented seed', parsed.schemaVersion === 1 && Number.isInteger(parsed.seed))
  check(`saved JSON is written only under ${STORE_KEY}`, env.storage.size === 1 && env.storage.has(STORE_KEY), [...env.storage.keys()].join(','))
}

// place-phase reload keeps the placed ships (restore placement after unmount)
{
  resetEnv()
  const state = makePartialPlaceState(4242)
  seam.saveStateToStorage(state)
  const loaded = seam.loadSavedState()
  check('place-phase save reloads with ships and placementIndex', !!loaded && loaded.phase === 'place' && JSON.stringify(loaded.playerShips) === JSON.stringify(state.playerShips) && loaded.placementIndex === state.placementIndex)
  check('place-phase save reloads with enemyShips empty', !!loaded && loaded.enemyShips.length === 0)
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */
const passed = checks.filter((item) => item.ok).length
console.log('\n=== save-fuzz summary ===')
console.log(`round-trip cases: ${roundTrips} (place/battle/mid-AI-turn/over/difficulty/allowAdjacent)`)
console.log(`corrupt mutations: ${MUTATIONS} x 2 forms (JSON + raw) = ${MUTATIONS * 2} sanitize calls`)
console.log(`  accepted (renormalized): ${accepted}, rejected: ${rejected}, throws: ${throws}`)
console.log(`explicit must-reject cases: ${explicitRejected}/${mustReject.length} rejected`)
console.log(`place-phase explicit must-reject cases: ${placeExplicitRejected}/${placeMustRejectCount} rejected`)
console.log(`max observed save size: ${maxSaveBytes} bytes`)
console.log(`checks: ${checks.length}, passed: ${passed}, failed: ${failures.length}`)
for (const failure of failures) console.log('  FAIL ' + failure)
if (failures.length) {
  console.error('\nSAVE-FUZZ FAILED')
  process.exit(1)
}
console.log('\nSAVE-FUZZ OK')
