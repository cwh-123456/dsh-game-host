/*!
 * dev/fake-react.js — 极简 React 替身（仅 dev 预览用，不随包发布）
 * ---------------------------------------------------------------------------
 * `client.js` 运行时通过 `require('react')` 从宿主模块表拿 React。dev 预览页
 * 没有宿主，所以这里用真实 DOM 实现一个够用的迷你 React，让预览页能真实
 * 渲染 client.js 注册的游戏组件、跑 hooks / effects / setState / 事件。
 *
 * 支持（client.js 实际用到的子集 + 常用）：
 *   - createElement（key / ref / 嵌套 children / 数组 / null / 数字 / 字符串）
 *   - 函数组件 + hooks：useState / useRef / useEffect / useCallback / useMemo
 *   - 类组件：Component 基类、state / setState、componentDidMount /
 *     componentDidUpdate / componentWillUnmount、getDerivedStateFromError +
 *     componentDidCatch（错误边界）
 *   - DOM props：style 对象（camelCase → CSS，数字补 px）、className、
 *     aria-* / data-* / role / title / tabIndex / value / disabled
 *   - 事件 props：onClick / onDoubleClick / onPointerDown / onPointerMove /
 *     onPointerLeave / onContextMenu / onAuxClick ...
 *   - ref：{current} 对象 ref（宿主元素）
 *
 * 语义边界（够预览用，不是 React 完整实现）：同步渲染；不做并发调度；
 * 子节点按 key / 位置复用，不实现真正的 Fiber 优先级。
 */
