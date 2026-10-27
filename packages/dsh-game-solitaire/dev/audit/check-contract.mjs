/**
 * check-contract.mjs — static contract / manifest audit for @local/dsh-game-solitaire.
 *
 * Run: node packages/dsh-game-solitaire/dev/audit/check-contract.mjs
 * Read-only (never writes). Exit 0 = no FAILs; PENDING items are reported.
 *
 * Basis: handoff/contract/game-plugin-api.v1.md (v1 frozen) and
 *        handoff/to-sub/009-add-solitaire.md.
 * Scope: package.json, cordis.patch.yml, index.js, locale/*.json, icon.svg,
 *        client.js registration shape, save key/schema, safety greps,
 *        cross-package id/name/key conflicts, packaging hygiene.
 * NOT in scope here (dynamic tests elsewhere): rule correctness (diff-fuzz),
 * save robustness (save-fuzz), lifecycle (lifecycle.mjs).
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..', '..')
const root = join(pkgDir, '..', '..')
const PACKAGE_NAME = '@local/dsh-game-solitaire'
const GAME_ID = 'solitaire'
const STORE_KEY = 'dsh.game.solitaire.v1'

const checks = []
let passCount = 0
let pendingCount = 0
const fails = []

function check(name, condition, detail) {
  let status
  if (condition === 'PENDING') status = 'PENDING'
  else if (condition === 'NOTE') status = 'NOTE'
  else status = condition ? 'PASS' : 'FAIL'
  checks.push({ name, status, detail })
  if (status === 'PASS') passCount += 1
  else if (status === 'PENDING') pendingCount += 1
  else if (status === 'FAIL') fails.push(`${name}${detail === undefined ? '' : ' :: ' + detail}`)
}

const read = (p) => readFileSync(p, 'utf8')
const exists = (p) => existsSync(p)
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/* ------------------------------------------------------------------ *
 * 0. Required files on disk
 * ------------------------------------------------------------------ */
const CLIENT = join(pkgDir, 'client.js')
const clientExists = exists(CLIENT)
check('client.js exists', clientExists)
check(
  'README.md exists (Lead-owned; allowed to be the last file written)',
  exists(join(pkgDir, 'README.md')) ? true : 'PENDING',
  'README.md not written yet',
)

/* ------------------------------------------------------------------ *
 * 1. package.json
 * ------------------------------------------------------------------ */
let pkg = null
try {
  pkg = JSON.parse(read(join(pkgDir, 'package.json')))
  check('package.json is valid JSON', true)
} catch (error) {
  check('package.json is valid JSON', false, String(error && error.message))
}

