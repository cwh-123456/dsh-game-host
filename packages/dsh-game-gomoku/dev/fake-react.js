/*!
 * dev/fake-react.js — 极简 React 替身（仅 dev 预览用，不随包发布）
 * ---------------------------------------------------------------------------
 * client.js 在 DSH 里通过 require('react') 拿 React。开发预览页没有宿主模块表，
 * 本文件用真实 DOM 实现一个够用的迷你渲染器，让 dev/preview.html 能真实渲染本游戏
 * 注册的 React 组件（工具栏 / 状态栏 / 规则弹窗）。
 *
 * 支持（client.js 实际用到的子集）：
 *   - createElement / 函数组件 / class 组件（setState、getDerivedStateFromError、
 *     componentDidCatch）
 *   - Hooks：useState / useRef / useEffect（deps + cleanup）/ useCallback / useMemo
 *   - 真实 DOM：style 对象、className、aria-* 与 data-*、role、tabIndex、disabled、
 *     type/title、事件 onClick/onKeyDown/onMouseDown 等、ref {current}
 *   - setState 同步重渲染；effect 在渲染提交后执行
 *
 * 明确不是 React：没有并发调度、没有合成事件、没有 keyed 列表重排优化，
 * 只求把本组件的 UI 真实画出来。宿主内用真实 React。
 */
