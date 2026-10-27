/**
 * dev/fake-dom.mjs — minimal DOM + browser globals for headless controller tests.
 * Dev-only, no dependencies.
 *
 * Supports exactly the APIs client.js uses: createElement / appendChild /
 * removeChild / setAttribute / classList / style / textContent / listeners with
 * bubbling / getBoundingClientRect; document.hidden + visibilitychange;
 * ResizeObserver; requestAnimationFrame; performance.now; localStorage.
 */

class FakeClassList {
  constructor(element) {
    this.element = element
  }

  _list() {
    return String(this.element.className || '')
      .split(/\s+/)
      .filter(Boolean)
  }

  _set(list) {
    this.element.className = Array.from(new Set(list)).join(' ')
  }

  add(name) {
    const list = this._list()
    if (!list.includes(name)) list.push(name)
    this._set(list)
  }

  remove(name) {
    this._set(this._list().filter((item) => item !== name))
  }

  contains(name) {
    return this._list().includes(name)
  }

  toggle(name, force) {
    const has = this.contains(name)
    const next = force === undefined ? !has : Boolean(force)
    if (next) this.add(name)
    else this.remove(name)
    return next
  }
}

class FakeStyle {
  constructor() {
    this.__values = Object.create(null)
  }

  setProperty(name, value) {
    this.__values[name] = String(value)
    this[name] = String(value)
  }

  removeProperty(name) {
    delete this.__values[name]
    delete this[name]
  }

  getPropertyValue(name) {
    return this.__values[name] || ''
  }

  set cssText(text) {
    this.__values = Object.create(null)
    const parts = String(text || '').split(';')
    for (const part of parts) {
      const index = part.indexOf(':')
      if (index < 0) continue
      const name = part.slice(0, index).trim()
      const value = part.slice(index + 1).trim()
      if (name) this.setProperty(name, value)
    }
  }

  get cssText() {
    return Object.keys(this.__values)
      .map((name) => name + ':' + this.__values[name])
      .join(';')
  }
}

class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc
    this.parentNode = null
    this.children = []
    this._text = ''
  }

  get firstChild() {
    return this.children.length ? this.children[0] : null
  }

  get lastChild() {
    return this.children.length ? this.children[this.children.length - 1] : null
  }

  appendChild(child) {
    if (!child) return child
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child)
    if (child.parentNode) child.parentNode.removeChild(child)
    const index = this.children.indexOf(reference)
    child.parentNode = this
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    if (child) child.parentNode = null
    return child
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
}

class FakeText extends FakeNode {
  constructor(doc, text) {
    super(doc)
    this.nodeType = 3
    this._text = String(text)
  }

  get textContent() {
    return this._text
  }

  set textContent(value) {
    this._text = String(value)
  }
}

class FakeElement extends FakeNode {
  constructor(doc, tagName) {
    super(doc)
    this.nodeType = 1
    this.tagName = String(tagName || 'div').toUpperCase()
    this.attributes = Object.create(null)
    this.style = new FakeStyle()
    this.className = ''
    this.classList = new FakeClassList(this)
    this.listeners = Object.create(null)
    this.clientWidth = 0
    this.clientHeight = 0
    this.disabled = false
    this.tabIndex = 0
    this.__rect = { left: 0, top: 0, width: 0, height: 0 }
    this.__focused = false
  }

  get textContent() {
    if (this.children.length === 0) return this._text
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this.children = []
    this._text = value === null || value === undefined ? '' : String(value)
  }

  set innerHTML(value) {
    this.children = []
    this._text = value === null || value === undefined ? '' : String(value)
  }

