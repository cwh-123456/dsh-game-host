/**
 * harness.mjs — headless environment + client.js test-seam loader for the
 * independent Battleship audit.
 *
 * Read-only. Imported by diff-fuzz.mjs / save-fuzz.mjs / lifecycle.mjs.
 *
 * How it works:
 *   1. installs a fake `window` / `document` (localStorage, timers, rAF,
 *      ResizeObserver, event listeners, devicePixelRatio, performance.now);
 *   2. sets window.__DSH_GAME_BATTLESHIP_TEST__ = true, which makes client.js
 *      publish its pure test seam on window.__DSH_GAME_BATTLESHIP__;
 *   3. dynamically imports client.js so its IIFE runs against the stubs;
 *   4. exports the seam plus deterministic helpers for the fuzz/lifecycle suites.
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
  consoleErrors: [],
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
  env.consoleErrors.length = 0
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
 * Fake DOM nodes (only what createGame/lifecycle touches)
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
    querySelector() {
      return null
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
Object.defineProperty(fakeDocument, 'visibilityState', {
  get() {
    return env.documentHidden ? 'hidden' : 'visible'
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
  __DSH_GAME_BATTLESHIP_TEST__: true,
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

const originalConsoleError = console.error
console.error = function patchedConsoleError(...args) {
  env.consoleErrors.push(args.map(String).join(' '))
  // keep the audit output readable; real errors are asserted through env.consoleErrors
}

globalThis.window = fakeWindow
globalThis.document = fakeDocument
// client.js (like browser code) uses these as bare globals, not window.* members.
globalThis.ResizeObserver = FakeResizeObserver
globalThis.setTimeout = fakeWindow.setTimeout
globalThis.clearTimeout = fakeWindow.clearTimeout
globalThis.requestAnimationFrame = fakeWindow.requestAnimationFrame
globalThis.cancelAnimationFrame = fakeWindow.cancelAnimationFrame

const CLIENT_URL = new URL('../../client.js', import.meta.url).href
await import(CLIENT_URL)

console.error = originalConsoleError

const seam = fakeWindow.__DSH_GAME_BATTLESHIP__
if (!seam) {
  throw new Error('client.js did not install window.__DSH_GAME_BATTLESHIP__ (test seam missing)')
}
const CLIENT_DEFINITION = env.capturedDefinition
if (!CLIENT_DEFINITION) {
  throw new Error('client.js did not register with window.__ModuleLoader__.load')
}

/* ------------------------------------------------------------------ *
 * Fake React (enough to instantiate the module + registration test)
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

/* ------------------------------------------------------------------ *
 * Deterministic time helpers used by lifecycle / diff / save fuzz
 * ------------------------------------------------------------------ */

/**
 * Run pending setTimeout callbacks whose delay matches the filter.
 * `maxDelay` runs timers with delay <= maxDelay (e.g. AI_DELAY_MS but not the
 * toast timer); `exactDelay` runs only that delay. Timers scheduled by a
 * callback are picked up by re-scanning until nothing matches.
 */
export function runTimers(options = {}) {
  const maxRuns = options.limit || 1000
  let runs = 0
  while (runs < maxRuns) {
    let ran = false
    for (const [id, timer] of [...env.timers.entries()]) {
      if (options.maxDelay !== undefined && timer.delay > options.maxDelay) continue
      if (options.exactDelay !== undefined && timer.delay !== options.exactDelay) continue
      env.timers.delete(id)
      runs += 1
      ran = true
      timer.fn()
      break
    }
    if (!ran) break
  }
  return runs
}

/** Run pending rAF callbacks (each once); callbacks may reschedule. */
export function flushRaf(limit = 200) {
  let guard = 0
  while (env.rafQueue.size && guard < limit) {
    guard += 1
    const entry = [...env.rafQueue.entries()].shift()
    env.rafQueue.delete(entry[0])
    entry[1](env.clockMs)
  }
  return guard
}

export function fireWindow(type) {
  const listeners = env.windowListeners.get(type)
  if (listeners) for (const listener of [...listeners]) listener({ type })
}

export function fireDocument(type) {
  const listeners = env.documentListeners.get(type)
  if (listeners) for (const listener of [...listeners]) listener({ type })
}

/** Minimal deep clone for JSON states. */
export function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export { seam, fakeWindow, fakeDocument, fakeReact, CLIENT_DEFINITION }
