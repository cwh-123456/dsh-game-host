/**
 * Run the whole independent audit suite sequentially.
 *
 * Run: node dev/audit/run-all.mjs
 * Exits non-zero if any audit script fails (or if client.js is still missing).
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scripts = ['selftest-reference.mjs', 'audit-contract.mjs', 'audit-generate.mjs', 'audit-state.mjs']
let failed = 0

for (const script of scripts) {
  const file = fileURLToPath(new URL(script, import.meta.url))
  console.log('\n===== ' + script + ' =====')
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' })
  if (result.error) {
    failed += 1
    console.error('could not run ' + script + ': ' + result.error.message)
    continue
  }
  if (result.status !== 0) {
    failed += 1
    console.error(script + ' exited with code ' + result.status)
  }
}

console.log('')
if (failed > 0) {
  console.log('AUDIT SUITE: ' + failed + ' script(s) failed')
  process.exitCode = 1
} else {
  console.log('AUDIT SUITE: all ' + scripts.length + ' scripts passed')
}
