/**
 * Duo (same-device hot-seat) tests for @local/dsh-game-battleship (dev-only).
 *
 * Covers the second mode added after v1: who places which fleet, the hand-off
 * curtain, perspective switching, win/surrender by either side, save/restore in
 * every sub-state and the fact that solo mode is untouched.
 *
 * Run from the repo root:  node packages/dsh-game-battleship/dev/test-duo.mjs
 */

const store = new Map()
globalThis.window = {
  __DSH_GAME_BATTLESHIP_TEST__: true,
  devicePixelRatio: 1,
  localStorage: {
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      store.set(key, String(value))
    },
    removeItem(key) {
      store.delete(key)
    },
  },
}

await import('../client.js')
const G = window.__DSH_GAME_BATTLESHIP__
if (!G) throw new Error('test seam missing (window.__DSH_GAME_BATTLESHIP__)')

const results = { pass: 0, fail: 0, failures: [] }
function test(name, fn) {
  try {
    fn()
    results.pass += 1
  } catch (error) {
    results.fail += 1
    results.failures.push(
      name + ': ' + (error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error)),
    )
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(label + ': expected ' + b + ', got ' + a)
}
function ok(cond, label) {
  if (!cond) throw new Error(label)
}

// ---------------------------------------------------------------------------
// Fleet fixtures: two fleets that respect "no adjacency" and never overlap.
// ---------------------------------------------------------------------------

function horizontalFleet() {
  return G.SHIPS.map(function (def, index) {
    const origin = index * 20
    return { key: def.key, cells: G.shipCells(origin, def.len, true) }
  })
}

function verticalFleet() {
  return G.SHIPS.map(function (def, index) {
    const origin = index * 2
    return { key: def.key, cells: G.shipCells(origin, def.len, false) }
  })
}

function fillFleetDirect(state, side, fleet) {
  const target = side === 'enemy' ? state.enemyShips : state.playerShips
  target.length = 0
  for (let i = 0; i < fleet.length; i += 1) target.push({ key: fleet[i].key, cells: fleet[i].cells.slice() })
}

function duoPlacing() {
  const state = G.newGameState(7, 'duo')
  fillFleetDirect(state, 'player', horizontalFleet())
  state.placementIndex = 5
  const started = G.startBattle(state)
  if (!started.ok) throw new Error('P1 start failed: ' + JSON.stringify(started))
  return state
}

function duoBattle() {
  const state = duoPlacing()
  G.acknowledgeHandoff(state)
  fillFleetDirect(state, 'enemy', verticalFleet())
  state.placementIndex = 5
  const started = G.startBattle(state)
  if (!started.ok) throw new Error('P2 start failed: ' + JSON.stringify(started))
  G.acknowledgeHandoff(state)
  return state
}

function roundTrip(state) {
  const saved = JSON.parse(JSON.stringify(G.serializeState(state)))
  return G.sanitizeState(saved)
}

// ---------------------------------------------------------------------------
// Mode + placement routing
// ---------------------------------------------------------------------------

test('default mode is solo', () => {
  const state = G.newGameState(1)
  eq(state.mode, 'ai', 'mode')
  eq(state.placeTurn, 'player', 'placeTurn')
  eq(state.handoff, null, 'handoff')
})

test('duo mode is opt-in', () => {
  const state = G.newGameState(1, 'duo')
  eq(state.mode, 'duo', 'mode')
})

test('duo: player A writes playerShips', () => {
  const state = G.newGameState(5, 'duo')
  const placed = G.placeCurrent(state, 0, 'h')
  ok(placed.ok, 'place ok')
  eq(state.playerShips.length, 1, 'P1 fleet')
  eq(state.enemyShips.length, 0, 'P2 fleet untouched')
  eq(state.placementIndex, 1, 'index')
  eq(placed.side, 'player', 'side')
})

test('duo: player A cannot overlap his own ship', () => {
  const state = G.newGameState(5, 'duo')
  ok(G.placeCurrent(state, 0, 'h').ok, 'first')
  const second = G.placeCurrent(state, 2, 'h')
  eq(second.ok, false, 'overlap rejected')
  eq(second.reason, 'overlap', 'reason')
})

test('duo: cannot start with an incomplete fleet', () => {
  const state = G.newGameState(5, 'duo')
  G.placeCurrent(state, 0, 'h')
  const started = G.startBattle(state)
  eq(started.ok, false, 'rejected')
  eq(started.reason, 'fleet', 'reason')
})

test('duo: player A finished hands over to B', () => {
  const state = duoPlacing()
  eq(state.phase, 'place', 'still placing')
  eq(state.placeTurn, 'enemy', 'B places next')
  eq(state.handoff, 'curtain', 'curtain up')
  eq(state.enemyShips.length, 0, 'B fleet empty')
})

