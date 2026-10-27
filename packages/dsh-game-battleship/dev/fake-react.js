/**
 * Minimal React-compatible renderer for the Battleship dev preview (dev-only,
 * never shipped). Copied from packages/dsh-game-solitaire/dev/fake-react.js
 * (the proven dev harness) so this package's preview does not depend on the
 * solitaire package existing at install time.
 *
 * It is intentionally small: it only implements the subset of React that
 * `client.js` uses, on top of a real browser DOM (Chromium preview) or a fake
 * DOM (node tests can import it too).
 *
 * Supported: createElement + children flattening, function components with
 * useState / useRef / useEffect / useLayoutEffect / useCallback / useMemo,
 * class components with setState / forceUpdate / componentDidMount /
 * componentDidUpdate / componentWillUnmount / getDerivedStateFromError +
 * componentDidCatch (error boundaries), keyed lists, style/className/events,
 * refs, Fragment, synchronous re-rendering.
 *
 * Not supported (not needed here): context, portals, concurrent features,
 * Suspense, server rendering, synthetic event pooling.
 */
;(function (global) {
  'use strict'

  var Fragment = typeof Symbol === 'function' ? Symbol('fakeReact.fragment') : '__fakeReactFragment__'
  var roots = []
  var pendingRender = false
  var rendering = false
  var currentFiber = null
  var effectQueue = []

  function isVNode(value) {
    return !!value && typeof value === 'object' && value.__fakeVNode === true
  }

  function appendChildren(target, child) {
    if (child === null || child === undefined || typeof child === 'boolean') return
    if (Array.isArray(child)) {
      for (var i = 0; i < child.length; i += 1) appendChildren(target, child[i])
      return
    }
    target.push(child)
  }

  function createElement(type, config) {
    if (type === undefined || type === null) throw new Error('fake-react: createElement requires a type')
    var props = {}
    var key = null
    config = config || {}
    for (var name in config) {
      if (!Object.prototype.hasOwnProperty.call(config, name)) continue
      if (name === 'key') key = config[name]
      else props[name] = config[name]
    }
    var children = []
    for (var i = 2; i < arguments.length; i += 1) appendChildren(children, arguments[i])
    if (props.children !== undefined) {
      var explicit = props.children
      delete props.children
      appendChildren(children, explicit)
    }
    // Mimic React: one child collapses to the element itself, several become an array.
    props.children = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return {
      __fakeVNode: true,
      type: type,
      key: key === null || key === undefined ? null : String(key),
      props: props,
      children: children,
    }
  }

  function isClassType(type) {
    return typeof type === 'function' && type.prototype && type.prototype.isReactComponent === true
  }

  function textVNode(text) {
    return { __fakeVNode: true, type: '#text', key: null, props: {}, children: [], text: String(text) }
  }

  function normalizeChild(child) {
    if (child === null || child === undefined || typeof child === 'boolean') return null
    if (typeof child === 'string' || typeof child === 'number') return textVNode(child)
    if (Array.isArray(child)) throw new Error('fake-react: nested child arrays must be flattened by createElement')
    if (!isVNode(child)) throw new Error('fake-react: invalid child ' + typeof child)
    return child
  }

  /* ------------------------------------------------------------------ *
   * DOM property patching
   * ------------------------------------------------------------------ */

  var UNITLESS = {
    animationIterationCount: 1, borderImageOutset: 1, borderImageSlice: 1, borderImageWidth: 1,
    boxFlex: 1, boxFlexGroup: 1, boxOrdinalGroup: 1, columnCount: 1, columns: 1, flex: 1,
    flexGrow: 1, flexPositive: 1, flexShrink: 1, flexNegative: 1, flexOrder: 1, gridRow: 1,
    gridRowEnd: 1, gridRowSpan: 1, gridRowStart: 1, gridColumn: 1, gridColumnEnd: 1,
    gridColumnSpan: 1, gridColumnStart: 1, gridRowSpan: 1, fontWeight: 1, lineClamp: 1,
    lineHeight: 1, opacity: 1, order: 1, orphans: 1, tabSize: 1, widows: 1, zIndex: 1, zoom: 1,
    fillOpacity: 1, floodOpacity: 1, stopOpacity: 1, strokeDasharray: 1, strokeDashoffset: 1,
    strokeMiterlimit: 1, strokeOpacity: 1, strokeWidth: 1,
  }

  function styleKey(name) {
    if (name.indexOf('--') === 0) return name
    return name.replace(/[A-Z]/g, function (match) {
      return '-' + match.toLowerCase()
    })
  }

  function styleValue(name, value) {
    if (value === null || value === undefined || value === '') return ''
    if (typeof value === 'number' && !UNITLESS[name] && name.indexOf('--') !== 0) return value + 'px'
    return String(value)
  }

  function applyStyle(dom, oldStyle, newStyle) {
    if (oldStyle === newStyle) return
    var oldObj = oldStyle && typeof oldStyle === 'object' ? oldStyle : {}
    var newObj = newStyle && typeof newStyle === 'object' ? newStyle : {}
    var name
    for (name in oldObj) {
      if (!Object.prototype.hasOwnProperty.call(oldObj, name)) continue
      if (!Object.prototype.hasOwnProperty.call(newObj, name)) dom.style.removeProperty(styleKey(name))
    }
    for (name in newObj) {
      if (!Object.prototype.hasOwnProperty.call(newObj, name)) continue
      var value = styleValue(name, newObj[name])
      var cssName = styleKey(name)
      if (value === '') dom.style.removeProperty(cssName)
      else dom.style.setProperty(cssName, value)
    }
  }

  function isEventProp(name) {
    return typeof name === 'string' && name.length > 2 && name[0] === 'o' && name[1] === 'n' && name[2] === name[2].toUpperCase()
  }

  function eventTypeFor(name) {
    if (name === 'DoubleClick') return 'dblclick'
    if (name === 'Change') return 'change'
    return name.toLowerCase()
  }

  // Supports React's capture-phase props such as onClickCapture / onPointerDownCapture.
  function eventSpec(propName) {
    var name = propName.slice(2)
    var capture = false
    if (name.length > 7 && name.slice(-7) === 'Capture') {
      capture = true
      name = name.slice(0, -7)
    }
    return { type: eventTypeFor(name), capture: capture }
  }

  function setRef(ref, value) {
    if (typeof ref === 'function') ref(value)
    else if (ref !== null && ref !== undefined && typeof ref === 'object') ref.current = value
  }

  function patchProps(dom, oldProps, newProps) {
    var name
    for (name in oldProps) {
      if (!Object.prototype.hasOwnProperty.call(oldProps, name)) continue
      if (name === 'children' || name === 'key') continue
      if (!Object.prototype.hasOwnProperty.call(newProps, name)) {
        if (name === 'style') applyStyle(dom, oldProps.style, null)
        else if (isEventProp(name)) {
          var oldRecord = dom.__fakeEvents && dom.__fakeEvents[name]
          if (oldRecord) {
            dom.removeEventListener(oldRecord.type, oldRecord.wrapper, oldRecord.capture === true)
            delete dom.__fakeEvents[name]
          }
        } else if (name === 'ref') setRef(oldProps.ref, null)
        else if (name === 'className') dom.removeAttribute('class')
        else if (name === 'dangerouslySetInnerHTML') dom.innerHTML = ''
        else dom.removeAttribute(name)
      }
    }
    for (name in newProps) {
      if (!Object.prototype.hasOwnProperty.call(newProps, name)) continue
      if (name === 'children' || name === 'key') continue
      var value = newProps[name]
      if (name === 'style') {
        applyStyle(dom, oldProps.style, value)
      } else if (name === 'className') {
        if (value === null || value === undefined) dom.removeAttribute('class')
        else dom.setAttribute('class', String(value))
      } else if (isEventProp(name)) {
        if (typeof value !== 'function') continue
        if (!dom.__fakeEvents) dom.__fakeEvents = {}
        var oldHandler = dom.__fakeEvents[name]
        if (oldHandler && oldHandler.handler === value) continue
        if (oldHandler) {
          dom.removeEventListener(oldHandler.type, oldHandler.wrapper, oldHandler.capture === true)
        }
        var wrapper = (function (handler) {
          return function (event) {
            return handler(event)
          }
        })(value)
        var spec = eventSpec(name)
        dom.addEventListener(spec.type, wrapper, spec.capture)
        dom.__fakeEvents[name] = { type: spec.type, capture: spec.capture, wrapper: wrapper, handler: value }
      } else if (name === 'ref') {
        setRef(value, dom)
      } else if (name === 'dangerouslySetInnerHTML') {
        dom.innerHTML = value && value.__html ? value.__html : ''
      } else if (name === 'disabled' || name === 'value' || name === 'checked' || name === 'selected') {
        dom[name] = value
      } else if (name === 'tabIndex') {
        dom.setAttribute('tabindex', String(value))
      } else if (value === null || value === undefined || value === false) {
        dom.removeAttribute(name)
      } else {
        dom.setAttribute(name, value === true ? '' : String(value))
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Hooks
   * ------------------------------------------------------------------ */

  function nextHook() {
    var fiber = currentFiber
    if (!fiber) throw new Error('fake-react: hook called outside a component render')
    var index = fiber.hookIndex
    fiber.hookIndex += 1
    if (!(index in fiber.hooks)) fiber.hooks[index] = {}
    return fiber.hooks[index]
  }

  function depsChanged(oldDeps, newDeps) {
    if (!oldDeps) return true
    if (!newDeps) return true
    if (oldDeps.length !== newDeps.length) return true
    for (var i = 0; i < oldDeps.length; i += 1) {
      if (!Object.is(oldDeps[i], newDeps[i])) return true
    }
    return false
  }

  function useState(initial) {
    var hook = nextHook()
    if (!Object.prototype.hasOwnProperty.call(hook, 'value')) {
      hook.value = typeof initial === 'function' ? initial() : initial
    }
    if (!hook.setter) {
      hook.setter = function setter(next) {
        var value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) {
          requestRender()
          return
        }
        hook.value = value
        requestRender()
      }
    }
    return [hook.value, hook.setter]
  }

  function useRef(initial) {
    var hook = nextHook()
    if (!hook.ref) hook.ref = { current: initial }
    return hook.ref
  }

  function useEffect(create, deps) {
    var hook = nextHook()
    if (depsChanged(hook.deps, deps)) {
      hook.deps = deps
      effectQueue.push({ hook: hook, create: create })
    }
  }

  function useCallback(callback, deps) {
    var hook = nextHook()
    if (depsChanged(hook.deps, deps)) {
      hook.deps = deps
      hook.value = callback
    }
    return hook.value
  }

  function useMemo(factory, deps) {
    var hook = nextHook()
    if (depsChanged(hook.deps, deps)) {
      hook.deps = deps
      hook.value = factory()
    }
    return hook.value
  }

  function useLayoutEffect(create, deps) {
    useEffect(create, deps)
  }

  function Component(props) {
    this.props = props
    this.state = this.state || {}
  }
  Component.prototype.isReactComponent = true
  Component.prototype.setState = function setState(partial, callback) {
    var next = typeof partial === 'function' ? partial(this.state, this.props) : partial
    this.state = Object.assign({}, this.state, next)
    var self = this
    requestRender(function () {
      if (typeof callback === 'function') callback.call(self)
    })
  }
  Component.prototype.forceUpdate = function forceUpdate(callback) {
    var self = this
    requestRender(function () {
      if (typeof callback === 'function') callback.call(self)
    })
  }

  function runCleanups(fiber) {
    if (!fiber.hooks) return
    for (var i = 0; i < fiber.hooks.length; i += 1) {
      var hook = fiber.hooks[i]
      if (hook && typeof hook.cleanup === 'function') {
        try {
          hook.cleanup()
        } catch (error) {
          console.error('[fake-react] cleanup failed', error)
        }
        hook.cleanup = null
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Fibers
   * ------------------------------------------------------------------ */

  function createFiber(vnode) {
    return {
      type: vnode.type,
      key: vnode.key,
      props: vnode.props,
      hooks: [],
      hookIndex: 0,
      dom: null,
      childFiber: null,
      childFibers: [],
      parent: null,
      instance: null,
      cleanups: [],
    }
  }

  function topDom(fiber) {
    if (!fiber) return null
    if (fiber.dom) return fiber.dom
    if (fiber.childFiber) return topDom(fiber.childFiber)
    return null
  }

  function canReuse(fiber, vnode) {
    if (!fiber) return false
    if (fiber.type !== vnode.type) return false
    if ((fiber.key || null) !== (vnode.key || null)) return false
    return true
  }

  function findBoundary(fiber) {
    var node = fiber.parent
    while (node) {
      if (node.instance && typeof node.instance.componentDidCatch === 'function') return node
      node = node.parent
    }
    return null
  }

  function handleRenderError(fiber, error) {
    var boundary = findBoundary(fiber)
    if (!boundary) throw error
    var derived = null
    try {
      if (typeof boundary.type.getDerivedStateFromError === 'function') {
        derived = boundary.type.getDerivedStateFromError(error)
      }
    } catch (derivedError) {
      console.error('[fake-react] getDerivedStateFromError failed', derivedError)
    }
    boundary.instance.state = Object.assign({}, boundary.instance.state, derived || {})
    try {
      boundary.instance.componentDidCatch(error, { componentStack: '' })
    } catch (catchError) {
      console.error('[fake-react] componentDidCatch failed', catchError)
    }
    requestRender()
  }

  function mountFiber(vnode, parent) {
    vnode = normalizeChild(vnode)
    if (!vnode) return null
    if (vnode.type === '#text') {
      var textFiber = createFiber(vnode)
      textFiber.dom = document.createTextNode(vnode.text)
      textFiber.parent = parent
      return textFiber
    }
    if (vnode.type === Fragment) {
      var fragFiber = createFiber(vnode)
      fragFiber.parent = parent
      fragFiber.childFibers = mountChildren(fragFiber, vnode.children)
      fragFiber.dom = fragFiber.childFibers.length ? topDom(fragFiber.childFibers[0]) : null
      return fragFiber
    }
    if (typeof vnode.type === 'function') {
      var componentFiber = createFiber(vnode)
      componentFiber.parent = parent
      if (isClassType(vnode.type)) {
        var instance = new vnode.type(vnode.props)
        instance.props = vnode.props
        instance.state = instance.state || {}
        componentFiber.instance = instance
        instance.__fiber = componentFiber
      }
      renderComponent(componentFiber)
      return componentFiber
    }
    if (typeof vnode.type === 'string') {
      var hostFiber = createFiber(vnode)
      hostFiber.parent = parent
      hostFiber.dom = document.createElement(vnode.type)
      patchProps(hostFiber.dom, {}, vnode.props)
      hostFiber.__oldProps = vnode.props
      hostFiber.childFibers = mountChildren(hostFiber, vnode.children)
      orderDomNodes(hostFiber.dom, hostFiber.childFibers)
      return hostFiber
    }
    throw new Error('fake-react: unsupported element type ' + String(vnode.type))
  }

  function mountChildren(parentFiber, childVNodes) {
    var result = []
    for (var i = 0; i < childVNodes.length; i += 1) {
      var vnode = normalizeChild(childVNodes[i])
      if (!vnode) continue
      var child = null
      try {
        child = mountFiber(vnode, parentFiber)
      } catch (error) {
        handleRenderError(parentFiber, error)
        continue
      }
      if (child) result.push(child)
    }
    return result
  }

  function renderComponent(fiber) {
    currentFiber = fiber
    fiber.hookIndex = 0
    var previous = fiber.childFiber
    var output = null
    try {
      if (fiber.instance) {
        output = fiber.instance.render()
      } else {
        output = fiber.type(fiber.props)
      }
    } catch (error) {
      currentFiber = null
      handleRenderError(fiber, error)
      return
    }
    currentFiber = null
    var vnode = normalizeChild(output)
    if (!vnode) {
      if (previous) unmountFiber(previous)
      fiber.childFiber = null
      return
    }
    if (previous && canReuse(previous, vnode)) {
      fiber.childFiber = updateFiber(previous, vnode, fiber)
    } else {
      if (previous) unmountFiber(previous)
      fiber.childFiber = mountFiber(vnode, fiber)
    }
    if (fiber.instance && typeof fiber.instance.componentDidMount === 'function' && !fiber.instance.__mounted) {
      fiber.instance.__mounted = true
      fiber.instance.componentDidMount()
    }
  }

  function updateFiber(fiber, vnode, parent) {
    fiber.props = vnode.props
    fiber.parent = parent
    if (vnode.type === '#text') {
      if (fiber.dom.nodeValue !== vnode.text) fiber.dom.nodeValue = vnode.text
      return fiber
    }
    if (vnode.type === Fragment) {
      var previousFragmentChildren = fiber.childFibers
      fiber.childFibers = reconcileChildren(fiber, previousFragmentChildren, vnode.children)
      return fiber
    }
    if (typeof vnode.type === 'function') {
      if (fiber.instance) {
        fiber.instance.props = vnode.props
        var oldProps = fiber.instance.props
        renderComponent(fiber)
        if (typeof fiber.instance.componentDidUpdate === 'function') fiber.instance.componentDidUpdate(oldProps)
      } else {
        renderComponent(fiber)
      }
      return fiber
    }
    if (typeof vnode.type === 'string') {
      var oldProps = fiber.__oldProps || {}
      patchProps(fiber.dom, oldProps, vnode.props)
      fiber.__oldProps = vnode.props
      fiber.childFibers = reconcileChildren(fiber, fiber.childFibers, vnode.children)
      orderDomNodes(fiber.dom, fiber.childFibers)
      return fiber
    }
    throw new Error('fake-react: unsupported element type ' + String(vnode.type))
  }

  function reconcileChildren(parentFiber, oldFibers, childVNodes) {
    var newVNodes = []
    for (var i = 0; i < childVNodes.length; i += 1) {
      var vnode = normalizeChild(childVNodes[i])
      if (vnode) newVNodes.push(vnode)
    }
    var oldByKey = {}
    var oldUnkeyed = []
    for (var j = 0; j < oldFibers.length; j += 1) {
      var oldFiber = oldFibers[j]
      if (oldFiber.key !== null && oldFiber.key !== undefined) oldByKey['k:' + oldFiber.key] = oldFiber
      else oldUnkeyed.push(oldFiber)
    }
    var used = []
    var next = []
    for (var index = 0; index < newVNodes.length; index += 1) {
      var node = newVNodes[index]
      var match = null
      if (node.key !== null) {
        var keyedCandidate = oldByKey['k:' + node.key]
        if (keyedCandidate && !used[keyedCandidate.__id] && canReuse(keyedCandidate, node)) match = keyedCandidate
      } else {
        var candidate = oldUnkeyed[index]
        if (candidate && !used[candidate.__id] && canReuse(candidate, node)) match = candidate
      }
      if (match) used[match.__id] = true
      var child
      try {
        child = match ? updateFiber(match, node, parentFiber) : mountFiber(node, parentFiber)
      } catch (error) {
        handleRenderError(parentFiber, error)
        child = null
      }
      if (child) next.push(child)
    }
    for (var k = 0; k < oldFibers.length; k += 1) {
      var stale = oldFibers[k]
      if (!used[stale.__id]) unmountFiber(stale)
    }
    return next
  }

  var fiberId = 0
  var originalCreateFiber = createFiber

  // assign a stable id used for reconcile bookkeeping
  createFiber = function (vnode) {
    var fiber = originalCreateFiber(vnode)
    fiberId += 1
    fiber.__id = fiberId
    return fiber
  }

  function unmountFiber(fiber) {
    if (!fiber) return
    if (fiber.instance && typeof fiber.instance.componentWillUnmount === 'function') {
      try {
        fiber.instance.componentWillUnmount()
      } catch (error) {
        console.error('[fake-react] componentWillUnmount failed', error)
      }
    }
    runCleanups(fiber)
    if (fiber.childFiber) unmountFiber(fiber.childFiber)
    for (var i = 0; i < fiber.childFibers.length; i += 1) unmountFiber(fiber.childFibers[i])
    var dom = topDom(fiber)
    if (dom && dom.parentNode) dom.parentNode.removeChild(dom)
    fiber.dom = null
  }

  /* ------------------------------------------------------------------ *
   * Ordering DOM nodes, roots, effects, scheduling
   * ------------------------------------------------------------------ */

  function orderDomNodes(parentDom, fibers) {
    var wanted = []
    for (var i = 0; i < fibers.length; i += 1) {
      var dom = topDom(fibers[i])
      if (dom) wanted.push(dom)
    }
    var current = []
    for (var j = 0; j < parentDom.childNodes.length; j += 1) current.push(parentDom.childNodes[j])
    var position = 0
    for (var k = 0; k < wanted.length; k += 1) {
      var node = wanted[k]
      if (current[position] === node) {
        position += 1
        continue
      }
      var reference = wanted[k + 1] && wanted[k + 1].parentNode === parentDom ? wanted[k + 1] : null
      parentDom.insertBefore(node, reference)
      current = []
      for (var m = 0; m < parentDom.childNodes.length; m += 1) current.push(parentDom.childNodes[m])
      position = current.indexOf(node) + 1
    }
  }

  function renderRoot(root) {
    var element = root.element
    var vnode = normalizeChild(element)
    if (!vnode) {
      if (root.fiber) {
        unmountFiber(root.fiber)
        root.fiber = null
      }
      return
    }
    if (root.fiber && canReuse(root.fiber, vnode)) {
      root.fiber = updateFiber(root.fiber, vnode, null)
    } else {
      if (root.fiber) unmountFiber(root.fiber)
      root.fiber = mountFiber(vnode, null)
    }
    if (root.fiber) orderDomNodes(root.container, [root.fiber])
  }

  function runEffects() {
    var queue = effectQueue
    effectQueue = []
    for (var i = 0; i < queue.length; i += 1) {
      var item = queue[i]
      var hook = item.hook
      if (typeof hook.cleanup === 'function') {
        try {
          hook.cleanup()
        } catch (error) {
          console.error('[fake-react] effect cleanup failed', error)
        }
      }
      hook.cleanup = null
      try {
        var cleanup = item.create()
        if (typeof cleanup === 'function') hook.cleanup = cleanup
      } catch (error) {
        console.error('[fake-react] effect failed', error)
      }
    }
  }

  function flush(afterRender) {
    if (rendering) {
      pendingRender = true
      return
    }
    rendering = true
    try {
      var guard = 0
      do {
        pendingRender = false
        for (var i = 0; i < roots.length; i += 1) renderRoot(roots[i])
        runEffects()
        guard += 1
      } while (pendingRender && guard < 60)
      if (afterRender) afterRender()
    } finally {
      rendering = false
    }
  }

  function requestRender(callback) {
    pendingRender = true
    if (!rendering) flush(callback)
    else if (typeof callback === 'function') effectQueue.push({ hook: {}, create: callback })
  }

  function render(element, container) {
    var root = null
    for (var i = 0; i < roots.length; i += 1) {
      if (roots[i].container === container) root = roots[i]
    }
    if (!root) {
      root = { container: container, fiber: null, element: null }
      roots.push(root)
    }
    root.element = element
    pendingRender = true
    flush()
    return root
  }

  function unmountComponentAtNode(container) {
    for (var i = roots.length - 1; i >= 0; i -= 1) {
      if (roots[i].container === container) {
        if (roots[i].fiber) unmountFiber(roots[i].fiber)
        roots.splice(i, 1)
        return true
      }
    }
    return false
  }

  global.FakeReact = {
    createElement: createElement,
    createFactory: function (type) {
      return function () {
        return createElement.apply(null, [type].concat(Array.prototype.slice.call(arguments)))
      }
    },
    Fragment: Fragment,
    Component: Component,
    useState: useState,
    useRef: useRef,
    useEffect: useEffect,
    useLayoutEffect: useLayoutEffect,
    useCallback: useCallback,
    useMemo: useMemo,
    render: render,
    unmountComponentAtNode: unmountComponentAtNode,
    __roots: roots,
  }
})(typeof window !== 'undefined' ? window : globalThis)
