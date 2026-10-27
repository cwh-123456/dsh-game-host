/**
 * harness.mjs — headless environment + client.js test-seam loader for the audit.
 *
 * Read-only. Imported by diff-fuzz.mjs / save-fuzz.mjs / lifecycle.mjs.
 *
 * How it works:
 *   1. installs a fake `window` / `document` (localStorage, timers, rAF,
 *      ResizeObserver, event listeners, devicePixelRatio, performance.now);
 *   2. sets window.__DSH_GAME_SOLITAIRE_TEST__ = true, which makes client.js
 *      publish its pure test seam on window.__DSH_GAME_SOLITAIRE__;
 *   3. dynamically imports client.js so its IIFE runs against the stubs;
 *   4. exports the seam plus deterministic adapters between the client's
 *      integer-card representation (id 0..51, suit = id/13) and the reference
 *      model's canonical pile form.
 *
 * The fake environment is deliberately small and honest: every call the client
 * makes is recorded so tests can assert on lifecycle side effects (listeners,
 * timers, rAF, localStorage, document.body touches).
 */

/* ------------------------------------------------------------------ *
 * Fake environment state (resettable between tests)
 * ------------------------------------------------------------------ */

export const env = {
  storage: new Map(),          // localStorage key -> string
  windowListeners: new Map(),  // type -> Set(fn)
  documentListeners: new Map(),
  timers: new Map(),           // id -> { fn, delay }
  rafQueue: new Map(),         // id -> fn
  observers: [],               // fake ResizeObserver instances
  clockMs: 1000,
  nextId: 1,
  documentHidden: false,
  devicePixelRatio: 2,
  hostRect: { width: 1024, height: 700 },
  bodyTouches: 0,
  createElementCalls: [],
}

export function resetEnv() {
  env.storage.clear()
  env.windowListeners.clear()
  env.documentListeners.clear()
  env.timers.clear()
  env.rafQueue.clear()
  env.observers.length = 0
  env.clockMs = 1000
  env.nextId = 1
  env.documentHidden = false
  env.devicePixelRatio = 2
  env.hostRect = { width: 1024, height: 700 }
  env.bodyTouches = 0
  env.createElementCalls.length = 0
  env.capturedDefinition = null
}

export function advanceClock(ms) {
  env.clockMs += ms
}

function addListener(store, type, fn) {
  if (!store.has(type)) store.set(type, new Set())
  store.get(type).add(fn)
}

function removeListener(store, type, fn) {
  const set = store.get(type)
  if (set) set.delete(fn)
}

export function countListeners(store) {
  let total = 0
  for (const set of store.values()) total += set.size
  return total
}

export function listenerTypes(store) {
  return [...store.keys()]
}

/* ------------------------------------------------------------------ *
 * Fake canvas/DOM nodes (only what React rendering would touch)
 * ------------------------------------------------------------------ */

function makeElement(tagName) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    nodeType: 1,
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    value: '',
    className: '',
    textContent: '',
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
    },
    removeAttribute(name) {
      delete this.attributes[name]
    },
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
    removeChild(child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      if (child.parentNode === this) child.parentNode = null
      return child
    },
    insertBefore(child, reference) {
      const index = reference ? this.children.indexOf(reference) : -1
      if (index >= 0) this.children.splice(index, 0, child)
      else this.children.push(child)
      child.parentNode = this
      return child
    },
    addEventListener(type, fn) {
      if (!this.__listeners) this.__listeners = new Map()
      addListener(this.__listeners, type, fn)
    },
    removeEventListener(type, fn) {
      if (this.__listeners) removeListener(this.__listeners, type, fn)
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: env.hostRect.width, height: env.hostRect.height, right: env.hostRect.width, bottom: env.hostRect.height, x: 0, y: 0 }
    },
    focus() {},
    remove() {},
  }
  return node
}

const fakeBody = makeElement('body')
Object.defineProperty(fakeBody, 'appendChild', {
  value(child) {
    env.bodyTouches += 1
    return makeElement('body').appendChild(child)
  },
})

const fakeDocument = {
  hidden: false,
  get body() {
    return fakeBody
  },
  createElement(tag) {
    env.createElementCalls.push(tag)
    return makeElement(tag)
  },
  createTextNode(text) {
    return { nodeType: 3, nodeValue: String(text), parentNode: null }
  },
  addEventListener(type, fn) {
    addListener(env.documentListeners, type, fn)
  },
  removeEventListener(type, fn) {
    removeListener(env.documentListeners, type, fn)
  },
  getElementById() {
    return null
  },
  querySelector() {
    return null
  },
}
Object.defineProperty(fakeDocument, 'hidden', {
  get() {
    return env.documentHidden
  },
  set(value) {
    env.documentHidden = !!value
  },
})

