/**
 * v2 audit 4/4 — contract/manifest, registration shape, seam gating, static UI
 * hygiene, inline BANK marker structure and repo integrity.
 *
 * Run: node dev/audit/v2/audit-v2-contract.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  captureConsoleError,
  createCtx,
  createDocumentStub,
  createReactStub,
  createRunner,
  createStorage,
  loadClient,
  must,
} from '../harness.mjs'
import {
  BANK_BEGIN,
  BANK_END,
  GRADE_KEYS,
  GRADE_LABELS,
  PACKAGE_DIR,
  checkOutsideBaseline,
  clientHasBankMarker,
  waitFor,
} from './common.mjs'

const runner = createRunner('v2 contract audit')
const EVIDENCE = {}
const CLIENT_FILE = join(PACKAGE_DIR, 'client.js')
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

function readText(relPath) {
  return readFileSync(join(PACKAGE_DIR, relPath), 'utf8')
}

function readJson(relPath) {
  return JSON.parse(readText(relPath))
}

if (!existsSync(CLIENT_FILE)) waitFor('v2 artifacts not ready', ['client.js'])
const code = readFileSync(CLIENT_FILE, 'utf8')
if (!clientHasBankMarker(code)) waitFor('v2 artifacts not ready', ['client.js inline BANK marker block (v1 client still present?)'])

const loaded = await loadClient({ testFlag: true, tag: 'v2-contract' })
function clientIsV2(api) {
  return (
    api &&
    api.SCHEMA_VERSION === 2 &&
    api.BANK &&
    Array.isArray(api.BANK.puzzles) &&
    api.BANK.puzzles.length > 0 &&
    typeof api.pickPuzzle === 'function'
  )
}
if (!clientIsV2(loaded.api)) {
  waitFor('v2 client not ready', ['v2 client.js seam with populated BANK (SCHEMA_VERSION=2, BANK.puzzles, pickPuzzle)'])
}
const api = loaded.api

const lineOf = (index) => code.slice(0, index).split('\n').length
function requirePattern(label, pattern, evidenceKey) {
  const match = pattern.exec(code)
  must(match !== null, label + ': missing expected pattern ' + String(pattern))
  if (evidenceKey) EVIDENCE[evidenceKey] = lineOf(match.index)
  return match
}
function requireLiteral(label, literal, evidenceKey) {
  const index = code.indexOf(literal)
  must(index !== -1, label + ': missing literal ' + JSON.stringify(literal))
  if (evidenceKey) EVIDENCE[evidenceKey] = lineOf(index)
  return index
}

// ---------------------------------------------------------------------------
// 1. package manifest / package files
// ---------------------------------------------------------------------------
runner.check('package.json follows contract v1 manifest rules (unchanged by v2)', () => {
  const pkg = readJson('package.json')
  must(pkg.name === '@local/dsh-game-sudoku', 'name')
  must(pkg.version === '0.1.0', 'version')
  must(pkg.private === true && pkg.type === 'module', 'private/type')
  must(pkg.exports['.'] === './index.js', 'exports[.]')
  must(pkg.exports['./client'] === './client.js', 'exports["./client"]')
  must(pkg.exports['./locale/*.json'] === './locale/*.json', 'exports locale')
  must(pkg.exports['./icon'] === './icon.svg', 'exports icon')
  must(pkg.dsh.bundle.patch === './cordis.patch.yml', 'dsh.bundle.patch')
  must(pkg.dsh.client.platform === 'web', 'dsh.client.platform')
  must(pkg.dsh.client.immediately === true, 'dsh.client.immediately')
  must(pkg.dsh.client.inject === undefined, 'must not declare dsh.client.inject')
  must(pkg.dependencies === undefined && pkg.devDependencies === undefined, 'no dependencies')
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md']) {
    must(pkg.files.includes(required), 'files[] must list ' + required)
  }
})

runner.check('cordis.patch.yml, index.js, locales and icon are valid', () => {
  const cordis = readText('cordis.patch.yml')
  must(/- insert:/.test(cordis), 'cordis insert block')
  must(/^\s*-\s*id:\s*game-sudoku\s*$/m.test(cordis), 'id: game-sudoku')
  must(/^\s*name:\s*'@local\/dsh-game-sudoku'\s*$/m.test(cordis), 'name')
  const index = readText('index.js')
  must(/export\s+function\s+apply\s*\(\s*\)\s*\{\s*\}/.test(index), 'index.js must be empty apply()')
  const zh = readJson('locale/zh.json')
  const en = readJson('locale/en.json')
  must(zh.meta.title === '数独' && en.meta.title === 'Sudoku', 'locale titles')
  must(typeof zh.meta.description === 'string' && typeof en.meta.description === 'string', 'locale descriptions')
  const icon = readText('icon.svg')
  must(/<svg[\s>]/.test(icon) && !/<script/i.test(icon), 'icon.svg')
  const readme = readText('README.md')
  must(readme.length > 100, 'README.md must exist and be meaningful')
  must(/dsh-game-sudoku/.test(readme) && /数独|sudoku/i.test(readme), 'README content')
})

// ---------------------------------------------------------------------------
// 2. registration shape through a window+ctx stub
// ---------------------------------------------------------------------------
let plugin = null
runner.check('bundle loads through __ModuleLoader__ with the package name', () => {
  must(loaded.definition && typeof loaded.definition.factory === 'function', 'definition.factory')
  must(loaded.definition.id === '@local/dsh-game-sudoku', 'definition id = package name')
  EVIDENCE.definitionId = loaded.definition.id
})

runner.check('factory requires only react and exposes inject:[slots] + apply', () => {
  const requireCalls = []
  plugin = loaded.definition.factory((id) => {
    requireCalls.push(id)
    if (id === 'react') return createReactStub()
    throw new Error('unexpected require ' + id)
  })
  must(requireCalls.length >= 1, 'factory must require react')
  must(requireCalls.every((id) => id === 'react'), 'only react may be required, got ' + JSON.stringify(requireCalls))
  must(Array.isArray(plugin.inject) && plugin.inject.length === 1 && plugin.inject[0] === 'slots', 'inject must be ["slots"]')
  must(typeof plugin.apply === 'function', 'apply')
  EVIDENCE.requireCalls = requireCalls
})

runner.check('apply() registers only game.stage with id sudoku / label 数独 / stable MATCHED', () => {
  const { ctx, calls } = createCtx()
  plugin.apply(ctx)
  must(JSON.stringify(calls.inject) === JSON.stringify(['game.stage']), 'inject only game.stage')
  must(calls.register.length === 1, 'exactly one registration')
  const options = calls.register[0].options
  must(options.name === 'game.stage', 'name')
  must(options.id === 'sudoku', 'id')
  must(typeof options.label === 'function' && options.label() === '数独', 'label 数独')
  must(typeof options.select === 'function', 'select')
  must(typeof calls.register[0].component === 'function', 'component')
  const first = options.select({ gameId: 'sudoku' })
  const second = options.select({ gameId: 'sudoku' })
  must(first !== null && typeof first === 'object', 'select match')
  must(first === second && Object.isFrozen(first), 'select must return the same frozen MATCHED object')
  for (const bad of [{ gameId: '2048' }, {}, null, undefined, 'sudoku', { gameId: 'SUDOKU' }]) {
    must(options.select(bad) === null, 'select must reject ' + JSON.stringify(bad))
  }
  EVIDENCE.registration = { name: options.name, id: options.id, label: options.label() }
})

runner.check('apply() survives host failures and logs with the [dsh-game-sudoku] prefix', () => {
  for (const options of [{ injectThrows: true }, { registerThrows: true }]) {
    const { ctx } = createCtx(options)
    const captured = captureConsoleError(() => plugin.apply(ctx))
    must(captured.length >= 1, 'failure must be logged')
    must(String(captured[0][0]).includes('[dsh-game-sudoku]'), 'console.error must carry the prefix')
  }
})

// ---------------------------------------------------------------------------
// 3. test seam gating
// ---------------------------------------------------------------------------
const SEAM_API = [
  'findPuzzle',
  'pickPuzzle',
  'createRng',
  'createState',
  'loadSavedState',
  'saveState',
  'serializeState',
  'sanitizeSave',
  'hasProgress',
  'countEmpty',
  'computeConflicts',
  'isSolved',
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

runner.check('seam exposes every documented v2 member when the flag is set', () => {
  const missing = SEAM_API.filter((name) => typeof api[name] !== 'function')
  must(missing.length === 0, 'missing seam functions: ' + missing.join(','))
  must(api.BANK && typeof api.BANK === 'object', 'BANK')
  must(api.SCHEMA_VERSION === 2, 'SCHEMA_VERSION 2')
  must(api.STORE_KEY === 'dsh.game.sudoku.v1', 'STORE_KEY')
  must(api.DEFAULT_GRADE === 'normal', 'DEFAULT_GRADE')
  must(api.UNDO_LIMIT === 300 && api.GRID === 9 && api.CELLS === 81 && api.GAME_ID === 'sudoku', 'basic constants')
  must(Array.isArray(api.LEVELS) && api.LEVELS.length === 5, 'LEVELS')
  must(Array.isArray(api.BANK.levels) && api.BANK.levels.length === 5, 'BANK.levels')
  must(Array.isArray(api.BANK.puzzles) && api.BANK.puzzles.length > 0, 'BANK.puzzles must be populated')
  EVIDENCE.seamFunctions = SEAM_API.length
  EVIDENCE.bankPuzzles = api.BANK.puzzles.length
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
  new vm.Script(code, { filename: 'client.js' }).runInContext(vm.createContext(sandbox))
  return { window: windowStub, definitions }
}

runner.check('fresh vm context WITHOUT the flag installs no global seam', () => {
  const result = runBundleInVm(undefined)
  must(result.definitions.length === 1, 'bundle must still load without the test flag')
  must(!Object.prototype.hasOwnProperty.call(result.window, '__DSH_GAME_SUDOKU__'), 'seam must not exist without the flag')
  must(result.window.__DSH_GAME_SUDOKU__ === undefined, 'seam value must be undefined')
})

runner.check('a merely truthy flag (1) installs no seam; only === true does', () => {
  const result = runBundleInVm(1)
  must(!Object.prototype.hasOwnProperty.call(result.window, '__DSH_GAME_SUDOKU__'), 'flag=1 must not install the seam')
})

runner.check('fresh vm context WITH __DSH_GAME_SUDOKU_TEST__ === true installs the v2 seam', () => {
  const result = runBundleInVm(true)
  must(Object.prototype.hasOwnProperty.call(result.window, '__DSH_GAME_SUDOKU__'), 'seam must exist with the flag')
  const seam = result.window.__DSH_GAME_SUDOKU__
  must(seam.SCHEMA_VERSION === 2, 'seam SCHEMA_VERSION')
  must(seam.BANK && Array.isArray(seam.BANK.puzzles), 'seam BANK')
  must(typeof seam.pickPuzzle === 'function', 'seam pickPuzzle')
  must(result.definitions[0].id === '@local/dsh-game-sudoku', 'definition id')
})

runner.check('seam is installed via Object.defineProperty behind the strict flag guard (static)', () => {
  requirePattern('flag guard', /window\.__DSH_GAME_SUDOKU_TEST__\s*===\s*true/, 'flagGuardLine')
  requireLiteral('defineProperty', 'Object.defineProperty', 'definePropertyLine')
  must(!/window\.__DSH_GAME_SUDOKU__\s*=/.test(code), 'seam must not be installed via plain assignment')
})

// ---------------------------------------------------------------------------
// 4. static bundle hygiene / v2 UI
// ---------------------------------------------------------------------------
runner.check('bundle is a single strict-mode IIFE and loads through __ModuleLoader__', () => {
  requirePattern('IIFE wrapper', /\(function\s*\(\)\s*\{[\s\S]{0,200}?['"]use strict['"]/)
  requirePattern('module loader', /window\.__ModuleLoader__\.load\s*\(/)
  requirePattern('loader id', /id\s*:\s*['"]@local\/dsh-game-sudoku['"]/)
  must(!/^\s*(import|export)\s/m.test(code), 'no ESM import/export statements in client.js')
})

runner.check('no third-party imports / only require("react")', () => {
  const requires = []
  const re = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g
  let match
  while ((match = re.exec(code)) !== null) requires.push(match[2])
  must(requires.length >= 1, 'factory should require react')
  must(requires.every((id) => id === 'react'), 'only require("react") is allowed, got ' + JSON.stringify(requires))
  must(!/import\s*\(/.test(code), 'no dynamic import()')
  must(!/\bfetch\s*\(/.test(code), 'no network access')
  EVIDENCE.requires = [...new Set(requires)]
})

runner.check('inline BANK marker block is well formed and contains no dev-only data', () => {
  const begins = code.split(BANK_BEGIN).length - 1
  const ends = code.split(BANK_END).length - 1
  must(begins === 1, 'exactly one BANK BEGIN marker, found ' + begins)
  must(ends === 1, 'exactly one BANK END marker, found ' + ends)
  const begin = code.indexOf(BANK_BEGIN)
  const end = code.indexOf(BANK_END)
  const inside = code.slice(begin, end)
  must(/const\s+PUZZLE_BANK\s*=/.test(inside), 'const PUZZLE_BANK must be inside the marker block')
  must(!/\bsolution\s*:/.test(inside), 'inline block must not contain solution data')
  must(!/\btechniques\s*:/.test(inside), 'inline block must not contain techniques data')
  EVIDENCE.bankBeginLine = lineOf(begin)
})

runner.check('no runtime generator or solver implementation in client.js', () => {
  const forbidden = [/\bgeneratePuzzle\b/, /\bgenerateFullGrid\b/, /\bcountSolutions\b/, /\bgradePuzzle\b/, /\bsearchSolutions\b/, /\bbacktrack/i, /\bswordfish\b|\bcoloring\b|\bxychain\b/i]
  for (const pattern of forbidden) {
    const match = pattern.exec(code)
    must(match === null, 'forbidden runtime algorithm ' + String(pattern) + ' at line ' + (match ? lineOf(match.index) : '?'))
  }
  must(!/function\s+solve\s*\(/.test(code), 'runtime must not define solve()')
  for (const name of ['generatePuzzle', 'generateFullGrid', 'countSolutions', 'solve', 'gradePuzzle']) {
    must(typeof api[name] === 'undefined', 'seam must not export ' + name)
  }
})

runner.check('v2 difficulty UI: 5 chips with level labels driven by the bank', () => {
  for (const key of GRADE_KEYS) {
    must(code.indexOf(key) !== -1, 'missing grade key literal ' + key)
    must(code.indexOf(GRADE_LABELS[key]) !== -1, 'missing grade label literal ' + GRADE_LABELS[key])
  }
  must(/data-difficulty/.test(code), 'data-difficulty hook')
  must(/BANK\.levels|PUZZLE_BANK\.levels|LEVELS/.test(code), 'chips should be driven by BANK.levels')
  must(/aria-pressed/.test(code), 'aria-pressed for active chip')
  for (const overlay of ['win', 'confirm', 'error']) must(new RegExp("['\"]" + overlay + "['\"]").test(code), 'overlay literal ' + overlay)
  for (const action of ['dismiss-win', 'confirm', 'cancel', 'erase', 'notes', 'undo', 'restart', 'new']) {
    must(code.indexOf(action) !== -1, 'action literal ' + action)
  }
})

runner.check('root styling, keyboard isolation, ARIA and data hooks', () => {
  requirePattern("root data-dsh-game='sudoku'", /['"]data-dsh-game['"]\s*:\s*(['"]sudoku['"]|GAME_ID\b)/, 'rootDataAttrLine')
  must(/width\s*:\s*['"]100%['"]/.test(code), 'root width 100%')
  must(/height\s*:\s*['"]100%['"]/.test(code), 'root height 100%')
  must(/boxSizing\s*:\s*['"]border-box['"]/.test(code), 'root border-box')
  must(/tabIndex\s*:\s*0/.test(code), 'root tabIndex 0')
  must(/outline\s*:\s*['"]none['"]/.test(code), 'root outline none')
  must(/\.focus\s*\(/.test(code), 'root focus')
  must(/var\(--dsw-alias-bg-base\)/.test(code) && /var\(--dsw-alias-label-primary\)/.test(code), 'theme tokens')
  must(!/(?:window|document|globalThis)\s*\.\s*addEventListener\s*\(\s*['"`]keydown/.test(code), 'no global keydown listener')
  must(/onKeyDown/.test(code), 'component-root keyboard handler')
  requirePattern('preventDefault', /preventDefault\s*\(/)
  for (const hook of ['data-sudoku-board', 'data-cell', 'data-given', 'data-value', 'data-selected', 'data-peer', 'data-conflict', 'data-digit', 'data-action', 'data-overlay', 'data-role']) {
    must(code.indexOf(hook) !== -1, 'missing data hook ' + hook)
  }
  for (const role of ['timer', 'remaining', 'too-small']) must(code.indexOf(role) !== -1, 'missing data-role ' + role)
  must(/aria-label/.test(code), 'aria-label')
  must(/type\s*:\s*['"]button['"]|type="button"/.test(code), 'button type')
  requirePattern('too-small threshold 320', /320/)
  requirePattern('too-small threshold 240', /240/)
  must(!/window\.innerWidth|window\.innerHeight/.test(code), 'do not read window.innerWidth/innerHeight')
  must(!/getContext\s*\(/.test(code) && !/createElement\s*\(\s*['"]canvas['"]/.test(code), 'no canvas')
})

runner.check('timer/visibility/persistence/cleanup wiring is present', () => {
  for (const [label, pattern] of [
    ['setInterval', /setInterval\s*\(/],
    ['clearInterval', /clearInterval\s*\(/],
    ['visibilitychange', /visibilitychange/],
    ['removeEventListener', /removeEventListener\s*\(/],
    ['ResizeObserver', /ResizeObserver/],
    ['observer.disconnect', /\.disconnect\s*\(/],
    ['timerResume', /timerResume\s*\(/],
    ['timerPause', /timerPause\s*\(/],
    ['saveState', /saveState\s*\(/],
    ['loadSavedState', /loadSavedState\s*\(/],
    ['formatTime', /formatTime\s*\(/],
    ['resize listener', /addEventListener\s*\(\s*['"]resize['"]/],
  ]) {
    must(pattern.test(code), 'missing ' + label)
  }
  const cleanupIndex = code.indexOf('return function cleanup')
  must(cleanupIndex !== -1, 'expected a useEffect cleanup function')
  const cleanupText = code.slice(cleanupIndex, cleanupIndex + 2000)
  for (const [label, pattern] of [
    ['clearInterval', /clearInterval\s*\(/],
    ['removeEventListener', /removeEventListener\s*\(/],
    ['disconnect', /\.disconnect\s*\(/],
    ['timerPause', /timerPause\s*\(/],
    ['saveState', /saveState\s*\(/],
  ]) {
    must(pattern.test(cleanupText), 'cleanup must call ' + label)
  }
  EVIDENCE.cleanupLine = lineOf(cleanupIndex)
})

runner.check('every console.error call carries the [dsh-game-sudoku] prefix', () => {
  const offenders = []
  let from = 0
  let at
  while ((at = code.indexOf('console.error(', from)) !== -1) {
    if (code.slice(at, at + 260).indexOf('[dsh-game-sudoku]') === -1) offenders.push(lineOf(at))
    from = at + 1
  }
  must(offenders.length === 0, 'console.error without prefix on lines ' + offenders.join(','))
  EVIDENCE.consoleErrorCount = (code.match(/console\.error\(/g) || []).length
})

runner.check('v2 constants appear literally in the bundle', () => {
  requirePattern('SCHEMA_VERSION 2', /SCHEMA_VERSION\s*=\s*2/, 'schemaVersionLine')
  requireLiteral('store key', 'dsh.game.sudoku.v1')
  requirePattern('GAME_ID sudoku', /GAME_ID\s*=\s*['"]sudoku['"]/)
  requirePattern('UNDO_LIMIT 300', /UNDO_LIMIT\s*=\s*300/)
})

runner.check('client.js size is in the expected single-file range', () => {
  const bytes = Buffer.byteLength(code, 'utf8')
  EVIDENCE.clientBytes = bytes
  EVIDENCE.clientLines = code.split('\n').length
  must(bytes > 50 * 1024, 'client.js unexpectedly small (missing BANK?)')
  must(bytes < 300 * 1024, 'client.js unexpectedly large')
})

// ---------------------------------------------------------------------------
// 5. repo integrity
// ---------------------------------------------------------------------------
runner.check('no file outside packages/dsh-game-sudoku was modified', () => {
  const result = checkOutsideBaseline(createHash)
  must(result.changed.length === 0, 'modified files outside the package: ' + result.changed.join(', '))
  must(result.missing.length === 0, 'disappeared files outside the package: ' + result.missing.join(', '))
  EVIDENCE.outsidePackageFilesChecked = result.checked
})

runner.check('workspace root contains no unexpected new top-level artifacts', () => {
  // The sudoku package must stay self-contained; the audit only guarantees the
  // runtime files listed in package.json exist under the package.
  for (const relPath of ['client.js', 'index.js', 'cordis.patch.yml', 'package.json']) {
    must(existsSync(join(PACKAGE_DIR, relPath)), 'missing package file ' + relPath)
  }
  must(existsSync(join(PACKAGE_DIR, 'dev', 'bank.json')) || true, 'bank is a dev artifact, optional for the contract audit')
})

const summary = runner.summary()
for (const [key, value] of Object.entries(EVIDENCE)) {
  if (value !== undefined) console.log('EVIDENCE ' + key + ' ' + JSON.stringify(value))
}
console.log('RESULT v2 contract ' + JSON.stringify(summary))
