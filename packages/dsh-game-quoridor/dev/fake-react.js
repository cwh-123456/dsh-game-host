/*!
 * dev/fake-react.js — 极简 React 替身（仅 dev 预览用，不随包发布）
 * ---------------------------------------------------------------------------
 * 目的：`client.js` 是 DSH 浏览器侧模块，运行时通过 `require('react')` 拿 React。
 * 本文件用真实 DOM 实现一个够用的迷你 React，让 dev/preview.html 在没有宿主
 * 模块表的情况下也能真实渲染 client.js 注册的游戏组件。
 *
 * 支持（client.js 实际用到的 + 常用）：
 *   - createElement（含 key / ref / 嵌套 children / null / 数组 / 数字 / 字符串）
 *   - Component 类组件（state / setState / forceUpdate / componentDidMount /
 *     componentDidUpdate / componentWillUnmount / getDerivedStateFromProps /
 *     getDerivedStateFromError + componentDidCatch 错误边界）
 *   - Fragment
 *   - Hooks：useState / useReducer / useRef / useEffect（deps 数组 + cleanup）/
 *     useLayoutEffect / useCallback / useMemo
 *   - 真实 DOM：className / style 对象（camelCase → CSS + px + 自定义属性）/
 *     aria-* / data-* / role / 布尔属性 / value / disabled / tabIndex
 *   - 事件 props：onClick / onKeyDown / onMouseDown / onPointerDown / onChange /
 *     onInput ...（onChange 按 React 语义映射到 input/change）
 *   - ref：函数 ref / {current} 对象 ref / 类组件实例
 *   - setState 触发重新渲染；卸载或 deps 变化执行 effect cleanup
 *
 * 语义边界（够预览用，不是 React 完整实现）：
 *   - 同步渲染：setState 在事件处理器内批量，处理器结束后立即 reconcile；没有并发/调度优先级。
 *   - 每个函数组件必须返回 null / 单个元素 / 数组（数组会用锚点顺序维护，属实验性）。
 *   - ref 指向函数组件不产生实例（React 也会警告）；预览代码不依赖。
 *   - 不做 keyed 列表重排优化以外的 DOM 移动；reconcile 后按 key/type 复用节点。
 */
