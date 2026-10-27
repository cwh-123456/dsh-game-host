/**
 * Run every verifier suite in one Node process (no child processes needed).
 *
 *   node packages/dsh-game-klotski/dev/audit/run-all.mjs
 *
 * Suites run sequentially; the process exit code is non-zero if any suite fails.
 */
const suites = [
  ['suite 1  independent BFS / par / L1 spec', './bfs.mjs'],
  ['suite 2  rule differential fuzz', './fuzz.mjs'],
  ['suite 3  save / restore audit', './save-audit.mjs'],
  ['suite 4  contract / manifest static audit', './contract-audit.mjs'],
  ['suite 5  host baseline sha256', './host-hashes.mjs'],
  ['suite 6  fake-DOM createGame lifecycle (bonus)', './fake-dom.mjs'],
]

console.log('########################################################################')
console.log('# Klotski verifier audit — run all suites')
console.log('########################################################################\n')

const results = []
for (const [label, file] of suites) {
  console.log('\n\n################ ' + label + ' ################\n')
  process.exitCode = 0
  const startedAt = Date.now()
  let crashed = null
  try {
    await import(new URL(file, import.meta.url).href)
  } catch (error) {
    crashed = error
    process.exitCode = 1
    console.error('SUITE CRASHED: ' + (error && error.stack ? error.stack : error))
  }
  results.push({ suite: label, file, ok: process.exitCode === 0 && !crashed, ms: Date.now() - startedAt })
}

console.log('\n\n########################################################################')
console.log('# Summary')
console.log('########################################################################')
let failed = 0
for (const row of results) {
  if (!row.ok) failed += 1
  console.log((row.ok ? 'PASS ' : 'FAIL ') + row.suite.padEnd(52, ' ') + '  ' + row.ms + 'ms')
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' suites passed')
if (failed > 0) {
  process.exitCode = 1
  console.error('\nVERIFIER AUDIT: FAIL')
} else {
  console.log('\nVERIFIER AUDIT: PASS')
}