test('duo: curtain acknowledgement', () => {
  const state = duoPlacing()
  const ack = G.acknowledgeHandoff(state)
  ok(ack.ok, 'ack ok')
  eq(state.handoff, null, 'curtain cleared')
})

test('duo: acknowledge twice is rejected', () => {
  const state = duoPlacing()
  G.acknowledgeHandoff(state)
  eq(G.acknowledgeHandoff(state).ok, false, 'second ack rejected')
})

test('duo: player B writes enemyShips only', () => {
  const state = duoPlacing()
  G.acknowledgeHandoff(state)
  const placed = G.placeCurrent(state, 0, 'h')
  ok(placed.ok, 'place ok')
  eq(placed.side, 'enemy', 'side')
  eq(state.enemyShips.length, 1, 'B fleet')
  eq(state.playerShips.length, 5, 'A fleet untouched')
  eq(G.placedShips(state), state.enemyShips, 'placing target')
  eq(G.placingSide(state), 'enemy', 'placing side')
})

test('duo: B finishing starts the battle behind the curtain', () => {
  const state = duoPlacing()
  G.acknowledgeHandoff(state)
  fillFleetDirect(state, 'enemy', verticalFleet())
  state.placementIndex = 5
  const started = G.startBattle(state)
  ok(started.ok, 'start ok')
  eq(state.phase, 'battle', 'phase')
  eq(state.turn, 'player', 'A first')
  eq(state.handoff, 'curtain', 'curtain before A fires')
  eq(state.playerShots.filter(Boolean).length, 0, 'no shots')
  eq(state.enemyShots.filter(Boolean).length, 0, 'no shots')
})

// ---------------------------------------------------------------------------
// Battle flow / perspective
// ---------------------------------------------------------------------------

test('duo: nobody fires while the curtain is up', () => {
  const state = duoBattle()
  // Simulate the curtain again after a restart.
  G.restartBattle(state)
  eq(state.handoff, 'curtain', 'curtain')
  eq(G.fireAtSide(state, 'player', 0).ok, false, 'blocked')
})

test('duo: A fires at B fleet and passes the device', () => {
  const state = duoBattle()
  const target = state.enemyShips[0].cells[0]
  const result = G.fireAtSide(state, 'player', target)
  ok(result.ok, 'fire ok')
  eq(result.result, 'hit', 'hit')
  eq(state.playerShots[target], 2, 'marked on B board')
  eq(state.turn, 'enemy', 'turn passed')
  eq(state.handoff, 'pass', 'waiting for hand-over')
  eq(G.viewSideOf(state), 'player', 'shooter still sees own view')
})

test('duo: B cannot fire before the hand-over', () => {
  const state = duoBattle()
  G.fireAtSide(state, 'player', 0)
  eq(G.fireAtSide(state, 'enemy', 0).ok, false, 'blocked during pass')
})

test('duo: pass then acknowledge flips the perspective to B', () => {
  const state = duoBattle()
  G.fireAtSide(state, 'player', 0)
  ok(G.passDevice(state).ok, 'pass ok')
  eq(state.handoff, 'curtain', 'curtain')
  eq(G.viewSideOf(state), 'enemy', 'B sees B board')
  ok(G.acknowledgeHandoff(state).ok, 'ack ok')
  eq(state.handoff, null, 'cleared')
  eq(G.viewSideOf(state), 'enemy', 'still B')
})

test('duo: B fires at A fleet', () => {
  const state = duoBattle()
  G.fireAtSide(state, 'player', 0)
  G.passDevice(state)
  G.acknowledgeHandoff(state)
  const target = state.playerShips[0].cells[0]
  const result = G.fireAtSide(state, 'enemy', target)
  ok(result.ok, 'fire ok')
  eq(result.side, 'enemy', 'side')
  eq(state.enemyShots[target], 2, 'marked on A board')
  eq(state.turn, 'player', 'back to A')
  eq(state.handoff, 'pass', 'hand-over again')
  eq(G.viewSideOf(state), 'enemy', 'B still sees own view')
})

test('duo: a cell already fired cannot be fired again', () => {
  const state = duoBattle()
  G.fireAtSide(state, 'player', 0)
  G.passDevice(state)
  G.acknowledgeHandoff(state)
  G.fireAtSide(state, 'enemy', 0)
  G.passDevice(state)
  G.acknowledgeHandoff(state)
  const again = G.fireAtSide(state, 'player', 0)
  eq(again.ok, false, 'rejected')
  eq(again.reason, 'fired', 'reason')
})

