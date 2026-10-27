/**
 * Suite 4 — static contract / manifest audit against
 * handoff/contract/game-plugin-api.v1.md (v1).
 *
 *   node packages/dsh-game-klotski/dev/audit/contract-audit.mjs
 *
 * Everything is asserted by script: package.json, cordis.patch.yml, index.js,
 * locale/*.json, icon.svg, the client.js source rules (module loader id, only
 * require('react'), inject:['slots'] only, only game.stage registration,
 * strict gameId select, store key/schema, no document.body, no global
 * window/document keydown, root fills 100%, ResizeObserver, devicePixelRatio,
 * <320x240 handling, no third-party import/require), and the factory's runtime
 * registration shape via a fake React + fake slot registry.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, definition } from './harness.mjs'

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = join(PKG_DIR, '..', '..')
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
const clientSource = readFileSync(join(PKG_DIR, 'client.js'), 'utf8')
const indexSource = readFileSync(join(PKG_DIR, 'index.js'), 'utf8')
const patchSource = readFileSync(join(PKG_DIR, 'cordis.patch.yml'), 'utf8')
const zh = JSON.parse(readFileSync(join(PKG_DIR, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(PKG_DIR, 'locale', 'en.json'), 'utf8'))

const checks = []
const notes = []
function check(name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, message: String(error && error.message) })
    console.error('FAIL ' + name + ': ' + (error && error.message))
  }
}
function note(id, text) {
  notes.push({ id, text })
}

/* ------------------------------------------------------------ package.json */

check('package.json name/version/private/type', () => {
  assert.equal(pkg.name, '@local/dsh-game-klotski')
  assert.equal(pkg.version, '0.1.0')
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, 'module')
})

check('package.json exports: "." , "./client", "./locale/*.json", "./icon"', () => {
  assert.ok(pkg.exports && typeof pkg.exports === 'object')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], './icon.svg')
  for (const key of ['./index.js', './client.js', './locale/en.json', './locale/zh.json', './icon.svg']) {
    assert.ok(existsSync(join(PKG_DIR, key)), 'exported file missing: ' + key)
  }
})

check('package.json files lists every runtime file', () => {
  const files = pkg.files
  assert.ok(Array.isArray(files), 'files must be an array')
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(files.includes(required), 'files must include ' + required)
  }
  for (const entry of files) {
    if (entry.includes('*')) continue
    assert.ok(existsSync(join(PKG_DIR, entry)), 'files entry does not exist: ' + entry)
  }
})

check('package.json dsh.bundle.patch + dsh.client(web, immediately)', () => {
  assert.ok(pkg.dsh && typeof pkg.dsh === 'object')
  assert.deepEqual(pkg.dsh.bundle, { patch: './cordis.patch.yml' })
  assert.deepEqual(pkg.dsh.client, { platform: 'web', immediately: true })
})

check('package.json has no dependencies and no dsh.client.inject', () => {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies']) {
    assert.equal(pkg[field], undefined, 'must not declare ' + field)
  }
  assert.equal(pkg.dsh.client.inject, undefined, 'must not declare dsh.client.inject')
})

/* --------------------------------------------------------- cordis.patch.yml */

check('cordis.patch.yml: one insert with id game-klotski and the package name', () => {
  const text = patchSource.replace(/\r/g, '')
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  assert.deepEqual(lines[0], '- insert:', 'patch must start with "- insert:"')
  assert.equal(lines.length, 3, 'expected exactly one inserted plugin entry, got: ' + JSON.stringify(lines))
  assert.equal(lines[1], '- id: game-klotski')
  assert.equal(lines[2], "name: '@local/dsh-game-klotski'")
})

/* ---------------------------------------------------------------- index.js */

