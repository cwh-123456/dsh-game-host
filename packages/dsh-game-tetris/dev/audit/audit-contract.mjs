/**
 * Independent read-only audit — contract / manifest / static shape.
 *
 * Written by the verifier (not the implementer). It does not modify the package.
 * Run: node dev/audit/audit-contract.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const readJson = (rel) => JSON.parse(read(rel))
const count = (text, re) => (text.match(re) || []).length

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    failed += 1
    failures.push(name + ': ' + (error && error.message))
    console.error('not ok - ' + name + ' :: ' + (error && error.message))
  }
}

const pkg = readJson('package.json')
const client = read('client.js')
const index = read('index.js')
const patch = read('cordis.patch.yml').replace(/\r\n/g, '\n').trim()
const host = read('../dsh-game-host/client.js')
const host2048 = read('../dsh-game-2048/client.js')

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------
check('package.json name is @local/dsh-game-tetris', () => {
  assert.equal(pkg.name, '@local/dsh-game-tetris')
})
check('package.json is private ESM v0.1.0', () => {
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.version, '0.1.0')
})
check('exports . -> index.js and ./client -> client.js', () => {
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], './icon.svg')
})
check('dsh.client = {platform: web, immediately: true}', () => {
  assert.deepEqual(pkg.dsh.client, { platform: 'web', immediately: true })
})
check('dsh.client has no inject field', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(pkg.dsh.client, 'inject'), false)
})
check('dsh.bundle.patch = ./cordis.patch.yml', () => {
  assert.deepEqual(pkg.dsh.bundle, { patch: './cordis.patch.yml' })
})
check('no dependencies / peer / optional deps', () => {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    assert.equal(Object.prototype.hasOwnProperty.call(pkg, field), false, field)
  }
})
check('files covers all runtime files and excludes dev/', () => {
  const files = pkg.files
  for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md']) {
    assert.ok(files.indexOf(entry) !== -1, 'files should include ' + entry)
  }
  assert.ok(!files.some((entry) => /^dev\//.test(entry)), 'dev/ must not ship')
  for (const rel of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg', 'README.md']) {
    assert.ok(fs.statSync(path.join(root, rel)).isFile(), rel + ' exists')
  }
})
check('description is UTF-8 Chinese label, not mojibake', () => {
  assert.ok(pkg.description.includes('俄罗斯方块'), 'description should name the game')
})

// ---------------------------------------------------------------------------
// cordis.patch.yml
// ---------------------------------------------------------------------------
check('cordis.patch.yml exact insert shape', () => {
  assert.equal(patch, "- insert:\n    - id: game-tetris\n      name: '@local/dsh-game-tetris'")
})
check('only one insert entry, id game-tetris, matching package name', () => {
  assert.equal(count(patch, /-\s*id:/g), 1)
  assert.ok(/id:\s*game-tetris/.test(patch))
  assert.ok(/name:\s*'@local\/dsh-game-tetris'/.test(patch))
})
check('patch shape matches 2048 precedent (insert list, id/name only)', () => {
  const p2048 = read('../dsh-game-2048/cordis.patch.yml').replace(/\r\n/g, '\n').trim()
  const shaped = (text) => text.replace(/game-\w+/g, 'GAME')
  assert.equal(shaped(patch), shaped(p2048))
})
check('no other package claims id game-tetris or name @local/dsh-game-tetris', () => {
  const packagesDir = path.join(root, '..')
  const others = []
  for (const name of fs.readdirSync(packagesDir)) {
    if (name === 'dsh-game-tetris') continue
    const pj = path.join(packagesDir, name, 'package.json')
    const cj = path.join(packagesDir, name, 'cordis.patch.yml')
    if (!fs.existsSync(pj)) continue
    const otherPkg = JSON.parse(fs.readFileSync(pj, 'utf8'))
    others.push({ dir: name, name: otherPkg.name })
    if (fs.existsSync(cj)) {
      const text = fs.readFileSync(cj, 'utf8')
      assert.ok(!/id:\s*game-tetris\b/.test(text), name + ' reuses id game-tetris')
    }
  }
  assert.equal(others.filter((entry) => entry.name === pkg.name).length, 0)
})

// ---------------------------------------------------------------------------
// index.js
// ---------------------------------------------------------------------------
check('index.js is an empty apply()', () => {
  assert.ok(/export function apply\s*\(\s*\)\s*\{\s*\}/.test(index), 'apply must be empty')
  assert.ok(!/ctx\.|slots\.|provide/.test(index), 'no host-side logic')
})

// ---------------------------------------------------------------------------
// locale + icon
// ---------------------------------------------------------------------------
check('locale zh.json meta.title / meta.description', () => {
  const zh = readJson('locale/zh.json')
  assert.equal(zh.meta.title, '俄罗斯方块')
  assert.equal(typeof zh.meta.description, 'string')
  assert.ok(zh.meta.description.length >= 10)
  assert.ok(/[\u4e00-\u9fff]/.test(zh.meta.description))
})
check('locale en.json meta.title / meta.description', () => {
  const en = readJson('locale/en.json')
  assert.equal(en.meta.title, 'Tetris')
  assert.equal(typeof en.meta.description, 'string')
  assert.ok(en.meta.description.length >= 10)
  assert.ok(!/[\u4e00-\u9fff]/.test(en.meta.title + en.meta.description), 'en locale should be English')
})
check('icon.svg is well-formed SVG with viewBox and no script/event handlers', () => {
  const svg = read('icon.svg').trim()
  assert.ok(svg.startsWith('<svg'), 'root element')
  assert.ok(svg.endsWith('</svg>'), 'closed root element')
  assert.ok(/viewBox="0 0 64 64"/.test(svg))
  assert.ok(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg))
  assert.ok(!/<script/i.test(svg))
  assert.ok(!/<foreignObject/i.test(svg))
  assert.ok(!/\son[a-z]+\s*=/i.test(svg), 'no inline event handlers')
  // minimal XML tag-balance check
  const body = svg.replace(/<!--[\s\S]*?-->/g, '')
  const stack = []
  const tagRe = /<\/?([A-Za-z][\w:.-]*)(?:\s[^<>]*?)?(\/?)>/g
  let match
  let consumed = 0
  const allowed = new Set(['svg', 'rect', 'g', 'path', 'circle', 'defs', 'linearGradient', 'stop'])
  while ((match = tagRe.exec(body))) {
    const whole = match[0]
    const name = match[1]
    consumed += whole.length
    assert.ok(allowed.has(name), 'unexpected tag ' + name)
    if (whole.startsWith('</')) {
      assert.equal(stack.pop(), name, 'mismatched closing tag ' + name)
    } else if (!whole.endsWith('/>')) {
      stack.push(name)
    }
  }
  assert.equal(stack.length, 0, 'unclosed tags: ' + stack.join(','))
  assert.equal(body.replace(tagRe, '').trim().length, 0, 'stray markup text')
  assert.ok(consumed > 0)
})

// ---------------------------------------------------------------------------
// client.js — static contract shape
// ---------------------------------------------------------------------------
check('loader id equals package name', () => {
  assert.ok(/window\.__ModuleLoader__\.load\(\{/.test(client))
  assert.ok(/id:\s*'@local\/dsh-game-tetris'/.test(client))
})
check('only react is required (no relative/third-party modules)', () => {
  const mods = [...client.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(mods)], ['react'])
})
check('client.js is a single IIFE (no import/export statements)', () => {
  assert.ok(!/^\s*import\s/m.test(client))
  assert.ok(!/^\s*export\s/m.test(client))
  assert.ok(!/\bimport\s*\(/.test(client))
})
check('plugin injects only [slots], no provide, one slot registration', () => {
  assert.equal(count(client, /inject:\s*\['slots'\]/g), 1)
  assert.equal(count(client, /ctx\.slots\.inject\(/g), 1)
  assert.equal(count(client, /ctx\.slots\.register\(/g), 1)
  assert.equal(count(client, /ctx\.provide|slots\.provide/g), 0)
  assert.equal(count(client, /name:\s*'game\.stage'/g), 1)
  assert.equal(count(client, /id:\s*GAME_ID/g), 1)
})
check('GAME_ID = tetris and STORE_KEY = dsh.game.tetris.v1', () => {
  assert.ok(/const GAME_ID\s*=\s*'tetris'/.test(client))
  assert.ok(/const STORE_KEY\s*=\s*'dsh\.game\.'\s*\+\s*GAME_ID\s*\+\s*'\.v1'/.test(client))
})
check('label() returns Chinese display name', () => {
  assert.ok(/label:\s*function\s*\(\)\s*\{[\s\S]{0,80}?return '俄罗斯方块'/.test(client))
})
check('select() only matches gameId === tetris', () => {
  assert.ok(/select:\s*function\s*\(ownerProps\)\s*\{[\s\S]{0,160}?ownerProps\.gameId === GAME_ID \? MATCHED : null/.test(client))
})
check('error boundary wraps the game component', () => {
  assert.ok(/class GameBoundary extends React\.Component/.test(client))
  assert.ok(/static getDerivedStateFromError\(\)/.test(client))
  assert.ok(/componentDidCatch\(error, info\)/.test(client))
  assert.ok(/h\(GameBoundary, null, h\(Game, props\)\)/.test(client))
})
check('keyboard listener only on canvas (0 on window/document)', () => {
  assert.equal(count(client, /window\.addEventListener\(\s*['"]keydown/g), 0)
  assert.equal(count(client, /document\.addEventListener\(\s*['"]keydown/g), 0)
  assert.equal(count(client, /addEventListener\(\s*['"]keydown/g), 1)
  assert.equal(count(client, /removeEventListener\(\s*['"]keydown/g), 1)
  assert.equal(count(client, /\.onkeydown/g), 0)
  assert.ok(/canvas\.addEventListener\('keydown', onKeyDown\)/.test(client))
})
check('focus: tabIndex = 0, role application, mounted focus()', () => {
  assert.ok(/canvas\.tabIndex\s*=\s*0/.test(client))
  assert.ok(/role', 'application'/.test(client))
  assert.ok(/canvas\.focus\(\{ preventScroll: true \}\)/.test(client))
  assert.ok(/focusCanvas\(\)/.test(client))
})
check('preventDefault used for arrows/space path', () => {
  assert.ok(count(client, /preventDefault/g) >= 2)
  assert.ok(/if \(typeof event\.preventDefault === 'function'\) event\.preventDefault\(\)/.test(client))
})
check('requestAnimationFrame loop with cancelAnimationFrame', () => {
  assert.ok(count(client, /requestAnimationFrame/g) >= 2)
  assert.ok(count(client, /cancelAnimationFrame/g) >= 1)
})
check('ResizeObserver + devicePixelRatio + host rect (no window.innerWidth)', () => {
  assert.ok(count(client, /ResizeObserver/g) >= 2)
  assert.ok(count(client, /devicePixelRatio/g) >= 1)
  assert.ok(/getBoundingClientRect\(\)/.test(client))
  assert.equal(count(client, /window\.innerWidth|innerWidth/g), 0)
})
check('localStorage save/restore wrapped in try/catch', () => {
  assert.ok(/window\.localStorage\.getItem\(STORE_KEY\)/.test(client))
  assert.ok(/window\.localStorage\.setItem\(STORE_KEY/.test(client))
  assert.ok(/catch \(error\)/.test(client))
})
check('test seam only enabled behind __DSH_GAME_TETRIS_TEST__', () => {
  assert.equal(count(client, /__DSH_GAME_TETRIS_TEST__ === true/g), 1)
  assert.ok(/Object\.defineProperty\(window, '__DSH_GAME_TETRIS__'/.test(client))
})
check('no eval / Function / network / body or title mutation', () => {
  assert.equal(count(client, /\beval\s*\(/g), 0)
  assert.equal(count(client, /new Function/g), 0)
  assert.equal(count(client, /\bfetch\s*\(/g), 0)
  assert.equal(count(client, /XMLHttpRequest|WebSocket/g), 0)
  assert.equal(count(client, /document\.body|document\.title/g), 0)
})
check('inline <style> precedent matches 2048 (CSP note)', () => {
  assert.ok(/h\('style', null, STYLE_TEXT\)/.test(client))
  assert.ok(/h\('style', null, STYLE_TEXT\)/.test(host2048), '2048 has the same precedent')
})
check('host-side game.stage integration exists and is tetris-agnostic', () => {
  assert.ok(/renderSlotChain\('game\.stage', \{ gameId: selectedId \}/.test(host))
  assert.ok(/ctx\.slots\.entries\('game\.stage'\)/.test(host))
  assert.ok(/options\.id/.test(host) && /options\.label/.test(host))
  assert.ok(!/tetris/i.test(host), 'host must not contain tetris-specific code')
  assert.ok(!/俄罗斯方块/.test(host), 'host must not hard-code tetris label')
})

// ---------------------------------------------------------------------------
// factory evaluation: real registration behaviour with a React stub
// ---------------------------------------------------------------------------
const ReactStub = {
  createElement(tag) {
    return { tag }
  },
  useRef(value) {
    return { current: value === undefined ? null : value }
  },
  useEffect() {},
  useState(value) {
    return [value, function () {}]
  },
  useCallback(fn) {
    return fn
  },
  Component: class Component {
    constructor(props) {
      this.props = props
    }
    setState(partial) {
      this.state = Object.assign({}, this.state, partial)
    }
  },
}

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

await import(pathToFileURL(path.join(root, 'client.js')).href)

function makePlugin() {
  assert.ok(loaded, 'module loader should be called')
  return loaded.factory(function (name) {
    assert.equal(name, 'react')
    return ReactStub
  })
}

check('factory exposes exactly {inject, apply} and inject === [slots]', () => {
  const plugin = makePlugin()
  assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'inject'])
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

check('apply() injects game.stage and registers exactly once', () => {
  const plugin = makePlugin()
  const calls = { inject: [], register: [], provide: 0 }
  const disposer = function () {}
  const ctx = {
    provide() {
      calls.provide += 1
    },
    slots: {
      inject(name, callback) {
        calls.inject.push(name)
        calls.callback = callback
      },
      register(config, component) {
        calls.register.push({ config, component })
        return disposer
      },
    },
  }
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.deepEqual(calls.inject, ['game.stage'])
  assert.equal(calls.provide, 0)
  const injectedReturn = calls.callback()
  assert.equal(calls.register.length, 1)
  const { config, component } = calls.register[0]
  assert.equal(config.name, 'game.stage')
  assert.equal(config.id, 'tetris')
  assert.equal(typeof config.label, 'function')
  assert.equal(config.label(), '俄罗斯方块')
  assert.equal(typeof config.select, 'function')
  assert.equal(typeof config.select, 'function')
  assert.ok(config.select({ gameId: 'tetris' }) !== null)
  assert.equal(config.select({ gameId: '2048' }), null)
  assert.equal(config.select({ gameId: 'Tetris' }), null)
  assert.equal(config.select({ gameId: '' }), null)
  assert.equal(config.select({}), null)
  assert.equal(config.select(null), null)
  assert.equal(config.select(undefined), null)
  const matched = config.select({ gameId: 'tetris' })
  assert.equal(typeof matched, 'object')
  assert.ok(Object.isFrozen(matched), 'matched payload stable/frozen')
  assert.equal(config.select({ gameId: 'tetris' }), matched, 'same matched reference every call')
  assert.equal(typeof component, 'function')
  assert.equal(injectedReturn, disposer, 'inject callback returns the slot disposer')
  assert.doesNotThrow(() => component({ matched }), 'component renders with matched prop')
})

check('host absent: inject throws -> swallowed, apply does not throw', () => {
  const plugin = makePlugin()
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    plugin.apply({
      slots: {
        inject() {
          throw new Error('no host')
        },
      },
    })
  } finally {
    console.error = original
  }
  assert.ok(errors.some((line) => line.includes('slot inject failed')))
})

check('register throws -> swallowed, inject callback returns a disposer', () => {
  const plugin = makePlugin()
  const original = console.error
  const errors = []
  console.error = (...args) => errors.push(args.join(' '))
  let returned
  try {
    plugin.apply({
      slots: {
        inject(name, callback) {
          returned = callback()
        },
        register() {
          throw new Error('slot missing')
        },
      },
    })
  } finally {
    console.error = original
  }
  assert.equal(typeof returned, 'function', 'fallback disposer')
  assert.doesNotThrow(() => returned())
  assert.ok(errors.some((line) => line.includes('slot registration failed')))
})

// ---------------------------------------------------------------------------
console.log('\ncontract audit: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  console.log('failures:\n- ' + failures.join('\n- '))
  process.exitCode = 1
}
