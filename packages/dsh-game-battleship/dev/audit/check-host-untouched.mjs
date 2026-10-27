/**
 * check-host-untouched.mjs — proves the audit did not change the host package.
 *
 * Run: node packages/dsh-game-battleship/dev/audit/check-host-untouched.mjs
 *      node ... --print   (print the current hashes as a baseline candidate, read-only)
 * Read-only. Exit 0 = host + contract identical to baseline-hashes.json.
 *
 * Scope of the required-unchanged set: packages/dsh-game-host/** and
 * handoff/contract/**. The battleship runtime files are printed for the record
 * but never treated as violations of this audit.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, sep } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..', '..')
const baselinePath = join(here, 'baseline-hashes.json')
const printMode = process.argv.includes('--print')

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const rel = (p) => relative(root, p).split(sep).join('/')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const groups = {
  host: walk(join(root, 'packages', 'dsh-game-host')),
  contract: walk(join(root, 'handoff', 'contract')),
}
const current = {}
for (const file of [...groups.host, ...groups.contract]) current[rel(file)] = sha256(file)

if (printMode) {
  console.log(JSON.stringify({ createdAt: new Date().toISOString(), files: current }, null, 2))
  process.exit(0)
}

let baseline
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
} catch (error) {
  console.error('cannot read baseline-hashes.json: ' + error.message)
  process.exit(1)
}
const expected = baseline.requiredUnchanged || {}

const changed = []
const missing = []
const added = []
for (const [file, hash] of Object.entries(expected)) {
  if (!existsSync(join(root, file))) missing.push(file)
  else if (current[file] !== hash) changed.push({ file, expected: hash, actual: current[file] })
}
for (const file of Object.keys(current)) {
  if (!(file in expected)) added.push(file)
}

console.log('required-unchanged baseline: ' + baseline.createdAt)
console.log(`watched files: ${Object.keys(expected).length}`)
console.log(`current host files: ${groups.host.length}, contract files: ${groups.contract.length}`)
if (changed.length || missing.length || added.length) {
  console.log('CHANGED:')
  for (const item of changed) console.log(`  ${item.file}\n    expected ${item.expected}\n    actual   ${item.actual}`)
  for (const file of missing) console.log(`  MISSING ${file}`)
  for (const file of added) console.log(`  ADDED ${file}`)
  console.error('HOST/CONTRACT BASELINE VIOLATED')
  process.exit(1)
}

// Record (not enforce) current battleship runtime files.
const battleship = join(root, 'packages', 'dsh-game-battleship')
console.log('\nbattleship package runtime files (recorded, Lead-owned):')
for (const name of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg', 'README.md']) {
  const full = join(battleship, name)
  console.log(`  ${existsSync(full) ? sha256(full) : '(missing)'.padEnd(64)}  ${name}${existsSync(full) ? '' : '  MISSING'}`)
}
console.log(`\nhost + contract UNCHANGED (all ${Object.keys(expected).length} files match the pre-audit baseline)`)