test('duo: A wins by sinking the whole B fleet', () => {
  const state = duoBattle()
  const cells = []
  for (let i = 0; i < state.enemyShips.length; i += 1) {
    for (let j = 0; j < state.enemyShips[i].cells.length; j += 1) cells.push(state.enemyShips[i].cells[j])
  }
  let result = null
  for (let i = 0; i < cells.length; i += 1) {
    result = G.fireAtSide(state, 'player', cells[i])
    if (!result.ok) throw new Error('fire failed: ' + JSON.stringify(result))
    if (state.phase === 'over') break
    G.passDevice(state)
    G.acknowledgeHandoff(state)
    // B fires somewhere harmless, then hands back.
    for (let cell = 0; cell < 100; cell += 1) {
      if (state.enemyShots[cell] === 0) {
        G.fireAtSide(state, 'enemy', cell)
        break
      }
    }
    G.passDevice(state)
    G.acknowledgeHandoff(state)
  }
  eq(state.phase, 'over', 'phase')
  eq(state.winner, 'player', 'winner')
  eq(state.endReason, 'sunk', 'reason')
  eq(result.result, 'win', 'last shot')
  eq(state.handoff, null, 'no curtain at the end')
})

test('duo: B wins by sinking the whole A fleet', () => {
  const state = duoBattle()
  const cells = []
  for (let i = 0; i < state.playerShips.length; i += 1) {
    for (let j = 0; j < state.playerShips[i].cells.length; j += 1) cells.push(state.playerShips[i].cells[j])
  }
  // Burn A's turns on empty water far away from B's fleet.
  let index = 0
  while (state.phase === 'battle' && index < 400) {
    index += 1
    if (state.turn === 'player') {
      let cell = -1
      for (let c = 99; c >= 0; c -= 1) {
        if (state.playerShots[c] === 0) {
          cell = c
          break
        }
      }
      G.fireAtSide(state, 'player', cell)
    } else {
      const next = cells.shift()
      if (next === undefined) break
      const result = G.fireAtSide(state, 'enemy', next)
      if (!result.ok) throw new Error('B fire failed: ' + JSON.stringify(result))
      if (state.phase === 'over') break
    }
    if (state.handoff) {
      G.passDevice(state)
      G.acknowledgeHandoff(state)
    }
  }
  eq(state.phase, 'over', 'phase')
  eq(state.winner, 'enemy', 'winner')
  eq(state.endReason, 'sunk', 'reason')
})

test('duo: B can resign, A wins', () => {
  const state = duoBattle()
  G.fireAtSide(state, 'player', 0)
  G.passDevice(state)
  G.acknowledgeHandoff(state)
  const result = G.surrender(state)
  ok(result.ok, 'surrender ok')
  eq(result.side, 'enemy', 'B resigned')
  eq(state.winner, 'player', 'A wins')
  eq(state.endReason, 'surrender', 'reason')
})

test('duo: A can resign, B wins', () => {
  const state = duoBattle()
  const result = G.surrender(state)
  ok(result.ok, 'surrender ok')
  eq(state.winner, 'enemy', 'B wins')
})

test('duo: restart keeps fleets, clears shots, asks for the curtain', () => {
  const state = duoBattle()
  G.fireAtSide(state, 'player', 0)
  ok(G.restartBattle(state).ok, 'restart ok')
  eq(state.phase, 'battle', 'phase')
  eq(state.turn, 'player', 'A first')
  eq(state.handoff, 'curtain', 'curtain')
  eq(state.playerShots.filter(Boolean).length, 0, 'shots cleared')
})

// ---------------------------------------------------------------------------
// Solo mode must be untouched
// ---------------------------------------------------------------------------

test('solo: startBattle still generates the AI fleet', () => {
  const state = G.newGameState(11)
  fillFleetDirect(state, 'player', horizontalFleet())
  state.placementIndex = 5
  const started = G.startBattle(state)
  ok(started.ok, 'start ok')
  eq(state.enemyShips.length, 5, 'AI fleet generated')
  eq(state.handoff, null, 'no curtain in solo')
  eq(G.viewSideOf(state), 'player', 'solo view')
})

test('solo: fire and AI reply keep working', () => {
  const state = G.newGameState(12)
  fillFleetDirect(state, 'player', horizontalFleet())
  state.placementIndex = 5
  G.startBattle(state)
  ok(G.fireAt(state, 0).ok, 'player fire')
  eq(state.turn, 'enemy', 'ai turn')
  ok(G.aiFire(state).ok, 'ai fire')
  eq(state.turn, 'player', 'back to player')
  eq(state.handoff, null, 'no curtain in solo')
})

// ---------------------------------------------------------------------------
// Save / restore
// ---------------------------------------------------------------------------

test('save: solo save keeps mode/placeTurn/handoff', () => {
  const state = G.newGameState(13)
  const restored = roundTrip(state)
  ok(restored, 'accepted')
  eq(restored.mode, 'ai', 'mode')
  eq(restored.handoff, null, 'handoff')
})

