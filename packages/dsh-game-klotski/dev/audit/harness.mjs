/**
 * Shared Node harness for the INDEPENDENT verifier audit.
 *
 * It installs exactly the documented client.js test seam:
 *   globalThis.window = {
 *     __DSH_GAME_KLOTSKI_TEST__: true,
 *     __ModuleLoader__: { load(){} },
 *     localStorage: <fake>,
 *   }
 * then imports ../client.js once. The seam exposes window.__DSH_GAME_KLOTSKI__.
 *
 * This file contains NO rule/solver logic and never imports dev/solve.mjs.
 */
export const storageMap = new Map()

export const storage = {
  getItem(key) {
    const k = String(key)
    return storageMap.has(k) ? storageMap.get(k) : null
  },
  setItem(key, value) {
    storageMap.set(String(key), String(value))
  },
  removeItem(key) {
    storageMap.delete(String(key))
  },
  clear() {
    storageMap.clear()
  },
  key(index) {
    const keys = Array.from(storageMap.keys())
    return index >= 0 && index < keys.length ? keys[index] : null
  },
  get length() {
    return storageMap.size
  },
}

const loaded = {}

globalThis.window = {
  __DSH_GAME_KLOTSKI_TEST__: true,
  __ModuleLoader__: {
    load(definition) {
      loaded.definition = definition
      globalThis.window.__loadedDefinition = definition
    },
  },
  localStorage: storage,
  devicePixelRatio: 2,
  addEventListener() {},
  removeEventListener() {},
}

// The seam is read through `window`; keep this file's global surface minimal.
try {
  globalThis.localStorage = storage
} catch (ignored) {
  /* Node may define a non-writable global localStorage; window.localStorage still works */
}

await import(new URL('../../client.js', import.meta.url).href)

export const api = globalThis.window.__DSH_GAME_KLOTSKI__
export const definition = loaded.definition

if (!api) throw new Error('harness: client.js did not install the test seam')
if (!definition) throw new Error('harness: client.js did not call window.__ModuleLoader__.load')

/** Build the plain state object shape the seam's engine functions accept. */
export function clientState(levelIndex, positions) {
  const level = api.LEVELS[levelIndex]
  return {
    levelIndex,
    pieces: level.pieces.map((def, i) => ({ id: def.id, x: positions[i].x, y: positions[i].y })),
    moves: 0,
    elapsedMs: 0,
    started: false,
    won: false,
    undo: [],
    best: {},
  }
}

/** Fresh client state from a level definition (uses the package's own initial data). */
export function initialState(levelIndex) {
  return api.createState(levelIndex)
}