  get innerHTML() {
    return this._text
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'class') this.className = String(value)
    if (name === 'id') this.id = String(value)
  }

  getAttribute(name) {
    if (name === 'class') return this.className || null
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }

  removeAttribute(name) {
    delete this.attributes[name]
    if (name === 'class') this.className = ''
  }

  addEventListener(type, listener) {
    if (!this.listeners[type]) this.listeners[type] = []
    if (!this.listeners[type].includes(listener)) this.listeners[type].push(listener)
  }

  removeEventListener(type, listener) {
    const list = this.listeners[type]
    if (!list) return
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
  }

  dispatchEvent(event) {
    const normalized = normalizeEvent(event)
    normalized.target = this
    let node = this
    while (node) {
      normalized.currentTarget = node
      const list = node.listeners && node.listeners[normalized.type]
      if (list) {
        for (const listener of list.slice()) {
          if (normalized.__stopped) break
          listener.call(node, normalized)
        }
      }
      if (normalized.__stopped) break
      node = node.parentNode
    }
    return !normalized.defaultPrevented
  }

  getBoundingClientRect() {
    return {
      left: this.__rect.left,
      top: this.__rect.top,
      width: this.__rect.width,
      height: this.__rect.height,
      right: this.__rect.left + this.__rect.width,
      bottom: this.__rect.top + this.__rect.height,
    }
  }

  focus() {
    this.__focused = true
  }

  querySelectorAll() {
    return []
  }
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') event = { type: String(event) }
  if (!event.type) event.type = 'event'
  if (typeof event.preventDefault !== 'function') {
    event.preventDefault = function () {
      event.defaultPrevented = true
    }
  }
  if (typeof event.stopPropagation !== 'function') {
    event.stopPropagation = function () {
      event.__stopped = true
    }
  }
  if (event.defaultPrevented === undefined) event.defaultPrevented = false
  return event
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null)
    this.nodeType = 9
    this.ownerDocument = this
    this.hidden = false
    this.visibilityState = 'visible'
    this.listeners = Object.create(null)
    this.devicePixelRatio = 1
    this.body = new FakeElement(this, 'body')
  }

  createElement(tagName) {
    return new FakeElement(this, tagName)
  }

  createTextNode(text) {
    return new FakeText(this, text)
  }

  addEventListener(type, listener) {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(listener)
  }

  removeEventListener(type, listener) {
    const list = this.listeners[type]
    if (!list) return
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
  }

  dispatchEvent(event) {
    const normalized = normalizeEvent(event)
    normalized.target = this
    normalized.currentTarget = this
    const list = this.listeners[normalized.type]
    if (list) for (const listener of list.slice()) listener.call(this, normalized)
    return !normalized.defaultPrevented
  }
}

class FakeResizeObserver {
  constructor(callback, registry) {
    this.callback = callback
    this.registry = registry
    registry.push(this)
  }

  observe() {}

  unobserve() {}

  disconnect() {
    const index = this.registry.indexOf(this)
    if (index >= 0) this.registry.splice(index, 1)
  }
}

function createEnvironment(options) {
  const opts = options || {}
  const document = new FakeDocument()
  const observers = []
  const rafQueue = new Map()
  let rafId = 1
  const storageMap = new Map()
  const clock = { now: 0 }
  const storage = {
    getItem(key) {
      return storageMap.has(String(key)) ? storageMap.get(String(key)) : null
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
      return Array.from(storageMap.keys())[index] || null
    },
    get length() {
      return storageMap.size
    },
    __map: storageMap,
  }

  const window = {
    devicePixelRatio: opts.dpr || 1,
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
    performance: {
      now: () => clock.now,
    },
    ResizeObserver: function ResizeObserver(callback) {
      return new FakeResizeObserver(callback, observers)
    },
    requestAnimationFrame(fn) {
      const id = rafId
      rafId += 1
      rafQueue.set(id, fn)
      return id
    },
    cancelAnimationFrame(id) {
      rafQueue.delete(id)
    },
    setTimeout,
    clearTimeout,
  }

  const host = document.createElement('div')
  host.clientWidth = opts.width === undefined ? 720 : opts.width
  host.clientHeight = opts.height === undefined ? 600 : opts.height
  document.body.appendChild(host)

  const env = {
    document,
    window,
    storage,
    host,
    clock,
    observers,
    install() {
      globalThis.window = window
      globalThis.document = document
      globalThis.localStorage = storage
      globalThis.performance = window.performance
      globalThis.ResizeObserver = window.ResizeObserver
      globalThis.requestAnimationFrame = window.requestAnimationFrame
      globalThis.cancelAnimationFrame = window.cancelAnimationFrame
      return env
    },
    setSize(width, height) {
      host.clientWidth = width
      host.clientHeight = height
      env.triggerResize()
    },
    triggerResize() {
      for (const observer of observers.slice()) {
        observer.callback([{ target: host }], observer)
      }
    },
    flushRaf() {
      const snapshot = Array.from(rafQueue.entries())
      rafQueue.clear()
      for (const [, fn] of snapshot) {
        try {
          fn(clock.now)
        } catch (error) {
          throw error
        }
      }
      return snapshot.length
    },
    pendingRaf() {
      return rafQueue.size
    },
    advance(ms) {
      clock.now += ms
      return clock.now
    },
    setHidden(hidden) {
      document.hidden = Boolean(hidden)
      document.visibilityState = hidden ? 'hidden' : 'visible'
      document.dispatchEvent({ type: 'visibilitychange' })
    },
    setBoardRect(game) {
      const view = game.getView()
      if (!view.layout) return
      const board = game.__test.board
      board.__rect = { left: 0, top: 0, width: view.layout.boardWidth, height: view.layout.boardHeight }
    },
    restore() {
      // Best-effort cleanup; the test process exits shortly after.
      document.hidden = false
      document.visibilityState = 'visible'
    },
  }

  env.install()
  return env
}

export { createEnvironment }