/* ------------------------------------------------------------------ *
 * Fake window
 * ------------------------------------------------------------------ */

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback
    this.targets = []
    this.disconnected = false
    env.observers.push(this)
  }
  observe(target) {
    this.targets.push(target)
  }
  unobserve(target) {
    this.targets = this.targets.filter((item) => item !== target)
  }
  disconnect() {
    this.disconnected = true
    this.targets = []
  }
  trigger() {
    this.callback([])
  }
}

const fakeWindow = {
  __DSH_GAME_SOLITAIRE_TEST__: true,
  __ModuleLoader__: {
    load(definition) {
      env.capturedDefinition = definition
    },
  },
  localStorage: {
    getItem(key) {
      return env.storage.has(key) ? env.storage.get(key) : null
    },
    setItem(key, value) {
      env.storage.set(key, String(value))
    },
    removeItem(key) {
      env.storage.delete(key)
    },
    clear() {
      env.storage.clear()
    },
  },
  performance: {
    now() {
      return env.clockMs
    },
  },
  devicePixelRatio: 2,
  setTimeout(fn, delay) {
    const id = env.nextId
    env.nextId += 1
    env.timers.set(id, { fn, delay: Math.max(0, Number(delay) || 0) })
    return id
  },
  clearTimeout(id) {
    env.timers.delete(id)
  },
  requestAnimationFrame(fn) {
    const id = env.nextId
    env.nextId += 1
    env.rafQueue.set(id, fn)
    return id
  },
  cancelAnimationFrame(id) {
    env.rafQueue.delete(id)
  },
  addEventListener(type, fn) {
    addListener(env.windowListeners, type, fn)
  },
  removeEventListener(type, fn) {
    removeListener(env.windowListeners, type, fn)
  },
  ResizeObserver: FakeResizeObserver,
}
Object.defineProperty(fakeWindow, 'devicePixelRatio', {
  get() {
    return env.devicePixelRatio
  },
  set(value) {
    env.devicePixelRatio = value
  },
})

/* ------------------------------------------------------------------ *
 * Install globals BEFORE importing client.js
 * ------------------------------------------------------------------ */

globalThis.window = fakeWindow
globalThis.document = fakeDocument

const CLIENT_URL = new URL('../../client.js', import.meta.url).href
await import(CLIENT_URL)

const seam = fakeWindow.__DSH_GAME_SOLITAIRE__
if (!seam) {
  throw new Error('client.js did not install window.__DSH_GAME_SOLITAIRE__ (test seam missing)')
}
const CLIENT_DEFINITION = env.capturedDefinition
if (!CLIENT_DEFINITION) {
  throw new Error('client.js did not register with window.__ModuleLoader__.load')
}

/* ------------------------------------------------------------------ *
 * Card / pile adapters (client integer ids <-> reference canonical form)
 * ------------------------------------------------------------------ */