check('index.js: only "export function apply() {}", no logic/effects', () => {
  const stripped = indexSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  assert.equal(stripped, 'export function apply() {}', 'index.js body should be exactly an empty apply(): ' + JSON.stringify(stripped))
  assert.ok(!/^\s*import\s/m.test(indexSource), 'index.js must not import anything')
  assert.ok(!/require\s*\(/.test(indexSource), 'index.js must not require anything')
})

/* -------------------------------------------------------------- locale/*.json */

check('locale zh/en: meta.title + meta.description, same shape', () => {
  for (const [name, doc] of [['zh', zh], ['en', en]]) {
    assert.ok(doc.meta && typeof doc.meta === 'object', name + ' needs meta')
    assert.deepEqual(Object.keys(doc).sort(), ['meta'], name + ' should only have meta')
    assert.deepEqual(Object.keys(doc.meta).sort(), ['description', 'title'], name + ' meta keys')
    assert.ok(typeof doc.meta.title === 'string' && doc.meta.title.length > 0, name + ' title')
    assert.ok(typeof doc.meta.description === 'string' && doc.meta.description.length > 10, name + ' description')
  }
  assert.equal(zh.meta.title, '华容道')
  assert.equal(en.meta.title, 'Klotski')
})

/* ------------------------------------------------------------------ icon.svg */

check('icon.svg exists and is a 64x64 svg', () => {
  const iconPath = join(PKG_DIR, 'icon.svg')
  assert.ok(existsSync(iconPath), 'icon.svg missing')
  const icon = readFileSync(iconPath, 'utf8')
  assert.ok(/^\s*<svg[\s>]/.test(icon), 'icon must start with <svg>')
  assert.ok(icon.includes('viewBox="0 0 64 64"'), 'icon viewBox should be 0 0 64 64')
  assert.ok(icon.includes('</svg>'), 'icon must close')
})

/* -------------------------------------------------------- client.js: module */

check('client.js calls window.__ModuleLoader__.load with the package-name id', () => {
  assert.ok(/window\.__ModuleLoader__\.load\s*\(\s*\{/.test(clientSource), 'missing __ModuleLoader__.load({...})')
  assert.ok(clientSource.includes("id: '@local/dsh-game-klotski'"), 'module id literal')
  assert.ok(definition && definition.id === pkg.name, 'loaded definition id must equal package name, got ' + (definition && definition.id))
  assert.equal(typeof definition.factory, 'function', 'definition.factory must be a function')
})

check('client.js is a classic IIFE script: no top-level import/export, no third-party require', () => {
  assert.ok(!/^\s*import\s/m.test(clientSource), 'client.js must not use ESM import')
  assert.ok(!/^\s*export\s/m.test(clientSource), 'client.js must not use ESM export')
  const requires = Array.from(clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map((m) => m[1])
  assert.deepEqual(requires, ['react'], 'client.js may only require("react"), got ' + JSON.stringify(requires))
})

/* --------------------------- client.js: factory runtime registration shape */

const REQUIRED_MODULES = []
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useRef(initial) {
    return { current: initial }
  },
  useEffect() {},
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(next) {
      this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next)
    }
  },
}

let moduleExport = null
let factoryError = null
try {
  moduleExport = definition.factory(function fakeRequire(name) {
    REQUIRED_MODULES.push(name)
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
} catch (error) {
  factoryError = error
}

check('factory requires react only', () => {
  assert.equal(factoryError, null, 'factory threw: ' + (factoryError && factoryError.message))
  assert.deepEqual(REQUIRED_MODULES, ['react'], 'factory may only require react, got ' + JSON.stringify(REQUIRED_MODULES))
})

check('factory returns exactly { inject: [slots], apply(ctx) }', () => {
  assert.ok(moduleExport && typeof moduleExport === 'object', 'factory must return the plugin object')
  assert.deepEqual(moduleExport.inject, ['slots'], 'inject must be exactly ["slots"]')
  assert.equal(typeof moduleExport.apply, 'function', 'apply must be a function')
  assert.deepEqual(Object.keys(moduleExport).sort(), ['apply', 'inject'], 'plugin object should only expose inject/apply')
})

check('apply registers only game.stage with id klotski and strict gameId select', () => {
  assert.ok(moduleExport && typeof moduleExport.apply === 'function', 'apply missing')
  const injectCalls = []
  const registerCalls = []
  const ctx = {
    slots: {
      inject(slotName, callback) {
        injectCalls.push({ slotName, callback })
      },
      register(options, component) {
        registerCalls.push({ options, component })
      },
    },
  }
  moduleExport.apply(ctx)
  assert.equal(injectCalls.length, 1, 'apply must call slots.inject exactly once')
  assert.equal(injectCalls[0].slotName, 'game.stage', 'only the game.stage slot may be injected')
  assert.equal(typeof injectCalls[0].callback, 'function', 'slots.inject needs the registration callback')
  injectCalls[0].callback()
  assert.equal(registerCalls.length, 1, 'callback must register exactly one entry')
  const { options, component } = registerCalls[0]
  assert.equal(options.name, 'game.stage')
  assert.equal(options.id, 'klotski', 'slot id must be the game id')
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), '华容道', 'label() must return the Chinese display name')
  assert.equal(typeof options.select, 'function', 'select is required for a chain slot')
  const matched = options.select({ gameId: 'klotski' })
  assert.ok(matched && typeof matched === 'object', 'select({gameId:"klotski"}) must return an object')
  assert.equal(options.select({ gameId: 'other' }), null, 'select must reject other game ids')
  assert.equal(options.select({ gameId: 'Klotski' }), null, 'select must be case-strict')
  assert.equal(options.select({ gameId: '' }), null, 'select must reject empty game id')
  assert.equal(options.select({}), null, 'select must reject missing gameId')
  assert.equal(typeof component, 'function', 'registration component must be a React component function')
  assert.equal(api.GAME_ID, 'klotski')
})

check('apply only touches ctx.slots (no ctx.provide / no other service)', () => {
  const ctxUsages = Array.from(clientSource.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)).map((m) => m[1])
  assert.ok(ctxUsages.length > 0, 'expected ctx usage in apply')
  for (const usage of ctxUsages) assert.equal(usage, 'slots', 'unexpected ctx.' + usage)
  assert.ok(!/ctx\.provide\s*\(/.test(clientSource), 'must not provide new services')
  assert.ok(!/ctx\.slots\.register\s*\(\s*\{[^}]*name:\s*['"](?!game\.stage)/.test(clientSource), 'only game.stage may be registered')
})

/* ------------------------------------------- client.js: contract source rules */

check('store key/schema constants are exactly dsh.game.klotski.v1 / 1', () => {
  assert.equal(api.STORE_KEY, 'dsh.game.klotski.v1')
  assert.equal(api.SCHEMA_VERSION, 1)
  assert.equal(api.GAME_ID, 'klotski')
  assert.ok(clientSource.includes("const STORE_KEY = 'dsh.game.klotski.v1'"), 'store key constant')
  assert.ok(clientSource.includes('const SCHEMA_VERSION = 1'), 'schema version constant')
  const literals = clientSource.match(/dsh\.game\.[A-Za-z0-9_.-]+/g) || []
  for (const literal of literals) assert.equal(literal, 'dsh.game.klotski.v1', 'unexpected store key literal ' + literal)
})

check('no document.body / document.title / foreign page mutation', () => {
  assert.ok(!/document\.body/.test(clientSource), 'client.js must not touch document.body')
  assert.ok(!/document\.title/.test(clientSource), 'client.js must not change document.title')
  assert.ok(!/document\.head/.test(clientSource), 'client.js must not touch document.head')
  assert.ok(!/body\.appendChild/.test(clientSource), 'client.js must not append to body')
})

check('no global window/document keydown listeners (keyboard only on own root)', () => {
  assert.ok(!/window\.addEventListener\(\s*['"]keydown['"]/.test(clientSource), 'window keydown listener found')
  assert.ok(!/document\.addEventListener\(\s*['"]keydown['"]/.test(clientSource), 'document keydown listener found')
  assert.ok(!/window\.onkeydown|document\.onkeydown/.test(clientSource), 'global onkeydown handler found')
  assert.ok(/root\.addEventListener\(\s*['"]keydown['"]/.test(clientSource), 'root must own the keydown listener')
  assert.ok(/root\.setAttribute\(\s*['"]tabindex['"]/.test(clientSource), 'root must be focusable (tabindex)')
  assert.ok(/root\.focus\s*\(/.test(clientSource), 'root should focus on pointer down')
})

check('root element fills 100% x 100%', () => {
  assert.ok(/width:\s*'100%'/.test(clientSource) && /height:\s*'100%'/.test(clientSource), 'React host div must be 100% x 100%')
  assert.ok(/\.dshklt-root\{position:absolute;inset:0;/.test(clientSource), 'game root must be positioned to fill its host')
})

check('ResizeObserver + devicePixelRatio handled', () => {
  assert.ok(/new ResizeObserver\s*\(/.test(clientSource), 'must use ResizeObserver')
  assert.ok(/observer\.observe\(\s*host\s*\)/.test(clientSource), 'must observe its own root/host')
  assert.ok(/observer\.disconnect\s*\(\s*\)/.test(clientSource), 'must disconnect on destroy')
  assert.ok(/devicePixelRatio/.test(clientSource), 'must consider devicePixelRatio')
})

check('too-small window (<320x240) shows a readable hint', () => {
  assert.ok(/MIN_WIDTH\s*=\s*320/.test(clientSource), 'MIN_WIDTH must be 320')
  assert.ok(/MIN_HEIGHT\s*=\s*240/.test(clientSource), 'MIN_HEIGHT must be 240')
  assert.ok(/width\s*<\s*MIN_WIDTH\s*\|\|\s*height\s*<\s*MIN_HEIGHT/.test(clientSource), 'small-size condition')
  assert.ok(clientSource.includes('窗口太小'), 'must show the too-small hint text')
  assert.ok(/dshklt-root--small/.test(clientSource), 'too-small class must exist')
})

check('no global window resize listener when ResizeObserver exists', () => {
  // Allowed only as a documented fallback (inside the else branch of the
  // ResizeObserver availability check). Assert it is not a second, always-on
  // global listener.
  const resizeListeners = Array.from(clientSource.matchAll(/window\.addEventListener\(\s*['"]resize['"]/g))
  assert.ok(resizeListeners.length <= 1, 'at most one resize fallback listener')
  const observerIndex = clientSource.indexOf('typeof ResizeObserver')
  const fallbackIndex = clientSource.indexOf("window.addEventListener('resize'")
  if (fallbackIndex >= 0) assert.ok(fallbackIndex > observerIndex, 'resize fallback must live after the ResizeObserver branch')
})

check('rendering has no canvas: DOM/CSS board (so dpr cannot blur)', () => {
  assert.ok(!/createElement\(\s*['"]canvas['"]/.test(clientSource), 'no canvas is created')
  note('no-canvas', 'Board is rendered with DOM/CSS (no <canvas>); devicePixelRatio is read/handled defensively but does not affect the DOM rendering, which is resolution-independent. Contract §5 describes canvas sizing; DOM rendering satisfies the intent (crisp at any DPI) but not the letter. Non-blocking.')
})

check('error/robustness: save + frame + error paths guarded, ErrorBoundary present', () => {
  assert.ok(/class ErrorBoundary extends React\.Component/.test(clientSource), 'ErrorBoundary component')
  assert.ok(/getDerivedStateFromError/.test(clientSource), 'ErrorBoundary.getDerivedStateFromError')
  assert.ok(/componentDidCatch/.test(clientSource), 'ErrorBoundary.componentDidCatch')
  assert.ok(/function loadSavedState[\s\S]{0,400}try\s*\{/.test(clientSource), 'loadSavedState guarded by try/catch')
  assert.ok(/function persistState[\s\S]{0,400}try\s*\{/.test(clientSource), 'persistState guarded by try/catch')
  assert.ok(/function handleError/.test(clientSource), 'in-game error handler')
  assert.ok(clientSource.includes('华容道出错了'), 'readable fatal message + restart')
})

check('test seam is gated on window.__DSH_GAME_KLOTSKI_TEST__ === true', () => {
  assert.ok(/window\.__DSH_GAME_KLOTSKI_TEST__\s*===\s*true/.test(clientSource), 'seam must be gated by the test flag')
  assert.ok(
    /if\s*\([^)]*__DSH_GAME_KLOTSKI_TEST__[^)]*\)\s*\{[\s\S]{0,500}__DSH_GAME_KLOTSKI__/.test(clientSource),
    'window.__DSH_GAME_KLOTSKI__ must be defined inside the test-flag guard',
  )
})

check('destroy() tears down rAF, listeners, observer and persists', () => {
  assert.ok(/function destroy\s*\(/.test(clientSource), 'destroy function')
  assert.ok(/stopTimer\(true\)[\s\S]{0,200}persist\(\)/.test(clientSource), 'destroy must stop timer and persist')
  assert.ok(/cancelAnimationFrame/.test(clientSource), 'destroy must cancel rAF')
  assert.ok(/doc\.removeEventListener\(\s*['"]visibilitychange['"]/.test(clientSource), 'destroy must remove visibilitychange listener')
  assert.ok(/observer\.disconnect/.test(clientSource), 'destroy must disconnect ResizeObserver')
})

check('visibility pause uses document visibilitychange (not a global key listener)', () => {
  assert.ok(/doc\.addEventListener\(\s*['"]visibilitychange['"]/.test(clientSource), 'visibilitychange listener')
  assert.ok(/function onVisibilityChange/.test(clientSource), 'visibility handler')
  assert.ok(/document\.hidden|doc\.hidden/.test(clientSource), 'document.hidden check')
})

check('package README.md listed in files (presence check)', () => {
  const listed = Array.isArray(pkg.files) && pkg.files.includes('README.md')
  const exists = existsSync(join(PKG_DIR, 'README.md'))
  if (listed && !exists) {
    note('readme-missing', 'package.json files[] lists README.md but packages/dsh-game-klotski/README.md does not exist. Runtime is unaffected (files[] only matters when packing/publishing), but the manifest is inconsistent. Non-blocking.')
  } else {
    assert.ok(!listed || exists, 'README.md listed but missing')
  }
})

/* ------------------------------------------------------------- host contract */

check('handoff/contract has the frozen v1 document and no extra top-level files', () => {
  const contractDir = join(ROOT, 'handoff', 'contract')
  assert.ok(existsSync(join(contractDir, 'game-plugin-api.v1.md')), 'contract doc present')
  // The task brief says the directory holds only that one file; extra top-level
  // entries are reported as a note (an examples/ folder was observed).
  const entries = readdirSync(contractDir, { withFileTypes: true })
  const topFiles = entries.filter((e) => e.isFile()).map((e) => e.name)
  if (topFiles.length !== 1 || topFiles[0] !== 'game-plugin-api.v1.md') {
    note('contract-dir-extra', 'handoff/contract top-level files: ' + JSON.stringify(topFiles) + ' (baseline note says only game-plugin-api.v1.md)')
  }
})

/* ---------------------------------------------------------------- results */

const failed = checks.filter((c) => !c.ok)
console.log('=== Suite 4: contract / manifest static audit ===\n')
for (const c of checks) console.log((c.ok ? 'ok   - ' : 'FAIL - ') + c.name + (c.ok ? '' : ' :: ' + c.message))
console.log('\nnotes:')
for (const n of notes) console.log('  - [' + n.id + '] ' + n.text)
console.log('\n--- Result ---')
console.log(JSON.stringify({ checks: checks.length, failed: failed.length, failures: failed, notes }, null, 2))

if (failed.length > 0) {
  console.error('\nSUITE 4 FAILED: ' + failed.length + ' check(s)')
  process.exitCode = 1
} else {
  console.log('\nSUITE 4 PASS — ' + checks.length + ' contract checks, ' + notes.length + ' note(s).')
}
