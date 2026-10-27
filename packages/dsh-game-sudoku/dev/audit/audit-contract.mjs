/**
 * Audit 1/3 — contract, manifest, registration, test seam and static UI checks.
 *
 * Run: node dev/audit/audit-contract.mjs
 * Independent of the implementation's own dev/test-logic.mjs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  AUDIT_DIR,
  CLIENT_FILE,
  PACKAGE_DIR,
  assert,
  captureConsoleError,
  clientCode,
  clientExists,
  createCtx,
  createDocumentStub,
  createReactStub,
  createRunner,
  createStorage,
  loadClient,
  must,
} from './harness.mjs'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

if (!clientExists()) {
  console.log('WAITING: client.js does not exist yet at ' + CLIENT_FILE)
  process.exit(2)
}

const runner = createRunner('contract audit')

let loaded = null
try {
  loaded = await loadClient({ testFlag: true, tag: 'contract' })
} catch (error) {
  console.log('FATAL: could not load client.js: ' + error.message)
  process.exit(3)
}

function readText(relPath) {
  return readFileSync(join(PACKAGE_DIR, relPath), 'utf8')
}

function readJson(relPath) {
  return JSON.parse(readText(relPath))
}

const EVIDENCE = {}
const code = clientCode()
const lineCount = code.split('\n').length
EVIDENCE.clientBytes = Buffer.byteLength(code, 'utf8')
EVIDENCE.clientLines = lineCount

function lineOfIndex(index) {
  return code.slice(0, index).split('\n').length
}

function findLine(needle) {
  const index = code.indexOf(needle)
  return index === -1 ? null : lineOfIndex(index)
}

function requirePattern(label, pattern, evidenceKey) {
  const match = pattern.exec(code)
  must(match !== null, label + ': missing expected pattern ' + String(pattern))
  if (evidenceKey) EVIDENCE[evidenceKey] = lineOfIndex(match.index)
  return match
}

function requireLiteral(label, literal, evidenceKey) {
  const index = code.indexOf(literal)
  must(index !== -1, label + ': missing literal ' + JSON.stringify(literal))
  if (evidenceKey) EVIDENCE[evidenceKey] = lineOfIndex(index)
  return index
}

// ---------------------------------------------------------------------------
// 1. package.json manifest (contract §2)
// ---------------------------------------------------------------------------
let manifest = null
runner.check('package.json is valid JSON and follows contract v1 manifest rules', () => {
  manifest = readJson('package.json')
  const pkg = manifest
  assert.equal(pkg.name, '@local/dsh-game-sudoku')
  assert.equal(pkg.version, '0.1.0')
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, undefined, 'no main field expected (exports is the entry)')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js', 'exports["./client"] is required by the contract')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.ok(pkg.dsh.client.inject === undefined, 'contract §2: do not declare dsh.client.inject')
  assert.ok(pkg.dependencies === undefined, 'contract §2: no dependencies')
  assert.ok(pkg.devDependencies === undefined, 'contract §2: no devDependencies')
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md']) {
    assert.ok(pkg.files.includes(required), 'files[] must list ' + required)
  }
  EVIDENCE.manifestExports = Object.keys(pkg.exports)
})

runner.check('cordis.patch.yml declares exactly one game-sudoku insert', () => {
  const text = readText('cordis.patch.yml')
  const inserts = text.match(/^\s*-\s*insert:/gm) || []
  assert.equal(inserts.length, 1, 'exactly one insert block expected')
  assert.ok(/- insert:/.test(text))
  assert.ok(/^\s*-\s*id:\s*game-sudoku\s*$/m.test(text), 'id: game-sudoku')
  assert.ok(/^\s*name:\s*'@local\/dsh-game-sudoku'\s*$/m.test(text), "name: '@local/dsh-game-sudoku'")
  EVIDENCE.cordisPatch = text.trim()
})

runner.check('index.js is the empty host half (only export apply)', () => {
  const text = readText('index.js')
  assert.ok(/export\s+function\s+apply\s*\(\s*\)\s*\{\s*\}/.test(text), 'expected `export function apply() {}`')
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim()
  assert.ok(!/window\.|document\.|setTimeout|setInterval/.test(withoutComments), 'index.js must stay side-effect free')
  assert.ok(!/import\s/.test(withoutComments), 'index.js must not import anything')
})

runner.check('locale zh/en carry meta.title/meta.description', () => {
  const zh = readJson('locale/zh.json')
  const en = readJson('locale/en.json')
  assert.equal(zh.meta.title, '数独')
  assert.equal(en.meta.title, 'Sudoku')
  for (const locale of [zh, en]) {
    assert.equal(typeof locale.meta.description, 'string')
    assert.ok(locale.meta.description.length > 10, 'description should be meaningful')
  }
  EVIDENCE.localeZh = zh.meta
})

runner.check('icon.svg exists and looks like an SVG', () => {
  const text = readText('icon.svg')
  assert.ok(text.length > 50)
  assert.ok(/<svg[\s>]/.test(text), 'missing <svg> root')
  assert.ok(!/<script/i.test(text), 'icon must not embed scripts')
})

runner.check('README.md exists (listed in files[]) and mentions install path', () => {
  const text = readText('README.md')
  assert.ok(text.length > 50)
  assert.ok(/dsh-game-sudoku/.test(text))
  assert.ok(/数独|sudoku/i.test(text))
})

// ---------------------------------------------------------------------------
// 2. registration shape through a window+ctx stub
// ---------------------------------------------------------------------------
runner.check('bundle loads through __ModuleLoader__ with the package name', () => {
  assert.ok(loaded && loaded.definition, 'definition should be captured')
  assert.equal(loaded.definition.id, manifest.name, 'definition id must equal package.json name')
  assert.equal(typeof loaded.definition.factory, 'function')
  EVIDENCE.definitionId = loaded.definition.id
})

let plugin = null
runner.check('factory requires only react and exposes inject:[slots] + apply', () => {
  const requireCalls = []
  const reactStub = createReactStub()
  plugin = loaded.definition.factory((id) => {
    requireCalls.push(id)
    if (id === 'react') return reactStub
    throw new Error('unexpected require: ' + id)
  })
  assert.ok(requireCalls.length >= 1)
  assert.ok(requireCalls.every((id) => id === 'react'), 'only react may be required, got ' + JSON.stringify(requireCalls))
  assert.deepEqual(plugin.inject, ['slots'], 'plugin.inject must be exactly ["slots"]')
  assert.equal(typeof plugin.apply, 'function')
  EVIDENCE.requireCalls = requireCalls
})

runner.check('apply() registers only game.stage with id sudoku / label 数独', () => {
  const { ctx, calls } = createCtx()
  plugin.apply(ctx)
  assert.deepEqual(calls.inject, ['game.stage'], 'inject only into game.stage')
  assert.equal(calls.register.length, 1, 'exactly one registration')
  const { options, component } = calls.register[0]
  assert.equal(options.name, 'game.stage')
  assert.equal(options.id, 'sudoku')
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), '数独')
  assert.equal(typeof options.select, 'function')
  assert.equal(typeof component, 'function')
  assert.ok(calls.disposers >= 1, 'slots.inject callback must return the register disposition')
  EVIDENCE.registration = {
    name: options.name,
    id: options.id,
    label: options.label(),
    component: typeof component,
  }
})

runner.check('select returns one stable frozen MATCHED object only for gameId sudoku', () => {
  const { ctx, calls } = createCtx()
  plugin.apply(ctx)
  const { select } = calls.register[0].options
  const first = select({ gameId: 'sudoku' })
  const second = select({ gameId: 'sudoku' })
  must(first !== null && typeof first === 'object', 'select({gameId:"sudoku"}) must return the matched object')
  must(first === second, 'select must return the same MATCHED object instance (created once)')
  must(Object.isFrozen(first), 'MATCHED must be Object.freeze({})')
  assert.equal(select({ gameId: '2048' }), null)
  assert.equal(select({ gameId: 'SUDOKU' }), null)
  assert.equal(select({}), null)
  assert.equal(select(null), null)
  assert.equal(select(undefined), null)
  assert.equal(select('sudoku'), null)
  EVIDENCE.matchedFrozen = Object.isFrozen(first)
})

runner.check('apply() survives slots injection/registration failures and logs with the console prefix', () => {
  const injectCase = createCtx({ injectThrows: true })
  const injectErrors = captureConsoleError(() => {
    plugin.apply(injectCase.ctx) // must not throw
  })
  assert.ok(injectErrors.length >= 1, 'inject failure must be logged via console.error')
  assert.ok(
    String(injectErrors[0][0]).includes('[dsh-game-sudoku]'),
    'console.error must use the [dsh-game-sudoku] prefix, got ' + String(injectErrors[0][0]),
  )

  const registerCase = createCtx({ registerThrows: true })
  const registerErrors = captureConsoleError(() => {
    plugin.apply(registerCase.ctx) // register throws inside inject callback -> must be caught
  })
  assert.ok(registerErrors.length >= 1, 'register failure must be logged via console.error')
  assert.ok(String(registerErrors[0][0]).includes('[dsh-game-sudoku]'))
})

runner.check('apply() is a no-op when the host never installs game.stage (inject not called)', () => {
  const ctx = {
    slots: {
      inject() {
        // host absent: inject callback never invoked
      },
      register() {
        throw new Error('register must not be called when the host is absent')
      },
    },
  }
  plugin.apply(ctx) // must not throw
})

// ---------------------------------------------------------------------------
// 3. test seam: present with flag only
// ---------------------------------------------------------------------------
const SEAM_FUNCTIONS = [
  'createRng',
  'generatePuzzle',
  'countSolutions',
  'solve',
  'computeConflicts',
  'countEmpty',
  'isSolved',
  'hasProgress',
  'createState',
  'loadSavedState',
  'saveState',
  'serializeState',
  'sanitizeSave',
  'formatTime',
  'selectCell',
  'moveSelection',
  'toggleNotesMode',
  'applyDigit',
  'eraseCell',
  'undoMove',
  'restartPuzzle',
  'newPuzzle',
  'timerResume',
  'timerPause',
  'timerElapsed',
  'getSnapshot',
]

runner.check('seam exposes every documented function when the test flag is set', () => {
  must(loaded.api, 'window.__DSH_GAME_SUDOKU__ must exist with __DSH_GAME_SUDOKU_TEST__ = true')
  const missing = SEAM_FUNCTIONS.filter((name) => typeof loaded.api[name] !== 'function')
  assert.deepEqual(missing, [], 'missing seam functions: ' + missing.join(', '))
  EVIDENCE.seamFunctions = SEAM_FUNCTIONS.length
})

runner.check('seam constants match the frozen spec (§2)', () => {
  const api = loaded.api
  assert.equal(api.GAME_ID, 'sudoku')
  assert.equal(api.STORE_KEY, 'dsh.game.sudoku.v1')
  assert.equal(api.SCHEMA_VERSION, 1)
  assert.equal(api.GRID, 9)
  assert.equal(api.CELLS, 81)
  assert.equal(api.DEFAULT_DIFFICULTY, 'normal')
  assert.equal(api.UNDO_LIMIT, 300)
  assert.equal(api.DIFFICULTIES.easy.key, 'easy')
  assert.equal(api.DIFFICULTIES.easy.label, '简单')
  assert.equal(api.DIFFICULTIES.easy.givens, 40)
  assert.equal(api.DIFFICULTIES.normal.key, 'normal')
  assert.equal(api.DIFFICULTIES.normal.label, '普通')
  assert.equal(api.DIFFICULTIES.normal.givens, 34)
  assert.equal(api.DIFFICULTIES.hard.key, 'hard')
  assert.equal(api.DIFFICULTIES.hard.label, '困难')
  assert.equal(api.DIFFICULTIES.hard.givens, 28)
  EVIDENCE.difficulties = {
    easy: api.DIFFICULTIES.easy.givens,
    normal: api.DIFFICULTIES.normal.givens,
    hard: api.DIFFICULTIES.hard.givens,
  }
})

function runBundleInVm(flagValue) {
  const storage = createStorage()
  const definitions = []
  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        definitions.push(definition)
      },
    },
    localStorage: storage,
  }
  if (flagValue !== undefined) windowStub.__DSH_GAME_SUDOKU_TEST__ = flagValue
  const sandbox = {
    window: windowStub,
    localStorage: storage,
    document: createDocumentStub(),
    performance: { now: () => 0 },
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  }
  const context = vm.createContext(sandbox)
  new vm.Script(code, { filename: 'client.js' }).runInContext(context)
  return { window: windowStub, definitions }
}

runner.check('fresh vm context WITHOUT the flag installs no global seam', () => {
  const result = runBundleInVm(undefined)
  assert.equal(result.definitions.length, 1, 'bundle must still load/register without the test flag')
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.window, '__DSH_GAME_SUDOKU__'),
    false,
    'window.__DSH_GAME_SUDOKU__ must NOT exist without the flag',
  )
  assert.equal(result.window.__DSH_GAME_SUDOKU__, undefined)
})

runner.check('fresh vm context with a merely truthy flag (1) installs no seam: only === true counts', () => {
  const result = runBundleInVm(1)
  assert.equal(Object.prototype.hasOwnProperty.call(result.window, '__DSH_GAME_SUDOKU__'), false)
})

runner.check('fresh vm context WITH __DSH_GAME_SUDOKU_TEST__ === true installs the seam', () => {
  const result = runBundleInVm(true)
  assert.equal(Object.prototype.hasOwnProperty.call(result.window, '__DSH_GAME_SUDOKU__'), true)
  assert.equal(typeof result.window.__DSH_GAME_SUDOKU__.generatePuzzle, 'function')
  assert.equal(result.definitions[0].id, manifest.name)
})

runner.check('seam installed via Object.defineProperty behind the flag (static)', () => {
  requireLiteral('seam flag guard', 'window.__DSH_GAME_SUDOKU_TEST__')
  must(/window\.__DSH_GAME_SUDOKU_TEST__\s*===\s*true/.test(code), 'guard must be `window.__DSH_GAME_SUDOKU_TEST__ === true`')
  requireLiteral('seam defineProperty', 'Object.defineProperty', 'seamDefinePropertyLine')
  must(/window\.__DSH_GAME_SUDOKU__\s*=/.test(code) === false, 'seam must be installed with defineProperty, not assignment')
  const guardIndex = code.indexOf('window.__DSH_GAME_SUDOKU_TEST__ === true')
  const defineIndex = code.indexOf("'__DSH_GAME_SUDOKU__'")
  must(guardIndex !== -1 && defineIndex > guardIndex, 'defineProperty call must live inside the flag branch')
  EVIDENCE.seamFlagGuardLine = lineOfIndex(guardIndex)
})

// ---------------------------------------------------------------------------
// 4. static UI / bundle hygiene (api-spec §7, §8, §9)
// ---------------------------------------------------------------------------
runner.check('bundle is a single strict-mode IIFE and loads through __ModuleLoader__', () => {
  requirePattern('IIFE wrapper', /\(function\s*\(\)\s*\{[\s\S]{0,200}?['"]use strict['"]/)
  requirePattern('module loader call', /window\.__ModuleLoader__\.load\s*\(/)
  requirePattern('loader id', /id\s*:\s*['"]@local\/dsh-game-sudoku['"]/)
  requirePattern('loader factory', /factory\s*\(\s*require\s*\)\s*\{/)
  assert.ok(!/^\s*(import|export)\s/m.test(code), 'client.js must not use ESM import/export statements')
  EVIDENCE.usesESM = false
})

runner.check('no third-party imports / no local requires (React from the module table only)', () => {
  const requires = []
  const requirePatternRe = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g
  let match
  while ((match = requirePatternRe.exec(code)) !== null) requires.push(match[2])
  must(requires.length >= 1, 'factory should require React at least once')
  const bad = requires.filter((id) => id !== 'react')
  assert.deepEqual(bad, [], 'only require("react") is allowed, found: ' + JSON.stringify(bad))
  assert.ok(!/import\s*\(/.test(code), 'no dynamic import() allowed')
  assert.ok(!/\bfetch\s*\(/.test(code), 'no network access expected')
  assert.ok(!/from\s+['"][^'"]+['"]/.test(code), 'no ESM import-from statements')
  EVIDENCE.requires = Array.from(new Set(requires))
})

runner.check('no global window/document keydown listener; keyboard handled on the component root', () => {
  must(
    !/(?:window|document|globalThis)\s*\.\s*addEventListener\s*\(\s*['"`]keydown/.test(code),
    'forbidden: window/document.addEventListener("keydown") per contract §6 and api-spec §8',
  )
  const hasRootHandler = /onKeyDown/.test(code) || /addEventListener\s*\(\s*['"`]keydown/.test(code)
  must(hasRootHandler, 'expected an onKeyDown handler on the component root (or an element-level keydown listener)')
  requirePattern('preventDefault usage', /preventDefault\s*\(/)
  requirePattern('Escape handling literal', /Escape/)
  requirePattern('Backspace/Delete handling', /Backspace|Delete/)
  requirePattern('Ctrl/Meta+Z undo shortcut', /ctrlKey|metaKey|Ctrl\+Z|Meta\+Z/)
  requirePattern('input/textarea guard', /INPUT|TEXTAREA|SELECT/)
  EVIDENCE.rootKeyboardHandler = /onKeyDown/.test(code)
})

runner.check('root element styling: 100%x100%, token colors, border-box, tabIndex 0', () => {
  // data-dsh-game may be a literal or the GAME_ID constant (which must be 'sudoku').
  requirePattern(
    "root data-dsh-game='sudoku'",
    /['"]data-dsh-game['"]\s*:\s*(['"]sudoku['"]|GAME_ID\b)/,
    'rootDataAttrLine',
  )
  must(/GAME_ID\s*=\s*['"]sudoku['"]/.test(code), "GAME_ID must be 'sudoku' when used as the data-dsh-game value")
  requirePattern('root width 100%', /width\s*:\s*['"]100%['"]/)
  requirePattern('root height 100%', /height\s*:\s*['"]100%['"]/)
  requirePattern('root box-sizing border-box', /boxSizing\s*:\s*['"]border-box['"]/)
  requirePattern('root token background', /var\(--dsw-alias-bg-base\)/)
  requirePattern('root token color', /var\(--dsw-alias-label-primary\)/)
  requirePattern('root tabIndex 0', /tabIndex\s*:\s*0/)
  requirePattern('root outline none', /outline\s*:\s*['"]none['"]/)
  requirePattern('root mount focus', /\.focus\s*\(/)
  requireLiteral('title text 数独', '数独')
  requireLiteral('difficulty labels 简单', '简单')
  requireLiteral('difficulty labels 普通', '普通')
  requireLiteral('difficulty labels 困难', '困难')
})

runner.check('all required data-* hooks are present (cells, board, digits, actions, overlays, roles)', () => {
  const hooks = [
    'data-sudoku-board',
    'data-cell',
    'data-given',
    'data-value',
    'data-selected',
    'data-peer',
    'data-conflict',
    'data-digit',
    'data-action',
    'data-overlay',
    'data-role',
    'data-difficulty',
  ]
  const missing = hooks.filter((hook) => code.indexOf(hook) === -1)
  assert.deepEqual(missing, [], 'missing data hooks: ' + missing.join(', '))
  const actionValues = ['notes', 'undo', 'restart', 'erase', 'dismiss-win', 'confirm', 'cancel']
  const missingActions = actionValues.filter((value) => code.indexOf(value) === -1)
  assert.deepEqual(missingActions, [], 'missing action literals: ' + missingActions.join(', '))
  const overlayValues = ['win', 'confirm', 'error']
  const missingOverlays = overlayValues.filter((value) => code.indexOf(value) === -1)
  assert.deepEqual(missingOverlays, [], 'missing overlay literals: ' + missingOverlays.join(', '))
  for (const role of ['timer', 'remaining', 'too-small']) {
    assert.ok(code.indexOf(role) !== -1, 'missing data-role literal ' + role)
  }
  EVIDENCE.dataHooks = hooks.length
  EVIDENCE.dataHooksMissing = 0
})

runner.check('keyboard/ARIA accessibility helpers and Chinese UI copy are present', () => {
  for (const literal of ['aria-pressed', 'aria-label', '再来一局', '窗口太小', '请放大游戏区域', '用时', '草稿']) {
    assert.ok(code.indexOf(literal) !== -1, 'missing UI literal ' + JSON.stringify(literal))
  }
  requirePattern('button type', /type\s*:\s*['"]button['"]|type="button"/)
  EVIDENCE.uiCopyChecked = 7
})

runner.check('too-small thresholds 320x240 are implemented', () => {
  requirePattern('threshold 320', /320/)
  requirePattern('threshold 240', /240/)
})

runner.check('ResizeObserver watches root + board area; resize listener allowed for zoom', () => {
  const observerInstances = (code.match(/new\s+ResizeObserver/g) || []).length
  const observeCalls = (code.match(/\.observe\s*\(/g) || []).length
  assert.ok(observerInstances >= 1, 'expected at least one ResizeObserver')
  assert.ok(observeCalls >= 2, 'expected the root element and the board area to be observed, got ' + observeCalls)
  assert.ok(/addEventListener\s*\(\s*['"]resize['"]/.test(code), 'expected a window resize listener for zoom re-layout')
  assert.ok(!/window\.innerWidth|window\.innerHeight/.test(code), 'api-spec §9: do not read window.innerWidth/innerHeight')
  EVIDENCE.resizeObserverInstances = observerInstances
})

runner.check('timer + visibilitychange + persistence wiring present', () => {
  requirePattern('setInterval 500ms', /setInterval\s*\(/)
  requirePattern('clearInterval cleanup', /clearInterval\s*\(/)
  requirePattern('visibilitychange listener', /visibilitychange/)
  requirePattern('removeEventListener cleanup', /removeEventListener\s*\(/)
  requirePattern('ResizeObserver disconnect cleanup', /\.disconnect\s*\(/)
  requirePattern('timerResume usage', /timerResume\s*\(/)
  requirePattern('timerPause usage', /timerPause\s*\(/)
  requirePattern('saveState usage', /saveState\s*\(/)
  requirePattern('loadSavedState usage', /loadSavedState\s*\(/)
  requirePattern('formatTime usage', /formatTime\s*\(/)
})

runner.check('no canvas rendering (DOM grid required by api-spec §7)', () => {
  assert.ok(!/createElement\s*\(\s*['"]canvas['"]/.test(code), 'canvas must not be used')
  assert.ok(!/getContext\s*\(/.test(code), 'getContext must not be used')
})

runner.check('every console.error call carries the [dsh-game-sudoku] prefix', () => {
  const positions = []
  let from = 0
  let index
  while ((index = code.indexOf('console.error(', from)) !== -1) {
    positions.push(index)
    from = index + 1
  }
  assert.ok(positions.length >= 1, 'expected at least one guarded console.error in registration')
  const offenders = []
  for (const position of positions) {
    const chunk = code.slice(position, position + 260)
    if (chunk.indexOf('[dsh-game-sudoku]') === -1) offenders.push(lineOfIndex(position))
  }
  assert.deepEqual(offenders, [], 'console.error without prefix on lines: ' + offenders.join(', '))
  EVIDENCE.consoleErrorCount = positions.length
})

runner.check('registration is wrapped in try/catch and MATCHED is frozen once', () => {
  const injectIndex = code.indexOf('ctx.slots.inject')
  must(injectIndex !== -1, 'ctx.slots.inject call missing')
  const before = code.slice(Math.max(0, injectIndex - 400), injectIndex)
  must(/try\s*\{/.test(before), 'registration must be wrapped in try/catch')
  const freezes = (code.match(/Object\.freeze\s*\(\s*\{\s*\}\s*\)/g) || []).length
  assert.equal(freezes, 1, 'MATCHED = Object.freeze({}) must be created exactly once (found ' + freezes + ')')
  requirePattern('MATCHED constant', /MATCHED\s*=\s*Object\.freeze/)
  const selects = (code.match(/select\s*:\s*/g) || []).length
  assert.equal(selects, 1, 'exactly one select: entry expected (found ' + selects + ')')
})