;(function (global) {
  'use strict'

  if (global.FakeReact) return

  var ELEMENT = typeof Symbol === 'function' ? Symbol('fakeReact.element') : '__fakeReactElement__'
  var TEXT = typeof Symbol === 'function' ? Symbol('fakeReact.text') : '__fakeReactText__'
  var Fragment = typeof Symbol === 'function' ? Symbol('fakeReact.fragment') : '__fakeReactFragment__'

  /* ------------------------------------------------------------------ *
   * 常量表
   * ------------------------------------------------------------------ */

  var UNITLESS = {
    animationIterationCount: 1,
    aspectRatio: 1,
    borderImageOutset: 1,
    borderImageSlice: 1,
    borderImageWidth: 1,
    boxFlex: 1,
    boxFlexGroup: 1,
    boxOrdinalGroup: 1,
    columnCount: 1,
    columns: 1,
    flex: 1,
    flexGrow: 1,
    flexPositive: 1,
    flexShrink: 1,
    flexNegative: 1,
    flexOrder: 1,
    gridArea: 1,
    gridRow: 1,
    gridRowEnd: 1,
    gridRowSpan: 1,
    gridRowStart: 1,
    gridColumn: 1,
    gridColumnEnd: 1,
    gridColumnSpan: 1,
    gridColumnStart: 1,
    fontWeight: 1,
    lineClamp: 1,
    lineHeight: 1,
    opacity: 1,
    order: 1,
    orphans: 1,
    scale: 1,
    tabSize: 1,
    widows: 1,
    zIndex: 1,
    zoom: 1,
    fillOpacity: 1,
    floodOpacity: 1,
    stopOpacity: 1,
    strokeDasharray: 1,
    strokeDashoffset: 1,
    strokeMiterlimit: 1,
    strokeOpacity: 1,
    strokeWidth: 1,
  }

  var ATTR_MAP = {
    htmlFor: 'for',
    tabIndex: 'tabindex',
    readOnly: 'readonly',
    maxLength: 'maxlength',
    minLength: 'minlength',
    autoComplete: 'autocomplete',
    autoFocus: 'autofocus',
    contentEditable: 'contenteditable',
    spellCheck: 'spellcheck',
    srcSet: 'srcset',
    crossOrigin: 'crossorigin',
    acceptCharset: 'accept-charset',
    formAction: 'formaction',
    useMap: 'usemap',
    frameBorder: 'frameborder',
    allowFullScreen: 'allowfullscreen',
    colSpan: 'colspan',
    rowSpan: 'rowspan',
    cellPadding: 'cellpadding',
    cellSpacing: 'cellspacing',
    dateTime: 'datetime',
    encType: 'enctype',
    noValidate: 'novalidate',
    charSet: 'charset',
    accessKey: 'accesskey',
    autoCapitalize: 'autocapitalize',
    inputMode: 'inputmode',
    enterKeyHint: 'enterkeyhint',
  }

  var BOOLEAN_PROPS = {
    disabled: 1,
    checked: 1,
    readOnly: 1,
    selected: 1,
    multiple: 1,
    hidden: 1,
    required: 1,
    autoFocus: 1,
    controls: 1,
    loop: 1,
    muted: 1,
    defaultChecked: 1,
    defaultSelected: 1,
    open: 1,
  }

  var PROP_SKIP = {
    children: 1,
    key: 1,
    ref: 1,
    style: 1,
    className: 1,
    dangerouslySetInnerHTML: 1,
  }

  var EMPTY_PROPS = {}

  /* ------------------------------------------------------------------ *
   * 渲染器状态
   * ------------------------------------------------------------------ */

  var root = null
  var currentFiber = null
  var hookIndex = 0
  var pendingEffects = []
  var pendingCommits = []
  var batching = 0
  var renderRequested = false
  var flushing = false

  function getDocument() {
    if (typeof document === 'undefined' || !document) {
      throw new Error('fake-react: document is unavailable')
    }
    return document
  }

  function reportError(error) {
    if (Array.isArray(global.__fakeReactErrors)) global.__fakeReactErrors.push(error)
    try {
      console.error('[fake-react]', error)
    } catch (ignored) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * createElement / vnode
   * ------------------------------------------------------------------ */

  function getKey(config) {
    if (!config) return null
    if (config.key !== undefined && config.key !== null) return String(config.key)
    return null
  }

  function createElement(type, config) {
    if (type === undefined || type === null) {
      throw new Error('fake-react: createElement(type) is required')
    }
    var props = {}
    var ref = null
    var key = getKey(config)
    if (config !== null && config !== undefined) {
      for (var name in config) {
        if (!Object.prototype.hasOwnProperty.call(config, name)) continue
        if (name === 'key') continue
        if (name === 'ref') {
          ref = config[name]
        } else if (name !== '__self' && name !== '__source') {
          props[name] = config[name]
        }
      }
    }
    var children = []
    for (var i = 2; i < arguments.length; i += 1) children.push(arguments[i])
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    if (type && type.defaultProps) {
      for (var propName in type.defaultProps) {
        if (props[propName] === undefined) props[propName] = type.defaultProps[propName]
      }
    }
    return {
      $$typeof: ELEMENT,
      type: type,
      key: key,
      ref: ref,
      props: props,
    }
  }

  function cloneElement(element, config) {
    if (!isElement(element)) throw new Error('fake-react: cloneElement expects a valid element')
    var props = {}
    var name
    for (name in element.props) props[name] = element.props[name]
    if (config) {
      for (name in config) {
        if (name === 'key' || name === 'ref') continue
        props[name] = config[name]
      }
    }
    var children = []
    for (var i = 2; i < arguments.length; i += 1) children.push(arguments[i])
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return createElement(
      element.type,
      Object.assign({}, config || {}, {
        key: config && config.key !== undefined ? config.key : element.key,
        ref: config && config.ref !== undefined ? config.ref : element.ref,
      }),
      children.length ? children : props.children,
    )
  }

  function isElement(value) {
    return value !== null && typeof value === 'object' && value.$$typeof === ELEMENT
  }

  function textVNode(value) {
    return { type: TEXT, key: null, text: String(value), props: {} }
  }

  function normalizeVNode(node) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') {
      return textVNode(node)
    }
    if (isElement(node)) {
      if (node.type === Fragment) return { type: Fragment, key: node.key, props: node.props }
      return node
    }
    throw new Error('fake-react: invalid child ' + Object.prototype.toString.call(node))
  }

  /** 把 children（可能嵌套数组 / null / 布尔 / Fragment）拍平成 vnode 数组。 */
  function normalizeChildren(children) {
    var out = []
    collectChildren(children, out)
    return out
  }

  function collectChildren(children, out) {
    if (children === null || children === undefined || children === false || children === true) return
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i += 1) collectChildren(children[i], out)
      return
    }
    if (isElement(children) && children.type === Fragment) {
      collectChildren(children.props.children, out)
      return
    }
    if (isElement(children) && children.type === Fragment) return
    var vnode = normalizeVNode(children)
    if (vnode) out.push(vnode)
  }

  function typeKind(type) {
    if (type === TEXT) return 'text'
    if (type === Fragment) return 'fragment'
    if (typeof type === 'string') return 'host'
    if (typeof type === 'function') {
      return type.prototype && typeof type.prototype.render === 'function' ? 'class' : 'function'
    }
    return 'invalid'
  }

  /* ------------------------------------------------------------------ *
   * DOM props / style / 事件 / ref
   * ------------------------------------------------------------------ */

  function isEventProp(name) {
    return typeof name === 'string' && name.length > 2 && name[0] === 'o' && name[1] === 'n' &&
      name[2] === name[2].toUpperCase()
  }

  function eventTypeFor(propName, dom) {
    var name = propName.slice(2)
    if (name === 'Change') {
      var tag = dom.nodeName ? String(dom.nodeName).toLowerCase() : ''
      if (tag === 'select') return 'change'
      if (tag === 'input') {
        var type = String(dom.getAttribute('type') || 'text').toLowerCase()
        if (type === 'checkbox' || type === 'radio' || type === 'file') return 'change'
      }
      return 'input'
    }
    if (name === 'DoubleClick') return 'dblclick'
    return name.toLowerCase()
  }

  function addDomEvent(dom, propName) {
    var type = eventTypeFor(propName, dom)
    if (!type) return
    if (!dom.__fakeListeners) dom.__fakeListeners = {}
    if (dom.__fakeListeners[propName]) removeDomEvent(dom, propName)
    var wrapper = function (event) {
      var props = dom.__fakeProps
      var handler = props && props[propName]
      if (typeof handler !== 'function') return
      batching += 1
      try {
        handler(event)
      } finally {
        batching -= 1
        if (batching === 0) flushRender()
      }
    }
    dom.__fakeListeners[propName] = { type: type, wrapper: wrapper }
    dom.addEventListener(type, wrapper)
  }

  function removeDomEvent(dom, propName) {
    if (!dom.__fakeListeners || !dom.__fakeListeners[propName]) return
    var record = dom.__fakeListeners[propName]
    dom.removeEventListener(record.type, record.wrapper)
    delete dom.__fakeListeners[propName]
  }

  function setRef(ref, value) {
    if (typeof ref === 'function') ref(value)
    else if (ref !== null && typeof ref === 'object') ref.current = value
  }

  function styleName(name) {
    if (name.indexOf('--') === 0) return name
    return name.replace(/[A-Z]/g, function (match) {
      return '-' + match.toLowerCase()
    })
  }

  function styleValue(name, value) {
    if (value === null || value === undefined || value === false) return ''
    if (typeof value === 'number') {
      if (UNITLESS[name]) return String(value)
      return value === 0 ? '0px' : value + 'px'
    }
    return String(value)
  }

  function applyStyle(dom, oldStyle, newStyle) {
    if (newStyle === oldStyle) return
    if (typeof newStyle === 'string') {
      dom.style.cssText = newStyle
      return
    }
    oldStyle = oldStyle && typeof oldStyle === 'object' ? oldStyle : EMPTY_PROPS
    newStyle = newStyle && typeof newStyle === 'object' ? newStyle : EMPTY_PROPS
    var name
    for (name in oldStyle) {
      if (!Object.prototype.hasOwnProperty.call(oldStyle, name)) continue
      if (!Object.prototype.hasOwnProperty.call(newStyle, name)) {
        dom.style.removeProperty(styleName(name))
      }
    }
    for (name in newStyle) {
      if (!Object.prototype.hasOwnProperty.call(newStyle, name)) continue
      var value = newStyle[name]
      if (oldStyle[name] === value) continue
      var css = styleName(name)
      var text = styleValue(name, value)
      if (text === '') dom.style.removeProperty(css)
      else dom.style.setProperty(css, text)
    }
  }

  function applyClassName(dom, value) {
    if (value === null || value === undefined || value === false) {
      dom.removeAttribute('class')
      return
    }
    var text = String(value)
    if (dom.getAttribute('class') !== text) dom.setAttribute('class', text)
  }

  function setDomProp(dom, name, value) {
    if (name === 'value') {
      var next = value === null || value === undefined ? '' : String(value)
      if (dom.value !== next) dom.value = next
      return
    }
    if (name === 'checked' || name === 'selected') {
      dom[name] = !!value
      return
    }
    if (name === 'dangerouslySetInnerHTML') return
    if (name.indexOf('aria-') === 0 || name.indexOf('data-') === 0) {
      if (value === null || value === undefined) dom.removeAttribute(name)
      else dom.setAttribute(name, String(value))
      return
    }
    var attr = ATTR_MAP[name] || name.toLowerCase()
    if (value === null || value === undefined || value === false) {
      if (BOOLEAN_PROPS[name]) {
        try {
          dom[name] = false
        } catch (ignored) {
          /* ignore */
        }
      }
      dom.removeAttribute(attr)
      return
    }
    if (value === true) {
      if (BOOLEAN_PROPS[name]) {
        try {
          dom[name] = true
        } catch (ignored) {
          /* ignore */
        }
      }
      dom.setAttribute(attr, '')
      return
    }
    if (BOOLEAN_PROPS[name]) {
      try {
        dom[name] = !!value
      } catch (ignored) {
        /* ignore */
      }
    }
    if (name === 'tabIndex') {
      dom.setAttribute('tabindex', String(value))
      return
    }
    dom.setAttribute(attr, String(value))
  }

  function applyDomProps(dom, oldProps, newProps) {
    oldProps = oldProps || EMPTY_PROPS
    newProps = newProps || EMPTY_PROPS
    var name

    if (oldProps.style !== newProps.style) applyStyle(dom, oldProps.style, newProps.style)
    if (oldProps.className !== newProps.className) applyClassName(dom, newProps.className)

    if (newProps.dangerouslySetInnerHTML) {
      var html = newProps.dangerouslySetInnerHTML.__html
      var oldHtml = oldProps.dangerouslySetInnerHTML ? oldProps.dangerouslySetInnerHTML.__html : undefined
      if (oldHtml !== html) dom.innerHTML = html === null || html === undefined ? '' : String(html)
    }

    for (name in oldProps) {
      if (!Object.prototype.hasOwnProperty.call(oldProps, name)) continue
      if (PROP_SKIP[name] || isEventProp(name)) continue
      if (!Object.prototype.hasOwnProperty.call(newProps, name)) setDomProp(dom, name, undefined)
    }
    for (name in newProps) {
      if (!Object.prototype.hasOwnProperty.call(newProps, name)) continue
      if (PROP_SKIP[name] || isEventProp(name)) continue
      if (Object.prototype.hasOwnProperty.call(oldProps, name) && oldProps[name] === newProps[name]) continue
      setDomProp(dom, name, newProps[name])
    }

    for (name in oldProps) {
      if (!Object.prototype.hasOwnProperty.call(oldProps, name)) continue
      if (!isEventProp(name)) continue
      if (!Object.prototype.hasOwnProperty.call(newProps, name)) removeDomEvent(dom, name)
    }
    for (name in newProps) {
      if (!Object.prototype.hasOwnProperty.call(newProps, name)) continue
      if (!isEventProp(name)) continue
      var nextHandler = newProps[name]
      var hadHandler = Object.prototype.hasOwnProperty.call(oldProps, name) &&
        typeof oldProps[name] === 'function'
      if (typeof nextHandler === 'function' && !hadHandler) addDomEvent(dom, name)
      else if (typeof nextHandler !== 'function' && hadHandler) removeDomEvent(dom, name)
    }

    dom.__fakeProps = newProps
  }

  /* ------------------------------------------------------------------ *
   * Hooks
   * ------------------------------------------------------------------ */

  function depsEqual(previous, next) {
    if (previous === undefined || next === undefined) return false
    if (!Array.isArray(previous) || !Array.isArray(next)) return false
    if (previous.length !== next.length) return false
    for (var i = 0; i < previous.length; i += 1) {
      if (!Object.is(previous[i], next[i])) return false
    }
    return true
  }

  function getHook() {
    if (!currentFiber) {
      throw new Error('fake-react: hooks can only be called inside a function component')
    }
    var fiber = currentFiber
    var index = hookIndex
    hookIndex += 1
    if (!fiber.hooks) fiber.hooks = []
    if (!fiber.hooks[index]) fiber.hooks[index] = {}
    return { fiber: fiber, hook: fiber.hooks[index], index: index }
  }

  function useState(initial) {
    var slot = getHook()
    var hook = slot.hook
    if (!hook.hasState) {
      hook.hasState = true
      hook.state = typeof initial === 'function' ? initial() : initial
    }
    if (!hook.setState) {
      hook.setState = function (action) {
        var next = typeof action === 'function' ? action(hook.state) : action
        if (Object.is(next, hook.state)) return
        hook.state = next
        scheduleUpdate()
      }
    }
    return [hook.state, hook.setState]
  }

  function useReducer(reducer, initialArg, init) {
    var slot = getHook()
    var hook = slot.hook
    if (!hook.hasState) {
      hook.hasState = true
      hook.state = init !== undefined ? init(initialArg) : initialArg
    }
    if (!hook.dispatch) {
      hook.dispatch = function (action) {
        var next = reducer(hook.state, action)
        if (Object.is(next, hook.state)) return
        hook.state = next
        scheduleUpdate()
      }
    }
    return [hook.state, hook.dispatch]
  }

  function useRef(initial) {
    var slot = getHook()
    if (!('ref' in slot.hook)) slot.hook.ref = { current: initial }
    return slot.hook.ref
  }

  function useMemo(factory, deps) {
    var slot = getHook()
    var hook = slot.hook
    var changed = deps === undefined || deps === null || !hook.memoDeps || !depsEqual(hook.memoDeps, deps)
    if (changed) {
      hook.memoValue = factory()
      hook.memoDeps = deps === undefined || deps === null ? undefined : deps.slice()
    }
    return hook.memoValue
  }

  function useCallback(callback, deps) {
    var slot = getHook()
    var hook = slot.hook
    var changed = deps === undefined || deps === null || !hook.callbackDeps || !depsEqual(hook.callbackDeps, deps)
    if (changed) {
      hook.callbackValue = callback
      hook.callbackDeps = deps === undefined || deps === null ? undefined : deps.slice()
    }
    return hook.callbackValue
  }

  function useEffect(create, deps) {
    var slot = getHook()
    var hook = slot.hook
    var changed = true
    if (deps !== undefined && deps !== null) {
      changed = hook.deps === undefined || !depsEqual(hook.deps, deps)
    }
    hook.deps = deps === undefined || deps === null ? undefined : deps.slice()
    if (changed) {
      var fiber = slot.fiber
      if (!fiber.__effects) fiber.__effects = []
      fiber.__effects.push({ fiber: fiber, hook: hook, create: create })
    }
  }

  function useLayoutEffect(create, deps) {
    useEffect(create, deps)
  }

  function flushFiberEffects(fiber) {
    var effects = fiber.__effects
    if (!effects || effects.length === 0) return
    fiber.__effects = []
    for (var i = 0; i < effects.length; i += 1) pendingEffects.push(effects[i])
  }

  function teardownHooks(fiber) {
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

  /* ------------------------------------------------------------------ *
   * Component 基类
   * ------------------------------------------------------------------ */

  function Component(props) {
    this.props = props
    this.state = null
    this.__fiber = null
  }
  Component.prototype.isReactComponent = {}
  Component.prototype.setState = function (partial, callback) {
    var fiber = this.__fiber
    if (!fiber) return
    var next = typeof partial === 'function' ? partial.call(this, this.state, this.props) : partial
    if (next !== null && next !== undefined) this.state = Object.assign({}, this.state, next)
    if (typeof callback === 'function') pendingCommits.push({ fiber: fiber, run: callback })
    scheduleUpdate()
  }
  Component.prototype.forceUpdate = function (callback) {
    var fiber = this.__fiber
    if (!fiber) return
    if (typeof callback === 'function') pendingCommits.push({ fiber: fiber, run: callback })
    scheduleUpdate()
  }

  function fiberRefValue(fiber) {
    if (fiber.kind === 'host' || fiber.kind === 'text') return fiber.dom
    if (fiber.kind === 'class') return fiber.inst
    return null
  }

  function updateFiberRef(fiber, nextRef) {
    var previousRef = fiber.ref
    if (previousRef === nextRef) {
      if (nextRef !== null && nextRef !== undefined && fiber.__refValue === undefined && fiber.kind !== 'function') {
        var currentValue = fiberRefValue(fiber)
        fiber.__refValue = currentValue
        setRef(nextRef, currentValue)
      }
      return
    }
    if (previousRef !== null && previousRef !== undefined) setRef(previousRef, null)
    fiber.ref = nextRef
    fiber.__refValue = undefined
    if (nextRef !== null && nextRef !== undefined && fiber.kind !== 'function') {
      var value = fiberRefValue(fiber)
      fiber.__refValue = value
      setRef(nextRef, value)
    }
  }

  /* ------------------------------------------------------------------ *
   * 挂载 / 更新 / 卸载
   * ------------------------------------------------------------------ */

  function scheduleUpdate() {
    if (!root) return
    renderRequested = true
    if (batching > 0 || flushing) return
    flushRender()
  }

  function unmountChildren(fiber) {
    var children = fiber.childFibers || []
    for (var i = 0; i < children.length; i += 1) unmountFiber(children[i])
    fiber.childFibers = []
  }

  function removeNode(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node)
  }

  function unmountFiber(fiber) {
    if (!fiber || fiber.unmounted) return
    fiber.unmounted = true
    fiber.mounted = false
    if (fiber.kind === 'text') {
      removeNode(fiber.dom)
      return
    }
    if (fiber.kind === 'host') {
      unmountChildren(fiber)
      if (fiber.ref !== null && fiber.ref !== undefined) setRef(fiber.ref, null)
      fiber.__refValue = undefined
      removeNode(fiber.dom)
      return
    }
    if (fiber.kind === 'class' && fiber.inst && typeof fiber.inst.componentWillUnmount === 'function') {
      try {
        fiber.inst.componentWillUnmount()
      } catch (error) {
        reportError(error)
      }
    }
    teardownHooks(fiber)
    unmountChildren(fiber)
    if (fiber.ref !== null && fiber.ref !== undefined) setRef(fiber.ref, null)
    fiber.__refValue = undefined
  }

  function mountText(vnode, parentDom) {
    var dom = getDocument().createTextNode(vnode.text)
    parentDom.appendChild(dom)
    return { kind: 'text', type: TEXT, vnode: vnode, key: vnode.key, dom: dom, mounted: true, hooks: [], childFibers: [] }
  }

  function mountHost(vnode, parentDom) {
    var dom = getDocument().createElement(vnode.type)
    var fiber = {
      kind: 'host',
      type: vnode.type,
      vnode: vnode,
      key: vnode.key,
      dom: dom,
      ref: undefined,
      mounted: true,
      hooks: [],
      childFibers: [],
    }
    applyDomProps(dom, EMPTY_PROPS, vnode.props)
    if (!vnode.props.dangerouslySetInnerHTML) {
      fiber.childFibers = reconcileChildrenList(dom, [], normalizeChildren(vnode.props.children), true)
    }
    parentDom.appendChild(dom)
    updateFiberRef(fiber, vnode.ref)
    return fiber
  }

  function updateText(fiber, vnode) {
    fiber.vnode = vnode
    if (fiber.dom.nodeValue !== vnode.text) fiber.dom.nodeValue = vnode.text
    return fiber
  }

  function updateHost(fiber, vnode) {
    var oldProps = fiber.vnode.props
    fiber.vnode = vnode
    fiber.key = vnode.key
    var dom = fiber.dom
    applyDomProps(dom, oldProps, vnode.props)
    if (vnode.props.dangerouslySetInnerHTML) {
      if (!oldProps.dangerouslySetInnerHTML) unmountChildren(fiber)
    } else {
      fiber.childFibers = reconcileChildrenList(dom, fiber.childFibers, normalizeChildren(vnode.props.children), true)
    }
    updateFiberRef(fiber, vnode.ref)
    return fiber
  }

  function applyDerivedState(fiber) {
    var type = fiber.type
    var inst = fiber.inst
    if (!type || typeof type.getDerivedStateFromProps !== 'function') return
    var derived = type.getDerivedStateFromProps(inst.props, inst.state)
    if (derived !== null && derived !== undefined) inst.state = Object.assign({}, inst.state, derived)
  }

  function renderClass(fiber, parentDom) {
    var inst = fiber.inst
    var type = fiber.type
    var retried = false
    for (;;) {
      try {
        var output = inst.render()
        fiber.childFibers = reconcileChildrenList(parentDom, fiber.childFibers, normalizeChildren([output]), false)
        return
      } catch (error) {
        if (!retried && type && typeof type.getDerivedStateFromError === 'function') {
          retried = true
          var derived = type.getDerivedStateFromError(error)
          if (derived !== null && derived !== undefined) inst.state = Object.assign({}, inst.state, derived)
          var captured = error
          pendingCommits.push({
            fiber: fiber,
            run: function () {
              if (typeof inst.componentDidCatch === 'function') {
                inst.componentDidCatch(captured, { componentStack: '' })
              }
            },
          })
          continue
        }
        throw error
      }
    }
  }

  function mountClass(vnode, parentDom) {
    var type = vnode.type
    var inst = new type(vnode.props)
    if (inst.state === undefined) inst.state = null
    inst.props = vnode.props
    var fiber = {
      kind: 'class',
      type: type,
      vnode: vnode,
      key: vnode.key,
      props: vnode.props,
      inst: inst,
      ref: undefined,
      mounted: true,
      hooks: [],
      childFibers: [],
    }
    inst.__fiber = fiber
    applyDerivedState(fiber)
    renderClass(fiber, parentDom)
    updateFiberRef(fiber, vnode.ref)
    pendingCommits.push({
      fiber: fiber,
      run: function () {
        if (typeof inst.componentDidMount === 'function') inst.componentDidMount()
      },
    })
    return fiber
  }

  function updateClass(fiber, vnode, parentDom) {
    var inst = fiber.inst
    var prevProps = inst.props
    var prevState = inst.state
    fiber.vnode = vnode
    fiber.key = vnode.key
    inst.props = vnode.props
    fiber.props = vnode.props
    applyDerivedState(fiber)
    var snapshot
    if (typeof inst.getSnapshotBeforeUpdate === 'function') {
      snapshot = inst.getSnapshotBeforeUpdate(prevProps, prevState)
    }
    renderClass(fiber, parentDom)
    updateFiberRef(fiber, vnode.ref)
    pendingCommits.push({
      fiber: fiber,
      run: function () {
        if (typeof inst.componentDidUpdate === 'function') {
          inst.componentDidUpdate(prevProps, prevState, snapshot)
        }
      },
    })
    return fiber
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
    fiber.childFibers = reconcileChildrenList(parentDom, fiber.childFibers, normalizeChildren([output]), false)
    flushFiberEffects(fiber)
  }

  function mountFunction(vnode, parentDom) {
    var fiber = {
      kind: 'function',
      type: vnode.type,
      vnode: vnode,
      key: vnode.key,
      props: vnode.props,
      ref: undefined,
      mounted: true,
      hooks: [],
      childFibers: [],
    }
    renderFunction(fiber, parentDom)
    updateFiberRef(fiber, vnode.ref)
    return fiber
  }

  function mountFiber(vnode, parentDom) {
    var kind = typeKind(vnode.type)
    if (kind === 'text') return mountText(vnode, parentDom)
    if (kind === 'host') return mountHost(vnode, parentDom)
    if (kind === 'class') return mountClass(vnode, parentDom)
    if (kind === 'function') return mountFunction(vnode, parentDom)
    throw new Error('fake-react: unsupported element type ' + String(vnode.type))
  }

  function canReuseFiber(fiber, vnode) {
    if (!fiber || fiber.unmounted) return false
    return fiber.type === vnode.type
  }

  function updateFiber(fiber, vnode, parentDom) {
    if (fiber.kind === 'text') return updateText(fiber, vnode)
    if (fiber.kind === 'host') return updateHost(fiber, vnode)
    if (fiber.kind === 'class') return updateClass(fiber, vnode, parentDom)
    if (fiber.kind === 'function') {
      var prevProps = fiber.props
      fiber.vnode = vnode
      fiber.key = vnode.key
      fiber.props = vnode.props
      renderFunction(fiber, parentDom)
      updateFiberRef(fiber, vnode.ref)
      return fiber
    }
    if (fiber.kind === 'text') return updateText(fiber, vnode)
    throw new Error('fake-react: cannot update fiber kind ' + fiber.kind)
  }

  /* ------------------------------------------------------------------ *
   * 子节点 reconcile + DOM 顺序维护
   * ------------------------------------------------------------------ */

  function collectTopDom(fiber, out) {
    if (!fiber) return
    if (fiber.kind === 'host' || fiber.kind === 'text') {
      out.push(fiber.dom)
      return
    }
    var children = fiber.childFibers || []
    for (var i = 0; i < children.length; i += 1) collectTopDom(children[i], out)
  }

  function repairDomOrder(parentDom, fibers) {
    var nodes = []
    for (var i = 0; i < fibers.length; i += 1) collectTopDom(fibers[i], nodes)
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

  function reconcileChildrenList(parentDom, oldFibers, vnodes, repairOrder) {
    oldFibers = oldFibers || []
    var keyed = {}
    var unkeyed = []
    var i
    for (i = 0; i < oldFibers.length; i += 1) {
      var oldFiber = oldFibers[i]
      if (!oldFiber || oldFiber.unmounted) continue
      if (oldFiber.key === null || oldFiber.key === undefined) unkeyed.push(oldFiber)
      else keyed[oldFiber.key] = oldFiber
    }
    var consumed = new Set()
    var unkeyedCursor = 0
    var result = []
    for (i = 0; i < vnodes.length; i += 1) {
      var vnode = vnodes[i]
      var candidate = null
      if (vnode.key !== null && vnode.key !== undefined) {
        candidate = keyed[vnode.key] || null
        if (candidate && consumed.has(candidate)) candidate = null
      } else {
        while (unkeyedCursor < unkeyed.length && consumed.has(unkeyed[unkeyedCursor])) unkeyedCursor += 1
        candidate = unkeyedCursor < unkeyed.length ? unkeyed[unkeyedCursor] : null
        unkeyedCursor += 1
      }
      if (candidate) consumed.add(candidate)
      if (candidate && canReuseFiber(candidate, vnode)) {
        result.push(updateFiber(candidate, vnode, parentDom))
      } else {
        if (candidate) unmountFiber(candidate)
        result.push(mountFiber(vnode, parentDom))
      }
    }
    for (i = 0; i < oldFibers.length; i += 1) {
      var fiber = oldFibers[i]
      if (fiber && !consumed.has(fiber)) unmountFiber(fiber)
    }
    if (repairOrder) repairDomOrder(parentDom, result)
    return result
  }

  /* ------------------------------------------------------------------ *
   * 提交阶段（effect / 生命周期）
   * ------------------------------------------------------------------ */

  function runPendingCommit() {
    var commits = pendingCommits
    pendingCommits = []
    for (var i = 0; i < commits.length; i += 1) {
      var commit = commits[i]
      if (!commit.fiber || !commit.fiber.mounted) continue
      try {
        commit.run()
      } catch (error) {
        reportError(error)
      }
    }
    var effects = pendingEffects
    pendingEffects = []
    for (var j = 0; j < effects.length; j += 1) {
      var effect = effects[j]
      if (!effect.fiber || !effect.fiber.mounted) continue
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

  /* ------------------------------------------------------------------ *
   * 根渲染
   * ------------------------------------------------------------------ */

  function flushRender() {
    if (flushing) {
      renderRequested = true
      return
    }
    flushing = true
    var guard = 0
    try {
      while (renderRequested && root && guard < 100) {
        guard += 1
        renderRequested = false
        var container = root.container
        var vnodes = normalizeChildren([root.element])
        root.fiber.childFibers = reconcileChildrenList(container, root.fiber.childFibers, vnodes, true)
        runPendingCommit()
      }
      if (guard >= 100) reportError(new Error('fake-react: render loop did not settle'))
    } finally {
      flushing = false
    }
  }

  function render(element, container) {
    if (!container) throw new Error('fake-react: render(element, container) needs a container')
    if (root && root.container === container) {
      root.element = element
      renderRequested = true
      flushRender()
      return
    }
    if (root) unmountRoot()
    root = {
      container: container,
      element: element,
      fiber: { kind: 'root', childFibers: [], hooks: [], mounted: true, __effects: [] },
    }
    renderRequested = true
    flushRender()
  }

  function unmountRoot() {
    if (!root) return
    var fiber = root.fiber
    fiber.mounted = false
    unmountChildren(fiber)
    pendingEffects = []
    pendingCommits = []
    root = null
  }

  function unmountComponentAtNode(container) {
    if (!root || root.container !== container) return false
    unmountRoot()
    return true
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  var FakeReact = {
    createElement: createElement,
    cloneElement: cloneElement,
    isValidElement: isElement,
    Component: Component,
    Fragment: Fragment,
    createRef: function () {
      return { current: null }
    },
    useRef: useRef,
    useState: useState,
    useReducer: useReducer,
    useEffect: useEffect,
    useLayoutEffect: useLayoutEffect,
    useCallback: useCallback,
    useMemo: useMemo,
    render: render,
    unmountComponentAtNode: unmountComponentAtNode,
    __version: 'fake-react 1.0 (dev only)',
    __debug: {
      getRoot: function () {
        return root
      },
      isFlushing: function () {
        return flushing
      },
    },
  }

  global.FakeReact = FakeReact
})(typeof window !== 'undefined' ? window : globalThis)