test('save: legacy save without mode loads as solo', () => {
  const raw = JSON.parse(JSON.stringify(G.serializeState(G.newGameState(14))))
  delete raw.mode
  delete raw.placeTurn
  delete raw.handoff
  const restored = G.sanitizeState(raw)
  ok(restored, 'accepted')
  eq(restored.mode, 'ai', 'mode')
  eq(restored.placeTurn, 'player', 'placeTurn')
})

test('save: duo place A mid-placement round-trips', () => {
  const state = G.newGameState(15, 'duo')
  G.placeCurrent(state, 0, 'h')
  G.placeCurrent(state, 20, 'h')
  const restored = roundTrip(state)
  ok(restored, 'accepted')
  eq(restored.mode, 'duo', 'mode')
  eq(restored.playerShips.length, 2, 'P1 progress')
  eq(restored.placementIndex, 2, 'index')
  eq(G.placedShips(restored).length, 2, 'placing target restored')
})

test('save: duo place B behind the curtain round-trips', () => {
  const state = duoPlacing()
  G.acknowledgeHandoff(state)
  G.placeCurrent(state, 0, 'h')
  const restored = roundTrip(state)
  ok(restored, 'accepted')
  eq(restored.placeTurn, 'enemy', 'placeTurn')
  eq(restored.enemyShips.length, 1, 'B progress')
  eq(restored.playerShips.length, 5, 'A fleet kept')
  eq(G.placingSide(restored), 'enemy', 'placing side')
})

test('save: duo battle mid-pass round-trips', () => {
  const state = duoBattle()
  G.fireAtSide(state, 'player', 0)
  const restored = roundTrip(state)
  ok(restored, 'accepted')
  eq(restored.handoff, 'pass', 'handoff')
  eq(restored.turn, 'enemy', 'turn')
  eq(G.viewSideOf(restored), 'player', 'view stays with shooter')
})

test('save: duo battle curtain round-trips', () => {
  const state = duoBattle()
  G.fireAtSide(state, 'player', 0)
  G.passDevice(state)
  const restored = roundTrip(state)
  ok(restored, 'accepted')
  eq(restored.handoff, 'curtain', 'handoff')
  eq(G.viewSideOf(restored), 'enemy', 'view flipped')
})

test('save: duo game over round-trips', () => {
  const state = duoBattle()
  const cells = state.enemyShips.reduce(function (acc, ship) {
    return acc.concat(ship.cells)
  }, [])
  let i = 0
  while (state.phase === 'battle' && i < cells.length) {
    G.fireAtSide(state, 'player', cells[i])
    i += 1
    if (state.phase === 'over') break
    G.passDevice(state)
    G.acknowledgeHandoff(state)
    for (let cell = 0; cell < 100; cell += 1) {
      if (state.enemyShots[cell] === 0) {
        G.fireAtSide(state, 'enemy', cell)
        break
      }
    }
    G.passDevice(state)
    G.acknowledgeHandoff(state)
  }
  const restored = roundTrip(state)
  ok(restored, 'accepted')
  eq(restored.phase, 'over', 'phase')
  eq(restored.winner, 'player', 'winner')
  eq(restored.endReason, 'sunk', 'reason')
})

test('save: reject unknown mode', () => {
  const raw = JSON.parse(JSON.stringify(G.serializeState(G.newGameState(16, 'duo'))))
  raw.mode = 'coop'
  eq(G.sanitizeState(raw), null, 'rejected')
})

test('save: reject handoff in solo mode', () => {
  const raw = JSON.parse(JSON.stringify(G.serializeState(G.newGameState(17))))
  raw.handoff = 'pass'
  raw.phase = 'battle'
  eq(G.sanitizeState(raw), null, 'rejected')
})

test('save: reject pass outside battle', () => {
  const raw = JSON.parse(JSON.stringify(G.serializeState(G.newGameState(18, 'duo'))))
  raw.handoff = 'pass'
  eq(G.sanitizeState(raw), null, 'rejected')
})

test('save: reject B placing before A finished', () => {
  const raw = JSON.parse(JSON.stringify(G.serializeState(G.newGameState(19, 'duo'))))
  raw.placeTurn = 'enemy'
  raw.placementIndex = 0
  eq(G.sanitizeState(raw), null, 'rejected')
})

test('save: reject index that does not match the fleet being placed', () => {
  const state = G.newGameState(20, 'duo')
  G.placeCurrent(state, 0, 'h')
  const raw = JSON.parse(JSON.stringify(G.serializeState(state)))
  raw.placementIndex = 3
  eq(G.sanitizeState(raw), null, 'rejected')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (results.fail) {
  console.error('\nbattleship test-duo: ' + results.pass + '/' + (results.pass + results.fail) + ' passed')
  for (const failure of results.failures) console.error('  FAIL ' + failure)
  process.exit(1)
}
console.log('\nbattleship test-duo: ' + results.pass + '/' + results.pass + ' passed, 0 failed')
