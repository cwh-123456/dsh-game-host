/**
 * Independent audit harness for @local/dsh-game-sudoku (verifier-owned).
 *
 * This file is NOT the implementation's test file: it stubs `window` exactly as
 * the api-spec §1/§10 seam contract describes and loads the browser bundle
 * `client.js` with a fresh module instance per audit run.
 *
 * Node built-ins only. Run from the package directory:
 *   node dev/audit/audit-contract.mjs
 *   node dev/audit/audit-generate.mjs
 *   node dev/audit/audit-state.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export { assert }

export const CLIENT_URL = new URL('../../client.js', import.meta.url)
export const CLIENT_FILE = fileURLToPath(CLIENT_URL)
export const AUDIT_DIR = fileURLToPath(new URL('./', import.meta.url))
export const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url))

export function clientExists() {
  try {
    readFileSync(CLIENT_FILE)
    return true
  } catch {
    return false
  }
}

export function clientCode() {
  return readFileSync(CLIENT_FILE, 'utf8')
}

/** Throw a plain readable error (assertion style used by every audit file). */
export function must(condition, message) {
  if (!condition) throw new Error(message)
}

export function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
}

export function close(actual, expected, message, eps = 1e-9) {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new Error(message + ' (actual=' + actual + ', expected=' + expected + ')')
  }
}

// ---------------------------------------------------------------------------
// window / browser stubs
// ---------------------------------------------------------------------------

export function createStorage() {
  const map = new Map()
  return {
    map,
    failGet: false,
    failSet: false,
    failRemove: false,
    getItem(key) {
      if (this.failGet) throw new Error('storage.getItem exploded (injected)')
      const k = String(key)
      return map.has(k) ? map.get(k) : null
    },
    setItem(key, value) {
      if (this.failSet) throw new Error('storage.setItem exploded (injected)')
      map.set(String(key), String(value))
    },
    removeItem(key) {
      if (this.failRemove) throw new Error('storage.removeItem exploded (injected)')
      map.delete(String(key))
    },
    clear() {
      map.clear()
    },
    key(index) {
      const keys = Array.from(map.keys())
      return index >= 0 && index < keys.length ? keys[index] : null
    },
    get length() {
      return map.size
    },
  }
}

export function createDocumentStub() {
  const listeners = new Map()
  const documentStub = {
    listeners,
    hidden: false,
    visibilityState: 'visible',
    title: 'audit',
    body: { appendChild() {}, removeChild() {} },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        style: {},
        dataset: {},
        appendChild() {},
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        removeEventListener() {},
        getContext() {
          throw new Error('audit stub: canvas/getContext is not supported')
        },
      }
    },
    querySelector() {
      return null
    },
  }
  return documentStub
}

/**
 * Install a browser-ish global environment. Returns the window object, the
 * storage stub and the `__ModuleLoader__.load` capture list.
 *
 * @param {{testFlag?: boolean, tag?: string}} options
 */
export function installBrowserStubs({ testFlag = true } = {}) {
  const storage = createStorage()
  const definitions = []
  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        definitions.push(definition)
      },
    },
    localStorage: storage,
    performance: { now: () => Date.now() },
  }
  if (testFlag) windowStub.__DSH_GAME_SUDOKU_TEST__ = true

  const documentStub = createDocumentStub()

  globalThis.window = windowStub
  globalThis.localStorage = storage
  globalThis.document = documentStub
  globalThis.performance = windowStub.performance
  return { window: windowStub, storage, definitions, document: documentStub }
}

let loadCounter = 0

/**
 * Load `client.js` in the current process with the given seam flag.
 * A unique query keeps module instances independent between audit runs.
 */
export async function loadClient({ testFlag = true, tag = 'audit' } = {}) {
  const env = installBrowserStubs({ testFlag })
  loadCounter += 1
  const url = CLIENT_URL.href + '?audit=' + encodeURIComponent(tag) + '&n=' + loadCounter
  await import(url)
  const api = env.window.__DSH_GAME_SUDOKU__
  return {
    ...env,
    definition: env.definitions[0] || null,
    api: api || null,
  }
}

// ---------------------------------------------------------------------------
// registration stubs
// ---------------------------------------------------------------------------

export function createReactStub() {
  const calls = { createElement: 0, hooks: [] }
  function createElement(type, props, ...children) {
    calls.createElement += 1
    return { type, props, children }
  }
  class Component {
    constructor(props) {
      this.props = props || {}
    }
    setState(update) {
      this.state = Object.assign({}, this.state, typeof update === 'function' ? update(this.state) : update)
    }
  }
  return {
    calls,
    createElement,
    Fragment: Symbol.for('react.fragment'),
    useState(initial) {
      calls.hooks.push('useState')
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect(fn) {
      calls.hooks.push('useEffect')
      return undefined
    },
    useRef(initial) {
      calls.hooks.push('useRef')
      return { current: initial === undefined ? null : initial }
    },
    useCallback(fn) {
      calls.hooks.push('useCallback')
      return fn
    },
    useMemo(fn) {
      calls.hooks.push('useMemo')
      return fn()
    },
    Component,
  }
}

export function createCtx({ injectThrows = false, registerThrows = false } = {}) {
  const calls = { inject: [], register: [], disposers: 0 }
  let registerReturned = null
  const ctx = {
    slots: {
      inject(slotName, callback) {
        calls.inject.push(slotName)
        if (injectThrows) throw new Error('slots.inject exploded (injected)')
        const dispose = callback()
        calls.disposers += 1
        return dispose
      },
      register(options, component) {
        calls.register.push({ options, component })
        if (registerThrows) throw new Error('slots.register exploded (injected)')
        registerReturned = () => {}
        return registerReturned
      },
    },
  }
  return { ctx, calls, get registerReturned() { return registerReturned } }
}

export function captureConsoleError(fn) {
  const original = console.error
  const captured = []
  console.error = (...args) => {
    captured.push(args)
  }
  try {
    fn()
  } finally {
    console.error = original
  }
  return captured
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

export function createRunner(title) {
  const results = []
  const evidence = []
  const notes = []

  function check(name, fn) {
    try {
      const value = fn()
      results.push({ name, ok: true })
      return value
    } catch (error) {
      results.push({ name, ok: false, error })
      return undefined
    }
  }

  function recordEvidence(name, value) {
    evidence.push({ name, value })
  }

  function note(message) {
    notes.push(message)
  }

  function summary() {
    let passed = 0
    const failures = []
    for (const result of results) {
      if (result.ok) {
        passed += 1
        console.log('ok - ' + result.name)
      } else {
        failures.push(result)
        console.log('not ok - ' + result.name)
      }
    }
    for (const failure of failures) {
      console.log('  ERROR: ' + (failure.error && failure.error.message ? failure.error.message : String(failure.error)))
      if (failure.error && failure.error.stack) {
        console.log(
          failure.error.stack
            .split('\n')
            .slice(1, 4)
            .map((line) => '    ' + line.trim())
            .join('\n'),
        )
      }
    }
    for (const item of evidence) {
      console.log('EVIDENCE ' + item.name + ' ' + JSON.stringify(item.value))
    }
    for (const message of notes) {
      console.log('NOTE ' + message)
    }
    console.log('')
    console.log(title + ': PASS ' + passed + ' / FAIL ' + failures.length)
    if (failures.length > 0) process.exitCode = 1
    return { passed, failed: failures.length, notes: notes.length }
  }

  return { check, recordEvidence, note, summary, results }
}

export function requireClient(api) {
  if (!api) throw new Error('window.__DSH_GAME_SUDOKU__ seam is missing (did client.js load?)')
  return api
}