;(function (global) {
  'use strict'

  if (global.FakeReact) return

  var ELEMENT = typeof Symbol === 'function' ? Symbol('fakeReact.element') : '__fakeReactElement__'
  var TEXT = typeof Symbol === 'function' ? Symbol('fakeReact.text') : '__fakeReactText__'
  var Fragment = typeof Symbol === 'function' ? Symbol('fakeReact.fragment') : '__fakeReactFragment__'
  var hasOwn = Object.prototype.hasOwnProperty

  var UNITLESS = {
    fontWeight: 1,
    opacity: 1,
    lineHeight: 1,
    zIndex: 1,
    flex: 1,
    flexGrow: 1,
    flexShrink: 1,
    order: 1,
    zoom: 1,
    aspectRatio: 1,
    animationIterationCount: 1,
  }

  function reportError(error) {
    try {
      console.error('[fake-react]', error)
    } catch (ignored) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * createElement / vnode
   * ------------------------------------------------------------------ */

  function createElement(type, config) {
    if (type === undefined || type === null) throw new Error('fake-react: createElement(type) is required')
    var props = {}
    var ref = null
    var key = null
    if (config) {
      for (var name in config) {
        if (!hasOwn.call(config, name)) continue
        if (name === 'key') key = String(config.key)
        else if (name === 'ref') ref = config.ref
        else props[name] = config[name]
      }
    }
    var children = []
    for (var i = 2; i < arguments.length; i += 1) children.push(arguments[i])
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return { $$typeof: ELEMENT, type: type, key: key, ref: ref, props: props }
  }

  function isValidElement(value) {
    return value !== null && typeof value === 'object' && value.$$typeof === ELEMENT
  }

  function normalize(children) {
    var out = []
    collect(children, out)
    return out
  }

  function collect(children, out) {
    if (children === null || children === undefined || children === false || children === true) return
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i += 1) collect(children[i], out)
      return
    }
    if (isValidElement(children) && children.type === Fragment) {
      collect(children.props.children, out)
      return
    }
    if (typeof children === 'string' || typeof children === 'number' || typeof children === 'bigint') {
      out.push({ type: TEXT, key: null, props: {}, text: String(children) })
      return
    }
    if (isValidElement(children)) {
      out.push(children)
      return
    }
    throw new Error('fake-react: invalid child ' + Object.prototype.toString.call(children))
  }

  function kindOf(type) {
    if (type === TEXT) return 'text'
    if (typeof type === 'string') return 'host'
    if (typeof type === 'function') {
      return type.prototype && typeof type.prototype.render === 'function' ? 'class' : 'function'
    }
    throw new Error('fake-react: unsupported element type ' + String(type))
  }

  /* ------------------------------------------------------------------ *
   * DOM props / style / 事件 / ref
   * ------------------------------------------------------------------ */

  function kebab(name) {
    if (name.indexOf('--') === 0) return name
    return name.replace(/[A-Z]/g, function (match) {
      return '-' + match.toLowerCase()
    })
  }

  function styleText(style) {
    if (!style) return ''
    if (typeof style === 'string') return style
    var parts = []
    for (var name in style) {
      if (!hasOwn.call(style, name)) continue
      var value = style[name]
      if (value === null || value === undefined || value === false) continue
      var css = kebab(name)
      var text
      if (typeof value === 'number' && !UNITLESS[name]) text = value + 'px'
      else text = String(value)
      parts.push(css + ':' + text)
    }
    return parts.join(';')
  }

  function isEventProp(name) {
    return typeof name === 'string' && name.length > 2 && name[0] === 'o' && name[1] === 'n' &&
      name[2] === name[2].toUpperCase()
  }

  function eventType(name) {
    var rest = name.slice(2)
    if (rest === 'DoubleClick') return 'dblclick'
    return rest.toLowerCase()
  }

  function setRef(ref, value) {
    if (typeof ref === 'function') ref(value)
    else if (ref !== null && ref !== undefined && typeof ref === 'object') ref.current = value
  }

  function removeDomEvent(dom, name) {
    if (!dom.__fxListeners || !dom.__fxListeners[name]) return
    var record = dom.__fxListeners[name]
    dom.removeEventListener(record.type, record.wrapper)
    delete dom.__fxListeners[name]
  }

  function removeAllDomEvents(dom) {
    if (!dom.__fxListeners) return
    var names = Object.keys(dom.__fxListeners)
    for (var i = 0; i < names.length; i += 1) removeDomEvent(dom, names[i])
  }

  function addDomEvent(dom, name) {
    if (!dom.__fxListeners) dom.__fxListeners = {}
    if (dom.__fxListeners[name]) return
    var type = eventType(name)
    var wrapper = function (event) {
      var props = dom.__fxProps
      var handler = props && props[name]
      if (typeof handler === 'function') handler(event)
    }
    dom.__fxListeners[name] = { type: type, wrapper: wrapper }
    dom.addEventListener(type, wrapper)
  }

  function setDomProp(dom, name, value) {
    if (name === 'value') {
      try {
        dom.value = value === null || value === undefined ? '' : String(value)
      } catch (ignored) {
        /* ignore */
      }
      return
    }
    if (name === 'checked' || name === 'selected') {
      try {
        dom[name] = !!value
      } catch (ignored) {
        /* ignore */
      }
      return
    }
    if (name === 'tabIndex') {
      dom.setAttribute('tabindex', String(value))
      return
    }
    if (name === 'disabled' || name === 'readOnly' || name === 'hidden') {
      try {
        dom[name] = !!value
      } catch (ignored) {
        /* ignore */
      }
      if (value) dom.setAttribute(name.toLowerCase(), '')
      else dom.removeAttribute(name.toLowerCase())
      return
    }
    if (name.indexOf('aria-') === 0 || name.indexOf('data-') === 0) {
      if (value === null || value === undefined) dom.removeAttribute(name)
      else dom.setAttribute(name, value === true ? 'true' : value === false ? 'false' : String(value))
      return
    }
    if (value === null || value === undefined || value === false) {
      dom.removeAttribute(name)
      return
    }
    if (value === true) {
      dom.setAttribute(name, '')
      return
    }
    dom.setAttribute(name, String(value))
  }

  var SKIP_PROPS = {
    children: 1,
    key: 1,
    ref: 1,
    style: 1,
    className: 1,
    dangerouslySetInnerHTML: 1,
  }

  function applyProps(dom, oldProps, newProps, fiber) {
    oldProps = oldProps || {}
    newProps = newProps || {}
    if (oldProps.style !== newProps.style) dom.style.cssText = styleText(newProps.style)
    if (oldProps.className !== newProps.className) {
      if (newProps.className === null || newProps.className === undefined || newProps.className === false) {
        dom.removeAttribute('class')
      } else {
        dom.setAttribute('class', String(newProps.className))
      }
    }
    var name
    for (name in oldProps) {
      if (!hasOwn.call(oldProps, name) || SKIP_PROPS[name] || isEventProp(name)) continue
      if (!hasOwn.call(newProps, name)) setDomProp(dom, name, undefined)
    }
    for (name in newProps) {
      if (!hasOwn.call(newProps, name) || SKIP_PROPS[name] || isEventProp(name)) continue
      if (oldProps[name] === newProps[name]) continue
      setDomProp(dom, name, newProps[name])
    }
    for (name in oldProps) {
      if (!hasOwn.call(oldProps, name) || !isEventProp(name)) continue
      if (!hasOwn.call(newProps, name)) removeDomEvent(dom, name)
    }
    for (name in newProps) {
      if (!hasOwn.call(newProps, name) || !isEventProp(name)) continue
      if (typeof newProps[name] === 'function' && !(oldProps[name] === newProps[name])) addDomEvent(dom, name)
      else if (typeof newProps[name] !== 'function') removeDomEvent(dom, name)
    }
    if (fiber) fiber.props = newProps
    dom.__fxProps = newProps
  }

  /* ------------------------------------------------------------------ *
   * 组件树 / hooks
   * ------------------------------------------------------------------ */

  var root = null
  var currentFiber = null
  var hookIndex = 0
  var pendingEffects = []
  var rendering = false
  var updateRequested = false

  function Component(props) {
    this.props = props
    this.state = null
    this.__fiber = null
  }
  Component.prototype.setState = function (partial, callback) {
    var fiber = this.__fiber
    if (!fiber) return
    var next = typeof partial === 'function' ? partial.call(this, this.state, this.props) : partial
    if (next !== null && next !== undefined) this.state = Object.assign({}, this.state, next)
    requestUpdate()
    if (typeof callback === 'function') callback()
  }
  Component.prototype.forceUpdate = function (callback) {
    requestUpdate()
    if (typeof callback === 'function') callback()
  }

  function getHook() {
    if (!currentFiber) throw new Error('fake-react: hooks can only be called inside a component')
    var fiber = currentFiber
    var index = hookIndex
    hookIndex += 1
    if (!fiber.hooks) fiber.hooks = []
    if (!fiber.hooks[index]) fiber.hooks[index] = {}
    return { fiber: fiber, hook: fiber.hooks[index] }
  }

  function useState(initial) {
    var slot = getHook()
    if (!hasOwn.call(slot.hook, 'state')) {
      slot.hook.state = typeof initial === 'function' ? initial() : initial
      slot.hook.setState = function (action) {
        var next = typeof action === 'function' ? action(slot.hook.state) : action
        if (Object.is(next, slot.hook.state)) return
        slot.hook.state = next
        requestUpdate()
      }
    }
    return [slot.hook.state, slot.hook.setState]
  }

  function useRef(initial) {
    var slot = getHook()
    if (!hasOwn.call(slot.hook, 'ref')) slot.hook.ref = { current: initial }
    return slot.hook.ref
  }

  function depsEqual(previous, next) {
    if (previous === undefined || next === undefined) return false
    if (!Array.isArray(previous) || !Array.isArray(next)) return false
    if (previous.length !== next.length) return false
    for (var i = 0; i < previous.length; i += 1) {
      if (!Object.is(previous[i], next[i])) return false
    }
    return true
  }

  function useEffect(create, deps) {
    var slot = getHook()
    var changed = true
    if (deps !== undefined && deps !== null) changed = !depsEqual(slot.hook.deps, deps)
    slot.hook.deps = deps === undefined || deps === null ? undefined : deps.slice()
    if (changed) pendingEffects.push({ fiber: slot.fiber, hook: slot.hook, create: create })
  }

  function useMemo(factory, deps) {
    var slot = getHook()
    if (deps === undefined || deps === null || !depsEqual(slot.hook.memoDeps, deps)) {
      slot.hook.memoValue = factory()
      slot.hook.memoDeps = deps === undefined || deps === null ? undefined : deps.slice()
    }
    return slot.hook.memoValue
  }

  function useCallback(callback, deps) {
    var slot = getHook()
    if (deps === undefined || deps === null || !depsEqual(slot.hook.callbackDeps, deps)) {
      slot.hook.callbackValue = callback
      slot.hook.callbackDeps = deps === undefined || deps === null ? undefined : deps.slice()
    }
    return slot.hook.callbackValue
  }

  function requestUpdate() {
    if (!root) return
    if (rendering) {
      updateRequested = true
      return
    }
    rendering = true
    var guard = 0
    try {
      do {
        updateRequested = false
        commitUpdate()
      } while (updateRequested && (guard += 1) < 100)
      if (guard >= 100) reportError(new Error('fake-react: render loop did not settle'))
    } finally {
      rendering = false
    }
  }

  function commitUpdate() {
    if (!root) return
    root.children = reconcileChildren(root.container, root.children || [], normalize([root.element]))
    runEffects()
  }

  function runEffects() {
    var effects = pendingEffects
    pendingEffects = []
    for (var i = 0; i < effects.length; i += 1) {
      var effect = effects[i]
      if (!effect.fiber || effect.fiber.__mounted === false) continue
      var hook = effect.hook
      if (typeof hook.cleanup === 'function') {
        var previousCleanup = hook.cleanup
        hook.cleanup = null
        try {
          previousCleanup()
        } catch (error) {
          reportError(error)
        }
      }
      try {
        var cleanup = effect.create()
        if (typeof cleanup === 'function') hook.cleanup = cleanup
      } catch (error) {
        reportError(error)
      }
    }
  }

  function unmountFiber(fiber) {
    if (!fiber || fiber.__mounted === false) return
    fiber.__mounted = false
    if (fiber.kind === 'text') {
      if (fiber.dom && fiber.dom.parentNode) fiber.dom.parentNode.removeChild(fiber.dom)
      return
    }
    if (fiber.kind === 'host') {
      unmountChildren(fiber)
      if (fiber.ref) setRef(fiber.ref, null)
      removeAllDomEvents(fiber.dom)
      if (fiber.dom.parentNode) fiber.dom.parentNode.removeChild(fiber.dom)
      return
    }
    if (fiber.kind === 'class' && fiber.inst && typeof fiber.inst.componentWillUnmount === 'function') {
      try {
        fiber.inst.componentWillUnmount()
      } catch (error) {
        reportError(error)
      }
    }
    if (fiber.kind === 'function') {
      var hooks = fiber.hooks || []
      for (var i = 0; i < hooks.length; i += 1) {
        var hook = hooks[i]
        if (hook && typeof hook.cleanup === 'function') {
          var cleanup = hook.cleanup
          hook.cleanup = null
          try {
            cleanup()
          } catch (error) {
            reportError(error)
          }
        }
      }
    }
    unmountChildren(fiber)
  }

  function unmountChildren(fiber) {
    var children = fiber.children || []
    for (var i = 0; i < children.length; i += 1) unmountFiber(children[i])
    fiber.children = []
  }

  function collectDom(fiber, out) {
    if (!fiber || fiber.__mounted === false) return
    if (fiber.kind === 'text' || fiber.kind === 'host') {
      if (fiber.dom) out.push(fiber.dom)
      return
    }
    var children = fiber.children || []
    for (var i = 0; i < children.length; i += 1) collectDom(children[i], out)
  }

  function ensureOrder(parentDom, fibers) {
    var nodes = []
    for (var i = 0; i < fibers.length; i += 1) collectDom(fibers[i], nodes)
    var reference = null
    for (var j = nodes.length - 1; j >= 0; j -= 1) {
      var node = nodes[j]
      if (!node) continue
      if (node.parentNode !== parentDom || node.nextSibling !== reference) {
        parentDom.insertBefore(node, reference)
      }
      reference = node
    }
  }

  function sameType(fiber, vnode) {
    if (vnode.type === TEXT) return fiber.kind === 'text'
    return fiber.kind !== 'text' && fiber.type === vnode.type
  }

  function mountFiber(vnode, parentDom) {
    var kind = kindOf(vnode.type)
    if (kind === 'text') {
      var textDom = document.createTextNode(vnode.text)
      parentDom.appendChild(textDom)
      return { kind: 'text', type: TEXT, key: null, props: {}, text: vnode.text, dom: textDom, __mounted: true }
    }
    if (kind === 'host') {
      var dom = document.createElement(vnode.type)
      var hostFiber = {
        kind: 'host',
        type: vnode.type,
        key: vnode.key,
        props: vnode.props,
        dom: dom,
        ref: vnode.ref,
        children: [],
        __mounted: true,
      }
      applyProps(dom, {}, vnode.props, hostFiber)
      parentDom.appendChild(dom)
      hostFiber.children = reconcileChildren(dom, [], normalize(vnode.props.children))
      if (vnode.ref) setRef(vnode.ref, dom)
      return hostFiber
    }
    if (kind === 'function') {
      var functionFiber = {
        kind: 'function',
        type: vnode.type,
        key: vnode.key,
        props: vnode.props,
        hooks: [],
        children: [],
        __mounted: true,
      }
      renderFunction(functionFiber, parentDom)
      return functionFiber
    }
    var classFiber = {
      kind: 'class',
      type: vnode.type,
      key: vnode.key,
      props: vnode.props,
      inst: null,
      children: [],
      __mounted: true,
    }
    var inst = new vnode.type(vnode.props)
    inst.props = vnode.props
    if (inst.state === undefined) inst.state = null
    inst.__fiber = classFiber
    classFiber.inst = inst
    renderClass(classFiber, parentDom)
    if (typeof inst.componentDidMount === 'function') {
      try {
        inst.componentDidMount()
      } catch (error) {
        reportError(error)
      }
    }
    return classFiber
  }

  function renderFunction(fiber, parentDom) {
    var previousFiber = currentFiber
    var previousIndex = hookIndex
    currentFiber = fiber
    hookIndex = 0
    var output
    try {
      output = fiber.type(fiber.props)
    } finally {
      currentFiber = previousFiber
      hookIndex = previousIndex
    }
    fiber.children = reconcileChildren(parentDom, fiber.children || [], normalize([output]))
  }

  function renderClass(fiber, parentDom) {
    var inst = fiber.inst
    if (fiber.type && typeof fiber.type.getDerivedStateFromProps === 'function') {
      var derived = fiber.type.getDerivedStateFromProps(inst.props, inst.state)
      if (derived !== null && derived !== undefined) inst.state = Object.assign({}, inst.state, derived)
    }
    var output
    try {
      output = inst.render()
    } catch (error) {
      if (fiber.type && typeof fiber.type.getDerivedStateFromError === 'function') {
        inst.state = Object.assign({}, inst.state, fiber.type.getDerivedStateFromError(error))
        if (typeof inst.componentDidCatch === 'function') {
          try {
            inst.componentDidCatch(error, { componentStack: '' })
          } catch (catchError) {
            reportError(catchError)
          }
        }
        output = inst.render()
      } else {
        throw error
      }
    }
    fiber.children = reconcileChildren(parentDom, fiber.children || [], normalize([output]))
  }

  function updateFiber(fiber, vnode, parentDom) {
    if (fiber.kind === 'text') {
      fiber.text = vnode.text
      if (fiber.dom.nodeValue !== vnode.text) fiber.dom.nodeValue = vnode.text
      return fiber
    }
    if (fiber.kind === 'host') {
      var oldProps = fiber.props
      fiber.props = vnode.props
      applyProps(fiber.dom, oldProps, vnode.props, fiber)
      fiber.children = reconcileChildren(fiber.dom, fiber.children || [], normalize(vnode.props.children))
      if (fiber.ref !== vnode.ref) {
        if (fiber.ref) setRef(fiber.ref, null)
        fiber.ref = vnode.ref
        if (vnode.ref) setRef(vnode.ref, fiber.dom)
      }
      return fiber
    }
    if (fiber.kind === 'function') {
      fiber.props = vnode.props
      renderFunction(fiber, parentDom)
      return fiber
    }
    fiber.props = vnode.props
    fiber.inst.props = vnode.props
    renderClass(fiber, parentDom)
    return fiber
  }

  function reconcileChildren(parentDom, oldFibers, vnodes) {
    oldFibers = oldFibers || []
    var keyed = {}
    var unkeyed = []
    var i
    for (i = 0; i < oldFibers.length; i += 1) {
      var oldFiber = oldFibers[i]
      if (!oldFiber || oldFiber.__mounted === false) continue
      if (oldFiber.key === null || oldFiber.key === undefined) unkeyed.push(oldFiber)
      else keyed[oldFiber.key] = oldFiber
    }
    var used = new Set()
    var unkeyedCursor = 0
    var result = []
    for (i = 0; i < vnodes.length; i += 1) {
      var vnode = vnodes[i]
      var candidate = null
      if (vnode.key !== null && vnode.key !== undefined) {
        candidate = keyed[vnode.key] || null
        if (candidate && used.has(candidate)) candidate = null
      } else {
        while (unkeyedCursor < unkeyed.length && used.has(unkeyed[unkeyedCursor])) unkeyedCursor += 1
        candidate = unkeyedCursor < unkeyed.length ? unkeyed[unkeyedCursor] : null
        unkeyedCursor += 1
      }
      if (candidate) used.add(candidate)
      if (candidate && sameType(candidate, vnode)) {
        result.push(updateFiber(candidate, vnode, parentDom))
      } else {
        if (candidate) unmountFiber(candidate)
        result.push(mountFiber(vnode, parentDom))
      }
    }
    for (i = 0; i < oldFibers.length; i += 1) {
      var fiber = oldFibers[i]
      if (fiber && !used.has(fiber)) unmountFiber(fiber)
    }
    ensureOrder(parentDom, result)
    return result
  }

  /* ------------------------------------------------------------------ *
   * 根渲染
   * ------------------------------------------------------------------ */

  function render(element, container) {
    if (!container) throw new Error('fake-react: render(element, container) needs a container')
    if (root && root.container === container) {
      root.element = element
      requestUpdate()
      return
    }
    if (root) unmountRoot()
    root = { container: container, element: element, children: [] }
    requestUpdate()
  }

  function unmountRoot() {
    if (!root) return
    var children = root.children || []
    for (var i = 0; i < children.length; i += 1) unmountFiber(children[i])
    pendingEffects = []
    root = null
  }

  function unmountComponentAtNode(container) {
    if (!root || root.container !== container) return false
    unmountRoot()
    return true
  }

  global.FakeReact = {
    createElement: createElement,
    isValidElement: isValidElement,
    Component: Component,
    Fragment: Fragment,
    createRef: function () {
      return { current: null }
    },
    useRef: useRef,
    useState: useState,
    useEffect: useEffect,
    useMemo: useMemo,
    useCallback: useCallback,
    render: render,
    unmountComponentAtNode: unmountComponentAtNode,
    __version: 'fake-react 1.0 (dev only)',
    __debug: {
      getRoot: function () {
        return root
      },
    },
  }
})(typeof window !== 'undefined' ? window : globalThis)
