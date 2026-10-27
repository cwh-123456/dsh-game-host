/**
 * dev/fake-react.js — minimal React stand-in for the dev preview + contract tests.
 * Dev-only: NOT listed in package.json `files`, never shipped.
 *
 * Only the tiny subset client.js actually uses is implemented:
 *   createElement, Fragment, Component (setState), useRef, useEffect,
 *   useMemo, useCallback, useState, render, unmountComponentAtNode.
 *
 * Semantics are intentionally simple (full remount on setState); the real host
 * uses React 18. This shim exists so dev/preview.html can render the registered
 * Game component without the DSH module table.
 */
;(function (global) {
  'use strict'

  if (global.FakeReact) return

  var ELEMENT = typeof Symbol === 'function' ? Symbol.for('fake.react.element') : '__fake_react_element__'
  var FRAGMENT = typeof Symbol === 'function' ? Symbol.for('fake.react.fragment') : '__fake_react_fragment__'
  var UNITLESS = {
    opacity: 1,
    zIndex: 1,
    fontWeight: 1,
    lineHeight: 1,
    flex: 1,
    flexGrow: 1,
    flexShrink: 1,
    order: 1,
    zoom: 1,
  }

  var root = null
  var currentFiber = null
  var hookIndex = 0
  var pendingEffects = []
  var cleanups = []

  function createElement(type, config) {
    var props = {}
    var key = null
    var ref = null
    if (config) {
      for (var name in config) {
        if (!Object.prototype.hasOwnProperty.call(config, name)) continue
        if (name === 'key') {
          key = config[name]
          continue
        }
        if (name === 'ref') {
          ref = config[name]
          continue
        }
        props[name] = config[name]
      }
    }
    var children = []
    for (var i = 2; i < arguments.length; i += 1) children.push(arguments[i])
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return { $$typeof: ELEMENT, type: type, key: key, ref: ref, props: props }
  }

  function isElement(value) {
    return value !== null && typeof value === 'object' && value.$$typeof === ELEMENT
  }

  function flattenChildren(children, out) {
    if (children === null || children === undefined || children === false || children === true) return
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i += 1) flattenChildren(children[i], out)
      return
    }
    if (isElement(children) && children.type === FRAGMENT) {
      flattenChildren(children.props.children, out)
      return
    }
    out.push(children)
  }

  function styleName(name) {
    if (name.indexOf('--') === 0) return name
    return name.replace(/[A-Z]/g, function (match) {
      return '-' + match.toLowerCase()
    })
  }

  function styleValue(name, value) {
    if (value === null || value === undefined || value === false) return ''
    if (typeof value === 'number') return UNITLESS[name] ? String(value) : value + 'px'
    return String(value)
  }

  function applyStyle(dom, style) {
    if (!style) return
    if (typeof style === 'string') {
      dom.style.cssText = style
      return
    }
    for (var name in style) {
      if (!Object.prototype.hasOwnProperty.call(style, name)) continue
      var value = styleValue(name, style[name])
      var css = styleName(name)
      if (value === '') {
        if (dom.style.removeProperty) dom.style.removeProperty(css)
      } else if (css.indexOf('--') === 0 && dom.style.setProperty) {
        dom.style.setProperty(css, value)
      } else {
        dom.style[css] = value
      }
    }
  }

  function applyProps(dom, props) {
    var name
    for (name in props) {
      if (!Object.prototype.hasOwnProperty.call(props, name)) continue
      var value = props[name]
      if (name === 'children' || name === 'key' || name === 'ref') continue
      if (name === 'style') {
        applyStyle(dom, value)
        continue
      }
      if (name === 'className') {
        if (value === null || value === undefined || value === false) dom.removeAttribute('class')
        else dom.setAttribute('class', String(value))
        continue
      }
      if (name === 'textContent' || name === 'innerText') {
        dom.textContent = value === null || value === undefined ? '' : String(value)
        continue
      }
      if (name === 'dangerouslySetInnerHTML') {
        if (value && value.__html !== undefined) dom.innerHTML = String(value.__html)
        continue
      }
      if (typeof value === 'function' && name.length > 2 && name.charAt(0) === 'o' && name.charAt(1) === 'n') {
        var eventName = name.slice(2).toLowerCase()
        if (eventName === 'doubleclick') eventName = 'dblclick'
        dom.addEventListener(eventName, value)
        continue
      }
      if (name === 'tabIndex') {
        dom.setAttribute('tabindex', String(value))
        continue
      }
      if (name === 'value' || name === 'checked' || name === 'selected' || name === 'disabled') {
        try {
          dom[name] = value
        } catch (ignored) {
          /* ignore */
        }
        continue
      }
      if (value === null || value === undefined || value === false) {
        dom.removeAttribute(name)
        continue
      }
      if (value === true) {
        dom.setAttribute(name, '')
        continue
      }
      dom.setAttribute(name, String(value))
    }
  }

  function setRef(ref, value) {
    if (typeof ref === 'function') ref(value)
    else if (ref && typeof ref === 'object') ref.current = value
  }

  function typeKind(type) {
    if (type === FRAGMENT) return 'fragment'
    if (typeof type === 'string') return 'host'
    if (typeof type === 'function') {
      return type.prototype && typeof type.prototype.render === 'function' ? 'class' : 'function'
    }
    return 'invalid'
  }

  function getHook() {
    if (!currentFiber) throw new Error('fake-react: hooks can only be used inside a component')
    var fiber = currentFiber
    var index = hookIndex
    hookIndex += 1
    if (!fiber.hooks[index]) fiber.hooks[index] = {}
    return { fiber: fiber, hook: fiber.hooks[index] }
  }

  function depsEqual(previous, next) {
    if (previous === undefined || next === undefined) return false
    if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) return false
    for (var i = 0; i < previous.length; i += 1) if (!Object.is(previous[i], next[i])) return false
    return true
  }

  function useRef(initial) {
    var slot = getHook()
    if (!('ref' in slot.hook)) slot.hook.ref = { current: initial }
    return slot.hook.ref
  }

  function useEffect(create, deps) {
    var slot = getHook()
    var changed = deps === undefined || deps === null || !slot.hook.deps || !depsEqual(slot.hook.deps, deps)
    if (!changed) return
    slot.hook.deps = deps ? deps.slice() : undefined
    pendingEffects.push({ hook: slot.hook, create: create })
  }

  function useMemo(factory, deps) {
    var slot = getHook()
    if (!slot.hook.memo || !deps || !depsEqual(slot.hook.memoDeps, deps)) {
      slot.hook.memo = factory()
      slot.hook.memoDeps = deps ? deps.slice() : undefined
    }
    return slot.hook.memo
  }

  function useCallback(callback, deps) {
    return useMemo(function () {
      return callback
    }, deps)
  }

  function useState(initial) {
    var slot = getHook()
    if (!('state' in slot.hook)) slot.hook.state = typeof initial === 'function' ? initial() : initial
    if (!slot.hook.setState) {
      slot.hook.setState = function (action) {
        var next = typeof action === 'function' ? action(slot.hook.state) : action
        if (Object.is(next, slot.hook.state)) return
        slot.hook.state = next
        remount()
      }
    }
    return [slot.hook.state, slot.hook.setState]
  }

  function Component(props) {
    this.props = props
    this.state = null
  }
  Component.prototype.setState = function (partial) {
    var next = typeof partial === 'function' ? partial(this.state, this.props) : partial
    if (next) this.state = Object.assign({}, this.state, next)
    remount()
  }

  function mountVNode(vnode, parent) {
    if (vnode === null || vnode === undefined || vnode === false || vnode === true) return
    if (typeof vnode === 'string' || typeof vnode === 'number') {
      parent.appendChild(document.createTextNode(String(vnode)))
      return
    }
    if (!isElement(vnode)) throw new Error('fake-react: invalid child')
    var kind = typeKind(vnode.type)
    if (kind === 'fragment') {
      var fragmentChildren = []
      flattenChildren(vnode.props.children, fragmentChildren)
      for (var f = 0; f < fragmentChildren.length; f += 1) mountVNode(fragmentChildren[f], parent)
      return
    }
    if (kind === 'host') {
      var dom = document.createElement(vnode.type)
      applyProps(dom, vnode.props)
      var hostChildren = []
      flattenChildren(vnode.props.children, hostChildren)
      for (var h = 0; h < hostChildren.length; h += 1) mountVNode(hostChildren[h], dom)
      parent.appendChild(dom)
      setRef(vnode.ref, dom)
      return
    }
    if (kind === 'class') {
      var inst = new vnode.type(vnode.props)
      var classFiber = { hooks: [], kind: 'class', instance: inst }
      inst.__fakeFiber = classFiber
      var previousFiber = currentFiber
      var previousHook = hookIndex
      currentFiber = classFiber
      hookIndex = 0
      var output
      try {
        output = inst.render()
      } finally {
        currentFiber = previousFiber
        hookIndex = previousHook
      }
      var classChildren = []
      flattenChildren(output, classChildren)
      for (var c = 0; c < classChildren.length; c += 1) mountVNode(classChildren[c], parent)
      setRef(vnode.ref, inst)
      return
    }
    if (kind === 'function') {
      var fiber = { hooks: [], kind: 'function' }
      var prevFiber = currentFiber
      var prevIndex = hookIndex
      currentFiber = fiber
      hookIndex = 0
      var result
      try {
        result = vnode.type(vnode.props)
      } finally {
        currentFiber = prevFiber
        hookIndex = prevIndex
      }
      var children = []
      flattenChildren(result, children)
      for (var k = 0; k < children.length; k += 1) mountVNode(children[k], parent)
      return
    }
    throw new Error('fake-react: unsupported element type ' + String(vnode.type))
  }

  function runEffects() {
    var effects = pendingEffects
    pendingEffects = []
    for (var i = 0; i < effects.length; i += 1) {
      var effect = effects[i]
      try {
        var cleanup = effect.create()
        if (typeof cleanup === 'function') {
          effect.hook.cleanup = cleanup
          cleanups.push(effect.hook)
        }
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) console.error('[fake-react] effect error', error)
      }
    }
  }

  function unmountTree() {
    for (var i = 0; i < cleanups.length; i += 1) {
      var hook = cleanups[i]
      if (hook && typeof hook.cleanup === 'function') {
        try {
          hook.cleanup()
        } catch (ignored) {
          /* ignore */
        }
        hook.cleanup = null
      }
    }
    cleanups = []
    pendingEffects = []
  }

  function render(element, container) {
    if (!container) throw new Error('fake-react: render needs a container')
    if (root) unmountTree()
    if (root && root.container) root.container.innerHTML = ''
    root = { element: element, container: container }
    container.innerHTML = ''
    mountVNode(element, container)
    runEffects()
  }

  function remount() {
    if (!root) return
    var element = root.element
    var container = root.container
    unmountTree()
    container.innerHTML = ''
    mountVNode(element, container)
    runEffects()
  }

  function unmountComponentAtNode(container) {
    if (!root || root.container !== container) return false
    unmountTree()
    container.innerHTML = ''
    root = null
    return true
  }

  global.FakeReact = {
    createElement: createElement,
    isValidElement: isElement,
    Component: Component,
    Fragment: FRAGMENT,
    useRef: useRef,
    useEffect: useEffect,
    useState: useState,
    useMemo: useMemo,
    useCallback: useCallback,
    render: render,
    unmountComponentAtNode: unmountComponentAtNode,
    __version: 'fake-react 1.0 (dev only)',
  }
})(typeof window !== 'undefined' ? window : globalThis)