;(function (global) {
  'use strict'

  const ELEMENT = typeof Symbol === 'function' ? Symbol('fake.element') : '__fake_element__'
  const TEXT = '__fake_text__'
  const UNITLESS = {
    flex: 1,
    flexGrow: 1,
    flexShrink: 1,
    opacity: 1,
    fontWeight: 1,
    lineHeight: 1,
    zIndex: 1,
    order: 1,
    zoom: 1,
    animationIterationCount: 1,
  }
  const SKIP_PROPS = {
    children: 1,
    key: 1,
    ref: 1,
    style: 1,
    className: 1,
  }

  let root = null
  let currentFiber = null
  let hookIndex = 0
  let rendering = false
  let rerenderQueued = false
  let pendingEffects = []
  let pendingDidCatch = []
  const errors = []

  function report(error) {
    errors.push(error)
    try {
      console.error('[fake-react]', error)
    } catch (ignored) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * createElement
   * ------------------------------------------------------------------ */
  function createElement(type, config) {
    if (type === undefined || type === null) throw new Error('fake-react: createElement(type) required')
    const props = {}
    let key = null
    let ref = null
    if (config !== null && config !== undefined) {
      for (const name in config) {
        if (!Object.prototype.hasOwnProperty.call(config, name)) continue
        if (name === 'key') {
          key = config[name]
          continue
        }
        if (name === 'ref') {
          ref = config[name]
          continue
        }
        if (name === '__self' || name === '__source') continue
        props[name] = config[name]
      }
    }
    const children = []
    for (let i = 2; i < arguments.length; i += 1) children.push(arguments[i])
    props.children = children.length === 0
      ? undefined
      : children.length === 1 ? children[0] : children
    if (type && type.defaultProps) {
      for (const name in type.defaultProps) {
        if (props[name] === undefined) props[name] = type.defaultProps[name]
      }
    }
    return { $$typeof: ELEMENT, type: type, key: key, ref: ref, props: props }
  }

  function normalizeChildren(children) {
    const out = []
    collect(children, out)
    return out
  }

  function collect(children, out) {
    if (children === null || children === undefined || children === false || children === true) return
    if (Array.isArray(children)) {
      for (let i = 0; i < children.length; i += 1) collect(children[i], out)
      return
    }
    if (typeof children === 'string' || typeof children === 'number' || typeof children === 'bigint') {
      out.push({ $$typeof: TEXT, type: TEXT, key: null, ref: null, text: String(children), props: {} })
      return
    }
    if (children && children.$$typeof === ELEMENT) {
      out.push(children)
      return
    }
    throw new Error('fake-react: unsupported child ' + Object.prototype.toString.call(children))
  }

  function flatten(children) {
    return normalizeChildren(children)
  }

  /* ------------------------------------------------------------------ *
   * Hooks
   * ------------------------------------------------------------------ */
  function hookSlot() {
    if (!currentFiber) throw new Error('fake-react: hooks outside a function component')
    const fiber = currentFiber
    const index = hookIndex
    hookIndex += 1
    if (!fiber.hooks[index]) fiber.hooks[index] = {}
    return fiber.hooks[index]
  }

  function useState(initial) {
    const hook = hookSlot()
    if (!('value' in hook)) hook.value = typeof initial === 'function' ? initial() : initial
    if (!hook.set) {
      hook.set = function (next) {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
        scheduleRerender()
      }
    }
    return [hook.value, hook.set]
  }

  function useRef(initial) {
    const hook = hookSlot()
    if (!hook.value) hook.value = { current: initial }
    return hook.value
  }

  function useCallback(callback, deps) {
    const hook = hookSlot()
    if (!hook.hasValue || !sameDeps(hook.deps, deps)) {
      hook.value = callback
      hook.hasValue = true
      hook.deps = deps
    }
    return hook.value
  }

  function useMemo(factory, deps) {
    const hook = hookSlot()
    if (!hook.hasValue || !sameDeps(hook.deps, deps)) {
      hook.value = factory()
      hook.hasValue = true
      hook.deps = deps
    }
    return hook.value
  }

  function sameDeps(previous, next) {
    if (previous === undefined || next === undefined) return false
    if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) return false
    for (let i = 0; i < previous.length; i += 1) {
      if (!Object.is(previous[i], next[i])) return false
    }
    return true
  }

  function useEffect(create, deps) {
    const hook = hookSlot()
    const changed = !hook.hasRun || deps === undefined || deps === null || !sameDeps(hook.deps, deps)
    hook.hasRun = true
    hook.deps = deps
    if (changed) {
      hook.create = create
      pendingEffects.push(hook)
    }
  }

  /* ------------------------------------------------------------------ *
   * Component base class
   * ------------------------------------------------------------------ */
  function Component(props) {
    this.props = props
    this.state = {}
  }
  Component.prototype.setState = function (partial) {
    const next = typeof partial === 'function' ? partial(this.state, this.props) : partial
    if (next !== null && next !== undefined) this.state = Object.assign({}, this.state, next)
    scheduleRerender()
  }
  Component.prototype.forceUpdate = function () {
    scheduleRerender()
  }

  /* ------------------------------------------------------------------ *
   * DOM props
   * ------------------------------------------------------------------ */
  function kebab(name) {
    return name.replace(/[A-Z]/g, function (match) {
      return '-' + match.toLowerCase()
    })
  }

  function applyStyle(dom, style) {
    const next = {}
    if (style && typeof style === 'object') {
      for (const name in style) {
        if (!Object.prototype.hasOwnProperty.call(style, name)) continue
        const value = style[name]
        if (value === null || value === undefined || value === false) continue
        next[name] = typeof value === 'number' && !UNITLESS[name] ? value + 'px' : String(value)
      }
    }
    const previous = dom.__fakeStyle || {}
    for (const name in previous) {
      if (!Object.prototype.hasOwnProperty.call(previous, name)) continue
      if (Object.prototype.hasOwnProperty.call(next, name)) continue
      dom.style.removeProperty(kebab(name))
    }
    for (const name in next) {
      if (!Object.prototype.hasOwnProperty.call(next, name)) continue
      const prop = name.indexOf('--') === 0 ? name : kebab(name)
      dom.style.setProperty(prop, next[name])
    }
    dom.__fakeStyle = next
  }

  function setAttr(dom, name, value) {
    if (name === 'className') {
      if (value === null || value === undefined || value === false) dom.removeAttribute('class')
      else dom.setAttribute('class', String(value))
      return
    }
    if (name.indexOf('aria-') === 0 || name.indexOf('data-') === 0 || name === 'role') {
      if (value === null || value === undefined || value === false) dom.removeAttribute(name)
      else dom.setAttribute(name, String(value))
      return
    }
    if (name === 'tabIndex') {
      dom.setAttribute('tabindex', String(value))
      return
    }
    if (name === 'disabled') {
      dom.disabled = !!value
      if (value) dom.setAttribute('disabled', '')
      else dom.removeAttribute('disabled')
      return
    }
    const attr = name.toLowerCase()
    if (value === null || value === undefined || value === false) dom.removeAttribute(attr)
    else if (value === true) dom.setAttribute(attr, '')
    else dom.setAttribute(attr, String(value))
  }

  function isEvent(name) {
    return name.length > 2 && name[0] === 'o' && name[1] === 'n' && name[2] === name[2].toUpperCase()
  }

  function eventType(name) {
    return name.slice(2).toLowerCase()
  }

  function updateListeners(dom, fiber, oldProps, newProps) {
    if (!fiber.listeners) fiber.listeners = {}
    for (const name in oldProps) {
      if (!isEvent(name)) continue
      if (fiber.listeners[name] && !(name in newProps)) {
        dom.removeEventListener(eventType(name), fiber.listeners[name])
        delete fiber.listeners[name]
      }
    }
    for (const name in newProps) {
      if (!isEvent(name)) continue
      if (typeof newProps[name] !== 'function') {
        if (fiber.listeners[name]) {
          dom.removeEventListener(eventType(name), fiber.listeners[name])
          delete fiber.listeners[name]
        }
        continue
      }
      if (!fiber.listeners[name]) {
        const wrapper = function (event) {
          const props = fiber.props
          const handler = props && props[name]
          if (typeof handler === 'function') handler(event)
        }
        fiber.listeners[name] = wrapper
        dom.addEventListener(eventType(name), wrapper)
      }
    }
  }

  function applyProps(dom, fiber, oldProps, newProps, rawRef) {
    if (oldProps.style !== newProps.style) applyStyle(dom, newProps.style)
    for (const name in oldProps) {
      if (SKIP_PROPS[name] || isEvent(name)) continue
      if (!(name in newProps)) {
        if (name === 'className') dom.removeAttribute('class')
        else dom.removeAttribute(name.toLowerCase())
      }
    }
    for (const name in newProps) {
      if (SKIP_PROPS[name] || isEvent(name)) continue
      if (oldProps[name] === newProps[name]) continue
      setAttr(dom, name, newProps[name])
    }
    updateListeners(dom, fiber, oldProps, newProps)

    const previousRef = fiber.ref
    if (previousRef !== rawRef) {
      if (previousRef && typeof previousRef === 'object') previousRef.current = null
      fiber.ref = rawRef
    }
    if (rawRef && typeof rawRef === 'object') rawRef.current = dom
  }

  /* ------------------------------------------------------------------ *
   * Mount / patch
   * ------------------------------------------------------------------ */
  function topNodes(fiber, out) {
    if (!fiber) return
    if (fiber.kind === 'host' || fiber.kind === 'text') {
      out.push(fiber.dom)
      return
    }
    for (let i = 0; i < fiber.children.length; i += 1) topNodes(fiber.children[i], out)
  }

  function appendNodes(parentDom, fibers) {
    const nodes = []
    for (let i = 0; i < fibers.length; i += 1) topNodes(fibers[i], nodes)
    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i] && nodes[i].parentNode !== parentDom) parentDom.appendChild(nodes[i])
    }
    // 保序：按渲染顺序 append（appendChild 会把已有节点挪到末尾）
    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i]) parentDom.appendChild(nodes[i])
    }
  }

  function mountText(vnode, parentDom) {
    const dom = document.createTextNode(vnode.text)
    parentDom.appendChild(dom)
    return { kind: 'text', vnode: vnode, dom: dom, children: [], hooks: [], props: {} }
  }

  function mountHost(vnode, parentDom) {
    const dom = document.createElement(vnode.type)
    const fiber = {
      kind: 'host',
      type: vnode.type,
      vnode: vnode,
      dom: dom,
      props: vnode.props,
      ref: vnode.ref,
      listeners: {},
      children: [],
      hooks: [],
    }
    applyProps(dom, fiber, {}, vnode.props, vnode.ref)
    parentDom.appendChild(dom)
    fiber.children = reconcileChildren(fiber, dom, vnode.props.children, [])
    return fiber
  }

  function patchHost(fiber, vnode) {
    const oldProps = fiber.props
    fiber.vnode = vnode
    fiber.props = vnode.props
    applyProps(fiber.dom, fiber, oldProps, vnode.props, vnode.ref)
    fiber.children = reconcileChildren(fiber, fiber.dom, vnode.props.children, fiber.children)
    return fiber
  }

  function mountFunction(vnode, parentDom) {
    const fiber = {
      kind: 'function',
      type: vnode.type,
      vnode: vnode,
      parentDom: parentDom,
      props: vnode.props,
      ref: vnode.ref,
      hooks: [],
      children: [],
    }
    renderFunction(fiber)
    return fiber
  }

  function patchFunction(fiber, vnode) {
    fiber.vnode = vnode
    fiber.props = vnode.props
    renderFunction(fiber)
    return fiber
  }

  function renderFunction(fiber) {
    const previousFiber = currentFiber
    const previousIndex = hookIndex
    currentFiber = fiber
    hookIndex = 0
    let output
    try {
      output = fiber.type(fiber.props)
    } finally {
      currentFiber = previousFiber
      hookIndex = previousIndex
    }
    fiber.children = reconcileChildren(fiber, fiber.parentDom, output, fiber.children)
  }

  function mountClass(vnode, parentDom) {
    const inst = new vnode.type(vnode.props)
    if (!inst.state) inst.state = {}
    const fiber = {
      kind: 'class',
      type: vnode.type,
      vnode: vnode,
      inst: inst,
      parentDom: parentDom,
      props: vnode.props,
      ref: vnode.ref,
      children: [],
    }
    renderClass(fiber)
    return fiber
  }

  function patchClass(fiber, vnode) {
    fiber.vnode = vnode
    fiber.props = vnode.props
    fiber.inst.props = vnode.props
    renderClass(fiber)
    return fiber
  }

  function renderClass(fiber) {
    let output
    try {
      output = fiber.inst.render()
    } catch (error) {
      const type = fiber.type
      if (typeof type.getDerivedStateFromError === 'function') {
        fiber.inst.state = Object.assign({}, fiber.inst.state, type.getDerivedStateFromError(error))
        pendingDidCatch.push({ fiber: fiber, error: error })
        output = fiber.inst.render()
      } else {
        throw error
      }
    }
    fiber.children = reconcileChildren(fiber, fiber.parentDom, output, fiber.children)
  }

  function mount(vnode, parentDom) {
    if (vnode.$$typeof === TEXT) return mountText(vnode, parentDom)
    if (typeof vnode.type === 'string') return mountHost(vnode, parentDom)
    const kind = vnode.type.prototype && typeof vnode.type.prototype.render === 'function'
      ? 'class'
      : 'function'
    if (kind === 'class') return mountClass(vnode, parentDom)
    return mountFunction(vnode, parentDom)
  }

  function patchFiber(fiber, vnode) {
    if (vnode.$$typeof === TEXT) {
      fiber.vnode = vnode
      if (fiber.dom.nodeValue !== vnode.text) fiber.dom.nodeValue = vnode.text
      return fiber
    }
    if (typeof vnode.type === 'string') return patchHost(fiber, vnode)
    const kind = vnode.type.prototype && typeof vnode.type.prototype.render === 'function'
      ? 'class'
      : 'function'
    if (kind === 'class') return patchClass(fiber, vnode)
    return patchFunction(fiber, vnode)
  }

  function canReuse(fiber, vnode) {
    if (!fiber) return false
    if (vnode.$$typeof === TEXT) return fiber.kind === 'text'
    if (typeof vnode.type === 'string') return fiber.kind === 'host' && fiber.type === vnode.type
    const kind = vnode.type.prototype && typeof vnode.type.prototype.render === 'function'
      ? 'class'
      : 'function'
    return fiber.kind === kind && fiber.type === vnode.type
  }

  function unmountFiber(fiber) {
    if (!fiber) return
    const hooks = fiber.hooks || []
    for (let i = 0; i < hooks.length; i += 1) {
      const hook = hooks[i]
      if (hook && typeof hook.cleanup === 'function') {
        const cleanup = hook.cleanup
        hook.cleanup = null
        try {
          cleanup()
        } catch (error) {
          report(error)
        }
      }
    }
    if (fiber.kind === 'text' || fiber.kind === 'host') {
      if (fiber.ref && typeof fiber.ref === 'object') fiber.ref.current = null
      for (let i = 0; i < fiber.children.length; i += 1) unmountFiber(fiber.children[i])
      if (fiber.dom && fiber.dom.parentNode) fiber.dom.parentNode.removeChild(fiber.dom)
      return
    }
    for (let i = 0; i < fiber.children.length; i += 1) unmountFiber(fiber.children[i])
  }

  function reconcileChildren(fiber, parentDom, childrenProp, oldChildren) {
    const vnodes = flatten(childrenProp)
    const keyed = {}
    const unkeyed = []
    for (let i = 0; i < oldChildren.length; i += 1) {
      const old = oldChildren[i]
      if (!old) continue
      if (old.key !== null && old.key !== undefined) keyed[String(old.key)] = old
      else unkeyed.push(old)
    }
    const used = new Set()
    let unkeyedCursor = 0
    const next = []
    for (let i = 0; i < vnodes.length; i += 1) {
      const vnode = vnodes[i]
      let candidate = null
      if (vnode.key !== null && vnode.key !== undefined) {
        candidate = keyed[String(vnode.key)] || null
      } else {
        while (unkeyedCursor < unkeyed.length && used.has(unkeyed[unkeyedCursor])) unkeyedCursor += 1
        candidate = unkeyedCursor < unkeyed.length ? unkeyed[unkeyedCursor] : null
        unkeyedCursor += 1
      }
      if (candidate) used.add(candidate)
      if (candidate && canReuse(candidate, vnode)) {
        next.push(patchFiber(candidate, vnode))
      } else {
        if (candidate) unmountFiber(candidate)
        next.push(mount(vnode, parentDom))
      }
    }
    for (let i = 0; i < oldChildren.length; i += 1) {
      const old = oldChildren[i]
      if (old && !used.has(old)) unmountFiber(old)
    }
    appendNodes(parentDom, next)
    return next
  }

  /* ------------------------------------------------------------------ *
   * Commit effects
   * ------------------------------------------------------------------ */
  function commitEffects() {
    const effects = pendingEffects
    pendingEffects = []
    for (let i = 0; i < effects.length; i += 1) {
      const hook = effects[i]
      if (hook.cleanup) {
        const previous = hook.cleanup
        hook.cleanup = null
        try {
          previous()
        } catch (error) {
          report(error)
        }
      }
      try {
        const cleanup = hook.create()
        hook.cleanup = typeof cleanup === 'function' ? cleanup : null
      } catch (error) {
        report(error)
      }
    }
    const didCatch = pendingDidCatch
    pendingDidCatch = []
    for (let i = 0; i < didCatch.length; i += 1) {
      const inst = didCatch[i].fiber.inst
      if (inst && typeof inst.componentDidCatch === 'function') {
        try {
          inst.componentDidCatch(didCatch[i].error, { componentStack: '' })
        } catch (error) {
          report(error)
        }
      }
    }
  }

  function rerender() {
    if (!root || rendering) {
      rerenderQueued = true
      return
    }
    rendering = true
    try {
      if (!root.fiber) {
        root.fiber = mount(root.element, root.container)
      } else {
        root.fiber = patchFiber(root.fiber, root.element)
      }
    } finally {
      rendering = false
    }
    commitEffects()
    if (rerenderQueued) {
      rerenderQueued = false
      rerender()
    }
  }

  function scheduleRerender() {
    if (!root) return
    if (rendering) {
      rerenderQueued = true
      return
    }
    rerender()
  }

  function render(element, container) {
    if (!container) throw new Error('fake-react: render needs a container')
    if (root && root.container === container) {
      root.element = element
      rerender()
      return
    }
    if (root) unmountRoot()
    root = { container: container, element: element, fiber: null }
    rerender()
  }

  function unmountRoot() {
    if (!root) return
    if (root.fiber) unmountFiber(root.fiber)
    pendingEffects = []
    pendingDidCatch = []
    root = null
  }

  function unmountComponentAtNode(container) {
    if (!root || root.container !== container) return false
    unmountRoot()
    return true
  }

  global.FakeReact = {
    createElement: createElement,
    Component: Component,
    useState: useState,
    useRef: useRef,
    useEffect: useEffect,
    useCallback: useCallback,
    useMemo: useMemo,
    render: render,
    unmountComponentAtNode: unmountComponentAtNode,
    __errors: errors,
  }
})(typeof window !== 'undefined' ? window : globalThis)