export const SUIT_ORDER = ['S', 'H', 'D', 'C'] // must match client's SUITS order
export const RANK_LABELS = [null, 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']

export function idToCode(id) {
  const suit = SUIT_ORDER[Math.floor(id / 13)]
  const rank = (id % 13) + 1
  return RANK_LABELS[rank] + suit
}

export function codeToId(code) {
  const suit = SUIT_ORDER.indexOf(code.slice(-1))
  const rank = RANK_LABELS.indexOf(code.slice(0, -1))
  if (suit < 0 || rank < 1) throw new Error('bad card code: ' + code)
  return suit * 13 + (rank - 1)
}

/** Client state/piles -> reference canonical piles ({stock draw order, coded cards}). */
export function clientPilesToCanonical(piles) {
  const foundations = {}
  for (let pile = 0; pile < 4; pile += 1) {
    foundations[SUIT_ORDER[pile]] = (piles.foundations[pile] || []).map(idToCode)
  }
  return {
    stock: (piles.stock || []).slice().reverse().map(idToCode),
    waste: (piles.waste || []).map(idToCode),
    tableau: (piles.tableau || []).map((column) =>
      column.map((card) => ({ c: idToCode(card.id), up: !!card.up })),
    ),
    foundations,
    moves: Number.isInteger(piles.moves) ? piles.moves : 0,
    won: piles.won === true,
  }
}

/** Reference canonical piles -> client-style integer piles (used to seed client state). */
export function canonicalToClientPiles(piles) {
  const foundations = [[], [], [], []]
  for (let pile = 0; pile < 4; pile += 1) {
    foundations[pile] = (piles.foundations[SUIT_ORDER[pile]] || []).map(codeToId)
  }
  const tableau = piles.tableau.map((column) =>
    column.map((entry) => ({ id: codeToId(typeof entry === 'string' ? entry : entry.c), up: !!(typeof entry === 'string' ? true : entry.up) })),
  )
  return {
    stock: (piles.stock || []).slice().reverse().map(codeToId),
    waste: (piles.waste || []).map(codeToId),
    foundations,
    tableau,
  }
}

/** Action descriptors shared by the fuzzer: client vocabulary, mapped to reference words. */
export function selectionToRef(src) {
  if (src === null || src === undefined) return null
  if (src.kind === 'waste') return { zone: 'waste' }
  if (src.kind === 'tableau') return { zone: 'tableau', col: src.col, index: src.index }
  if (src.kind === 'foundation') return { zone: 'foundation', suit: SUIT_ORDER[src.pile] }
  return { zone: 'bogus' } // malformed selection: both engines must refuse it
}

export function targetToRef(dst) {
  if (dst === null || dst === undefined) return null
  if (dst.kind === 'tableau') return { zone: 'tableau', col: dst.col }
  if (dst.kind === 'foundation') return { zone: 'foundation', suit: SUIT_ORDER[dst.pile] }
  return { zone: 'bogus' } // malformed target: both engines must refuse it
}

/** Stable JSON-ish description for repro messages. */
export function describeAction(action) {
  if (!action) return String(action)
  if (action.type === 'draw') return 'drawStock'
  if (action.type === 'auto') return `autoMove src=${JSON.stringify(action.src)}`
  return `move src=${JSON.stringify(action.src)} dst=${JSON.stringify(action.dst)}`
}

/* ------------------------------------------------------------------ *
 * Minimal fake React (enough to instantiate the module + registration test;
 * real DOM rendering is covered by the Lead's browser pass, not here)
 * ------------------------------------------------------------------ */

const fakeReact = {
  createElement(type, config, ...children) {
    const props = Object.assign({}, config || {})
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return { $$typeof: 'fake.element', type, key: props.key, ref: props.ref, props }
  },
  cloneElement(element, config, ...children) {
    const props = Object.assign({}, element.props, config || {})
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return { $$typeof: 'fake.element', type: element.type, key: props.key, ref: props.ref, props }
  },
  isValidElement(value) {
    return !!value && value.$$typeof === 'fake.element'
  },
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(partial) {
      this.state = Object.assign({}, this.state, typeof partial === 'function' ? partial(this.state) : partial)
    }
    forceUpdate() {}
  },
  Fragment: 'fake.fragment',
  createRef() {
    return { current: null }
  },
  useRef(initial) {
    return { current: initial }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, function noopSet() {}]
  },
  useReducer(reducer, initial) {
    return [initial, function noopDispatch() {}]
  },
  useEffect() {},
  useLayoutEffect() {},
  useCallback(fn) {
    return fn
  },
  useMemo(factory) {
    return factory()
  },
}

/** Instantiate the client module definition and return { module, React }. */
export function instantiateClientModule() {
  const definition = CLIENT_DEFINITION
  if (!definition) throw new Error('client.js never called window.__ModuleLoader__.load')
  const module = definition.factory(function require(name) {
    if (name !== 'react') throw new Error('unexpected require: ' + name)
    return fakeReact
  })
  return { definition, module, React: fakeReact }
}

/** Fake slot context that records registrations; calls apply(ctx). */
export function applyClientModule(module) {
  const records = { injects: [], registers: [], provides: [] }
  const cleanup = function cleanup() {}
  const ctx = {
    slots: {
      inject(name, callback) {
        records.injects.push(name)
        return callback()
      },
      register(definition, component) {
        records.registers.push({ definition, component })
        return cleanup
      },
    },
    provide(...args) {
      records.provides.push(args)
    },
  }
  module.apply(ctx)
  return records
}

/** Fake host element for createGame(). */
export function makeHost(rect) {
  const host = makeElement('div')
  Object.defineProperty(host, 'getBoundingClientRect', {
    value() {
      const r = rect || env.hostRect
      return { left: 0, top: 0, width: r.width, height: r.height, right: r.width, bottom: r.height, x: 0, y: 0 }
    },
  })
  return host
}

export { seam, fakeWindow, fakeDocument, fakeReact }