runner.check('spec constants appear literally in the bundle', () => {
  requireLiteral('store key', 'dsh.game.sudoku.v1')
  requirePattern('SCHEMA_VERSION 1', /SCHEMA_VERSION\s*=\s*1/)
  requirePattern('UNDO_LIMIT 300', /UNDO_LIMIT\s*=\s*300/)
  requirePattern('GAME_ID sudoku', /GAME_ID\s*=\s*['"]sudoku['"]/)
})

runner.check('mount restores a valid save and only generates when there is none (static review)', () => {
  const sessionIndex = code.indexOf('function createSession')
  must(sessionIndex !== -1, 'expected a createSession/bootstrap function')
  const sessionText = code.slice(sessionIndex, sessionIndex + 1200)
  const loadIndex = sessionText.indexOf('loadSavedState()')
  const createIndex = sessionText.indexOf('createState(')
  must(loadIndex !== -1, 'createSession must call loadSavedState()')
  must(createIndex !== -1, 'createSession must be able to create a new state')
  must(loadIndex < createIndex, 'loadSavedState() must be attempted before createState()')
  must(/if\s*\(\s*restored\s*\)/.test(sessionText), 'the restored save must be preferred via an `if (restored)` branch')
  must(
    /state:\s*restored/.test(sessionText),
    'the restored state must be returned as-is (never regenerated)',
  )
  EVIDENCE.createSessionLine = lineOfIndex(sessionIndex)
})

runner.check('unmount cleanup stops timers/listeners/observers and saves the current game (static review)', () => {
  const cleanupIndex = code.indexOf('return function cleanup')
  must(cleanupIndex !== -1, 'expected a useEffect cleanup function')
  const cleanupText = code.slice(cleanupIndex, cleanupIndex + 2000)
  const required = [
    ['clearInterval', /clearInterval\s*\(/],
    ['removeEventListener', /removeEventListener\s*\(/],
    ['ResizeObserver.disconnect', /\.disconnect\s*\(/],
    ['timerPause', /timerPause\s*\(/],
    ['saveState', /saveState\s*\(/],
  ]
  for (const [label, pattern] of required) {
    must(pattern.test(cleanupText), 'cleanup must call ' + label)
  }
  EVIDENCE.cleanupLine = lineOfIndex(cleanupIndex)
})

// ---------------------------------------------------------------------------
// 5. no modifications outside the sudoku package
// ---------------------------------------------------------------------------
runner.check('no file outside packages/dsh-game-sudoku was modified during the task', () => {
  const baselinePath = join(AUDIT_DIR, '_baseline-outside-sudoku.json')
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const changed = []
  const missing = []
  for (const [relPath, expectedHash] of Object.entries(baseline)) {
    const absolute = join(ROOT, relPath)
    if (!existsSync(absolute)) {
      missing.push(relPath)
      continue
    }
    const hash = createHash('sha256').update(readFileSync(absolute)).digest('hex').toUpperCase()
    if (hash !== expectedHash) changed.push(relPath)
  }
  assert.deepEqual(changed, [], 'modified files outside the sudoku package: ' + changed.join(', '))
  assert.deepEqual(missing, [], 'files outside the sudoku package disappeared: ' + missing.join(', '))
  EVIDENCE.outsidePackageFilesChecked = Object.keys(baseline).length
})

// ---------------------------------------------------------------------------
// done
// ---------------------------------------------------------------------------
runner.check('seam object returned by the loader equals window.__DSH_GAME_SUDOKU__', () => {
  must(loaded.window.__DSH_GAME_SUDOKU__ === loaded.api)
})

const summary = runner.summary()
for (const [key, value] of Object.entries(EVIDENCE)) {
  if (value !== undefined) console.log('EVIDENCE ' + key + ' ' + JSON.stringify(value))
}
console.log('RESULT contract audit ' + JSON.stringify(summary))