if (pkg) {
  check(`name = ${PACKAGE_NAME}`, pkg.name === PACKAGE_NAME, pkg.name)
  check('version = 0.1.0', pkg.version === '0.1.0', pkg.version)
  check('private: true', pkg.private === true, pkg.private)
  check('type: module', pkg.type === 'module', pkg.type)
  check('description present (non-empty string)', typeof pkg.description === 'string' && pkg.description.length > 10)
  check('no dependencies', !pkg.dependencies, JSON.stringify(pkg.dependencies))
  check('no devDependencies', !pkg.devDependencies, JSON.stringify(pkg.devDependencies))
  check('no peerDependencies', !pkg.peerDependencies, JSON.stringify(pkg.peerDependencies))
  check('no optionalDependencies', !pkg.optionalDependencies, JSON.stringify(pkg.optionalDependencies))
  check('no bundledDependencies', !pkg.bundledDependencies && !pkg.bundleDependencies)
  check('no engines requirement (not needed for a browser plugin)', !pkg.engines)

  const ex = pkg.exports
  check('exports is an object', ex && typeof ex === 'object', JSON.stringify(ex))
  check('exports["."] = "./index.js"', ex && ex['.'] === './index.js', ex && ex['.'])
  check('exports["./client"] = "./client.js"', ex && ex['./client'] === './client.js', ex && ex['./client'])
  check('exports["./locale/*.json"] = "./locale/*.json"', ex && ex['./locale/*.json'] === './locale/*.json')
  check('exports["./icon"] = "./icon.svg"', ex && ex['./icon'] === './icon.svg')
  check('no stray exports keys', ex && Object.keys(ex).length === 4, ex && Object.keys(ex).join(','))

  const files = Array.isArray(pkg.files) ? pkg.files : []
  check('files is an array', Array.isArray(pkg.files))
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md']) {
    check(`files includes ${required}`, files.includes(required), files.join(','))
  }
  check('files does not include engine.js (single-file client.js per handoff)', !files.includes('engine.js'), files.join(','))
  const missing = files.filter((f) => !f.includes('*') && !exists(join(pkgDir, f)))
  check('every non-glob file listed in files exists on disk (README may be pending)', missing.length === 0 || (missing.length === 1 && missing[0] === 'README.md'), missing.join(','))
  if (missing.includes('README.md')) check('README.md pending (Lead writes it last)', 'PENDING', 'README.md missing')

  check('dsh exists', pkg.dsh && typeof pkg.dsh === 'object')
  check('dsh.bundle.patch = ./cordis.patch.yml', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', pkg.dsh && JSON.stringify(pkg.dsh.bundle))
  check('dsh.client exists', !!(pkg.dsh && pkg.dsh.client))
  check('dsh.client.platform = web', pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web')
  check('dsh.client.immediately = true', pkg.dsh && pkg.dsh.client && pkg.dsh.client.immediately === true)
  check('dsh.client.inject is absent (contract §2)', !(pkg.dsh && pkg.dsh.client && 'inject' in pkg.dsh.client), pkg.dsh && pkg.dsh.client && JSON.stringify(pkg.dsh.client))
}

/* ------------------------------------------------------------------ *
 * 2. cordis.patch.yml (+ cross-package conflicts)
 * ------------------------------------------------------------------ */
const patchPath = join(pkgDir, 'cordis.patch.yml')
let patch = ''
if (exists(patchPath)) {
  patch = read(patchPath)
  check('cordis.patch.yml starts with "- insert:"', /^-\s*insert:\s*$/m.test(patch), patch.trim())
  check(`cordis.patch.yml id = game-${GAME_ID}`, new RegExp('^\\s*-\\s*id:\\s*game-' + GAME_ID + '\\s*$', 'm').test(patch), patch.trim())
  check('cordis.patch.yml name points at this package', patch.includes(`'${PACKAGE_NAME}'`), patch.trim())
} else {
  check('cordis.patch.yml exists', false)
}

const packagesDir = join(root, 'packages')
const siblings = exists(packagesDir)
  ? readdirSync(packagesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('dsh-game-') && e.name !== 'dsh-game-host' && e.name !== 'dsh-game-solitaire')
  : []
const siblingIds = []
const siblingNames = []
const siblingKeys = new Map() // save key -> package dir
for (const entry of siblings) {
  const dir = join(packagesDir, entry.name)
  try {
    const cp = read(join(dir, 'cordis.patch.yml'))
    for (const m of cp.matchAll(/-\s*id:\s*([A-Za-z0-9_-]+)/g)) siblingIds.push(m[1])
    for (const m of cp.matchAll(/name:\s*'?([^'\s]+)'?/g)) {
      if (m[1].startsWith('@')) siblingNames.push(m[1])
    }
  } catch (error) {
    /* packages without a patch are fine to skip */
  }
  try {
    const text = read(join(dir, 'client.js'))
    for (const m of text.matchAll(/['"](dsh\.game\.[A-Za-z0-9._-]+)['"]/g)) {
      if (!siblingKeys.has(m[1])) siblingKeys.set(m[1], entry.name)
    }
  } catch (error) {
    /* no client.js yet */
  }
}
check(`cordis patch id game-${GAME_ID} is not used by a sibling package`, !siblingIds.includes(`game-${GAME_ID}`), siblingIds.join(','))
check('package name is not used by a sibling package', !siblingNames.includes(PACKAGE_NAME), siblingNames.join(','))
check(`save key ${STORE_KEY} is not used by a sibling package`, !siblingKeys.has(STORE_KEY), [...siblingKeys.keys()].join(','))

/* ------------------------------------------------------------------ *
 * 3. index.js (host half must stay empty)
 * ------------------------------------------------------------------ */
const indexPath = join(pkgDir, 'index.js')
if (exists(indexPath)) {
  const stripped = read(indexPath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim()
  check('index.js contains only `export function apply() {}`', /^export function apply\(\) \{\}$/.test(stripped), JSON.stringify(stripped))
} else {
  check('index.js exists', false)
}

/* ------------------------------------------------------------------ *
 * 4. locale/zh.json + locale/en.json
 * ------------------------------------------------------------------ */
function loadJson(path, label) {
  try {
    const value = JSON.parse(read(path))
    check(`${label} is valid JSON`, true)
    return value
  } catch (error) {
    check(`${label} is valid JSON`, false, String(error && error.message))
    return null
  }
}
const zh = loadJson(join(pkgDir, 'locale', 'zh.json'), 'locale/zh.json')
const en = loadJson(join(pkgDir, 'locale', 'en.json'), 'locale/en.json')
check('zh.json meta.title = 接龙', zh && zh.meta && zh.meta.title === '接龙', zh && zh.meta && zh.meta.title)
check('zh.json meta.description present', !!(zh && zh.meta && typeof zh.meta.description === 'string' && zh.meta.description.length > 10))
check('en.json meta.title = Solitaire', en && en.meta && en.meta.title === 'Solitaire', en && en.meta && en.meta.title)
check('en.json meta.description present', !!(en && en.meta && typeof en.meta.description === 'string' && en.meta.description.length > 10))
check('zh.json has no U+FFFD replacement chars', zh && !JSON.stringify(zh).includes('\uFFFD'))
check('en.json has no U+FFFD replacement chars', en && !JSON.stringify(en).includes('\uFFFD'))
check('locale files only contain a meta object', zh && Object.keys(zh).join() === 'meta' && en && Object.keys(en).join() === 'meta', `${Object.keys(zh || {}).join(',')} / ${Object.keys(en || {}).join(',')}`)

/* ------------------------------------------------------------------ *
 * 5. icon.svg
 * ------------------------------------------------------------------ */
const iconPath = join(pkgDir, 'icon.svg')
if (exists(iconPath)) {
  const icon = read(iconPath)
  check('icon.svg is an SVG document', /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(icon))
  check('icon.svg has a viewBox', /viewBox\s*=/.test(icon))
  check('icon.svg does not reference external resources', !/(?:href|src)\s*=\s*["'](?:https?:)?\/\//.test(icon))
  check('icon.svg <= 256 KiB', statSync(iconPath).size <= 256 * 1024, String(statSync(iconPath).size))
  check('no binary/image assets inside the package (outside dev/)', noBinaryAssets(pkgDir))
} else {
  check('icon.svg exists', false)
}

function noBinaryAssets(dir) {
  const BAD = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.ttf', '.otf', '.woff', '.woff2', '.mp3', '.wav', '.ogg', '.bin']
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'dev' || entry.name === 'node_modules') continue
        walk(full)
      } else if (BAD.includes(extname(entry.name).toLowerCase())) {
        found.push(full)
      }
    }
  }
  walk(dir)
  if (found.length) check('no binary assets in publish scope', false, found.join(','))
  return found.length === 0
}

/* ------------------------------------------------------------------ *
 * 6. client.js — registration shape (contract §1/§3)
 * ------------------------------------------------------------------ */
let client = null
if (clientExists) {
  client = read(CLIENT)

  check('loader id equals package.json name', client.includes(`id: '${PACKAGE_NAME}'`) || client.includes(`id:"${PACKAGE_NAME}"`))
  check('client uses window.__ModuleLoader__.load', /window\.__ModuleLoader__\.load\s*\(/.test(client))
  check('factory(require) form present', /factory\s*\(\s*require\s*\)/.test(client))

  const requiredModules = [...client.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  check("only require('react') (no third-party libraries)", requiredModules.length > 0 && requiredModules.every((r) => r === 'react'), requiredModules.join(','))
  check('no ESM import() / import statement in client.js', !/\bimport\s*\(/.test(client) && !/^\s*import\s+[\w{*]/m.test(client))

  check("inject is exactly ['slots']", /inject\s*:\s*\[\s*'slots'\s*\]/.test(client), '')
  check('no ctx.provide(...)', !/ctx\.provide\s*\(/.test(client))
  check("slots.inject('game.stage', ...) appears exactly once", (client.match(/slots\.inject\s*\(/g) || []).length === 1 && /slots\.inject\(\s*'game\.stage'/.test(client), String((client.match(/slots\.inject\s*\(/g) || []).length))
  check('slots.register appears exactly once', (client.match(/slots\.register\s*\(/g) || []).length === 1, String((client.match(/slots\.register\s*\(/g) || []).length))
  check("register name = 'game.stage'", /name:\s*'game\.stage'/.test(client))
  check('register id = GAME_ID', /id:\s*GAME_ID/.test(client))
  check(`GAME_ID = '${GAME_ID}'`, new RegExp("GAME_ID\\s*=\\s*'" + GAME_ID + "'").test(client))
  check("label returns '接龙'", /label\s*:\s*[\s\S]{0,80}?'接龙'/.test(client), '')
  check('select is provided and compares gameId with GAME_ID', /select\s*:/.test(client) && /gameId\s*===\s*GAME_ID/.test(client))
  check('select returns null when the game is not selected', /:\s*null/.test(client))
  check('component only relies on matched (no sessionId / host internals)', !/sessionId/.test(client) && !/__DSH_HOST/.test(client))

  // save contract §4
  const hasKeyLiteral = client.includes(`'${STORE_KEY}'`) || client.includes(`"${STORE_KEY}"`)
  const hasKeyExpression = /'dsh\.game\.'\s*\+\s*GAME_ID\s*\+\s*'\.v1'/.test(client) || /`dsh\.game\.\$\{GAME_ID\}\.v1`/.test(client)
  check(`save key is ${STORE_KEY} (literal or GAME_ID-derived)`, hasKeyLiteral || hasKeyExpression, hasKeyLiteral ? 'literal' : hasKeyExpression ? 'derived' : 'missing')
  const seenKeys = new Set([...client.matchAll(/dsh\.game\.[A-Za-z0-9._-]+/g)].map((m) => m[0]))
  check('client only references its own save key', [...seenKeys].every((k) => k === STORE_KEY), [...seenKeys].join(','))
  check('SCHEMA_VERSION = 1', /SCHEMA_VERSION\s*=\s*1\b/.test(client))
  check('localStorage usage is wrapped (try/catch somewhere near)', /try\s*\{[\s\S]{0,400}localStorage/.test(client) || /localStorage[\s\S]{0,400}catch/.test(client) || /function readSavedState[\s\S]{0,600}catch/.test(client), 'inspect manually if this FAILS')

  // safety §6/§8
  check(
    'no global keydown/keyup/keypress listener (window/document)',
    !/(?:window|document|globalThis)\s*\.\s*addEventListener\s*\(\s*['"](?:keydown|keyup|keypress)['"]/.test(client),
    '',
  )
  check('no document.body usage', !/document\.body/.test(client))
  check('no document.title assignment', !/document\.title\s*=/.test(client))
  check('no network APIs (fetch/XHR/WebSocket/EventSource/sendBeacon)', !/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon/.test(client))
  check('no document.write', !/document\.write\s*\(/.test(client))
  const windowListeners = [...client.matchAll(/window\s*\.\s*addEventListener\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  const documentListeners = [...client.matchAll(/document\s*\.\s*addEventListener\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  check('window listeners, if any, are not keyboard/global shortcuts', windowListeners.every((t) => !/^key/.test(t)) || windowListeners.length === 0, windowListeners.join(','))
  check('document listener is visibilitychange only (pause requirement §4)', documentListeners.length === 0 || documentListeners.every((t) => t === 'visibilitychange'), documentListeners.join(','))
  check('destroy() exists (lifecycle §4)', /destroy\s*\(/.test(client))
  check('readSavedState/parse-save helper exists (corrupt save must not throw)', /readSavedState|loadSavedState|parseSave|sanitizeSave|sanitizeState\s*\(/.test(client))
  check('destroy persists the state before cleanup', /destroy[\s\S]{0,500}(?:persist|save|setItem)/.test(client) || /(?:persist|save|setItem)[\s\S]{0,500}destroy/.test(client), 'verify dynamically — static heuristic only')
  check('visibility pause support (document.hidden / visibilitychange)', /document\.hidden|doc(?:ument)?\.hidden/.test(client) && /visibilitychange/.test(client))
  check('right-click context menu suppressed (handoff)', /onContextMenu|contextmenu/.test(client))
  check('timer/moves display markers present (用时/步数)', /用时|时间|步数|moves/i.test(client))

  // rendering §5/§7
  check('root element fills the stage (width/height 100%)', /width:\s*'100%'/.test(client) && /height:\s*'100%'/.test(client))
  check('ResizeObserver is used', /ResizeObserver/.test(client))
  const usesCanvas = /createElement\(\s*['"]canvas['"]\s*\)/.test(client) || /getContext\(\s*['"]2d['"]\s*\)/.test(client)
  if (usesCanvas) {
    check('canvas path handles devicePixelRatio', /devicePixelRatio/.test(client))
  } else {
    check('DOM rendering path (no canvas) — dpr not required', 'NOTE', 'client.js renders DOM, so canvas dpr rules from §5 do not apply')
  }
  check('requestAnimationFrame loop present (or change-driven redraw via rAF)', /requestAnimationFrame/.test(client))
  check('too-small-stage hint (< 320x240)', /320/.test(client) && /240/.test(client) && /(?:太小|too small|small window)/i.test(client))
  const tokens = (client.match(/--dsw-alias-/g) || []).length
  check('uses host theme tokens (--dsw-alias-*)', tokens >= 5, String(tokens))
  check('no CSS reset / body / html selectors in inline styles', !/(?:^|[\n;}{])\s*(?:body|html|\*)\s*\{/.test(client), 'check inline <style> text manually if this FAILS')
  const prefixedClass = /(?:dsh-)?solitaire[-_a-z0-9]*|sol[-_][a-z0-9]+/i.test(client)
  check('CSS class names are prefixed (solitaire/sol prefix marker present)', prefixedClass)

  // test seam (gated; the seam is part of the dev contract, not the runtime API)
  check('test seam gated by window.__DSH_GAME_SOLITAIRE_TEST__ === true', /window\.__DSH_GAME_SOLITAIRE_TEST__\s*===\s*true/.test(client))
  check("seam installed as window.__DSH_GAME_SOLITAIRE__", /Object\.defineProperty\(\s*window,\s*'__DSH_GAME_SOLITAIRE__'/.test(client))
  const expectedSeamNames = ['dealFromSeed', 'newState', 'sanitize', 'serialize', 'canDrop', 'applyMove', 'drawStock', 'doubleClickMove', 'undo', 'restart', 'computeLayout', 'createGame']
  const missingSeamNames = expectedSeamNames.filter((name) => !new RegExp('\\b' + name + '\\s*[:,]').test(client))
  if (missingSeamNames.length === 0) check('seam exposes the expected pure functions', true)
  else check('seam exposes the expected pure functions (names may differ — dynamic check is authoritative)', 'NOTE', 'missing static names: ' + missingSeamNames.join(','))
} else {
  check('client.js present for registration checks', 'PENDING', 'client.js not written yet')
}

/* ------------------------------------------------------------------ *
 * 7. packaging hygiene (dev/ must not be shipped, no .bak/.tmp files)
 * ------------------------------------------------------------------ */
const stray = []
if (exists(pkgDir)) {
  for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue
    if (/\.(bak|tmp|orig|rej)$/.test(entry.name) || /~$/.test(entry.name)) stray.push(entry.name)
  }
}
check('no stray backup/temp files in package root', stray.length === 0, stray.join(','))
const filesList = pkg && Array.isArray(pkg.files) ? pkg.files : []
check('dev/ is not part of the publish file list', !filesList.some((f) => f.startsWith('dev')))

/* ------------------------------------------------------------------ *
 * 8. hashes for the report
 * ------------------------------------------------------------------ */
const hashTargets = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg', 'README.md']
const hashes = {}
for (const rel of hashTargets) {
  const full = join(pkgDir, rel)
  if (exists(full)) hashes[rel] = sha256(full)
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */
const byStatus = (s) => checks.filter((c) => c.status === s)
for (const item of checks) {
  if (item.status === 'FAIL' || item.status === 'PENDING' || item.status === 'NOTE') {
    console.log(`${item.status.padEnd(7)} ${item.name}${item.detail ? '  ::  ' + item.detail : ''}`)
  }
}
console.log(`\nchecks: ${checks.length} total, ${passCount} pass, ${pendingCount} pending, ${byStatus('NOTE').length} notes, ${fails.length} fail`)
console.log('sha256:')
for (const [rel, hash] of Object.entries(hashes)) console.log(`  ${rel.padEnd(20)} ${hash}`)
if (!clientExists) console.log('NOTE: client.js absent — registration/seam/safety checks are PENDING until the Lead finishes it.')
if (fails.length) {
  console.error('\nCONTRACT FAILED:')
  for (const fail of fails) console.error(' - ' + fail)
  process.exit(1)
}
console.log('\nCONTRACT OK')
